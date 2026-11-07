import { posix } from "node:path";
import { resolveUserPath } from "./paths.js";

/** How long `wsl.exe` may take to name the home folder, and how long the whole read of the distro's login may take. */
export const WSL_HOME_TIMEOUT_MS = 5000;
export const WSL_READ_TIMEOUT_MS = 6000;
/** A failed look at the home folder is not repeated before this has passed. */
export const WSL_HOME_RETRY_MS = 30_000;

/** The names WSL gives distros, and no more: this goes into a `\\wsl.localhost\` path and onto a command line. */
export function isDistroName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) && !name.startsWith("-");
}

/**
 * A Linux path that maps onto a Windows one without surprises: absolute, with no control character (NUL and newline
 * among them), no backslash and no `..` segment. Null for anything else.
 */
export function cleanLinuxPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || /[\x00-\x1f\\]/.test(value)) return null;
  return value.split("/").includes("..") ? null : value;
}

/**
 * A file path Windows opens as the very file Linux would. The mapper trims a path and drops a trailing slash, and
 * Windows reads a colon in the file's own name as a stream of the file before it (`auth.json::$DATA` is `auth.json`),
 * so each of these would be another file there than the one Muse is told to use. Null for such a path, for one that
 * ends in a dot, and for an unsafe one.
 */
function cleanLinuxFile(value: string): string | null {
  const path = cleanLinuxPath(value);
  if (!path || path !== path.trim() || /[/.]$/.test(path)) return null;
  return path.slice(path.lastIndexOf("/") + 1).includes(":") ? null : path;
}

/**
 * The file Muse keeps its login in, inside the distro: an absolute `MUSE_AUTH_PATH`, else `XDG_CONFIG_HOME`, else the
 * user's home folder, taking the variables from runtime.json's `wslEnv` (this process's own are the Windows ones, and
 * one that the user's own WSLENV forwards is not seen). A variable that is not absolute is skipped; one that is
 * absolute but unsafe to map leaves no file at all, since the next choice could be another account's. `home` is only
 * asked for when nothing before it answers.
 */
export async function linuxAuthPath(env: Record<string, string>, home: () => Promise<string | null>): Promise<string | null> {
  const override = env["MUSE_AUTH_PATH"];
  if (override?.startsWith("/")) return cleanLinuxFile(override);
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg?.startsWith("/")) {
    const dir = cleanLinuxPath(xdg);
    return dir ? posix.join(dir, "muse", "auth.json") : null;
  }
  const base = await home();
  return base ? posix.join(base, ".config", "muse", "auth.json") : null;
}

/** The path Windows opens for a file in the distro, through the same mapping project folders use. Null when it has none. */
export function localAuthPath(distro: string, linuxPath: string): string | null {
  try {
    return resolveUserPath(linuxPath, { platform: "win32", home: "", distro }).local;
  } catch { return null; }
}

/** The work's answer, or null once `ms` has passed. The work is left to finish; what it does after that is not heard of. */
export async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * The home folder of the distro's user. A good answer is kept for the life of the process; a failure, whether a bad
 * answer, an error or a distro that did not answer in time, is kept for `retryMs` so that polling never starts
 * `wsl.exe` again and again. Callers that arrive together share one run.
 */
export class WslHomes {
  private readonly homes = new Map<string, string>();
  private readonly retryAt = new Map<string, number>();
  private readonly pending = new Map<string, Promise<string | null>>();
  constructor(private readonly options: {
    run: (distro: string) => Promise<string | null>; timeoutMs: number; retryMs: number; now?: () => number;
  }) {}

  async get(distro: string): Promise<string | null> {
    const known = this.homes.get(distro);
    if (known) return known;
    const now = this.options.now ?? Date.now;
    if ((this.retryAt.get(distro) ?? 0) > now()) return null;
    let pending = this.pending.get(distro);
    if (!pending) {
      pending = this.look(distro).finally(() => { this.pending.delete(distro); });
      this.pending.set(distro, pending);
    }
    return pending;
  }

  /** A failed look is not held against the distro any more: the next `get` asks again. A good answer stays. */
  forgetFailure(distro: string): void { this.retryAt.delete(distro); }

  private async look(distro: string): Promise<string | null> {
    try {
      const home = cleanLinuxPath(await withinMs(this.options.run(distro), this.options.timeoutMs));
      if (home) {
        this.homes.set(distro, home);
        return home;
      }
    } catch { /* A distro that cannot answer has no login to read this time. */ }
    this.retryAt.set(distro, (this.options.now ?? Date.now)() + this.options.retryMs);
    return null;
  }
}
