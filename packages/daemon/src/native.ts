import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Resolved location and launcher details for a native Windows Muse installation.
 */
export interface NativeMuse {
  /** Full path to the executable binary. */
  binary: string;
  /** Directory containing the installation artifacts. */
  dir: string;
  /** Release version tag, or null for unversioned binaries. */
  version: string | null;
  /** Full path to the PowerShell updater script, if present. */
  launcher: string | null;
}

/** Execution environment for Muse host processes. */
export type MuseRuntime = "posix" | "native" | "wsl";

/** User preference for selecting runtime environment on Windows platforms. */
export type RuntimePreference = "auto" | "native" | "wsl";

/** Abstract filesystem access for testability and portability. */
export interface FileProbe {
  exists(path: string): boolean;
  read(path: string): string | null;
}

const defaultFileProbe: FileProbe = {
  exists: (targetPath: string): boolean => existsSync(targetPath),
  read: (targetPath: string): string | null => {
    try {
      return readFileSync(targetPath, "utf-8");
    } catch {
      return null;
    }
  },
};

const RELEASE_TAG_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(?:\.[0-9]+)?$/;
const AUTO_UPDATE_INTERVAL_SEC = 3600;

function isValidReleaseTag(version: string): boolean {
  return RELEASE_TAG_REGEX.test(version);
}

function probeManagedInstall(directory: string, probe: FileProbe): NativeMuse | null {
  const versionFile = win32.join(directory, ".muse-version");
  const rawVersion = probe.read(versionFile)?.trim();
  if (!rawVersion || !isValidReleaseTag(rawVersion)) return null;

  const binaryPath = win32.join(directory, `muse-bin-${rawVersion}.exe`);
  if (!probe.exists(binaryPath)) return null;

  const launcherScript = win32.join(directory, ".muse-launcher.ps1");
  const launcher = probe.exists(launcherScript) ? launcherScript : null;

  return {
    binary: binaryPath,
    dir: directory,
    version: rawVersion,
    launcher,
  };
}

/**
 * Locates an active native Windows Muse installation.
 * Checks MUSE_INSTALL_DIR override, %LOCALAPPDATA%\Programs\muse, and system PATH directories.
 */
export function findNativeMuse(
  env: NodeJS.ProcessEnv = process.env,
  files: FileProbe = defaultFileProbe,
): NativeMuse | null {
  const candidateDirectories: string[] = [];

  const explicitDir = env["MUSE_INSTALL_DIR"]?.trim();
  if (explicitDir) {
    candidateDirectories.push(explicitDir);
  }

  const localAppData = env["LOCALAPPDATA"]?.trim();
  if (localAppData) {
    candidateDirectories.push(win32.join(localAppData, "Programs", "muse"));
  }

  const pathVar = env["Path"] ?? env["PATH"] ?? "";
  const pathEntries = pathVar
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Check managed installations (with version metadata) first
  for (const dir of [...candidateDirectories, ...pathEntries]) {
    const install = probeManagedInstall(dir, files);
    if (install) return install;
  }

  // Fallback: look for a standalone muse.exe on PATH
  for (const dir of pathEntries) {
    const standaloneBinary = win32.join(dir, "muse.exe");
    if (files.exists(standaloneBinary)) {
      return {
        binary: standaloneBinary,
        dir,
        version: null,
        launcher: null,
      };
    }
  }

  return null;
}

/**
 * Retrieves the release metadata payload (.muse-release-info.json) matching the installed version.
 */
export function nativeReleaseInfo(muse: NativeMuse, files: FileProbe = defaultFileProbe): string | null {
  if (!muse.version) return null;

  const metadataPath = win32.join(muse.dir, ".muse-release-info.json");
  const content = files.read(metadataPath);
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed["version"] === muse.version ? content : null;
  } catch {
    return null;
  }
}

/**
 * Schedules an hourly background update check using the PowerShell launcher script.
 * Returns true if an update subprocess was initiated, false otherwise.
 */
export function refreshNativeMuse(muse: NativeMuse, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!muse.launcher || env["MUSE_NO_AUTO_UPDATE"] === "1") return false;

  try {
    const stampFile = win32.join(muse.dir, ".muse-update-checked-at");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lastChecked = Number.parseInt(defaultFileProbe.read(stampFile)?.trim() ?? "", 10);

    if (Number.isFinite(lastChecked) && nowSeconds - lastChecked < AUTO_UPDATE_INTERVAL_SEC) {
      return false;
    }

    writeFileSync(stampFile, `${nowSeconds}\n`);

    const systemRoot = env["SystemRoot"] ?? "C:\\Windows";
    const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    const subprocess = spawn(
      powershell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", muse.launcher],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...env,
          PSModulePath: undefined,
          MUSE_INTERNAL_UPDATE: "1",
          MUSE_LOGIN: "0",
        },
      },
    );

    subprocess.on("error", () => {});
    subprocess.unref();

    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves user runtime preference from CLI argument or environment variable.
 */
export function parseRuntimePreference(value: string | null | undefined): RuntimePreference {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "native":
    case "windows":
      return "native";
    case "wsl":
      return "wsl";
    default:
      return "auto";
  }
}
