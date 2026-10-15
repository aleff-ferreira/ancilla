import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelList } from "../src/client.js";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { formatElapsed, formatSpeed } from "../src/model/format.js";
import { costOf, listedPrice, NO_PRICE_REASON } from "../src/model/pricing.js";
import {
  contextBreakdown,
  contextUsageOf,
  ESTIMATED_PRESSURE,
  isPartialHistory,
  isUnrecordedModel,
  lastTurnSpeed,
  loadedSince,
  sessionUsage,
  speedCalls,
  streamingSpeed,
  turnCost,
  turnSpeed,
  turnSpeeds,
  turnsCost,
} from "../src/model/usage.js";
import {
  atLeast,
  breakdownNote,
  contextCostValue,
  contextMeterView,
  contextTokenRows,
  contextTone,
  costIsFloor,
  costLabel,
  costNotes,
  costRows,
  costTip,
  costTitle,
  goalCostTip,
  goalCostValue,
  goalTokensTip,
  goalTokensValue,
  LOADED_ONLY,
  LOWER_BOUND,
  modelRateCaption,
  NO_MODEL_REASON,
  noPriceReason,
  NO_VALUE,
  pressureNote,
  segmentBarLabel,
  share,
  subagentLine,
  SUBAGENT_CAPTION,
  turnCostLabel,
  turnCostTip,
  unpricedNote,
  unpricedWhy,
  usageCostLabel,
} from "../src/model/usage-labels.js";
import { costEstimate } from "../src/model/crew.js";
import type { ModelOption, ViewEvent } from "../src/types.js";
import { historyEvents, liveEvents, modelList } from "./fixtures/probe.js";

function tokenUsage(cursor: string, params: Record<string, unknown>): ViewEvent {
  return { method: "session/tokenUsage", params: { sessionId: "s1", turnId: "t1", viewCursor: cursor, ...params } };
}

const PRICED: ModelOption = {
  modelId: "priced",
  displayLabel: "priced",
  description: null,
  isDefault: false,
  isActive: false,
  contextLimit: 1_000_000,
  outputLimit: null,
  cost: { input: 2, output: 8, cached: 0.5, currency: "USD" },
  contributor: false,
};

describe("context and session usage", () => {
  it("splits the reported context without inventing or losing tokens", () => {
    const fold = applyEvents(emptyFold(), liveEvents);
    const breakdown = contextBreakdown(fold, []);
    assert.ok(breakdown);
    const total = breakdown.slices.reduce((sum, slice) => sum + slice.tokens, 0);
    assert.equal(total, breakdown.used);
    assert.equal(breakdown.free, (breakdown.window ?? 0) - breakdown.used);
    assert.ok(breakdown.slices.some((slice) => slice.key === "prompts"));
  });

  it("reads the context of a thread opened from history off its last model call", () => {
    const fold = applyEvents(emptyFold(), historyEvents);
    assert.equal(fold.meta.contextUsage, null);
    const usage = contextUsageOf(fold, parseModelList(modelList));
    const last = Object.values(fold.meta.calls).at(-1);
    assert.ok(usage && last);
    assert.equal(usage.usedTokens, last.promptTokens + last.outputTokens);
    assert.equal(usage.windowTokens, 1007997);
  });

  it("counts every model call once, even when history is applied twice", () => {
    const once = applyEvents(emptyFold(), historyEvents);
    const twice = applyEvents(once, historyEvents);
    const calls = historyEvents.filter((event) => event.method === "session/tokenUsage").length;
    assert.equal(sessionUsage(once, []).calls, calls);
    assert.equal(sessionUsage(twice, []).calls, calls);
    assert.equal(sessionUsage(once, []).totalTokens, once.meta.tokenTotals?.totalTokens);
  });

  it("prices calls from the catalog and flags calls it could not price", () => {
    const fold = applyEvents(emptyFold(), [
      tokenUsage("v:1", {
        modelId: "priced",
        promptTokens: 1_000_000,
        totalTokens: 1_100_000,
        usage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 400_000, reasoningTokens: 0 },
      }),
    ]);
    const priced = sessionUsage(fold, [PRICED]);
    // 600k fresh at $2, 400k cached at $0.50 and 100k out at $8, per million.
    assert.equal(priced.cost?.toFixed(2), "2.20");
    assert.equal(priced.costComplete, true);
    assert.equal(Math.round((priced.cacheHit ?? 0) * 100), 40);
    assert.equal(sessionUsage(fold, []).cost, null);

    const mixed = applyEvents(fold, [tokenUsage("v:2", { modelId: "free", promptTokens: 10, totalTokens: 12, usage: { outputTokens: 2 } })]);
    assert.equal(sessionUsage(mixed, [PRICED]).costComplete, false);
  });

  it("measures a turn's output speed over its model calls, ignoring tiny calls", () => {
    const fold = applyEvents(emptyFold(), [
      tokenUsage("v:1", { turnId: "t1", promptTokens: 100, totalTokens: 400, durationMs: 3500, usage: { outputTokens: 300 } }),
      { method: "turn/completed", params: { turnId: "t1", terminal: "completed", timeToFirstTokenMs: 500 } },
      tokenUsage("v:2", { turnId: "t2", promptTokens: 100, totalTokens: 105, durationMs: 1000, usage: { outputTokens: 5 } }),
      tokenUsage("v:3", { turnId: "t2", promptTokens: 100, totalTokens: 300, durationMs: 4000, usage: { outputTokens: 200 } }),
      { method: "turn/completed", params: { turnId: "t2", terminal: "completed", timeToFirstTokenMs: 800 } },
    ]);
    // 300 tokens over the call's 3.5 s; the turn-level first-token time is not taken off.
    assert.equal(Math.round(turnSpeed(fold, "t1")?.tokensPerSecond ?? 0), 86);
    // The 5-token call is too small to count, so only the 200 tokens over 4 s remain.
    assert.equal(Math.round(turnSpeed(fold, "t2")?.tokensPerSecond ?? 0), 50);
    assert.equal(Math.round(lastTurnSpeed(fold)?.tokensPerSecond ?? 0), 50);
    assert.deepEqual(Object.keys(turnSpeeds(fold)).sort(), ["t1", "t2"]);
    assert.equal(formatSpeed(42.4), "42 tok/s");
    assert.equal(formatSpeed(7.25), "7.3 tok/s");
    assert.deepEqual([formatElapsed(42_000), formatElapsed(7 * 60_000), formatElapsed(67 * 60_000)], ["42s", "7m", "1h 7m"]);
  });

  it("estimates live speed per burst of streamed text", () => {
    const delta = (at: number, text: string, field = "text"): ViewEvent => ({
      method: "item/delta",
      params: { itemId: "a1", turnId: "t1", field, delta: text },
      at,
    });
    let fold = applyEvents(emptyFold(), [{ method: "turn/started", params: { turnId: "t1" }, at: 0 }, delta(1000, "x".repeat(400)), delta(3000, "x".repeat(400))]);
    // 800 characters is about 200 tokens, over two seconds.
    assert.equal(Math.round(streamingSpeed(fold.turns["t1"]) ?? 0), 100);
    fold = applyEvents(fold, [delta(9000, "x".repeat(40)), delta(9500, "tool text", "output")]);
    assert.equal(fold.turns["t1"]?.stream?.chars, 40, "a long pause starts a new burst, and tool output is not model text");
  });

  it("only counts what is left in context after a compaction", () => {
    const events: ViewEvent[] = [
      { method: "item/completed", params: { item: { itemId: "u1", kind: "userMessage", status: "completed", revision: 1, text: "x".repeat(4000) } } },
      {
        method: "item/completed",
        params: { item: { itemId: "c1", kind: "compaction", status: "completed", revision: 1, outcome: "compacted", trigger: "manual", tokensBefore: 5000, tokensAfter: 300 } },
      },
      { method: "item/completed", params: { item: { itemId: "u2", kind: "userMessage", status: "completed", revision: 1, text: "y".repeat(400) } } },
      { method: "session/contextUsage", params: { usedTokens: 2000, windowTokens: 10_000, pressure: "normal" } },
    ];
    const fold = applyEvents(emptyFold(), events);
    const breakdown = contextBreakdown(fold, []);
    assert.equal(breakdown?.slices.find((slice) => slice.key === "prompts")?.tokens, 100);
    assert.equal(breakdown?.slices.find((slice) => slice.key === "summary")?.tokens, 300);
    assert.equal(breakdown?.slices.find((slice) => slice.key === "system")?.tokens, 1600);
    assert.deepEqual(sessionUsage(fold, []).compactions, [{ itemId: "c1", trigger: "manual", outcome: "compacted", before: 5000, after: 300 }]);
  });
});

