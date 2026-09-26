import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRuntimePreference } from "@ancilla/daemon";

function usage(): string {
  return [
    "ancilla-server: local bridge between the Ancilla UI and Muse MSP hosts.",
    "",
    "Options:",
    "  --port <n>        HTTP port (default 3127, 0 picks a free port)",
    "  --host <addr>     bind address (default 127.0.0.1)",
    "  --data-dir <dir>  sqlite directory, or :memory: (default ~/.ancilla)",
    "  --static <dir>    serve a built frontend from this directory",
    "  --token <value>   require a token for non-loopback access",
    "  --allow-origin <o>  browser origin allowed to connect from another site (repeatable)",
    "  --distro <name>   WSL distro for muse on Windows (default: WSL's default distro, else Ubuntu)",
    "  --runtime <mode>  Windows only: native, wsl, or auto (default; native Muse once installed)",
    "  --muse <path>     explicit muse binary path",
  ].join("\n");
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return;
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
    token: flagValue(argv, "--token"),
    allowOrigins: flagValues(argv, "--allow-origin"),
    distro: flagValue(argv, "--distro") ?? local.distro,
    runtime: parseRuntimePreference(flagValue(argv, "--runtime") ?? envSetting("MUSE_RUNTIME") ?? local.runtime),
    musePath: flagValue(argv, "--muse") ?? local.musePath,
    syncSessionNames: local.syncSessionNames,
    wslEnv: local.wslEnv,
  });
  const bound = await server.listen();
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
