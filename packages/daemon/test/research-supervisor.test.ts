import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunContext } from "../src/research/context.js";
import { mapWithLimit, runSupervisorLoop } from "../src/research/supervisor.js";
import type { ResearchConfig, ResearchRunState } from "../src/research/index.js";
import {
  FakeClock,
  FakeModel,
  FakeWorker,
  INPUT,
  completedResult,
  decision,
  failedResult,
  makeHarness,
  researchingState,
  saved,
  searchCall,
  testConfig,
  verifiedWorkerScript,
  type Harness,
} from "./research-fakes.js";

interface LoopRun {
  harness: Harness;
  state: ResearchRunState;
  ctx: RunContext;
  controller: AbortController;
}

function loop(config: ResearchConfig, model: FakeModel, worker: FakeWorker, clock = new FakeClock()): LoopRun {
  const harness = makeHarness(model, worker, clock);
  const state = researchingState(config, clock.now);
  const controller = new AbortController();
  const ctx = new RunContext(state, harness.deps, INPUT, controller.signal);
  return { harness, state, ctx, controller };
}

/** A supervisor that advances the clock by `minutes` on every decision and always delegates one topic. */
function busySupervisor(clock: FakeClock, minutes: number, verdict: "CONTINUE_RESEARCH" | "RESEARCH_COMPLETE" = "CONTINUE_RESEARCH"): FakeModel {
  const model = new FakeModel({ supervisor: [(_req, index) => decision(verdict, [`Topic ${index + 1}`])] });
  model.onCall = () => clock.advanceMinutes(minutes);
  return model;
}

describe("supervisor loop exits", () => {
  it("stops when the round count reaches maxRounds", async () => {
    const clock = new FakeClock();
    const run = loop(testConfig({ maxRounds: 3, windowMaxMinutes: 100 }), busySupervisor(clock, 0.1), new FakeWorker(verifiedWorkerScript()), clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.deepEqual(exit, { kind: "write", reason: "round cap reached (3)", salvage: false });
    assert.equal(run.state.rounds.length, 3);
    assert.equal(run.state.rounds[2]?.exit, "round cap reached (3)");
    assert.equal(run.harness.worker.tasks.length, 3);
  });

  it("stops once windowMax plus one minute has elapsed", async () => {
    const clock = new FakeClock();
    const run = loop(testConfig({ windowMaxMinutes: 10, maxRounds: 50 }), busySupervisor(clock, 4), new FakeWorker(verifiedWorkerScript()), clock);
    const exit = await runSupervisorLoop(run.ctx);
    // Decisions at 4, 8 and 12 minutes: the third round runs, then 12 >= 11 ends research.
    assert.equal(run.state.rounds.length, 3);
    assert.ok(exit.kind === "write" && /window elapsed/.test(exit.reason));
    assert.equal(run.state.rounds[2]?.exit, exit.kind === "write" ? exit.reason : null);
  });

  it("needs two empty RESEARCH_COMPLETE rounds before windowMin", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("RESEARCH_COMPLETE", [], "VERDICT: READY_TO_CONCLUDE")] });
    const run = loop(testConfig({ windowMinMinutes: 3 }), model, new FakeWorker(), clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.deepEqual(exit, { kind: "write", reason: "research complete", salvage: false });
    assert.equal(run.state.rounds.length, 2);
    assert.equal(model.counts.supervisor, 2);
    assert.match(model.calls[1]?.prompt ?? "", /NOTE: Your previous decision set RESEARCH_COMPLETE/);
    assert.equal(run.harness.worker.tasks.length, 0);
  });

  it("accepts an empty RESEARCH_COMPLETE at once after windowMin", async () => {
    const clock = new FakeClock();
    clock.advanceMinutes(3.5);
    const model = new FakeModel({ supervisor: [decision("RESEARCH_COMPLETE", [])] });
    const config = testConfig({ windowMinMinutes: 3 });
    const harness = makeHarness(model, new FakeWorker(), clock);
    const state = researchingState(config, clock.now - 3.5 * 60_000);
    const ctx = new RunContext(state, harness.deps, INPUT, new AbortController().signal);
    const exit = await runSupervisorLoop(ctx);
    assert.equal(exit.kind === "write" && exit.reason, "research complete");
    assert.equal(state.rounds.length, 1);
  });

  it("treats RESEARCH_COMPLETE with delegations as CONTINUE for that round", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("RESEARCH_COMPLETE", ["Topic A"]), decision("RESEARCH_COMPLETE", [])] });
    model.onCall = () => clock.advanceMinutes(2);
    const run = loop(testConfig({ windowMinMinutes: 3 }), model, new FakeWorker(verifiedWorkerScript()), clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.equal(run.harness.worker.tasks.length, 1);
    assert.equal(run.state.rounds[0]?.verdict, "RESEARCH_COMPLETE");
    assert.equal(run.state.rounds[0]?.delegations.length, 1);
    assert.equal(exit.kind === "write" && exit.reason, "research complete");
    assert.equal(run.state.rounds.length, 2);
    assert.ok(run.harness.logs.some((line) => /RESEARCH_COMPLETE ignored/.test(line)));
  });

  it("ends research when the token soft cap is passed", async () => {
    const clock = new FakeClock();
    const model = busySupervisor(clock, 0.1);
    model.usagePerCall = 400;
    const run = loop(testConfig({ tokenSoftCap: 1000, maxRounds: 50, windowMaxMinutes: 100 }), model, new FakeWorker(verifiedWorkerScript()), clock);
    const exit = await runSupervisorLoop(run.ctx);
    // Each round costs 400 (decision) + 50 (worker); the cap trips before the third decision.
    assert.ok(exit.kind === "write" && /token soft cap passed/.test(exit.reason));
    assert.equal(run.state.rounds.length, 3);
    assert.ok(run.state.usage.totalTokens >= 1000);
  });

  it("ends after two idle CONTINUE rounds instead of looping", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", [])] });
    const run = loop(testConfig(), model, new FakeWorker(), clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.equal(exit.kind === "write" && exit.reason, "no delegations in two consecutive rounds");
    assert.equal(model.counts.supervisor, 2);
  });
});