function item(fields: Record<string, unknown>): ViewEvent {
  return { method: "item/completed", params: { item: { status: "completed", revision: 1, ...fields } } };
}

/** Calls as Muse sends them: the prompt count, and a usage block that may fill either cache counter, or both. */
function foldOfCalls(calls: Record<string, unknown>[]) {
  return applyEvents(emptyFold(), calls.map((params, index) => tokenUsage(`v:${index}`, params)));
}

describe("cache rows", () => {
  it("counts a cache read once when Muse fills both counters with it", () => {
    const usage = sessionUsage(foldOfCalls([{ promptTokens: 29862, usage: { outputTokens: 2504, cachedTokens: 21105, cacheReadTokens: 21105 } }]), []);
    assert.equal(usage.freshTokens, 8757);
    assert.equal(usage.cachedReadTokens, 21105);
  });

  it("does not read a heavily cached thread as zero input", () => {
    const usage = sessionUsage(
      foldOfCalls([
        { promptTokens: 1000, usage: { outputTokens: 10, cachedTokens: 990, cacheReadTokens: 990 } },
        { promptTokens: 1000, usage: { outputTokens: 10, cachedTokens: 990, cacheReadTokens: 990 } },
      ]),
      [],
    );
    assert.equal(usage.freshTokens, 20);
    assert.equal(usage.cachedReadTokens, 1980);
  });

  it("counts a call that fills only one of the counters, whichever it is", () => {
    const usage = sessionUsage(
      foldOfCalls([
        { promptTokens: 1000, usage: { outputTokens: 10, cachedTokens: 500 } },
        { promptTokens: 1000, usage: { outputTokens: 10, cacheReadTokens: 500 } },
      ]),
      [],
    );
    assert.equal(usage.cachedReadTokens, 1000);
    assert.equal(usage.freshTokens, 1000);
  });

  it("clamps one call's cache reads to its own prompt instead of the sum", () => {
    const usage = sessionUsage(
      foldOfCalls([
        { promptTokens: 100, usage: { outputTokens: 10, cacheReadTokens: 500 } },
        { promptTokens: 1000, usage: { outputTokens: 10 } },
      ]),
      [],
    );
    assert.equal(usage.cachedReadTokens, 100);
    assert.equal(usage.freshTokens, 1000);
  });

  it("makes fresh and cached input add up to the loaded prompt on a real thread", () => {
    const usage = sessionUsage(applyEvents(emptyFold(), historyEvents), []);
    assert.equal(usage.freshTokens + usage.cachedReadTokens, usage.loadedPromptTokens);
    assert.equal(usage.cachedReadTokens, 21745);
    assert.equal(usage.freshTokens, 86143);
  });
});

