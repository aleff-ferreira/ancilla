import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_PRICE_REASON } from "../src/model/pricing.js";
import { atLeast, NO_MODEL_REASON } from "../src/model/usage-labels.js";
import {
  ACCOUNTS_NOTE,
  AGENT_SPEND_NOTE,
  costBound,
  coverageNote,
  coverageText,
  excludedCallsNote,
  loadFailed,
  loadSucceeded,
  noPriceCaption,
  noPriceTip,
  LOWER_BOUND,
  NO_LOAD,
  NO_VALUE,
  NOT_COUNTED_NOTE,
  ONE_SHOT_NOTE,
  refreshFailedNote,
  shouldRefresh,
  summarize,
  threadOpenable,
  threadPriceNote,
  threadsCutNote,
  TOP_THREADS,
  unpricedCallsNote,
  unpricedReason,
  updatedLabel,
  USAGE_REFRESH_MS,
  usageAge,
} from "../src/model/usage-report.js";
import type { ModelOption, UsageBucket, UsageReport, UsageThread } from "../src/types.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function close(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} is not ${expected}`);
}

function bucket(modelId: string, calls: number, day = "2026-09-15", extra: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day,
    modelId,
    calls,
    promptTokens: calls * 100_000,
    outputTokens: calls * 10_000,
    cachedTokens: calls * 40_000,
    cacheReadTokens: calls * 40_000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: calls * 1_000,
    ...extra,
  };
}

function thread(id: string, modelId: string, calls: number, extra: Partial<UsageThread> = {}): UsageThread {
  const promptTokens = calls * 100_000;
  const outputTokens = calls * 10_000;
  const cachedTokens = calls * 40_000;
  return {
    sessionId: id,
    title: id,
    cwd: "/work/app",
    calls,
    promptTokens,
    outputTokens,
    cachedTokens,
    modelIds: [modelId],
    models: [{ modelId, calls, promptTokens, outputTokens, cachedTokens }],
    lastAt: "2026-09-15T10:00:00.000Z",
    ...extra,
  };
}

function report(buckets: UsageBucket[], threads: UsageThread[] = [], extra: Partial<UsageReport> = {}): UsageReport {
  return { since: "2026-09-13T00:00:00.000Z", days: 3, tz: "UTC", buckets, threads, ...extra };
}

const SPARK = "muse-spark-1.3";
const WONDER = "muse-wonder-1.0";
const WONDER_FULL = "muse-wonder-full-1.0";

