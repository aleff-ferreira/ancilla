/**
 * The job manager's lifecycle: how a run is closed out when nobody is running it, how its progress is written to a
 * database that may be locked, and what a graceful shutdown leaves behind. Everything here runs against the real
 * store; the engine is the real one over a scripted model and worker, or a stand-in where a test needs the timing.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore, isStoreBusy, type ResearchEvent, type ResearchRunPatch, type ResearchRunState } from "@ancilla/daemon";
import { ResearchJobManager, type ResearchEngine } from "../src/research/index.js";
import { aState, busyError, deferred, newRun, scriptedRig, seededStore, thread, tmpDir, untilAborted } from "./lifecycle-rig.js";
import { waitFor } from "./harness.js";

const eventAt = (store: AncillaStore, runId: string, seq: number, type: ResearchEvent["type"], at: string): void => {
  store.appendResearchEvent({ type, runId, seq, at, phase: null, round: null, agentId: null, payload: {} });
};

function bareManager(store: AncillaStore, extra: Partial<ConstructorParameters<typeof ResearchJobManager>[0]> = {}): ResearchJobManager {
  return new ResearchJobManager({
    store,
    engine: (async () => {
      throw new Error("no engine in this test");
    }) as ResearchEngine,
    createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }),
    createWorkerRunner: () => ({ run: async () => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "unused" }) }),
    broadcast: () => undefined,
    writeReport: async () => null,
    ...extra,
  });
}

describe("markInterrupted", () => {
  it("leaves a run that already ended alone and writes no event", () => {
    const store = seededStore();
    const manager = bareManager(store);
    const run = newRun(store, "c1", "running");
    // The caller's copy is stale: the run completed after it was read.
    store.updateResearchRun(run.id, { status: "completed", report: "# done", endedAt: "2026-10-13T10:00:00.000Z" });
    assert.equal(manager.markInterrupted(run, "The run was found in flight without a job running it."), null);
    const after = store.getResearchRun(run.id);
    assert.equal(after?.status, "completed");
    assert.equal(after?.report, "# done");
    assert.equal(after?.endedAt, "2026-10-13T10:00:00.000Z");
    assert.deepEqual(store.listResearchEvents(run.id), []);
  });

  it("interrupts a stale run, writes its event with aliveUntil, and closes its working worker rows", () => {
    const store = seededStore();
    const manager = bareManager(store, { now: () => Date.parse("2026-10-13T12:00:00.000Z") });
    const run = newRun(store, "c1", "running");
    eventAt(store, run.id, 1, "run_started", "2026-10-13T10:00:00.000Z");
    eventAt(store, run.id, 2, "supervisor_iteration", "2026-10-13T10:05:00.000Z");
    store.addResearchWorker({ runId: run.id, workerSessionId: "w1", round: 1, agentId: 1, status: "working" });
    store.addResearchWorker({ runId: run.id, workerSessionId: "w2", round: 1, agentId: 2, status: "completed" });

    const updated = manager.markInterrupted(run, "The run was found in flight without a job running it.");
    assert.equal(updated?.status, "interrupted");
    assert.equal(updated?.endedAt, "2026-10-13T12:00:00.000Z");
    assert.match(updated?.failure ?? "", /^interrupted: the run was found in flight/);
    const events = store.listResearchEvents(run.id);
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[1, "run_started"], [2, "supervisor_iteration"], [3, "run_interrupted"]]);
    assert.equal(events[2]?.payload["aliveUntil"], "2026-10-13T10:05:00.000Z", "the run was last alive at its last engine event, not at the interruption");
    assert.deepEqual(store.listResearchWorkers(run.id).map((w) => [w.agentId, w.status]), [[1, "cancelled"], [2, "completed"]]);
  });

  it("dates a second interruption from the engine's last event, never from the host's own", () => {
    const store = seededStore();
    const manager = bareManager(store, { now: () => Date.parse("2026-10-13T12:00:00.000Z") });
    const run = newRun(store, "c1", "running");
    eventAt(store, run.id, 1, "run_started", "2026-10-13T10:00:00.000Z");
    eventAt(store, run.id, 2, "run_interrupted", "2026-10-13T11:00:00.000Z");
    const updated = manager.markInterrupted(run, "x");
    assert.equal(updated?.status, "interrupted");
    const last = store.listResearchEvents(run.id).at(-1);
    assert.equal(last?.payload["aliveUntil"], "2026-10-13T10:00:00.000Z");
  });

  it("falls back to when the run began when it has no event at all", () => {
    const store = seededStore();
    const manager = bareManager(store, { now: () => Date.parse("2026-10-13T12:00:00.000Z") });
    const run = newRun(store, "c1", "running");
    store.updateResearchRun(run.id, { startedAt: "2026-10-13T09:30:00.000Z" });
    manager.markInterrupted(store.getResearchRun(run.id)!, "x");
    assert.equal(store.listResearchEvents(run.id).at(-1)?.payload["aliveUntil"], "2026-10-13T09:30:00.000Z");
  });

  it("is atomic with its event: a failing event write leaves the row and its workers as they were", () => {
    const store = seededStore();
    const manager = bareManager(store);
    const run = newRun(store, "c1", "running");
    store.addResearchWorker({ runId: run.id, workerSessionId: "w1", round: 1, agentId: 1, status: "working" });
    store.appendResearchEvent = () => {
      throw new Error("disk is full");
    };
    assert.throws(() => manager.markInterrupted(run, "x"), /disk is full/);
    assert.equal(store.getResearchRun(run.id)?.status, "running");
    assert.equal(store.getResearchRun(run.id)?.endedAt, null);
    assert.deepEqual(store.listResearchWorkers(run.id).map((w) => w.status), ["working"]);
  });

  it("rolls the event back with the row when a later step fails", () => {
    const store = seededStore();
    const manager = bareManager(store);
    const run = newRun(store, "c1", "running");
    store.addResearchWorker({ runId: run.id, workerSessionId: "w1", round: 1, agentId: 1, status: "working" });
    store.closeResearchWorkers = () => {
      throw new Error("the last step failed");
    };
    assert.throws(() => manager.markInterrupted(run, "x"), /the last step failed/);
    assert.equal(store.getResearchRun(run.id)?.status, "running", "the status flip was rolled back");
    assert.deepEqual(store.listResearchEvents(run.id), [], "and so was the event: no event stands for a change that did not happen");
  });

  it("leaves a run this manager is running alone", async () => {
    const store = seededStore();
    const rigged = scriptedRig(store, { worker: "wait" });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => rigged.workerWaiting(), "the worker waiting");
    assert.equal(rigged.manager.markInterrupted(store.getResearchRun(run.id)!, "x"), null);
    assert.equal(store.getResearchRun(run.id)?.status, "running");
    rigged.manager.stop(run.id, false);
    await waitFor(() => !rigged.manager.isActive(run.id), "the run to end");
  });

  it("sweeps what a previous process left in flight, and keeps going past a run that cannot be written", () => {
    const store = seededStore();
    const logs: string[] = [];
    const manager = bareManager(store, { log: (m) => logs.push(m) });
    const first = newRun(store, "c1", "running");
    const second = newRun(store, "c2", "running");
    const real = store.updateResearchRunIf.bind(store);
    store.updateResearchRunIf = (id: string, from: Parameters<typeof real>[1], patch: ResearchRunPatch) => {
      if (id === first.id) {
        throw new Error("one row is bad");
      }
      return real(id, from, patch);
    };
    const marked = manager.markInterruptedOnBoot();
    assert.deepEqual(marked.map((r) => r.id), [second.id]);
    assert.equal(store.getResearchRun(first.id)?.status, "running");
    assert.equal(store.getResearchRun(second.id)?.status, "interrupted");
    assert.ok(logs.some((m) => m.includes(first.id) && /one row is bad/.test(m)), logs.join(" | "));
  });
});

// ---------------------------------------------------------------- writing progress to a database that may be locked

const FAST_RETRY = { windowMs: 5000, firstDelayMs: 5, maxDelayMs: 20 } as const;
const SHORT_RETRY = { windowMs: 150, firstDelayMs: 5, maxDelayMs: 20 } as const;

/** Wraps the store's run update, so a test can see every write and fail the ones it chooses. */
function spyOnRunWrites(store: AncillaStore, fail: (patch: ResearchRunPatch, attempt: number) => Error | null) {
  const writes: { phase: string | null; status: string | null; threw: boolean }[] = [];
  const real = store.updateResearchRun.bind(store);
  let attempt = 0;
  store.updateResearchRun = (id: string, patch: ResearchRunPatch) => {
    attempt += 1;
    const injected = fail(patch, attempt);
    const entry = { phase: patch.state?.phase ?? null, status: patch.status ?? null, threw: false };
    writes.push(entry);
    if (injected) {
      entry.threw = true;
      throw injected;
    }
    try {
      return real(id, patch);
    } catch (error) {
      entry.threw = true;
      throw error;
    }
  };
  return writes;
}

