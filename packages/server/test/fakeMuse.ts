/**
 * A `muse` that starts and then never answers: it records its pid and ignores the protocol, a SIGTERM and, unless
 * asked otherwise, the end of its input. It stands in for the host that wedges while it starts. POSIX only, since it
 * is an executable script; the suites that use it skip on Windows with that reason.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Why the fake muse cannot run on this machine, or false when it can: it is a script with a `#!<node>` line, which
 * needs a POSIX system and a node path without whitespace (a shebang cannot quote its interpreter, so a macOS
 * developer's home with a space in it would fail the suites instead of skipping them).
 */
export function fakeMuseSkipReason(platform: string, execPath: string): string | false {
  if (platform === "win32") {
    return "the fake muse is an executable script, which needs a POSIX system";
  }
  if (/\s/.test(execPath)) {
    return "the fake muse's shebang names the node binary, and a shebang cannot hold a path with whitespace";
  }
  return false;
}

/** The `skip` option of every test that starts the fake muse as a real process. */
export const FAKE_MUSE_SKIP = fakeMuseSkipReason(process.platform, process.execPath);

export interface FakeMuse {
  path: string;
  pidFile: string;
  /** The environment the server and its hosts need to find the pid file. */
  env: Record<string, string>;
}

export async function writeFakeMuse(dir: string, options: { exitOnEof?: boolean } = {}): Promise<FakeMuse> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "muse");
  const pidFile = join(dir, "muse.pid");
  const script = [
    `#!${process.execPath}`,
    `require("node:fs").writeFileSync(process.env.ANCILLA_FAKE_MUSE_PID, String(process.pid));`,
    `process.on("SIGTERM", () => {});`,
    options.exitOnEof ? `process.stdin.on("end", () => process.exit(0));` : ``,
    `process.stdin.resume();`,
    `setInterval(() => {}, 1000);`,
    ``,
  ].join("\n");
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
  return { path, pidFile, env: { ANCILLA_FAKE_MUSE_PID: pidFile } };
}

/** Whether a process with this pid is still running. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Ends the process if it is still there; a test's own cleanup, so it never throws. */
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