describe("usage summarize: unpriced calls", () => {
  const mixed = report(
    [bucket(SPARK, 10, "2026-09-14"), bucket(WONDER_FULL, 5, "2026-09-14"), bucket(SPARK, 2, "2026-09-15")],
    [thread("a", SPARK, 12), thread("b", WONDER_FULL, 5)],
  );

  it("counts every call, and the ones with no price separately", () => {
    const view = summarize(mixed, [], NOW);
    assert.equal(view.calls, 17);
    assert.equal(view.unpriced, 5);
    assert.equal(view.metric, "cost");
    const wonderFull = view.models.find((row) => row.modelId === WONDER_FULL);
    assert.ok(wonderFull);
    assert.equal(wonderFull.price, null);
    assert.equal(wonderFull.unpricedCalls, 5);
    assert.equal(wonderFull.cost, 0);
    assert.equal(wonderFull.tokens, 5 * 110_000);
    const spark = view.models.find((row) => row.modelId === SPARK);
    assert.equal(spark?.unpricedCalls, 0);
    assert.ok(spark?.price);
  });

  it("carries tokens and unpriced calls on each day, and drops no bar", () => {
    const view = summarize(mixed, [], NOW);
    const day = view.days.find((row) => row.day === "2026-09-14");
    assert.ok(day);
    assert.equal(day.calls, 15);
    assert.equal(day.unpricedCalls, 5);
    assert.equal(day.tokens, 15 * 110_000);
    assert.equal(day.byModel.find((slice) => slice.modelId === WONDER_FULL)?.tokens, 5 * 110_000);
    assert.equal(view.days.find((row) => row.day === "2026-09-15")?.unpricedCalls, 0);
    assert.equal(view.days.find((row) => row.day === "2026-09-13")?.calls, 0);
  });

  it("marks a thread as partly or wholly unpriced and keeps it in the list", () => {
    const view = summarize(mixed, [], NOW);
    const wonderThread = view.threads.find((row) => row.sessionId === "b");
    assert.ok(wonderThread);
    assert.equal(wonderThread.unpricedCalls, 5);
    assert.equal(wonderThread.cost, 0);
    assert.equal(wonderThread.tokens, 5 * 110_000);
    assert.equal(view.threads.find((row) => row.sessionId === "a")?.unpricedCalls, 0);
    const switched = thread("c", SPARK, 4, {
      modelIds: [SPARK, WONDER_FULL],
      models: [
        { modelId: SPARK, calls: 3, promptTokens: 300_000, outputTokens: 30_000, cachedTokens: 120_000 },
        { modelId: WONDER_FULL, calls: 1, promptTokens: 100_000, outputTokens: 10_000, cachedTokens: 40_000 },
      ],
    });
    const row = summarize(report([bucket(SPARK, 3), bucket(WONDER_FULL, 1)], [switched]), [], NOW).threads[0];
    assert.equal(row?.unpricedCalls, 1);
    assert.ok((row?.cost ?? 0) > 0);
  });

  it("reads a report with only unpriced calls by tokens, and a mixed one by cost", () => {
    const only = summarize(report([bucket(WONDER_FULL, 5), bucket("unknown", 3)]), [], NOW);
    assert.equal(only.metric, "tokens");
    assert.equal(only.unpriced, only.calls);
    assert.equal(only.cost, 0);
    assert.equal(summarize(mixed, [], NOW).metric, "cost");
    assert.equal(summarize(report([bucket(SPARK, 1)]), [], NOW).metric, "cost");
  });

  it("treats a call with no model as unpriced, not as free", () => {
    const view = summarize(report([bucket("unknown", 4)]), [], NOW);
    assert.equal(view.unpriced, 4);
    assert.equal(view.models[0]?.price, null);
    assert.equal(view.models[0]?.unpricedCalls, 4);
  });

  it("prices Wonder at its published rates and leaves Wonder Full without one", () => {
    // 1M prompt (500k cached) and 1M output at 4 / 20 / 0.2 dollars per million.
    const wonder = bucket(WONDER, 1, "2026-09-15", { promptTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 1_000_000 });
    const view = summarize(report([wonder]), [], NOW);
    close(view.cost, 0.5 * 4 + 0.5 * 0.2 + 20);
    assert.equal(view.unpriced, 0);
    const full = summarize(report([{ ...wonder, modelId: WONDER_FULL }]), [], NOW);
    assert.equal(full.cost, 0);
    assert.equal(full.unpriced, 1);
  });

  it("lets a catalog price win over the published table", () => {
    const catalog: ModelOption[] = [
      {
        modelId: WONDER_FULL,
        displayLabel: "",
        description: null,
        isDefault: false,
        isActive: false,
        contextLimit: null,
        outputLimit: null,
        cost: { input: 10, output: 40, cached: 1, currency: "USD" },
        contributor: false,
      },
    ];
    const view = summarize(report([bucket(WONDER_FULL, 1, "2026-09-15", { promptTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 })]), catalog, NOW);
    close(view.cost, 10);
    assert.equal(view.unpriced, 0);
  });

  it("reconciles the days, the models and the total", () => {
    const view = summarize(report([bucket(SPARK, 10, "2026-09-13"), bucket(SPARK, 3, "2026-09-14"), bucket(WONDER, 2, "2026-09-14"), bucket(WONDER_FULL, 7, "2026-09-15")]), [], NOW);
    const days = view.days.reduce((sum, row) => sum + row.cost, 0);
    const models = view.models.reduce((sum, row) => sum + row.cost, 0);
    close(days, view.cost);
    close(models, view.cost);
    assert.equal(
      view.days.reduce((sum, row) => sum + row.calls, 0),
      view.calls,
    );
    assert.equal(
      view.days.reduce((sum, row) => sum + row.tokens, 0),
      view.tokens,
    );
    assert.equal(
      view.models.reduce((sum, row) => sum + row.unpricedCalls, 0),
      view.unpriced,
    );
  });

  it("counts the cache saving only on calls it can price", () => {
    const priced = summarize(report([bucket(SPARK, 10)]), [], NOW);
    // 10 calls with 40k cached tokens each, saved at (1.25 - 0.15) dollars per million.
    close(priced.cacheSaved, (10 * 40_000 * (1.25 - 0.15)) / 1_000_000);
    const withUnpriced = summarize(report([bucket(SPARK, 10), bucket(WONDER_FULL, 5)]), [], NOW);
    close(withUnpriced.cacheSaved, priced.cacheSaved);
    assert.match(costBound(withUnpriced.cacheSaved, "USD", withUnpriced.unpriced, withUnpriced.calls), /^≥ \$/);
    assert.doesNotMatch(costBound(priced.cacheSaved, "USD", priced.unpriced, priced.calls), /≥/);
  });
});