describe("supervisor loop workers", () => {
  it("runs at most maxParallel workers at once and queues the rest", async () => {
    const clock = new FakeClock();
    const topics = Array.from({ length: 6 }, (_, i) => `Topic ${i + 1}`);
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", topics), decision("RESEARCH_COMPLETE", [])] });
    model.onCall = () => clock.advanceMinutes(4);
    const worker = new FakeWorker(verifiedWorkerScript());
    const run = loop(testConfig({ maxParallel: 3 }), model, worker, clock);
    await runSupervisorLoop(run.ctx);
    assert.equal(worker.tasks.length, 6);
    assert.equal(worker.maxConcurrent, 3);
    assert.deepEqual(
      worker.tasks.map((t) => t.agentId),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(run.state.registry.length, 6);
    assert.equal(run.state.notes.length, 6);
  });

  it("passes the delegation's max_reads into the budgets and the discovery flag into the task", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({
      supervisor: [decision("CONTINUE_RESEARCH", [{ topic: "Deep", max_reads: 40 }, { topic: "Wide", discovery: true }]), decision("RESEARCH_COMPLETE", [])],
    });
    model.onCall = () => clock.advanceMinutes(4);
    const worker = new FakeWorker(verifiedWorkerScript());
    const run = loop(testConfig({ workerMaxReads: 10 }), model, worker, clock);
    await runSupervisorLoop(run.ctx);
    assert.equal(worker.budgets[0]?.maxReads, 40);
    assert.equal(worker.budgets[1]?.maxReads, 10);
    assert.equal(worker.tasks[1]?.discovery, true);
    assert.match(worker.tasks[1]?.instructions ?? "", /DISCOVERY/);
    assert.match(worker.tasks[0]?.instructions ?? "", /at most 40 page fetches/);
  });

  it("trips the breaker when every worker fails with a quota error", async () => {
    const clock = new FakeClock();
    const model = busySupervisor(clock, 1);
    const worker = new FakeWorker(() => failedResult("quota: billing exhausted"));
    const run = loop(testConfig(), model, worker, clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.equal(exit.kind, "aborted");
    assert.match(exit.reason, /quota/);
    assert.equal(run.state.aborted, true);
    assert.equal(run.state.rounds.length, 1);
    assert.equal(run.state.rounds[0]?.exit, "circuit breaker");
    assert.equal(model.counts.supervisor, 1);
  });

  it("retries a failed round once, then salvages when enough of the window is spent and findings exist", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["Good"]), decision("CONTINUE_RESEARCH", ["Bad one", "Bad two"])] });
    model.onCall = () => clock.advanceMinutes(3);
    let calls = 0;
    const worker = new FakeWorker((task) => {
      calls += 1;
      if (task.agentId === 1) return completedResult("useful findings (https://a.org)", [saved("https://a.org", "A")], [searchCall("q", [{ url: "https://a.org", title: "A" }])]);
      return failedResult("timeout: worker hung", "timed_out");
    });
    const run = loop(testConfig({ windowMaxMinutes: 10, salvageFraction: 0.6 }), model, worker, clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.ok(exit.kind === "write" && exit.salvage, JSON.stringify(exit));
    // Round 1 succeeds; round 2 fails; round 3 retries the same two topics without a new decision; then salvage.
    assert.equal(model.counts.supervisor, 2);
    assert.equal(calls, 5);
    assert.equal(run.state.rounds.length, 3);
    assert.deepEqual(
      run.state.rounds[2]?.delegations.map((d) => [d.topic, d.agentId]),
      [
        ["Bad one", 4],
        ["Bad two", 5],
      ],
    );
    assert.equal(run.state.consecutiveFailures, 2);
    assert.ok(run.state.notes.some((n) => /^Worker A2 on Bad one failed: timeout/.test(n)));
  });

  it("aborts after the retry when nothing was found or the window is young", async () => {
    const clock = new FakeClock();
    const model = busySupervisor(clock, 0.5);
    const worker = new FakeWorker(() => failedResult("other: boom"));
    const run = loop(testConfig({ windowMaxMinutes: 10 }), model, worker, clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.equal(exit.kind, "aborted");
    assert.match(exit.reason, /stalled after 2 consecutive failed rounds/);
    assert.equal(run.state.rounds.length, 2);
    assert.equal(model.counts.supervisor, 1);
  });

  it("checkpoints after each round with a state that survives JSON", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["A"]), decision("CONTINUE_RESEARCH", ["B"]), decision("RESEARCH_COMPLETE", [])] });
    model.onCall = () => clock.advanceMinutes(2);
    const run = loop(testConfig(), model, new FakeWorker(verifiedWorkerScript()), clock);
    await runSupervisorLoop(run.ctx);
    const finished = run.harness.checkpoints.filter((s) => s.rounds.length > 0 && s.rounds[s.rounds.length - 1]?.endedAt !== null);
    assert.deepEqual(
      finished.map((s) => s.rounds.length),
      [1, 2, 3],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(run.state)), run.state);
    assert.equal(run.harness.checkpoints[run.harness.checkpoints.length - 1]?.rounds[2]?.exit, "research complete");
  });

  it("aborts when the supervisor fails twice before anything was found", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: ["no json here", "still nothing"] });
    const run = loop(testConfig(), model, new FakeWorker(), clock);
    const exit = await runSupervisorLoop(run.ctx);
    assert.equal(exit.kind, "aborted");
    assert.match(exit.reason, /supervisor decision failed twice/);
    assert.match(model.calls[1]?.prompt ?? "", /did not contain a valid fenced JSON decision/);
  });
});

describe("mapWithLimit", () => {
  it("preserves order and never exceeds the limit", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      running -= 1;
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
    assert.equal(peak, 2);
  });
});