const preDispatch = (state: ResearchRunState | null | undefined): boolean => {
  const last = state?.rounds[state.rounds.length - 1];
  return Boolean(last && last.endedAt === null && last.results.length === 0 && last.delegations.length > 0);
};

describe("writing a run's progress", () => {
  it("rides out a database lock on a checkpoint: the run is not failed", async () => {
    const dir = tmpDir();
    const path = join(dir, "ancilla.db");
    const store = seededStore(path);
    const logs: string[] = [];
    const writes = spyOnRunWrites(store, () => null);
    const reached = deferred();
    const go = deferred();
    const engine: ResearchEngine = async (input, config, deps) => {
      const state = aState(input.runId);
      await deps.checkpoint(state);
      reached.resolve();
      await go.promise;
      state.phase = "researching";
      await deps.checkpoint(state);
      return { status: "completed", report: "# R", state: { ...state, phase: "done" }, failure: null };
    };
    const manager = bareManager(store, { engine, persistRetry: FAST_RETRY, log: (m) => logs.push(m) });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await reached.promise;
    const holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    go.resolve();
    // Released after the store has had to give up at least once; the timer fires between its short waits.
    const release = setTimeout(() => holder.exec("ROLLBACK"), 300);
    after(() => {
      clearTimeout(release);
      try {
        holder.exec("ROLLBACK");
      } catch {
        /* released already */
      }
      holder.close();
    });
    await waitFor(() => store.getResearchRun(run.id)?.status === "completed", "the run to complete", 20_000);
    assert.equal(store.getResearchRun(run.id)?.report, "# R");
    assert.ok(logs.every((m) => !/ended failed/.test(m)), logs.join(" | "));
    assert.ok(writes.some((w) => w.threw), "the lock really did make a write fail");
    const checkpointed = writes.filter((w) => w.status === null);
    assert.equal(checkpointed.at(-1)?.threw, false, "and the checkpoint went through in the end");
  });

  it("serialises what it writes at write time, so a retried older snapshot never overwrites a newer one", async () => {
    const store = seededStore();
    let first = true;
    const writes = spyOnRunWrites(store, (patch) => {
      if (first && patch.state) {
        first = false;
        return busyError();
      }
      return null;
    });
    const engine: ResearchEngine = async (input, _config, deps) => {
      const older = aState(input.runId, { phase: "scoping" });
      const newer = aState(input.runId, { phase: "researching", notes: ["newer"] });
      // The engine does not wait for the first: its answer is still on its way back when the second is made.
      const one = deps.checkpoint(older);
      const two = deps.checkpoint(newer);
      await Promise.all([one, two]);
      return { status: "completed", report: "# R", state: { ...newer, phase: "done" }, failure: null };
    };
    const manager = bareManager(store, { engine, persistRetry: FAST_RETRY });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => store.getResearchRun(run.id)?.status === "completed", "the run to complete");
    const stateWrites = writes.filter((w) => w.phase !== null && w.status === null && !w.threw).map((w) => w.phase);
    assert.deepEqual(stateWrites, ["researching"], `only the newest snapshot was written: ${JSON.stringify(writes)}`);
  });

  it("ends the run interrupted, not failed, and dispatches nothing when the pre-dispatch checkpoint cannot be written", async () => {
    const store = seededStore();
    const logs: string[] = [];
    spyOnRunWrites(store, (patch) => (preDispatch(patch.state) ? busyError() : null));
    const rigged = scriptedRig(store, { persistRetry: SHORT_RETRY, log: (m) => logs.push(m) });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => !rigged.manager.isActive(run.id), "the run to end", 15_000);
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "interrupted", `${row?.status}: ${row?.failure}`);
    assert.match(row?.failure ?? "", /^interrupted:/);
    assert.ok(row?.endedAt);
    assert.equal(rigged.workerCalls(), 0, "no worker was started on a round that could not be saved");
    assert.ok(store.listResearchEvents(run.id).some((e) => e.type === "run_interrupted"));
    assert.ok(logs.some((m) => /checkpoint/.test(m)), logs.join(" | "));
  });

  it("does not fail the run for an ordinary checkpoint it cannot write: the next one heals it", async () => {
    const store = seededStore();
    // Every phase and round-end snapshot fails; the pre-dispatch one and the final outcome go through.
    spyOnRunWrites(store, (patch) => (patch.status === undefined && patch.state && !preDispatch(patch.state) && patch.state.phase !== "done" ? busyError() : null));
    const rigged = scriptedRig(store, { persistRetry: SHORT_RETRY });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => !rigged.manager.isActive(run.id), "the run to end", 30_000);
    assert.equal(store.getResearchRun(run.id)?.status, "completed");
    assert.equal(rigged.workerCalls(), 1);
  });

  it("rides out a lock on the terminal outcome", async () => {
    const store = seededStore();
    let failures = 2;
    spyOnRunWrites(store, (patch) => {
      if (patch.status === "completed" && failures > 0) {
        failures -= 1;
        return busyError();
      }
      return null;
    });
    const rigged = scriptedRig(store, { persistRetry: FAST_RETRY });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => !rigged.manager.isActive(run.id), "the run to end", 30_000);
    assert.equal(failures, 0, "the outcome write was refused twice");
    assert.equal(store.getResearchRun(run.id)?.status, "completed");
    assert.ok(store.getResearchRun(run.id)?.report);
  });

  it("fails closed on the terminal outcome: a run whose outcome cannot be written ends interrupted, never completed", async () => {
    const store = seededStore();
    const logs: string[] = [];
    spyOnRunWrites(store, (patch) => (patch.status === "completed" ? busyError() : null));
    const rigged = scriptedRig(store, { persistRetry: SHORT_RETRY, log: (m) => logs.push(m) });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => !rigged.manager.isActive(run.id), "the run to end", 30_000);
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "interrupted");
    assert.equal(row?.report, null, "a report that was never stored is not claimed");
    assert.ok(logs.some((m) => /outcome/.test(m)), logs.join(" | "));
  });

  it("recognises the errors it retries on and no others", () => {
    assert.equal(isStoreBusy(busyError()), true);
    assert.equal(isStoreBusy(new Error("disk full")), false);
  });
});