describe("partial history", () => {
  const models = parseModelList(modelList);
  const whole = () => applyEvents(emptyFold(), historyEvents);
  const tail = () => applyEvents(emptyFold(), historyEvents.slice(-12));

  it("sees a loaded tail as partial from Muse's cumulative totals alone", () => {
    const full = sessionUsage(whole(), models);
    const cut = sessionUsage(tail(), models);
    assert.equal(full.partial, false);
    assert.equal(full.totalsComplete, true);
    assert.equal(cut.partial, true);
    assert.equal(cut.totalsComplete, true, "Muse's totals still cover the whole session");
    assert.equal(cut.costComplete, full.costComplete, "partial history is not an unpriced call");
    assert.ok(cut.cost !== null && full.cost !== null && cut.cost < full.cost, "the loaded calls cost less than the thread did");
    assert.equal(cut.promptTokens, full.promptTokens);
    assert.ok(cut.loadedPromptTokens < cut.promptTokens);
  });

  it("is partial when the history was truncated, and then the totals are a floor", () => {
    const fold = foldOfCalls([{ promptTokens: 1000, usage: { outputTokens: 100 } }]);
    assert.equal(sessionUsage(fold, []).partial, false);
    const cut = sessionUsage(fold, [], true);
    assert.equal(cut.partial, true);
    assert.equal(cut.totalsComplete, false);
  });

  it("applies one rule: truncated, or cumulative totals above what the loaded calls add up to", () => {
    const fold = emptyFold();
    assert.equal(isPartialHistory(fold, 10, 10, false), false, "no totals and not truncated");
    assert.equal(isPartialHistory(fold, 10, 10, true), true);
    fold.meta.tokenTotals = { promptTokens: 100, outputTokens: 10, totalTokens: 110 };
    assert.equal(isPartialHistory(fold, 100, 10, false), false);
    assert.equal(isPartialHistory(fold, 99, 10, false), true);
    assert.equal(isPartialHistory(fold, 100, 9, false), true);
  });

  it("labels a cost as exact, short of a price, or short of the thread", () => {
    assert.equal(costLabel(1.5, true, false), "$1.50");
    assert.equal(costLabel(1.5, false, false), "≥ $1.50", "an unpriced call makes it a floor, written like every other floor");
    assert.equal(costLabel(1.5, true, true), "≥ $1.50");
    assert.equal(costLabel(1.5, false, true), "≥ $1.50", "a floor for either reason reads as a floor");
    assert.equal(costLabel(1.5, true, false, "EUR"), "EUR 1.50");
    assert.equal(costLabel(1.5, false, false, "EUR"), "≥ EUR 1.50");
    const full = sessionUsage(whole(), models);
    assert.equal(usageCostLabel(full)?.startsWith("≥"), false);
    assert.equal(usageCostLabel(sessionUsage(tail(), models))?.startsWith("≥"), true);
    assert.equal(usageCostLabel(sessionUsage(foldOfCalls([{ promptTokens: 1, usage: { outputTokens: 1 } }]), [])), null);
  });

  it("says in the cost popover that earlier turns are missing, and relabels the call rows", () => {
    const cut = sessionUsage(tail(), models);
    assert.ok(costNotes(cut).includes("Covers the loaded calls only; earlier turns are not shown."));
    const labels = (rows: { label: string }[]) => rows.map((row) => row.label).filter((label) => !/reasoning/i.test(label));
    assert.deepEqual(labels(costRows(cut)), ["Loaded uncached input", "Loaded cached input", "Loaded output", "Loaded model calls"]);
    const full = sessionUsage(whole(), models);
    assert.equal(costNotes(full).length, 1);
    // The Context panel's own Input counts the whole prompt, so this row says what it leaves out.
    assert.deepEqual(labels(costRows(full)), ["Uncached input", "Cached input", "Output", "Model calls"]);
    assert.match(costTip(cut), /Loaded calls only/);
  });

  it("keeps the context panel's token rows on one scope and says which", () => {
    const labels = (rows: { label: string }[]) => rows.map((row) => row.label).filter((label) => !/reasoning/i.test(label));
    const cut = contextTokenRows(sessionUsage(tail(), models));
    assert.deepEqual(labels(cut.rows), ["Loaded input", "Loaded output", "Loaded cache read", "Loaded cache write", "Total"]);
    assert.equal(cut.rows.find((row) => row.id === "total")?.hint, "Whole session");
    assert.match(cut.note ?? "", /Earlier turns are not loaded/);
    const floor = contextTokenRows(sessionUsage(foldOfCalls([{ promptTokens: 1000, usage: { outputTokens: 100 } }]), [], true));
    assert.equal(floor.rows.find((row) => row.id === "total")?.value, "≥1.1k");
    const complete = contextTokenRows(sessionUsage(whole(), models));
    assert.deepEqual(labels(complete.rows), ["Input", "Output", "Cache read", "Cache write", "Total"]);
    assert.equal(complete.note, null);
  });
});

