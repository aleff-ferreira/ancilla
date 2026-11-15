import type { ModelOption, UsageBucket, UsageCoverage, UsageReport, UsageThread } from "../types.js";
import { formatTokens } from "./format.js";
import { costOf, formatCost, priceOf, type TokenPrice } from "./pricing.js";
import { atLeast, LOWER_BOUND, noPriceReason, NO_VALUE, unpricedWhy } from "./usage-labels.js";
import { isUnrecordedModel } from "./usage.js";
import { fillUsageDays, localDay } from "./usage-range.js";

/**
 * The Usage page's numbers: the server's day and thread aggregates with prices put on them. Everything here is
 * pure so the rules (what a call with no price does to a total, what the thread list leaves out, what the report
 * does not cover) are tested without rendering the page.
 */

/** How many threads the page lists; the rest are folded into one line. */
export const TOP_THREADS = 8;

/** A silent refresh of the page, in milliseconds. */
export const USAGE_REFRESH_MS = 60_000;

// The dash for a row with no price and the floor mark are shared with the thread panels, so one spelling is used
// everywhere (see usage-labels.ts); they stay importable from here.
export { LOWER_BOUND, NO_VALUE };

/** The line under the totals when the thread list spans more than one login. */
export const ACCOUNTS_NOTE = "Totals include every account";

/** Calls that no counter here can see: one-shot calls are made outside any thread. */
export const ONE_SHOT_NOTE = "One-shot title and DeepResearch exec calls are not included.";

/**
 * The ledger is fed by each thread's own model calls. A subagent or workflow agent reports its usage on its own
 * item, which never reaches it, so what those agents spent is in no figure on the page.
 */
export const AGENT_SPEND_NOTE = "Spend of subagents and workflow agents is not included.";

/** Everything the page never counts, in the one sentence pair its coverage line always ends with. */
export const NOT_COUNTED_NOTE = `${ONE_SHOT_NOTE} ${AGENT_SPEND_NOTE}`;

export interface ModelRow {
  modelId: string;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Prompt plus output: what the charts scale by when no call in the window has a price. */
  tokens: number;
  /** Dollars at the model's price; 0 for a model with none, so read `price` to tell the two apart. */
  cost: number;
  price: TokenPrice | null;
  /** Every call of a model with no price, none of one with a price. */
  unpricedCalls: number;
  contributor: boolean;
}

export interface DayRow {
  day: string;
  calls: number;
  cost: number;
  tokens: number;
  unpricedCalls: number;
  byModel: { modelId: string; cost: number; tokens: number }[];
}

export interface ThreadRow extends UsageThread {
  cost: number;
  tokens: number;
  unpricedCalls: number;
  /** Of those, the calls that name no model, which is a different reason for having no price. */
  unpricedUnrecorded: number;
}

export interface UsageView {
  calls: number;
  /** Dollars of the calls that have a price: a lower bound while `unpriced` is above zero. */
  cost: number;
  currency: string;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokens: number;
  modelMs: number;
  /** What the cache saved on the calls that have a price. */
  cacheSaved: number;
  /** Calls with no price. */
  unpriced: number;
  /** Of those, the calls that name no model (the `unknown` bucket): Meta is not the reason they have no price. */
  unpricedUnrecorded: number;
  /** What the charts and rankings scale by: dollars, or tokens when not one call in the window has a price. */
  metric: "cost" | "tokens";
  models: ModelRow[];
  days: DayRow[];
  /** The busiest threads, at most `TOP_THREADS`. */
  threads: ThreadRow[];
  /** Every thread in the window, before the list was cut. */
  threadsTotal: number;
  /** The threads not listed, summed. */
  otherCalls: number;
  otherCost: number;
  otherTokens: number;
  otherUnpricedCalls: number;
  /** The zone the report's days are in; undefined for a report that names none (older server, demo), whose days are UTC. */
  tz: string | undefined;
  /** The day it is now in the report's zone, so the chart can mark its last bar as still counting. */
  today: string;
  coverage: UsageCoverage | null;
  /** Threads from more than one login are in the totals. */
  allAccounts: boolean;
}