// ---------------------------------------------------------------- graceful shutdown

describe("a graceful shutdown", () => {
  it("leaves a run interrupted, with the state of its last checkpoint and the time it was last alive", async () => {
    const store = seededStore();
    const rigged = scriptedRig(store, { worker: "wait" });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => rigged.workerWaiting(), "the worker waiting");
    await waitFor(() => (store.getResearchRun(run.id)?.state?.rounds.length ?? 0) === 1, "the round to be checkpointed");
    const before = JSON.stringify(store.getResearchRun(run.id)?.state);
    const t0 = Date.now();
    await rigged.manager.close();
    const t1 = Date.now();

    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "interrupted");
    assert.match(row?.failure ?? "", /^interrupted:/);
    assert.ok(row?.endedAt);
    assert.equal(JSON.stringify(row?.state), before, "nothing the engine did while shutting down reached the state");
    assert.equal(row?.state?.phase, "researching");
    assert.equal(row?.state?.rounds.at(-1)?.endedAt, null, "the open round was not closed with cancelled summaries");
    assert.equal(row?.report, null);

    const events = store.listResearchEvents(run.id);
    const types = events.map((e) => e.type);
    assert.equal(types.at(-1), "run_interrupted");
    for (const dropped of ["run_cancelled", "run_failed", "run_completed", "subagent_failed"]) {
      assert.ok(!types.includes(dropped as never), `${dropped} was written after the shutdown began`);
    }
    const alive = Date.parse(String(events.at(-1)?.payload["aliveUntil"]));
    assert.ok(alive >= t0 - 1000 && alive <= t1 + 1000, `aliveUntil ${events.at(-1)?.payload["aliveUntil"]} is when the server went down`);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "and the event numbers run on");

    assert.deepEqual(store.listResearchWorkers(run.id).map((w) => w.status), ["cancelled"], "the worker rows still close");
  });

  it("still ends a user's Stop as cancelled, and a Stop wins over a later shutdown", async () => {
    const store = seededStore();
    const rigged = scriptedRig(store, { worker: "wait" });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => rigged.workerWaiting(), "the worker waiting");
    rigged.manager.stop(run.id, false);
    await rigged.manager.close();
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "cancelled");
    assert.match(row?.failure ?? "", /^cancelled/);
    assert.ok(store.listResearchEvents(run.id).some((e) => e.type === "run_cancelled"));
    assert.ok(!store.listResearchEvents(run.id).some((e) => e.type === "run_interrupted"));
  });

  it("leaves a user's stop-and-write salvage interrupted at the writing phase, ready to be finished", async () => {
    const store = seededStore();
    // Round 1's worker found something and round 2's waits, so a stop has findings to write from.
    const rigged = scriptedRig(store, { worker: "complete-first", writer: "wait" });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => rigged.workerWaiting(), "round 2's worker waiting");
    assert.equal(rigged.manager.stop(run.id, true), true);
    await rigged.writerRunning;
    assert.equal(store.getResearchRun(run.id)?.state?.phase, "writing", "the salvage write is under way");
    await rigged.manager.close();
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "interrupted", `${row?.status}: ${row?.failure}`);
    assert.equal(row?.state?.phase, "writing");
    assert.equal(row?.state?.loopExit?.salvage, true, "the state says what kind of report is being written");
    assert.equal(row?.report, null);
    assert.equal(rigged.writerSignal()?.aborted, true, "the writer was still cut short at once");
  });

  it("keeps a report the engine finished anyway", async () => {
    const store = seededStore();
    const engine: ResearchEngine = async (input, _config, deps, signal) => {
      await deps.checkpoint(aState(input.runId));
      await untilAborted(signal);
      return { status: "completed", report: "# Finished", state: aState(input.runId, { phase: "done" }), failure: null };
    };
    const manager = bareManager(store, { engine });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => store.getResearchRun(run.id)?.state !== null, "the first checkpoint");
    await manager.close();
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "completed");
    assert.equal(row?.report, "# Finished");
  });

  /** A run whose engine sits on a promise the test holds, as one whose worker host never answers does. */
  async function closeOnHungEngine(userStop: boolean) {
    const store = seededStore();
    const hung = deferred();
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(aState(input.runId, { phase: "researching" }));
      await hung.promise;
      return { status: "completed", report: "# Late", state: aState(input.runId, { phase: "done" }), failure: null };
    };
    const manager = bareManager(store, { engine, now: () => Date.parse("2026-10-13T12:00:00.000Z") });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => store.getResearchRun(run.id)?.state !== null, "the first checkpoint");
    if (userStop) {
      manager.stop(run.id, false);
    }
    // The close timer does not hold the process open, and an engine that never answers holds nothing either.
    const keepAlive = setInterval(() => undefined, 1000);
    try {
      await manager.close(100);
    } finally {
      clearInterval(keepAlive);
    }
    return { store, manager, run, hung };
  }

  it("still leaves a run interrupted when its engine does not wind down in time, written before the store is let go", async () => {
    const { store, run } = await closeOnHungEngine(false);
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "interrupted", `${row?.status}: ${row?.failure}`);
    assert.equal(row?.state?.phase, "researching", "the state is the last checkpoint");
    const last = store.listResearchEvents(run.id).at(-1);
    assert.equal(last?.type, "run_interrupted");
    assert.equal(last?.payload["aliveUntil"], "2026-10-13T12:00:00.000Z");
  });

  it("does that for a run the user had stopped whose engine never answered, too", async () => {
    const { store, run } = await closeOnHungEngine(true);
    assert.equal(store.getResearchRun(run.id)?.status, "interrupted");
  });

  it("does not write once it has returned, even when the engine that never answered finally does", async () => {
    const { store, manager, run, hung } = await closeOnHungEngine(false);
    const snapshot = () => JSON.stringify([store.getResearchRun(run.id), store.listResearchEvents(run.id), store.listResearchWorkers(run.id)]);
    const before = snapshot();
    hung.resolve();
    await waitFor(() => !manager.isActive(run.id), "the late engine to be let go of");
    assert.equal(snapshot(), before, "a run closed out at shutdown is not rewritten by an engine that returns after it");
  });

  it("does not take an outcome back when the shutdown lands while the outcome waits for a locked database", async () => {
    const store = seededStore();
    let locked = true;
    let attempts = 0;
    spyOnRunWrites(store, (patch) => {
      if (patch.status === "cancelled") {
        attempts += 1;
        return locked ? busyError() : null;
      }
      return null;
    });
    // A stop that asked for a report, whose engine then throws: the manager writes the end of the run itself.
    const engine: ResearchEngine = async (input, _config, deps, signal) => {
      await deps.checkpoint(aState(input.runId));
      await untilAborted(signal);
      throw new Error("boom");
    };
    const manager = bareManager(store, { engine, persistRetry: FAST_RETRY });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => store.getResearchRun(run.id)?.state !== null, "the first checkpoint");
    manager.stop(run.id, true);
    await waitFor(() => attempts >= 1, "the outcome write to meet the lock");
    // The manager's own timers do not hold the process open, so something here must while the close waits.
    const keepAlive = setInterval(() => undefined, 20);
    try {
      const closing = manager.close(20_000);
      locked = false;
      await closing;
    } finally {
      clearInterval(keepAlive);
    }
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "cancelled", `${row?.status}: ${row?.failure}`);
    const types = store.listResearchEvents(run.id).map((e) => e.type);
    assert.ok(types.includes("run_cancelled"), "its terminal event is stored");
    assert.ok(!types.includes("run_interrupted"));
  });

  it("says in the interruption that a stop asked for a report, when one did, so the report can be finished later", async () => {
    const store = seededStore();
    const rigged = scriptedRig(store, { worker: "complete-first", writer: "wait" });
    const run = newRun(store, "c1");
    rigged.manager.start(run, thread());
    await waitFor(() => rigged.workerWaiting(), "round 2's worker waiting");
    rigged.manager.stop(run.id, true);
    await rigged.writerRunning;
    await rigged.manager.close();
    assert.deepEqual(store.listResearchEvents(run.id).at(-1)?.payload["stopRequested"], { writeReport: true });

    const plainStore = seededStore();
    const plain = scriptedRig(plainStore, { worker: "wait" });
    const other = newRun(plainStore, "c2");
    plain.manager.start(other, thread());
    await waitFor(() => plain.workerWaiting(), "the worker waiting");
    await plain.manager.close();
    const payload = plainStore.listResearchEvents(other.id).at(-1)?.payload ?? {};
    assert.equal("stopRequested" in payload, false, "a plain shutdown says nothing about a stop");
  });
});

