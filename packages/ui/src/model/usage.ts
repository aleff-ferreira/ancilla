import type { ContextUsage, ModelOption, MspItem, TokenUsage } from "../types.js";
import { type CallUsage, HIDDEN_KINDS, type ThreadFold, type TurnInfo } from "./fold.js";
import { diffStats, extractDiff, formatCompactTokens, formatTokensPerSecond, modelDisplayName } from "./format.js";
import { costOf, priceOf } from "./pricing.js";

const APPROX_CHARS_PER_TOKEN = 4;

export type SliceKey = "prompts" | "replies" | "tools" | "subagents" | "summary" | "system";

export interface ContextSlice {
  readonly key: SliceKey;
  readonly label: string;
  readonly tokens: number;
}

export interface ContextBreakdown {
  readonly used: number;
  readonly window: number | null;
  readonly pressure: string;
  readonly slices: ContextSlice[];
  readonly free: number | null;
}

const BREAKDOWN_TITLES: Readonly<Record<SliceKey, string>> = {
  prompts: "Your messages",
  replies: "Muse's replies",
  tools: "Tool calls and results",
  subagents: "Subagent results",
  summary: "Compacted summary",
  system: "System prompt and tools",
};

function estimateTokens(content: string | null | undefined): number {
  return content ? Math.ceil(content.length / APPROX_CHARS_PER_TOKEN) : 0;
}

function extractActiveContext(fold: ThreadFold): { readonly activeItems: MspItem[]; readonly latestSummary: MspItem | null } {
  let startIndex = 0;
  let latestSummary: MspItem | null = null;
  fold.order.forEach((id, idx) => {
    const item = fold.items[id];
    if (item?.kind === "compaction" && item.outcome === "compacted") {
      startIndex = idx + 1;
      latestSummary = item;
    }
  });
  const activeItems: MspItem[] = [];
  for (let i = startIndex; i < fold.order.length; i += 1) {
    const item = fold.items[fold.order[i]!];
    if (item && !HIDDEN_KINDS.has(item.kind) && !item.retracted) {
      activeItems.push(item);
    }
  }
  return { activeItems, latestSummary };
}

export const ESTIMATED_PRESSURE = "unknown";

function compactionTokensAfterTurn(fold: ThreadFold, call: CallUsage): number | null {
  if (!call.turnId) {
    return null;
  }
  let lastTurnItemIndex = -1;
  fold.order.forEach((itemId, idx) => {
    const it = fold.items[itemId];
    if (it && it.kind !== "compaction" && it.turnId === call.turnId) {
      lastTurnItemIndex = idx;
    }
  });
  for (let i = fold.order.length - 1; i > lastTurnItemIndex; i -= 1) {
    const it = fold.items[fold.order[i]!];
    if (it?.kind === "compaction" && it.outcome === "compacted" && typeof it.tokensAfter === "number") {
      return it.tokensAfter;
    }
  }
  return null;
}

export function contextUsageOf(fold: ThreadFold, models: readonly ModelOption[]): ContextUsage | null {
  if (fold.meta.contextUsage) {
    return fold.meta.contextUsage;
  }
  const callList = Object.values(fold.meta.calls);
  const latestCall = callList[callList.length - 1];
  if (!latestCall) {
    return null;
  }
  const targetModelId = latestCall.modelId ?? fold.meta.modelId;
  const matchedModel = models.find((opt) => opt.modelId === targetModelId);
  const contextWindow = matchedModel?.contextLimit ?? undefined;
  const tokensUsed = compactionTokensAfterTurn(fold, latestCall) ?? (latestCall.promptTokens + latestCall.outputTokens);
  return {
    usedTokens: tokensUsed,
    windowTokens: contextWindow,
    pressure: ESTIMATED_PRESSURE,
  };
}

