// Server Command Line Interface (CLI) entry point
import * as fileOps from "node:fs";
import * as systemOs from "node:os";
import * as pathUtils from "node:path";
import { parseRuntimePreference } from "@ancilla/daemon";
import { parseAllowHosts } from "./admission.js";
import { EXIT_DATA_DIR_OWNED } from "./exitCodes.js";
import { DataDirOwnedError } from "./ownerLock.js";
import { STDIN_EOF_CAUSE, STDIN_EOF_FLAG } from "./shutdown.js";
const { mkdirSync } = fileOps;
const { homedir } = systemOs;
const { join } = pathUtils;
function formatCliUsage(): string {
  const usageLines = [
    `ancilla-server: local bridge between the Ancilla UI and Muse MSP hosts.`,
    ``,
    `Options:`,
    `  --port <n>        HTTP port (default 3127, 0 picks a free port)`,
    `  --host <addr>     bind address (default 127.0.0.1)`,
    `  --data-dir <dir>  sqlite directory, or :memory: (default ~/.ancilla)`,
    `  --static <dir>    serve a built frontend from this directory`,
    `  --token <value>   require this token on every request (needed to listen beyond this machine)`,
    `  --allow-origin <o>  browser origin allowed to connect from another site (repeatable)`,
    `  --allow-host <name>  host name this server may be reached by, for a proxy or tunnel (repeatable)`,
    `  --distro <name>   WSL distro for muse on Windows (default: WSL's default distro, else Ubuntu)`,
    `  --runtime <mode>  Windows only: native, wsl, or auto (default; native Muse once installed)`,
    `  --muse <path>     explicit muse binary path`,
  ];
  return usageLines.join("\n");
}
const RECOGNIZED_PARAM_FLAGS = [
  "--port", "--host", "--data-dir", "--static", "--token",
  "--allow-origin", "--allow-host", "--distro", "--runtime", "--muse",
];
/** Prohibits equals-style flags (--flag=value) to guard against accidental token exposure or silent misconfiguration. */
function enforceSeparatedArgFormat(cliArgs: string[]): void {
  for (const argument of cliArgs) {
    const invalidFlagMatch = RECOGNIZED_PARAM_FLAGS.find((flagPrefix) => argument.startsWith(`${flagPrefix}=`));
    if (invalidFlagMatch !== undefined) {
      throw new Error(`${invalidFlagMatch}= is not understood, and the server was not started: use ${invalidFlagMatch} <value>, with a space instead of "=".`);
    }
  }
}
function retrieveSingleFlag(cliArgs: string[], targetFlag: string): string | null {
  const positionIndex = cliArgs.indexOf(targetFlag);
  if (positionIndex === -1 || positionIndex + 1 >= cliArgs.length) {
    return null;
  }
  return cliArgs[positionIndex + 1] as string;
}
function retrieveMultipleFlags(cliArgs: string[], targetFlag: string): string[] {
  const collectedValues: string[] = [];
  for (let cursor = 0; cursor < cliArgs.length - 1; cursor += 1) {
    if (cliArgs[cursor] === targetFlag) {
      collectedValues.push(cliArgs[cursor + 1] as string);
    }
  }
  return collectedValues;
}
function retrieveMandatoryFlags(cliArgs: string[], targetFlag: string): string[] {
  const verifiedValues: string[] = [];
  cliArgs.forEach((currentArg, argIndex) => {
    if (currentArg !== targetFlag) {
      return;
    }
    const assignedValue = cliArgs[argIndex + 1];
    if (assignedValue === undefined || assignedValue.trim() === "" || assignedValue.startsWith("--")) {
      const extraTokenNotice = targetFlag === "--token"
        ? " (a long random string); without one the server would start with no protection"
        : "";
      throw new Error(`${targetFlag} needs a value${extraTokenNotice}.`);
    }
    verifiedValues.push(assignedValue);
  });
  return verifiedValues;
}
async function executeCliMain(): Promise<void> {
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  const processArguments = process.argv.slice(2);
  if (processArguments.includes("--help") || processArguments.includes("-h")) {
    process.stdout.write(formatCliUsage() + "\n");
    return;
  }
  enforceSeparatedArgFormat(processArguments);
  const assignedToken = retrieveMandatoryFlags(processArguments, "--token")[0] ?? null;
  const { hosts: canonicalHosts, invalid: rejectedHosts } = parseAllowHosts(retrieveMandatoryFlags(processArguments, "--allow-host"));
  if (rejectedHosts.length > 0) {
    const offendingHost = rejectedHosts[0] as string;
    const nonAsciiNotice = /[^\x00-\x7f]/.test(offendingHost)
      ? " A name with letters outside ASCII has to be given in its xn-- (punycode) form, as in xn--bcher-kva.example."
      : "";
    throw new Error(`--allow-host ${JSON.stringify(offendingHost)} is not a host name: pass a name such as ancilla.example, with or without a port.${nonAsciiNotice}`);
  }
  const { AncillaServer } = await import("./server.js");
  const { readRuntimeConfig } = await import("./runtimeConfig.js");
  const rawPortNumber = retrieveSingleFlag(processArguments, "--port");
  const configuredDataDir = retrieveSingleFlag(processArguments, "--data-dir") ?? join(homedir(), ".ancilla");
  const writeDiagnostic = (logMsg: string) => process.stderr.write(`[ancilla] ${new Date().toISOString()} ${logMsg}\n`);
  if (configuredDataDir !== ":memory:") {
    mkdirSync(configuredDataDir, { recursive: true });
  }
  const localConfig = configuredDataDir === ":memory:"
    ? { wslEnv: {} }
    : readRuntimeConfig(join(configuredDataDir, "runtime.json"), writeDiagnostic);
  if (process.platform === "win32") {
    for (const [varName, varVal] of Object.entries(localConfig.wslEnv)) {
      const activeWinVal = Object.entries(process.env).find(([winKey]) => winKey.toUpperCase() === varName.toUpperCase())?.[1];
      if (activeWinVal !== undefined && activeWinVal !== varVal) {
        writeDiagnostic(`runtime.json wslEnv ${varName} replaces the Windows value of ${varName} for Muse in WSL`);
      }
    }
  }
  if (localConfig.dataDirLock === false) {
    writeDiagnostic(`runtime.json dataDirLock is false: ${configuredDataDir} is not locked, so another Ancilla can open it while this one runs and each would rewrite the other's runs.`);
  }
  const { HOST_START_TIMEOUT_ENV, resolveHostStartTimeoutMs, CLI_HOST_WAITS } = await import("./hostBounds.js");
  const { closeWhenStdinEnds, createShutdown, settleStdin, shutdownSignals } = await import("./shutdown.js");
  const resolvedTimeoutMs = resolveHostStartTimeoutMs({
    env: process.env[HOST_START_TIMEOUT_ENV],
    file: localConfig.hostStartTimeoutMs,
    warn: writeDiagnostic,
  });
  const server = new AncillaServer({
    hostWaits: CLI_HOST_WAITS,
    hostStartTimeoutMs: resolvedTimeoutMs,
    port: rawPortNumber ? Number.parseInt(rawPortNumber, 10) : 3127,
    host: retrieveSingleFlag(processArguments, "--host") ?? "127.0.0.1",
    dataDir: configuredDataDir,
    staticDir: retrieveSingleFlag(processArguments, "--static"),
    token: assignedToken,
    allowOrigins: retrieveMultipleFlags(processArguments, "--allow-origin"),
    allowHosts: [...canonicalHosts, ...(localConfig.allowHosts ?? [])],
    distro: retrieveSingleFlag(processArguments, "--distro") ?? localConfig.distro,
    runtime: parseRuntimePreference(retrieveSingleFlag(processArguments, "--runtime") ?? process.env["ANCILLA_MUSE_RUNTIME"] ?? localConfig.runtime),
    musePath: retrieveSingleFlag(processArguments, "--muse") ?? localConfig.musePath,
    syncSessionNames: localConfig.syncSessionNames,
    wslEnv: localConfig.wslEnv,
    dataDirLock: localConfig.dataDirLock ?? true,
  });
  const shutdown = createShutdown({
    close: (shutdownCause) => server.close({ freePortFirst: shutdownCause === STDIN_EOF_CAUSE }),
    exit: (exitCode) => process.exit(exitCode),
    log: writeDiagnostic,
  });
  for (const signal of shutdownSignals()) {
    process.on(signal, () => shutdown(signal));
  }
  if (processArguments.includes(STDIN_EOF_FLAG)) {
    closeWhenStdinEnds(process.stdin, shutdown);
  }
  let addressInfo: { host: string; port: number };
  try {
    addressInfo = await server.listen();
  } catch (listenError) {
    if (shutdown.begun()) {
      return;
    }
    throw listenError;
  }
  if (processArguments.includes(STDIN_EOF_FLAG)) {
    await settleStdin(shutdown);
  } else {
    await new Promise<void>((tickResolve) => setImmediate(tickResolve));
  }
  if (shutdown.begun()) {
    return;
  }
  if (!assignedToken) {
    writeDiagnostic(
      `no --token was given: anything on this machine that can reach http://${addressInfo.host}:${addressInfo.port} can use this server. It will need a token in a later release; pass --token <value> to start using one now. If you use the desktop app you need do nothing yet: it cannot pass a token today.`,
    );
  }
  process.stdout.write(`ancilla-server listening on http://${addressInfo.host}:${addressInfo.port}\n`);
}
void executeCliMain().catch((launchError) => {
  if (launchError instanceof DataDirOwnedError) {
    process.stderr.write(`ancilla-server: ${launchError.message}\n`);
    process.exit(EXIT_DATA_DIR_OWNED);
  }
  process.stderr.write(`ancilla-server failed: ${String(launchError)}\n`);
  process.exit(1);
});