describe("usage summarize: the day window", () => {
  it("draws the report's own days and marks which one is still counting", () => {
    const view = summarize(report([bucket(SPARK, 1, "2026-09-14")]), [], NOW);
    assert.deepEqual(
      view.days.map((row) => row.day),
      ["2026-09-13", "2026-09-14", "2026-09-15"],
    );
    assert.equal(view.today, "2026-09-15");
    assert.equal(view.tz, "UTC");
    // 01:00 UTC on the 16th is still the evening of the 15th in Sao Paulo, so the 15th is the day still counting.
    const late = summarize(report([], [], { tz: "America/Sao_Paulo", since: "2026-09-13T03:00:00.000Z" }), [], new Date("2026-09-16T01:00:00.000Z"));
    assert.equal(late.today, "2026-09-15");
    assert.equal(late.days.at(-1)?.day, "2026-09-15");
  });

  it("fills a report that names no zone, as the demo sends it", () => {
    const view = summarize({ since: "2026-09-13T12:00:00.000Z", days: 3, buckets: [bucket(SPARK, 1, "2026-09-14")], threads: [] }, [], NOW);
    assert.equal(view.days.length, 3);
    assert.equal(view.tz, undefined);
    assert.equal(view.today, "2026-09-15");
  });
});

describe("usage summarize: the thread list", () => {
  function many(count: number): UsageReport {
    const threads = Array.from({ length: count }, (_, i) => thread(`t${i}`, SPARK, i + 1));
    const buckets = threads.map((row, i) => bucket(SPARK, row.calls, i % 2 === 0 ? "2026-09-14" : "2026-09-15"));
    return report(buckets, threads);
  }

  it("lists the top eight and still accounts for the rest", () => {
    const view = summarize(many(12), [], NOW);
    assert.equal(TOP_THREADS, 8);
    assert.equal(view.threads.length, 8);
    assert.equal(view.threadsTotal, 12);
    const listed = view.threads.reduce((sum, row) => sum + row.cost, 0);
    close(listed + view.otherCost, view.cost);
    assert.equal(view.otherCalls, 1 + 2 + 3 + 4);
    // The costliest come first.
    assert.equal(view.threads[0]?.sessionId, "t11");
    assert.ok(view.otherCost > 0);
    assert.equal(view.otherUnpricedCalls, 0);
  });

  it("says what the list is cut to, with a bound when others have unpriced calls", () => {
    const view = summarize(many(12), [], NOW);
    assert.match(threadsCutNote(view) ?? "", /^Showing top 8 of 12 threads, others \$\d/);
    assert.equal(threadsCutNote(summarize(many(8), [], NOW)), null);
    assert.equal(threadsCutNote(summarize(many(3), [], NOW)), null);
    const threads = [
      ...Array.from({ length: 8 }, (_, i) => thread(`p${i}`, SPARK, 20 + i)),
      thread("small", SPARK, 1),
      thread("big-unpriced", WONDER_FULL, 1),
    ];
    const buckets = [bucket(SPARK, 20 + 21 + 22 + 23 + 24 + 25 + 26 + 27 + 1), bucket(WONDER_FULL, 1)];
    const cut = summarize(report(buckets, threads), [], NOW);
    assert.equal(cut.threadsTotal, 10);
    assert.match(threadsCutNote(cut) ?? "", /others ≥ \$/);
    assert.equal(cut.otherUnpricedCalls, 1);
  });

  it("says the others in tokens when nothing has a price", () => {
    const threads = Array.from({ length: 10 }, (_, i) => thread(`w${i}`, WONDER_FULL, i + 1));
    const buckets = [bucket(WONDER_FULL, 55)];
    const view = summarize(report(buckets, threads), [], NOW);
    assert.equal(view.metric, "tokens");
    assert.match(threadsCutNote(view) ?? "", /^Showing top 8 of 10 threads, others \d.*k tokens$/);
    // Ranked by tokens, not tied at zero cost.
    assert.equal(view.threads[0]?.sessionId, "w9");
  });

  it("breaks cost ties by tokens, and lets a priced thread outrank an unpriced one", () => {
    const view = summarize(
      report(
        [bucket(SPARK, 1), bucket(WONDER_FULL, 9), bucket("unknown", 2)],
        [thread("cheap", SPARK, 1), thread("wonder-full", WONDER_FULL, 9), thread("odd", "unknown", 2)],
      ),
      [],
      NOW,
    );
    assert.deepEqual(
      view.threads.map((row) => row.sessionId),
      ["cheap", "wonder-full", "odd"],
    );
  });

  it("prices a thread that reports no per-model split from its first model", () => {
    const old: UsageThread = { ...thread("old", SPARK, 2) };
    delete old.models;
    const view = summarize(report([bucket(SPARK, 2)], [old]), [], NOW);
    close(view.threads[0]?.cost ?? 0, view.cost);
    const unnamed: UsageThread = { ...thread("none", SPARK, 2), modelIds: [] };
    delete unnamed.models;
    assert.equal(summarize(report([bucket(SPARK, 2)], [unnamed]), [], NOW).threads[0]?.unpricedCalls, 2);
  });

  it("keeps the research row apart: no thread to open", () => {
    const research = thread("research-workers:/work/app", SPARK, 3, { kind: "research", title: "DeepResearch workers" });
    const view = summarize(report([bucket(SPARK, 3)], [research]), [], NOW);
    assert.equal(view.threads[0]?.kind, "research");
    assert.equal(threadOpenable(research, { "research-workers:/work/app": {} }), false);
    assert.equal(threadOpenable(thread("real", SPARK, 1), { real: {} }), true);
    assert.equal(threadOpenable(thread("archived", SPARK, 1), { real: {} }), false);
    assert.equal(threadOpenable(thread("toString", SPARK, 1), {}), false);
  });

  it("opens every real thread's row until the thread list has loaded, and never the research row", () => {
    // An empty list before it loads says nothing about a thread's absence: its row is not a dead one yet.
    assert.equal(threadOpenable(thread("real", SPARK, 1), {}, false), true);
    assert.equal(threadOpenable(thread("archived", SPARK, 1), { real: {} }, false), true);
    assert.equal(threadOpenable(thread("research-workers:/work/app", SPARK, 3, { kind: "research" }), {}, false), false);
    // Loaded, the list decides, and leaving the argument out means loaded.
    assert.equal(threadOpenable(thread("archived", SPARK, 1), { real: {} }, true), false);
    assert.equal(threadOpenable(thread("real", SPARK, 1), { real: {} }, true), true);
  });

  it("notes when the totals include more than one account", () => {
    const one = summarize(report([bucket(SPARK, 2)], [thread("a", SPARK, 1), thread("b", SPARK, 1)]), [], NOW);
    assert.equal(one.allAccounts, false);
    const defaults = summarize(report([bucket(SPARK, 2)], [thread("a", SPARK, 1, { accountId: null }), thread("b", SPARK, 1)]), [], NOW);
    assert.equal(defaults.allAccounts, false);
    const named = summarize(report([bucket(SPARK, 2)], [thread("a", SPARK, 1, { accountId: "work" }), thread("b", SPARK, 1, { accountId: "work" })]), [], NOW);
    assert.equal(named.allAccounts, false);
    const withDefault = summarize(report([bucket(SPARK, 2)], [thread("a", SPARK, 1, { accountId: "work" }), thread("b", SPARK, 1, { accountId: null })]), [], NOW);
    assert.equal(withDefault.allAccounts, true);
    const two = summarize(report([bucket(SPARK, 2)], [thread("a", SPARK, 1, { accountId: "work" }), thread("b", SPARK, 1, { accountId: "home" })]), [], NOW);
    assert.equal(two.allAccounts, true);
    assert.equal(ACCOUNTS_NOTE, "Totals include every account");
  });

  it("passes the coverage through", () => {
    const coverage = { countedThreads: 4, partialThreads: 1, uncountedThreads: 2 };
    assert.deepEqual(summarize(report([bucket(SPARK, 1)], [], { coverage }), [], NOW).coverage, coverage);
    assert.equal(summarize(report([bucket(SPARK, 1)]), [], NOW).coverage, null);
  });
});