describe("thread prices", () => {
  /** A million-token call, 400k of it cached, with a hundred thousand tokens out. */
  const spend = (modelId: string) =>
    foldOfCalls([{ modelId, promptTokens: 1_000_000, totalTokens: 1_100_000, usage: { outputTokens: 100_000, cachedTokens: 400_000, cacheReadTokens: 400_000 } }]);
  const tokens = { promptTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 400_000 };

  it("prices from the published table when the catalog is empty", () => {
    const usage = sessionUsage(spend("muse-spark-1.3"), []);
    const price = listedPrice("muse-spark-1.3");
    assert.ok(price);
    assert.equal(usage.costComplete, true);
    assert.equal(usage.cost, costOf(price, tokens));
    assert.ok(Math.abs((usage.cost ?? 0) - 1.235) < 1e-9);
    assert.equal(turnCost(spend("muse-spark-1.3"), "t1", [])?.cost, usage.cost, "the turn footer prices the same call the same way");
  });

  it("keeps the contributor tier on its own rates", () => {
    const usage = sessionUsage(spend("muse-spark-1.3-contributor"), []);
    assert.ok(Math.abs((usage.cost ?? 0) - 0.0808) < 1e-9);
  });

  it("prices Muse Wonder 1.0 at Meta's rates and leaves Wonder Full unpriced", () => {
    const wonder = sessionUsage(spend("muse-wonder-1.0"), []);
    assert.ok(Math.abs((wonder.cost ?? 0) - 4.48) < 1e-9);
    assert.equal(wonder.costComplete, true);
    const full = sessionUsage(spend("muse-wonder-full-1.0"), []);
    assert.equal(full.cost, null);
    assert.equal(full.costComplete, false);
    assert.equal(turnCost(spend("muse-wonder-full-1.0"), "t1", [])?.complete, false);
    assert.match(costTip({ ...full, cost: 1 }), new RegExp(NO_PRICE_REASON));
  });

  it("lets a catalog price win over the table", () => {
    const catalog: ModelOption = { ...PRICED, modelId: "muse-spark-1.3", cost: { input: 10, output: 20, cached: 1, currency: "USD" } };
    assert.ok(Math.abs((sessionUsage(spend("muse-spark-1.3"), [catalog]).cost ?? 0) - 8.4) < 1e-9);
  });

  it("gives the same dollars on the turn footer, the cost chip and the run card", () => {
    const fold = spend("muse-spark-1.3");
    const dollars = sessionUsage(fold, []).cost;
    assert.equal(turnCost(fold, "t1", [])?.cost, dollars);
    assert.equal(costEstimate({ inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 400_000 }, "muse-spark-1.3"), dollars);
  });

  it("prices a goal's turns together and says when turns are not loaded", () => {
    const fold = foldOfCalls([
      { turnId: "t1", modelId: "priced", promptTokens: 1000, usage: { outputTokens: 100 } },
      { turnId: "t2", modelId: "priced", promptTokens: 1000, usage: { outputTokens: 100 } },
    ]);
    const both = turnsCost(fold, ["t1", "t2"], [PRICED]);
    assert.ok(both);
    assert.ok(Math.abs(both.cost - 0.0056) < 1e-9);
    assert.equal(goalCostValue(both), "$0.0056");
    assert.equal(turnsCost(fold, ["t3"], [PRICED]), null);
    assert.equal(goalCostValue(null), "Not known");
    const missing = turnsCost(fold, ["t1", "t3"], [PRICED], true);
    assert.equal(missing?.partial, true);
    assert.equal(goalCostValue(missing), "≥ $0.0028");
    assert.match(goalCostTip(missing), /Earlier turns of this goal are not loaded/);
    assert.equal(turnsCost(fold, ["t1", "t3"], [PRICED], false)?.partial, false, "a turn with no call is only missing history on a truncated thread");
    // Truncated history alone is not a floor: every turn of the goal has its calls, so nothing of it is missing.
    const loaded = turnsCost(fold, ["t1", "t2"], [PRICED], true);
    assert.equal(loaded?.partial, false);
    assert.equal(goalCostValue(loaded), "$0.0056");
    assert.doesNotMatch(goalCostTip(loaded), /Earlier turns of this goal are not loaded/);
    const unpriced = turnsCost(fold, ["t1"], []);
    assert.equal(unpriced?.complete, false);
    assert.match(goalCostTip(unpriced), new RegExp(NO_PRICE_REASON));
  });
});

describe("context fallback", () => {
  const modelTurn = (promptTokens: number, outputTokens: number, turnId = "t1") =>
    tokenUsage(`v:${turnId}`, { turnId, modelId: "priced", promptTokens, totalTokens: promptTokens + outputTokens, usage: { outputTokens } });
  const compaction = (outcome: string, extra: Record<string, unknown> = {}) =>
    item({ itemId: "c1", kind: "compaction", outcome, trigger: "manual", tokensBefore: 900_100, tokensAfter: 300, ...extra });

  it("does not call a full window plenty of room", () => {
    const fold = applyEvents(emptyFold(), [modelTurn(999_000, 1_000)]);
    const usage = contextUsageOf(fold, [PRICED]);
    assert.ok(usage);
    assert.deepEqual(usage, { usedTokens: 1_000_000, windowTokens: 1_000_000, pressure: "unknown" });
    assert.equal(contextTone(usage), "danger");
    assert.equal(contextMeterView(usage).tone, "danger");
    assert.equal(pressureNote(usage.pressure).text, "Estimated from the last call", "the words stay neutral; only the ring is toned");
  });

  it("derives the ring's tone from how full an estimate is, never from Muse's word", () => {
    const estimate = (used: number) => contextTone({ usedTokens: used, windowTokens: 1_000_000, pressure: "unknown" });
    assert.equal(estimate(849_999), "normal");
    assert.equal(estimate(850_000), "warn");
    assert.equal(estimate(979_999), "warn");
    assert.equal(estimate(980_000), "danger");
    assert.equal(contextTone({ usedTokens: 1_000_000, windowTokens: 1_000_000, pressure: "normal" }), "normal", "Muse said normal");
    assert.equal(contextTone({ usedTokens: 1, windowTokens: 1_000_000, pressure: "warning" }), "warn");
    assert.equal(contextTone({ usedTokens: 1, windowTokens: 1_000_000, pressure: "blocked" }), "danger");
    assert.equal(contextTone({ usedTokens: 5, pressure: "unknown" }), "normal", "no window, no tone to derive");
  });

  it("reads what is left after a compaction that came after the last call", () => {
    const fold = applyEvents(emptyFold(), [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
      modelTurn(900_000, 100),
      item({ itemId: "a1", kind: "agentMessage", turnId: "t1", text: "done" }),
      compaction("compacted"),
    ]);
    assert.equal(contextUsageOf(fold, [PRICED])?.usedTokens, 300);
  });

  it("ignores a compaction that did not install, and one the last call already followed", () => {
    const skipped = applyEvents(emptyFold(), [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
      modelTurn(900_000, 100),
      compaction("skipped"),
    ]);
    assert.equal(contextUsageOf(skipped, [PRICED])?.usedTokens, 900_100);
    const before = applyEvents(emptyFold(), [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
      modelTurn(900_000, 100),
      compaction("compacted"),
      item({ itemId: "u2", kind: "userMessage", turnId: "t2", text: "again" }),
      modelTurn(4_000, 100, "t2"),
    ]);
    assert.equal(contextUsageOf(before, [PRICED])?.usedTokens, 4_100);
    const midTurn = applyEvents(emptyFold(), [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
      compaction("compacted", { turnId: "t1" }),
      modelTurn(5_000, 50),
      item({ itemId: "a1", kind: "agentMessage", turnId: "t1", text: "done" }),
    ]);
    assert.equal(contextUsageOf(midTurn, [PRICED])?.usedTokens, 5_050, "the call ran on the compacted context");
  });

  it("cannot place a compaction against a call that names no turn, so it keeps the call's own count", () => {
    const fold = applyEvents(emptyFold(), [
      tokenUsage("v:1", { turnId: null, modelId: "priced", promptTokens: 900_000, usage: { outputTokens: 100 } }),
      compaction("compacted"),
    ]);
    assert.equal(Object.values(fold.meta.calls)[0]?.turnId, null);
    assert.equal(contextUsageOf(fold, [PRICED])?.usedTokens, 900_100);
  });

  it("keeps the used tokens when the model is not in the catalog", () => {
    const usage = contextUsageOf(applyEvents(emptyFold(), [modelTurn(100, 10)]), []);
    assert.equal(usage?.usedTokens, 110);
    assert.equal(usage?.windowTokens, undefined);
    assert.equal(usage?.pressure, "unknown");
  });

  it("keeps the ring and its panel when the window is not known", () => {
    const view = contextMeterView({ usedTokens: 5_000, pressure: "normal" });
    assert.equal(view.fill, null);
    assert.equal(view.text, "5k", "the used tokens, with no percentage");
    assert.match(view.tip, /window size is not known/);
    const sized = contextMeterView({ usedTokens: 250_000, windowTokens: 1_000_000, pressure: "normal" });
    assert.equal(sized.fill, 0.25);
    assert.equal(sized.text, "25%");
    assert.equal(sized.tip, "250k of 1M tokens in context");
    assert.equal(contextMeterView({ usedTokens: 1, windowTokens: 1_000_000, pressure: "normal" }).text, "<1%");
    assert.match(contextMeterView({ usedTokens: 1, windowTokens: 100, pressure: "unknown" }).tip, /estimated from the last call/);
  });

  it("never fills a live reading's missing window from the catalog", () => {
    const fold = applyEvents(emptyFold(), [{ method: "session/contextUsage", params: { usedTokens: 5_000 } }, modelTurn(100, 10)]);
    const usage = contextUsageOf(fold, [PRICED]);
    assert.equal(usage?.usedTokens, 5_000);
    assert.equal(usage?.windowTokens, undefined);
    assert.equal(usage?.pressure, "normal");
  });

  it("says in plain words what Muse reported", () => {
    assert.deepEqual(pressureNote("blocked"), { text: "Full. Compact the session to continue.", tone: "danger" });
    assert.deepEqual(pressureNote("warning"), { text: "Filling up", tone: "warn" });
    assert.deepEqual(pressureNote("normal"), { text: "Plenty of room", tone: "muted" });
  });
});