// ---------------------------------------------------------------- what counts as live, and how a stop is heard

describe("which runs are live", () => {
  it("is a run whose row is queued or running, and not one whose outcome is stored while its report file is still being written", async () => {
    const store = seededStore();
    const hang = deferred<string | null>();
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(aState(input.runId));
      return { status: "completed", report: "# R", state: aState(input.runId, { phase: "done" }), failure: null };
    };
    const manager = bareManager(store, { engine, writeReport: () => hang.promise, reportWriteTimeoutMs: 60_000 });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    assert.equal(manager.hasLiveRun("s1"), true);
    await waitFor(() => store.getResearchRun(run.id)?.status === "completed", "the outcome to be stored");
    assert.equal(manager.isActive(run.id), true, "the job is still there, waiting on a report file that does not come");
    assert.equal(manager.hasLiveRun("s1"), false, "but the run is over: archiving or settling the thread is no longer refused");
    assert.equal(manager.hasLiveRun("another-thread"), false);
    hang.resolve(null);
    await waitFor(() => !manager.isActive(run.id), "the job to end");
  });

  it("counts a job whose row never reached running as queued, and one that did as live", async () => {
    const store = seededStore();
    let refused = false;
    spyOnRunWrites(store, (patch) => {
      if (patch.status === "running" && !refused) {
        refused = true;
        return busyError();
      }
      return null;
    });
    const engine: ResearchEngine = async (input, _config, deps, signal) => {
      await deps.checkpoint(aState(input.runId));
      await untilAborted(signal);
      return { status: "cancelled", report: null, state: aState(input.runId, { phase: "done", aborted: true }), failure: "cancelled: stopped" };
    };
    const manager = bareManager(store, { engine, persistRetry: FAST_RETRY });
    assert.deepEqual(manager.counts(), { live: 0, queued: 0 });
    const first = newRun(store, "c1");
    manager.start(first, thread());
    const second = newRun(store, "c2");
    manager.start(second, thread("s1"));
    assert.equal(store.getResearchRun(first.id)?.status, "queued", "the first run's mark as running was refused");
    assert.equal(store.getResearchRun(second.id)?.status, "running");
    assert.deepEqual(manager.counts(), { live: 1, queued: 1 });
    manager.stop(first.id, false);
    manager.stop(second.id, false);
    await waitFor(() => !manager.isActive(first.id) && !manager.isActive(second.id), "both runs to end");
    assert.deepEqual(manager.counts(), { live: 0, queued: 0 });
  });
});

