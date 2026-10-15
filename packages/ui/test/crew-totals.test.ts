import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityView, costEstimate, crewView, runLive, usageTotal, type RunVM } from "../src/model/crew.js";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { costOf, listedPrice } from "../src/model/pricing.js";
import { turnCost } from "../src/model/usage.js";
import type { ModelOption, SessionSummary, ViewEvent } from "../src/types.js";
import { appState, session, thread } from "./crew-fixtures.js";
import { historyEvents } from "./fixtures/probe.js";
import { NOW, S, SESSION, finishedFeed, lantern, view } from "./fixtures/lantern.js";

/**
 * What a crew total counts. Reasoning is part of the output (Muse's totalTokens is promptTokens + outputTokens), so
 * it is never added on top; a lead turn's total is Muse's counted-once figure; a finished run is priced at the
 * model its launching turn used.
 */

const SPARK = "muse-spark-1.3";
const CONTRIBUTOR = "muse-spark-1.3-contributor";

describe("what a total counts", () => {
  it("adds input and output, and leaves reasoning to the output it is part of", () => {
    assert.equal(usageTotal({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3 }), 15);
    assert.equal(usageTotal({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 500_000 }), 1_000_000);
    assert.equal(usageTotal({ reasoningTokens: 7 }), 0, "reasoning alone is not a count of anything");
    assert.equal(usageTotal(null), 0);
    assert.equal(usageTotal(undefined), 0);
  });

  it("prices the output once: reasoning inside it is not charged a second time", () => {
    // $1.25 per million in and $4.25 per million out, worked by hand.
    assert.equal(costEstimate({ inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 500_000 }, SPARK), 5.5);
    assert.equal(costEstimate({ inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 0 }, SPARK), 5.5);
    assert.equal(costEstimate({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, SPARK), 5.5);
  });

  it("takes the catalog's price over the published table, and the table when the catalog has none", () => {
    const catalog: ModelOption = { modelId: SPARK, displayLabel: SPARK, description: null, isDefault: false, isActive: false, contextLimit: null, outputLimit: null, cost: { input: 2, output: 8, cached: 0.5, currency: "USD" }, contributor: false };
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    assert.equal(costEstimate(usage, SPARK, [catalog]), 10);
    assert.equal(costEstimate(usage, SPARK, [{ ...catalog, cost: null }]), 5.5, "a row without a price falls back to the table");
    assert.equal(costEstimate(usage, SPARK, []), 5.5, "so does a catalog that never loaded");
    assert.equal(costEstimate(usage, "muse-wonder-1.0", []), 24, "Wonder at $4 in and $20 out");
    assert.equal(costEstimate(usage, "muse-wonder-full-1.0", []), null, "Wonder Full has no published price");
  });

  it("gives the same dollars for the same tokens as the turn footer", () => {
    const tokens = { inputTokens: 300_000, outputTokens: 20_000, reasoningTokens: 8_000, cachedTokens: 100_000 };
    const fold = applyEvents(emptyFold(), [
      { method: "session/tokenUsage", params: { sessionId: "s1", turnId: "t1", viewCursor: "v:1", modelId: SPARK, promptTokens: 300_000, totalTokens: 320_000, usage: tokens } },
    ]);
    const crew = costEstimate(tokens, SPARK);
    const turn = turnCost(fold, "t1", []);
    assert.ok(crew !== null && turn !== null);
    assert.equal(turn.cost, crew);
    assert.equal(crew, costOf(listedPrice(SPARK)!, { promptTokens: 300_000, outputTokens: 20_000, cachedTokens: 100_000 }));
  });
});

describe("the lead's own total", () => {
  const T = Date.UTC(2026, 8, 28, 12);
  const started: ViewEvent = { method: "turn/started", at: T, params: { turnId: "turn-1" } };
  const lead = (events: ViewEvent[]): RunVM => {
    const run = crewView(applyEvents(emptyFold(), events), session("thread", "Ordinary prompt", { modelId: SPARK }), T + 5000).runs.find((candidate) => candidate.kind === "turn");
    assert.ok(run, "the ordinary turn is a run");
    return run;
  };

  it("is Muse's counted-once total, not the raw counters, when a provider counts cache beside input", () => {
    const run = lead([
      started,
      { method: "session/tokenUsage", at: T + 1000, params: { sessionId: "thread", turnId: "turn-1", viewCursor: "v:1", modelId: SPARK, promptTokens: 1000, totalTokens: 1100, usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 100 } } },
    ]);
    assert.deepEqual(run.tokens, { total: 1100, reported: 1, of: 1 });
    const row = run.agents[0];
    assert.equal(row?.kind, "lead");
    assert.deepEqual([row?.tokens?.inputTokens, row?.tokens?.cacheReadTokens, row?.tokens?.outputTokens], [100, 900, 100], "the raw counters stay for the breakdown");
  });

  it("does not add reasoning to it", () => {
    const run = lead([
      started,
      { method: "session/tokenUsage", at: T + 1000, params: { sessionId: "thread", turnId: "turn-1", viewCursor: "v:1", promptTokens: 1000, totalTokens: 1200, usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 150 } } },
    ]);
    assert.equal(run.tokens?.total, 1200);
  });

  it("sums the calls of the turn only, from a real capture", () => {
    const fold = applyEvents(emptyFold(), historyEvents);
    const run = crewView(fold, SESSION, T + 5000).runs.find((candidate) => candidate.kind === "turn");
    assert.ok(run);
    const calls = Object.values(fold.meta.calls).filter((call) => call.turnId === run.runId);
    assert.ok(calls.length > 0 && calls.length < Object.keys(fold.meta.calls).length, "an earlier turn's calls are left out");
    assert.equal(run.tokens?.total, calls.reduce((sum, call) => sum + call.promptTokens + call.outputTokens, 0));
    assert.equal(run.tokens?.total, 44_242, "22,069 and 22,173, as the host counted them; the 164 reasoning tokens are inside");
  });
});

