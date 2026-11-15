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

/**
 * Decodes process stdout/stderr buffers, transparently handling UTF-16 LE with BOM or UTF-8.
 * Normalizes newlines and strips NUL bytes.
 */
export function decodeCliOutput(raw: Buffer): string {
  const hasUtf16Bom = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe;
  const decoded = hasUtf16Bom ? raw.toString("utf16le") : raw.toString("utf8");
  return decoded.replaceAll("\0", "").replaceAll("\r\n", "\n");
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
    return {
      stdout: decodeCliOutput(stdout as Buffer),
      stderr: decodeCliOutput(stderr as Buffer),
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      name?: unknown;
    };
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

/**
 * Parses textual distribution listing emitted by `wsl.exe -l -v`.
 */
export function parseWslList(output: string): WslDistro[] {
  const recognizedDistros: WslDistro[] = [];
  const textLines = output.split("\n");

  for (const rawLine of textLines) {
    const line = rawLine.trim();
    if (!line || /^name\s+state\s+version/i.test(line)) {
      continue;
    }

    const segments = line.match(/^(\*?)\s*(\S+)\s+(\S+)\s+(\S+)/);
    if (!segments) {
      continue;
    }

    const isDefault = segments[1] === "*";
    const name = segments[2] ?? "";
    const state = segments[3] ?? "";
    const version = Number.parseInt(segments[4] ?? "0", 10) || 0;

    recognizedDistros.push({
      name,
      isDefault,
      state,
      version,
    });
  }

  return recognizedDistros;
}

export function defaultDistro(distros: WslDistro[]): WslDistro | null {
  for (const item of distros) {
    if (item.isDefault) return item;
  }
  return distros[0] ?? null;
}

/**
 * Maps an absolute Windows file path (e.g. C:\proj) to its WSL mount path (/mnt/c/proj).
 */
export function toWslPath(windowsPath: string): string {
  const match = windowsPath.match(/^([A-Za-z]):[\\/]+(.*)$/);
  if (!match) {
    throw new Error(`Cannot map to WSL: not an absolute Windows path: ${windowsPath}.`);
  }
  const driveLetter = (match[1] as string).toLowerCase();
  const subPath = (match[2] as string).replaceAll("\\", "/").replace(/\/+/g, "/");
  return `/mnt/${driveLetter}/${subPath}`;
}

/**
 * Maps a WSL mount path (/mnt/c/proj) back to an absolute Windows path (C:\proj).
 */
export function toWindowsPath(wslPath: string): string {
  const match = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) {
    throw new Error(`Cannot map to Windows: not a /mnt/<drive> path: ${wslPath}.`);
  }
  const driveLetter = (match[1] as string).toUpperCase();
  const subPath = (match[2] as string).replaceAll("/", "\\");
  return `${driveLetter}:\\${subPath}`;
}

/**
 * Executes a probe inside the designated WSL distro to determine where the `muse` binary lives.
 */
