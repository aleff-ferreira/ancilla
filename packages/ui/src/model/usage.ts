import type { ContextUsage, ModelOption, MspItem, TokenUsage } from "../types.js";
import { HIDDEN_KINDS, type CallUsage, type ThreadFold, type TurnInfo } from "./fold.js";
import { diffStats, extractDiff, formatCompactTokens, formatTokensPerSecond, modelDisplayName } from "./format.js";
import { costOf, priceOf } from "./pricing.js";

/**
 * Context and session usage for the composer's context panel. Muse reports the context total,
 * every model call's token counts and the catalog prices; how the context splits between
 * prompts, replies and tool output is estimated here from the thread's own text.
 */

/** About four characters per token for English and code. Only feeds the estimated split. */
const CHARS_PER_TOKEN = 4;

export type SliceKey = "prompts" | "replies" | "tools" | "subagents" | "summary" | "system";

export interface ContextSlice {
  key: SliceKey;
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  /** Muse's own count of the tokens in context. */
  used: number;
  window: number | null;
  pressure: string;
  /** How `used` splits, in a fixed order so the bar keeps its colors as it grows. */
  slices: ContextSlice[];
  free: number | null;
}

const SLICE_LABELS: Record<SliceKey, string> = {
  prompts: "Your messages",
  replies: "Muse's replies",
  tools: "Tool calls and results",
  subagents: "Subagent results",
  summary: "Compacted summary",
  system: "System prompt and tools",
};

function estimate(text: string | null | undefined): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/** The items still in the model's context: everything after the latest installed compaction. */
function inContext(fold: ThreadFold): { items: MspItem[]; summary: MspItem | null } {
  let start = 0;
  let summary: MspItem | null = null;
  fold.order.forEach((id, index) => {
    const item = fold.items[id];
    if (item?.kind === "compaction" && item.outcome === "compacted") {
      start = index + 1;
      summary = item;
    }
  });
  const items: MspItem[] = [];
  for (const id of fold.order.slice(start)) {
    const item = fold.items[id];
    if (item && !HIDDEN_KINDS.has(item.kind) && !item.retracted) {
      items.push(item);
    }
  }
  return { items, summary };
}

/** The pressure of a reading Ancilla estimated itself: Muse said nothing about how full the context is. */
export const ESTIMATED_PRESSURE = "unknown";

/**
 * What a compaction left in context, when one came after the last work of the call's turn. Calls carry no
 * time and items carry no cursor, so "after" is the place in the transcript: past the turn's last item that
 * is not a compaction. A call whose turn has no items yet counts any compaction as after it.
 */
function tokensAfterCompaction(fold: ThreadFold, call: CallUsage): number | null {
  if (!call.turnId) {
    return null;
  }
  let anchor = -1;
  fold.order.forEach((id, index) => {
    const item = fold.items[id];
    if (item && item.kind !== "compaction" && item.turnId === call.turnId) {
      anchor = index;
    }
  });
  for (let index = fold.order.length - 1; index > anchor; index -= 1) {
    const item = fold.items[fold.order[index] as string];
    if (item?.kind === "compaction" && item.outcome === "compacted" && typeof item.tokensAfter === "number") {
      return item.tokensAfter;
    }
  }
  return null;
}

/**
 * The context reading to show. Live streams report it directly, and Muse's own reading wins untouched: a
 * missing window stays missing, because the schema says it is never invented. A thread opened from history
 * only has its model calls, so the latest call's occupancy stands in, sized by the model's catalog limit. That
 * reading is an estimate and says so with `pressure: "unknown"`, which no consumer may read as Muse's word.
 */
export function contextUsageOf(fold: ThreadFold, models: readonly ModelOption[]): ContextUsage | null {
  if (fold.meta.contextUsage) {
    return fold.meta.contextUsage;
  }
  const calls = Object.values(fold.meta.calls);
  const last = calls[calls.length - 1];
  if (!last) {
    return null;
  }
  const modelId = last.modelId ?? fold.meta.modelId;
  const window = models.find((m) => m.modelId === modelId)?.contextLimit ?? undefined;
  const used = tokensAfterCompaction(fold, last) ?? last.promptTokens + last.outputTokens;
  return { usedTokens: used, windowTokens: window, pressure: ESTIMATED_PRESSURE };
}

