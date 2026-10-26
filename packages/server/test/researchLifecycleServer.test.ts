/**
 * The research lifecycle through the server: a Stop on a run nobody is running, archiving and settling a thread
 * with a run in flight, the sweep at boot (and the second server that must not run it), and the counts /api/health
 * gives. The engine is a stand-in that waits for its stop, so a run stays live until a test ends it.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore } from "@ancilla/daemon";
import { EXIT_DATA_DIR_OWNED } from "../src/exitCodes.js";
import type { ResearchEngine } from "../src/research/index.js";
import { AncillaServer, type HostHandle } from "../src/server.js";
import { aState, deferred, newRun, seededStore, tmpDir } from "./lifecycle-rig.js";
import { BUDGETS, noSink, TASK } from "./research-rigs.js";
import { FakeConnection, fakeFactory, get, send, start, waitFor, type FactoryProbe } from "./harness.js";

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

interface ServerInternals {
  store: AncillaStore;
  autoSettle(): void;
}

async function rig(options: { dataDir?: string; autoSettleDays?: number | null; engine?: ResearchEngine; probe?: FactoryProbe; syncSessionNames?: boolean } = {}) {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const { server, base } = await start(connection, {
    researchEngine: options.engine ?? waitingEngine,
    ...(options.syncSessionNames ? { syncSessionNames: true } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.autoSettleDays !== undefined ? { autoSettleDays: options.autoSettleDays } : {}),
    ...(options.probe ? { hostFactory: fakeFactory(connection, options.probe) } : {}),
  });
  const cwd = tmpDir("ancilla-lifecycle-cwd-");
  assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
  const internals = server as unknown as ServerInternals;
  const startRun = async (commandId = "cmd-1") => {
    const started = await send(base, "/api/research", { commandId, sessionId: "s1", question: "What is SQLite?" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    return started.json.run.runId as string;
  };
  const runOf = (runId: string) => internals.store.getResearchRun(runId);
  return { connection, server, base, cwd, internals, startRun, runOf };
}

const patchSession = (base: string, body: Record<string, unknown>) => send(base, "/api/sessions/s1", body, "PATCH");

describe("Stop on a run that is no longer in flight", () => {
  it("settles a stale running row as interrupted, with its event", async () => {
    const { base, internals } = await rig();
    const stale = newRun(internals.store, "stale", "running");
    const stopped = await send(base, `/api/research/${stale.id}/stop`, {});
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.run.status, "interrupted", "the answer says what became of the run");
    assert.equal(internals.store.getResearchRun(stale.id)?.status, "interrupted");
    assert.ok(internals.store.listResearchEvents(stale.id).some((e) => e.type === "run_interrupted"));
  });

  it("answers 200 and changes nothing for a run that already ended", async () => {
    const { base, internals } = await rig();
    const done = newRun(internals.store, "done", "running");
    internals.store.updateResearchRun(done.id, { status: "completed", report: "# R", endedAt: "2026-10-13T10:00:00.000Z" });
    for (const writeReport of [false, true]) {
      const stopped = await send(base, `/api/research/${done.id}/stop`, { writeReport });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.json.run.status, "completed");
    }
    assert.equal(internals.store.getResearchRun(done.id)?.endedAt, "2026-10-13T10:00:00.000Z");
    assert.deepEqual(internals.store.listResearchEvents(done.id), []);
  });

  it("still stops a run that is in flight the ordinary way", async () => {
    const { base, startRun, runOf } = await rig();
    const runId = await startRun();
    await waitFor(() => runOf(runId)?.status === "running", "the run to be running");
    const stopped = await send(base, `/api/research/${runId}/stop`, {});
    assert.equal(stopped.status, 200);
    await waitFor(() => runOf(runId)?.status === "cancelled", "the run to be cancelled");
  });
});

describe("archiving and settling a thread with research in flight", () => {
  it("answers 409 with a reason about the research while the run is live, and lets go once it ended", async () => {
    const { base, startRun, runOf, internals } = await rig();
    const runId = await startRun();
    await waitFor(() => runOf(runId)?.status === "running", "the run to be running");

    const archived = await patchSession(base, { archived: true });
    assert.equal(archived.status, 409);
    assert.match(archived.json.error ?? JSON.stringify(archived.json), /research/i);
    assert.match(archived.json.error ?? JSON.stringify(archived.json), /stop/i);
    assert.equal(internals.store.getSession("s1")?.archived, false, "the thread was not archived");

    const settled = await patchSession(base, { settled: true });
    assert.equal(settled.status, 409);
    assert.match(settled.json.error ?? JSON.stringify(settled.json), /research/i);
    assert.equal(internals.store.getSession("s1")?.settledOverride, null);

    assert.equal((await patchSession(base, { title: "A new name" })).status, 200, "renaming is not blocked");
    assert.equal((await patchSession(base, { archived: false })).status, 200, "and neither is un-archiving");

    await send(base, `/api/research/${runId}/stop`, {});
    await waitFor(() => runOf(runId)?.status === "cancelled", "the run to be cancelled");
    assert.equal((await patchSession(base, { archived: true })).status, 200);
    assert.equal(internals.store.getSession("s1")?.archived, true);
  });

  it("asks again after the rename under way: a run that started meanwhile still refuses the archive", async () => {
    const { base, connection, startRun, runOf, internals } = await rig({ syncSessionNames: true });
    const rename = deferred();
    connection.replies.set("session/rename", () => rename.promise.then(() => ({ name: "A new name" })));
    const archiving = patchSession(base, { title: "A new name", archived: true });
    await waitFor(() => connection.of("session/rename").length === 1, "the rename to be under way");
    const runId = await startRun();
    await waitFor(() => runOf(runId)?.status === "running", "the run to be running");
    rename.resolve();
    const answered = await archiving;
    assert.equal(answered.status, 409, JSON.stringify(answered.json));
    assert.match(answered.json.error ?? JSON.stringify(answered.json), /research/i);
    assert.equal(internals.store.getSession("s1")?.archived, false, "the thread was not archived under the run");
    await send(base, `/api/research/${runId}/stop`, {});
    await waitFor(() => runOf(runId)?.status === "cancelled", "the run to be cancelled");
  });

  it("is not blocked by a stale running row, which no job is running", async () => {
    const { base, internals } = await rig();
    newRun(internals.store, "stale", "running");
    assert.equal((await patchSession(base, { settled: true })).status, 200);
    assert.equal((await patchSession(base, { archived: true })).status, 200);
  });

  it("leaves a thread with a run in flight out of the automatic settle, and settles it afterwards", async () => {
    const { base, startRun, runOf, internals } = await rig({ autoSettleDays: 0 });
    const runId = await startRun();
    await waitFor(() => runOf(runId)?.status === "running", "the run to be running");
    await new Promise((resolve) => setTimeout(resolve, 15));
    internals.autoSettle();
    assert.equal(internals.store.getSession("s1")?.settledOverride, null, "a thread whose run is live is not shelved");

    await send(base, `/api/research/${runId}/stop`, {});
    await waitFor(() => runOf(runId)?.status === "cancelled", "the run to be cancelled");
    await new Promise((resolve) => setTimeout(resolve, 15));
    internals.autoSettle();
    assert.equal(internals.store.getSession("s1")?.settledOverride, "settled");
  });
});

describe("/api/health", () => {
  it("carries counts of the research runs and nothing a stranger could read", async () => {
    const { base, startRun, runOf } = await rig();
    const idle = (await get(base, "/api/health")).research;
    assert.deepEqual(idle, { live: 0, queued: 0, interruptedAtBoot: 0 });
    const runId = await startRun();
    await waitFor(() => runOf(runId)?.status === "running", "the run to be running");
    const health = await get(base, "/api/health");
    assert.equal(health.research.live, 1);
    assert.deepEqual(Object.keys(health.research).sort(), ["interruptedAtBoot", "live", "queued"]);
    assert.ok(Object.values(health.research).every((value) => typeof value === "number"));
    assert.doesNotMatch(JSON.stringify(health), /SQLite/, "the question is not in the health report");
  });

  it("counts the runs the boot sweep interrupted", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const seed = seededStore(join(dir, "ancilla.db"));
    newRun(seed, "left-running", "running");
    newRun(seed, "left-queued", "queued");
    seed.close();
    const { base, internals } = await rig({ dataDir: dir });
    const health = await get(base, "/api/health");
    assert.equal(health.research.interruptedAtBoot, 2);
    assert.deepEqual(internals.store.listRunningResearchRuns(), []);
  });

  it("counts the hosts that exited, and when the last one did", async () => {
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await rig({ probe });
    assert.deepEqual((await get(base, "/api/health")).diagnostics.hostExits, { count: 0, lastExitAt: null });
    assert.equal(probe.exits.length, 1);
    probe.exits[0]!({ code: 1, signal: null });
    const exits = (await get(base, "/api/health")).diagnostics.hostExits;
    assert.equal(exits.count, 1);
    assert.match(exits.lastExitAt, /^\d{4}-\d\d-\d\dT/);
  });
});

describe("the boot sweep", () => {
  it("waits until the server is listening, and gives the interruption its aliveUntil", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const seed = seededStore(join(dir, "ancilla.db"));
    const run = newRun(seed, "left", "running");
    seed.appendResearchEvent({ type: "run_started", runId: run.id, seq: 1, at: "2026-10-13T10:00:00.000Z", phase: null, round: null, agentId: null, payload: {} });
    seed.appendResearchEvent({ type: "supervisor_iteration", runId: run.id, seq: 2, at: "2026-10-13T10:07:00.000Z", phase: null, round: null, agentId: null, payload: {} });
    seed.close();

    const server = new AncillaServer({ port: 0, dataDir: dir, platform: "linux", musePath: "muse", home: dir, exec: async () => ({ stdout: "", exitCode: 127 }) });
    after(() => server.close().catch(() => undefined));
    const store = (server as unknown as ServerInternals).store;
    assert.equal(store.getResearchRun(run.id)?.status, "running", "constructing a server changes nothing");
    await server.listen();
    assert.equal(store.getResearchRun(run.id)?.status, "interrupted");
    assert.equal(store.listResearchEvents(run.id).at(-1)?.payload["aliveUntil"], "2026-10-13T10:07:00.000Z");
  });

  /** A server over a data folder that another process locks for writing from now until `lockedMs` have passed. */
  function lockedServer(dir: string, lockedMs: number) {
    const path = join(dir, "ancilla.db");
    const server = new AncillaServer({ port: 0, dataDir: dir, platform: "linux", musePath: "muse", home: dir, exec: async () => ({ stdout: "", exitCode: 127 }) });
    after(() => server.close().catch(() => undefined));
    const holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    const release = setTimeout(() => holder.exec("ROLLBACK"), lockedMs);
    after(() => {
      clearTimeout(release);
      try {
        holder.exec("ROLLBACK");
      } catch {
        /* released already */
      }
      holder.close();
    });
    return { server, internals: server as unknown as ServerInternals };
  }

  it("waits out a database another process has locked, and closes out the run the last process left in flight", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const seed = seededStore(join(dir, "ancilla.db"));
    const run = newRun(seed, "left", "running");
    seed.close();
    const { server, internals } = lockedServer(dir, 600);
    const bound = await server.listen();
    assert.equal(internals.store.getResearchRun(run.id)?.status, "interrupted");
    assert.equal((await get(`http://127.0.0.1:${bound.port}`, "/api/health")).research.interruptedAtBoot, 1);
  });

  it("waits out the same lock for the turns the last process left running", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const seed = seededStore(join(dir, "ancilla.db"));
    seed.registerTurn("t1", "s1");
    seed.close();
    // No research run to sweep, so the turn sweep is the first thing to meet the lock.
    const { server, internals } = lockedServer(dir, 600);
    await server.listen();
    assert.deepEqual(internals.store.listTurns("s1").map((t) => [t.id, t.status]), [["t1", "unknown"]]);
  });

  it("sweeps the turns even when the research sweep cannot read its runs", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const seed = seededStore(join(dir, "ancilla.db"));
    seed.registerTurn("t1", "s1");
    seed.close();
    const server = new AncillaServer({ port: 0, dataDir: dir, platform: "linux", musePath: "muse", home: dir, exec: async () => ({ stdout: "", exitCode: 127 }) });
    after(() => server.close().catch(() => undefined));
    const internals = server as unknown as ServerInternals;
    internals.store.listRunningResearchRuns = () => {
      throw new Error("the research tables are unreadable");
    };
    await server.listen();
    assert.deepEqual(internals.store.listTurns("s1").map((t) => [t.id, t.status]), [["t1", "unknown"]]);
  });

  it("sweeps the turns even when the research sweep itself throws", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const seed = seededStore(join(dir, "ancilla.db"));
    seed.registerTurn("t1", "s1");
    seed.close();
    const server = new AncillaServer({ port: 0, dataDir: dir, platform: "linux", musePath: "muse", home: dir, exec: async () => ({ stdout: "", exitCode: 127 }) });
    after(() => server.close().catch(() => undefined));
    const internals = server as unknown as ServerInternals & { researchJobs: { sweepInterruptedOnBoot(): Promise<unknown> } };
    internals.researchJobs.sweepInterruptedOnBoot = async () => {
      throw new Error("the sweep fell over");
    };
    await server.listen();
    assert.deepEqual(internals.store.listTurns("s1").map((t) => [t.id, t.status]), [["t1", "unknown"]]);
  });

  it("is not run by a second server that cannot take the port, so the first one's live run is left alone", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const first = await rig({ dataDir: dir });
    const runId = await first.startRun();
    await waitFor(() => first.runOf(runId)?.status === "running", "the run to be running");
    const port = Number(new URL(first.base).port);

    const second = new AncillaServer({ port, dataDir: dir, platform: "linux", musePath: "muse", home: dir, exec: async () => ({ stdout: "", exitCode: 127 }) });
    after(() => second.close().catch(() => undefined));
    await assert.rejects(second.listen(), /EADDRINUSE/);
    assert.equal(first.runOf(runId)?.status, "running", "the run of the server that holds the port is untouched");
    assert.ok(!first.internals.store.listResearchEvents(runId).some((e) => e.type === "run_interrupted"));
    assert.equal(((await get(first.base, "/api/health")).research as { live: number }).live, 1);
  });

  // The folder's lock refuses the command-line server before it binds, on the first server's port and on any other:
  // the sweep is never reached, and the exit code tells the desktop shell not to try another port.
  for (const [label, portOf] of [
    ["the same port", (port: string) => port],
    ["another port", () => "0"],
  ] as const) {
    it(`is not run by the command-line server over the same folder on ${label} either`, { timeout: 120_000 }, async () => {
      const dir = tmpDir("ancilla-lifecycle-data-");
      const first = await rig({ dataDir: dir });
      const runId = await first.startRun();
      await waitFor(() => first.runOf(runId)?.status === "running", "the run to be running");
      const port = new URL(first.base).port;

      const child = spawn(process.execPath, [join(__dirname, "..", "src", "cli.js"), "--port", portOf(port), "--data-dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      const code = await exited;
      clearTimeout(killer);
      assert.equal(code, EXIT_DATA_DIR_OWNED, `a server over an owned folder exits with the folder's code; stderr:\n${stderr}`);
      assert.equal(stdout, "", "nothing on stdout: the ready line is the only thing ever written there");
      assert.match(stderr, /^ancilla-server: another Ancilla \(pid \d+, started \S+, http:\/\/127\.0\.0\.1:\d+\) owns the data folder /m);
      assert.doesNotMatch(stderr, /EADDRINUSE/, "the lock answered before the bind");
      assert.equal(first.runOf(runId)?.status, "running", `the first server's live run was rewritten by the second; stderr:\n${stderr}`);
      assert.ok(!first.internals.store.listResearchEvents(runId).some((e) => e.type === "run_interrupted"));
    });
  }
});

