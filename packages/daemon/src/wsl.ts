import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { findNativeMuse, type MuseRuntime, type NativeMuse, type RuntimePreference } from "./native.js";

const execFileAsync = promisify(execFileCallback);

export interface ExecResult {
  stdout: string;
  exitCode: number;
  /** What the child wrote to stderr; absent from runners that do not capture it. */
  stderr?: string;
  /** True when the child was killed because `ExecOptions.timeoutMs` passed. */
  timedOut?: boolean;
  /** True when the child was killed because `ExecOptions.signal` fired. */
  aborted?: boolean;
}

/** The longest `defaultExec` waits for a child when nobody says otherwise. */
export const DEFAULT_EXEC_TIMEOUT_MS = 30000;

/** Enough for a long `muse exec --json` answer (a research report with its event stream) without truncation. */
export const EXEC_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface ExecOptions {
  /** The child's whole environment; this process's own when absent. */
  env?: NodeJS.ProcessEnv;
  /** How long the child may run before it is killed; `DEFAULT_EXEC_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
  /** Kills the child when it fires; the result then says `aborted`. */
  signal?: AbortSignal;
}

export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface WslDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: number;
}

/** The distro Muse runs in when nobody named one and no probe has said otherwise. */
export const FALLBACK_DISTRO = "Ubuntu";

export interface ServePlan {
  command: string;
  args: string[];
  cwd: string;
  viaWsl: boolean;
  distro: string | null;
}

export function decodeCliOutput(raw: Buffer): string {
  let text: string;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.toString("utf16le");
  } else {
    text = raw.toString("utf8");
  }
  return text.replace(/\0/g, "").replace(/\r\n/g, "\n");
}

export async function defaultExec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeout = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "buffer",
      windowsHide: true,
      timeout,
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { stdout: decodeCliOutput(stdout as Buffer), stderr: decodeCliOutput(stderr as Buffer), exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; name?: unknown };
    const aborted = options.signal?.aborted === true || failure.name === "AbortError" || failure.code === "ABORT_ERR";
    // Node kills a child that outlives `timeout` and reports it killed with no exit code; an abort looks the same
    // apart from the signal, which is why the abort is checked first.
    const timedOut = !aborted && failure.killed === true && (failure.code === null || failure.code === undefined);
    const code = typeof failure.code === "number" ? failure.code : 1;
    return {
      stdout: Buffer.isBuffer(failure.stdout) ? decodeCliOutput(failure.stdout) : "",
      stderr: Buffer.isBuffer(failure.stderr) ? decodeCliOutput(failure.stderr) : "",
      exitCode: code,
      ...(timedOut ? { timedOut: true } : {}),
      ...(aborted ? { aborted: true } : {}),
    };
  }
}

export function parseWslList(output: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^name\s+state\s+version/i.test(trimmed)) {
      continue;
    }
    const match = trimmed.match(/^(\*?)\s*(\S+)\s+(\S+)\s+(\S+)/);
    if (!match) {
      continue;
    }
    distros.push({
      name: match[2] as string,
      isDefault: match[1] === "*",
      state: match[3] as string,
      version: Number.parseInt(match[4] as string, 10) || 0,
    });
  }
  return distros;
}

export function defaultDistro(distros: WslDistro[]): WslDistro | null {
  return distros.find((d) => d.isDefault) ?? distros[0] ?? null;
}

export function toWslPath(windowsPath: string): string {
  const match = windowsPath.match(/^([A-Za-z]):[\\/]+(.*)$/);
  if (!match) {
    throw new Error(`Cannot map to WSL: not an absolute Windows path: ${windowsPath}.`);
  }
  const drive = (match[1] as string).toLowerCase();
  const rest = (match[2] as string).replace(/[\\/]+/g, "/");
  return `/mnt/${drive}/${rest}`;
}

export function toWindowsPath(wslPath: string): string {
  const match = wslPath.match(/^\/mnt\/([a-z])\/(.*)$/);
  if (!match) {
    throw new Error(`Cannot map to Windows: not a /mnt/<drive> path: ${wslPath}.`);
  }
  const drive = (match[1] as string).toUpperCase();
  const rest = (match[2] as string).replace(/\//g, "\\");
  return `${drive}:\\${rest}`;
}

export async function resolveMuseInDistro(
  exec: ExecFn,
  distro: string,
  options?: ExecOptions,
): Promise<string | null> {
  const args = ["-d", distro, "--", "sh", "-lc", "command -v muse"];
  const result = await (options ? exec("wsl", args, options) : exec("wsl", args));
  if (result.exitCode !== 0) {
    return null;
  }
  const firstLine = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}

export function planServe(options: {
  platform?: string;
  distro?: string;
  musePath?: string | null;
  cwd: string;
  /** On Windows, `native` runs Windows Muse itself; anything else goes through WSL. */
  runtime?: MuseRuntime;
  /** Pass `muse serve --disable-sandbox`, lifting shell filesystem/network sandboxing for the host. */
  sandboxDisabled?: boolean;
  /** Pass `muse serve --disable-sandbox --trust-workspace`, the `muse --yolo` posture for the host. */
  yoloEnabled?: boolean;
}): ServePlan {
  const platform = options.platform ?? process.platform;
  const serveArgs = [
    "serve",
    ...(options.sandboxDisabled || options.yoloEnabled ? ["--disable-sandbox"] : []),
    ...(options.yoloEnabled ? ["--trust-workspace"] : []),
  ];
  if (platform === "win32" && options.runtime !== "native") {
    const distro = options.distro ?? FALLBACK_DISTRO;
    if (options.musePath) {
      return {
        command: "wsl",
        args: ["-d", distro, "--", options.musePath, ...serveArgs],
        cwd: options.cwd,
        viaWsl: true,
        distro,
      };
    }
    return {
      command: "wsl",
      args: ["-d", distro, "--", "sh", "-lc", ["muse", ...serveArgs].join(" ")],
      cwd: options.cwd,
      viaWsl: true,
      distro,
    };
  }
  return {
    command: options.musePath ?? "muse",
    args: serveArgs,
    cwd: options.cwd,
    viaWsl: false,
    distro: null,
  };
}

/**
 * One program run with an exact argv where Muse lives: directly off Windows, and through `wsl -e` on
 * Windows, which skips the Linux shell so paths with spaces arrive as single arguments.
 */
export function planHostCommand(options: {
  platform?: string;
  distro?: string;
  program: string;
  args: string[];
  runtime?: MuseRuntime;
}): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && options.runtime !== "native") {
    return { command: "wsl", args: ["-d", options.distro ?? FALLBACK_DISTRO, "-e", options.program, ...options.args] };
  }
  return { command: options.program, args: options.args };
}

