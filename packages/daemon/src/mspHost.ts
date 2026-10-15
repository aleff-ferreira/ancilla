import { spawnMspConnection } from "@muse-code/sdk";
import type { CommandConnection } from "./sessions.js";

export type SpawnMspConnection = typeof spawnMspConnection;
export type MspHandshake = Awaited<ReturnType<SpawnMspConnection>>;
export type MspSession = Awaited<ReturnType<MspHandshake["initialize"]>>;

export interface ServeTarget {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ServeExit {
  code: number | null;
  signal: string | null;
  /** Set when the host is reported gone although its process was not seen to exit; see `connectionGraceMs`. */
  reason?: "connection-ended";
}

export const ANCILLA_CLIENT_NAME = "ancilla";
export const SDK_TIER_OFF_EXIT_CODE = 5;

/**
 * How long a host may take to answer its `initialize` before it is given up on. A start that is merely slow (a cold
 * WSL distro, a launcher updating itself) finishes well inside it; one that never answers is a dead start, whoever
 * asked for it.
 */
export const DEFAULT_HOST_START_TIMEOUT_MS = 300_000;

/** How long a host whose connection ended gets to report an exit of its own before it is closed as still running. */
export const DEFAULT_CONNECTION_GRACE_MS = 2_000;

/** The timers a host measures its deadlines with; tests inject a fake one. */
export interface HostTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: HostTimers = {
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AncillaMspHostOptions {
  /** The start ceiling in milliseconds; 0 turns it off. `DEFAULT_HOST_START_TIMEOUT_MS` when unset. */
  startTimeoutMs?: number;
  /** The grace a host whose connection ended gets before its still-running process is closed. */
  connectionGraceMs?: number;
  timers?: HostTimers;
  /** Where a line worth reading later goes; the daemon's own log line on stderr when unset. */
  log?: (line: string) => void;
}

function describeDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

/** A start that did not answer within the ceiling. The host is being closed; nothing waits for that. */
export class HostStartTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, stderrTail = "") {
    super(`The Muse host did not finish starting within ${describeDuration(timeoutMs)}, so it was given up on.${stderrTail ? `\n${stderrTail}` : ""}`);
    this.name = "HostStartTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** A start ended by `close()` while it was still open. */
class HostStartAborted extends Error {
  constructor() {
    super("The Muse host was closed while it was still starting.");
    this.name = "HostStartAborted";
  }
}

export type ServeExitClass = "clean" | "sdk-tier-off" | "signalled" | "error";

export function classifyServeExit(code: number | null): ServeExitClass {
  if (code === 0) {
    return "clean";
  }
  if (code === SDK_TIER_OFF_EXIT_CODE) {
    return "sdk-tier-off";
  }
  if (code === null) {
    return "signalled";
  }
  return "error";
}

export function serveExitMessage(exitClass: ServeExitClass): string {
  switch (exitClass) {
    case "clean":
      return "The Muse host exited cleanly.";
    case "sdk-tier-off":
      return "This Muse build has its experimental SDK tier switched off, so no invocation of that binary will serve. Upgrade the CLI or use a build with MSP serving enabled.";
    case "signalled":
      return "The Muse host was killed by a signal before it reported an exit code.";
    case "error":
      return "The Muse host exited with an error. Check that you are logged in (muse login) and that the workspace is readable.";
  }
}

const STDERR_TAIL_LINES = 12;

export class AncillaMspHost {
  private handshake: MspHandshake | null = null;
  private msp: MspSession | null = null;
  private stderrTail: string[] = [];
  private exitHandlers: ((exit: ServeExit) => void)[] = [];
  private closing = false;
  private exitNotified = false;
  /** The exit that was reported, kept for a handler registered after it. */
  private notifiedExit: ServeExit | null = null;
  private closePromise: Promise<ServeExit> | null = null;
  /** Ends the start in progress with the given error; null when none is open. */
  private abortStart: ((error: Error) => void) | null = null;
  private graceTimer: unknown = null;
  private readonly startTimeoutMs: number;
  private readonly connectionGraceMs: number;
  private readonly timers: HostTimers;
  private readonly log: (line: string) => void;