export function contextBreakdown(fold: ThreadFold, models: readonly ModelOption[]): ContextBreakdown | null {
  const usage = contextUsageOf(fold, models);
  if (!usage) {
    return null;
  }
  const { activeItems, latestSummary } = extractActiveContext(fold);
  const bucketCounts: Record<Exclude<SliceKey, "system">, number> = {
    prompts: 0,
    replies: 0,
    tools: 0,
    subagents: 0,
    summary: latestSummary?.tokensAfter ?? 0,
  };
  for (const entry of activeItems) {
    switch (entry.kind) {
      case "userMessage":
        bucketCounts.prompts += estimateTokens(entry.displayText ?? entry.text);
        break;
      case "agentMessage":
        bucketCounts.replies += estimateTokens(entry.text);
        break;
      case "toolCall":
        bucketCounts.tools += estimateTokens(entry.args) + estimateTokens(entry.visibleOutput);
        break;
      case "userShell":
        bucketCounts.tools += estimateTokens(entry.commandText) + estimateTokens(entry.visibleOutput);
        break;
      case "subagent":
        bucketCounts.subagents += estimateTokens(entry.result?.summary ?? entry.result?.text ?? entry.objective);
        break;
    }
  }
  const totalUsed = usage.usedTokens;
  const countedEstimates = Object.values(bucketCounts).reduce((acc, val) => acc + val, 0);
  const scaling = (countedEstimates > totalUsed && countedEstimates > 0) ? totalUsed / countedEstimates : 1;
  const sliceList: ContextSlice[] = [];
  let accountedFor = 0;
  const orderedKeys: readonly (Exclude<SliceKey, "system">)[] = ["prompts", "replies", "tools", "subagents", "summary"];
  for (const k of orderedKeys) {
    const sliceTokens = Math.round(bucketCounts[k] * scaling);
    if (sliceTokens > 0) {
      sliceList.push({ key: k, label: BREAKDOWN_TITLES[k], tokens: sliceTokens });
      accountedFor += sliceTokens;
    }
  }
  const systemRemainder = Math.max(0, totalUsed - accountedFor);
  if (systemRemainder > 0) {
    sliceList.push({ key: "system", label: BREAKDOWN_TITLES.system, tokens: systemRemainder });
  }
  const limitWindow = usage.windowTokens ?? null;
  return {
    used: totalUsed,
    window: limitWindow,
    pressure: usage.pressure,
    slices: sliceList,
    free: limitWindow === null ? null : Math.max(0, limitWindow - totalUsed),
  };
}

const OUTPUT_SPEED_THRESHOLD = 10;
const MIN_SPEED_ELAPSED_MS = 100;

export interface TurnSpeed {
  readonly tokensPerSecond: number;
  readonly outputTokens: number;
  readonly generationMs: number;
}

export function speedCalls(calls: readonly CallUsage[]): CallUsage[] {
  return calls.filter((c) => c.outputTokens > OUTPUT_SPEED_THRESHOLD && (c.durationMs ?? 0) > 0);
}

function calculateSpeedFromCalls(calls: readonly CallUsage[]): TurnSpeed | null {
  const eligible = speedCalls(calls);
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  for (const c of eligible) {
    totalOutputTokens += c.outputTokens;
    totalDurationMs += c.durationMs ?? 0;
  }
  if (totalOutputTokens === 0 || totalDurationMs < MIN_SPEED_ELAPSED_MS) {
    return null;
  }
  return {
    tokensPerSecond: (totalOutputTokens / totalDurationMs) * 1000,
    outputTokens: totalOutputTokens,
    generationMs: totalDurationMs,
  };
}

export function turnSpeed(fold: ThreadFold, turnId: string): TurnSpeed | null {
  const callsForTurn = Object.values(fold.meta.calls).filter((c) => c.turnId === turnId);
  return calculateSpeedFromCalls(callsForTurn);
}

export function turnSpeeds(fold: ThreadFold): Record<string, TurnSpeed> {
  const result: Record<string, TurnSpeed> = {};
  const distinctTurnIds = new Set(Object.values(fold.meta.calls).map((c) => c.turnId));
  for (const id of distinctTurnIds) {
    if (id && id !== fold.activeTurnId) {
      const spd = turnSpeed(fold, id);
      if (spd) {
        result[id] = spd;
      }
    }
  }
  return result;
}

