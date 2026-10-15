import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRuntimePreference } from "@ancilla/daemon";
import { parseAllowHosts } from "./admission.js";

function usage(): string {
  return [
    "ancilla-server: local bridge between the Ancilla UI and Muse MSP hosts.",
    "",
    "Options:",
    "  --port <n>        HTTP port (default 3127, 0 picks a free port)",
    "  --host <addr>     bind address (default 127.0.0.1)",
    "  --data-dir <dir>  sqlite directory, or :memory: (default ~/.ancilla)",
    "  --static <dir>    serve a built frontend from this directory",
    "  --token <value>   require this token on every request (needed to listen beyond this machine)",
    "  --allow-origin <o>  browser origin allowed to connect from another site (repeatable)",
    "  --allow-host <name>  host name this server may be reached by, for a proxy or tunnel (repeatable)",
    "  --distro <name>   WSL distro for muse on Windows (default: WSL's default distro, else Ubuntu)",
    "  --runtime <mode>  Windows only: native, wsl, or auto (default; native Muse once installed)",
    "  --muse <path>     explicit muse binary path",
  ].join("\n");
}

/** The flags that take a value, as the one form this parser reads: the name, a space, the value. */
const VALUE_FLAGS = ["--port", "--host", "--data-dir", "--static", "--token", "--allow-origin", "--allow-host", "--distro", "--runtime", "--muse"];

/**
 * `--token=abc` is not read by this parser, and ignoring it would start the server with no token: the same fail-open
 * as `--token ""`. Any known flag written with `=` is an error. The value is left out of the message: it may be the token.
 */
function rejectEqualsForms(argv: string[]): void {
  for (const arg of argv) {
    const flag = VALUE_FLAGS.find((name) => arg.startsWith(`${name}=`));
    if (flag !== undefined) {
      throw new Error(`${flag}= is not understood, and the server was not started: use ${flag} <value>, with a space instead of "=".`);
    }
  }
}

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) {
    return null;
  }
  return argv[index + 1] as string;
}

/** Every occurrence of a repeatable flag, as in `--allow-origin a --allow-origin b`. */
function flagValues(argv: string[], name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === name) {
      found.push(argv[index + 1] as string);
    }
  }
  return found;
}

/**
 * Every value of a flag that takes one. A flag with no value, an empty one, or another flag where its value should be
 * is an error: `--token` read as "no token" would start the server open to whoever reaches it.
 */
function flagValuesRequired(argv: string[], name: string): string[] {
  const found: string[] = [];
  argv.forEach((arg, index) => {
    if (arg !== name) {
      return;
    }
    const value = argv[index + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new Error(`${name} needs a value${name === "--token" ? " (a long random string); without one the server would start with no protection" : ""}.`);
    }
    found.push(value);
  });
  return found;
}

async function main(): Promise<void> {
  // The desktop shell reads the first stdout line and closes its end of the pipe. A write that finds the pipe closed
  // is not a reason to stop serving.
  process.stdout.on("error", () => undefined);
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return;
  }
  rejectEqualsForms(argv);
  const token = flagValuesRequired(argv, "--token")[0] ?? null;
  const { hosts: allowHosts, invalid } = parseAllowHosts(flagValuesRequired(argv, "--allow-host"));
  if (invalid.length > 0) {
    const first = invalid[0] as string;
    const international = /[^\x00-\x7f]/.test(first)
      ? " A name with letters outside ASCII has to be given in its xn-- (punycode) form, as in xn--bcher-kva.example."
      : "";
    throw new Error(`--allow-host ${JSON.stringify(first)} is not a host name: pass a name such as ancilla.example, with or without a port.${international}`);
  }
  const { AncillaServer } = await import("./server.js");
  const { envSetting, importLegacyRuntime } = await import("./legacy.js");
  const { readRuntimeConfig } = await import("./runtimeConfig.js");
  const portRaw = flagValue(argv, "--port");
  const dataDir = flagValue(argv, "--data-dir") ?? join(homedir(), ".ancilla");
  // Only stderr: stdout's first line is the readiness handshake.
  const log = (message: string) => process.stderr.write(`[ancilla] ${new Date().toISOString()} ${message}\n`);
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    // A first start brings Helicon's runtime choice along.
    importLegacyRuntime(dataDir, homedir(), log);
  }
  // Machine-local runtime selection survives replacing the bundled server on an app update. A file or field that
  // cannot be used is left out with a line in the log; the server starts either way.
  const local = dataDir === ":memory:" ? { wslEnv: {} } : readRuntimeConfig(join(dataDir, "runtime.json"), log);
  if (process.platform === "win32") {
    for (const [key, value] of Object.entries(local.wslEnv)) {
      const windows = Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1];
      if (windows !== undefined && windows !== value) {
        log(`runtime.json wslEnv ${key} replaces the Windows value of ${key} for Muse in WSL`);
      }
    }
  }
  const server = new AncillaServer({
    port: portRaw ? Number.parseInt(portRaw, 10) : 3127,
    host: flagValue(argv, "--host") ?? "127.0.0.1",
    dataDir,
    staticDir: flagValue(argv, "--static"),
    token,
    allowOrigins: flagValues(argv, "--allow-origin"),
    // Flags and runtime.json add up: the file is how desktop users, who cannot pass flags, open the door for a proxy.
    allowHosts: [...allowHosts, ...(local.allowHosts ?? [])],
    distro: flagValue(argv, "--distro") ?? local.distro,
    runtime: parseRuntimePreference(flagValue(argv, "--runtime") ?? envSetting("MUSE_RUNTIME") ?? local.runtime),
    musePath: flagValue(argv, "--muse") ?? local.musePath,
    syncSessionNames: local.syncSessionNames,
    wslEnv: local.wslEnv,
  });
  const bound = await server.listen();
  if (!token) {
    log(
      `no --token was given: anything on this machine that can reach http://${bound.host}:${bound.port} can use this server. It will need a token in a later release; pass --token <value> to start using one now. If you use the desktop app you need do nothing yet: it cannot pass a token today.`,
    );
  }
  process.stdout.write(`ancilla-server listening on http://${bound.host}:${bound.port}\n`);
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  process.stderr.write(`ancilla-server failed: ${String(error)}\n`);
  process.exit(1);
});