export function contextBreakdown(fold: ThreadFold, models: readonly ModelOption[]): ContextBreakdown | null {
  const usage = contextUsageOf(fold, models);
  if (!usage) {
    return null;
  }
  const { items, summary } = inContext(fold);
  const raw: Record<Exclude<SliceKey, "system">, number> = {
    prompts: 0,
    replies: 0,
    tools: 0,
    subagents: 0,
    summary: summary?.tokensAfter ?? 0,
  };
  for (const item of items) {
    if (item.kind === "userMessage") {
      raw.prompts += estimate(item.displayText ?? item.text);
    } else if (item.kind === "agentMessage") {
      raw.replies += estimate(item.text);
    } else if (item.kind === "toolCall") {
      raw.tools += estimate(item.args) + estimate(item.visibleOutput);
    } else if (item.kind === "userShell") {
      raw.tools += estimate(item.commandText) + estimate(item.visibleOutput);
    } else if (item.kind === "subagent") {
      raw.subagents += estimate(item.result?.summary ?? item.result?.text ?? item.objective);
    }
  }
  const used = usage.usedTokens;
  const counted = Object.values(raw).reduce((total, value) => total + value, 0);
  // The estimate can overshoot what Muse counted (text the model never saw in full); shrink it to fit.
  const scale = counted > used && counted > 0 ? used / counted : 1;
  const slices: ContextSlice[] = [];
  let explained = 0;
  for (const key of ["prompts", "replies", "tools", "subagents", "summary"] as const) {
    const tokens = Math.round(raw[key] * scale);
    if (tokens > 0) {
      slices.push({ key, label: SLICE_LABELS[key], tokens });
      explained += tokens;
    }
  }
  // Whatever the thread's text does not explain is the system prompt, tool definitions and memory.
  const system = Math.max(0, used - explained);
  if (system > 0) {
    slices.push({ key: "system", label: SLICE_LABELS.system, tokens: system });
  }
  const window = usage.windowTokens ?? null;
  return { used, window, pressure: usage.pressure, slices, free: window === null ? null : Math.max(0, window - used) };
}

/** Calls with this few output tokens say nothing about speed, as in opencode's gateway. */
const MIN_SPEED_TOKENS = 10;
/** Shorter generation windows are too noisy to report. */
const MIN_SPEED_MS = 100;

export interface TurnSpeed {
  tokensPerSecond: number;
  outputTokens: number;
  generationMs: number;
}

/**
 * The calls that say something about speed: ones that reported a time above zero and wrote more than ten
 * tokens. A call timed at 0 ms carries tokens but no time, and a tool-call-only step carries seconds of latency
 * but almost no tokens, so either would skew the quotient. Every speed in the app divides over these calls.
 */
export function speedCalls(calls: readonly CallUsage[]): CallUsage[] {
  return calls.filter((call) => call.outputTokens > MIN_SPEED_TOKENS && (call.durationMs ?? 0) > 0);
}

/** Output tokens over model time across the speed calls, or null when too little time was measured. */
function measureSpeed(calls: readonly CallUsage[]): TurnSpeed | null {
  let tokens = 0;
  let generation = 0;
  for (const call of speedCalls(calls)) {
    tokens += call.outputTokens;
    generation += call.durationMs ?? 0;
  }
  if (tokens === 0 || generation < MIN_SPEED_MS) {
    return null;
  }
  return { tokensPerSecond: (tokens / generation) * 1000, outputTokens: tokens, generationMs: generation };
}

/**
 * A finished turn's output speed, measured the way opencode's gateway measures each model call:
 * output tokens (reasoning included, as Muse counts it) over the time the model spent producing
 * them, ignoring calls of ten tokens or fewer. The time is each counted call's own wall time, so
 * tool runs between calls never count. Muse's time to first token cannot be taken off: it runs from
 * the turn's start to its first visible text, across calls and tool runs, not per call.
 */
export function turnSpeed(fold: ThreadFold, turnId: string): TurnSpeed | null {
  return measureSpeed(Object.values(fold.meta.calls).filter((call) => call.turnId === turnId));
}