describe("usage figures for calls with no price", () => {
  it("reads a lower bound when some calls are unpriced and a dash when all are", () => {
    assert.equal(costBound(1.2, "USD", 3, 10), "≥ $1.20");
    assert.equal(costBound(0, "USD", 10, 10), "—");
    assert.equal(costBound(0, "USD", 10, 10), NO_VALUE);
    assert.equal(costBound(1.2, "USD", 0, 10), "$1.20");
    assert.equal(costBound(0, "USD", 0, 10), "$0");
    assert.equal(costBound(0.5, "EUR", 1, 2), "≥ EUR 0.500");
  });

  it("words the notes in the singular and the plural", () => {
    assert.equal(unpricedCallsNote(1), "1 call has no published price");
    assert.equal(unpricedCallsNote(43), "43 calls have no published price");
    assert.equal(excludedCallsNote(1), "excludes 1 call with no published price");
    assert.equal(excludedCallsNote(43), "excludes 43 calls with no published price");
    assert.equal(noPriceTip(2), `2 calls have no published price. ${NO_PRICE_REASON}.`);
    assert.equal(threadPriceNote({ calls: 5, unpricedCalls: 0 }), null);
    assert.equal(threadPriceNote({ calls: 5, unpricedCalls: 2 }), `2 of 5 calls have no published price. ${NO_PRICE_REASON}.`);
    assert.equal(threadPriceNote({ calls: 1, unpricedCalls: 1 }), `1 of 1 call has no published price. ${NO_PRICE_REASON}.`);
  });

  it("writes a lower bound with a space, as the thread panels do", () => {
    assert.equal(costBound(0.0021, "USD", 1, 2), "≥ $0.0021");
    assert.equal(LOWER_BOUND, "≥");
    assert.equal(costBound(0.0021, "USD", 1, 2), atLeast("$0.0021"));
  });
});

