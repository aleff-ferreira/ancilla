/**
 * The real `ancilla-server` process against a folder another server owns: it exits with `EXIT_DATA_DIR_OWNED`, one
 * line on stderr and nothing on stdout, on the owner's port and on any other, and the owner's live run is left alone.
 * A stale record is taken over, an unreadable one leaves the lock off with a line, and runtime.json can turn it off.
 * The owner is a server in this process with a fake host; the command line is the real program, stopped through
 * the end of its stdin, which every system has. Runs on every system.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { ResearchEngine } from "../src/research/index.js";
import { EXIT_DATA_DIR_OWNED } from "../src/exitCodes.js";
import { STDIN_EOF_FLAG } from "../src/shutdown.js";
import { aState, tmpDir } from "./lifecycle-rig.js";
import { FakeConnection, get, send, start, waitFor } from "./harness.js";
import { ownerFile, ownerRecord, readOwner, writeOwner } from "./ownerLockFakes.js";
import { exitedWithin, startCli } from "./cliRig.js";

/** An engine that checkpoints once and then waits for its signal, as a run in the middle of its work does. */
const waitingEngine: ResearchEngine = async (input, _config, deps, signal) => {
  await deps.checkpoint(aState(input.runId, { phase: "researching" }));
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  return { status: "cancelled", report: null, state: aState(input.runId, { phase: "done", aborted: true }), failure: "cancelled: stopped" };
};

interface Internals {
  store: { getResearchRun(id: string): { status: string } | undefined; listResearchEvents(id: string): { type: string }[] };
}

