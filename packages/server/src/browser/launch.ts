import { spawn as nodeSpawn, execFile } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Starting the browser: headless, driven over a private pipe, with Ancilla's own profile. The sandbox is never turned
 * off: a browser that cannot start sandboxed is reported as that and left alone.
 */

/** Each flag and why. Anything not here is the browser's default. */
export function launchArgs(profileDir: string, platform: NodeJS.Platform = process.platform): string[] {
  return [
    "--headless=new", // no window: the pane draws the screencast
    "--remote-debugging-pipe", // CDP on fds 3/4, no TCP port
    `--user-data-dir=${profileDir}`, // Ancilla's own profile, never the user's everyday one
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking", // no update, safe-browsing or component pings from a tool browser
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-breakpad", // no crash uploads
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--mute-audio",
    ...(platform === "linux" ? ["--password-store=basic"] : []), // no keyring prompt
    ...(platform === "darwin" ? ["--use-mock-keychain"] : []),
    "about:blank",
  ];
}

/** The part of a child process this module uses; tests give a fake. */
export interface ChildLike {
  pid?: number;
  stdio: Array<Readable | Writable | null | undefined>;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  path: string,
  args: string[],
  options: { stdio: Array<"ignore" | "pipe">; detached: boolean; windowsHide: boolean },
) => ChildLike;
export type TaskkillFn = (pid: number) => Promise<void>;

export interface BrowserProcess {
  pid: number | undefined;
  /** Where CDP messages are written (the child's fd 3). */
  toBrowser: Writable;
  /** Where CDP messages come from (the child's fd 4). */
  fromBrowser: Readable;
  /** Resolves once with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
  hasExited(): boolean;
  /** Ends the whole process tree: the browser, its renderers and helpers. */
  killTree(): Promise<void>;
}

const defaultTaskkill: TaskkillFn = (pid) =>
  new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });

export interface LaunchOptions {
  path: string;
  profileDir: string;
  platform?: NodeJS.Platform;
  spawnFn?: SpawnFn;
  taskkill?: TaskkillFn;
}

export function launchBrowser(options: LaunchOptions): BrowserProcess {
  const platform = options.platform ?? process.platform;
  const spawnFn: SpawnFn = options.spawnFn ?? ((path, args, o) => nodeSpawn(path, args, o) as unknown as ChildLike);
  const taskkill = options.taskkill ?? defaultTaskkill;
  const child = spawnFn(options.path, launchArgs(options.profileDir, platform), {
    // fd 0-2 ignored (so a stray log line can never block the browser), 3 and 4 are the CDP pipe
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    // on POSIX its own process group, so one signal reaches every helper; on Windows taskkill /T does the tree
    detached: platform !== "win32",
    windowsHide: true,
  });
  let exited = false;
  const done = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      resolve(code);
    });
    child.on("error", () => {
      exited = true;
      resolve(null);
    });
  });
  return {
    pid: child.pid,
    toBrowser: child.stdio[3] as Writable,
    fromBrowser: child.stdio[4] as Readable,
    exited: done,
    hasExited: () => exited,
    async killTree() {
      if (child.pid === undefined) return;
      if (platform === "win32") {
        await taskkill(child.pid);
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    },
  };
}
