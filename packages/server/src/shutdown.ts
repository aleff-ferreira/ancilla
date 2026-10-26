import { CLOSE_TIMEOUT_MS } from "./research/jobManager.js";
import { DEFAULT_HOST_WAITS, type HostWaits } from "./hostBounds.js";
import { INSTALLER_KILL_GRACE_MS } from "./linuxMuseInstaller.js";
import { SHELL_KILL_SETTLE_MS } from "./runCapture.js";

/**
 * How the command line ends on a stop signal: close the server, then exit. A close that is still waiting after the
 * deadline does not hold the process, and a second signal ends it at once, so a stuck host can never make the only way
 * to stop the server a SIGKILL.
 *
 * The deadline must be longer than the worst case of `AncillaServer.close()` with the waits the command line gives
 * it (`CLI_HOST_WAITS`), or a slow host close always ends as exit code 1 with the port still open and the store not
 * closed; `worstCaseCloseMs` adds that case up and a test keeps the two apart by a second. A process that is stopped
 * by something other than a signal it can answer is another matter: the desktop shell has to give the sidecar at
 * least this deadline plus the time to exit before it kills it.
 */
export const SHUTDOWN_DEADLINE_MS = 20_000;

/**
 * The hidden flag the desktop shell passes as the last argument: close the server, as on SIGTERM, when stdin reaches
 * its end. The shell keeps the write end of the pipe for the sidecar's whole life and drops it to quit; when the shell
 * dies instead (Task Manager, a crash) the system closes it, so the same end arrives either way, on every system,
 * which a signal does not (Windows delivers none to a process that is killed). It is never a default and is not in the
 * usage text: stdin from `/dev/null`, a closed stdin and a parent that has exited all end at once, so an unconditional
 * watchdog would stop every server under systemd, Docker without `-i`, nohup and cron the moment it started.
 */
export const STDIN_EOF_FLAG = "--close-on-stdin-eof";

/** What the handler is called with when stdin ends; the log line names it like a signal. */
export const STDIN_EOF_CAUSE = "stdin EOF";

/**
 * What the install does after its group has been killed, before `AncillaServer.close()` has the answer: the child's
 * close event, then the removal of the folder the script was written to. Both are quick; this is what they may take.
 */
export const LINUX_INSTALLER_CLEANUP_MS = 500;

/**
 * What stopping a running Linux installer takes at most. The real stop is `cancel()` and then waiting for the install
 * to finish: the polite stop, the kill once `INSTALLER_KILL_GRACE_MS` has passed (the one constant, linuxMuseInstaller.ts),
 * and the cleanup after it.
 */
export const LINUX_INSTALLER_STOP_MS = INSTALLER_KILL_GRACE_MS + LINUX_INSTALLER_CLEANUP_MS;

/**
 * The longest `AncillaServer.close()` can take with these waits (the defaults for what is left out). It runs in two
 * stages: the installer and the research runs one after the other, then the starts still open, every host close, the
 * title worker and the `!` commands still running all at once, so that stage lasts as long as the slowest of them.
 * Closing the listener and the store take no time worth adding.
 */
export function worstCaseCloseMs(waits: HostWaits = {}): number {
  const { startsMs, closeMs, shellsMs } = { ...DEFAULT_HOST_WAITS, ...waits };
  return LINUX_INSTALLER_STOP_MS + CLOSE_TIMEOUT_MS + Math.max(startsMs, closeMs, shellsMs + SHELL_KILL_SETTLE_MS);
}

/**
 * The signals that end the server: SIGINT, SIGTERM and SIGHUP everywhere, and SIGBREAK on Windows. A terminal that goes
 * away hangs up on the server it ran, and a closed Windows console delivers SIGHUP (Ctrl+Break, SIGBREAK); a process
 * that does not answer one is ended by it with no exit event, so neither the close nor the exit hook that stops the
 * `!` commands would run, and a command in its own session would be left running. `nohup` never protected a Node
 * process from that: Node resets every inherited signal disposition when it starts. The hangup is answered like
 * SIGTERM instead. On Windows a closed console gives the process only about ten seconds before the system ends it,
 * which is why the research runs are closed out first: within five seconds (`CLOSE_TIMEOUT_MS`) on Windows, where the
 * Linux installer never runs; on Linux the installer's stop can add `LINUX_INSTALLER_STOP_MS` (2.5 s) before them. The
 * 20 s deadline below is never reached on Windows. The desktop app does not signal its sidecar: it closes the sidecar's
 * stdin, which the `STDIN_EOF_FLAG` turns into the same close. A server that is killed outright skips all of this
 * (SIGKILL, or the shell's kill once its own grace has passed): a `!` command still pending then keeps running, and
 * what the server left in flight is marked at the next start.
 */
export function shutdownSignals(platform: string = process.platform): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

export interface ShutdownTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ShutdownOptions {
  /** Closes the server; `cause` is what the handler was called with (a signal's name, or `STDIN_EOF_CAUSE`). */
  close: (cause: string) => Promise<unknown>;
  exit: (code: number) => void;
  log: (message: string) => void;
  deadlineMs?: number;
  timers?: ShutdownTimers;
}

/** The handler for a signal, called with the signal's name each time one arrives; `begun()` says whether one has. */
export interface ShutdownHandler {
  (cause: string): void;
  /** Whether a close has begun: the command line writes its ready line only when none has. */
  begun(): boolean;
}

export function createShutdown(options: ShutdownOptions): ShutdownHandler {
  const timers: ShutdownTimers = options.timers ?? { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let begun = false;
  let ended = false;
  let deadline: unknown = null;
  const end = (code: number): void => {
    if (ended) {
      return;
    }
    ended = true;
    if (deadline !== null) {
      timers.clearTimeout(deadline);
    }
    options.exit(code);
  };
  const handler = (signal: string): void => {
    if (begun) {
      options.log(`second signal (${signal}): exiting now, without waiting for the server to finish closing.`);
      end(1);
      return;
    }
    begun = true;
    options.log(`${signal} received: closing the server (another signal exits at once).`);
    deadline = timers.setTimeout(() => {
      options.log(`closing did not finish within ${Math.round(deadlineMs / 1000)} s: exiting anyway.`);
      end(1);
    }, deadlineMs);
    let closing: Promise<unknown>;
    try {
      closing = Promise.resolve(options.close(signal));
    } catch (error) {
      closing = Promise.reject(error);
    }
    closing.then(
      () => end(0),
      (error: unknown) => {
        options.log(`closing failed: ${error instanceof Error ? error.message : String(error)}`);
        end(1);
      },
    );
  };
  return Object.assign(handler, { begun: () => begun });
}
