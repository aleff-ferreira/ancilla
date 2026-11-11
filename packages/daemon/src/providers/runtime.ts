import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { findNativeMuse, type MuseRuntime, type RuntimePreference } from "../native.js";
import {
  defaultDistro,
  defaultExec,
  FALLBACK_DISTRO,
  parseWslList,
  planHostCommand,
  type ExecFn,
  type ExecOptions,
  type ServePlan,
} from "../wsl.js";
import {
  BUILTIN_PROVIDER_IDS,
  descriptorForProvider,
  type BuiltinProviderId,
  type ProviderId,
} from "./types.js";

export interface ProviderBinaryProbe {
  providerId: ProviderId;
  available: boolean;
  runtime: MuseRuntime | "builtin";
  binaryPath: string | null;
  distro: string | null;
  version: string | null;
}

function findWindowsCliOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const dirs = (env["Path"] ?? env["PATH"] ?? "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const appData = env["APPDATA"]?.trim();
  if (appData) {
    dirs.push(win32.join(appData, "npm"));
  }
  const localAppData = env["LOCALAPPDATA"]?.trim();
  if (localAppData) {
    dirs.push(win32.join(localAppData, "Programs", binaryName));
    dirs.push(win32.join(localAppData, "Microsoft", "WinGet", "Links"));
  }
  const extensions = [".exe", ".cmd", ".bat", ""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = win32.join(dir, `${binaryName}${ext}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export async function resolveBinaryInDistro(
  exec: ExecFn,
  distro: string,
  binaryName: string,
  options?: ExecOptions,
): Promise<string | null> {
  if (!/^[A-Za-z0-9._/-]+$/.test(binaryName)) {
    return null;
  }
  const args = ["-d", distro, "--", "sh", "-lc", `command -v ${binaryName}`];
  const result = await (options ? exec("wsl", args, options) : exec("wsl", args));
  if (result.exitCode !== 0) {
    return null;
  }
  return (
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

/**
 * Probes a single CLI provider across POSIX, native Windows, or WSL2.
 */
export async function probeProviderBinary(
  providerId: ProviderId,
  options: {
    exec?: ExecFn;
    platform?: string;
    preference?: RuntimePreference;
    distro?: string;
    configuredPath?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProviderBinaryProbe> {
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const descriptor = descriptorForProvider(providerId);

  if (descriptor.capabilities.transport === "http-api") {
    return {
      providerId,
      available: true,
      runtime: "builtin",
      binaryPath: null,
      distro: null,
      version: "built-in",
    };
  }

  const binaryName = options.configuredPath?.trim() || descriptor.binaryName;
  if (!binaryName) {
    return {
      providerId,
      available: false,
      runtime: platform === "win32" ? "native" : "posix",
      binaryPath: null,
      distro: null,
      version: null,
    };
  }

  if (platform !== "win32") {
    const checkCmd = binaryName.includes("/")
      ? `test -x "${binaryName.replace(/"/g, '\\"')}" && printf '%s\\n' "${binaryName.replace(/"/g, '\\"')}"`
      : `command -v ${binaryName}`;
    const found = await exec("sh", ["-lc", checkCmd], { timeoutMs: 5000, ...(options.env ? { env: options.env } : {}) });
    const resolved =
      found.exitCode === 0
        ? (found.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null)
        : null;
    let version: string | null = null;
    if (resolved && descriptor.versionArgs.length > 0) {
      const ver = await exec(resolved, [...descriptor.versionArgs], { timeoutMs: 4000, ...(options.env ? { env: options.env } : {}) });
      if (ver.exitCode === 0) {
        version = ver.stdout.split("\n").map((l) => l.trim()).find(Boolean) ?? null;
      }
    }
    return {
      providerId,
      available: resolved !== null,
      runtime: "posix",
      binaryPath: resolved,
      distro: null,
      version,
    };
  }

  // Windows: check native first unless pinned to WSL
  const preference = options.preference ?? "auto";
  if (preference !== "wsl") {
    const nativePath =
      providerId === "muse" && !options.configuredPath
        ? (findNativeMuse(options.env)?.binary ?? null)
        : options.configuredPath && !options.configuredPath.startsWith("/")
          ? (existsSync(options.configuredPath) ? options.configuredPath : null)
          : findWindowsCliOnPath(binaryName, options.env);
    if (nativePath) {
      return {
        providerId,
        available: true,
        runtime: "native",
        binaryPath: nativePath,
        distro: null,
        version: null,
      };
    }
    if (preference === "native") {
      return {
        providerId,
        available: false,
        runtime: "native",
        binaryPath: null,
        distro: null,
        version: null,
      };
    }
  }

  // Fall back to WSL2 discovery
  const execOpts = { timeoutMs: 6000, ...(options.env ? { env: options.env } : {}) };
  const listed = await exec("wsl", ["-l", "-v"], execOpts);
  if (listed.exitCode !== 0) {
    return {
      providerId,
      available: false,
      runtime: "wsl",
      binaryPath: null,
      distro: options.distro ?? null,
      version: null,
    };
  }
  const distros = parseWslList(listed.stdout);
  const def = defaultDistro(distros);
  const candidates = options.distro
    ? [options.distro]
    : [distros.some((d) => d.name === FALLBACK_DISTRO) ? FALLBACK_DISTRO : undefined, def?.name].filter(
        (name, idx, arr): name is string => Boolean(name) && arr.indexOf(name) === idx,
      );

  for (const distro of candidates) {
    const resolved = binaryName.startsWith("/")
      ? (await exec("wsl", ["-d", distro, "-e", "test", "-x", binaryName], execOpts)).exitCode === 0
        ? binaryName
        : null
      : await resolveBinaryInDistro(exec, distro, binaryName, execOpts);
    if (resolved) {
      return {
        providerId,
        available: true,
        runtime: "wsl",
        binaryPath: resolved,
        distro,
        version: null,
      };
    }
  }

  return {
    providerId,
    available: false,
    runtime: "wsl",
    binaryPath: null,
    distro: candidates[0] ?? null,
    version: null,
  };
}

export async function probeAllBuiltinProviders(options: {
  exec?: ExecFn;
  platform?: string;
  preference?: RuntimePreference;
  distro?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<Record<BuiltinProviderId, ProviderBinaryProbe>> {
  const entries = await Promise.all(
    BUILTIN_PROVIDER_IDS.map(async (id) => [id, await probeProviderBinary(id, options)] as const),
  );
  return Object.fromEntries(entries) as Record<BuiltinProviderId, ProviderBinaryProbe>;
}

/**
 * Plans the OS spawn command for a provider's long-lived stdio agent server (native, POSIX, or WSL2).
 */
export function planProviderServe(options: {
  providerId: ProviderId;
  platform?: string;
  runtime?: MuseRuntime;
  distro?: string | null;
  binaryPath?: string | null;
  customArgs?: readonly string[] | null;
  cwd: string;
  sandboxDisabled?: boolean;
  yoloEnabled?: boolean;
}): ServePlan {
  const platform = options.platform ?? process.platform;
  const descriptor = descriptorForProvider(options.providerId);
  const baseArgs = options.customArgs ? [...options.customArgs] : [...descriptor.serveArgs];

  if (options.providerId === "muse") {
    if (options.sandboxDisabled || options.yoloEnabled) {
      baseArgs.push("--disable-sandbox");
    }
    if (options.yoloEnabled) {
      baseArgs.push("--trust-workspace");
    }
  }

  const program = options.binaryPath || descriptor.binaryName || "acp-agent";
  if (platform === "win32" && options.runtime === "wsl") {
    const distro = options.distro || FALLBACK_DISTRO;
    if (options.binaryPath && options.binaryPath.startsWith("/")) {
      return {
        command: "wsl",
        args: ["-d", distro, "--", options.binaryPath, ...baseArgs],
        cwd: options.cwd,
        viaWsl: true,
        distro,
      };
    }
    return {
      command: "wsl",
      args: ["-d", distro, "--", "sh", "-lc", 'exec "$@"', "sh", program, ...baseArgs],
      cwd: options.cwd,
      viaWsl: true,
      distro,
    };
  }

  if (platform === "win32" && /\.(cmd|bat)$/i.test(program)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", program, ...baseArgs],
      cwd: options.cwd,
      viaWsl: false,
      distro: null,
    };
  }

  return {
    command: program,
    args: baseArgs,
    cwd: options.cwd,
    viaWsl: false,
    distro: null,
  };
}

/**
 * Plans a one-off CLI invocation (`<cli> login`, `claude auth status --json`, etc.) on native, POSIX, or WSL2.
 */
export function planProviderCli(options: {
  providerId: ProviderId;
  platform?: string;
  runtime?: MuseRuntime;
  distro?: string | null;
  binaryPath?: string | null;
  args: readonly string[];
}): { command: string; args: string[] } {
  const descriptor = descriptorForProvider(options.providerId);
  const program = options.binaryPath || descriptor.binaryName || "cli";
  const platform = options.platform ?? process.platform;

  if (platform === "win32" && options.runtime === "native") {
    if (/\.(cmd|bat)$/i.test(program)) {
      return { command: "cmd.exe", args: ["/d", "/s", "/c", program, ...options.args] };
    }
    return { command: program, args: [...options.args] };
  }

  const direct = options.binaryPath
    ? { program: options.binaryPath, args: [...options.args] }
    : { program: "sh", args: ["-lc", `exec ${program} "$@"`, program, ...options.args] };
  return planHostCommand({
    platform,
    distro: options.distro ?? undefined,
    runtime: options.runtime,
    ...direct,
  });
}
