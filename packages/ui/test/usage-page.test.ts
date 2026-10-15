import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { DailyChart, Models, RefreshFailed, Threads, Totals, UpdatedAge, UsageReportBody } from "../src/components/usage/UsagePage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";
import { NO_MODEL_REASON } from "../src/model/usage-labels.js";
import { AGENT_SPEND_NOTE, loadFailed, loadSucceeded, NO_LOAD, summarize, TOP_THREADS, type UsageLoad } from "../src/model/usage-report.js";
import { dayBasis } from "../src/model/usage-range.js";
import type { UsageBucket, UsageReport, UsageThread } from "../src/types.js";

// The page's rules live in pure helpers with their own tests; these render the pieces the page puts them in, so a
// wrong argument or a dropped branch in a component turns a test red too.

const NOW = new Date("2026-09-15T12:00:00.000Z");
const SPARK = "muse-spark-1.3";
const WONDER_FULL = "muse-wonder-full-1.0";

function bucket(modelId: string, calls: number, day = "2026-09-15"): UsageBucket {
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
  };
}

function thread(id: string, modelId: string, calls: number, extra: Partial<UsageThread> = {}): UsageThread {
  return {
    sessionId: id,
    title: id,
    cwd: "/work/app",
    calls,
    promptTokens: calls * 100_000,
    outputTokens: calls * 10_000,
    cachedTokens: calls * 40_000,
    modelIds: [modelId],
    models: [{ modelId, calls, promptTokens: calls * 100_000, outputTokens: calls * 10_000, cachedTokens: calls * 40_000 }],
    lastAt: "2026-09-15T10:00:00.000Z",
    ...extra,
  };
}

function report(buckets: UsageBucket[], threads: UsageThread[] = []): UsageReport {
  return { since: "2026-09-13T00:00:00.000Z", days: 3, tz: "UTC", buckets, threads };
}

function render(element: ReactElement): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open" });
  const controller = { store, openThread: () => {} } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: element }) }));
}

/** The value a totals card shows under its label. */
function card(markup: string, label: string): string {
  const found = new RegExp(`${label}</p><p[^>]*>([^<]*)</p>`).exec(markup);
  assert.ok(found, `a card labelled ${label}`);
  return found[1] as string;
}

const mixed = summarize(
  report(
    [bucket(SPARK, 10, "2026-09-14"), bucket(WONDER_FULL, 5, "2026-09-14"), bucket(SPARK, 2, "2026-09-15")],
    [thread("a", SPARK, 12), thread("b", WONDER_FULL, 5)],
  ),
  [],
  NOW,
);
const unpricedOnly = summarize(report([bucket(WONDER_FULL, 5, "2026-09-14"), bucket("unknown", 3, "2026-09-15")], [thread("b", WONDER_FULL, 5)]), [], NOW);

describe("usage page: totals", () => {
  it("reads a total that leaves calls out as a lower bound, in both dollar cards", () => {
    const markup = render(createElement(Totals, { view: mixed }));
    assert.match(card(markup, "Cost at API rates"), /^≥ \$\d/);
    assert.match(card(markup, "Caching saved"), /^≥ \$\d/);
    assert.match(markup, /17 model calls/);
    assert.match(markup, /5 calls have no published price/);
  });

  it("shows a dash, not $0, when no call has a price", () => {
    const markup = render(createElement(Totals, { view: unpricedOnly }));
    assert.equal(card(markup, "Cost at API rates"), "—");
    assert.equal(card(markup, "Caching saved"), "—");
    assert.doesNotMatch(markup, /\$0/);
    assert.match(markup, /8 calls have no published price/);
  });

  it("shows the plain amount when every call is priced", () => {
    const priced = summarize(report([bucket(SPARK, 2)], [thread("a", SPARK, 2)]), [], NOW);
    const markup = render(createElement(Totals, { view: priced }));
    assert.match(card(markup, "Cost at API rates"), /^\$\d/);
    assert.match(card(markup, "Caching saved"), /^\$\d/);
    assert.doesNotMatch(markup, /no published price/);
  });
});