describe("a stop while the database is locked", () => {
  it("is heard at once by a checkpoint that is waiting, however long its wait was going to be", async () => {
    const store = seededStore();
    const writes = spyOnRunWrites(store, (patch) => (patch.status === undefined && patch.state ? busyError() : null));
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(aState(input.runId));
      return { status: "cancelled", report: null, state: aState(input.runId, { phase: "done", aborted: true }), failure: "cancelled: stopped" };
    };
    // A wait of half a minute between tries: only the stop can end it in time.
    const manager = bareManager(store, { engine, persistRetry: { windowMs: 120_000, firstDelayMs: 30_000, maxDelayMs: 30_000 } });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => writes.length >= 1, "the checkpoint to meet the lock");
    assert.equal(manager.isActive(run.id), true);
    manager.stop(run.id, false);
    await waitFor(() => !manager.isActive(run.id), "the run to end", 5000);
    assert.equal(store.getResearchRun(run.id)?.status, "cancelled");
  });

  it("does not cut short the checkpoint before a dispatch: a round that was never saved is not dispatched on a hope", async () => {
    const store = seededStore();
    let locked = true;
    const writes = spyOnRunWrites(store, (patch) => (patch.status === undefined && patch.state && locked ? busyError() : null));
    let passed = false;
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(aState(input.runId), { beforeDispatch: true });
      passed = true;
      return { status: "cancelled", report: null, state: aState(input.runId, { phase: "done", aborted: true }), failure: "cancelled: stopped" };
    };
    const manager = bareManager(store, { engine, persistRetry: FAST_RETRY });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => writes.length >= 1, "the checkpoint to meet the lock");
    manager.stop(run.id, false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(passed, false, "the engine is still waiting for its round to be saved");
    locked = false;
    await waitFor(() => !manager.isActive(run.id), "the run to end", 10_000);
    assert.equal(passed, true);
  });
});

