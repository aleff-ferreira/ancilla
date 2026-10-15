import { spawn } from "node:child_process";
import { settledWithin } from "./hostBounds.js";

/** Output kept from a `!` command Ancilla runs itself, and how long it may run. */
export const MAX_SHELL_OUTPUT = 64 * 1024;
export const SHELL_TIMEOUT_MS = 2 * 60_000;

/** How long output may keep arriving once the command has exited, before the pipes are let go. */
const DRAIN_GRACE_MS = 250;
/** How long a command that was asked to stop gets before it is killed. */
const KILL_GRACE_MS = 2_000;
/** How long a shutdown lets the commands still running wind down after the polite stop, before it kills them. */
export const SHELL_STOP_GRACE_MS = 1_500;
/** How long a shutdown waits, after the kill, for the commands to be reported gone. */
export const SHELL_KILL_SETTLE_MS = 500;

/** A command whose answer is still to come. */
export interface PendingCapture {
  /** Signals the command, and its whole process group where the system has them. */
  stop(signal: NodeJS.Signals): void;
  /** Settles once the answer has been delivered. */
  settled: Promise<void>;
}

/** The commands one owner has started whose answer has not been delivered; a server keeps one of these of its own. */
export type PendingCaptures = Set<PendingCapture>;

export interface RunCaptureOptions {
  drainGraceMs?: number;
  killGraceMs?: number;
  /** Where the command is listed while its answer is pending, so its owner can stop it; see `stopPendingCaptures`. */
  pending?: PendingCaptures;
}

/**
 * Every command in the process whose answer is pending, whoever owns it. A process that exits (a deadline, a crash
 * handler, `process.exit`) cannot wait for anyone, so one synchronous hook kills the groups still in here and nothing
 * a `!` command started in its own session outlives the server that ran it.
 */
const everyPending = new Set<PendingCapture>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const capture of [...everyPending]) {
      try {
        capture.stop("SIGKILL");
      } catch {
        /* the exit goes on */
      }
    }
  });
}

/**
 * Stops the commands in `pending`: a polite stop to every group, up to `graceMs` for them to answer, then a kill for
 * the ones that did not, and a moment more to see them gone. It is bounded by `graceMs` plus `settleMs` whatever the
 * commands do. A command that already answered is not in `pending`, so what it left running in the background is
 * not touched.
 */
export async function stopPendingCaptures(
  pending: PendingCaptures,
  options: { graceMs?: number; settleMs?: number } = {},
): Promise<void> {
  const stopping = [...pending];
  if (stopping.length === 0) {
    return;
  }
  for (const capture of stopping) {
    capture.stop("SIGTERM");
  }
  const answered = Promise.all(stopping.map((capture) => capture.settled));
  if (await settledWithin(answered, options.graceMs ?? SHELL_STOP_GRACE_MS)) {
    return;
  }
  for (const capture of stopping) {
    if (pending.has(capture)) {
      capture.stop("SIGKILL");
    }
  }
  await settledWithin(answered, options.settleMs ?? SHELL_KILL_SETTLE_MS);
}

/**
 * Runs a program and keeps what it printed, both streams together, as a terminal would show it. It answers when the
 * command has exited (and its last output had a moment to arrive), not when every pipe it touched is closed: a command
 * that leaves a background process behind would otherwise hold the answer for as long as that process lives. What the
 * command left running is its own business, and what it writes after the answer is read and dropped so that it is
 * never blocked or killed by a pipe nobody reads; only a command that outruns the timeout is stopped, together with
 * what it started where the system has process groups, and killed if it ignores the request. A command whose answer is
 * still pending when its owner stops (see `stopPendingCaptures`) or the process exits is stopped too.
 */
export function runCapture(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  options: RunCaptureOptions = {},
): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
  const drainGraceMs = options.drainGraceMs ?? DRAIN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  // Its own process group on POSIX, so a stop reaches the grandchildren and the server's own group is never signalled.
  const ownGroup = process.platform !== "win32";
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(ownGroup ? { detached: true } : {}) });
    let output = "";
    let truncated = false;
    let finished = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_SHELL_OUTPUT) {
        output = output.slice(-MAX_SHELL_OUTPUT);
        truncated = true;
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const stop = (signal: NodeJS.Signals): void => {
      if (ownGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* the group is already gone, or never was one: signal the command itself */
        }
      }
      child.kill(signal);
    };
    let answered!: () => void;
    const entry: PendingCapture = { stop, settled: new Promise<void>((resolve) => (answered = resolve)) };
    everyPending.add(entry);
    options.pending?.add(entry);
    installExitHook();
    const finish = (exitCode: number | null, extra = ""): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (killTimer) clearTimeout(killTimer);
      everyPending.delete(entry);
      options.pending?.delete(entry);
      answered();
      // Whatever still holds the other end of a pipe keeps it. This end is read on and thrown away, not closed: a
      // background process that writes to its inherited stdout would be killed by a closed pipe on its first log line.
      // It no longer holds the event loop, so the process can still exit on its own.
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.removeListener("data", take);
        stream.on("data", () => undefined);
        stream.on("error", () => undefined);
        (stream as { unref?: () => void }).unref?.();
      }
      if (ownGroup) {
        child.unref();
      }
      done({ output: extra ? `${output}\n${extra}`.trim() : output, exitCode, truncated });
    };
    const timer = setTimeout(() => {
      truncated = true;
      output += "\n[stopped: the command ran longer than two minutes]";
      stop("SIGTERM");
      killTimer = setTimeout(() => {
        stop("SIGKILL");
        finish(null);
      }, killGraceMs);
    }, timeoutMs);
    child.on("error", (error) => finish(null, error.message));
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => finish(code), drainGraceMs);
    });
    child.on("close", (code) => finish(code));
  });
}