describe("a graceful close of the server", () => {
  it("leaves a live run interrupted, which the next start reads back as such", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const first = await rig({ dataDir: dir });
    const runId = await first.startRun();
    await waitFor(() => first.runOf(runId)?.status === "running", "the run to be running");
    await first.server.close();

    const reread = new AncillaStore(join(dir, "ancilla.db"));
    after(() => reread.close());
    const row = reread.getResearchRun(runId);
    assert.equal(row?.status, "interrupted");
    assert.equal(row?.state?.phase, "researching", "the state is the last checkpoint, not a finished run's");
    const last = reread.listResearchEvents(runId).at(-1);
    assert.equal(last?.type, "run_interrupted");
    assert.ok(Date.parse(String(last?.payload["aliveUntil"])) > 0);
  });
});

describe("the order of a graceful close", () => {
  it("closes the research runs before the hosts, so a worker whose host ends under it does not end the run as failed", async () => {
    const dir = tmpDir("ancilla-lifecycle-data-");
    const connection = new FakeConnection();
    let sessions = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: sessions++ === 0 ? "s1" : "w1" } }));
    connection.replies.set("turn/start", () => ({ turnId: "wt1", status: "accepted" }));
    const engineEnded = deferred();
    // A host that, as it closes, ends the session of the worker on it, as a real one does, and then takes its time: it
    // is let go of only once the engine has seen the end, so that a close that reaches the hosts before the research
    // runs have been wound down finds the run already failed. (The wait is bounded, and a timer that is not needed
    // is cleared; when the runs are closed first the engine is done long before.)
    const hostFactory = (): HostHandle => ({
      start: async () => ({ initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } }),
      connection: connection as never,
      close: async () => {
        connection.notify("session/closed", { sessionId: "w1", reason: "hostShutdown" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([engineEnded.promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, 5000)))]);
        clearTimeout(timer);
        return { code: 0, signal: null };
      },
      onExit: () => undefined,
    });
    // An engine that ends the way its worker does: a worker that lost its session fails the run, one that the run's
    // stop cancelled leaves it cancelled (the shutdown turns that into an interruption), and only a finished one reports.
    const engine: ResearchEngine = async (input, _config, deps, signal) => {
      try {
        await deps.checkpoint(aState(input.runId, { phase: "researching" }));
        const result = await deps.worker.run({ ...TASK, runId: input.runId }, BUDGETS, signal, noSink);
        const state = aState(input.runId, { phase: "done" });
        if (result.status === "failed") return { status: "failed", report: null, state, failure: result.error ?? "the worker failed" };
        if (result.status !== "completed") return { status: "cancelled", report: null, state, failure: "cancelled: stopped" };
        return { status: "completed", report: "# R", state, failure: null };
      } finally {
        engineEnded.resolve();
      }
    };
    const { server, base } = await start(connection, { dataDir: dir, researchEngine: engine, hostFactory });
    assert.equal((await send(base, "/api/sessions", { cwd: tmpDir("ancilla-lifecycle-cwd-") })).status, 200);
    const started = await send(base, "/api/research", { commandId: "cmd-order", sessionId: "s1", question: "What is SQLite?" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId = started.json.run.runId as string;
    await waitFor(() => connection.of("turn/start").length === 1, "the worker's turn to start");

    await server.close();

    const reread = new AncillaStore(join(dir, "ancilla.db"));
    after(() => reread.close());
    assert.equal(reread.getResearchRun(runId)?.status, "interrupted", "the run was ended by its worker losing the host, not by the shutdown");
    const last = reread.listResearchEvents(runId).at(-1);
    assert.equal(last?.type, "run_interrupted");
    assert.ok(Date.parse(String(last?.payload["aliveUntil"])) > 0, "the interruption does not say how long the run was alive");
  });
});
