import { DEFAULT_HOST_START_TIMEOUT_MS } from "@ancilla/daemon";

/**
 * The limits on what the server waits for from a Muse host it started. None of them is a deadline on a user's own
 * request: a thread's turn, a `!` command or a model list is as long as it is. They bound only the waits that would
 * otherwise have no end, a start that never answers and a host that never finishes closing.
 */

export const HOST_START_TIMEOUT_ENV = "ANCILLA_HOST_START_TIMEOUT_MS";

/** A timer longer than this is silently cut to one millisecond by Node. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Whole milliseconds as a number or as digits, 0 included (it turns the ceiling off); null for anything else, which
 * would otherwise become an instant timeout or no timeout at all.
 */
export function parseHostStartTimeoutMs(value: unknown): number | null {
  let ms: number;
  if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
    ms = Number(value.trim());
  } else {
    return null;
  }
  return Number.isInteger(ms) && ms >= 0 && ms <= MAX_TIMER_MS ? ms : null;
}

const HOW_TO_WRITE = "it takes whole milliseconds, 0 to turn the limit off (for example 300000)";

/**
 * The start ceiling in milliseconds: the option, else the environment, else runtime.json, else five minutes. A value
 * that cannot be read is left out with one line naming it, as if it had not been given.
 */
export function resolveHostStartTimeoutMs(input: {
  option?: number;
  env?: string;
  file?: number;
  warn: (line: string) => void;
}): number {
  if (input.option !== undefined) {
    const option = parseHostStartTimeoutMs(input.option);
    if (option !== null) {
      return option;
    }
    input.warn(`ignoring hostStartTimeoutMs=${JSON.stringify(input.option)}: ${HOW_TO_WRITE}.`);
  }
  if (input.env !== undefined && input.env.trim() !== "") {
    const env = parseHostStartTimeoutMs(input.env);
    if (env !== null) {
      return env;
    }
    input.warn(`ignoring ${HOST_START_TIMEOUT_ENV}=${JSON.stringify(input.env)}: ${HOW_TO_WRITE}.`);
  }
  if (input.file !== undefined) {
    const file = parseHostStartTimeoutMs(input.file);
    if (file !== null) {
      return file;
    }
  }
  return DEFAULT_HOST_START_TIMEOUT_MS;
}

/** How long the server waits on a host's start and on a host's close before it goes on without them. */
export interface HostWaits {
  /** For a host start still open when a restart or a shutdown begins, and for the title worker at shutdown. */
  startsMs?: number;
  /** For one host to finish closing; the SDK's own close ends within about half a minute on its own. */
  closeMs?: number;
  /** For the `!` commands still running at shutdown to wind down after the polite stop, before they are killed. */
  shellsMs?: number;
}

export const DEFAULT_HOST_WAITS: Required<HostWaits> = { startsMs: 3_000, closeMs: 40_000, shellsMs: 1_500 };

/**
 * The waits of the command line, which must end the process within `SHUTDOWN_DEADLINE_MS`: a host that is slow to
 * close is let go after 11.5 s instead of 40. `worstCaseCloseMs` (shutdown.ts) adds up what a close can then take, and
 * a test holds it under the deadline with a second to spare. The same wait bounds the close of a host that a
 * settings change restarts, for the command-line server.
 */
export const CLI_HOST_WAITS: Required<HostWaits> = { ...DEFAULT_HOST_WAITS, closeMs: 11_500 };

/**
 * Waits `ms`, or less when `signal` fires, and leaves no timer behind either way. Resolves true when the time ran out
 * and false when the signal cut the wait short.
 */
export function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Whether `work` settled (either way) within `ms`. Never rejects, and leaves no timer behind. */
export function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(done, done);
  });
}

/** Closes a host without waiting for it, and without letting a failure of the close reach anyone. */
export function closeInBackground(handle: { close(): Promise<unknown> }): void {
  try {
    void Promise.resolve(handle.close()).catch(() => undefined);
  } catch {
    /* a host that cannot be closed has nothing more to give */
  }
}
