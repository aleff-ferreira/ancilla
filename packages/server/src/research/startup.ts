import { REAL_CLOCK, type TurnClock } from "./turn.js";

/**
 * How long a research session start may take before the run gives up on it. Starting a session is the first thing
 * a worker or a control call waits for, ahead of every deadline `runTurn` keeps, and it can include bringing the
 * thread's Muse host up (a cold WSL distro, a launcher updating itself), so the allowance is generous.
 */
export const DEFAULT_RESEARCH_STARTUP_MS = 120_000;

/** The allowance on Windows with Muse in WSL, where a cold distro and the `wsl.exe` hop make a start slower. */
export const WSL_RESEARCH_STARTUP_MS = 180_000;

export interface StartupAllowanceInput {
  platform: string;
  /** Where Muse runs, when known: `wsl` on Windows with Muse inside a distro. */
  runtime: string | null;
  /** `ServerOptions.researchStartupMs`; wins over the environment. */
  option?: number | undefined;
  /** The value of `ANCILLA_RESEARCH_STARTUP_MS`. */
  env?: string | undefined;
}

/** The least `ANCILLA_RESEARCH_STARTUP_MS` may ask for: a smaller figure is a unit mix-up (seconds), not a bound. */
export const MIN_RESEARCH_STARTUP_ENV_MS = 1000;

function positiveMs(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * What `ANCILLA_RESEARCH_STARTUP_MS` asks for, or null when it asks for nothing usable: plain decimal digits only
 * (no hex, exponent, fraction or separators) and at least a second, so a value written in seconds does not make
 * every worker and control call fail at once.
 */
export function startupEnvMs(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || !/^\d+$/.test(text)) {
    return null;
  }
  const ms = Number(text);
  return Number.isSafeInteger(ms) && ms >= MIN_RESEARCH_STARTUP_ENV_MS ? ms : null;
}

/**
 * The startup allowance for a run: the option, else the environment, else the platform's default. A value that is
 * not usable is ignored, so a typo in the environment cannot switch the bound off or make it absurdly short. Only
 * the environment has a floor: the option is set by code (and by tests that need a short bound).
 *
 * On Windows the longer allowance also applies while the runtime is not settled yet: the first research start after
 * a boot can come before anything probed where Muse runs, and a cold WSL distro is exactly the start that needs it.
 */
export function researchStartupAllowanceMs(input: StartupAllowanceInput): number {
  const fromOption = positiveMs(input.option);
  if (fromOption !== null) {
    return fromOption;
  }
  const fromEnv = startupEnvMs(input.env);
  if (fromEnv !== null) {
    return fromEnv;
  }
  return input.platform === "win32" && input.runtime !== "native" ? WSL_RESEARCH_STARTUP_MS : DEFAULT_RESEARCH_STARTUP_MS;
}

/** The reason a give-up signal carries when the wait ended because the allowance passed; see `gaveUpOnTimeout`. */
export const STARTUP_TIMED_OUT: Readonly<{ type: "startup_timeout" }> = Object.freeze({ type: "startup_timeout" as const });

/**
 * Whether the wait on a start ended because the allowance passed, the one case that says the host did not answer.
 * A stop also aborts the give-up signal, but a host that is merely slow was not at fault for that.
 */
export function gaveUpOnTimeout(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === STARTUP_TIMED_OUT;
}

/** How a start ended, as far as the caller that raced it can tell. */
export type StartupResult<T> =
  | { kind: "started"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "aborted" }
  | { kind: "timed_out"; ms: number };

export interface RaceStartupOptions<T> {
  /** The run's signal: a stop ends the wait at once. */
  signal: AbortSignal;
  /** The clock the allowance is measured on; tests inject a fake one. */
  clock?: TurnClock | undefined;
  timeoutMs: number;
  /** Called with the value of a start that finished after the race was lost, so the caller can log the straggler. */
  onLate?: ((value: T) => void) | undefined;
}

/**
 * Waits for `start` but not past the run's stop or the allowance. The start gets a "give-up" signal that is
 * aborted when the wait ended without it (a stop, or the allowance): the start itself cannot be taken back, so
 * the signal is how the host side learns that nobody is waiting for it any more. A rejection that arrives after
 * the race is over is swallowed here (it would otherwise be an unhandled rejection), and the one timer the race
 * arms is cleared on every path, so a finished race leaves nothing on the clock.
 */
export async function raceStartup<T>(start: (giveUp: AbortSignal) => Promise<T>, options: RaceStartupOptions<T>): Promise<StartupResult<T>> {
  const { signal, timeoutMs } = options;
  if (signal.aborted) {
    return { kind: "aborted" };
  }
  const clock = options.clock ?? REAL_CLOCK;
  const giveUp = new AbortController();
  let pending: Promise<T>;
  try {
    pending = start(giveUp.signal);
  } catch (error) {
    return { kind: "failed", error };
  }
  let timer: unknown = null;
  let decided: StartupResult<T> | null = null;
  let resolveRace: (result: StartupResult<T>) => void = () => undefined;
  const race = new Promise<StartupResult<T>>((resolve) => {
    resolveRace = resolve;
  });
  /** The first outcome stands; whatever comes after it is the start catching up with a race already over. */
  const decide = (result: StartupResult<T>): void => {
    if (decided === null) {
      decided = result;
      resolveRace(result);
    }
  };
  // Both handlers are attached at once, so a rejection after the race is over has a handler and goes nowhere.
  pending.then(
    (value) => {
      if (decided !== null) {
        options.onLate?.(value);
        return;
      }
      decide({ kind: "started", value });
    },
    (error: unknown) => decide({ kind: "failed", error }),
  );
  const onAbort = (): void => decide({ kind: "aborted" });
  signal.addEventListener("abort", onAbort, { once: true });
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = clock.setTimeout(() => decide({ kind: "timed_out", ms: timeoutMs }), timeoutMs);
  }
  try {
    const result = await race;
    if (result.kind === "aborted" || result.kind === "timed_out") {
      // The reason says which: only the allowance passing reads as the host not answering (`gaveUpOnTimeout`).
      giveUp.abort(result.kind === "timed_out" ? STARTUP_TIMED_OUT : undefined);
    }
    return result;
  } finally {
    if (timer !== null) {
      clock.clearTimeout(timer);
    }
    signal.removeEventListener("abort", onAbort);
  }
}

/** A duration as a log line or an error message says it. */
export function describeMs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}