/** Every finished turn's speed, by turn id. */
export function turnSpeeds(fold: ThreadFold): Record<string, TurnSpeed> {
  const speeds: Record<string, TurnSpeed> = {};
  for (const turnId of new Set(Object.values(fold.meta.calls).map((call) => call.turnId))) {
    if (turnId && turnId !== fold.activeTurnId) {
      const speed = turnSpeed(fold, turnId);
      if (speed) {
        speeds[turnId] = speed;
      }
    }
  }
  return speeds;
}

/** The most recent finished turn that has a speed. */
export function lastTurnSpeed(fold: ThreadFold): TurnSpeed | null {
  const calls = Object.values(fold.meta.calls);
  const seen = new Set<string>();
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const turnId = calls[index]?.turnId;
    if (!turnId || seen.has(turnId) || turnId === fold.activeTurnId) {
      continue;
    }
    seen.add(turnId);
    const speed = turnSpeed(fold, turnId);
    if (speed) {
      return speed;
    }
  }
  return null;
}

/** A call Muse sent without a model id, or with the placeholder id sessionUsage groups such calls under. */
export function isUnrecordedModel(modelId: string | null | undefined): boolean {
  return !modelId || modelId === "unknown";
}

/** Why some calls have no price: they named a model nobody publishes a price for, or named no model at all. */
export interface PriceCause {
  /** A call ran on a model with no listed price. */
  unpricedModel: boolean;
  /** A call carries no model id, so no price could be looked up for it. */
  unknownModel: boolean;
}

