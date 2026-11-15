/**
 * Bounds on the research loop: a decision that comes back after the window dispatches nothing, and the
 * supervisor prompt's "Previous Rounds" block stays within its budget however long the run was.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunContext } from "../src/research/context.js";
import { runSupervisorLoop } from "../src/research/supervisor.js";
import {
  ROUNDS_BLOCK_CHAR_BUDGET,
  ROUNDS_RECENT_IN_FULL,
  ROUND_FULL_CHAR_CAP,
  buildSupervisorPrompt,
  runResearch,
  roundsBlock,
  type SupervisorRound,
  type SupervisorPromptInput,
} from "../src/research/index.js";
import { FakeClock, FakeModel, FakeWorker, INPUT, briefText, decision, makeHarness, researchingState, testConfig, verifiedWorkerScript } from "./research-fakes.js";

describe("the research window after a decision", () => {
  it("dispatches nothing when the decision comes back after the window", async () => {
    const clock = new FakeClock();
    // The window is one minute (research routes to writing at two); the decision takes three.
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["A late topic"])] });
    model.onCall = () => clock.advanceMinutes(3);
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const config = testConfig({ windowMinMinutes: 0.5, windowMaxMinutes: 1, maxRounds: 10 });
    const state = researchingState(config, clock.now);
    const ctx = new RunContext(state, harness.deps, INPUT, new AbortController().signal);
    const exit = await runSupervisorLoop(ctx);
    assert.equal(worker.tasks.length, 0, "no worker was launched past the window");
    // Nothing was found yet, so there is nothing for a writer to work from: the run ends failed, honestly.
    assert.ok(exit.kind === "aborted" && /research window elapsed.*while the supervisor was deciding, with no findings to write from/.test(exit.reason), JSON.stringify(exit));
    assert.equal(state.rounds.length, 0, "the late decision did not open a round");
    assert.equal(model.counts.supervisor, 1);
  });

  it("attributes the window exit to the round before, as the check ahead of a decision does", async () => {
    const clock = new FakeClock();
    // Round 1 is decided in time and run; the decision for round 2 returns after the window.
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["First"]), decision("CONTINUE_RESEARCH", ["Second"])] });
    model.onCall = (request) => {
      void request;
      clock.advanceMinutes(model.counts.supervisor === 1 ? 0.2 : 5);
    };
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const config = testConfig({ windowMinMinutes: 0.5, windowMaxMinutes: 1, maxRounds: 10 });
    const state = researchingState(config, clock.now);
    const ctx = new RunContext(state, harness.deps, INPUT, new AbortController().signal);
    const exit = await runSupervisorLoop(ctx);
    assert.equal(worker.tasks.length, 1, "only the first round ran");
    assert.equal(state.rounds.length, 1);
    assert.ok(exit.kind === "write" && /research window elapsed/.test(exit.reason));
    assert.equal(state.rounds[0]?.exit, exit.kind === "write" ? exit.reason : null);
  });

  it("still dispatches a decision that returns inside the window", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["On time"]), decision("RESEARCH_COMPLETE", [])] });
    model.onCall = () => clock.advanceMinutes(0.5);
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const config = testConfig({ windowMinMinutes: 0.5, windowMaxMinutes: 10, maxRounds: 10 });
    const state = researchingState(config, clock.now);
    const ctx = new RunContext(state, harness.deps, INPUT, new AbortController().signal);
    await runSupervisorLoop(ctx);
    assert.equal(worker.tasks.length, 1);
  });
});

describe("a decision that fails after the research window", () => {
  const junk = "I cannot decide.";

  it("ends aborted when nothing was found: no default workers and no report out of nothing", async () => {
    const clock = new FakeClock();
    // Both attempts answer without a decision, and each takes three minutes of a one minute window.
    const model = new FakeModel({ supervisor: [junk, junk], writer: ["## Report\nBody.\n"] });
    model.onCall = (request) => {
      if (request.role === "supervisor") clock.advanceMinutes(3);
    };
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const config = testConfig({ windowMinMinutes: 0.5, windowMaxMinutes: 1, maxRounds: 10 });
    const state = researchingState(config, clock.now);
    const ctx = new RunContext(state, harness.deps, INPUT, new AbortController().signal);
    const exit = await runSupervisorLoop(ctx);
    assert.ok(exit.kind === "aborted" && /research window elapsed.*while the supervisor was deciding, with no findings to write from/.test(exit.reason), JSON.stringify(exit));
    assert.equal(worker.tasks.length, 0, "the default delegations did not run after the window");
    assert.equal(state.rounds.length, 0);
    assert.equal(model.counts.writer, 0, "the writer was never called");
    assert.equal(state.aborted, true);
  });

  it("through the engine ends failed with no report and no writer call", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ brief: [briefText()], supervisor: [junk, junk], writer: ["## Report\nBody.\n"] });
    model.onCall = (request) => {
      if (request.role === "supervisor") clock.advanceMinutes(3);
    };
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const config = testConfig({ windowMinMinutes: 0.2, windowMaxMinutes: 1, maxRounds: 10, draftFirst: false });
    const outcome = await runResearch(INPUT, config, harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.report, null);
    assert.match(outcome.failure ?? "", /while the supervisor was deciding, with no findings to write from/);
    assert.equal(worker.tasks.length, 0);
    assert.equal(model.counts.writer, 0);
  });

  it("with findings keeps the salvage write, so the run ends partial and says why", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["First"]), junk, junk] });
    model.onCall = (request) => {
      if (request.role === "supervisor") clock.advanceMinutes(model.counts.supervisor === 1 ? 0.3 : 3);
    };
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const config = testConfig({ windowMinMinutes: 0.2, windowMaxMinutes: 1, maxRounds: 10 });
    const state = researchingState(config, clock.now);
    const ctx = new RunContext(state, harness.deps, INPUT, new AbortController().signal);
    const exit = await runSupervisorLoop(ctx);
    assert.equal(worker.tasks.length, 1, "only the first round ran");
    assert.ok(exit.kind === "write" && exit.salvage === true && /supervisor decision failed/.test(exit.reason), JSON.stringify(exit));
    assert.equal(state.rounds.length, 1);
  });

  it("with findings through the engine ends partial, never completed", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({
      brief: [briefText()],
      supervisor: [decision("CONTINUE_RESEARCH", ["First"]), junk, junk],
      writer: ["## Report\nBody text [A1].\n\n### Sources\n"],
    });
    model.onCall = (request) => {
      if (request.role === "supervisor") clock.advanceMinutes(model.counts.supervisor === 1 ? 0.3 : 3);
    };
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const config = testConfig({ windowMinMinutes: 0.2, windowMaxMinutes: 1, maxRounds: 10, draftFirst: false });
    const outcome = await runResearch(INPUT, config, harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "partial");
    assert.match(outcome.failure ?? "", /supervisor decision failed/);
  });
});

// ---------------------------------------------------------------- the Previous Rounds block

function roundOf(n: number, reflectionChars: number, delegations = 2): SupervisorRound {
  const ds = Array.from({ length: delegations }, (_, i) => ({ agentId: n * 10 + i, topic: `Round ${n} topic ${i}: ${"detail ".repeat(20)}`, discovery: false, maxReads: null }));
  return {
    round: n,
    startedAt: "2026-09-26T10:00:00.000Z",
    endedAt: "2026-09-26T10:01:00.000Z",
    reflection: `REFLECTION-${n} ` + "r".repeat(Math.max(0, reflectionChars - 20)),
    verdict: "CONTINUE_RESEARCH",
    delegations: ds,
    results: ds.map((d) => ({
      agentId: d.agentId,
      status: "completed" as const,
      findingsChars: 100,
      savedCount: 2,
      verifiedCount: 1,
      observedCount: 3,
      usage: null,
      error: null,
      startedAt: "2026-09-26T10:00:00.000Z",
      endedAt: "2026-09-26T10:01:00.000Z",
    })),
    exit: null,
  };
}

function promptFor(rounds: SupervisorRound[]): string {
  const input: SupervisorPromptInput = {
    question: "What is the state of small modular reactors?",
    brief: "Brief.",
    draft: null,
    targetLanguage: "English",
    notes: [],
    rounds,
    round: rounds.length + 1,
    maxRounds: 500,
    maxParallel: 3,
    windowMinMinutes: 3,
    windowMaxMinutes: 10,
    elapsedMinutes: 4,
    nowMs: Date.UTC(2026, 8, 26),
    notice: null,
  };
  return buildSupervisorPrompt(input);
}

function previousRoundsOf(prompt: string): string {
  const match = /<Previous Rounds>\n([\s\S]*?)\n<\/Previous Rounds>/.exec(prompt);
  assert.ok(match, "the prompt has a Previous Rounds block");
  return match[1] as string;
}

describe("the Previous Rounds block", () => {
  it("is conservative: sixty thousand characters, three rounds whole", () => {
    assert.equal(ROUNDS_BLOCK_CHAR_BUDGET, 60_000);
    assert.equal(ROUNDS_RECENT_IN_FULL, 3);
    assert.ok(ROUNDS_RECENT_IN_FULL * ROUND_FULL_CHAR_CAP < ROUNDS_BLOCK_CHAR_BUDGET, "the whole rounds alone always fit");
  });

  it("is left exactly as it was while the run is small", () => {
    const rounds = [roundOf(1, 500), roundOf(2, 500)];
    const block = previousRoundsOf(promptFor(rounds));
    assert.ok(block.includes("REFLECTION-1 "));
    assert.ok(block.includes("REFLECTION-2 "));
    assert.equal(block, roundsBlock(rounds));
    assert.equal(roundsBlock([]), "(none yet)");
  });

  it("keeps twelve long rounds within the budget, the recent ones whole and the older ones as digests", () => {
    const rounds = Array.from({ length: 12 }, (_, i) => roundOf(i + 1, 12_000));
    const unbounded = rounds.map((r) => r.reflection.length).reduce((a, b) => a + b, 0);
    assert.ok(unbounded > 140_000, "the unbudgeted block is the size the plan measured");
    const block = previousRoundsOf(promptFor(rounds));
    assert.ok(block.length <= ROUNDS_BLOCK_CHAR_BUDGET, `block is ${block.length} chars`);
    for (const n of [10, 11, 12]) {
      assert.ok(block.includes(`REFLECTION-${n} `), `round ${n} is kept whole`);
    }
    assert.equal(block.includes("REFLECTION-1 "), false, "an old reflection is dropped");
    assert.ok(block.includes("Round 1:"), "an old round still has its line");
    assert.ok(block.includes("Round 1 topic 0"), "and its delegations");
    assert.ok(block.indexOf("Round 9:") < block.indexOf("Round 10:"), "rounds stay in order");
  });

  it("is deterministic", () => {
    const rounds = Array.from({ length: 12 }, (_, i) => roundOf(i + 1, 12_000));
    assert.equal(roundsBlock(rounds), roundsBlock(rounds.map((r) => ({ ...r }))));
  });

  it("stays within the budget for the longest run the engine allows, and says what it left out", () => {
    const rounds = Array.from({ length: 500 }, (_, i) => roundOf(i + 1, 8_000, 12));
    const block = roundsBlock(rounds);
    assert.ok(block.length <= ROUNDS_BLOCK_CHAR_BUDGET, `block is ${block.length} chars`);
    assert.ok(block.includes("REFLECTION-500 "), "the newest round is whole");
    assert.match(block, /omitted/);
    assert.ok(block.includes("Round 499:") && block.includes("Round 498:"));
  });

  it("cuts one enormous round to the cap rather than carrying it", () => {
    const block = roundsBlock([roundOf(1, 400_000)]);
    assert.ok(block.length <= ROUNDS_BLOCK_CHAR_BUDGET);
    assert.ok(block.includes("REFLECTION-1 "));
    assert.match(block, /truncated/);
  });

  it("honours a smaller budget it is given", () => {
    const rounds = Array.from({ length: 12 }, (_, i) => roundOf(i + 1, 2_000));
    const block = roundsBlock(rounds, 6_000);
    assert.ok(block.length <= 6_000, `block is ${block.length} chars`);
    assert.ok(block.includes("Round 12:"));
  });
});

describe("the Previous Rounds block and surrogate pairs", () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const EMOJI = "\u{1F600}";

  it("does not split a pair when a topic is clipped for an older round's digest", () => {
    // The digest keeps 159 units of a topic and an ellipsis; units 158 and 159 are one emoji.
    const rounds = Array.from({ length: 5 }, (_, i) => {
      const round = roundOf(i + 1, 12_000, 2);
      round.delegations = round.delegations.map((d) => ({ ...d, topic: `${"a".repeat(158)}${EMOJI}${EMOJI} tail` }));
      return round;
    });
    const block = roundsBlock(rounds, 40_000);
    assert.ok(block.includes("older round; reflection left out"), "older rounds are digests");
    assert.ok(!LONE_SURROGATE.test(block), "no half of a pair is left in the block");
    assert.ok(block.length <= 40_000);
  });

  it("does not split a pair where the tail of an over-long block is cut", () => {
    for (let budget = 400; budget < 404; budget += 1) {
      const round = roundOf(1, 100, 1);
      round.delegations = round.delegations.map((d) => ({ ...d, topic: EMOJI.repeat(600) }));
      const block = roundsBlock([round], budget);
      assert.ok(block.length <= budget, `budget ${budget}: block is ${block.length} chars`);
      assert.ok(!LONE_SURROGATE.test(block), `budget ${budget}: a half pair was left at the cut`);
    }
  });
});
