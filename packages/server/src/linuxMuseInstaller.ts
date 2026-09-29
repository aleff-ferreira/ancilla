import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseLoginOutput } from "@harjjotsinghh/aonia";

const INSTALLER_URL = "https://dev.meta.ai/install.sh";
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;

export interface LinuxInstallState {
  status: "idle" | "installing" | "installed" | "error" | "cancelled";
  phase: "idle" | "download" | "install" | "signin" | "complete" | "error" | "cancelled";
  message: string;
  attemptId: string | null;
  loginUrl: string | null;
  loginCode: string | null;
}

interface InstallerRunOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onOutput(chunk: string): void;
}

export type LinuxInstallerRunner = (script: string, options: InstallerRunOptions) => Promise<number | null>;
type InstallerFetch = (url: string, options: { signal: AbortSignal; redirect: "error" }) => Promise<Response>;

export interface LinuxMuseInstallerOptions {
  platform: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  fetch?: InstallerFetch;
  run?: LinuxInstallerRunner;
  timeoutMs?: number;
}

/** The installer and all curl/launcher children belong to this one cancellable process group. */
const runInstaller: LinuxInstallerRunner = (script, options) => new Promise((resolve, reject) => {
  const child = spawn("/bin/bash", [script], {
    cwd: options.home,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform === "linux",
  });
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const signalChild = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === "linux" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The owned process may have exited between cancellation and delivery.
    }
  };
  const cancel = () => {
    signalChild("SIGTERM");
    forceStop = setTimeout(() => signalChild("SIGKILL"), 2000);
    forceStop.unref();
  };
  const cleanup = () => {
    // A leader can exit while a detached descendant ignores TERM and has closed its output pipes.
    // Finish cancelling the owned group before a retry is allowed to write the same installation.
    if (options.signal.aborted) signalChild("SIGKILL");
    options.signal.removeEventListener("abort", cancel);
    if (forceStop) clearTimeout(forceStop);
  };
  child.stdout.on("data", (chunk: Buffer) => options.onOutput(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => options.onOutput(chunk.toString("utf8")));
  child.on("error", (error) => { cleanup(); reject(error); });
  child.on("close", (code) => { cleanup(); resolve(code); });
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
});

/** Only Meta's device authorization links are exposed as installer actions. */
export function installerLogin(text: string): { url: string; code: string | null } | null {
  const parsed = parseLoginOutput(text);
  if (!parsed.url) return null;
  try {
    const url = new URL(parsed.url.replace(/[).,;]+$/, ""));
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!["auth.meta.com", "www.meta.com", "meta.com", "meta.ai", "www.meta.ai"].includes(url.hostname)) return null;
    return { url: url.toString(), code: parsed.code };
  } catch { return null; }
}

function installFailure(output: string, error?: unknown): string {
  if (/required command not found: curl|curl: (?:command )?not found/i.test(output)) {
    return "Muse needs curl to download its files. Install Ancilla using the .deb or .rpm package so your system installs the required tools, then try again.";
  }
  if (/permission denied|not permitted|read-only file system/i.test(output)) {
    return "Muse could not write to your account’s installation folder. Check that you own ~/.local/bin and can write there, then try again.";
  }
  if (/HTTP (?:401|403)|not entitled|subscription|access denied/i.test(output)) {
    return "Meta did not allow the Muse download. Try again and sign in with the Meta account that owns your Muse Code plan.";
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return "The Bash installer could not start. Install Ancilla using the .deb or .rpm package to include the required tools.";
  }
  return "Muse installation did not finish. Check your internet connection, then choose Try again. Your existing login and threads are kept.";
}

/** One official, user-requested installation at a time. No request controls its URL, executable or arguments. */
export class LinuxMuseInstaller {
  private state: LinuxInstallState = {
    status: "idle", phase: "idle", message: "Install Muse Code to connect your Meta subscription.",
    attemptId: null, loginUrl: null, loginCode: null,
  };
  private active: { id: string; abort: AbortController; done: Promise<void> } | null = null;
  private disposed = false;

  constructor(private readonly options: LinuxMuseInstallerOptions) {}

  snapshot(): LinuxInstallState { return { ...this.state }; }