describe("which checkpoint the run cannot go on without", () => {
  const dispatchShaped = (runId: string): ResearchRunState =>
    aState(runId, {
      rounds: [
        {
          round: 1,
          startedAt: "2026-10-13T10:00:00.000Z",
          endedAt: null,
          reflection: "r",
          verdict: "CONTINUE_RESEARCH",
          delegations: [{ agentId: 1, topic: "T", discovery: false, maxReads: null }],
          results: [],
          exit: null,
        },
      ],
    });

  it("is the one the engine says is before a dispatch, whatever shape the state has", async () => {
    const store = seededStore();
    spyOnRunWrites(store, (patch) => (patch.status === undefined && patch.state ? busyError() : null));
    let passed = false;
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(aState(input.runId), { beforeDispatch: true });
      passed = true;
      return { status: "completed", report: "# R", state: aState(input.runId, { phase: "done" }), failure: null };
    };
    const manager = bareManager(store, { engine, persistRetry: SHORT_RETRY });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => !manager.isActive(run.id), "the run to end", 15_000);
    assert.equal(passed, false, "the engine was stopped at that checkpoint");
    assert.equal(store.getResearchRun(run.id)?.status, "interrupted");
  });

  it("is not guessed from the shape of the state: a checkpoint that looks like a dispatch but is not said to be is an ordinary one", async () => {
    const store = seededStore();
    spyOnRunWrites(store, (patch) => (patch.status === undefined && patch.state ? busyError() : null));
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(dispatchShaped(input.runId));
      return { status: "completed", report: "# R", state: aState(input.runId, { phase: "done" }), failure: null };
    };
    const manager = bareManager(store, { engine, persistRetry: SHORT_RETRY });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => !manager.isActive(run.id), "the run to end", 15_000);
    assert.equal(store.getResearchRun(run.id)?.status, "completed");
  });
});