export interface TurnCost extends PriceCause {
  cost: number;
  currency: string | null;
  /** False when a call ran on a model with no listed price, so the total undercounts. */
  complete: boolean;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** What one turn would have cost at API rates, from the calls it made. */
export function turnCost(fold: ThreadFold, turnId: string, models: readonly ModelOption[]): TurnCost | null {
  let cost = 0;
  let priced = 0;
  let calls = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let unpricedModel = false;
  let unknownModel = false;
  let currency: string | null = null;
  for (const call of Object.values(fold.meta.calls)) {
    if (call.turnId !== turnId) {
      continue;
    }
    calls += 1;
    const cached = cacheReads(call);
    promptTokens += call.promptTokens;
    cachedTokens += cached;
    outputTokens += call.outputTokens;
    reasoningTokens += call.reasoningTokens;
    const price = priceOf(call.modelId, models);
    if (price) {
      cost += costOf(price, { promptTokens: call.promptTokens, outputTokens: call.outputTokens, cachedTokens: cached });
      priced += 1;
      currency = currency ?? price.currency;
    } else if (isUnrecordedModel(call.modelId)) {
      unknownModel = true;
    } else {
      unpricedModel = true;
    }
  }
  if (calls === 0) {
    return null;
  }
  return { cost, currency, complete: priced === calls, unpricedModel, unknownModel, promptTokens, cachedTokens, outputTokens, reasoningTokens };
}

/** What a set of turns would have cost, with whether the figure is a floor because turns or prices are missing. */
export interface TurnsCost extends PriceCause {
  cost: number;
  currency: string | null;
  /** False when a call ran on a model with no listed price. */
  complete: boolean;
  /** The history is truncated and the goal's earlier turns are not all loaded, so their share is missing. */
  partial: boolean;
}

/**
 * The earliest moment anything loaded in the thread happened: its first dated item or turn start. Null when
 * nothing is dated. Work before it is not in the fold, whatever the ids a caller holds say.
 */
export function loadedSince(fold: ThreadFold): number | null {
  let earliest = Number.POSITIVE_INFINITY;
  for (const id of fold.order) {
    const recorded = fold.items[id]?.recordedAt;
    const at = recorded ? Date.parse(recorded) : Number.NaN;
    if (!Number.isNaN(at) && at < earliest) {
      earliest = at;
    }
  }
  for (const turn of Object.values(fold.turns)) {
    if (turn.startedAt !== undefined && turn.startedAt < earliest) {
      earliest = turn.startedAt;
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
}

/**
 * The cost of exactly these turns, as the goal panel prices the work its token count covers. Null when none has a
 * call. A truncated history is missing part of the goal when one of its turns has no loaded call, and also when the
 * goal began (`startedAt`) before the first thing that was loaded: those turns are in neither the ids nor the fold.
 */
export function turnsCost(
  fold: ThreadFold,
  turnIds: readonly string[],
  models: readonly ModelOption[],
  truncated = false,
  startedAt: number | null = null,
): TurnsCost | null {
  let cost = 0;
  let currency: string | null = null;
  let complete = true;
  let unpricedModel = false;
  let unknownModel = false;
  let any = false;
  let missing = false;
  for (const turnId of turnIds) {
    const turn = turnCost(fold, turnId, models);
    if (!turn) {
      missing = true;
      continue;
    }
    any = true;
    cost += turn.cost;
    currency = currency ?? turn.currency;
    complete = complete && turn.complete;
    unpricedModel = unpricedModel || turn.unpricedModel;
    unknownModel = unknownModel || turn.unknownModel;
  }
  if (!any) {
    return null;
  }
  const since = truncated && startedAt !== null ? loadedSince(fold) : null;
  const beforeLoaded = since !== null && startedAt !== null && startedAt < since;
  return { cost, currency, complete, unpricedModel, unknownModel, partial: truncated && (missing || beforeLoaded) };
}

/** Every turn's cost, by turn id. */
export function turnCosts(fold: ThreadFold, models: readonly ModelOption[]): Record<string, TurnCost> {
  const costs: Record<string, TurnCost> = {};
  for (const turnId of new Set(Object.values(fold.meta.calls).map((call) => call.turnId))) {
    if (!turnId) {
      continue;
    }
    const cost = turnCost(fold, turnId, models);
    if (cost) {
      costs[turnId] = cost;
    }
  }
  return costs;
}

/** A rough live speed for the text streaming right now: characters over four, per second of the burst. */
export function streamingSpeed(info: TurnInfo | null | undefined): number | null {
  const stream = info?.stream;
  if (!stream) {
    return null;
  }
  const ms = stream.lastAt - stream.startAt;
  const tokens = stream.chars / CHARS_PER_TOKEN;
  if (ms < 500 || tokens <= MIN_SPEED_TOKENS) {
    return null;
  }
  return (tokens / ms) * 1000;
}

export interface ModelUsage {
  modelId: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  /** Null when the catalog lists no price for this model. */
  cost: number | null;
}

export interface ToolUsage {
  tool: string;
  calls: number;
  /** Estimated from the call's arguments and visible output. */
  tokens: number;
}

export interface SubagentUsage {
  itemId: string;
  label: string;
  tokens: number;
}

export interface CompactionRecord {
  itemId: string;
  trigger: string | null;
  outcome: string | null;
  before: number | null;
  after: number | null;
}

export interface SessionUsage extends PriceCause {
  calls: number;
  /** Counted-once session totals, as Muse reports them; the loaded calls' sums where Muse sent none. */
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** The loaded calls' own sums, for the rows that must not mix scopes with the totals above. */
  loadedPromptTokens: number;
  loadedOutputTokens: number;
  /** Muse sent session totals, or the history is complete, so `totalTokens` is the whole session and not a floor. */
  totalsComplete: boolean;
  /** Raw per-call counters, summed. */
  inputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Prompt tokens served from the cache, summed per call: the one definition every panel shows. */
  cachedReadTokens: number;
  /** Prompt tokens not served from the cache, summed per call, so fresh and cached add up to the loaded prompt. */
  freshTokens: number;
  /** Share of prompt tokens served from the provider's cache; null before any call. */
  cacheHit: number | null;
  modelMs: number;
  models: ModelUsage[];
  /** Estimated from list prices; null when no model used here has one. */
  cost: number | null;
  currency: string | null;
  /** False when some calls ran on a model without a price, so `cost` undercounts. */
  costComplete: boolean;
  /** The calls and turns here are only part of the thread: earlier ones were not loaded. */
  partial: boolean;
  /** Tokens of subagents and workflow agents, which Muse leaves out of its totals; never priced. */
  subagentTokens: number;
  /** Some subagent or workflow agent reported usage, so `cost` and the totals leave their spend out. */
  excludesSubagents: boolean;
  lines: { added: number; removed: number; files: number };
  /** Finished turns that ran. The telemetry pill's count also holds the turn still running. */
  turns: number;
  workedMs: number;
  firstTokenMs: number | null;
  tools: ToolUsage[];
  subagents: SubagentUsage[];
  compactions: CompactionRecord[];
}

/** Cached prompt tokens for one call, whichever counter the provider fills. */
function cacheReads(call: CallUsage): number {
  return Math.min(call.promptTokens, call.cacheReadTokens || call.cachedTokens);
}

/**
 * The cache split of a set of calls, summed one call at a time so a clamp or a missing counter on one call never
 * leaks into another. Muse fills `cachedTokens` and `cacheReadTokens` with the same figure, so they are
 * alternatives, never added.
 */
function cacheSplit(calls: readonly CallUsage[]): { cachedReadTokens: number; freshTokens: number } {
  let cachedReadTokens = 0;
  let freshTokens = 0;
  for (const call of calls) {
    const cached = cacheReads(call);
    cachedReadTokens += cached;
    freshTokens += Math.max(0, call.promptTokens - cached);
  }
  return { cachedReadTokens, freshTokens };
}

/**
 * Whether the loaded calls are only part of the session: the history was cut short, or Muse's cumulative totals
 * are above what the loaded calls add up to (a resumed thread whose call history is unavailable).
 */
export function isPartialHistory(fold: ThreadFold, loadedPrompt: number, loadedOutput: number, truncated: boolean): boolean {
  const totals = fold.meta.tokenTotals;
  return truncated || Boolean(totals && (totals.promptTokens > loadedPrompt || totals.outputTokens > loadedOutput));
}

/**
 * The turns that did work: a prompt the user pulled back (`retracted`, even when its interrupt then ended it as
 * `cancelled`) and one that left the queue unrun (`unqueued`) never did. Both telemetry surfaces count from this;
 * the pill counts the turn still running as well, the panel only the finished ones (`terminal` set).
 */
export function countedTurns(fold: ThreadFold): TurnInfo[] {
  return Object.values(fold.turns).filter((turn) => !turn.retracted && turn.terminal !== "unqueued");
}

/**
 * The newest report of each agent in one workflow run, as the run card counts them: Muse does not say whether a
 * retry's usage covers its earlier attempts, so attempts are never added up. Usage rides one revision only, so
 * the fold's latched traces are read as well as the item.
 */
function workflowAgentUsage(fold: ThreadFold, run: MspItem): TokenUsage[] {
  const newest = new Map<string, { attempt: number; usage: TokenUsage }>();
  const note = (childId: string, attempt: number, usage: TokenUsage | undefined) => {
    if (!usage) {
      return;
    }
    const known = newest.get(childId);
    if (!known || attempt >= known.attempt) {
      newest.set(childId, { attempt, usage });
    }
  };
  for (const child of run.children ?? []) {
    note(child.childId, child.attempt, child.usage);
  }
  for (const [key, trace] of Object.entries(fold.crew?.runs[run.itemId]?.children ?? {})) {
    const cut = key.lastIndexOf(":");
    note(key.slice(0, cut), Number(key.slice(cut + 1)), trace.usage);
  }
  return [...newest.values()].map((entry) => entry.usage);
}

export function sessionUsage(fold: ThreadFold, models: readonly ModelOption[], truncated = false): SessionUsage {
  const calls = Object.values(fold.meta.calls);
  const sum = (pick: (call: CallUsage) => number) => calls.reduce((total, call) => total + pick(call), 0);
  const perCallPrompt = sum((c) => c.promptTokens);
  const perCallOutput = sum((c) => c.outputTokens);
  const partial = isPartialHistory(fold, perCallPrompt, perCallOutput, truncated);
  const cache = cacheSplit(calls);

  const byModel = new Map<string, ModelUsage>();
  let cost = 0;
  let priced = 0;
  let unpricedModel = false;
  let unknownModel = false;
  let currency: string | null = null;
  for (const call of calls) {
    const id = call.modelId ?? "unknown";
    const entry = byModel.get(id) ?? { modelId: id, calls: 0, promptTokens: 0, outputTokens: 0, cost: null };
    entry.calls += 1;
    entry.promptTokens += call.promptTokens;
    entry.outputTokens += call.outputTokens;
    const price = priceOf(call.modelId, models);
    if (price) {
      const callCost = costOf(price, { promptTokens: call.promptTokens, outputTokens: call.outputTokens, cachedTokens: cacheReads(call) });
      entry.cost = (entry.cost ?? 0) + callCost;
      cost += callCost;
      priced += 1;
      currency = currency ?? price.currency;
    } else if (isUnrecordedModel(call.modelId)) {
      unknownModel = true;
    } else {
      unpricedModel = true;
    }
    byModel.set(id, entry);
  }

  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  const tools = new Map<string, ToolUsage>();
  const subagents: SubagentUsage[] = [];
  const compactions: CompactionRecord[] = [];
  let subagentTokens = 0;
  let excludesSubagents = false;
  for (const id of fold.order) {
    const item = fold.items[id];
    if (!item) {
      continue;
    }
    if (item.kind === "toolCall") {
      const diff = extractDiff(item);
      if (diff) {
        const stats = diffStats(diff);
        added += stats.added;
        removed += stats.removed;
        files.add(diff.path ?? item.itemId);
      }
      const name = item.tool ?? "tool";
      const entry = tools.get(name) ?? { tool: name, calls: 0, tokens: 0 };
      entry.calls += 1;
      entry.tokens += estimate(item.args) + estimate(item.visibleOutput);
      tools.set(name, entry);
    } else if (item.kind === "subagent" && item.usage) {
      const tokens = (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0);
      subagents.push({ itemId: item.itemId, label: item.role ?? item.objective ?? "Subagent", tokens });
      subagentTokens += tokens;
      excludesSubagents = true;
    } else if (item.kind === "workflow") {
      for (const usage of workflowAgentUsage(fold, item)) {
        subagentTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        excludesSubagents = true;
      }
    } else if (item.kind === "compaction" && item.status !== "inProgress") {
      compactions.push({
        itemId: item.itemId,
        trigger: item.trigger ?? null,
        outcome: item.outcome ?? null,
        before: item.tokensBefore ?? null,
        after: item.tokensAfter ?? null,
      });
    }
  }

  const turns = countedTurns(fold).filter((turn) => turn.terminal);
  const firstTokens = turns.map((turn) => turn.firstTokenMs).filter((ms): ms is number => typeof ms === "number");
  const totals = fold.meta.tokenTotals;
  return {
    calls: calls.length,
    promptTokens: totals?.promptTokens ?? perCallPrompt,
    outputTokens: totals?.outputTokens ?? perCallOutput,
    totalTokens: totals?.totalTokens ?? perCallPrompt + perCallOutput,
    loadedPromptTokens: perCallPrompt,
    loadedOutputTokens: perCallOutput,
    totalsComplete: totals !== null || !partial,
    inputTokens: sum((c) => c.inputTokens),
    cacheWriteTokens: sum((c) => c.cacheWriteTokens),
    reasoningTokens: sum((c) => c.reasoningTokens),
    cachedReadTokens: cache.cachedReadTokens,
    freshTokens: cache.freshTokens,
    cacheHit: perCallPrompt > 0 ? cache.cachedReadTokens / perCallPrompt : null,
    modelMs: sum((c) => c.durationMs ?? 0),
    models: [...byModel.values()].sort((a, b) => b.promptTokens + b.outputTokens - (a.promptTokens + a.outputTokens)),
    cost: priced > 0 ? cost : null,
    currency,
    costComplete: priced === calls.length,
    unpricedModel,
    unknownModel,
    partial,
    subagentTokens,
    excludesSubagents,
    lines: { added, removed, files: files.size },
    turns: turns.length,
    workedMs: turns.reduce((total, turn) => total + (turn.durationMs ?? 0), 0),
    firstTokenMs: firstTokens.length > 0 ? firstTokens.reduce((a, b) => a + b, 0) / firstTokens.length : null,
    tools: [...tools.values()].sort((a, b) => b.tokens - a.tokens),
    subagents: subagents.sort((a, b) => b.tokens - a.tokens),
    compactions,
  };
}

/** Per-model totals behind the telemetry dialogs, grouped the way sessionUsage groups them. */
export interface TelemetryModelUsage {
  modelId: string;
  /** The model id in display form, e.g. with the contributor tier suffix stripped. */
  name: string;
  calls: number;
  outputTokens: number;
}

/** Live per-thread totals for the telemetry pills above the composer. */
export interface SessionTelemetry {
  /** Call-derived details cover only the loaded history. */
  partial: boolean;
  /** Cumulative tokens when available, otherwise the loaded calls' sum. */
  totalTokens: number;
  totalsComplete: boolean;
  /** Turns that count (see countedTurns), including the one still running. */
  turns: number;
  /** Model calls the session made. */
  steps: number;
  /** Calls that reported a model time above zero; a reported 0 is not a measurement. */
  timedCalls: number;
  /** The model's own time, summed over every call that reported one. */
  durationMs: number;
  /** The same output speed turnSpeed reports, over the whole session; null when no call measures it. */
  tokensPerSecond: number | null;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Uncached input in the loaded calls, using the same cache convention as cacheHitPct. */
  uncachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Share of prompt tokens served from cache, rounded 0–100; null before any prompt tokens. */
  cacheHitPct: number | null;
  models: TelemetryModelUsage[];
}

/**
 * What the telemetry pills show, from the same per-call records sessionUsage reads. The turn count is
 * countedTurns, so a thread mid-turn is counted too (the Context panel's count holds finished turns only); speed
 * comes from the calls turnSpeed uses (speedCalls) across the whole session, and time sums every reported duration.
 */
export function sessionTelemetry(fold: ThreadFold, truncated = false): SessionTelemetry {
  const calls = Object.values(fold.meta.calls);
  let timedCalls = 0;
  let durationMs = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  const byModel = new Map<string, TelemetryModelUsage>();
  for (const call of calls) {
    promptTokens += call.promptTokens;
    outputTokens += call.outputTokens;
    cacheWriteTokens += call.cacheWriteTokens;
    reasoningTokens += call.reasoningTokens;
    if (call.durationMs !== null) {
      durationMs += call.durationMs;
      if (call.durationMs > 0) {
        timedCalls += 1;
      }
    }
    const id = call.modelId ?? "unknown";
    const entry = byModel.get(id) ?? { modelId: id, name: modelDisplayName(id), calls: 0, outputTokens: 0 };
    entry.calls += 1;
    entry.outputTokens += call.outputTokens;
    byModel.set(id, entry);
  }
  const totals = fold.meta.tokenTotals;
  const partial = isPartialHistory(fold, promptTokens, outputTokens, truncated);
  const { cachedReadTokens, freshTokens } = cacheSplit(calls);
  return {
    partial,
    totalTokens: totals?.totalTokens ?? promptTokens + outputTokens,
    totalsComplete: totals !== null || !partial,
    turns: countedTurns(fold).length,
    steps: calls.length,
    timedCalls,
    durationMs,
    tokensPerSecond: measureSpeed(calls)?.tokensPerSecond ?? null,
    promptTokens: totals?.promptTokens ?? promptTokens,
    outputTokens: totals?.outputTokens ?? outputTokens,
    cachedTokens: cachedReadTokens,
    uncachedTokens: freshTokens,
    cacheWriteTokens,
    reasoningTokens,
    cacheHitPct: promptTokens > 0 ? Math.round((cachedReadTokens / promptTokens) * 100) : null,
    models: [...byModel.values()].sort((a, b) => b.outputTokens - a.outputTokens),
  };
}

/** The time pill's label: `3 turns · 8 steps · 62 tok/s`, the speed left off when nothing timed. */
export function timePillLabel(t: SessionTelemetry): string {
  const speed = t.tokensPerSecond === null ? "" : ` · ${formatTokensPerSecond(t.tokensPerSecond)}`;
  const turns = `${t.turns} ${t.turns === 1 ? "turn" : "turns"}`;
  const steps = `${t.steps} ${t.steps === 1 ? "step" : "steps"}`;
  return `${t.partial ? "Partial · " : ""}${turns} · ${steps}${speed}`;
}

/** The usage pill's label: `252K tok · Cache hit 87%`, the cache left off before any prompt tokens. */
export function usagePillLabel(t: SessionTelemetry): string {
  const total = formatCompactTokens(t.totalTokens).toUpperCase();
  const hit = t.partial || t.cacheHitPct === null ? "" : ` · Cache hit ${t.cacheHitPct}%`;
  return `${total}${t.totalsComplete ? "" : "+"} tok${hit}`;
}
