/**
 * Research startup is bounded: a worker or control session that Muse never opens settles as cancelled when the
 * run is stopped and as unavailable when the allowance passes, and a stuck start never keeps a worker slot.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  AncillaStore,
  DEFAULT_RESEARCH_CONFIG,
  ResearchFailure,
  type ResearchOutcome,
  type ResearchRunState,
  type WorkerBudgets,
  type WorkerResult,
  type WorkerRunner,
  type WorkerTask,
} from "@ancilla/daemon";
import { ResearchJobManager, Semaphore, uuidv7, type ResearchEngine } from "../src/research/index.js";
import { waitFor } from "./harness.js";
import { BUDGETS, TASK, controlRig, modelRequest, noSink, sleep, workerRig } from "./research-rigs.js";

const neverStarts = (): Promise<never> => new Promise(() => undefined);

describe("worker startup", () => {
  it("settles cancelled the moment the run is stopped while the session is still opening", async () => {
    const { runner, clock, updates } = workerRig({ start: neverStarts, startupMs: 120_000 });
    const controller = new AbortController();
    const pending = runner.run(TASK, BUDGETS, controller.signal, noSink);
    await sleep(10);
    controller.abort({ type: "stop", writeReport: false });
    const result = await Promise.race([pending, sleep(500).then(() => "still waiting" as const)]);
    assert.notEqual(result, "still waiting", "a stop is not held up by a session start");
    if (result === "still waiting") {
      return;
    }
    assert.equal(result.status, "cancelled");
    assert.match(result.error ?? "", /^cancelled: /);
    assert.equal(clock.timers.length, 0, "no timer outlives the run");
    assert.deepEqual(updates, [], "no session, so no worker row to update");
  });

  it("fails unavailable on the clock when the session never opens, with a timer armed until then", async () => {
    const { runner, clock, logs } = workerRig({ start: neverStarts, startupMs: 120_000 });
    const pending = runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    await waitFor(() => clock.timers.length === 1, "the startup allowance armed", 500);
    clock.advance(119_000);
    assert.equal(clock.timers.length, 1);
    clock.advance(1_000);
    const result = await pending;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /^unavailable: could not start a worker session: .*within 120 s/);
    assert.equal(clock.timers.length, 0);
    assert.ok(logs.some((line) => /worker A1 session did not open within 120 s; giving up on it/.test(line)), logs.join(" | "));
  });

  it("uses the allowance a function gives, read at each start", async () => {
    let allowance = 30_000;
    const { runner, clock } = workerRig({ start: neverStarts, startupMs: () => allowance });
    const first = runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    await waitFor(() => clock.timers.length === 1, "the first allowance armed", 500);
    clock.advance(30_000);
    assert.equal((await first).status, "failed");
    allowance = 60_000;
    const second = runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    await waitFor(() => clock.timers.length === 1, "the second allowance armed", 500);
    clock.advance(30_000);
    assert.equal(clock.timers.length, 1, "the new allowance is longer");
    clock.advance(30_000);
    assert.equal((await second).status, "failed");
  });

  it("passes the start a give-up signal, aborted when the run gave up on it", async () => {
    const { runner, startsSeen, clock } = workerRig({ start: neverStarts, startupMs: 1000 });
    const pending = runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    await waitFor(() => startsSeen.length === 1, "the start", 500);
    assert.equal(startsSeen[0]?.aborted, false);
    clock.advance(1000);
    await pending;
    assert.equal(startsSeen[0]?.aborted, true);
  });

  it("does not cache or reuse a start that timed out: the next worker opens its own session", async () => {
    let calls = 0;
    const { runner, clock } = workerRig({
      startupMs: 1000,
      start: async () => {
        calls += 1;
        if (calls === 1) {
          return neverStarts();
        }
        return { sessionId: `w${calls}`, manager: workerManagerStub() };
      },
    });
    const first = runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    await waitFor(() => clock.timers.length === 1, "armed", 500);
    clock.advance(1000);
    assert.equal((await first).status, "failed");
    assert.equal(calls, 1);
    // The second run reaches the turn (which the stub refuses); the point is that it started again.
    await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(calls, 2);
  });

  it("records a worker stopped before its turn started as cancelled, not failed", async () => {
    const { connection, runner, updates } = workerRig({ cancelGraceMs: 30_000 });
    const controller = new AbortController();
    // The run is stopped while the turn start is in flight, and the host then fails it.
    connection.replies.set("turn/start", () => {
      controller.abort({ type: "stop", writeReport: false });
      throw new Error("the host went away");
    });
    const result = await runner.run(TASK, BUDGETS, controller.signal, noSink);
    assert.equal(result.status, "cancelled");
    assert.match(result.error ?? "", /^cancelled: /);
    assert.equal(updates[updates.length - 1]?.state, "cancelled");
  });

  it("still records a turn start the host refused, with no stop, as failed", async () => {
    const { connection, runner, updates } = workerRig();
    connection.replies.set("turn/start", new Error("503 service unavailable"));
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /^unavailable: /);
    assert.equal(updates[updates.length - 1]?.state, "failed");
  });
});

/** A manager whose turn start is refused, for runs that only need a session handle. */
function workerManagerStub(): never {
  return { sendTurn: () => Promise.reject(new Error("no turns in this stub")), interruptTurn: () => Promise.resolve(), cancelTurn: () => Promise.resolve() } as never;
}

