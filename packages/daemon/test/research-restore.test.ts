/**
 * What a stored state must carry before an engine continues from it, and what a stop-and-write leaves behind: the
 * salvage checkpoint records how the loop ended, and a state with a damaged nested shape ends the run with a
 * clear failure instead of a throw somewhere inside it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runResearch, researchRunStateDamage } from "../src/research/engine.js";
import type { ResearchRunState, SupervisorRound } from "../src/research/types.js";
import {
  FakeClock,
  FakeModel,
  FakeWorker,
  INPUT,
  briefText,
  decision,
  makeHarness,
  researchingState,
  testConfig,
  verifiedWorkerScript,
} from "./research-fakes.js";

function round(overrides: Partial<SupervisorRound> = {}): SupervisorRound {
  return {
    round: 1,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(60_000).toISOString(),
    reflection: "r",
    verdict: "CONTINUE_RESEARCH",
    delegations: [{ agentId: 1, topic: "T", discovery: false, maxReads: null }],
    results: [
      { agentId: 1, status: "completed", findingsChars: 10, savedCount: 1, verifiedCount: 1, observedCount: 2, usage: null, error: null, startedAt: new Date(0).toISOString(), endedAt: new Date(1000).toISOString() },
    ],
    exit: null,
    ...overrides,
  };
}

function good(): ResearchRunState {
  const state = researchingState(testConfig(), Date.UTC(2026, 8, 26, 12, 0, 0));
  state.rounds = [round()];
  state.nextAgentId = 2;
  return state;
}

describe("a stop-and-write checkpoint", () => {
  it("records how the loop ended before the salvage write, so a resume writes a salvage report", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({
      brief: [briefText()],
      supervisor: [decision("CONTINUE_RESEARCH", ["Early"]), decision("CONTINUE_RESEARCH", ["T1", "T2"])],
      writer: ["# Salvage\n\nClaim [A1-S1]."],
    });
    model.onCall = () => clock.advanceMinutes(3.5);
    const controller = new AbortController();
    const worker = new FakeWorker(verifiedWorkerScript());
    worker.onStart = (task) => {
      if (task.agentId === 2) controller.abort();
    };
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch({ ...INPUT, stopWritesReport: true }, testConfig({ maxParallel: 2, windowMaxMinutes: 10, salvageFraction: 0.6 }), harness.deps, controller.signal);
    assert.equal(outcome.status, "partial");

    const writing = harness.checkpoints.filter((s) => s.phase === "writing");
    assert.ok(writing.length > 0, "the run checkpointed at the writing phase");
    for (const checkpoint of writing) {
      assert.equal(checkpoint.loopExit?.salvage, true, "every writing checkpoint carries the loop exit");
      assert.match(checkpoint.loopExit?.reason ?? "", /cancelled/);
    }

    // A run continued from the first of them goes on to write a salvage report, not a finished one.
    const resumedModel = new FakeModel({ writer: ["# Resumed salvage\n\nClaim [A1-S1]."] });
    const resumed = await runResearch(INPUT, testConfig(), makeHarness(resumedModel, new FakeWorker(), clock).deps, new AbortController().signal, writing[0]);
    assert.equal(resumed.status, "partial");
    assert.match(resumed.failure ?? "", /cancelled/);
  });
});

describe("the checkpoint before workers are dispatched", () => {
  it("is marked by the engine itself, and no other checkpoint is", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({
      brief: [briefText()],
      supervisor: [decision("CONTINUE_RESEARCH", ["A"]), decision("CONTINUE_RESEARCH", ["B"]), decision("RESEARCH_COMPLETE", [])],
      writer: ["# Report\n\nClaim [A1-S1]."],
    });
    model.onCall = () => clock.advanceMinutes(2);
    const harness = makeHarness(model, new FakeWorker(verifiedWorkerScript()), clock);
    const calls: { phase: string; open: boolean; dispatching: boolean; flagged: boolean }[] = [];
    harness.deps.checkpoint = (state, options) => {
      const last = state.rounds[state.rounds.length - 1];
      calls.push({
        phase: state.phase,
        open: Boolean(last && last.endedAt === null),
        // What is about to happen: a round with its delegations and no worker answered yet.
        dispatching: Boolean(last && last.endedAt === null && last.results.length === 0 && last.delegations.length > 0),
        flagged: options?.beforeDispatch === true,
      });
    };
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    const dispatching = calls.filter((c) => c.dispatching);
    assert.ok(dispatching.length >= 2, "one per round that delegated");
    assert.ok(dispatching.every((c) => c.flagged), "each checkpoint before a dispatch says so");
    assert.ok(calls.filter((c) => !c.dispatching).every((c) => !c.flagged), "and no other one does");
  });
});

describe("researchRunStateDamage", () => {
  it("accepts a state the engine wrote", () => {
    assert.equal(researchRunStateDamage(good()), null);
  });

  const damages: [string, (state: Record<string, any>) => void][] = [
    ["a null round", (s) => { s.rounds = [null]; }],
    ["rounds that are not a list", (s) => { s.rounds = "none"; }],
    ["a round without results", (s) => { delete s.rounds[0].results; }],
    ["a round whose delegations are not a list", (s) => { s.rounds[0].delegations = {}; }],
    ["a result that is not an object", (s) => { s.rounds[0].results = [7]; }],
    ["a result without a status", (s) => { delete s.rounds[0].results[0].status; }],
    ["usage with a text count", (s) => { s.usage = { inputTokens: "many", outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 }; }],
    ["a start that is not a date", (s) => { s.startedAt = "yesterday-ish"; }],
    ["a deadline that is not a date", (s) => { s.researchDeadlineAt = 12; }],
    ["no agent counter", (s) => { s.nextAgentId = "next"; }],
    ["notes that are not text", (s) => { s.notes = [1, 2]; }],
    ["a registry entry that is not an object", (s) => { s.registry = ["A1-S1"]; }],
    ["a phase nobody knows", (s) => { s.phase = "lunch"; }],
    ["a config that is not an object", (s) => { s.config = null; }],
    ["a question that is not text", (s) => { s.question = null; }],
  ];

  for (const [name, damage] of damages) {
    it(`names ${name}`, () => {
      const state = JSON.parse(JSON.stringify(good()));
      damage(state);
      assert.ok(researchRunStateDamage(state), `${name} went unnoticed`);
    });
  }
});

describe("continuing from a damaged state", () => {
  for (const [name, damage] of [
    ["a null round", (s: Record<string, any>) => { s.rounds = [null]; }],
    ["a round without results", (s: Record<string, any>) => { delete s.rounds[0].results; }],
    ["usage with a text count", (s: Record<string, any>) => { s.usage = { inputTokens: "many" }; }],
  ] as const) {
    it(`ends the run failed with a clear reason for ${name}, without a throw or a model call`, async () => {
      const state = JSON.parse(JSON.stringify(good()));
      damage(state);
      const model = new FakeModel({ supervisor: [decision("RESEARCH_COMPLETE", [])], writer: ["unused"] });
      const worker = new FakeWorker();
      const harness = makeHarness(model, worker);
      const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal, state);
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.report, null);
      assert.match(outcome.failure ?? "", /saved state.*damaged|damaged.*saved state/i);
      assert.equal(model.calls.length, 0);
      assert.equal(worker.tasks.length, 0);
      assert.equal(harness.checkpoints.length, 0, "a damaged state is not written over");
      assert.deepEqual(harness.events.map((e) => e.type), ["run_failed"], "and the log still gets its terminal event");
    });
  }
});