/** A `muse` CLI call. Without a resolved path a login shell finds muse on PATH; `"$@"` passes the arguments through untouched. */
export function planMuseCli(options: {
  platform?: string;
  distro?: string;
  musePath?: string | null;
  args: string[];
  runtime?: MuseRuntime;
}): { command: string; args: string[] } {
  if (options.runtime === "native") {
    return { command: options.musePath ?? "muse", args: options.args };
  }
  const direct = options.musePath
    ? { program: options.musePath, args: options.args }
    : { program: "sh", args: ["-lc", 'exec muse "$@"', "muse", ...options.args] };
  return planHostCommand({ platform: options.platform, distro: options.distro, runtime: options.runtime, ...direct });
}

export interface EnvironmentProbe {
  platform: string;
  /** Where Muse runs. On Windows, `native` when Windows Muse is installed (unless WSL is asked for), else `wsl`. */
  runtime: MuseRuntime;
  /** Native Windows Muse, when installed, whichever runtime was picked. */
  native: NativeMuse | null;
  wslAvailable: boolean;
  distros: WslDistro[];
  /** The distro WSL starts when none is named. */
  defaultDistro: string | null;
  /** The distro Muse runs in on WSL: the one asked for, else `Ubuntu`, else the default one when Muse is only there. */
  museDistro: string | null;
  musePath: string | null;
}

export async function probeEnvironment(
  exec: ExecFn = defaultExec,
  platform: string = process.platform,
  options: {
    preference?: RuntimePreference;
    findNative?: () => NativeMuse | null;
    /** A distro Muse was pinned to. Only that one is looked in. */
    distro?: string;
    /** A Muse path Muse was pinned to. An absolute Linux path is checked where it would run, not looked up on PATH. */
    musePath?: string | null;
    /** The environment for the calls into WSL, so they see what Muse will. */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<EnvironmentProbe> {
  if (platform !== "win32") {
    const found = await exec("sh", ["-lc", "command -v muse"]);
    const musePath =
      found.exitCode === 0
        ? (found.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null)
        : null;
    return { platform, runtime: "posix", native: null, wslAvailable: false, distros: [], defaultDistro: null, museDistro: null, musePath };
  }
  const preference = options.preference ?? "auto";
  const native = (options.findNative ?? (() => findNativeMuse()))();
  // Native Muse needs no WSL at all, so WSL is not even started to look.
  if (native && preference !== "wsl") {
    return { platform, runtime: "native", native, wslAvailable: false, distros: [], defaultDistro: null, museDistro: null, musePath: native.binary };
  }
  if (preference === "native") {
    return { platform, runtime: "native", native: null, wslAvailable: false, distros: [], defaultDistro: null, museDistro: null, musePath: null };
  }
  const execOptions = options.env ? { env: options.env } : undefined;
  const run = (args: string[]) => (execOptions ? exec("wsl", args, execOptions) : exec("wsl", args));
  const pinned = options.distro?.trim() || null;
  const listed = await run(["-l", "-v"]);
  if (listed.exitCode !== 0) {
    return { platform, runtime: "wsl", native, wslAvailable: false, distros: [], defaultDistro: null, museDistro: pinned, musePath: null };
  }
  const distros = parseWslList(listed.stdout);
  const def = defaultDistro(distros);
  // Muse runs where it was pinned. Otherwise it runs in the `Ubuntu` Ancilla has always started it in, and where
  // that has no Muse (or no `Ubuntu` exists), in the default distro. The probe and the spawn then name the same one.
  const candidates = pinned
    ? [pinned]
    : [distros.some((d) => d.name === FALLBACK_DISTRO) ? FALLBACK_DISTRO : undefined, def?.name]
        .filter((name, index, all): name is string => Boolean(name) && all.indexOf(name) === index);
  const configured = options.musePath?.startsWith("/") ? options.musePath : null;
  for (const candidate of candidates) {
    const musePath = configured
      ? (await run(["-d", candidate, "-e", "test", "-x", configured])).exitCode === 0 ? configured : null
      : await resolveMuseInDistro(exec, candidate, execOptions);
    if (musePath) {
      return { platform, runtime: "wsl", native, wslAvailable: true, distros, defaultDistro: def?.name ?? null, museDistro: candidate, musePath };
    }
  }
  return {
    platform,
    runtime: "wsl",
    native,
    wslAvailable: true,
    distros,
    defaultDistro: def ? def.name : null,
    museDistro: candidates[0] ?? null,
    musePath: null,
  };
}