describe("the end of a run that cannot be stored", () => {
  it("does not retry an error that waiting would not change", async () => {
    const store = seededStore();
    const logs: string[] = [];
    let attempts = 0;
    spyOnRunWrites(store, (patch) => {
      if (patch.status === "completed") {
        attempts += 1;
        return new Error("disk I/O error");
      }
      return null;
    });
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(aState(input.runId));
      return { status: "completed", report: "# R", state: aState(input.runId, { phase: "done" }), failure: null };
    };
    const manager = bareManager(store, { engine, persistRetry: FAST_RETRY, log: (m) => logs.push(m) });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => !manager.isActive(run.id), "the run to end", 10_000);
    assert.equal(attempts, 1, "tried once, not for the whole window");
    assert.equal(store.getResearchRun(run.id)?.status, "interrupted");
  });

  it("still writes the report file when the database would not take the outcome, and says where it is", async () => {
    const store = seededStore();
    const logs: string[] = [];
    spyOnRunWrites(store, (patch) => (patch.status === "completed" ? busyError() : null));
    const written: string[] = [];
    const engine: ResearchEngine = async (input, _config, deps) => {
      await deps.checkpoint(aState(input.runId));
      return { status: "completed", report: "# Finished report", state: aState(input.runId, { phase: "done" }), failure: null };
    };
    const manager = bareManager(store, {
      engine,
      persistRetry: SHORT_RETRY,
      log: (m) => logs.push(m),
      writeReport: async (_thread, _run, report) => {
        written.push(report);
        return "research/report.md";
      },
    });
    const run = newRun(store, "c1");
    manager.start(run, thread());
    await waitFor(() => !manager.isActive(run.id), "the run to end", 15_000);
    const row = store.getResearchRun(run.id);
    assert.equal(row?.status, "interrupted");
    assert.equal(row?.report, null, "the database still has no report: it never took one");
    assert.deepEqual(written, ["# Finished report"], "the file was written all the same");
    assert.ok(logs.some((m) => m.includes("research/report.md")), logs.join(" | "));
  });
});