describe("a finished run's estimate", () => {
  const modelChanged = (at: number, modelId: string): ViewEvent => ({ method: "session/modelChanged", at, params: { modelId } });
  const launchCall = (modelId: string, cumulative: number, turnId = "t1"): ViewEvent => ({
    method: "session/tokenUsage", at: S(1, cumulative),
    params: { sessionId: "s1", turnId, modelId, promptTokens: 1000, totalTokens: 1100, usage: { inputTokens: 1000, outputTokens: 100 }, cumulative: { promptTokens: cumulative * 1000, outputTokens: cumulative * 100, totalTokens: cumulative * 1100 } },
  });
  const finished = (events: ViewEvent[]): RunVM => view(finishedFeed(), S(50, 0), {}, events).vm.runs[0] as RunVM;
  const running = (events: ViewEvent[]): RunVM => view(lantern(), NOW, {}, events).vm.runs[0] as RunVM;

  // The finished lantern run: 1,211,000 tokens in and 171,000 out, with no cache.
  const AT_SPARK = (1_211_000 * 1.25 + 171_000 * 4.25) / 1_000_000;
  const AT_CONTRIBUTOR = (1_211_000 * 0.1 + 171_000 * 0.2) / 1_000_000;

  it("is priced at the model the launching turn named, so a later switch does not reprice it", () => {
    const before = finished([launchCall(SPARK, 1)]);
    assert.equal(before.cost?.model, SPARK);
    assert.ok(Math.abs((before.cost?.usd ?? 0) - AT_SPARK) < 1e-9);
    const after = finished([launchCall(SPARK, 1), modelChanged(S(46, 0), CONTRIBUTOR)]);
    assert.equal(after.cost?.model, SPARK, "the thread is on the contributor model now, the run was not");
    assert.equal(after.cost?.usd, before.cost?.usd);
    assert.equal(after.priceModel, SPARK);
  });

  it("is priced at the thread's current model when no call of the launching turn names one", () => {
    const run = finished([modelChanged(S(46, 0), CONTRIBUTOR)]);
    assert.equal(run.cost?.model, CONTRIBUTOR);
    assert.ok(Math.abs((run.cost?.usd ?? 0) - AT_CONTRIBUTOR) < 1e-9);
    const other = finished([launchCall(SPARK, 1, "t9"), modelChanged(S(46, 0), CONTRIBUTOR)]);
    assert.equal(other.cost?.model, CONTRIBUTOR, "a call of another turn says nothing about this run");
  });

  it("falls back to the current model when the launching turn's calls disagree", () => {
    const run = finished([launchCall(SPARK, 1), launchCall("muse-spark-1.2", 2), modelChanged(S(46, 0), CONTRIBUTOR)]);
    assert.equal(run.cost?.model, CONTRIBUTOR);
  });

  it("follows the current model while the run is still going", () => {
    const events = [launchCall(SPARK, 1), modelChanged(S(41, 0), CONTRIBUTOR)];
    const run = running(events);
    assert.ok(runLive(run));
    assert.equal(run.cost?.model, CONTRIBUTOR);
    // The running lantern run: 1,053,100 tokens in and 147,400 out.
    assert.ok(Math.abs((run.cost?.usd ?? 0) - (1_053_100 * 0.1 + 147_400 * 0.2) / 1_000_000) < 1e-9);
  });

  it("does not depend on which session summary the view is built with", () => {
    // The panel, the drawer and the transcript row each hold a summary of their own; none of them may move the price.
    const { fold } = view(finishedFeed(), S(50, 0), {}, [launchCall(SPARK, 1), modelChanged(S(46, 0), CONTRIBUTOR)]);
    const priced = (summary: SessionSummary | null): RunVM => crewView(fold, summary, S(50, 0)).runs[0] as RunVM;
    const reference = priced(null);
    assert.equal(reference.cost?.model, SPARK);
    for (const modelId of ["muse-spark-1.1", CONTRIBUTOR, null]) {
      const run = priced({ ...SESSION, modelId });
      assert.equal(run.cost?.model, reference.cost?.model);
      assert.equal(run.cost?.usd, reference.cost?.usd);
    }
  });
});