export function lastTurnSpeed(fold: ThreadFold): TurnSpeed | null {
  const callList = Object.values(fold.meta.calls);
  const visitedTurns = new Set<string>();
  for (let i = callList.length - 1; i >= 0; i -= 1) {
    const turnId = callList[i]?.turnId;
    if (!turnId || visitedTurns.has(turnId) || turnId === fold.activeTurnId) {
      continue;
    }
    visitedTurns.add(turnId);
    const spd = turnSpeed(fold, turnId);
    if (spd) {
      return spd;
    }
  }
  return null;
}

export function isUnrecordedModel(modelId: string | null | undefined): boolean {
  return !modelId || modelId === "unknown";
}

export interface PriceCause {
  readonly unpricedModel: boolean;
  readonly unknownModel: boolean;
}

export interface TurnCost extends PriceCause {
  readonly cost: number;
  readonly currency: string | null;
  readonly complete: boolean;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

function extractCachedTokens(call: CallUsage): number {
  return Math.min(call.promptTokens, call.cacheReadTokens || call.cachedTokens);
}

export function turnCost(fold: ThreadFold, turnId: string, models: readonly ModelOption[]): TurnCost | null {
  let aggregatedCost = 0;
  let pricedCallCount = 0;
  let matchingCalls = 0;
  let totalPrompt = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let unpricedModel = false;
  let unknownModel = false;
  let resolvedCurrency: string | null = null;

  for (const call of Object.values(fold.meta.calls)) {
    if (call.turnId !== turnId) {
      continue;
    }
    matchingCalls += 1;
    const cachedTokens = extractCachedTokens(call);
    totalPrompt += call.promptTokens;
    totalCached += cachedTokens;
    totalOutput += call.outputTokens;
    totalReasoning += call.reasoningTokens;
    const modelRate = priceOf(call.modelId, models);
    if (modelRate) {
      aggregatedCost += costOf(modelRate, {
        promptTokens: call.promptTokens,
        outputTokens: call.outputTokens,
        cachedTokens,
      });
      pricedCallCount += 1;
      resolvedCurrency = resolvedCurrency ?? modelRate.currency;
    } else if (isUnrecordedModel(call.modelId)) {
      unknownModel = true;
    } else {
      unpricedModel = true;
    }
  }

  if (matchingCalls === 0) {
    return null;
  }
  return {
    cost: aggregatedCost,
    currency: resolvedCurrency,
    complete: pricedCallCount === matchingCalls,
    unpricedModel,
    unknownModel,
    promptTokens: totalPrompt,
    cachedTokens: totalCached,
    outputTokens: totalOutput,
    reasoningTokens: totalReasoning,
  };
}

export interface TurnsCost extends PriceCause {
  readonly cost: number;
  readonly currency: string | null;
  readonly complete: boolean;
  readonly partial: boolean;
}

export function loadedSince(fold: ThreadFold): number | null {
  let minTimestamp = Number.POSITIVE_INFINITY;
  for (const itemId of fold.order) {
    const itemRecorded = fold.items[itemId]?.recordedAt;
    const parsedTime = itemRecorded ? Date.parse(itemRecorded) : Number.NaN;
    if (!Number.isNaN(parsedTime) && parsedTime < minTimestamp) {
      minTimestamp = parsedTime;
    }
  }
  for (const turn of Object.values(fold.turns)) {
    if (turn.startedAt !== undefined && turn.startedAt < minTimestamp) {
      minTimestamp = turn.startedAt;
    }
  }
  return Number.isFinite(minTimestamp) ? minTimestamp : null;
}

export function turnsCost(
  fold: ThreadFold,
  turnIds: readonly string[],
  models: readonly ModelOption[],
  truncated = false,
  startedAt: number | null = null,
): TurnsCost | null {
  let combinedCost = 0;
  let curr: string | null = null;
  let isComplete = true;
  let hasUnpriced = false;
  let hasUnknown = false;
  let foundAny = false;
  let hasMissing = false;

  for (const tId of turnIds) {
    const c = turnCost(fold, tId, models);
    if (!c) {
      hasMissing = true;
      continue;
    }
    foundAny = true;
    combinedCost += c.cost;
    curr = curr ?? c.currency;
    isComplete = isComplete && c.complete;
    hasUnpriced = hasUnpriced || c.unpricedModel;
    hasUnknown = hasUnknown || c.unknownModel;
  }

  if (!foundAny) {
    return null;
  }

  const earliestLoaded = truncated && startedAt !== null ? loadedSince(fold) : null;
  const startedBeforeHistory = earliestLoaded !== null && startedAt !== null && startedAt < earliestLoaded;

  return {
    cost: combinedCost,
    currency: curr,
    complete: isComplete,
    unpricedModel: hasUnpriced,
    unknownModel: hasUnknown,
    partial: truncated && (hasMissing || startedBeforeHistory),
  };
}

export function turnCosts(fold: ThreadFold, models: readonly ModelOption[]): Record<string, TurnCost> {
  const result: Record<string, TurnCost> = {};
  const uniqueTurns = new Set(Object.values(fold.meta.calls).map((c) => c.turnId));
  for (const tId of uniqueTurns) {
    if (!tId) continue;
    const computed = turnCost(fold, tId, models);
    if (computed) {
      result[tId] = computed;
    }
  }
  return result;
}

export function streamingSpeed(info: TurnInfo | null | undefined): number | null {
  const streamData = info?.stream;
  if (!streamData) {
    return null;
  }
  const elapsedMs = streamData.lastAt - streamData.startAt;
  const tokenCount = streamData.chars / APPROX_CHARS_PER_TOKEN;
  if (elapsedMs < 500 || tokenCount <= OUTPUT_SPEED_THRESHOLD) {
    return null;
  }
  return (tokenCount / elapsedMs) * 1000;
}

export interface ModelUsage {
  readonly modelId: string;
  readonly calls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly cost: number | null;
}

export interface ToolUsage {
  readonly tool: string;
  readonly calls: number;
  readonly tokens: number;
}

export interface SubagentUsage {
  readonly itemId: string;
  readonly label: string;
  readonly tokens: number;
}

export interface CompactionRecord {
  readonly itemId: string;
  readonly trigger: string | null;
  readonly outcome: string | null;
  readonly before: number | null;
  readonly after: number | null;
}

export interface SessionUsage extends PriceCause {
  readonly calls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly loadedPromptTokens: number;
  readonly loadedOutputTokens: number;
  readonly totalsComplete: boolean;
  readonly inputTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly cachedReadTokens: number;
  readonly freshTokens: number;
  readonly cacheHit: number | null;
  readonly modelMs: number;
  readonly models: ModelUsage[];
  readonly cost: number | null;
  readonly currency: string | null;
  readonly costComplete: boolean;
  readonly partial: boolean;
  readonly subagentTokens: number;
  readonly excludesSubagents: boolean;
  readonly lines: { readonly added: number; readonly removed: number; readonly files: number };
  readonly turns: number;
  readonly workedMs: number;
  readonly firstTokenMs: number | null;
  readonly tools: ToolUsage[];
  readonly subagents: SubagentUsage[];
  readonly compactions: CompactionRecord[];
}

function partitionCacheReads(calls: readonly CallUsage[]): { readonly cachedReadTokens: number; readonly freshTokens: number } {
  let cachedTotal = 0;
  let freshTotal = 0;
  for (const c of calls) {
    const cached = extractCachedTokens(c);
    cachedTotal += cached;
    freshTotal += Math.max(0, c.promptTokens - cached);
  }
  return { cachedReadTokens: cachedTotal, freshTokens: freshTotal };
}

export function isPartialHistory(fold: ThreadFold, loadedPrompt: number, loadedOutput: number, truncated: boolean): boolean {
  const totals = fold.meta.tokenTotals;
  return truncated || Boolean(totals && (totals.promptTokens > loadedPrompt || totals.outputTokens > loadedOutput));
}

export function countedTurns(fold: ThreadFold): TurnInfo[] {
  return Object.values(fold.turns).filter((t) => !t.retracted && t.terminal !== "unqueued");
}

function extractWorkflowChildUsage(fold: ThreadFold, runItem: MspItem): TokenUsage[] {
  const latestByChild = new Map<string, { readonly attempt: number; readonly usage: TokenUsage }>();
  const registerAttempt = (childId: string, attempt: number, usage: TokenUsage | undefined) => {
    if (!usage) return;
    const existing = latestByChild.get(childId);
    if (!existing || attempt >= existing.attempt) {
      latestByChild.set(childId, { attempt, usage });
    }
  };
  for (const ch of runItem.children ?? []) {
    registerAttempt(ch.childId, ch.attempt, ch.usage);
  }
  const traceChildren = fold.crew?.runs[runItem.itemId]?.children ?? {};
  for (const [compositeKey, traceObj] of Object.entries(traceChildren)) {
    const separatorIdx = compositeKey.lastIndexOf(":");
    registerAttempt(compositeKey.slice(0, separatorIdx), Number(compositeKey.slice(separatorIdx + 1)), traceObj.usage);
  }
  return [...latestByChild.values()].map((e) => e.usage);
}

export function sessionUsage(fold: ThreadFold, models: readonly ModelOption[], truncated = false): SessionUsage {
  const callList = Object.values(fold.meta.calls);
  const sumProperty = (getter: (call: CallUsage) => number) =>
    callList.reduce((acc, curr) => acc + getter(curr), 0);

  const totalLoadedPrompt = sumProperty((c) => c.promptTokens);
  const totalLoadedOutput = sumProperty((c) => c.outputTokens);
  const partial = isPartialHistory(fold, totalLoadedPrompt, totalLoadedOutput, truncated);
  const cacheDistribution = partitionCacheReads(callList);

  const modelMap = new Map<string, ModelUsage>();
  let aggregatedSessionCost = 0;
  let pricedCalls = 0;
  let unpricedModel = false;
  let unknownModel = false;
  let currencyCode: string | null = null;

  for (const call of callList) {
    const modelKey = call.modelId ?? "unknown";
    const record = modelMap.get(modelKey) ?? {
      modelId: modelKey,
      calls: 0,
      promptTokens: 0,
      outputTokens: 0,
      cost: null,
    };
    const cachedTokens = extractCachedTokens(call);
    const nextCalls = record.calls + 1;
    const nextPrompt = record.promptTokens + call.promptTokens;
    const nextOutput = record.outputTokens + call.outputTokens;
    let nextCost = record.cost;

    const rate = priceOf(call.modelId, models);
    if (rate) {
      const stepCost = costOf(rate, {
        promptTokens: call.promptTokens,
        outputTokens: call.outputTokens,
        cachedTokens,
      });
      nextCost = (record.cost ?? 0) + stepCost;
      aggregatedSessionCost += stepCost;
      pricedCalls += 1;
      currencyCode = currencyCode ?? rate.currency;
    } else if (isUnrecordedModel(call.modelId)) {
      unknownModel = true;
    } else {
      unpricedModel = true;
    }

    modelMap.set(modelKey, {
      modelId: modelKey,
      calls: nextCalls,
      promptTokens: nextPrompt,
      outputTokens: nextOutput,
      cost: nextCost,
    });
  }

  let linesAdded = 0;
  let linesRemoved = 0;
  const touchedFiles = new Set<string>();
  const toolAggregate = new Map<string, ToolUsage>();
  const subagentRecords: SubagentUsage[] = [];
  const compactionRecords: CompactionRecord[] = [];
  let subagentTokens = 0;
  let excludesSubagents = false;

  for (const itemId of fold.order) {
    const item = fold.items[itemId];
    if (!item) continue;

    if (item.kind === "toolCall") {
      const diffPayload = extractDiff(item);
      if (diffPayload) {
        const stats = diffStats(diffPayload);
        linesAdded += stats.added;
        linesRemoved += stats.removed;
        touchedFiles.add(diffPayload.path ?? item.itemId);
      }
      const toolIdent = item.tool ?? "tool";
      const existingTool = toolAggregate.get(toolIdent) ?? { tool: toolIdent, calls: 0, tokens: 0 };
      toolAggregate.set(toolIdent, {
        tool: toolIdent,
        calls: existingTool.calls + 1,
        tokens: existingTool.tokens + estimateTokens(item.args) + estimateTokens(item.visibleOutput),
      });
    } else if (item.kind === "subagent" && item.usage) {
      const tokensCount = (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0);
      subagentRecords.push({
        itemId: item.itemId,
        label: item.role ?? item.objective ?? "Subagent",
        tokens: tokensCount,
      });
      subagentTokens += tokensCount;
      excludesSubagents = true;
    } else if (item.kind === "workflow") {
      for (const wUsage of extractWorkflowChildUsage(fold, item)) {
        subagentTokens += (wUsage.inputTokens ?? 0) + (wUsage.outputTokens ?? 0);
        excludesSubagents = true;
      }
    } else if (item.kind === "compaction" && item.status !== "inProgress") {
      compactionRecords.push({
        itemId: item.itemId,
        trigger: item.trigger ?? null,
        outcome: item.outcome ?? null,
        before: item.tokensBefore ?? null,
        after: item.tokensAfter ?? null,
      });
    }
  }

  const finishedTurns = countedTurns(fold).filter((t) => t.terminal);
  const firstTokenLatencies = finishedTurns
    .map((t) => t.firstTokenMs)
    .filter((ms): ms is number => typeof ms === "number");
  const metaTotals = fold.meta.tokenTotals;

  return {
    calls: callList.length,
    promptTokens: metaTotals?.promptTokens ?? totalLoadedPrompt,
    outputTokens: metaTotals?.outputTokens ?? totalLoadedOutput,
    totalTokens: metaTotals?.totalTokens ?? (totalLoadedPrompt + totalLoadedOutput),
    loadedPromptTokens: totalLoadedPrompt,
    loadedOutputTokens: totalLoadedOutput,
    totalsComplete: metaTotals !== null || !partial,
    inputTokens: sumProperty((c) => c.inputTokens),
    cacheWriteTokens: sumProperty((c) => c.cacheWriteTokens),
    reasoningTokens: sumProperty((c) => c.reasoningTokens),
    cachedReadTokens: cacheDistribution.cachedReadTokens,
    freshTokens: cacheDistribution.freshTokens,
    cacheHit: totalLoadedPrompt > 0 ? cacheDistribution.cachedReadTokens / totalLoadedPrompt : null,
    modelMs: sumProperty((c) => c.durationMs ?? 0),
    models: [...modelMap.values()].sort((a, b) => (b.promptTokens + b.outputTokens) - (a.promptTokens + a.outputTokens)),
    cost: pricedCalls > 0 ? aggregatedSessionCost : null,
    currency: currencyCode,
    costComplete: pricedCalls === callList.length,
    unpricedModel,
    unknownModel,
    partial,
    subagentTokens,
    excludesSubagents,
    lines: { added: linesAdded, removed: linesRemoved, files: touchedFiles.size },
    turns: finishedTurns.length,
    workedMs: finishedTurns.reduce((acc, t) => acc + (t.durationMs ?? 0), 0),
    firstTokenMs: firstTokenLatencies.length > 0 ? firstTokenLatencies.reduce((a, b) => a + b, 0) / firstTokenLatencies.length : null,
    tools: [...toolAggregate.values()].sort((a, b) => b.tokens - a.tokens),
    subagents: subagentRecords.sort((a, b) => b.tokens - a.tokens),
    compactions: compactionRecords,
  };
}

export interface TelemetryModelUsage {
  readonly modelId: string;
  readonly name: string;
  readonly calls: number;
  readonly outputTokens: number;
}

export interface SessionTelemetry {
  readonly partial: boolean;
  readonly totalTokens: number;
  readonly totalsComplete: boolean;
  readonly turns: number;
  readonly steps: number;
  readonly timedCalls: number;
  readonly durationMs: number;
  readonly tokensPerSecond: number | null;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly uncachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly cacheHitPct: number | null;
  readonly models: TelemetryModelUsage[];
}

export function sessionTelemetry(fold: ThreadFold, truncated = false): SessionTelemetry {
  const callList = Object.values(fold.meta.calls);
  let timedCallsCount = 0;
  let cumulativeDurationMs = 0;
  let aggregatedPromptTokens = 0;
  let aggregatedOutputTokens = 0;
  let cumulativeCacheWriteTokens = 0;
  let cumulativeReasoningTokens = 0;
  const telemetryByModel = new Map<string, TelemetryModelUsage>();

  for (const call of callList) {
    aggregatedPromptTokens += call.promptTokens;
    aggregatedOutputTokens += call.outputTokens;
    cumulativeCacheWriteTokens += call.cacheWriteTokens;
    cumulativeReasoningTokens += call.reasoningTokens;
    if (call.durationMs !== null) {
      cumulativeDurationMs += call.durationMs;
      if (call.durationMs > 0) {
        timedCallsCount += 1;
      }
    }
    const modelIdent = call.modelId ?? "unknown";
    const existing = telemetryByModel.get(modelIdent) ?? {
      modelId: modelIdent,
      name: modelDisplayName(modelIdent),
      calls: 0,
      outputTokens: 0,
    };
    telemetryByModel.set(modelIdent, {
      modelId: modelIdent,
      name: existing.name,
      calls: existing.calls + 1,
      outputTokens: existing.outputTokens + call.outputTokens,
    });
  }

  const tokenTotals = fold.meta.tokenTotals;
  const partial = isPartialHistory(fold, aggregatedPromptTokens, aggregatedOutputTokens, truncated);
  const cacheDistribution = partitionCacheReads(callList);
  const overallSpeed = calculateSpeedFromCalls(callList)?.tokensPerSecond ?? null;

  return {
    partial,
    totalTokens: tokenTotals?.totalTokens ?? (aggregatedPromptTokens + aggregatedOutputTokens),
    totalsComplete: tokenTotals !== null || !partial,
    turns: countedTurns(fold).length,
    steps: callList.length,
    timedCalls: timedCallsCount,
    durationMs: cumulativeDurationMs,
    tokensPerSecond: overallSpeed,
    promptTokens: tokenTotals?.promptTokens ?? aggregatedPromptTokens,
    outputTokens: tokenTotals?.outputTokens ?? aggregatedOutputTokens,
    cachedTokens: cacheDistribution.cachedReadTokens,
    uncachedTokens: cacheDistribution.freshTokens,
    cacheWriteTokens: cumulativeCacheWriteTokens,
    reasoningTokens: cumulativeReasoningTokens,
    cacheHitPct: aggregatedPromptTokens > 0 ? Math.round((cacheDistribution.cachedReadTokens / aggregatedPromptTokens) * 100) : null,
    models: [...telemetryByModel.values()].sort((a, b) => b.outputTokens - a.outputTokens),
  };
}

export function timePillLabel(telemetry: SessionTelemetry): string {
  const speedSuffix = telemetry.tokensPerSecond === null ? "" : ` · ${formatTokensPerSecond(telemetry.tokensPerSecond)}`;
  const turnLabel = `${telemetry.turns} ${telemetry.turns === 1 ? "turn" : "turns"}`;
  const stepLabel = `${telemetry.steps} ${telemetry.steps === 1 ? "step" : "steps"}`;
  const partialPrefix = telemetry.partial ? "Partial · " : "";
  return `${partialPrefix}${turnLabel} · ${stepLabel}${speedSuffix}`;
}

export function usagePillLabel(telemetry: SessionTelemetry): string {
  const tokenMagnitude = formatCompactTokens(telemetry.totalTokens).toUpperCase();
  const cacheSegment = telemetry.partial || telemetry.cacheHitPct === null ? "" : ` · Cache hit ${telemetry.cacheHitPct}%`;
  const plusSymbol = telemetry.totalsComplete ? "" : "+";
  return `${tokenMagnitude}${plusSymbol} tok${cacheSegment}`;
}