describe("usage summarize: calls that name no model", () => {
  const unknown = "unknown";

  it("counts the unpriced calls that name no model apart from the ones Meta does not price", () => {
    const view = summarize(
      report([bucket(SPARK, 4), bucket(WONDER_FULL, 5), bucket(unknown, 3)], [thread("a", SPARK, 4), thread("b", WONDER_FULL, 5), thread("c", unknown, 3)]),
      [],
      NOW,
    );
    assert.equal(view.unpriced, 8);
    assert.equal(view.unpricedUnrecorded, 3);
    assert.equal(view.threads.find((row) => row.sessionId === "c")?.unpricedUnrecorded, 3);
    assert.equal(view.threads.find((row) => row.sessionId === "b")?.unpricedUnrecorded, 0);
    assert.equal(view.threads.find((row) => row.sessionId === "a")?.unpricedUnrecorded, 0);
    // A thread with no per-model split and no model ids is filed under no model too.
    const old: UsageThread = { ...thread("old", SPARK, 2), modelIds: [] };
    delete old.models;
    assert.equal(summarize(report([bucket(unknown, 2)], [old]), [], NOW).threads[0]?.unpricedUnrecorded, 2);
    assert.equal(summarize(report([bucket(SPARK, 1)]), [], NOW).unpricedUnrecorded, 0);
  });

  it("gives each unpriced call the reason that fits: no model, no published price, or both", () => {
    assert.equal(unpricedReason(5, 0), NO_PRICE_REASON);
    assert.equal(unpricedReason(3, 3), NO_MODEL_REASON);
    assert.equal(unpricedReason(8, 3), `${NO_PRICE_REASON}. ${NO_MODEL_REASON}`);
    assert.equal(unpricedReason(5), NO_PRICE_REASON, "the count of calls with no model is optional");
  });

  it("explains a total whose only unpriced calls name no model as a missing model, not as Meta's doing", () => {
    assert.equal(noPriceTip(3, 3), `3 calls have no price. ${NO_MODEL_REASON}.`);
    assert.doesNotMatch(noPriceTip(3, 3), new RegExp(NO_PRICE_REASON));
    assert.equal(unpricedCallsNote(3, 3), "3 calls have no price");
    assert.equal(excludedCallsNote(3, 3), "excludes 3 calls with no price");
    assert.equal(noPriceTip(8, 3), `8 calls have no published price. ${NO_PRICE_REASON}. ${NO_MODEL_REASON}.`);
    assert.equal(noPriceTip(5, 0), `5 calls have no published price. ${NO_PRICE_REASON}.`);
    assert.equal(excludedCallsNote(5, 0), "excludes 5 calls with no published price");
  });

  it("says the same on a thread's row, and on a model's line", () => {
    assert.equal(threadPriceNote({ calls: 3, unpricedCalls: 3, unpricedUnrecorded: 3 }), `3 of 3 calls have no price. ${NO_MODEL_REASON}.`);
    assert.equal(threadPriceNote({ calls: 5, unpricedCalls: 2, unpricedUnrecorded: 0 }), `2 of 5 calls have no published price. ${NO_PRICE_REASON}.`);
    assert.equal(
      threadPriceNote({ calls: 5, unpricedCalls: 4, unpricedUnrecorded: 1 }),
      `4 of 5 calls have no published price. ${NO_PRICE_REASON}. ${NO_MODEL_REASON}.`,
    );
    assert.equal(noPriceCaption(unknown), `no price. ${NO_MODEL_REASON}`);
    assert.equal(noPriceCaption(""), `no price. ${NO_MODEL_REASON}`);
    assert.equal(noPriceCaption(WONDER_FULL), `no published price. ${NO_PRICE_REASON}`);
  });
});