export async function resolveMuseInDistro(
  exec: ExecFn,
  distro: string,
  options?: ExecOptions,
): Promise<string | null> {
  const queryArgs = ["-d", distro, "--", "sh", "-lc", "command -v muse"];
  const res = await (options ? exec("wsl", queryArgs, options) : exec("wsl", queryArgs));
  if (res.exitCode !== 0) {
    return null;
  }

  const lines = res.stdout.split("\n");
  for (const line of lines) {
    const candidate = line.trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
  /** Additional CLI arguments appended to `muse serve` (e.g. lean voice host flags). */
  extraServeArgs?: readonly string[];
}): ServePlan {
  const targetPlatform = options.platform ?? process.platform;
  const extraFlags = options.extraServeArgs ?? [];

  const commandArguments = ["serve"];
  if (options.sandboxDisabled || options.yoloEnabled) {
    commandArguments.push("--disable-sandbox");
  }
  if (options.yoloEnabled) {
    commandArguments.push("--trust-workspace");
  }
  if (extraFlags.length > 0) {
    commandArguments.push(...extraFlags);
  }

  if (targetPlatform === "win32" && options.runtime !== "native") {
    const selectedDistro = options.distro ?? FALLBACK_DISTRO;
    if (options.musePath) {
      const execDispatchFlag = extraFlags.length > 0 ? "-e" : "--";
      return {
        command: "wsl",
        args: ["-d", selectedDistro, execDispatchFlag, options.musePath, ...commandArguments],
        cwd: options.cwd,
        viaWsl: true,
        distro: selectedDistro,
      };
    }
    const shellCommand = ["muse", ...commandArguments].map(shellQuoteArg).join(" ");
    return {
      command: "wsl",
      args: ["-d", selectedDistro, "--", "sh", "-lc", shellCommand],
      cwd: options.cwd,
      viaWsl: true,
      distro: selectedDistro,
    };
  }

  return {
    command: options.musePath ?? "muse",
    args: commandArguments,
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
  const targetPlatform = options.platform ?? process.platform;
  if (targetPlatform === "win32" && options.runtime !== "native") {
    const distroName = options.distro ?? FALLBACK_DISTRO;
    return {
      command: "wsl",
      args: ["-d", distroName, "-e", options.program, ...options.args],
    };
  }
  return {
    command: options.program,
    args: options.args,
  };
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
  const directInvocation = options.musePath
    ? { program: options.musePath, args: options.args }
    : { program: "sh", args: ["-lc", 'exec muse "$@"', "muse", ...options.args] };

  return planHostCommand({
    platform: options.platform,
    distro: options.distro,
    runtime: options.runtime,
    ...directInvocation,
  });
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
    const checkResult = await exec("sh", ["-lc", "command -v muse"]);
    let detectedPath: string | null = null;
    if (checkResult.exitCode === 0) {
      const candidates = checkResult.stdout.split("\n");
      for (const line of candidates) {
        const item = line.trim();
        if (item.length > 0) {
          detectedPath = item;
          break;
        }
      }
    }
    return {
      platform,
      runtime: "posix",
      native: null,
      wslAvailable: false,
      distros: [],
      defaultDistro: null,
      museDistro: null,
      musePath: detectedPath,
    };
  }

  const preference = options.preference ?? "auto";
  const nativeInstall = (options.findNative ?? (() => findNativeMuse()))();

  // Native Muse needs no WSL at all, so WSL is not even started to look.
  if (nativeInstall && preference !== "wsl") {
    return {
      platform,
      runtime: "native",
      native: nativeInstall,
      wslAvailable: false,
      distros: [],
      defaultDistro: null,
      museDistro: null,
      musePath: nativeInstall.binary,
    };
  }

  if (preference === "native") {
    return {
      platform,
      runtime: "native",
      native: null,
      wslAvailable: false,
      distros: [],
      defaultDistro: null,
      museDistro: null,
      musePath: null,
    };
  }

  const execOptions = options.env ? { env: options.env } : undefined;
  const invokeWsl = (cmdArgs: string[]) => (execOptions ? exec("wsl", cmdArgs, execOptions) : exec("wsl", cmdArgs));
  const pinnedDistro = options.distro?.trim() || null;

  const listProcess = await invokeWsl(["-l", "-v"]);
  if (listProcess.exitCode !== 0) {
    return {
      platform,
      runtime: "wsl",
      native: nativeInstall,
      wslAvailable: false,
      distros: [],
      defaultDistro: null,
      museDistro: pinnedDistro,
      musePath: null,
    };
  }

  const distros = parseWslList(listProcess.stdout);
  const def = defaultDistro(distros);

  // Determine candidate order: pinned distro, or Ubuntu then default distro
  const candidateNames: string[] = [];
  if (pinnedDistro) {
    candidateNames.push(pinnedDistro);
  } else {
    if (distros.some((d) => d.name === FALLBACK_DISTRO)) {
      candidateNames.push(FALLBACK_DISTRO);
    }
    if (def && !candidateNames.includes(def.name)) {
      candidateNames.push(def.name);
    }
  }

  const explicitMuseBinary = options.musePath?.startsWith("/") ? options.musePath : null;

  for (const distroName of candidateNames) {
    let resolvedBinary: string | null = null;
    if (explicitMuseBinary) {
      const probeTest = await invokeWsl(["-d", distroName, "-e", "test", "-x", explicitMuseBinary]);
      resolvedBinary = probeTest.exitCode === 0 ? explicitMuseBinary : null;
    } else {
      resolvedBinary = await resolveMuseInDistro(exec, distroName, execOptions);
    }

    if (resolvedBinary) {
      return {
        platform,
        runtime: "wsl",
        native: nativeInstall,
        wslAvailable: true,
        distros,
        defaultDistro: def?.name ?? null,
        museDistro: distroName,
        musePath: resolvedBinary,
      };
    }
  }

  return {
    platform,
    runtime: "wsl",
    native: nativeInstall,
    wslAvailable: true,
    distros,
    defaultDistro: def ? def.name : null,
    museDistro: candidateNames[0] ?? null,
    musePath: null,
  };
}