describe("usage page: models and the daily chart", () => {
  it("gives an unpriced model a dash and the reason, and a priced one its rate", () => {
    const markup = render(createElement(Models, { view: mixed }));
    assert.match(markup, /muse-wonder-full-1\.0/);
    assert.match(markup, /—<\/span>/);
    assert.match(markup, /no published price\. Meta publishes no price for this model/);
    assert.match(markup, /\/M in, /);
  });

  it("scales the chart and the model bars by tokens when nothing is priced", () => {
    const chart = render(createElement(DailyChart, { view: unpricedOnly, basis: dayBasis(unpricedOnly) }));
    assert.match(chart, /Tokens by day/);
    assert.match(chart, /peak \d+(\.\d+)?[kM]</);
    assert.doesNotMatch(chart, /Cost excludes/);
    const models = render(createElement(Models, { view: unpricedOnly }));
    assert.match(models, /\d+(\.\d+)?[kM] tokens<\/span>/);
    assert.doesNotMatch(models, />—<\/span>/);
  });

  it("keeps the chart on cost with a note when only some calls are priced, and marks today", () => {
    const chart = render(createElement(DailyChart, { view: mixed, basis: dayBasis(mixed) }));
    assert.match(chart, /Cost by day/);
    assert.match(chart, /Cost excludes 5 calls with no published price/);
    assert.match(chart, /2026-09-15 \(today so far\)/);
    assert.doesNotMatch(chart, /2026-09-13 \(today so far\)/);
    assert.match(chart, /\(UTC\)/);
  });

  it("calls a zoned report's days local time", () => {
    const zoned = summarize({ ...report([bucket(SPARK, 1)]), tz: "America/Sao_Paulo", since: "2026-09-13T03:00:00.000Z" }, [], NOW);
    const chart = render(createElement(DailyChart, { view: zoned, basis: dayBasis(zoned) }));
    assert.match(chart, /\(local time\)/);
  });
});

describe("usage page: calls that name no model", () => {
  const unnamed = summarize(report([bucket(SPARK, 2), bucket("unknown", 3)], [thread("a", SPARK, 2), thread("u", "unknown", 3)]), [], NOW);

  it("explains the unknown row as a missing model, not as a model Meta does not price", () => {
    const markup = render(createElement(Models, { view: unnamed }));
    assert.match(markup, /Unknown model/);
    assert.match(markup, new RegExp(`no price\\. ${NO_MODEL_REASON}`));
    assert.doesNotMatch(markup, /Meta publishes no price/);
    assert.doesNotMatch(markup, /no published price/);
    // The priced row beside it keeps its rates.
    assert.match(markup, /\/M in, /);
  });

  it("keeps Meta's reason on a model it publishes no price for, beside the unknown row", () => {
    const markup = render(createElement(Models, { view: summarize(report([bucket(WONDER_FULL, 2), bucket("unknown", 3)]), [], NOW) }));
    assert.match(markup, /no published price\. Meta publishes no price for this model/);
    assert.match(markup, new RegExp(`no price\\. ${NO_MODEL_REASON}`));
  });

  it("words the totals card and the chart note for calls that name no model", () => {
    const totals = render(createElement(Totals, { view: unnamed }));
    assert.match(totals, /3 calls have no price</);
    assert.doesNotMatch(totals, /no published price/);
    const chart = render(createElement(DailyChart, { view: unnamed, basis: dayBasis(unnamed) }));
    assert.match(chart, /Cost excludes 3 calls with no price</);
    assert.doesNotMatch(chart, /no published price/);
  });
});