  async start(): Promise<LinuxInstallState> {
    if (this.options.platform !== "linux") throw new Error("In-app Muse installation is available on Linux.");
    if (this.disposed) throw new Error("Ancilla is shutting down.");
    if (!isAbsolute(this.options.home)) throw new Error("Muse installation needs an absolute home directory.");
    // Wait for a cancelled child to exit before a retry can write the same install directory.
    while (this.active && this.state.status !== "installing") await this.active.done;
    if (this.active) return this.snapshot();
    if (this.disposed) throw new Error("Ancilla is shutting down.");
    const id = randomUUID();
    const abort = new AbortController();
    const active = { id, abort, done: Promise.resolve() };
    this.active = active;
    this.state = {
      status: "installing", phase: "download", message: "Downloading Meta’s Muse installer…",
      attemptId: id, loginUrl: null, loginCode: null,
    };
    active.done = this.install(id, abort).finally(() => { if (this.active === active) this.active = null; });
    return this.snapshot();
  }

  async cancel(attemptId: string): Promise<LinuxInstallState> {
    const active = this.active;
    if (!active || active.id !== attemptId || this.state.status !== "installing") return this.snapshot();
    this.state = { ...this.state, status: "cancelled", phase: "cancelled", message: "Installation cancelled. You can try again when you’re ready.", loginUrl: null, loginCode: null };
    active.abort.abort();
    await active.done;
    return this.snapshot();
  }

  async close(): Promise<void> {
    this.disposed = true;
    const active = this.active;
    if (active) {
      await this.cancel(active.id);
      await active.done;
    }
  }

  private async install(id: string, abort: AbortController): Promise<void> {
    let directory: string | null = null;
    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, this.options.timeoutMs ?? 10 * 60_000);
    timeout.unref();
    const update = (changes: Partial<LinuxInstallState>) => {
      if (this.state.attemptId === id && this.state.status === "installing") this.state = { ...this.state, ...changes };
    };
    try {
      // No insecure redirect or shell interpolation is accepted, even if the endpoint is unavailable.
      const response = await (this.options.fetch ?? fetch)(INSTALLER_URL, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]), redirect: "error",
      });
      if (!response.ok || !response.body) throw new Error("The official Muse installer could not be downloaded.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_SCRIPT_BYTES) throw new Error("The installer response was unexpectedly large.");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      abort.signal.throwIfAborted();
      const script = Buffer.concat(chunks).toString("utf8");
      if (!/^#![^\n]*\bbash\b/.test(script)) throw new Error("The installer response was not a Bash script.");
      directory = await mkdtemp(join(tmpdir(), "ancilla-muse-install-"));
      const scriptPath = join(directory, "install.sh");
      await writeFile(scriptPath, script, { mode: 0o600, flag: "wx" });
      abort.signal.throwIfAborted();
      const installDir = join(this.options.home, ".local", "bin");
      const env: NodeJS.ProcessEnv = {
        ...(this.options.env ?? process.env), HOME: this.options.home,
        MUSE_INSTALL_DIR: installDir, MUSE_LAUNCHER_URL: "https://api.meta.ai/muse-launcher.sh",
        MUSE_CHANNEL: "muse-stable", MUSE_LOGIN: "1", MUSE_UPGRADE_MODE: "1",
        PATH: `${installDir}:${(this.options.env ?? process.env)["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`,
      };
      // The GUI uses the absolute installed path; the installer need not edit shell startup files.
      delete env["BASH_ENV"];
      delete env["ENV"];
      delete env["MUSE_NO_AUTO_UPDATE"];
      update({ phase: "install", message: "Installing Muse Code for your account…" });
      const exitCode = await (this.options.run ?? runInstaller)(scriptPath, {
        home: this.options.home, env, signal: abort.signal,
        onOutput: (chunk) => {
          output = (output + chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")).slice(-MAX_OUTPUT_BYTES);
          const login = installerLogin(output);
          if (login) update({ phase: "signin", message: "Meta needs you to sign in before Muse can finish installing. Open the link, approve access, then return here.", loginUrl: login.url, loginCode: login.code });
        },
      });
      abort.signal.throwIfAborted();
      if (exitCode !== 0) throw new Error("The Muse installer exited before completion.");
      await access(join(installDir, "muse"), constants.X_OK);
      update({ status: "installed", phase: "complete", message: "Muse Code is installed. Connect your Meta subscription below, or continue with your existing login.", loginUrl: null, loginCode: null });
    } catch (error) {
      if (this.state.status !== "cancelled") {
        update({ status: "error", phase: "error", message: timedOut
          ? "Installation timed out. Choose Try again; if Meta asks you to sign in, approve access before the code expires."
          : installFailure(output, error), loginUrl: null, loginCode: null });
      }
    } finally {
      clearTimeout(timeout);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