describe("usage coverage note", () => {
  it("is absent when nothing is missing", () => {
    assert.equal(coverageNote(null), null);
    assert.equal(coverageNote(undefined), null);
    assert.equal(coverageNote({ countedThreads: 6, partialThreads: 0, uncountedThreads: 0 }), null);
  });

  it("names the partial and the uncounted threads, and how to clear the uncounted ones", () => {
    const note = coverageNote({ countedThreads: 6, partialThreads: 2, uncountedThreads: 3 });
    assert.ok(note);
    assert.match(note, /2 threads could only be read back in part/);
    assert.match(note, /3 threads have not been counted yet/);
    assert.match(note, /lower bound/);
    assert.match(note, /Open a thread to count it\./);
    assert.match(note, /one-shot/i);
    assert.ok(note.includes(ONE_SHOT_NOTE));
  });

  it("only says to open a thread when one is uncounted, and uses the singular", () => {
    const partial = coverageNote({ countedThreads: 1, partialThreads: 1, uncountedThreads: 0 });
    assert.ok(partial);
    assert.match(partial, /^1 thread could only be read back in part, so these totals are a lower bound\./);
    assert.doesNotMatch(partial, /Open a thread/);
    const uncounted = coverageNote({ countedThreads: 0, partialThreads: 0, uncountedThreads: 1 });
    assert.ok(uncounted);
    assert.match(uncounted, /^1 thread has not been counted yet/);
    assert.match(uncounted, /Open a thread to count it\./);
  });

  it("always says what is never counted", () => {
    assert.ok(coverageText(null).includes(ONE_SHOT_NOTE));
    assert.ok(coverageText({ countedThreads: 2, partialThreads: 0, uncountedThreads: 0 }).includes(ONE_SHOT_NOTE));
    assert.ok(coverageText({ countedThreads: 2, partialThreads: 0, uncountedThreads: 4 }).includes("4 threads have not been counted yet"));
  });

  it("always says that subagent and workflow agent spend is not included", () => {
    assert.equal(AGENT_SPEND_NOTE, "Spend of subagents and workflow agents is not included.");
    assert.equal(NOT_COUNTED_NOTE, `${ONE_SHOT_NOTE} ${AGENT_SPEND_NOTE}`);
    assert.ok(coverageText(null).includes(AGENT_SPEND_NOTE));
    assert.ok(coverageText(undefined).includes(AGENT_SPEND_NOTE));
    assert.ok(coverageText({ countedThreads: 2, partialThreads: 0, uncountedThreads: 0 }).includes(AGENT_SPEND_NOTE));
    assert.ok(coverageText({ countedThreads: 2, partialThreads: 1, uncountedThreads: 4 }).includes(AGENT_SPEND_NOTE));
    assert.ok(coverageNote({ countedThreads: 6, partialThreads: 2, uncountedThreads: 3 })?.endsWith(NOT_COUNTED_NOTE));
    assert.ok(coverageText(null).endsWith(NOT_COUNTED_NOTE));
  });
});