describe("control session startup", () => {
  it("settles cancelled the moment the run is stopped while the session is still opening", async () => {
    const { client, clock } = controlRig({ start: neverStarts });
    const controller = new AbortController();
    const pending = client.complete(modelRequest("supervisor", "x", controller.signal));
    await sleep(10);
    controller.abort({ type: "stop", writeReport: false });
    const outcome = await Promise.race([pending.then(() => "answered", (error: unknown) => error), sleep(500).then(() => "still waiting")]);
    assert.notEqual(outcome, "still waiting");
    assert.ok(outcome instanceof ResearchFailure && outcome.kind === "cancelled", String(outcome));
    assert.equal(clock.timers.length, 0);
  });

  it("fails unavailable on the clock when the session never opens", async () => {
    const { client, clock } = controlRig({ start: neverStarts, startupMs: 120_000 });
    const pending = client.complete(modelRequest("supervisor", "x"));
    const settled = pending.then(() => null, (error: unknown) => error);
    await waitFor(() => clock.timers.length === 1, "the startup allowance armed", 500);
    clock.advance(120_000);
    const error = await settled;
    assert.ok(error instanceof ResearchFailure && error.kind === "unavailable", String(error));
    assert.match(error.message, /could not start the research control session/);
    assert.equal(clock.timers.length, 0);
  });

  it("does not let a call that never got a session hold the calls behind it", async () => {
    // The first call's start never settles and its run is never stopped; the second call is its own run.
    let starts = 0;
    const { client, clock } = controlRig({
      startupMs: 120_000,
      start: async () => {
        starts += 1;
        return neverStarts();
      },
    });
    const first = client.complete(modelRequest("supervisor", "one"));
    const firstSettled = first.then(() => null, (error: unknown) => error);
    await waitFor(() => starts === 1, "the first start", 500);
    const secondController = new AbortController();
    const second = client.complete(modelRequest("writer", "two", secondController.signal));
    const secondSettled = second.then(() => null, (error: unknown) => error);
    await sleep(10);
    assert.equal(starts, 1, "calls run one at a time");
    secondController.abort({ type: "stop", writeReport: false });
    const queuedOutcome = await Promise.race([secondSettled, sleep(500).then(() => "still waiting")]);
    assert.ok(queuedOutcome instanceof ResearchFailure && queuedOutcome.kind === "cancelled", `a stop reaches a queued call: ${String(queuedOutcome)}`);
    clock.advance(120_000);
    const firstOutcome = await firstSettled;
    assert.ok(firstOutcome instanceof ResearchFailure && firstOutcome.kind === "unavailable");
    assert.equal(starts, 1, "the queued call that was stopped never started a session");
  });

  it("does not remember a start that timed out: the next call starts again", async () => {
    let starts = 0;
    const { client, clock } = controlRig({
      startupMs: 1000,
      start: async () => {
        starts += 1;
        return neverStarts();
      },
    });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const settled = client.complete(modelRequest("supervisor", "x")).then(() => null, (error: unknown) => error);
      await waitFor(() => starts === attempt && clock.timers.length === 1, `start ${attempt}`, 500);
      clock.advance(1000);
      assert.ok((await settled) instanceof ResearchFailure);
    }
    assert.equal(starts, 2);
  });
});