  constructor(
    private readonly target: ServeTarget,
    private readonly spawnFn: SpawnMspConnection = spawnMspConnection,
    private readonly onStderr: (chunk: string) => void = () => {},
    options: AncillaMspHostOptions = {},
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_HOST_START_TIMEOUT_MS;
    this.connectionGraceMs = options.connectionGraceMs ?? DEFAULT_CONNECTION_GRACE_MS;
    this.timers = options.timers ?? REAL_TIMERS;
    this.log = options.log ?? ((line) => void process.stderr.write(`[ancilla] ${new Date().toISOString()} ${line}\n`));
  }

  async start(
    clientVersion: string,
  ): Promise<{ initializeResult: unknown; fingerprintWarning: unknown }> {
    const onStderr = this.onStderr;
    const handshake = this.spawnFn({
      command: this.target.command,
      args: this.target.args,
      cwd: this.target.cwd,
      env: this.target.env,
      onStderr: (chunk: unknown) => {
        const text = String(chunk);
        this.rememberStderr(text);
        onStderr(text);
      },
    } as Parameters<SpawnMspConnection>[0]);
    this.handshake = handshake;
    let msp: MspSession;
    try {
      msp = await this.initialize(handshake, clientVersion);
    } catch (error) {
      // Whatever ended the start, the child it began must not outlive it. Never awaited: a child that ignores EOF and
      // SIGTERM holds the close for half a minute, and the caller has its answer already.
      this.closeInBackground();
      if (error instanceof HostStartTimeoutError || error instanceof HostStartAborted) {
        throw error;
      }
      const tail = this.stderrTail.join("\n").trim();
      throw new Error(tail ? `${String(error)}\n${tail}` : String(error));
    }
    try {
      this.msp = msp;
      const started = {
        initializeResult: msp.initializeResult,
        fingerprintWarning: msp.fingerprintWarning ?? null,
      };
      this.watch(msp);
      return started;
    } catch (error) {
      // The child answered, then something here failed: it is running and nobody will ever use it.
      this.closeInBackground();
      this.msp = null;
      throw error;
    }
  }

  /**
   * The handshake's `initialize`, ended early by the ceiling or by `close()`. Whichever comes first settles it; an
   * answer that comes later is dropped, its child already being closed by the failure that settled the start.
   */
  private initialize(handshake: MspHandshake, clientVersion: string): Promise<MspSession> {
    return new Promise<MspSession>((resolve, reject) => {
      let settled = false;
      let timer: unknown = null;
      const settle = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        this.abortStart = null;
        if (timer !== null) {
          this.timers.clearTimeout(timer);
        }
        return true;
      };
      this.abortStart = (error) => {
        if (settle()) {
          reject(error);
        }
      };
      if (this.startTimeoutMs > 0) {
        timer = this.timers.setTimeout(() => {
          if (settle()) {
            reject(new HostStartTimeoutError(this.startTimeoutMs, this.stderrTail.join("\n").trim()));
          }
        }, this.startTimeoutMs);
      }
      handshake
        .initialize({
          clientInfo: { name: ANCILLA_CLIENT_NAME, version: clientVersion },
          // `!` commands in the composer run through session/userShell, which the host grants per connection.
          capabilities: { requestedCapabilities: ["userShell"] },
        })
        .then(
          (msp) => {
            if (settle()) {
              resolve(msp);
            }
          },
          (error: unknown) => {
            if (settle()) {
              reject(error);
            }
          },
        );
    });
  }