describe("usage page refresh", () => {
  const now = 1_000_000;

  it("never refreshes a page that is not on screen", () => {
    assert.equal(shouldRefresh("hidden", null, now), false);
    assert.equal(shouldRefresh("hidden", now - 10 * USAGE_REFRESH_MS, now), false);
    assert.equal(shouldRefresh("prerender", null, now), false);
  });

  it("refreshes a visible page once what it shows is a minute old", () => {
    assert.equal(USAGE_REFRESH_MS, 60_000);
    assert.equal(shouldRefresh("visible", null, now), true);
    assert.equal(shouldRefresh("visible", now - 61_000, now), true);
    assert.equal(shouldRefresh("visible", now - 60_000, now), true);
    assert.equal(shouldRefresh("visible", now - 59_000, now), false);
    assert.equal(shouldRefresh("visible", now - 5_000, now), false);
    // The timer asks for less, so a tick a little early is not skipped for a whole extra minute.
    assert.equal(shouldRefresh("visible", now - 59_000, now, USAGE_REFRESH_MS / 2), true);
  });

  it("keeps the report on screen when a quiet refresh fails, marks it as not refreshed, and shows the error otherwise", () => {
    const shown = loadSucceeded(report([bucket(SPARK, 1)]), 5_000);
    const kept = loadFailed(shown, true, "offline");
    assert.equal(kept.report, shown.report, "the numbers stay");
    assert.equal(kept.error, null);
    assert.equal(kept.loadedAt, 5_000, "and they keep the time they were read");
    assert.equal(kept.refreshFailed, true, "but they are no longer called current");
    assert.equal(loadFailed(kept, true, "offline"), kept, "a second failure changes nothing more");
    assert.deepEqual(loadFailed(shown, false, "offline"), { report: null, error: "offline", loadedAt: null, refreshFailed: false });
    assert.deepEqual(loadFailed(NO_LOAD, true, "offline"), { report: null, error: "offline", loadedAt: null, refreshFailed: false });
    assert.deepEqual(loadFailed({ ...NO_LOAD, error: "old" }, true, "new"), { report: null, error: "new", loadedAt: null, refreshFailed: false });
  });

  it("clears the failed flag on the next good read and starts from nothing", () => {
    const failed = loadFailed(loadSucceeded(report([bucket(SPARK, 1)]), 5_000), true, "offline");
    const next = report([bucket(SPARK, 2)]);
    assert.deepEqual(loadSucceeded(next, 65_000), { report: next, error: null, loadedAt: 65_000, refreshFailed: false });
    assert.equal(failed.refreshFailed, true);
    assert.deepEqual(NO_LOAD, { report: null, error: null, loadedAt: null, refreshFailed: false });
  });

  it("says how old a read is", () => {
    const at = 1_000_000;
    assert.equal(usageAge(at, at), "just now");
    assert.equal(usageAge(at, at + 59_000), "just now");
    assert.equal(usageAge(at, at + 60_000), "1 min ago");
    assert.equal(usageAge(at, at + 3 * 60_000 + 20_000), "3 min ago");
    assert.equal(usageAge(at, at + 59 * 60_000), "59 min ago");
    assert.equal(usageAge(at, at + 60 * 60_000), "1 h ago");
    assert.equal(usageAge(at, at + 47 * 3_600_000), "47 h ago");
    assert.equal(usageAge(at, at + 48 * 3_600_000 - 60_000), "47 h ago", "a minute short of two days is still hours");
    assert.equal(usageAge(at, at + 48 * 3_600_000), "2 days ago", "hours turn to days at exactly 48");
    assert.equal(usageAge(at, at + 72 * 3_600_000), "3 days ago");
    assert.equal(usageAge(at, at - 5_000), "just now", "a clock that reads earlier than the read is not a negative age");
  });

  it("shows the age beside the range buttons while there is a report, and a warning once a refresh has failed", () => {
    const at = 1_000_000;
    const shown = loadSucceeded(report([bucket(SPARK, 1)]), at);
    assert.equal(updatedLabel(NO_LOAD, at), null, "nothing to date before the first read");
    assert.equal(updatedLabel({ ...NO_LOAD, error: "offline" }, at), null);
    assert.equal(updatedLabel(shown, at + 3 * 60_000), "Updated 3 min ago");
    assert.equal(refreshFailedNote(shown, at + 3 * 60_000), null, "a read that is current has no warning");
    const failed = loadFailed(shown, true, "offline");
    assert.equal(updatedLabel(failed, at + 3 * 60_000), "Updated 3 min ago", "the age keeps counting");
    assert.equal(refreshFailedNote(failed, at + 3 * 60_000), "Could not refresh; showing numbers from 3 min ago");
    assert.equal(refreshFailedNote(NO_LOAD, at), null);
    assert.equal(refreshFailedNote(loadSucceeded(shown.report as UsageReport, at + 60_000), at + 60_000), null, "the next good read clears it");
  });
});
