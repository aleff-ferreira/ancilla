import { readFileSync } from "node:fs";

/**
 * `runtime.json` in the data dir: the machine's runtime, WSL distro, Muse path, title sharing and the environment
 * Muse gets inside WSL. People write it by hand, often from Windows PowerShell, which saves UTF-8 with a byte order
 * mark (`Set-Content -Encoding utf8`) or UTF-16 (`>`). None of it may stop the server: a file that cannot be read is
 * ignored as a whole, and a field that is wrong is ignored on its own, each with one line saying why.
 */
export interface RuntimeConfig {
  runtime?: string;
  distro?: string;
  musePath?: string;
  syncSessionNames?: boolean;
  /** Environment variables for Muse inside WSL, never set on the server itself. */
  wslEnv: Record<string, string>;
}

const RUNTIMES = new Set(["native", "windows", "wsl", "auto"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** WSL itself decides these across the boundary; a value here would break the crossing rather than set it. */
const RESERVED_ENV = new Set(["WSLENV", "PATH"]);

/** File text in whatever Windows tools wrote: UTF-16 by its byte order mark, else UTF-8, without a leading mark. */
export function decodeConfigText(bytes: Buffer): string {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString("utf16le");
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else {
    text = bytes.toString("utf8");
  }
  return text.replace(/^﻿/, "");
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "a list" : typeof value;
}

/** Reads the file's bytes into settings, and says what it left out. Never throws. */
export function parseRuntimeConfig(bytes: Buffer): { config: RuntimeConfig | null; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeConfigText(bytes));
  } catch (error) {
    return { config: null, warnings: [`it is not valid JSON (${error instanceof Error ? error.message : String(error)})`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { config: null, warnings: [`it holds ${describe(parsed)}, not a JSON object`] };
  }
  const raw = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  const config: RuntimeConfig = { wslEnv: {} };
  const text = (key: "runtime" | "distro" | "musePath"): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value === "string" && value.trim()) return value.trim();
    warnings.push(`"${key}" was ignored: it must be a non-empty string, not ${describe(value)}`);
    return undefined;
  };
  const runtime = text("runtime");
  if (runtime !== undefined) {
    if (RUNTIMES.has(runtime.toLowerCase())) {
      config.runtime = runtime;
    } else {
      warnings.push(`"runtime" was ignored: "${runtime}" is not native, wsl or auto`);
    }
  }
  const distro = text("distro");
  if (distro !== undefined) config.distro = distro;
  const musePath = text("musePath");
  if (musePath !== undefined) config.musePath = musePath;
  if (raw["syncSessionNames"] !== undefined) {
    if (typeof raw["syncSessionNames"] === "boolean") {
      config.syncSessionNames = raw["syncSessionNames"];
    } else {
      warnings.push(`"syncSessionNames" was ignored: it must be true or false, not ${describe(raw["syncSessionNames"])}`);
    }
  }
  const env = raw["wslEnv"];
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      warnings.push(`"wslEnv" was ignored: it must be an object of names and values, not ${describe(env)}`);
    } else {
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        if (!ENV_NAME.test(key)) {
          warnings.push(`wslEnv "${key}" was ignored: it is not an environment variable name`);
        } else if (RESERVED_ENV.has(key.toUpperCase())) {
          warnings.push(`wslEnv "${key}" was ignored: WSL sets it itself`);
        } else if (typeof value !== "string" || value.includes("\0")) {
          warnings.push(`wslEnv "${key}" was ignored: its value must be a string, not ${describe(value)}`);
        } else {
          config.wslEnv[key] = value;
        }
      }
    }
  }
  return { config, warnings };
}

/**
 * The data dir's `runtime.json`, or no settings when there is none or it cannot be read. Every problem is reported
 * through `warn`, one line each, naming the file; the caller keeps them off stdout, whose first line is the desktop
 * app's readiness handshake.
 */
export function readRuntimeConfig(file: string, warn: (message: string) => void): RuntimeConfig {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`runtime.json ignored (${file}): ${error instanceof Error ? error.message : String(error)}`);
    }
    return { wslEnv: {} };
  }
  const { config, warnings } = parseRuntimeConfig(bytes);
  for (const warning of warnings) {
    warn(config ? `runtime.json (${file}): ${warning}` : `runtime.json ignored (${file}): ${warning}`);
  }
  return config ?? { wslEnv: {} };
}

/**
 * The environment for one process started through `wsl.exe`: `base` with `vars` on top (they win over a Windows
 * variable of the same name, whatever its case) and a `WSLENV` naming each of them, plus `forward` entries, so they
 * reach Linux. The entry `base` already has for a name keeps its flags.
 */
export function wslSpawnEnv(
  base: NodeJS.ProcessEnv,
  vars: Record<string, string>,
  forward: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  const names = new Set(Object.keys(vars).map((key) => key.toUpperCase()));
  for (const [key, value] of Object.entries(base)) {
    // Windows names are not case sensitive, so an older spelling would sit beside the new value and either could win.
    if (typeof value === "string" && !names.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  Object.assign(env, vars);
  const wslenvKey = Object.keys(base).find((key) => key.toUpperCase() === "WSLENV") ?? "WSLENV";
  const entries = (base[wslenvKey] ?? "").split(":").filter(Boolean);
  const named = (entry: string) => entry.split("/")[0]!;
  const forwarded = [...entries];
  for (const entry of [...Object.keys(vars).map((key) => `${key}/u`), ...forward]) {
    const index = forwarded.findIndex((existing) => named(existing) === named(entry));
    if (index === -1) {
      forwarded.push(entry);
    } else if (forward.includes(entry)) {
      forwarded[index] = entry;
    }
  }
  delete env[wslenvKey];
  env["WSLENV"] = forwarded.join(":");
  return env;
}
