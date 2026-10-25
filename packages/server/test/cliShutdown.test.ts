/**
 * The real `ancilla-server` process asked to stop while a Muse host is stuck starting: it ends instead of waiting for
 * the host, and a second signal ends it at once. The same for a hangup (a terminal that goes away sends SIGHUP) with a
 * `!` command still pending and a research run in flight: the server closes, marks the run interrupted, stops the
 * command and exits 0, as it does on SIGTERM. Every wait is
 * for an event (a pid file, a log line, an exit); the timeouts only keep a hung child from hanging the suite. The
 * stuck host and the command are scripts and the signals are POSIX ones, so this is POSIX only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AncillaStore } from "@ancilla/daemon";
import { FAKE_MUSE_SKIP, isRunning, killQuietly, writeFakeMuse } from "./fakeMuse.js";
import { sleep } from "./research-rigs.js";

const CLI = join(__dirname, "..", "src", "cli.js");
/** Long enough for a slow machine, short enough that a hung shutdown fails the test and not the run. */
const HUNG = 25_000;

interface Running {
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves with the base URL once the readiness line is printed. */
  ready: Promise<string>;
}

function startCli(args: string[], env: Record<string, string>): Running {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
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
  return { child, stderr: () => err, exited, ready };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = HUNG): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A server with a thread request stuck on a host that never answers, and the pid of that host. */
async function serverWithStuckHost() {
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

/** How a research run stands in the store once the server is gone: its row's status and the type of its last event. */
function researchRowAfterExit(dataDir: string, runId: string): { status: string | null; lastEvent: string | null } {
  const store = new AncillaStore(join(dataDir, "ancilla.db"));
  try {
    return { status: store.getResearchRun(runId)?.status ?? null, lastEvent: store.listResearchEvents(runId).at(-1)?.type ?? null };
  } finally {
    store.close();
  }
}

/**
 * A server over a data folder that already holds one thread (in a folder of the test's own), a research run in flight
 * on it, and a `!` command running in it: it records its pid and sleeps. No host is needed, so the fake muse is only
 * there to keep a real one out; its `muse exec` never answers, so the run stays where it started. Only a close marks
 * that run interrupted: the exit hook that stops the command on any exit does nothing for it, which is what tells a
 * signal that closed the server from one that only ended the process.
 */
async function serverWithPendingCommand() {
  const dir = await mkdtemp(join(tmpdir(), "ancilla-cli-shutdown-"));
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const store = new AncillaStore(join(dataDir, "ancilla.db"));
  store.recordSession({ id: "s1", projectId: store.upsertProject(dir).id });
  store.close();
  const muse = await writeFakeMuse(join(dir, "bin"));
  const run = startCli(["--port", "0", "--data-dir", dataDir, "--muse", muse.path], { ...muse.env, SHELL: "/bin/sh" });
  const base = await run.ready;
  const started = await fetch(`${base}/api/research`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: "cmd-signal", sessionId: "s1", question: "What does a hangup do?" }),
  });
  const startedBody = await started.text();
  assert.equal(started.status, 200, `the research run did not start: ${startedBody}`);
  const runId = (JSON.parse(startedBody) as { run: { runId: string } }).run.runId;
  await until(async () => {
    const shown = (await (await fetch(`${base}/api/research/${runId}`)).json()) as { run: { status: string } };
    return shown.run.status === "running";
  }, "the research run to be running");
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
    // The `muse exec` the run started, should the close have left it; the pid file holds the last muse started.
    try {
      killQuietly(Number((await readFile(muse.pidFile, "utf8")).trim()));
    } catch {
      /* no muse was started */
    }
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  };
  return { run, pid, cleanup, researchRow: () => researchRowAfterExit(dataDir, runId) };
}

describe("ancilla-server on a signal with a `!` command pending", () => {
  const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell and signals" : false;
  // SIGTERM is the control: what a hangup does has to be what a terminate does.
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    it(`closes on ${signal}, exits 0 and leaves the command stopped`, { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
      const pending = await serverWithPendingCommand();
      try {
        assert.equal(isRunning(pending.pid), true, "the command is running before the signal");
        pending.run.child.kill(signal);
        const ended = await Promise.race([pending.run.exited, sleep(HUNG).then(() => null)]);
        assert.notEqual(ended, null, `the server was still running ${HUNG} ms after ${signal}; stderr:\n${pending.run.stderr()}`);
        assert.deepEqual(ended, { code: 0, signal: null }, `${signal} must end the server by a close, not by the signal; stderr:\n${pending.run.stderr()}`);
        assert.match(pending.run.stderr(), new RegExp(`${signal} received: closing the server`));
        await until(() => !isRunning(pending.pid), `the command to be stopped after ${signal}`);
        // Only the close writes this; an exit that skipped it leaves the row running with its start as the last event.
        assert.deepEqual(pending.researchRow(), { status: "interrupted", lastEvent: "run_interrupted" }, `${signal} ended the server without closing out the research run`);
      } finally {
        await pending.cleanup();
      }
    });
  }

  it("closes on SIGHUP all the same when nothing reads its stderr any more, as after a terminal has gone", { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
    const pending = await serverWithPendingCommand();
    try {
      // The reader's end is closed, so every line the shutdown writes finds the pipe broken.
      pending.run.child.stderr!.destroy();
      pending.run.child.kill("SIGHUP");
      const ended = await Promise.race([pending.run.exited, sleep(HUNG).then(() => null)]);
      assert.notEqual(ended, null, `the server was still running ${HUNG} ms after SIGHUP`);
      assert.deepEqual(ended, { code: 0, signal: null }, "a write to a stderr that is gone ended the server before its close had run");
      await until(() => !isRunning(pending.pid), "the command to be stopped after SIGHUP");
      assert.deepEqual(pending.researchRow(), { status: "interrupted", lastEvent: "run_interrupted" }, "SIGHUP ended the server without closing out the research run");
    } finally {
      await pending.cleanup();
    }
  });
});

describe("ancilla-server on SIGTERM with a host that is stuck starting", () => {
  it("exits, and does not wait for the host", { skip: FAKE_MUSE_SKIP, timeout: 60_000 }, async () => {
    const stuck = await serverWithStuckHost();
    try {
      stuck.run.child.kill("SIGTERM");
      const ended = await Promise.race([stuck.run.exited, sleep(HUNG).then(() => null)]);
      assert.notEqual(ended, null, `the server was still running ${HUNG} ms after SIGTERM; stderr:\n${stuck.run.stderr()}`);
      assert.equal(ended?.code, 0, stuck.run.stderr());
      assert.match(stuck.run.stderr(), /SIGTERM/);
    } finally {
      await stuck.cleanup();
    }
  });

  it("exits at once on a second signal while the first is still closing", { skip: FAKE_MUSE_SKIP, timeout: 60_000 }, async () => {
    const stuck = await serverWithStuckHost();
    try {
      stuck.run.child.kill("SIGTERM");
      await until(() => /SIGTERM/.test(stuck.run.stderr()), "the shutdown to begin");
      // Only a close that is still waiting can be cut short, so this is sent before the first one ends.
      stuck.run.child.kill("SIGTERM");
      const ended = await Promise.race([stuck.run.exited, sleep(HUNG).then(() => null)]);
      assert.notEqual(ended, null, "a second signal did not end the server");
      assert.match(stuck.run.stderr(), /second signal/, "the second signal was seen while the first close was still waiting");
      assert.equal(ended?.code, 1, "the second signal is an exit, not a clean close");
    } finally {
      await stuck.cleanup();
    }
  });
});
