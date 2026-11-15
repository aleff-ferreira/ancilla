// Runtime configuration loader and WSL environment bridge
import fs from "node:fs";
import { normalizeAllowHost } from "./admission.js";
import { parseHostStartTimeoutMs } from "./hostBounds.js";
/** Machine-local runtime configuration options loaded from runtime.json. */
export interface RuntimeConfig {
  runtime?: string;
  distro?: string;
  musePath?: string;
  syncSessionNames?: boolean;
  allowHosts?: string[];
  hostStartTimeoutMs?: number;
  dataDirLock?: boolean;
  wslEnv: Record<string, string>;
}
const VALID_RUNTIME_MODES = new Set(["native", "windows", "wsl", "auto"]);
const VALID_ENV_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYSTEM_RESERVED_ENV_KEYS = new Set(["WSLENV", "PATH"]);
/** Decodes file buffer supporting UTF-8 BOM, UTF-16LE, and UTF-16BE encodings. */
export function decodeConfigText(inputBuffer: Buffer): string {
  let decodedString: string;
  if (inputBuffer.length >= 2 && inputBuffer[0] === 0xff && inputBuffer[1] === 0xfe) {
    decodedString = inputBuffer.subarray(2).toString("utf16le");
  } else if (inputBuffer.length >= 2 && inputBuffer[0] === 0xfe && inputBuffer[1] === 0xff) {
    const swappedBuffer = Buffer.from(inputBuffer.subarray(2));
    swappedBuffer.swap16();
    decodedString = swappedBuffer.toString("utf16le");
  } else {
    decodedString = inputBuffer.toString("utf8");
  }
  return decodedString.replace(/^\ufeff/, "");
}
function describeType(targetValue: unknown): string {
  return targetValue === null ? "null" : Array.isArray(targetValue) ? "a list" : typeof targetValue;
}
/** Parses raw JSON bytes into typed RuntimeConfig with descriptive diagnostic warnings. */
export function parseRuntimeConfig(configBytes: Buffer): { config: RuntimeConfig | null; warnings: string[] } {
  let parsedJsonPayload: unknown;
  try {
    parsedJsonPayload = JSON.parse(decodeConfigText(configBytes));
  } catch (parseErr) {
    const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return { config: null, warnings: [`it is not valid JSON (${errMsg})`] };
  }
  if (typeof parsedJsonPayload !== "object" || parsedJsonPayload === null || Array.isArray(parsedJsonPayload)) {
    return { config: null, warnings: [`it holds ${describeType(parsedJsonPayload)}, not a JSON object`] };
  }
  const rawRecord = parsedJsonPayload as Record<string, unknown>;
  const recordedWarnings: string[] = [];
  const assembledConfig: RuntimeConfig = { wslEnv: {} };
  const extractValidString = (propName: "runtime" | "distro" | "musePath"): string | undefined => {
    const rawVal = rawRecord[propName];
    if (rawVal === undefined) return undefined;
    if (typeof rawVal === "string" && rawVal.trim().length > 0) return rawVal.trim();
    recordedWarnings.push(`"${propName}" was ignored: it must be a non-empty string, not ${describeType(rawVal)}`);
    return undefined;
  };
  const requestedRuntime = extractValidString("runtime");
  if (requestedRuntime !== undefined) {
    if (VALID_RUNTIME_MODES.has(requestedRuntime.toLowerCase())) {
      assembledConfig.runtime = requestedRuntime;
    } else {
      recordedWarnings.push(`"runtime" was ignored: "${requestedRuntime}" is not native, wsl or auto`);
    }
  }
  const requestedDistro = extractValidString("distro");
  if (requestedDistro !== undefined) {
    assembledConfig.distro = requestedDistro;
  }
  const requestedMusePath = extractValidString("musePath");
  if (requestedMusePath !== undefined) {
    assembledConfig.musePath = requestedMusePath;
  }
  for (const flagKey of ["syncSessionNames", "dataDirLock"] as const) {
    const rawFlagVal = rawRecord[flagKey];
    if (rawFlagVal !== undefined) {
      if (typeof rawFlagVal === "boolean") {
        assembledConfig[flagKey] = rawFlagVal;
      } else {
        recordedWarnings.push(`"${flagKey}" was ignored: it must be true or false, not ${describeType(rawFlagVal)}`);
      }
    }
  }
  const hostCatalog = rawRecord["allowHosts"];
  if (hostCatalog !== undefined) {
    if (!Array.isArray(hostCatalog)) {
      recordedWarnings.push(`"allowHosts" was ignored: it must be a list of host names, not ${describeType(hostCatalog)}`);
    } else {
      const uniqueHosts: string[] = [];
      for (const hostItem of hostCatalog) {
        const canonicalHost = typeof hostItem === "string" ? normalizeAllowHost(hostItem) : null;
        if (canonicalHost === null) {
          recordedWarnings.push(`"allowHosts" entry ${JSON.stringify(hostItem)} was ignored: it is not a host name`);
        } else if (!uniqueHosts.includes(canonicalHost)) {
          uniqueHosts.push(canonicalHost);
        }
      }
      if (uniqueHosts.length > 0) {
        assembledConfig.allowHosts = uniqueHosts;
      }
    }
  }
  if (rawRecord["hostStartTimeoutMs"] !== undefined) {
    const parsedTimeout = parseHostStartTimeoutMs(rawRecord["hostStartTimeoutMs"]);
    if (parsedTimeout !== null) {
      assembledConfig.hostStartTimeoutMs = parsedTimeout;
    } else {
      recordedWarnings.push(`"hostStartTimeoutMs" was ignored: it must be whole milliseconds (0 turns the limit off), not ${describeType(rawRecord["hostStartTimeoutMs"])}`);
    }
  }
  const customWslEnvironment = rawRecord["wslEnv"];
  if (customWslEnvironment !== undefined) {
    if (typeof customWslEnvironment !== "object" || customWslEnvironment === null || Array.isArray(customWslEnvironment)) {
      recordedWarnings.push(`"wslEnv" was ignored: it must be an object of names and values, not ${describeType(customWslEnvironment)}`);
    } else {
      for (const [varName, varValue] of Object.entries(customWslEnvironment as Record<string, unknown>)) {
        if (!VALID_ENV_IDENTIFIER.test(varName)) {
          recordedWarnings.push(`wslEnv "${varName}" was ignored: it is not an environment variable name`);
        } else if (SYSTEM_RESERVED_ENV_KEYS.has(varName.toUpperCase())) {
          recordedWarnings.push(`wslEnv "${varName}" was ignored: WSL sets it itself`);
        } else if (typeof varValue !== "string" || varValue.includes("\0")) {
          recordedWarnings.push(`wslEnv "${varName}" was ignored: its value must be a string, not ${describeType(varValue)}`);
        } else {
          assembledConfig.wslEnv[varName] = varValue;
        }
      }
    }
  }
  return { config: assembledConfig, warnings: recordedWarnings };
}
/** Reads runtime.json file from disk, returning default configuration on failure or absence. */
export function readRuntimeConfig(filePath: string, warningSink: (detail: string) => void): RuntimeConfig {
  let rawFileContent: Buffer;
  try {
    rawFileContent = fs.readFileSync(filePath);
  } catch (ioErr) {
    if ((ioErr as NodeJS.ErrnoException).code !== "ENOENT") {
      const ioMsg = ioErr instanceof Error ? ioErr.message : String(ioErr);
      warningSink(`runtime.json ignored (${filePath}): ${ioMsg}`);
    }
    return { wslEnv: {} };
  }
  const { config: loadedConfig, warnings: detectedWarnings } = parseRuntimeConfig(rawFileContent);
  for (const warningLine of detectedWarnings) {
    const formattedWarning = loadedConfig
      ? `runtime.json (${filePath}): ${warningLine}`
      : `runtime.json ignored (${filePath}): ${warningLine}`;
    warningSink(formattedWarning);
  }
  return loadedConfig ?? { wslEnv: {} };
}
/** Synthesizes a child process environment for wsl.exe with proper WSLENV variable bridging. */
export function wslSpawnEnv(
  parentEnv: NodeJS.ProcessEnv,
  overrideVars: Record<string, string>,
  forwardFlags: string[] = [],
): Record<string, string> {
  const resultEnv: Record<string, string> = {};
  const overrideKeySet = new Set(Object.keys(overrideVars).map((k) => k.toUpperCase()));
  for (const [parentKey, parentValue] of Object.entries(parentEnv)) {
    if (typeof parentValue === "string" && !overrideKeySet.has(parentKey.toUpperCase())) {
      resultEnv[parentKey] = parentValue;
    }
  }
  Object.assign(resultEnv, overrideVars);
  const detectedWslenvKey = Object.keys(parentEnv).find((keyName) => keyName.toUpperCase() === "WSLENV") ?? "WSLENV";
  const existingWslenvTokens = (parentEnv[detectedWslenvKey] ?? "").split(":").filter(Boolean);
  const extractVarName = (token: string) => token.split("/")[0]!;
  const mergedTokens = [...existingWslenvTokens];
  const candidateBridgeTokens = [
    ...Object.keys(overrideVars).map((varKey) => `${varKey}/u`),
    ...forwardFlags,
  ];
  for (const bridgeToken of candidateBridgeTokens) {
    const matchIndex = mergedTokens.findIndex((tok) => extractVarName(tok) === extractVarName(bridgeToken));
    if (matchIndex === -1) {
      mergedTokens.push(bridgeToken);
    } else if (forwardFlags.includes(bridgeToken)) {
      mergedTokens[matchIndex] = bridgeToken;
    }
  }
  delete resultEnv[detectedWslenvKey];
  resultEnv["WSLENV"] = mergedTokens.join(":");
  return resultEnv;
}