// ---------------------------------------------------------------- the job manager: slots, release, report writes

function seededStore(): AncillaStore {
  const store = new AncillaStore();
  after(() => store.close());
  const project = store.upsertProject("/work/p");
  store.recordSession({ id: "s1", projectId: project.id });
  return store;
}

function stateFor(runId: string, question: string): ResearchRunState {
  return {
    version: 1,
    runId,
    eventSeq: 0,
    question,
    config: DEFAULT_RESEARCH_CONFIG,
    phase: "researching",
    brief: "A brief",
    inputLanguage: "en",
    targetLanguage: "en",
    draft: null,
    rounds: [],
    registry: [],
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z",
    nextAgentId: 1,
  };
}

/** An engine that runs `count` workers at once and returns once they all have. */
function fanOutEngine(count: number): ResearchEngine {
  return async (input, config, deps, signal) => {
    const tasks = Array.from({ length: count }, (_, i): WorkerTask => ({ runId: input.runId, round: 1, agentId: i + 1, topic: `t${i + 1}`, discovery: false, instructions: "go", maxReads: null }));
    const budgets: WorkerBudgets = { maxToolCalls: 1, maxSearches: 1, maxReads: 1, maxSaves: 1, wallTimeMs: 1000 };
    const results = await Promise.all(tasks.map((task) => deps.worker.run(task, budgets, signal, noSink)));
    const cancelled = signal.aborted;
    const outcome: ResearchOutcome = cancelled
      ? { status: "cancelled", report: null, state: stateFor(input.runId, input.question), failure: "cancelled: stopped" }
      : { status: results.every((r) => r.status === "completed") ? "completed" : "failed", report: "done", state: stateFor(input.runId, input.question), failure: null };
    void config;
    return outcome;
  };
}

describe("worker slots and stuck startups", () => {
  it("returns every slot when four stuck startups are stopped", async () => {
    const store = seededStore();
    const { runner } = workerRig({ start: neverStarts, startupMs: 120_000 });
    const manager = new ResearchJobManager({
      store,
      engine: fanOutEngine(4),
      createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }),
      createWorkerRunner: () => runner,
      broadcast: () => undefined,
      writeReport: async () => null,
    });
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-stuck", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    manager.start(run, { sessionId: "s1", cwd: "/work/p", accountId: null, modelId: null });
    await waitFor(() => manager.activeWorkers === 4, "four workers holding slots", 1000);
    assert.equal(manager.stop(run.id, false), true);
    await waitFor(() => manager.activeWorkers === 0, "every slot returned after the stop", 1000);
    await waitFor(() => store.getResearchRun(run.id)?.status === "cancelled", "the run cancelled", 1000);
    assert.equal(manager.isActive(run.id), false);
    await manager.close();
  });

  it("returns every slot when four stuck startups pass their allowance", async () => {
    const store = seededStore();
    const { runner, clock } = workerRig({ start: neverStarts, startupMs: 120_000 });
    const manager = new ResearchJobManager({
      store,
      engine: fanOutEngine(4),
      createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }),
      createWorkerRunner: () => runner,
      broadcast: () => undefined,
      writeReport: async () => null,
    });
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-deadline", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    manager.start(run, { sessionId: "s1", cwd: "/work/p", accountId: null, modelId: null });
    await waitFor(() => manager.activeWorkers === 4 && clock.timers.length === 4, "four startups armed", 1000);
    clock.advance(120_000);
    await waitFor(() => manager.activeWorkers === 0, "every slot returned at the allowance", 1000);
    await waitFor(() => store.getResearchRun(run.id)?.status === "failed", "the run failed", 1000);
    assert.equal(clock.timers.length, 0, "no timer outlives the workers");
    await manager.close();
  });
});