describe("the Activity drawer's token footer", () => {
  const T = Date.UTC(2026, 8, 28, 12);
  const call = (turnId: string, cumulative: number): ViewEvent => ({
    method: "session/tokenUsage", at: T + cumulative,
    params: { sessionId: "s1", turnId, viewCursor: `v:${cumulative}`, promptTokens: 1000, totalTokens: 1100, usage: { inputTokens: 1000, outputTokens: 100 }, cumulative: { promptTokens: cumulative, outputTokens: cumulative / 10, totalTokens: cumulative * 1.1 } },
  });

  it("counts the runs the drawer holds, which for an ordinary prompt is its latest turn, and says so", () => {
    const events: ViewEvent[] = [
      { method: "turn/started", at: T, params: { turnId: "t1" } }, call("t1", 1000),
      { method: "turn/completed", at: T + 2000, params: { turnId: "t1", terminal: "completed" } },
      { method: "turn/started", at: T + 3000, params: { turnId: "t2" } }, call("t2", 2000),
    ];
    const state = appState({ route: { kind: "thread", sessionId: "s1" }, sessions: { s1: session("s1", "Two turns", { modelId: SPARK }) }, threads: { s1: thread(applyEvents(emptyFold(), events)) } });
    const foot = activityView(state, T + 4000).foot;
    // Both turns spent 1,100 tokens, so the thread used 2.2k; the drawer only holds the latest turn's run.
    assert.equal(foot, "1 running in 1 thread · 1.1k tokens in current runs");
    assert.doesNotMatch(foot, /today/);
  });
});