interface Share {
  modelId: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** Each model's own share of a thread, so a thread that moved between tiers is not priced at one flat rate. */
function sharesOf(thread: UsageThread): Share[] {
  return (
    thread.models ?? [
      {
        modelId: thread.modelIds[0] ?? "",
        calls: thread.calls,
        promptTokens: thread.promptTokens,
        outputTokens: thread.outputTokens,
        cachedTokens: thread.cachedTokens,
      },
    ]
  );
}

function bucketCost(bucket: UsageBucket, price: TokenPrice | null): number {
  if (!price) {
    return 0;
  }
  return costOf(price, { promptTokens: bucket.promptTokens, outputTokens: bucket.outputTokens, cachedTokens: bucket.cachedTokens });
}

function threadRow(thread: UsageThread, models: readonly ModelOption[]): ThreadRow {
  let cost = 0;
  let unpricedCalls = 0;
  let unpricedUnrecorded = 0;
  for (const share of sharesOf(thread)) {
    const price = priceOf(share.modelId, models);
    if (price) {
      cost += costOf(price, { promptTokens: share.promptTokens, outputTokens: share.outputTokens, cachedTokens: share.cachedTokens });
    } else {
      unpricedCalls += share.calls;
      if (isUnrecordedModel(share.modelId)) {
        unpricedUnrecorded += share.calls;
      }
    }
  }
  return { ...thread, cost, tokens: thread.promptTokens + thread.outputTokens, unpricedCalls, unpricedUnrecorded };
}

export function summarize(report: UsageReport, models: readonly ModelOption[], now: Date = new Date()): UsageView {
  const byModel = new Map<string, ModelRow>();
  const byDay = new Map<string, DayRow>();
  let cost = 0;
  let calls = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let modelMs = 0;
  let cacheSaved = 0;
  let unpriced = 0;
  let unpricedUnrecorded = 0;
  let currency = "USD";

  for (const bucket of report.buckets) {
    const price = priceOf(bucket.modelId, models);
    const amount = bucketCost(bucket, price);
    const tokens = bucket.promptTokens + bucket.outputTokens;
    const unpricedCalls = price ? 0 : bucket.calls;
    if (!price) {
      unpriced += bucket.calls;
      if (isUnrecordedModel(bucket.modelId)) {
        unpricedUnrecorded += bucket.calls;
      }
    } else {
      currency = price.currency;
      cacheSaved += (bucket.cachedTokens * (price.input - price.cached)) / 1_000_000;
    }
    cost += amount;
    calls += bucket.calls;
    promptTokens += bucket.promptTokens;
    cachedTokens += bucket.cachedTokens;
    outputTokens += bucket.outputTokens;
    reasoningTokens += bucket.reasoningTokens;
    modelMs += bucket.durationMs;

    const row = byModel.get(bucket.modelId) ?? {
      modelId: bucket.modelId,
      calls: 0,
      promptTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      tokens: 0,
      cost: 0,
      price,
      unpricedCalls: 0,
      contributor: /contributor/i.test(bucket.modelId),
    };
    row.calls += bucket.calls;
    row.promptTokens += bucket.promptTokens;
    row.cachedTokens += bucket.cachedTokens;
    row.outputTokens += bucket.outputTokens;
    row.reasoningTokens += bucket.reasoningTokens;
    row.tokens += tokens;
    row.cost += amount;
    row.unpricedCalls += unpricedCalls;
    byModel.set(bucket.modelId, row);

    const day = byDay.get(bucket.day) ?? { day: bucket.day, calls: 0, cost: 0, tokens: 0, unpricedCalls: 0, byModel: [] };
    day.calls += bucket.calls;
    day.cost += amount;
    day.tokens += tokens;
    day.unpricedCalls += unpricedCalls;
    const slice = day.byModel.find((s) => s.modelId === bucket.modelId);
    if (slice) {
      slice.cost += amount;
      slice.tokens += tokens;
    } else {
      day.byModel.push({ modelId: bucket.modelId, cost: amount, tokens });
    }
    byDay.set(bucket.day, day);
  }

  // When nothing in the window has a price, dollars say nothing: everything is ranked and drawn by tokens.
  const metric: UsageView["metric"] = calls > 0 && unpriced >= calls ? "tokens" : "cost";
  const modelRows = [...byModel.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || b.calls - a.calls);

  // Cut after every thread is priced, so what the list leaves out is still counted and can be said.
  const priced = report.threads.map((thread) => threadRow(thread, models)).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const listed = priced.slice(0, TOP_THREADS);
  const others = priced.slice(TOP_THREADS);

  return {
    calls,
    cost,
    currency,
    promptTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    tokens: promptTokens + outputTokens,
    modelMs,
    cacheSaved,
    unpriced,
    unpricedUnrecorded,
    metric,
    models: modelRows,
    days: fillUsageDays(
      [...byDay.values()],
      report,
      (day) => ({ day, calls: 0, cost: 0, tokens: 0, unpricedCalls: 0, byModel: [] }),
      now,
    ),
    threads: listed,
    threadsTotal: priced.length,
    otherCalls: others.reduce((sum, thread) => sum + thread.calls, 0),
    otherCost: others.reduce((sum, thread) => sum + thread.cost, 0),
    otherTokens: others.reduce((sum, thread) => sum + thread.tokens, 0),
    otherUnpricedCalls: others.reduce((sum, thread) => sum + thread.unpricedCalls, 0),
    tz: report.tz,
    today: localDay(now, report.tz),
    coverage: report.coverage ?? null,
    allAccounts: new Set(report.threads.map((thread) => thread.accountId ?? null)).size > 1,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Dollars for something that may hold calls with no price: the plain amount when every call has one, a lower
 * bound (`≥ $1.20`) when some do not, and a dash when none do, since a figure there would be a made-up zero.
 */
export function costBound(amount: number, currency: string, unpricedCalls: number, calls: number): string {
  if (unpricedCalls <= 0) {
    return formatCost(amount, currency);
  }
  if (unpricedCalls >= calls) {
    return NO_VALUE;
  }
  return atLeast(formatCost(amount, currency));
}

/**
 * What to call calls with no price. A call that names no model has none because there is no model to look up, not
 * because Meta publishes none, so when every unpriced call is of that kind the "published" goes.
 */
function noPriceClause(count: number, unrecorded: number): string {
  return unrecorded > 0 && unrecorded >= count ? "no price" : "no published price";
}

/**
 * Why calls have no price: the reason for each cause that applies. `unpriced` counts the calls with no price and
 * `unrecorded` the ones among them that name no model, so a report with only such calls is not explained as a
 * model Meta does not price, and one with both says both.
 */
export function unpricedReason(unpriced: number, unrecorded: number = 0): string {
  return unpricedWhy({ unpricedModel: unpriced > unrecorded, unknownModel: unrecorded > 0 });
}

/** The totals card line for calls that cannot be priced. */
export function unpricedCallsNote(count: number, unrecorded: number = 0): string {
  return `${plural(count, "call has", "calls have")} ${noPriceClause(count, unrecorded)}`;
}

/** The note under the cost chart: what its bars leave out. */
export function excludedCallsNote(count: number, unrecorded: number = 0): string {
  return `excludes ${plural(count, "call", "calls")} with ${noPriceClause(count, unrecorded)}`;
}

/** The tooltip that explains a missing price, for the places that say it in a few words. */
export function noPriceTip(count: number, unrecorded: number = 0): string {
  return `${unpricedCallsNote(count, unrecorded)}. ${unpricedReason(count, unrecorded)}.`;
}

/** The line under a model that has no price: why, in the words that fit its id. */
export function noPriceCaption(modelId: string): string {
  return `${isUnrecordedModel(modelId) ? "no price" : "no published price"}. ${noPriceReason(modelId)}`;
}

/** How a thread's calls split between priced and not, or null when every call is priced. */
export function threadPriceNote(thread: Pick<ThreadRow, "calls" | "unpricedCalls"> & { unpricedUnrecorded?: number }): string | null {
  if (thread.unpricedCalls <= 0) {
    return null;
  }
  const unrecorded = thread.unpricedUnrecorded ?? 0;
  return `${thread.unpricedCalls} of ${plural(thread.calls, "call has", "calls have")} ${noPriceClause(thread.unpricedCalls, unrecorded)}. ${unpricedReason(thread.unpricedCalls, unrecorded)}.`;
}

/** What the thread list is cut to, or null when it shows every thread. */
export function threadsCutNote(view: UsageView): string | null {
  if (view.threadsTotal <= view.threads.length) {
    return null;
  }
  const others =
    view.metric === "tokens"
      ? `${formatTokens(view.otherTokens)} tokens`
      : costBound(view.otherCost, view.currency, view.otherUnpricedCalls, view.otherCalls);
  return `Showing top ${view.threads.length} of ${view.threadsTotal} threads, others ${others}`;
}

/**
 * What the totals do not cover, or null when the report says nothing is missing. A thread read back in part has
 * lost its oldest calls; a thread nobody has opened since it ran has none counted, and opening it counts it.
 */
export function coverageNote(coverage: UsageCoverage | null | undefined): string | null {
  if (!coverage) {
    return null;
  }
  const partial = Math.max(0, Math.round(coverage.partialThreads) || 0);
  const uncounted = Math.max(0, Math.round(coverage.uncountedThreads) || 0);
  const parts: string[] = [];
  if (partial > 0) {
    parts.push(`${plural(partial, "thread", "threads")} could only be read back in part`);
  }
  if (uncounted > 0) {
    parts.push(`${plural(uncounted, "thread has", "threads have")} not been counted yet`);
  }
  if (parts.length === 0) {
    return null;
  }
  const clear = uncounted > 0 ? " Open a thread to count it." : "";
  return `${parts.join(" and ")}, so these totals are a lower bound.${clear} ${NOT_COUNTED_NOTE}`;
}

/** The coverage line the page always shows: the report's own note when it has one, else what is never counted. */
export function coverageText(coverage: UsageCoverage | null | undefined): string {
  return coverageNote(coverage) ?? `Counts the model calls Ancilla has seen. ${NOT_COUNTED_NOTE}`;
}

/**
 * A thread row opens its thread only when the thread is in the sidebar's list. The folded DeepResearch row is no
 * thread, and an archived thread is not in the list, so a click on either would only land on the home screen. Until
 * the list has loaded it names no thread's absence, so every real thread's row opens (the route guard waits for the
 * list the same way).
 */
export function threadOpenable(
  thread: Pick<UsageThread, "sessionId" | "kind">,
  sessions: Readonly<Record<string, unknown>>,
  sessionsLoaded: boolean = true,
): boolean {
  return thread.kind !== "research" && (!sessionsLoaded || Object.prototype.hasOwnProperty.call(sessions, thread.sessionId));
}

/**
 * Whether the page should read the report again quietly: only while it is on screen, and only when what it shows
 * is at least `minAgeMs` old (a minute by default), so flipping back to the tab does not refetch every time.
 */
export function shouldRefresh(visibility: string, lastLoadedAt: number | null, now: number, minAgeMs: number = USAGE_REFRESH_MS): boolean {
  if (visibility !== "visible") {
    return false;
  }
  return lastLoadedAt === null || now - lastLoadedAt >= minAgeMs;
}

/** What the page holds between loads: the report on screen and how old it is, or why there is none. */
export interface UsageLoad {
  report: UsageReport | null;
  error: string | null;
  /** When `report` was last read successfully, in milliseconds since the epoch; null while there is no report. */
  loadedAt: number | null;
  /** A quiet refresh failed after that read: the report stays on screen, and the page says how old it is. */
  refreshFailed: boolean;
}

/** The page before its first read, and after a range change or Retry clears it to the spinner. */
export const NO_LOAD: UsageLoad = { report: null, error: null, loadedAt: null, refreshFailed: false };

/** A good read: the report, the moment it was read, and no failed refresh since. */
export function loadSucceeded(report: UsageReport, now: number): UsageLoad {
  return { report, error: null, loadedAt: now, refreshFailed: false };
}

/**
 * A failed load. A quiet refresh that fails keeps the report already on screen, since the numbers are still right
 * as of the last good read, and sets `refreshFailed` so the page says they are not new; a load the user waits on
 * shows the error and its Retry.
 */
export function loadFailed(current: UsageLoad, silent: boolean, message: string): UsageLoad {
  if (silent && current.report) {
    return current.refreshFailed ? current : { ...current, refreshFailed: true };
  }
  return { report: null, error: message, loadedAt: null, refreshFailed: false };
}

/** How long ago a read was, for the line beside the range buttons: `just now`, `3 min ago`, `2 h ago`, `3 days ago`. */
export function usageAge(loadedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - loadedAt) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} days ago`;
}

/** The muted line beside the range buttons: when the numbers on screen were read; null while there are none. */
export function updatedLabel(load: UsageLoad, now: number): string | null {
  return load.report && load.loadedAt !== null ? `Updated ${usageAge(load.loadedAt, now)}` : null;
}

/** The warning when a quiet refresh failed and the page is showing an older read; null otherwise. */
export function refreshFailedNote(load: UsageLoad, now: number): string | null {
  return load.report && load.loadedAt !== null && load.refreshFailed
    ? `Could not refresh; showing numbers from ${usageAge(load.loadedAt, now)}`
    : null;
}