  /** Watches the process and the connection of a host that started, for the day either ends without `close()`. */
  private watch(msp: MspSession): void {
    const exited = (msp as { exited?: Promise<ServeExit> }).exited;
    if (exited) {
      void exited.then(
        (exit) => this.notifyExit({ code: exit.code, signal: exit.signal }),
        () => this.notifyExit({ code: null, signal: null }),
      );
    }
    const ended = (msp.connection as unknown as { closed?: Promise<unknown> }).closed;
    if (ended && typeof ended.then === "function") {
      const onEnded = (): void => this.connectionEnded();
      void ended.then(onEnded, onEnded);
    }
  }

  /**
   * The connection ended without this side closing it. A host that is going away takes its connection with it and its
   * exit follows at once, and that exit is the one worth reporting. A process still running after the grace has a
   * connection nobody can use: it is reported gone and closed, or every dead connection would leave a `muse serve`.
   */
  private connectionEnded(): void {
    if (this.closing || this.exitNotified || this.graceTimer !== null) {
      return;
    }
    this.graceTimer = this.timers.setTimeout(() => {
      this.graceTimer = null;
      if (this.closing || this.exitNotified) {
        return;
      }
      // The child is closed before anyone is told: a handler that throws must not leave a running `muse serve` behind.
      this.notifyExit({ code: null, signal: null, reason: "connection-ended" }, true);
    }, this.connectionGraceMs);
  }

  get connection(): CommandConnection {
    if (!this.msp) {
      throw new Error("AncillaMspHost: call start() before using the connection.");
    }
    return this.msp.connection as unknown as CommandConnection;
  }

  /** Last lines the host wrote to stderr, for surfacing a crash to the user. */
  get recentStderr(): string {
    return this.stderrTail.join("\n").trim();
  }

  /**
   * Called once when the host process ends for any reason other than our own close(). A handler registered after the
   * exit was reported is told of it too, once, from a microtask: an exit does not go unheard for being early.
   */
  onExit(handler: (exit: ServeExit) => void): void {
    this.exitHandlers.push(handler);
    const exit = this.notifiedExit;
    if (exit !== null) {
      queueMicrotask(() => this.tell(handler, exit));
    }
  }

  /**
   * Closes the host. Valid from the moment `start()` was called: a start still open is ended (it rejects) and its
   * child closed, which is the only way to stop one that never answers. Closing twice shares one close.
   */
  async close(): Promise<ServeExit> {
    if (!this.handshake) {
      throw new Error("AncillaMspHost: call start() before close().");
    }
    this.abortStart?.(new HostStartAborted());
    return this.closeOnce();
  }

  private closeOnce(): Promise<ServeExit> {
    this.closing = true;
    if (this.graceTimer !== null) {
      this.timers.clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (!this.closePromise) {
      // The target is chosen before anything is awaited: a start that failed has no session, only its handshake.
      const target = this.msp ?? (this.handshake as MspHandshake);
      this.closePromise = (async () => target.close())().then((exit) => ({ code: exit.code, signal: exit.signal }));
    }
    return this.closePromise;
  }

  private closeInBackground(): void {
    this.closeOnce().catch(() => undefined);
  }

  /** Reports the exit once. `thenClose` closes the child before any handler runs, for a host whose process did not end. */
  private notifyExit(exit: ServeExit, thenClose = false): void {
    if (this.closing || this.exitNotified) {
      return;
    }
    this.exitNotified = true;
    this.notifiedExit = exit;
    if (this.graceTimer !== null) {
      this.timers.clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (thenClose) {
      this.closeInBackground();
    }
    // A handler registered from inside one of these is not in the copy: the replay in `onExit` tells it, once.
    for (const handler of [...this.exitHandlers]) {
      this.tell(handler, exit);
    }
  }

  /** Tells one handler. A handler that throws is logged and does not keep the others from hearing. */
  private tell(handler: (exit: ServeExit) => void, exit: ServeExit): void {
    try {
      handler(exit);
    } catch (error) {
      this.log(`the Muse host's exit handler threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private rememberStderr(text: string): void {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    this.stderrTail.push(...lines);
    if (this.stderrTail.length > STDERR_TAIL_LINES) {
      this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_LINES);
    }
  }
}