describe("usage page: what the totals do not count", () => {
  const sessions = { a: {} };
  const body = (extra: Partial<UsageReport> = {}) => {
    const view = summarize({ ...report([bucket(SPARK, 2)], [thread("a", SPARK, 2)]), ...extra }, [], NOW);
    return render(createElement(UsageReportBody, { view, sessions, sessionsLoaded: true }));
  };
  const count = (markup: string, needle: string) => markup.split(needle).length - 1;

  it("always says in the footer that agent spend is not included", () => {
    assert.equal(count(body(), AGENT_SPEND_NOTE), 1);
    assert.equal(count(body({ coverage: { countedThreads: 1, partialThreads: 0, uncountedThreads: 0 } }), AGENT_SPEND_NOTE), 1);
  });

  it("puts the coverage note right under the totals as well, when threads are missing from them", () => {
    const missing = body({ coverage: { countedThreads: 1, partialThreads: 1, uncountedThreads: 2 } });
    assert.equal(count(missing, "so these totals are a lower bound"), 2, "under the totals and in the footer");
    assert.equal(count(missing, "2 threads have not been counted yet"), 2);
    const first = missing.indexOf("so these totals are a lower bound");
    assert.ok(first > missing.indexOf("Caching saved"), "after the totals cards");
    assert.ok(first < missing.indexOf("By model"), "and before everything else");
    const onlyUncounted = body({ coverage: { countedThreads: 1, partialThreads: 0, uncountedThreads: 1 } });
    assert.equal(count(onlyUncounted, "so these totals are a lower bound"), 2);
    const onlyPartial = body({ coverage: { countedThreads: 1, partialThreads: 1, uncountedThreads: 0 } });
    assert.equal(count(onlyPartial, "so these totals are a lower bound"), 2);
  });

  it("keeps the totals clean when nothing is missing", () => {
    for (const coverage of [undefined, { countedThreads: 3, partialThreads: 0, uncountedThreads: 0 }]) {
      const markup = body(coverage ? { coverage } : {});
      assert.equal(count(markup, "so these totals are a lower bound"), 0);
      assert.equal(count(markup, "Counts the model calls Ancilla has seen."), 1, "only the footer says what is counted");
    }
  });
});

describe("usage page: how old the numbers are", () => {
  const at = Date.parse("2026-09-15T12:00:00.000Z");
  const shown = loadSucceeded(report([bucket(SPARK, 1)]), at);
  const age = (load: UsageLoad, now: number) => render(createElement(UpdatedAge, { load, now }));
  const warning = (load: UsageLoad, now: number) => render(createElement(RefreshFailed, { load, now, onRetry: () => {} }));

  it("shows how old the report on screen is, and nothing before the first read", () => {
    assert.match(age(shown, at + 3 * 60_000), />Updated 3 min ago</);
    assert.match(age(shown, at + 10_000), />Updated just now</);
    assert.equal(age(NO_LOAD, at), "");
    assert.equal(age({ ...NO_LOAD, error: "offline" }, at), "");
  });

  it("warns, with a Retry, when a quiet refresh failed and the numbers are older than they look", () => {
    const failed = loadFailed(shown, true, "offline");
    const html = warning(failed, at + 3 * 60_000);
    assert.match(html, /Could not refresh; showing numbers from 3 min ago/);
    assert.match(html, />Retry<\/button>/);
    assert.match(html, /role="status"/);
    assert.match(age(failed, at + 3 * 60_000), /text-warn-text[^>]*>Updated 3 min ago</, "the age beside the buttons turns warn-toned too");
  });

  it("shows the warning's Retry as working while a quiet retry is in flight, and keeps the numbers it warns about", () => {
    const failed = loadFailed(shown, true, "offline");
    const idle = warning(failed, at + 3 * 60_000);
    assert.doesNotMatch(idle, /aria-busy/);
    assert.doesNotMatch(idle, /<button[^>]* disabled=""/);
    const busy = render(createElement(RefreshFailed, { load: failed, now: at + 3 * 60_000, busy: true, onRetry: () => {} }));
    assert.match(busy, /<button[^>]*aria-busy="true"/);
    assert.match(busy, /<button[^>]* disabled=""/);
    assert.match(busy, /Could not refresh; showing numbers from 3 min ago/, "the warning stays while it works");
    // A retry that fails again goes through the same quiet path: the report, its age and the flag all stay.
    const again = loadFailed(failed, true, "offline");
    assert.equal(again.report, shown.report);
    assert.equal(again.loadedAt, at);
    assert.equal(again.refreshFailed, true);
    assert.equal(again.error, null);
  });

  it("says nothing while the numbers are current, and again once the next read lands", () => {
    assert.equal(warning(shown, at + 3 * 60_000), "");
    assert.equal(warning(NO_LOAD, at), "");
    const failed = loadFailed(shown, true, "offline");
    assert.equal(warning(loadSucceeded(report([bucket(SPARK, 2)]), at + 4 * 60_000), at + 4 * 60_000), "");
    assert.notEqual(warning(failed, at + 4 * 60_000), "");
  });
});

