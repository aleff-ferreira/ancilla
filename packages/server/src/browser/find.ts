import { existsSync, realpathSync } from "node:fs";
import { posix } from "node:path";

/**
 * Which Chromium-family browser to drive. Pure: the file check, the platform and the environment are injected so the
 * order of preference can be tested on any machine. Edge first on Windows (every Windows 10/11 has it), then Chrome,
 * Chromium and Brave; the macOS app bundles; the usual Linux command names on PATH. `ANCILLA_BROWSER` overrides all.
 */

export type BrowserKind = "edge" | "chrome" | "chromium" | "brave" | "custom";

export interface FoundBrowser {
  kind: BrowserKind;
  path: string;
}

export interface FindResult {
  browser: FoundBrowser | null;
  /** Why nothing was found, in words the user can act on. Set only when `browser` is null. */
  reason?: string;
}

export interface FindAllResult {
  browsers: FoundBrowser[];
  /** Why nothing was found, in words the user can act on. Set only when `browsers` is empty. */
  reason?: string;
}

export interface FindOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  /** True inside WSL: the server then runs on Linux and a Windows browser is out of reach without interop (not tried). */
  isWsl?: boolean;
}

const LINUX_NAMES: Array<[string, BrowserKind]> = [
  ["google-chrome", "chrome"],
  ["google-chrome-stable", "chrome"],
  ["chromium", "chromium"],
  ["chromium-browser", "chromium"],
  ["microsoft-edge", "edge"],
  ["brave-browser", "brave"],
];

function kindOfPath(path: string): BrowserKind {
  const name = path.toLowerCase();
  if (name.includes("edge")) return "edge";
  if (name.includes("brave")) return "brave";
  if (name.includes("chromium")) return "chromium";
  if (name.includes("chrome")) return "chrome";
  return "custom";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function candidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): FoundBrowser[] {
  if (platform === "win32") {
    const pf = env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = env["LOCALAPPDATA"];
    const at = (root: string, rest: string) => `${root}\\${rest}`;
    const out: FoundBrowser[] = [];
    // Both Program Files twins, spelled out, in case the variables are missing or point elsewhere.
    for (const root of unique([pf86, pf, "C:\\Program Files (x86)", "C:\\Program Files"])) {
      out.push({ kind: "edge", path: at(root, "Microsoft\\Edge\\Application\\msedge.exe") });
    }
    for (const root of unique([pf, pf86, ...(local ? [local] : [])])) {
      out.push({ kind: "chrome", path: at(root, "Google\\Chrome\\Application\\chrome.exe") });
    }
    for (const root of unique([...(local ? [local] : []), pf, pf86])) {
      out.push({ kind: "chromium", path: at(root, "Chromium\\Application\\chrome.exe") });
    }
    for (const root of unique([pf, pf86, ...(local ? [local] : [])])) {
      out.push({ kind: "brave", path: at(root, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") });
    }
    return out;
  }
  if (platform === "darwin") {
    const home = env["HOME"];
    const bundles: Array<[string, string, BrowserKind]> = [
      ["Google Chrome.app", "Google Chrome", "chrome"],
      ["Microsoft Edge.app", "Microsoft Edge", "edge"],
      ["Chromium.app", "Chromium", "chromium"],
      ["Brave Browser.app", "Brave Browser", "brave"],
    ];
    const roots = ["/Applications", ...(home ? [`${home}/Applications`] : [])];
    return bundles.flatMap(([app, bin, kind]) => roots.map((root) => ({ kind, path: `${root}/${app}/Contents/MacOS/${bin}` })));
  }
  return [];
}

export function findBrowsers(options: FindOptions = {}): FindAllResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const resolveReal = options.exists === undefined;

  const override = env["ANCILLA_BROWSER"]?.trim();
  if (override) {
    if (exists(override)) return { browsers: [{ kind: kindOfPath(override), path: override }] };
    return { browsers: [], reason: `ANCILLA_BROWSER points at "${override}", which does not exist.` };
  }

  const browsers: FoundBrowser[] = [];
  const seenKeys = new Set<string>();
  const add = (candidate: FoundBrowser): void => {
    let canonical = candidate.path;
    if (resolveReal) {
      try {
        canonical = realpathSync(candidate.path);
      } catch {
        canonical = candidate.path;
      }
    }
    const key = platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    browsers.push(candidate);
  };

  for (const candidate of candidates(platform, env)) {
    if (exists(candidate.path)) add(candidate);
  }
  if (browsers.length > 0) return { browsers };

  if (platform === "linux") {
    const dirs = (env["PATH"] ?? "").split(posix.delimiter).filter(Boolean);
    for (const [name, kind] of LINUX_NAMES) {
      for (const dir of dirs) {
        const path = posix.join(dir, name);
        if (exists(path)) add({ kind, path });
      }
    }
    if (browsers.length > 0) return { browsers };
    const wsl = options.isWsl ?? Boolean(env["WSL_DISTRO_NAME"]);
    return {
      browsers: [],
      reason: wsl
        ? "This server runs inside WSL and no Linux browser is installed there (looked for google-chrome, chromium, microsoft-edge, brave-browser on PATH). Install one in the distro, or set ANCILLA_BROWSER to its path. A Windows browser is not used through WSL interop."
        : "No Chromium-family browser was found on PATH (looked for google-chrome, google-chrome-stable, chromium, chromium-browser, microsoft-edge, brave-browser). Install one, or set ANCILLA_BROWSER to its path.",
    };
  }
  return {
    browsers: [],
    reason: `No Edge, Chrome, Chromium or Brave was found in the usual places on this ${platform === "win32" ? "Windows" : "macOS"} machine. Install one, or set ANCILLA_BROWSER to its path.`,
  };
}

export function findBrowser(options: FindOptions = {}): FindResult {
  const found = findBrowsers(options);
  if (found.browsers[0]) return { browser: found.browsers[0] };
  return { browser: null, ...(found.reason !== undefined ? { reason: found.reason } : {}) };
}
