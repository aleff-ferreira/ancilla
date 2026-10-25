/**
 * The real `ancilla-server` process for the suites that stop it: started with the arguments given, its ready line and
 * exit awaited, and two servers with something pending (a `!` command, a host stuck starting). Every wait is for an
 * event (a pid file, a log line, an exit); the timeouts only keep a hung child from hanging the suite.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AncillaStore } from "@ancilla/daemon";
import { killQuietly, writeFakeMuse } from "./fakeMuse.js";
import { sleep } from "./research-rigs.js";

export const CLI = join(__dirname, "..", "src", "cli.js");
/** Long enough for a slow machine, short enough that a hung shutdown fails the test and not the run. */
export const HUNG = 25_000;

export interface Running {
  child: ChildProcess;
  stderr: () => string;
  stdout: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves with the base URL once the readiness line is printed. */
  ready: Promise<string>;
}

export interface StartOptions {
  /** What the child's stdin is: nothing (the default), or a pipe the test holds the other end of. */
  stdin?: "ignore" | "pipe";
}

export function startCli(args: string[], env: Record<string, string> = {}, options: StartOptions = {}): Running {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: [options.stdin ?? "ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let err = "";
  let out = "";
  child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(out);
      if (match) resolve(match[1]!);
    });
    child.once("close", () => reject(new Error(`the server ended before it was ready; stderr:\n${err}`)));
  });
  ready.catch(() => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  return { child, stderr: () => err, stdout: () => out, exited, ready };
}

export async function until(check: () => boolean | Promise<boolean>, what: string, ms = HUNG): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The exit of a child, or null when it is still running after `ms`. */
export function exitedWithin(run: Running, ms = HUNG): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return Promise.race([run.exited, sleep(ms).then(() => null)]);
}

/** Whether `GET /api/health` of this base answers at all. */
export async function answers(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/api/health`)).ok;
  } catch {
    return false;
  }
}

/** A server with a thread request stuck on a host that never answers, and the pid of that host. */
export async function serverWithStuckHost() {
  const dir = await mkdtemp(join(tmpdir(), "ancilla-cli-shutdown-"));
  const muse = await writeFakeMuse(join(dir, "bin"));
  const run = startCli(["--port", "0", "--data-dir", join(dir, "data"), "--muse", muse.path], muse.env);
  const base = await run.ready;
  const request = fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir }) }).then(
    (response) => response.status,
    () => -1,
  );
  await until(async () => {
    try {
      return (await readFile(muse.pidFile, "utf8")).trim() !== "";
    } catch {
      return false;
    }
  }, "the stuck host to start");
  const pid = Number((await readFile(muse.pidFile, "utf8")).trim());
  const cleanup = async () => {
    killQuietly(pid);
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  };
  return { run, pid, request, cleanup };
}

/**
 * A server over a data folder that already holds one thread (in a folder of the test's own), and a `!` command running
 * in it: it records its pid and sleeps. No host is needed, so the fake muse is only there to keep a real one out.
 * `args` go after the server's own, and `stdin` is as for `startCli`.
 */
export async function serverWithPendingCommand(options: { args?: string[] } & StartOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ancilla-cli-shutdown-"));
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const store = new AncillaStore(join(dataDir, "ancilla.db"));
  store.recordSession({ id: "s1", projectId: store.upsertProject(dir).id });
  store.close();
  const muse = await writeFakeMuse(join(dir, "bin"));
  const run = startCli(["--port", "0", "--data-dir", dataDir, "--muse", muse.path, ...(options.args ?? [])], { ...muse.env, SHELL: "/bin/sh" }, options);
  const base = await run.ready;
  const pidFile = join(dir, "command.pid");
  // The answer comes after the stop, as a result or as a refused connection; either way nothing here waits for it.
  void fetch(`${base}/api/sessions/s1/shell-proxy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: `echo $$ > "${pidFile}"; exec sleep 60` }),
  }).then(
    (response) => response.status,
    () => -1,
  );
  await until(async () => {
    try {
      return (await readFile(pidFile, "utf8")).trim() !== "";
    } catch {
      return false;
    }
  }, "the command to start");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  const cleanup = async () => {
    killQuietly(pid);
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  };
  return { run, pid, dataDir, cleanup };
}