/** A server of this process over `dir`, with one thread and a research run that stays live until the suite ends. */
async function owner(dir: string, withRun = true) {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const { server, base } = await start(connection, { dataDir: dir, researchEngine: waitingEngine });
  assert.equal((await send(base, "/api/sessions", { cwd: tmpDir("ancilla-cli-lock-cwd-") })).status, 200);
  const store = (server as unknown as Internals).store;
  let runId: string | null = null;
  if (withRun) {
    const started = await send(base, "/api/research", { commandId: "cmd-1", sessionId: "s1", question: "What is SQLite?" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    runId = started.json.run.runId as string;
    await waitFor(() => store.getResearchRun(runId as string)?.status === "running", "the run to be running");
  }
  return { server, base, port: new URL(base).port, store, runId: runId as string };
}

/** A pid no process has; see ownerLock.test.ts. */
const deadPid = () => 2_147_000_000 + Math.floor(Math.random() * 400_000);

/** A port nothing listens on: one that was bound and released. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

const ROOT_SKIP = typeof process.getuid === "function" && process.getuid() === 0 ? "root ignores file modes" : false;

describe("ancilla-server over a folder a live Ancilla owns", () => {
  for (const [label, portOf] of [
    ["on the owner's own port", (port: string) => port],
    ["on another port", () => "0"],
  ] as const) {
    it(`exits ${EXIT_DATA_DIR_OWNED} ${label}, with one line on stderr and nothing on stdout, and leaves the owner's run alone`, { timeout: 60_000 }, async () => {
      const dir = tmpDir("ancilla-cli-lock-");
      const first = await owner(dir);
      const run = startCli(["--port", portOf(first.port), "--data-dir", dir]);
      const ended = await exitedWithin(run);
      assert.notEqual(ended, null, `the refused server did not exit; stderr:\n${run.stderr()}`);
      assert.deepEqual(ended, { code: EXIT_DATA_DIR_OWNED, signal: null }, run.stderr());
      assert.equal(run.stdout(), "", "a refused server wrote to stdout");
      // Node's own warning about the SQLite module is not the server's.
      const lines = run.stderr().split("\n").filter((line) => line !== "" && !/ExperimentalWarning|--trace-warnings/.test(line));
      assert.equal(lines.length, 1, `one stderr line, not:\n${run.stderr()}`);
      assert.match(
        lines[0]!,
        new RegExp(`^ancilla-server: another Ancilla \\(pid ${process.pid}, started \\S+, http://127\\.0\\.0\\.1:${first.port}\\) owns the data folder .*; close it first, or start this one with --data-dir <other folder>\\. \\(.*ancilla\\.owner holds the record\\)$`),
      );
      assert.ok(lines[0]!.includes(dir), "the line names the folder");
      assert.equal(first.store.getResearchRun(first.runId)?.status, "running", "the owner's live run was rewritten");
      assert.ok(!first.store.listResearchEvents(first.runId).some((event) => event.type === "run_interrupted"));
      const health = await get(first.base, "/api/health");
      assert.equal(health.ok, true);
      assert.equal(health.instanceId, first.server.instanceId);
      assert.equal(readOwner(dir)?.instanceId, first.server.instanceId, "the owner's record changed");
    });
  }
});

describe("ancilla-server over a folder with a record nobody serves", () => {
  it("takes it over, writes its own pid and port, and releases it on a clean close", { timeout: 60_000 }, async () => {
    const dir = tmpDir("ancilla-cli-lock-");
    const stale = ownerRecord({ pid: deadPid(), port: await closedPort(), startedAt: "2026-10-01T00:00:00.000Z" });
    writeOwner(dir, stale);
    const run = startCli(["--port", "0", "--data-dir", dir, STDIN_EOF_FLAG], {}, { stdin: "pipe" });
    const base = await run.ready;
    const record = readOwner(dir);
    assert.equal(record?.pid, run.child.pid);
    assert.equal(record?.port, Number(new URL(base).port));
    assert.notEqual(record?.instanceId, stale.instanceId);
    assert.equal(record?.instanceId, (await get(base, "/api/health")).instanceId);
    assert.match(run.stderr(), /taking over the data folder .*is gone/);
    run.child.stdin!.end();
    assert.deepEqual(await exitedWithin(run), { code: 0, signal: null }, run.stderr());
    assert.equal(readOwner(dir), null);
  });

  it("starts without the lock, with a line, when the record cannot be read", { skip: process.platform === "win32" ? "file modes are POSIX" : ROOT_SKIP, timeout: 60_000 }, async () => {
    const dir = tmpDir("ancilla-cli-lock-");
    writeOwner(dir, ownerRecord({ port: 4100 }));
    chmodSync(ownerFile(dir), 0o000);
    try {
      const run = startCli(["--port", "0", "--data-dir", dir, STDIN_EOF_FLAG], {}, { stdin: "pipe" });
      const base = await run.ready;
      assert.match(run.stderr(), /the data folder lock could not be read \(EACCES\): running without it/);
      assert.equal((await get(base, "/api/health")).owner.lock, "unavailable");
      run.child.stdin!.end();
      assert.deepEqual(await exitedWithin(run), { code: 0, signal: null }, run.stderr());
    } finally {
      chmodSync(ownerFile(dir), 0o600);
    }
  });
});

describe("runtime.json dataDirLock false", () => {
  it("starts over an owned folder, with a line that says what that costs", { timeout: 60_000 }, async () => {
    const dir = tmpDir("ancilla-cli-lock-");
    const first = await owner(dir, false);
    writeFileSync(join(dir, "runtime.json"), JSON.stringify({ dataDirLock: false }), "utf8");
    const run = startCli(["--port", "0", "--data-dir", dir, STDIN_EOF_FLAG], {}, { stdin: "pipe" });
    const base = await run.ready;
    assert.match(run.stderr(), /runtime\.json dataDirLock is false: .* is not locked/);
    assert.equal((await get(base, "/api/health")).owner.lock, "off");
    assert.equal(readOwner(dir)?.instanceId, first.server.instanceId, "the owner's record changed");
    run.child.stdin!.end();
    assert.deepEqual(await exitedWithin(run), { code: 0, signal: null }, run.stderr());
    assert.equal(readOwner(dir)?.instanceId, first.server.instanceId);
  });
});