describe("subagent and workflow spend", () => {
  const call = tokenUsage("v:1", { modelId: "priced", promptTokens: 100, totalTokens: 200, usage: { outputTokens: 100 } });
  const subagent = item({ itemId: "s1", kind: "subagent", role: "explorer", usage: { inputTokens: 500_000, outputTokens: 20_000 } });
  const revision = (n: number, status: string, children: unknown[]): ViewEvent => ({
    method: "item/updated",
    params: { item: { itemId: "w1", kind: "workflow", status, revision: n, children } },
  });

  it("keeps their tokens out of the cost and the totals, and says so", () => {
    const usage = sessionUsage(applyEvents(emptyFold(), [call, subagent]), [PRICED]);
    assert.equal(usage.cost, (100 * 2 + 100 * 8) / 1_000_000, "the lead agent's call only");
    assert.equal(usage.totalTokens, 200);
    assert.equal(usage.subagentTokens, 520_000);
    assert.equal(usage.excludesSubagents, true);
    assert.equal(usageCostLabel(usage), "≥ $0.0010", "a cost that leaves agents out is a floor");
    assert.match(costTip(usage), /Workflow agents and subagents are not in it/);
    assert.ok(costNotes(usage).includes("This thread's cost covers the lead agent only; workflow agents and subagents are in the run card."));
    assert.equal(subagentLine(usage.subagentTokens), "Subagents and workflow agents, not priced: 520k tokens");
  });

  it("does not mark a thread that has no agent usage", () => {
    const usage = sessionUsage(applyEvents(emptyFold(), [call, item({ itemId: "s2", kind: "subagent", role: "explorer" })]), [PRICED]);
    assert.equal(usage.excludesSubagents, false);
    assert.equal(usage.subagentTokens, 0);
    assert.equal(usageCostLabel(usage), "$0.0010");
    assert.equal(costNotes(usage).length, 1);
  });

  it("counts a workflow agent's newest report, from the item or from what the fold latched", () => {
    const fold = applyEvents(emptyFold(), [
      call,
      revision(1, "inProgress", [
        { childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 1000, outputTokens: 500 } },
        { childId: "b", attempt: 1, status: "usage", usage: { inputTokens: 200, outputTokens: 100 } },
      ]),
      // Muse leaves the usage off every later revision; a retry reports again.
      revision(2, "completed", [
        { childId: "a", attempt: 1, status: "completed" },
        { childId: "a", attempt: 2, status: "usage", usage: { inputTokens: 2000, outputTokens: 100 } },
        { childId: "b", attempt: 1, status: "completed" },
      ]),
    ]);
    const usage = sessionUsage(fold, [PRICED]);
    assert.equal(usage.subagentTokens, 2100 + 300, "agent a's retry replaces its first attempt, agent b is read from the trace");
    assert.equal(usage.excludesSubagents, true);
    assert.equal(usage.totalTokens, 200);
  });

  it("keeps the newest attempt of an agent even when its older attempt is read first", () => {
    // The item's own children are read before the fold's latched traces: here the item holds attempt 1's usage and
    // only the trace of the first revision holds attempt 2's, so reading order alone would keep the older one.
    const fold = applyEvents(emptyFold(), [
      call,
      revision(1, "inProgress", [{ childId: "a", attempt: 2, status: "usage", usage: { inputTokens: 2000, outputTokens: 100 } }]),
      revision(2, "completed", [
        { childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 1000, outputTokens: 500 } },
        { childId: "a", attempt: 2, status: "completed" },
      ]),
    ]);
    assert.equal(sessionUsage(fold, [PRICED]).subagentTokens, 2100);
  });

  it("does not mark a workflow whose agents report no usage", () => {
    const fold = applyEvents(emptyFold(), [
      call,
      revision(1, "completed", [
        { childId: "a", attempt: 1, status: "completed" },
        { childId: "b", attempt: 1, status: "completed" },
      ]),
    ]);
    const usage = sessionUsage(fold, [PRICED]);
    assert.equal(usage.excludesSubagents, false);
    assert.equal(usage.subagentTokens, 0);
    assert.equal(usageCostLabel(usage), "$0.0010", "nothing is left out, so the cost is not a floor");
  });
});