describe("usage page: the thread list", () => {
  const sessionsOf = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, {}]));
  const buttons = (markup: string) => markup.match(/<button[\s\S]*?<\/button>/g) ?? [];

  it("lists the top threads and says what it cut, with the others' cost", () => {
    const many = Array.from({ length: 12 }, (_, index) => thread(`t${index}`, SPARK, index + 1));
    const view = summarize(report([bucket(SPARK, 78)], many), [], NOW);
    const markup = render(createElement(Threads, { view, sessions: sessionsOf(...many.map((t) => t.sessionId)), sessionsLoaded: true }));
    assert.equal(buttons(markup).length, TOP_THREADS);
    assert.match(markup, /Showing top 8 of 12 threads, others \$\d/);
    assert.match(markup, /Costliest threads/);
  });

  it("puts a thread with no priced calls in the list, with a dash, not a zero", () => {
    const view = summarize(report([bucket(SPARK, 12), bucket(WONDER_FULL, 5)], [thread("a", SPARK, 12), thread("b", WONDER_FULL, 5)]), [], NOW);
    const markup = render(createElement(Threads, { view, sessions: sessionsOf("a", "b"), sessionsLoaded: true }));
    assert.match(markup, />—<\/span>/);
    assert.doesNotMatch(markup, /\$0\b/);
    assert.match(markup, /Costliest threads/);
  });

  it("lists by tokens when nothing is priced", () => {
    const markup = render(createElement(Threads, { view: unpricedOnly, sessions: sessionsOf("b"), sessionsLoaded: true }));
    assert.match(markup, /Busiest threads/);
    assert.match(markup, /\d+(\.\d+)?[kM] tokens<\/span>/);
  });

  it("opens a thread that is in the list, and says so for one that is not", () => {
    const view = summarize(report([bucket(SPARK, 3)], [thread("kept", SPARK, 2), thread("gone", SPARK, 1)]), [], NOW);
    const markup = render(createElement(Threads, { view, sessions: sessionsOf("kept"), sessionsLoaded: true }));
    assert.equal(buttons(markup).length, 1);
    assert.match(markup, /not in your thread list/);
    assert.equal(markup.match(/not in your thread list/g)?.length, 1);
  });

  it("opens every real thread until the thread list has loaded, and says nothing about its absence", () => {
    const view = summarize(report([bucket(SPARK, 3)], [thread("kept", SPARK, 2), thread("gone", SPARK, 1)]), [], NOW);
    const markup = render(createElement(Threads, { view, sessions: {}, sessionsLoaded: false }));
    assert.equal(buttons(markup).length, 2);
    assert.doesNotMatch(markup, /not in your thread list/);
  });

  it("shows the folded research row as no thread, with nothing to click", () => {
    const research = thread("research-workers:/work/app", SPARK, 3, { kind: "research", title: "DeepResearch workers" });
    const view = summarize(report([bucket(SPARK, 3)], [research]), [], NOW);
    for (const sessionsLoaded of [true, false]) {
      const markup = render(createElement(Threads, { view, sessions: sessionsOf(research.sessionId), sessionsLoaded }));
      assert.match(markup, /DeepResearch workers/);
      assert.match(markup, /not a thread/);
      assert.equal(buttons(markup).length, 0);
    }
  });

  it("puts no second tab stop inside a row's button, and keeps one on a row that is no button", () => {
    const partly = thread("partly", SPARK, 4, {
      modelIds: [SPARK, WONDER_FULL],
      models: [
        { modelId: SPARK, calls: 3, promptTokens: 300_000, outputTokens: 30_000, cachedTokens: 120_000 },
        { modelId: WONDER_FULL, calls: 1, promptTokens: 100_000, outputTokens: 10_000, cachedTokens: 40_000 },
      ],
    });
    const view = summarize(report([bucket(SPARK, 3), bucket(WONDER_FULL, 1)], [partly]), [], NOW);
    assert.equal(view.threads[0]?.unpricedCalls, 1);

    const open = render(createElement(Threads, { view, sessions: sessionsOf("partly"), sessionsLoaded: true }));
    assert.equal(buttons(open).length, 1);
    assert.match(open, /≥ \$\d/, "the row still reads as a lower bound");
    assert.ok(buttons(open).every((button) => !/tabindex/i.test(button)), "nothing focusable is nested in the button");

    const plain = render(createElement(Threads, { view, sessions: {}, sessionsLoaded: true }));
    assert.equal(buttons(plain).length, 0);
    assert.match(plain, /<span tabindex="0"[^>]*>≥ \$\d/, "the value itself is the tab stop when there is no button");
  });
});