// ---------------------------------------------------------------- the sweep at boot, when the database is locked

describe("the sweep at boot when the database is locked", () => {
  it("tries a row again after a busy refusal, and keeps what it already did", async () => {
    const store = seededStore();
    const manager = bareManager(store);
    const run = newRun(store, "c1", "running");
    const real = store.updateResearchRunIf.bind(store);
    let busy = 2;
    store.updateResearchRunIf = (id: string, from: Parameters<typeof real>[1], patch: ResearchRunPatch) => {
      if (busy > 0) {
        busy -= 1;
        throw busyError();
      }
      return real(id, from, patch);
    };
    const marked = await manager.sweepInterruptedOnBoot([2, 2, 2]);
    assert.deepEqual(marked.map((r) => r.id), [run.id]);
    assert.equal(store.getResearchRun(run.id)?.status, "interrupted");
    assert.equal(store.listResearchEvents(run.id).filter((e) => e.type === "run_interrupted").length, 1);
  });

  it("also tries again when it is the listing that is refused", async () => {
    const store = seededStore();
    const manager = bareManager(store);
    const run = newRun(store, "c1", "running");
    const real = store.listRunningResearchRuns.bind(store);
    let busy = 1;
    store.listRunningResearchRuns = () => {
      if (busy > 0) {
        busy -= 1;
        throw busyError();
      }
      return real();
    };
    assert.deepEqual((await manager.sweepInterruptedOnBoot([2, 2])).map((r) => r.id), [run.id]);
  });

  it("gives up after its attempts, logs it, and leaves the row for the next boot", async () => {
    const store = seededStore();
    const logs: string[] = [];
    const manager = bareManager(store, { log: (m) => logs.push(m) });
    const run = newRun(store, "c1", "running");
    let attempts = 0;
    store.updateResearchRunIf = () => {
      attempts += 1;
      throw busyError();
    };
    assert.deepEqual(await manager.sweepInterruptedOnBoot([2, 2]), []);
    assert.equal(attempts, 3, "the first try and one more after each wait");
    assert.equal(store.getResearchRun(run.id)?.status, "running");
    assert.ok(logs.some((m) => m.includes(run.id) && /locked/.test(m)), logs.join(" | "));
  });

  it("does not wait on an error that waiting would not change", async () => {
    const store = seededStore();
    const manager = bareManager(store);
    newRun(store, "c1", "running");
    let attempts = 0;
    store.updateResearchRunIf = () => {
      attempts += 1;
      throw new Error("disk I/O error");
    };
    assert.deepEqual(await manager.sweepInterruptedOnBoot([2, 2, 2]), []);
    assert.equal(attempts, 1);
  });
});