describe("speed calls", () => {
  it("keeps the calls with a measured time above zero and more than ten tokens", () => {
    const fold = foldOfCalls([
      { promptTokens: 10, durationMs: 3000, usage: { outputTokens: 300 } },
      { promptTokens: 10, durationMs: 0, usage: { outputTokens: 500 } },
      { promptTokens: 10, durationMs: 1000, usage: { outputTokens: 10 } },
      { promptTokens: 10, usage: { outputTokens: 500 } },
    ]);
    assert.deepEqual(speedCalls(Object.values(fold.meta.calls)).map((c) => c.outputTokens), [300]);
  });
});

describe("a goal that began before the loaded window", () => {
  const at = (iso: string) => Date.parse(iso);
  const loaded = () =>
    applyEvents(emptyFold(), [
      item({ itemId: "u2", kind: "userMessage", turnId: "t2", text: "go", recordedAt: "2026-09-28T10:00:00.000Z" }),
      tokenUsage("v:2", { turnId: "t2", modelId: "priced", promptTokens: 1000, usage: { outputTokens: 100 } }),
      item({ itemId: "u3", kind: "userMessage", turnId: "t3", text: "more", recordedAt: "2026-09-28T11:00:00.000Z" }),
      tokenUsage("v:3", { turnId: "t3", modelId: "priced", promptTokens: 1000, usage: { outputTokens: 100 } }),
    ]);
  const turns = ["t2", "t3"];

  it("finds the first thing that was loaded, from items and turn starts", () => {
    assert.equal(loadedSince(loaded()), at("2026-09-28T10:00:00.000Z"));
    assert.equal(loadedSince(emptyFold()), null);
    assert.equal(loadedSince(foldOfCalls([{ promptTokens: 1, usage: { outputTokens: 1 } }])), null, "nothing dated");
    const started = applyEvents(loaded(), [{ method: "turn/started", params: { turnId: "t4" }, at: at("2026-09-28T09:30:00.000Z") }]);
    assert.equal(loadedSince(started), at("2026-09-28T09:30:00.000Z"));
  });

  it("is a floor when a truncated history starts after the goal did, though every loaded turn has its calls", () => {
    const early = at("2026-09-28T09:00:00.000Z");
    const cut = turnsCost(loaded(), turns, [PRICED], true, early);
    assert.equal(cut?.partial, true);
    assert.equal(goalCostValue(cut), "≥ $0.0056");
    assert.match(goalCostTip(cut), /Earlier turns of this goal are not loaded/);
    assert.equal(turnsCost(loaded(), turns, [PRICED], false, early)?.partial, false, "the whole history is loaded, so the first loaded turn is the first turn");
  });

  it("is not a floor when the goal began inside the loaded window or its start is unknown", () => {
    assert.equal(turnsCost(loaded(), turns, [PRICED], true, at("2026-09-28T10:00:00.000Z"))?.partial, false);
    assert.equal(turnsCost(loaded(), turns, [PRICED], true, at("2026-09-28T10:30:00.000Z"))?.partial, false);
    assert.equal(turnsCost(loaded(), turns, [PRICED], true, null)?.partial, false);
    // Nothing loaded is dated, so there is nothing to compare the goal's start with.
    const undated = foldOfCalls([{ turnId: "t1", modelId: "priced", promptTokens: 1000, usage: { outputTokens: 100 } }]);
    assert.equal(turnsCost(undated, ["t1"], [PRICED], true, 0)?.partial, false);
  });

  it("marks the goal's tokens in the same cases", () => {
    assert.equal(goalTokensValue(12_000, 50_000, true), "≥ 12k of 50k");
    assert.equal(goalTokensValue(12_000, null, true), "≥ 12k");
    assert.equal(goalTokensValue(12_000, 50_000, false), "12k of 50k");
    assert.equal(goalTokensValue(12_000, null, false), "12k");
    assert.match(goalTokensTip(true, null), /Earlier turns of this goal are not loaded/);
    assert.doesNotMatch(goalTokensTip(false, null), /not loaded/);
    assert.match(goalTokensTip(false, 4_500), /Muse's own count at its last goal update: 4\.5k\./);
    assert.doesNotMatch(goalTokensTip(false, 0), /Muse's own count/);
  });
});

describe("calls with no recorded model", () => {
  const call = (modelId?: string) => ({ ...(modelId ? { modelId } : {}), promptTokens: 1000, usage: { outputTokens: 100 } });
  const unnamed = () => foldOfCalls([call()]);
  const wonderFull = () => foldOfCalls([call("muse-wonder-full-1.0")]);
  const both = () => foldOfCalls([call(), call("muse-wonder-full-1.0")]);
  const causes = (cause: { unknownModel: boolean; unpricedModel: boolean }) => [cause.unknownModel, cause.unpricedModel];

  it("tells a call with no model from a model nobody prices", () => {
    assert.deepEqual(causes(sessionUsage(unnamed(), [PRICED])), [true, false]);
    assert.equal(sessionUsage(unnamed(), [PRICED]).models[0]?.modelId, "unknown");
    assert.deepEqual(causes(sessionUsage(wonderFull(), [PRICED])), [false, true]);
    assert.deepEqual(causes(sessionUsage(both(), [PRICED])), [true, true]);
    assert.deepEqual(causes(sessionUsage(foldOfCalls([call("priced")]), [PRICED])), [false, false]);
    assert.equal(isUnrecordedModel(null) && isUnrecordedModel("unknown") && isUnrecordedModel(""), true);
    assert.equal(isUnrecordedModel("muse-wonder-full-1.0"), false);
  });

  it("explains a missing model as a missing model, not as a model without a price", () => {
    const none = sessionUsage(unnamed(), [PRICED]);
    assert.equal(unpricedWhy(none), NO_MODEL_REASON);
    assert.match(unpricedNote(none), /Muse did not record the model/);
    assert.doesNotMatch(unpricedNote(none), new RegExp(NO_PRICE_REASON));
    assert.doesNotMatch(costTip({ ...none, cost: 1 }), new RegExp(NO_PRICE_REASON));
    assert.match(costTip({ ...none, cost: 1 }), /Muse did not record the model/);
    assert.doesNotMatch(costTitle({ ...none, cost: 1 }), new RegExp(NO_PRICE_REASON));
    assert.doesNotMatch(costNotes(none).join(" "), /unpriced model/);
  });

  it("keeps Meta's reason for a model it publishes no price for, and gives both when both apply", () => {
    const full = sessionUsage(wonderFull(), [PRICED]);
    assert.equal(unpricedWhy(full), NO_PRICE_REASON);
    assert.match(costTip({ ...full, cost: 1 }), new RegExp(NO_PRICE_REASON));
    assert.doesNotMatch(costTip({ ...full, cost: 1 }), /did not record the model/);
    const mixed = sessionUsage(both(), [PRICED]);
    assert.equal(unpricedWhy(mixed), `${NO_PRICE_REASON}. ${NO_MODEL_REASON}`);
    assert.match(unpricedNote(mixed), new RegExp(NO_PRICE_REASON));
    assert.match(unpricedNote(mixed), /did not record the model/);
  });

  it("captions each model row by its own cause", () => {
    for (const none of ["unknown", null, undefined, ""]) {
      assert.equal(noPriceReason(none), NO_MODEL_REASON);
    }
    assert.equal(noPriceReason("muse-wonder-full-1.0"), NO_PRICE_REASON);
    assert.equal(modelRateCaption("unknown", null), NO_MODEL_REASON);
    assert.equal(modelRateCaption("muse-wonder-full-1.0", null), NO_PRICE_REASON);
    assert.equal(modelRateCaption("muse-spark-1.3", listedPrice("muse-spark-1.3")), "$1.25/M in · $0.150/M cached · $4.25/M out");
  });

  it("carries the cause onto the turn footer and the goal", () => {
    const turn = turnCost(unnamed(), "t1", [PRICED]);
    assert.ok(turn);
    assert.deepEqual(causes(turn), [true, false]);
    assert.match(turnCostTip(turn), /^At API rates: 1k in \(0 cached\), 100 out; /);
    assert.match(turnCostTip(turn), /Muse did not record the model/);
    assert.doesNotMatch(turnCostTip(turn), new RegExp(NO_PRICE_REASON));
    const full = turnCost(wonderFull(), "t1", [PRICED]);
    assert.ok(full);
    assert.match(turnCostTip(full), new RegExp(NO_PRICE_REASON));
    const priced = turnCost(foldOfCalls([call("priced")]), "t1", [PRICED]);
    assert.ok(priced);
    assert.equal(turnCostTip(priced), "At API rates: 1k in (0 cached), 100 out");

    const goal = turnsCost(unnamed(), ["t1"], [PRICED]);
    assert.ok(goal);
    assert.match(goalCostTip(goal), /Muse did not record the model/);
    assert.doesNotMatch(goalCostTip(goal), new RegExp(NO_PRICE_REASON));
    const twoTurns = foldOfCalls([{ ...call(), turnId: "t1" }, { ...call("muse-wonder-full-1.0"), turnId: "t2" }]);
    const together = turnsCost(twoTurns, ["t1", "t2"], [PRICED]);
    assert.ok(together);
    assert.deepEqual(causes(together), [true, true]);
  });
});

describe("when a cost is a floor", () => {
  const priced = () => sessionUsage(foldOfCalls([{ modelId: "priced", promptTokens: 1000, usage: { outputTokens: 100 } }]), [PRICED]);

  it("reads as an estimate when nothing is missing", () => {
    assert.equal(costIsFloor(priced()), false);
    assert.equal(costTitle(priced()), "Estimated from list prices");
  });

  it("reads as a floor for each reason, and says which", () => {
    const cut = sessionUsage(applyEvents(emptyFold(), historyEvents.slice(-12)), parseModelList(modelList));
    assert.equal(cut.costComplete, true);
    assert.equal(costIsFloor(cut), true, "earlier turns are missing");
    assert.equal(costTitle(cut), "At least this much. It covers the loaded calls only");

    const unpriced = sessionUsage(foldOfCalls([{ modelId: "muse-wonder-full-1.0", promptTokens: 1000, usage: { outputTokens: 100 } }]), [PRICED]);
    assert.equal(costIsFloor(unpriced), true, "a call has no price");
    assert.match(costTitle(unpriced), new RegExp(NO_PRICE_REASON));

    const agents = sessionUsage(
      applyEvents(emptyFold(), [
        tokenUsage("v:1", { modelId: "priced", promptTokens: 100, usage: { outputTokens: 100 } }),
        item({ itemId: "s1", kind: "subagent", role: "explorer", usage: { inputTokens: 500_000, outputTokens: 20_000 } }),
      ]),
      [PRICED],
    );
    assert.equal(agents.costComplete, true);
    assert.equal(costIsFloor(agents), true, "agents Muse leaves out");
    assert.equal(costTitle(agents), "At least this much. Workflow agents and subagents are not in it");
  });

  it("words the captions the Context panel hangs on those floors", () => {
    assert.equal(LOADED_ONLY, "Loaded calls only");
    assert.equal(SUBAGENT_CAPTION, "Outside Muse's total and not priced.");
  });
});

describe("one spelling for dollars and for floors", () => {
  const spend = (modelId: string, extra: Record<string, unknown> = {}) => ({ modelId, promptTokens: 10_000, usage: { outputTokens: 1_850 }, ...extra });
  /** 10k prompt and 1.85k output at the PRICED rates: $0.0348. */
  const priced = () => sessionUsage(foldOfCalls([spend("priced")]), [PRICED]);

  it("writes a floor as `≥ $x` and keeps the exact figure plain", () => {
    assert.equal(LOWER_BOUND, "≥");
    assert.equal(atLeast("$1.20"), "≥ $1.20");
    assert.equal(atLeast("EUR 1.20"), "≥ EUR 1.20");
    assert.equal(usageCostLabel(priced()), "$0.035");
  });

  it("gives the Context panel the chip's own digits, not a rounding of its own", () => {
    assert.equal(contextCostValue(priced()), "≈$0.035", "$0.0348 reads $0.035 on every surface, not $0.03");
    assert.equal(contextCostValue(priced()), `≈${usageCostLabel(priced())}`);
    // Past a dollar both use two decimals; $2.0348 reads $2.03.
    const bigger = sessionUsage(foldOfCalls([{ modelId: "priced", promptTokens: 1_000_000, usage: { outputTokens: 0 } }, spend("priced")]), [PRICED]);
    assert.equal(contextCostValue(bigger), "≈$2.03");
    assert.equal(contextCostValue(bigger), `≈${usageCostLabel(bigger)}`);
  });

  it("gives the Context panel the chip's floor, for each reason", () => {
    const cut = sessionUsage(applyEvents(emptyFold(), historyEvents.slice(-12)), parseModelList(modelList));
    assert.match(usageCostLabel(cut) ?? "", /^≥ \$/);
    assert.equal(contextCostValue(cut), usageCostLabel(cut), "earlier turns are missing");
    const unpriced = sessionUsage(foldOfCalls([spend("priced"), spend("muse-wonder-full-1.0")]), [PRICED]);
    assert.equal(usageCostLabel(unpriced), "≥ $0.035", "a call has no price: the chip no longer reads `$0.035+`");
    assert.equal(contextCostValue(unpriced), "≥ $0.035");
    const agents = sessionUsage(
      applyEvents(emptyFold(), [
        tokenUsage("v:1", spend("priced")),
        item({ itemId: "s1", kind: "subagent", role: "explorer", usage: { inputTokens: 500_000, outputTokens: 20_000 } }),
      ]),
      [PRICED],
    );
    assert.equal(contextCostValue(agents), "≥ $0.035");
    assert.equal(contextCostValue(sessionUsage(foldOfCalls([spend("muse-wonder-full-1.0")]), [PRICED])), null, "no call was priced");
  });

  it("keeps the turn footer's plus for a turn that is short by its unpriced calls", () => {
    const whole = turnCost(foldOfCalls([spend("priced")]), "t1", [PRICED]);
    assert.ok(whole);
    assert.equal(turnCostLabel(whole), "$0.035");
    const short = turnCost(foldOfCalls([spend("priced"), spend("muse-wonder-full-1.0")]), "t1", [PRICED]);
    assert.ok(short);
    assert.equal(turnCostLabel(short), "$0.035+", "plus unpriced, not a thread's floor");
    assert.equal(turnCostLabel({ cost: 1.5, currency: "EUR", complete: false }), "EUR 1.50+");
  });

  it("prints a dash, not a zero floor, for a goal that ran on a model with no price", () => {
    const wonderFull = turnsCost(foldOfCalls([spend("muse-wonder-full-1.0", { turnId: "t1" })]), ["t1"], [PRICED]);
    assert.ok(wonderFull);
    assert.equal(wonderFull.cost, 0);
    assert.equal(wonderFull.complete, false);
    assert.equal(goalCostValue(wonderFull), NO_VALUE);
    assert.equal(NO_VALUE, "—");
    assert.match(goalCostTip(wonderFull), new RegExp(NO_PRICE_REASON), "the tooltip keeps the reason");
    const unnamed = turnsCost(foldOfCalls([{ promptTokens: 1000, usage: { outputTokens: 100 }, turnId: "t1" }]), ["t1"], [PRICED]);
    assert.equal(goalCostValue(unnamed), NO_VALUE);
    assert.match(goalCostTip(unnamed), /Muse did not record the model/);
    // A goal with some priced calls is still a floor, with its figure.
    const mixed = turnsCost(foldOfCalls([spend("priced", { turnId: "t1" }), spend("muse-wonder-full-1.0", { turnId: "t2" })]), ["t1", "t2"], [PRICED]);
    assert.equal(goalCostValue(mixed), "≥ $0.035");
  });
});

describe("the context panel's words", () => {
  it("shares a window to a tenth of a percent, and says nothing without one", () => {
    assert.equal(share(250, 1000), "25.0%");
    assert.equal(share(0, 1000), "0.0%");
    assert.equal(share(1, 10_000), "<0.1%");
    assert.equal(share(5, null), "");
    assert.equal(share(5, 0), "");
  });

  it("names the segment bar by its tokens when there is no window to divide by", () => {
    assert.equal(segmentBarLabel(5_000, 1_000_000), "0.5% of the context window used");
    assert.equal(segmentBarLabel(5_000, null), "5k tokens in context");
  });

  it("says an estimated total is Ancilla's estimate, and Muse's total is Muse's", () => {
    const split = "The split marked ≈ is estimated from this thread's text.";
    assert.equal(breakdownNote("normal"), `Muse reports the total. ${split}`);
    assert.equal(breakdownNote("warning"), `Muse reports the total. ${split}`);
    assert.equal(breakdownNote(ESTIMATED_PRESSURE), `The total is estimated from the last model call. ${split}`);
  });
});