describe("Semaphore", () => {
  it("admits no more than its limit even when a release is called twice", async () => {
    const slots = new Semaphore(2);
    const signal = new AbortController().signal;
    const releaseA = await slots.acquire(signal);
    const releaseB = await slots.acquire(signal);
    assert.equal(slots.active, 2);
    let granted = 0;
    const waiting = [slots.acquire(signal).then(() => (granted += 1)), slots.acquire(signal).then(() => (granted += 1))];
    await sleep(5);
    assert.equal(granted, 0);
    releaseA();
    releaseA();
    await sleep(5);
    assert.equal(slots.active, 2, "one slot was freed and taken by one waiter, not two");
    assert.equal(granted, 1);
    releaseB();
    await Promise.all(waiting);
    assert.equal(granted, 2);
  });

  it("counts a slot back once, however often its release runs", async () => {
    const slots = new Semaphore(1);
    const signal = new AbortController().signal;
    const release = await slots.acquire(signal);
    release();
    release();
    release();
    assert.equal(slots.active, 0);
    const again = await slots.acquire(signal);
    assert.equal(slots.active, 1);
    again();
    assert.equal(slots.active, 0);
  });
});

describe("writing the report file", () => {
  it("does not hold a finished run open when the file write never returns", async () => {
    const store = seededStore();
    const logs: string[] = [];
    const finished: ResearchEngine = async (input, _config, _deps) => ({ status: "completed", report: "# Report", state: stateFor(input.runId, input.question), failure: null });
    const manager = new ResearchJobManager({
      store,
      engine: finished,
      createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }),
      createWorkerRunner: () => ({ run: async (): Promise<WorkerResult> => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "unused" }) }) as WorkerRunner,
      broadcast: () => undefined,
      writeReport: () => new Promise<string | null>(() => undefined),
      reportWriteTimeoutMs: 40,
      log: (message) => logs.push(message),
    });
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-report", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    manager.start(run, { sessionId: "s1", cwd: "/work/p", accountId: null, modelId: null });
    await waitFor(() => !manager.isActive(run.id), "the job released after the write bound", 2000);
    const stored = store.getResearchRun(run.id);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.report, "# Report");
    assert.equal(stored?.reportPath, null);
    assert.ok(logs.some((line) => /report file/.test(line) && /gave no answer within 40 ms/.test(line)), logs.join(" | "));
    assert.match(manager.view(stored!, false).reportWriteError ?? "", /report file could not be written/, "the run's view says why there is no file");
    await manager.close();
  });

  it("clears the bound's timer when the write finishes", async () => {
    const store = seededStore();
    const finished: ResearchEngine = async (input) => ({ status: "completed", report: "# Report", state: stateFor(input.runId, input.question), failure: null });
    const manager = new ResearchJobManager({
      store,
      engine: finished,
      createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }),
      createWorkerRunner: () => ({ run: async (): Promise<WorkerResult> => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "unused" }) }) as WorkerRunner,
      broadcast: () => undefined,
      writeReport: async () => ".ancilla/research/x/report.md",
      reportWriteTimeoutMs: 60_000,
    });
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-report-ok", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    manager.start(run, { sessionId: "s1", cwd: "/work/p", accountId: null, modelId: null });
    await waitFor(() => store.getResearchRun(run.id)?.reportPath === ".ancilla/research/x/report.md", "the path stored", 2000);
    await waitFor(() => !manager.isActive(run.id), "the job released", 2000);
    await manager.close();
  });
});
