import type {
  ApprovalRequest, LiveView, ModelOption, MspItem, ResearchPhase, ResearchRunView, ResearchStatus, ResearchWorkerState, ResearchWorkerView,
  SessionSummary, TokenUsage, UserInputRequest, WorkflowChild,
} from "../types.js";
import { agentNumbers, type AgentNumbers } from "./agents.js";
import { uuidTime, type ChildTrace, type RequestTrace, type RunTrace, type TaskTrace, type ThreadFold, type TurnInfo } from "./fold.js";
import { describeApproval, describeTool, formatClock, formatTokens, lastLine, parseArgs, type ToolDescription } from "./format.js";
import { costOf, formatCost, priceOf } from "./pricing.js";
import { interruptedLine, phaseLine, researchEnded, researchLive, researchThreadTitle, sourcesLine } from "./research.js";
import { projectForCwd } from "./status.js";
import type { AppState, ThreadState } from "./store.js";
import { TERMINAL_FAILURES, reconciled } from "./workflow.js";

/**
 * View-model definitions and projections for Ancilla's Crew panel, activity drawer,
 * sidebar status rows, and Deep Research progress tracking.
 */

export type AgentState =
  | "planned" | "scheduled" | "working" | "finishing" | "no-update"
  | "waiting-on-you" | "failed" | "skipped" | "done" | "unknown";

export type AgentKind = "workflow" | "subagent" | "task" | "research" | "lead";

/** Kind of background execution: workflow swarm, deep research, or conversational turn. */
export type RunKind = "workflow" | "research" | "turn";

/** Telemetry and stats reported for a Deep Research worker agent. */
export type ResearchAgentInfo = {
  agentId: number;
  round: number;
  searches: number;
  reads: number;
  saved: number;
  discovery: boolean;
  model: string | null;
  wireState: ResearchWorkerState;
};

/** Deep Research run metadata and lifecycle progress details. */
export interface ResearchRunInfo {
  runId: string;
  status: ResearchStatus;
  phase: ResearchPhase;
  round: number;
  maxRounds: number;
  question: string;
  sources: ResearchRunView["sources"];
  noCitableSources?: true;
  deadlineAt: number | null;
  reportAvailable: boolean;
}

export type PendingAction = "retry" | "stop";

export type SkippedBy = "you" | "run" | "muse";

export interface AttemptEventVM {
  kind: "scheduled" | "started" | "usage" | "completed" | "failed" | "cancelled" | "unknown";
  at: number | null;
  detail: string | null;
}

export interface AttemptVM {
  attempt: number;
  events: AttemptEventVM[];
  startedAt: number | null;
  endedAt: number | null;
  outcome: "done" | "failed" | "skipped" | "unknown" | null;
}

export interface AgentVM {
  id: string;
  attempt: number;
  name: string;
  label: string | null;
  display: { prefix: string | null; short: string };
  phase: string;
  kind: AgentKind;
  sourceTurnId?: string | null;
  state: AgentState;
  pending: PendingAction | null;
  skippedBy: SkippedBy | null;
  startedAt: number | null;
  endedAt: number | null;
  lastEventAt: number | null;
  silenceMs: number | null;
  runningMs: number | null;
  durationMs: number | null;
  approx: boolean;
  tokens: TokenUsage | null;
  toolCalls: number | null;
  attempts: AttemptVM[];
  failure: { text: string | null; at: number | null } | null;
  task: { text: string; source: "script" | "objective" } | null;
  shareOfLongest: number | null;
  quiet: { thresholdMs: number; longestFinishedMs: number | null } | null;
  needs: { kind: "approval" | "input"; command: string | null; askedAt: number | null; requestId: string } | null;
  runItemId: string | null;
  workflowRunId: string | null;
  taskInfo?: {
    command: string; tail: string | null; lastOutputAt: number | null; initiator: "user" | "timeout" | null; approvalId: string | null;
    background?: boolean; stoppable?: boolean; exitCode?: number | null; exitSignal?: number | null;
    look?: Pick<ToolDescription, "kind" | "verb" | "subject" | "mono" | "note">;
  };
  research?: ResearchAgentInfo;
}

export interface Counts {
  total: number;
  planned: number;
  scheduled: number;
  working: number;
  finishing: number;
  noUpdate: number;
  waiting: number;
  failed: number;
  skipped: number;
  done: number;
  unknown: number;
}

export interface PhaseVM {
  name: string;
  agents: AgentVM[];
  counts: Counts;
  state: "planned" | "live" | "done" | "done-with-failures" | "done-skipped";
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  tokens: number | null;
}

export type RunStatus = "starting" | "running" | "finished" | "finished-with-failures" | "stopped" | "failed";

export interface RunNeedVM {
  kind: "approval" | "input";
  command: string | null;
  askedAt: number | null;
  requestId: string;
  phase: string | null;
}

export interface RunVM {
  itemId: string;
  runId: string | null;
  name: string;
  kind: RunKind;
  research: ResearchRunInfo | null;
  status: RunStatus;
  revision: number;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  elapsedApprox: boolean;
  partialHistory: boolean;
  phases: PhaseVM[];
  agents: AgentVM[];
  counts: Counts;
  attention: AgentVM[];
  runNeeds: RunNeedVM[];
  currentPhase: string | null;
  plannedKnown: boolean;
  tokens: { total: number; reported: number; of: number } | null;
  cost: { usd: number; model: string } | null;
  priceModel?: string | null;
  mixedModels?: boolean;
  slots: { used: number; max: number } | null;
  pulse: number[];
  longestFinishedMs: number | null;
  agentTimeMs: number | null;
  peakConcurrency: { n: number; phase: string } | null;
  waitedOnYouMs: number | null;
  retried: number;
  report: { summary: string | null; failure: string | null; handoffs: { agent: string; description: string }[] } | null;
  stale: boolean;
  staleAt: number | null;
  clockAt: number;
}

export interface SinceYouLeftVM {
  leftAt: number;
  finished: number;
  failed: number;
  phasesStarted: string[];
  runFinishedAt: number | null;
}

export interface StatVM {
  value: string;
  label: string;
}

export interface HighlightVM {
  icon: string;
  text: string;
  strong: string;
  aside: string | null;
}

export interface FingerprintLaneVM {
  id: string;
  name: string;
  phase: string;
  state: AgentState;
  spans: { startMs: number; endMs: number; failed: boolean }[];
}

export interface FingerprintVM {
  totalMs: number;
  phases: { name: string; startMs: number | null; endMs: number | null }[];
  lanes: FingerprintLaneVM[];
  partial: boolean;
}

export interface CompletionVM {
  headline: string;
  factLine: string;
  stats: StatVM[];
  highlights: HighlightVM[];
  fingerprint: FingerprintVM;
  excerpt: string | null;
  sheen: boolean;
}

export interface SidebarCrewSummary {
  groups: AgentState[][];
  text: string;
  needs: number;
  failed: number;
  noUpdate: number;
  phase: string | null;
  stale: boolean;
  task: string | null;
  live: boolean;
  endedAt: number | null;
}

export interface ActivityItemVM {
  sessionId: string;
  itemId: string | null;
  agentId: string | null;
  kind: "run" | "task" | "subagent" | "request";
  project: string;
  thread: string;
  text: string;
  sub: string | null;
  state: AgentState | "request";
  startedAt: number | null;
  endedAt: number | null;
  stale: boolean;
}

export interface ActivityVM {
  needsYou: ActivityItemVM[];
  working: ActivityItemVM[];
  finishedToday: ActivityItemVM[];
  stopAll: { runs: number; tasks: number; agents?: number } | null;
  foot: string;
  empty: boolean;
  note: string | null;
}

export interface CrewVM {
  runs: RunVM[];
  tasks: AgentVM[];
  subagents: AgentVM[];
}

export interface CrewOptions {
  stale?: boolean;
  staleAt?: number | null;
  partialHistory?: boolean;
  pending?: Readonly<Record<string, PendingAction>>;
  skipped?: readonly string[];
  models?: readonly ModelOption[];
  numbers?: AgentNumbers;
  researchRuns?: readonly ResearchRunView[];
}

export type SummaryChip = { kind: "needs" | "failed" | "no-update" | "stale" | "skipped" | "run-failed"; count: number; text: string };

export function pendingKey(sessionId: string, agentId: string, attempt: number): string {
  return `${sessionId}:${agentId}:${attempt}`;
}

export const RESEARCH_ITEM_PREFIX = "research:";

export function researchItemId(runId: string): string {
  return `${RESEARCH_ITEM_PREFIX}${runId}`;
}

export function researchRunIdOf(itemId: string): string | null {
  return itemId.startsWith(RESEARCH_ITEM_PREFIX) ? itemId.slice(RESEARCH_ITEM_PREFIX.length) : null;
}

export const TURN_ITEM_PREFIX = "turn:";
export function turnIdOf(itemId: string): string | null {
  return itemId.startsWith(TURN_ITEM_PREFIX) ? itemId.slice(TURN_ITEM_PREFIX.length) : null;
}

export function canStopAgent(agent: Pick<AgentVM, "kind" | "taskInfo">): boolean {
  return agent.kind !== "research" && !(agent.kind === "task" && agent.taskInfo?.stoppable === false);
}

export function researchAgentId(runId: string, agentId: number): string {
  return `${researchItemId(runId)}:A${agentId}`;
}

export function researchCounters(info: Pick<ResearchAgentInfo, "searches" | "reads" | "saved">): string {
  const parts: string[] = [];
  if (info.searches > 0) parts.push(plural(info.searches, "search", "searches"));
  if (info.reads > 0) parts.push(plural(info.reads, "read"));
  if (info.saved > 0) parts.push(`${info.saved} saved`);
  return parts.length > 0 ? parts.join(" · ") : "no calls yet";
}

export const NO_UPDATE_FLOOR_MS = 240_000;
export const TASK_NO_OUTPUT_MS = 240_000;
const BURST_GAP_MS = 2_000;
const PULSE_BINS = 10;
const SINCE_LEFT_MIN_MS = 300_000;

const LIVE_STATES: ReadonlySet<AgentState> = new Set(["scheduled", "working", "finishing", "no-update", "waiting-on-you"]);
const ENDED_STATES: ReadonlySet<AgentState> = new Set(["failed", "skipped", "done", "unknown"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function capitalize(word: string): string {
  return word.length > 0 ? `${word[0]!.toUpperCase()}${word.slice(1)}` : "";
}

function plural(countVal: number, singularWord: string, pluralWord = `${singularWord}s`): string {
  const selectedForm = countVal === 1 ? singularWord : pluralWord;
  return `${countVal} ${selectedForm}`;
}

export function usageTotal(tokens: TokenUsage | null | undefined): number {
  if (!tokens) return 0;
  return (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0);
}

export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "";
  }
  const totalSecs = Math.max(0, Math.round(ms / 1000));
  if (totalSecs < 60) {
    return `${totalSecs}s`;
  }
  const totalMins = Math.floor(totalSecs / 60);
  const leftSecs = String(totalSecs % 60).padStart(2, "0");
  if (totalMins < 60) {
    return `${totalMins}m ${leftSecs}s`;
  }
  const totalHrs = Math.floor(totalMins / 60);
  const leftMins = String(totalMins % 60).padStart(2, "0");
  return `${totalHrs}h ${leftMins}m`;
}

export function aboutText(durationMs: number): string {
  const approximateMinutes = Math.max(1, Math.round(durationMs / 60_000));
  if (approximateMinutes < 60) {
    return `about ${approximateMinutes}m`;
  }
  const approximateHours = Math.floor(approximateMinutes / 60);
  const remMinutes = String(approximateMinutes % 60).padStart(2, "0");
  return `about ${approximateHours}h ${remMinutes}m`;
}

const NUMBER_WORDS: readonly string[] = Object.freeze([
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
]);

export function numberWord(n: number): string {
  return (n >= 0 && n < NUMBER_WORDS.length) ? NUMBER_WORDS[n]! : `${n}`;
}

function computeFnvHash(str: string): number {
  let hashVal = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hashVal = Math.imul(hashVal ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return hashVal;
}

const SIGIL_DEFAULT_GRID: readonly (readonly boolean[])[] = [
  [false, true, true, true, false],
  [true, false, true, false, true],
  [true, true, true, true, true],
  [true, false, false, false, true],
  [false, true, false, true, false],
];

const sigilCache = new Map<string, boolean[][]>();
const MAX_SIGIL_CACHE_SIZE = 4096;

export function sigilGrid(name: string): boolean[][] {
  const found = sigilCache.get(name);
  if (found) return found;

  let candidateGrid: boolean[][] | null = null;
  for (let saltVal = 0; saltVal < 64 && !candidateGrid; saltVal++) {
    const hash = computeFnvHash(`${name}#${saltVal}`);
    const matrix: boolean[][] = [];
    let litCount = 0;

    for (let rowIdx = 0; rowIdx < 5; rowIdx++) {
      const bitShift = rowIdx * 3;
      const b0 = Boolean((hash >>> bitShift) & 1);
      const b1 = Boolean((hash >>> (bitShift + 1)) & 1);
      const b2 = Boolean((hash >>> (bitShift + 2)) & 1);
      matrix.push([b0, b1, b2, b1, b0]);
      litCount += (b0 ? 2 : 0) + (b1 ? 2 : 0) + (b2 ? 1 : 0);
    }

    const rowOccupancy = matrix.filter((row) => row.some(Boolean)).length;
    const colOccupancy = [0, 1, 2].filter((col) => matrix.some((row) => row[col])).length;
    const centerFilled = matrix[2]!.some(Boolean);
    const edgeFilled = matrix[0]!.some(Boolean) || matrix[4]!.some(Boolean);

    if (litCount >= 9 && litCount <= 15 && rowOccupancy >= 4 && colOccupancy === 3 && centerFilled && edgeFilled) {
      candidateGrid = matrix;
    }
  }

  const result = candidateGrid ?? SIGIL_DEFAULT_GRID.map((r) => [...r]);
  if (sigilCache.size >= MAX_SIGIL_CACHE_SIZE) {
    const evictionKey = sigilCache.keys().next().value;
    if (evictionKey !== undefined) sigilCache.delete(evictionKey);
  }
  sigilCache.set(name, result);
  return result;
}

export interface Plan {
  labels: string[];
  inputs: Record<string, string>;
  complete: boolean;
}

interface ScannedAgentLiteral {
  seq: number;
  labelValue: string | null;
  inputValue: string | null;
  hasInterpolation: boolean;
}

function extractStringLiteral(code: string, startPos: number): { text: string; nextPos: number; isDynamic: boolean } {
  const delimiter = code[startPos]!;
  let content = "";
  let isDynamic = false;
  let ptr = startPos + 1;
  const len = code.length;

  while (ptr < len) {
    const char = code[ptr]!;
    if (char === "\\" && ptr + 1 < len) {
      const esc = code[ptr + 1]!;
      content += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
      ptr += 2;
      continue;
    }
    if (char === delimiter) {
      return { text: content, nextPos: ptr + 1, isDynamic };
    }
    if (delimiter === "`" && char === "$" && ptr + 1 < len && code[ptr + 1] === "{") {
      isDynamic = true;
    }
    if (char === "\n" && delimiter !== "`") {
      return { text: content, nextPos: ptr + 1, isDynamic };
    }
    content += char;
    ptr++;
  }
  return { text: content, nextPos: len, isDynamic };
}

export function readPlan(scriptText: string | undefined): Plan | null {
  if (!scriptText) return null;
  const invocationPattern = /\bhost\s*\.\s*(?:parallel|agent)\s*\(/;
  if (!invocationPattern.test(scriptText)) return null;

  const gathered: ScannedAgentLiteral[] = [];
  const objStack: ScannedAgentLiteral[] = [];
  let sequenceCounter = 0;
  let cursor = 0;
  const codeLen = scriptText.length;

  while (cursor < codeLen) {
    const c = scriptText[cursor]!;
    if (c === "/" && cursor + 1 < codeLen) {
      const nextChar = scriptText[cursor + 1]!;
      if (nextChar === "/") {
        const newlinePos = scriptText.indexOf("\n", cursor);
        cursor = newlinePos < 0 ? codeLen : newlinePos + 1;
        continue;
      }
      if (nextChar === "*") {
        const closeComment = scriptText.indexOf("*/", cursor + 2);
        cursor = closeComment < 0 ? codeLen : closeComment + 2;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const parsedStr = extractStringLiteral(scriptText, cursor);
      cursor = parsedStr.nextPos;
      continue;
    }
    if (c === "{") {
      const objEntry: ScannedAgentLiteral = { seq: sequenceCounter++, labelValue: null, inputValue: null, hasInterpolation: false };
      objStack.push(objEntry);
      gathered.push(objEntry);
      cursor++;
      continue;
    }
    if (c === "}") {
      objStack.pop();
      cursor++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let wordEnd = cursor + 1;
      while (wordEnd < codeLen && /[\w$]/.test(scriptText[wordEnd]!)) {
        wordEnd++;
      }
      const token = scriptText.slice(cursor, wordEnd);
      cursor = wordEnd;

      if ((token === "label" || token === "input") && objStack.length > 0) {
        let colonSearch = cursor;
        while (colonSearch < codeLen && /\s/.test(scriptText[colonSearch]!)) colonSearch++;
        if (scriptText[colonSearch] === ":") {
          let valSearch = colonSearch + 1;
          while (valSearch < codeLen && /\s/.test(scriptText[valSearch]!)) valSearch++;
          const leadQuote = scriptText[valSearch];
          if (leadQuote === '"' || leadQuote === "'" || leadQuote === "`") {
            const strLit = extractStringLiteral(scriptText, valSearch);
            const topScope = objStack[objStack.length - 1]!;
            if (token === "label") {
              topScope.labelValue = strLit.text;
              topScope.hasInterpolation = topScope.hasInterpolation || strLit.isDynamic;
            } else {
              topScope.inputValue = strLit.text;
            }
            cursor = strLit.nextPos;
          }
        }
      }
      continue;
    }
    cursor++;
  }

  const orderedLabels: string[] = [];
  const inputTable: Record<string, string> = {};
  let isFullyStatic = true;

  gathered.sort((a, b) => a.seq - b.seq);
  for (const item of gathered) {
    const lbl = item.labelValue?.trim();
    if (!lbl) continue;
    orderedLabels.push(item.labelValue!);
    if (item.hasInterpolation) isFullyStatic = false;
    if (item.inputValue !== null) {
      inputTable[item.labelValue!] = item.inputValue;
    }
  }

  if (orderedLabels.length === 0) return null;
  return { labels: orderedLabels, inputs: inputTable, complete: isFullyStatic };
}

export interface LaunchPolicy {
  maxParallelAgents: number | null;
  childLimit: number | null;
  tokenBudget: number | null;
}

export function readLaunchPolicy(rawOutput: string | undefined): LaunchPolicy | null {
  const parsedArgs = parseArgs(rawOutput);
  if (!parsedArgs) return null;

  const policyRecord = (parsedArgs.policy && typeof parsedArgs.policy === "object" && !Array.isArray(parsedArgs.policy))
    ? (parsedArgs.policy as Record<string, unknown>)
    : null;

  const extractValidNumber = (val: unknown): number | null => (typeof val === "number" && Number.isFinite(val) ? val : null);

  const concurrencyCap = extractValidNumber(parsedArgs.maxParallelAgents);
  const childCap = policyRecord ? extractValidNumber(policyRecord.childLimit) : null;
  const budgetAllocation = extractValidNumber(parsedArgs.tokenBudget) ?? (policyRecord ? extractValidNumber(policyRecord.tokenBudget) : null);

  return {
    maxParallelAgents: concurrencyCap,
    childLimit: childCap,
    tokenBudget: budgetAllocation,
  };
}

interface LaunchInfo {
  itemId: string;
  callId: string | null;
  name: string | null;
  plan: Plan | null;
  policy: LaunchPolicy | null;
  turnId: string | null;
}

const launchMetadataMap = new WeakMap<MspItem, LaunchInfo>();
const parsedPlansCache = new Map<string, Plan | null>();
const MAX_PARSED_PLANS = 32;

function launchInfo(item: MspItem): LaunchInfo {
  const existing = launchMetadataMap.get(item);
  if (existing) return existing;

  const primaryArgs = parseArgs(item.args);
  const effectiveArgs = (primaryArgs && typeof primaryArgs.args === "string")
    ? (parseArgs(primaryArgs.args) ?? primaryArgs)
    : primaryArgs;

  const scriptBody = text(effectiveArgs?.script) ?? text(primaryArgs?.script) ?? undefined;
  let resolvedPlan: Plan | null = null;

  if (scriptBody) {
    if (parsedPlansCache.has(scriptBody)) {
      resolvedPlan = parsedPlansCache.get(scriptBody) ?? null;
    } else {
      resolvedPlan = readPlan(scriptBody);
      if (parsedPlansCache.size >= MAX_PARSED_PLANS) {
        const oldestPlanKey = parsedPlansCache.keys().next().value;
        if (oldestPlanKey !== undefined) parsedPlansCache.delete(oldestPlanKey);
      }
      parsedPlansCache.set(scriptBody, resolvedPlan);
    }
  }

  const descriptor: LaunchInfo = {
    itemId: item.itemId,
    callId: text(item.callId),
    name: text(effectiveArgs?.name) ?? text(primaryArgs?.name),
    plan: resolvedPlan,
    policy: readLaunchPolicy(item.visibleOutput),
    turnId: text(item.turnId),
  };
  launchMetadataMap.set(item, descriptor);
  return descriptor;
}

interface ThreadIndex {
  workflows: MspItem[];
  subagents: MspItem[];
  background: MspItem[];
  foreground: Map<string, MspItem[]>;
  launches: string[];
  spawns: string[];
  waits: string[];
}

const threadIndexCache = new WeakMap<Record<string, MspItem>, { order: readonly string[]; index: ThreadIndex }>();
const transcriptPositionsCache = new WeakMap<readonly string[], ReadonlyMap<string, number>>();

function transcriptPositions(orderSequence: readonly string[]): ReadonlyMap<string, number> {
  let mapped = transcriptPositionsCache.get(orderSequence);
  if (!mapped) {
    mapped = new Map(orderSequence.map((itemId, idx) => [itemId, idx]));
    transcriptPositionsCache.set(orderSequence, mapped);
  }
  return mapped;
}

function threadIndex(fold: ThreadFold): ThreadIndex {
  const sourceItems = fold.agentItems ?? fold.items;
  const memoized = threadIndexCache.get(sourceItems);
  if (memoized?.order === fold.order) {
    return memoized.index;
  }

  const generatedIndex: ThreadIndex = {
    workflows: [],
    subagents: [],
    background: [],
    foreground: new Map(),
    launches: [],
    spawns: [],
    waits: [],
  };

  for (const itemRecord of Object.values(sourceItems)) {
    if (itemRecord.kind === "workflow") generatedIndex.workflows.push(itemRecord);
    else if (itemRecord.kind === "subagent") generatedIndex.subagents.push(itemRecord);

    if (itemRecord.kind === "toolCall") {
      if (itemRecord.background === true) {
        generatedIndex.background.push(itemRecord);
      } else if (itemRecord.turnId) {
        const bucket = generatedIndex.foreground.get(itemRecord.turnId) ?? [];
        bucket.push(itemRecord);
        generatedIndex.foreground.set(itemRecord.turnId, bucket);
      }

      if (itemRecord.tool === "workflow") {
        generatedIndex.launches.push(itemRecord.itemId);
      } else if (itemRecord.tool === "subagent_spawn") {
        generatedIndex.spawns.push(itemRecord.itemId);
      } else if (itemRecord.tool === "subagent_wait") {
        generatedIndex.waits.push(itemRecord.itemId);
      }
    }
  }

  if (generatedIndex.launches.length > 1 || generatedIndex.spawns.length > 1) {
    const posIndex = transcriptPositions(fold.order);
    const orderComparator = (x: string, y: string): number => (posIndex.get(x) ?? -1) - (posIndex.get(y) ?? -1);
    generatedIndex.launches.sort(orderComparator);
    generatedIndex.spawns.sort(orderComparator);
  }

  threadIndexCache.set(sourceItems, { order: fold.order, index: generatedIndex });
  return generatedIndex;
}

function launchFor(fold: ThreadFold, runItem: MspItem, payloadCallId: string | null): LaunchInfo | null {
  const idx = threadIndex(fold);
  if (idx.launches.length === 0) return null;

  const validInfos = idx.launches
    .map((launchId) => fold.items[launchId])
    .filter((it): it is MspItem => Boolean(it))
    .map(launchInfo);

  const wfRunId = text(runItem.workflowRunId);
  const callMatched = validInfos.find((inf) => inf.callId !== null && (inf.callId === payloadCallId || (wfRunId !== null && wfRunId.endsWith(inf.callId))));
  if (callMatched) return callMatched;

  const entryName = text(runItem.entryId);
  const turnMatches = validInfos.filter((inf) => inf.turnId !== null && inf.turnId === text(runItem.turnId));
  return turnMatches.find((inf) => entryName !== null && inf.name === entryName) ?? (turnMatches.length === 1 ? turnMatches[0]! : null) ?? (validInfos.length === 1 ? validInfos[0]! : null);
}

type Outcome = "done" | "failed" | "skipped" | "unknown";

function normalizedWord(rawWord: string | undefined): string {
  return (rawWord ?? "").replace(/[\s_-]/g, "").toLowerCase();
}

function outcomeOfTerminal(terminalStatus: string | undefined): Outcome {
  const cleanTerm = normalizedWord(terminalStatus);
  if (["completed", "complete", "succeeded", "success", "done"].includes(cleanTerm)) return "done";
  if (["failed", "error", "rejected", "timedout"].includes(cleanTerm)) return "failed";
  if (["cancelled", "canceled", "stopped", "skipped", "interrupted"].includes(cleanTerm)) return "skipped";
  return "unknown";
}

export function childOutcome(child: WorkflowChild): Outcome | null {
  if (text(child.terminal)) {
    return outcomeOfTerminal(child.terminal);
  }
  const cleanStat = normalizedWord(child.status);
  if (["completed", "complete", "succeeded", "success", "done"].includes(cleanStat)) {
    return "done";
  }
  if (cleanStat === "terminal") {
    return "unknown";
  }
  return null;
}

function lifecycleState(statusStr: string | undefined): "scheduled" | "finishing" | "working" {
  const cleanWord = normalizedWord(statusStr);
  if (cleanWord === "scheduled" || cleanWord === "queued" || cleanWord === "pending") {
    return "scheduled";
  }
  if (cleanWord === "usage") {
    return "finishing";
  }
  return "working";
}

function childKey(childDescriptor: { childId: string; attempt: number }): string {
  return `${childDescriptor.childId}:${childDescriptor.attempt}`;
}

function displayOf(labelString: string): AgentVM["display"] {
  const separatorPos = labelString.indexOf(":");
  if (separatorPos > 0) {
    return {
      prefix: labelString.slice(0, separatorPos + 1),
      short: labelString.slice(separatorPos + 1),
    };
  }
  return { prefix: null, short: labelString };
}

function prefixPhase(rawLabel: string | null): string | null {
  if (!rawLabel) return null;
  const sepIdx = rawLabel.indexOf(":");
  if (sepIdx > 0) {
    const rawPrefix = rawLabel.slice(0, sepIdx).trim();
    return rawPrefix ? capitalize(rawPrefix) : null;
  }
  return null;
}

const reconciledPayloadCache = new WeakMap<MspItem, ReturnType<typeof reconciled>>();

function payloadOf(item: MspItem): ReturnType<typeof reconciled> {
  if (reconciledPayloadCache.has(item)) {
    return reconciledPayloadCache.get(item) ?? null;
  }
  const parsedRes = reconciled(item.message);
  reconciledPayloadCache.set(item, parsedRes);
  return parsedRes;
}

interface DurableChild {
  childId: string;
  entries: WorkflowChild[];
  latest: WorkflowChild;
  traces: Map<number, ChildTrace | undefined>;
  label: string | null;
  scheduledAt: number | null;
}

interface ChildCacheEntry {
  vm: AgentVM;
  traces: (ChildTrace | undefined)[];
  signature: string;
}

interface RunCache {
  children: Map<string, ChildCacheEntry>;
}

const sessionRunCaches = new Map<string, RunCache>();
const MAX_SESSION_RUN_CACHES = 64;

function runCacheFor(compositeKey: string): RunCache {
  const existing = sessionRunCaches.get(compositeKey) ?? { children: new Map() };
  sessionRunCaches.delete(compositeKey);
  sessionRunCaches.set(compositeKey, existing);

  while (sessionRunCaches.size > MAX_SESSION_RUN_CACHES) {
    const oldestEntryKey = sessionRunCaches.keys().next().value;
    if (oldestEntryKey !== undefined) sessionRunCaches.delete(oldestEntryKey);
  }
  return existing;
}

function sameOptional<T extends Record<string, unknown>>(firstRec: T | null | undefined, secondRec: T | null | undefined): boolean {
  if (firstRec === secondRec) return true;
  if (!firstRec || !secondRec) return false;
  const firstKeys = Object.keys(firstRec);
  const secondKeys = Object.keys(secondRec);
  if (firstKeys.length !== secondKeys.length) return false;
  return firstKeys.every((propKey) => firstRec[propKey] === secondRec[propKey]);
}

function sameAgent(a: AgentVM, b: AgentVM): boolean {
  return a.id === b.id && a.attempt === b.attempt && a.name === b.name && a.label === b.label && a.phase === b.phase && a.kind === b.kind
    && a.state === b.state && a.pending === b.pending && a.skippedBy === b.skippedBy && a.startedAt === b.startedAt && a.endedAt === b.endedAt
    && a.lastEventAt === b.lastEventAt && a.silenceMs === b.silenceMs && a.runningMs === b.runningMs && a.durationMs === b.durationMs
    && a.approx === b.approx && a.tokens === b.tokens && a.toolCalls === b.toolCalls && a.attempts === b.attempts
    && a.shareOfLongest === b.shareOfLongest && a.runItemId === b.runItemId && a.workflowRunId === b.workflowRunId
    && sameOptional(a.display, b.display) && sameOptional(a.failure, b.failure) && sameOptional(a.task, b.task)
    && sameOptional(a.quiet, b.quiet) && sameOptional(a.needs, b.needs) && sameOptional(a.taskInfo, b.taskInfo) && sameOptional(a.research, b.research);
}

function attemptEvents(entry: WorkflowChild | undefined, trace: ChildTrace | undefined, outcome: Outcome | null, terminalAt: number | null): AttemptEventVM[] {
  const eventsList: AttemptEventVM[] = [];
  const currentStage = entry ? lifecycleState(entry.status) : "working";
  const hasEverStarted = trace?.startedAt !== undefined || (entry !== undefined && currentStage !== "scheduled") || outcome !== null;

  eventsList.push({
    kind: "scheduled",
    at: trace?.scheduledAt ?? null,
    detail: trace?.approx && trace.scheduledAt !== undefined ? "about" : null,
  });

  if (hasEverStarted) {
    eventsList.push({ kind: "started", at: trace?.startedAt ?? null, detail: null });
  }

  if (trace?.usageAt !== undefined || trace?.usage !== undefined || (entry !== undefined && currentStage === "finishing")) {
    const consumedUsage = trace?.usage ?? entry?.usage;
    eventsList.push({
      kind: "usage",
      at: trace?.usageAt ?? null,
      detail: consumedUsage ? `${formatTokens(usageTotal(consumedUsage))} tokens` : null,
    });
  }

  if (outcome !== null) {
    const elapsedSinceStart = trace?.startedAt !== undefined && terminalAt !== null ? terminalAt - trace.startedAt : null;
    const resolvedDuration = num(entry?.durationMs) ?? trace?.durationMs ?? elapsedSinceStart;
    const durationDetail = resolvedDuration !== null && resolvedDuration >= 0 ? `after ${durationText(resolvedDuration)}` : null;

    let targetKind: AttemptEventVM["kind"] = "unknown";
    if (outcome === "done") targetKind = "completed";
    else if (outcome === "failed") targetKind = "failed";
    else if (outcome === "skipped") targetKind = "cancelled";

    eventsList.push({
      kind: targetKind,
      at: terminalAt,
      detail: outcome === "unknown" ? "Muse did not report an outcome" : durationDetail,
    });
  }

  return eventsList;
}

function attemptEnd(trace: ChildTrace | undefined): number | null {
  return trace?.terminalAt ?? trace?.completedAt ?? null;
}

function buildAttempts(durable: DurableChild, runEnded: boolean): AttemptVM[] {
  const attemptNumbers = [...new Set([...durable.traces.keys(), ...durable.entries.map((e) => e.attempt)])].sort((x, y) => x - y);
  return attemptNumbers.map((attNum) => {
    const matchedEntry = durable.entries.find((it) => it.attempt === attNum);
    const matchedTrace = durable.traces.get(attNum);
    const isLatestAttempt = attNum === durable.latest.attempt;

    const resolvedOutcome = matchedEntry
      ? (childOutcome(matchedEntry) ?? (runEnded ? "unknown" : null))
      : matchedTrace?.terminal ? outcomeOfTerminal(matchedTrace.terminal) : isLatestAttempt && !runEnded ? null : "unknown";

    const attemptEndTimestamp = resolvedOutcome === null ? null : attemptEnd(matchedTrace);
    return {
      attempt: attNum,
      events: attemptEvents(matchedEntry, matchedTrace, resolvedOutcome, attemptEndTimestamp),
      startedAt: matchedTrace?.startedAt ?? null,
      endedAt: attemptEndTimestamp,
      outcome: resolvedOutcome,
    };
  });
}

interface RunContext {
  fold: ThreadFold;
  sessionId: string | null;
  now: number;
  clock: number;
  stale: boolean;
  staleAt: number | null;
  partialHistory: boolean;
  pending: Readonly<Record<string, PendingAction>>;
  skipped: ReadonlySet<string>;
  model: string | null;
  models: readonly ModelOption[];
  numbers: AgentNumbers;
}

function assignPhases(children: DurableChild[]): Map<string, string> {
  const phaseAssignment = new Map<string, string>();
  const unassignedChildren: DurableChild[] = [];
  let containsNamedPrefix = false;

  for (const child of children) {
    const explicitlyTaggedPhase = text(child.latest.phase) ?? [...child.entries].reverse().map((e) => text(e.phase)).find((val) => val !== null) ?? null;
    const inferredPrefix = prefixPhase(child.label);

    if (explicitlyTaggedPhase) {
      phaseAssignment.set(child.childId, explicitlyTaggedPhase);
    } else if (inferredPrefix) {
      phaseAssignment.set(child.childId, inferredPrefix);
      containsNamedPrefix = true;
    } else {
      unassignedChildren.push(child);
    }
  }

  if (unassignedChildren.length === 0) {
    return phaseAssignment;
  }

  if (containsNamedPrefix || unassignedChildren.some((c) => c.scheduledAt === null)) {
    for (const child of unassignedChildren) phaseAssignment.set(child.childId, "Agents");
    return phaseAssignment;
  }

  const sortedUnassigned = [...unassignedChildren].sort((a, b) => (a.scheduledAt as number) - (b.scheduledAt as number));
  const burstClusters: DurableChild[][] = [];
  let prevTimestamp = Number.NEGATIVE_INFINITY;

  for (const child of sortedUnassigned) {
    const currentAt = child.scheduledAt as number;
    if (currentAt - prevTimestamp > BURST_GAP_MS || burstClusters.length === 0) {
      burstClusters.push([]);
    }
    burstClusters[burstClusters.length - 1]!.push(child);
    prevTimestamp = currentAt;
  }

  burstClusters.forEach((cluster, clusterIdx) => {
    const clusterLabel = burstClusters.length === 1 ? "Agents" : `Wave ${clusterIdx + 1}`;
    for (const item of cluster) {
      phaseAssignment.set(item.childId, clusterLabel);
    }
  });

  return phaseAssignment;
}

function emptyCounts(): Counts {
  return { total: 0, planned: 0, scheduled: 0, working: 0, finishing: 0, noUpdate: 0, waiting: 0, failed: 0, skipped: 0, done: 0, unknown: 0 };
}

function count(accumulator: Counts, state: AgentState): void {
  accumulator.total += 1;
  switch (state) {
    case "planned": accumulator.planned += 1; break;
    case "scheduled": accumulator.scheduled += 1; break;
    case "working": accumulator.working += 1; break;
    case "finishing": accumulator.finishing += 1; break;
    case "no-update": accumulator.noUpdate += 1; break;
    case "waiting-on-you": accumulator.waiting += 1; break;
    case "failed": accumulator.failed += 1; break;
    case "skipped": accumulator.skipped += 1; break;
    case "done": accumulator.done += 1; break;
    case "unknown": accumulator.unknown += 1; break;
  }
}

export function runCounts(run: Pick<RunVM, "phases">): Counts {
  const tally = emptyCounts();
  for (const phaseItem of run.phases) {
    for (const member of phaseItem.agents) {
      count(tally, member.state);
    }
  }
  return tally;
}

export function attentionOrder(agents: readonly AgentVM[]): AgentVM[] {
  const waitingList: AgentVM[] = [];
  const failedList: AgentVM[] = [];
  const silentList: AgentVM[] = [];
  for (const item of agents) {
    if (item.state === "waiting-on-you") waitingList.push(item);
    else if (item.state === "failed") failedList.push(item);
    else if (item.state === "no-update") silentList.push(item);
  }
  return [...waitingList, ...failedList, ...silentList];
}

export function noUpdateThresholdMs(run: Pick<RunVM, "longestFinishedMs">): number | null {
  const longestDuration = run.longestFinishedMs;
  if (longestDuration === null) return null;
  return longestDuration < NO_UPDATE_FLOOR_MS ? NO_UPDATE_FLOOR_MS : longestDuration;
}

function phaseState(counts: Counts): PhaseVM["state"] {
  if (counts.total > 0 && counts.planned === counts.total) return "planned";
  if (counts.scheduled + counts.working + counts.finishing + counts.noUpdate + counts.waiting + counts.planned > 0) return "live";
  if (counts.failed + counts.unknown > 0) return "done-with-failures";
  if (counts.skipped > 0) return "done-skipped";
  return "done";
}

export function phasesOf(agents: readonly AgentVM[]): PhaseVM[] {
  const groupsByPhaseName = new Map<string, AgentVM[]>();
  for (const ag of agents) {
    if (ag.state === "planned") continue;
    const bucket = groupsByPhaseName.get(ag.phase);
    if (bucket) bucket.push(ag);
    else groupsByPhaseName.set(ag.phase, [ag]);
  }
  for (const ag of agents) {
    if (ag.state !== "planned") continue;
    const bucket = groupsByPhaseName.get(ag.phase);
    if (bucket) bucket.push(ag);
    else groupsByPhaseName.set(ag.phase, [ag]);
  }

  const resultPhases: PhaseVM[] = [];
  for (const [phaseTitle, members] of groupsByPhaseName) {
    const tally = emptyCounts();
    let minStart: number | null = null;
    let maxEnd: number | null = null;
    let allCompleted = true;
    let accumulatedTokens: number | null = null;

    for (const ag of members) {
      count(tally, ag.state);
      if (ag.startedAt !== null && (minStart === null || ag.startedAt < minStart)) {
        minStart = ag.startedAt;
      }
      if (ENDED_STATES.has(ag.state)) {
        if (ag.endedAt !== null && (maxEnd === null || ag.endedAt > maxEnd)) {
          maxEnd = ag.endedAt;
        }
      } else {
        allCompleted = false;
      }
      if (ag.tokens) {
        accumulatedTokens = (accumulatedTokens ?? 0) + usageTotal(ag.tokens);
      }
    }

    if (!allCompleted) maxEnd = null;
    resultPhases.push({
      name: phaseTitle,
      agents: members,
      counts: tally,
      state: phaseState(tally),
      startedAt: minStart,
      endedAt: maxEnd,
      durationMs: minStart !== null && maxEnd !== null ? Math.max(0, maxEnd - minStart) : null,
      tokens: accumulatedTokens,
    });
  }
  return resultPhases;
}

export function pulseBins(trace: RunTrace | undefined, clock: number): number[] {
  return binsOf(trace?.eventMinutes ?? [], clock);
}

function binsOf(eventMinutes: readonly number[], clock: number): number[] {
  const binArray = new Array<number>(PULSE_BINS).fill(0);
  const endMinute = Math.floor(clock / 60_000);
  const startMinute = endMinute - PULSE_BINS + 1;

  for (let idx = eventMinutes.length - 1; idx >= 0; idx--) {
    const minVal = eventMinutes[idx]!;
    if (minVal < startMinute) break;
    if (minVal <= endMinute) {
      binArray[minVal - startMinute] = (binArray[minVal - startMinute] as number) + 1;
    }
  }
  return binArray;
}

export function costEstimate(tokens: TokenUsage | null | undefined, modelId: string | null, models: readonly ModelOption[] = []): number | null {
  if (!tokens || !modelId) return null;
  const quote = priceOf(modelId, models);
  if (!quote) return null;
  const promptTokensCount = tokens.inputTokens ?? 0;
  const cacheHitCount = Math.min(promptTokensCount, tokens.cacheReadTokens || tokens.cachedTokens || 0);
  return costOf(quote, { promptTokens: promptTokensCount, outputTokens: tokens.outputTokens ?? 0, cachedTokens: cacheHitCount });
}

function launchModel(fold: ThreadFold, turnId: string | null | undefined): string | null {
  if (!turnId) return null;
  let detectedModel: string | null = null;
  for (const call of Object.values(fold.meta.calls)) {
    if (call.turnId !== turnId || !call.modelId || call.modelId === "unknown") continue;
    if (detectedModel !== null && detectedModel !== call.modelId) return null;
    detectedModel = call.modelId;
  }
  return detectedModel;
}

function peakOf(agents: readonly AgentVM[], clock: number): RunVM["peakConcurrency"] {
  const transitionMoments: { at: number; delta: number; phase: string }[] = [];
  for (const agent of agents) {
    for (const attempt of agent.attempts) {
      if (attempt.startedAt === null) continue;
      const termTime = attempt.endedAt ?? (attempt.outcome === null ? clock : null);
      if (termTime === null || termTime < attempt.startedAt) continue;
      transitionMoments.push({ at: attempt.startedAt, delta: 1, phase: agent.phase });
      transitionMoments.push({ at: termTime, delta: -1, phase: agent.phase });
    }
  }
  if (transitionMoments.length === 0) return null;

  transitionMoments.sort((x, y) => x.at - y.at || x.delta - y.delta);
  const activePhaseTally = new Map<string, number>();
  let concurrentNow = 0;
  let maxConcurrency = 0;
  let topPhase = "";

  for (const moment of transitionMoments) {
    concurrentNow += moment.delta;
    activePhaseTally.set(moment.phase, (activePhaseTally.get(moment.phase) ?? 0) + moment.delta);
    if (concurrentNow > maxConcurrency) {
      maxConcurrency = concurrentNow;
      let highestPhaseCount = 0;
      for (const [phaseName, pCount] of activePhaseTally) {
        if (pCount > highestPhaseCount) {
          highestPhaseCount = pCount;
          topPhase = phaseName;
        }
      }
    }
  }
  return maxConcurrency > 0 ? { n: maxConcurrency, phase: topPhase } : null;
}

function phaseAt(phases: readonly PhaseVM[], at: number): string | null {
  for (const phase of phases) {
    for (const agent of phase.agents) {
      const startTimestamp = agent.startedAt ?? agent.attempts.find((att) => att.startedAt !== null)?.startedAt ?? null;
      if (startTimestamp === null || startTimestamp > at) continue;
      if (agent.endedAt === null || agent.endedAt >= at) return phase.name;
    }
  }
  return null;
}

function requestCommand(fold: ThreadFold, id: string, kind: RequestTrace["kind"]): string | null {
  if (kind === "approval") {
    const req = fold.approvals[id];
    return req ? describeApproval(req).detail : null;
  }
  const userInputReq = fold.userInputs[id];
  return userInputReq?.questions?.[0]?.question ?? null;
}

function taskOfRequest(fold: ThreadFold, request: ApprovalRequest | UserInputRequest): string | null {
  const itId = text(request.itemId);
  return itId && fold.items[itId]?.background === true ? itId : null;
}

function runStatusOf(item: MspItem, children: readonly DurableChild[], counts: Counts): RunStatus {
  if (item.status === "inProgress") return children.length === 0 ? "starting" : "running";
  const cleanStat = normalizedWord(item.status);
  if (cleanStat === "cancelled" || cleanStat === "canceled") return "stopped";
  if (TERMINAL_FAILURES.has(item.status)) return "failed";
  return (counts.failed + counts.skipped + counts.unknown > 0) ? "finished-with-failures" : "finished";
}

function runView(item: MspItem, ctx: RunContext): RunVM {
  const { fold, clock } = ctx;
  const trace = fold.crew?.runs[item.itemId];
  const payload = payloadOf(item);
  const launch = launchFor(fold, item, text(payload?.call_id));
  const plan = launch?.plan ?? null;
  const isSettledRun = item.status !== "inProgress";
  const runId = text(item.workflowRunId);

  const byId = new Map<string, DurableChild>();
  const traced = new Map<string, [number, ChildTrace][]>();

  if (trace) {
    for (const traceKey of Object.keys(trace.children)) {
      const sepColon = traceKey.lastIndexOf(":");
      const cid = traceKey.slice(0, sepColon);
      const attemptVal = Number(traceKey.slice(sepColon + 1));
      if (!Number.isInteger(attemptVal)) continue;
      const bucket = traced.get(cid) ?? [];
      bucket.push([attemptVal, trace.children[traceKey] as ChildTrace]);
      traced.set(cid, bucket);
    }
  }

  const presentChildIds = new Set<string>();
  for (const ch of Array.isArray(item.children) ? item.children : []) {
    if (ch && typeof ch.childId === "string") presentChildIds.add(ch.childId);
  }

  for (const cid of traced.keys()) {
    if (presentChildIds.has(cid)) {
      byId.set(cid, { childId: cid, entries: [], latest: { childId: cid, attempt: 0, status: "" }, traces: new Map(), label: null, scheduledAt: null });
    }
  }

  for (const ch of Array.isArray(item.children) ? item.children : []) {
    if (!ch || typeof ch.childId !== "string") continue;
    const normAttempt = Number.isInteger(ch.attempt) && ch.attempt > 0 ? ch.attempt : 1;
    const entryObj = normAttempt === ch.attempt ? ch : { ...ch, attempt: normAttempt };
    const durableChild = byId.get(ch.childId);
    if (durableChild) {
      durableChild.entries.push(entryObj);
      if (entryObj.attempt > durableChild.latest.attempt) durableChild.latest = entryObj;
    } else {
      byId.set(ch.childId, { childId: ch.childId, entries: [entryObj], latest: entryObj, traces: new Map(), label: null, scheduledAt: null });
    }
  }

  for (const [cid, traceList] of traced) {
    const durable = byId.get(cid);
    if (!durable) continue;
    for (const [att, chTrace] of traceList) durable.traces.set(att, chTrace);
  }

  for (const durable of byId.values()) {
    durable.entries.sort((a, b) => a.attempt - b.attempt);
    for (const ent of durable.entries) {
      if (!durable.traces.has(ent.attempt)) durable.traces.set(ent.attempt, undefined);
    }
    const attemptKeysDesc = [...durable.traces.keys()].sort((a, b) => b - a);
    durable.label = [...durable.entries].reverse().map((e) => text(e.label)).find((val) => val !== null)
      ?? attemptKeysDesc.map((att) => text(durable.traces.get(att)?.label)).find((val) => val !== null)
      ?? null;
    const earliestTrace = durable.traces.get(Math.min(...durable.traces.keys()));
    durable.scheduledAt = earliestTrace?.scheduledAt ?? earliestTrace?.startedAt ?? uuidTime(durable.childId);
  }

  const childrenList = [...byId.values()];
  const phaseNames = assignPhases(childrenList);

  const activityTable = new Map<string, { durationMs: number | null; toolCalls: number | null }>();
  if (Array.isArray(payload?.agents_activity)) {
    for (const rawActivity of payload.agents_activity) {
      const actRecord = record(rawActivity);
      const agentIdentifier = text(actRecord?.agent);
      if (actRecord && agentIdentifier) {
        activityTable.set(agentIdentifier, { durationMs: num(actRecord.duration_ms), toolCalls: num(actRecord.tool_calls) });
      }
    }
  }

  interface Fact { durable: DurableChild; outcome: Outcome | null; trace: ChildTrace | undefined; startedAt: number | null; endedAt: number | null; durationMs: number | null }
  const factList: Fact[] = [];
  let maxFinishedDuration: number | null = null;

  for (const durable of childrenList) {
    const latestEntry = durable.latest;
    const latestTrace = durable.traces.get(latestEntry.attempt);
    const childOutcomeVal = childOutcome(latestEntry) ?? (isSettledRun ? "unknown" : null);
    const startTimestamp = latestTrace?.startedAt ?? null;
    const endTimestamp = childOutcomeVal === null ? null : attemptEnd(latestTrace) ?? (isSettledRun ? trace?.endedAt ?? null : null);
    const durFromActivity = num(latestEntry.durationMs) ?? activityTable.get(durable.childId)?.durationMs ?? null;
    const calculatedDuration = childOutcomeVal === null ? null : durFromActivity ?? (startTimestamp !== null && endTimestamp !== null ? Math.max(0, endTimestamp - startTimestamp) : null);

    if (childOutcomeVal === "done" && calculatedDuration !== null && (maxFinishedDuration === null || calculatedDuration > maxFinishedDuration)) {
      maxFinishedDuration = calculatedDuration;
    }
    factList.push({ durable, outcome: childOutcomeVal, trace: latestTrace, startedAt: startTimestamp, endedAt: endTimestamp, durationMs: calculatedDuration });
  }

  const silenceThreshold = isSettledRun || ctx.stale ? null : noUpdateThresholdMs({ longestFinishedMs: maxFinishedDuration });
  const failureReasonDescription = text(payload?.latest_failure) ?? text(item.failureReason);
  let mostRecentFailure: Fact | null = null;

  for (const f of factList) {
    if (f.outcome === "failed" && (mostRecentFailure === null || (f.endedAt ?? 0) >= (mostRecentFailure.endedAt ?? 0))) {
      mostRecentFailure = f;
    }
  }
  const isCancelledStatus = normalizedWord(item.status) === "cancelled" || normalizedWord(item.status) === "canceled";

  const sessionCache = runCacheFor(`${ctx.sessionId ?? ""}:${item.itemId}`);
  const nextCacheChildren = new Map<string, ChildCacheEntry>();
  const agentsList: AgentVM[] = [];
  let containsUnnamedAgent = false;

  for (const f of factList) {
    const { durable, outcome } = f;
    const latestEntry = durable.latest;
    const currentTrace = f.trace;
    const childPendingKey = ctx.sessionId ? pendingKey(ctx.sessionId, durable.childId, latestEntry.attempt) : null;

    let computedState: AgentState;
    if (outcome !== null) {
      computedState = outcome;
    } else {
      computedState = lifecycleState(latestEntry.status);
      if (computedState !== "scheduled" && silenceThreshold !== null && currentTrace?.lastEventAt != null && clock - currentTrace.lastEventAt >= silenceThreshold) {
        computedState = "no-update";
      }
    }

    const isLiveAgent = outcome === null;
    const pendingActionVal = childPendingKey ? ctx.pending[childPendingKey] ?? null : null;
    const pendingDirective: PendingAction | null = (pendingActionVal === "retry" && isLiveAgent) ? "retry" : (pendingActionVal === "stop" && isLiveAgent) ? "stop" : null;
    const skipCause: SkippedBy | null = outcome === "skipped" ? (childPendingKey && ctx.skipped.has(childPendingKey) ? "you" : isCancelledStatus ? "run" : "muse") : null;

    const childLabel = durable.label;
    if (childLabel === null) containsUnnamedAgent = true;
    const agentDisplayName = childLabel ?? `Agent ${numberFor(ctx.numbers, durable.childId)}`;

    const cachedChild = sessionCache.children.get(durable.childId);
    const traceArray = [...durable.traces.keys()].sort((x, y) => x - y).map((att) => durable.traces.get(att));
    const versionSig = `${latestEntry.attempt}|${latestEntry.status}|${latestEntry.terminal ?? ""}|${isSettledRun ? 1 : 0}|${durable.entries.length}`;

    const attemptsList = (cachedChild && cachedChild.signature === versionSig && cachedChild.traces.length === traceArray.length && cachedChild.traces.every((t, i) => t === traceArray[i]))
      ? cachedChild.vm.attempts
      : buildAttempts(durable, isSettledRun);

    const silenceInterval = isLiveAgent && computedState !== "scheduled" && currentTrace?.lastEventAt != null
      ? Math.max(0, clock - currentTrace.lastEventAt)
      : null;
    const runningTimeElapsed = isLiveAgent && f.startedAt !== null
      ? Math.max(0, clock - f.startedAt)
      : null;

    const durationMetric = f.durationMs ?? runningTimeElapsed;
    const failureDetail = outcome === "failed"
      ? { text: f === mostRecentFailure ? failureReasonDescription : null, at: f.endedAt }
      : null;

    const taskTextFromPlan = childLabel !== null ? plan?.inputs[childLabel] ?? null : null;
    const tokensReported = currentTrace?.usage ?? latestEntry.usage ?? attemptsList.slice().reverse().map((att) => durable.traces.get(att.attempt)?.usage).find((u) => u !== undefined) ?? null;

    const candidateVM: AgentVM = {
      id: durable.childId,
      attempt: latestEntry.attempt,
      name: agentDisplayName,
      label: childLabel,
      display: displayOf(agentDisplayName),
      phase: phaseNames.get(durable.childId) ?? "Agents",
      kind: "workflow",
      state: computedState,
      pending: pendingDirective,
      skippedBy: skipCause,
      startedAt: f.startedAt,
      endedAt: f.endedAt,
      lastEventAt: currentTrace?.lastEventAt ?? null,
      silenceMs: silenceInterval,
      runningMs: runningTimeElapsed,
      durationMs: f.durationMs,
      approx: currentTrace?.approx ?? false,
      tokens: tokensReported,
      toolCalls: activityTable.get(durable.childId)?.toolCalls ?? null,
      attempts: attemptsList,
      failure: failureDetail,
      task: taskTextFromPlan !== null ? { text: taskTextFromPlan, source: "script" } : null,
      shareOfLongest: durationMetric !== null && maxFinishedDuration !== null && maxFinishedDuration > 0 ? durationMetric / maxFinishedDuration : null,
      quiet: computedState === "no-update" ? { thresholdMs: silenceThreshold as number, longestFinishedMs: maxFinishedDuration } : null,
      needs: null,
      runItemId: item.itemId,
      workflowRunId: runId,
    };

    const finalVM = (cachedChild && sameAgent(cachedChild.vm, candidateVM)) ? cachedChild.vm : candidateVM;
    nextCacheChildren.set(durable.childId, { vm: finalVM, traces: traceArray, signature: versionSig });
    agentsList.push(finalVM);
  }
  sessionCache.children = nextCacheChildren;

  const plannedAreKnown = plan !== null && plan.complete;
  if (plannedAreKnown && !isSettledRun) {
    const knownLabels = new Set(childrenList.map((ch) => ch.label));
    for (const planLabel of plan.labels) {
      if (knownLabels.has(planLabel)) continue;
      knownLabels.add(planLabel);
      const planTaskText = plan.inputs[planLabel] ?? null;
      agentsList.push({
        id: `planned:${planLabel}`,
        attempt: 0,
        name: planLabel,
        label: planLabel,
        display: displayOf(planLabel),
        phase: prefixPhase(planLabel) ?? "Agents",
        kind: "workflow",
        state: "planned",
        pending: null,
        skippedBy: null,
        startedAt: null,
        endedAt: null,
        lastEventAt: null,
        silenceMs: null,
        runningMs: null,
        durationMs: null,
        approx: false,
        tokens: null,
        toolCalls: null,
        attempts: [],
        failure: null,
        task: planTaskText !== null ? { text: planTaskText, source: "script" } : null,
        shareOfLongest: null,
        quiet: null,
        needs: null,
        runItemId: item.itemId,
        workflowRunId: runId,
      });
    }
  }

  const generatedPhases = phasesOf(agentsList);
  const statusCounts = runCounts({ phases: generatedPhases });
  const finalStatus = runStatusOf(item, childrenList, statusCounts);
  const runStartTimestamp = trace?.startedAt ?? null;
  const runEndTimestamp = isSettledRun ? trace?.endedAt ?? null : null;
  const runDurationMs = runStartTimestamp !== null ? Math.max(0, (runEndTimestamp ?? clock) - runStartTimestamp) : null;

  let totalTokensSum = 0;
  let reportingAgentsCount = 0;
  const aggregatedUsageRecord: TokenUsage = {};
  let accumulatedAgentTime: number | null = null;
  let retriedAgentsCount = 0;

  for (const ag of agentsList) {
    if (ag.tokens) {
      reportingAgentsCount += 1;
      totalTokensSum += usageTotal(ag.tokens);
      for (const field of ["inputTokens", "outputTokens", "reasoningTokens", "cachedTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        const val = ag.tokens[field];
        if (val !== undefined) aggregatedUsageRecord[field] = (aggregatedUsageRecord[field] ?? 0) + val;
      }
    }
    if (ag.durationMs !== null) accumulatedAgentTime = (accumulatedAgentTime ?? 0) + ag.durationMs;
    if (ag.attempt > 1) retriedAgentsCount += 1;
  }

  const activePriceModel = (isSettledRun ? launchModel(fold, item.turnId) : null) ?? ctx.model;
  const estimatedCostUsd = reportingAgentsCount > 0 ? costEstimate(aggregatedUsageRecord, activePriceModel, ctx.models) : null;
  const launchPolicyRef = launch?.policy ?? null;
  const parallelCapacity = launchPolicyRef?.maxParallelAgents ?? launchPolicyRef?.childLimit ?? null;

  const unassignedNeeds: RunNeedVM[] = [];
  if (!isSettledRun) {
    const pendingRequestList: { id: string; kind: RequestTrace["kind"]; request: ApprovalRequest | UserInputRequest }[] = [
      ...Object.values(fold.approvals).map((req) => ({ id: req.approvalId, kind: "approval" as const, request: req })),
      ...Object.values(fold.userInputs).map((req) => ({ id: req.userInputId, kind: "input" as const, request: req })),
    ];
    for (const { id, kind, request } of pendingRequestList) {
      if (taskOfRequest(fold, request) !== null) continue;
      const requestedTimestamp = fold.crew?.requests[id]?.askedAt ?? null;
      unassignedNeeds.push({
        kind,
        command: requestCommand(fold, id, kind),
        askedAt: requestedTimestamp,
        requestId: id,
        phase: requestedTimestamp !== null ? phaseAt(generatedPhases, requestedTimestamp) : null,
      });
    }
  }

  let totalUserWaitTime: number | null = null;
  if (runStartTimestamp !== null && fold.crew) {
    for (const req of Object.values(fold.crew.requests)) {
      if (req.askedAt === null || req.askedAt < runStartTimestamp || (runEndTimestamp !== null && req.askedAt > runEndTimestamp)) continue;
      const decisionOrEnd = req.decidedAt ?? (runEndTimestamp ?? clock);
      totalUserWaitTime = (totalUserWaitTime ?? 0) + Math.max(0, decisionOrEnd - req.askedAt);
    }
  }

  const activePhase = generatedPhases.find((p) => p.agents.some((ag) => LIVE_STATES.has(ag.state)))
    ?? generatedPhases.find((p) => p.agents.some((ag) => ag.state === "planned"))
    ?? null;

  const rawHandoffsList = Array.isArray((payload as Record<string, unknown> | null)?.workspace_handoffs)
    ? ((payload as Record<string, unknown>)!.workspace_handoffs as unknown[])
        .map(record)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => ({ agent: text(entry.agent) ?? "", description: text(entry.description) ?? "" }))
        .filter((entry) => entry.agent || entry.description)
    : [];

  return {
    itemId: item.itemId,
    runId,
    name: text(item.entryId) ?? launch?.name ?? extractScriptSlug(text(item.scriptId)) ?? "Workflow",
    kind: "workflow",
    research: null,
    status: finalStatus,
    revision: item.revision,
    startedAt: runStartTimestamp,
    endedAt: runEndTimestamp,
    elapsedMs: runDurationMs,
    elapsedApprox: trace?.approx ?? true,
    partialHistory: ctx.partialHistory || containsUnnamedAgent || (trace?.approx ?? false),
    phases: generatedPhases,
    agents: agentsList,
    counts: statusCounts,
    attention: attentionOrder(agentsList),
    runNeeds: unassignedNeeds,
    currentPhase: activePhase?.name ?? null,
    plannedKnown: plannedAreKnown,
    tokens: reportingAgentsCount > 0 ? { total: totalTokensSum, reported: reportingAgentsCount, of: childrenList.length } : null,
    cost: estimatedCostUsd !== null && activePriceModel ? { usd: estimatedCostUsd, model: activePriceModel } : null,
    priceModel: activePriceModel,
    slots: parallelCapacity !== null ? { used: statusCounts.working + statusCounts.finishing + statusCounts.noUpdate, max: parallelCapacity } : null,
    pulse: pulseBins(trace, clock),
    longestFinishedMs: maxFinishedDuration,
    agentTimeMs: accumulatedAgentTime,
    peakConcurrency: peakOf(agentsList, clock),
    waitedOnYouMs: totalUserWaitTime,
    retried: retriedAgentsCount,
    report: isSettledRun ? { summary: text(payload?.final_summary?.summary), failure: failureReasonDescription, handoffs: rawHandoffsList } : null,
    stale: ctx.stale,
    staleAt: ctx.stale ? ctx.staleAt : null,
    clockAt: clock,
  };
}

function extractScriptSlug(idStr: string | null): string | null {
  if (!idStr) return null;
  return idStr.replace(/^generated\.(?:workflow\.)?/, "") || idStr;
}

function numberFor(agentNumbersMap: AgentNumbers, idKey: string): number {
  let val = agentNumbersMap.get(idKey);
  if (val === undefined) {
    val = agentNumbersMap.size + 1;
    agentNumbersMap.set(idKey, val);
  }
  return val;
}

function taskState(item: MspItem, silenceMs: number | null, needs: AgentVM["needs"]): AgentState {
  if (item.status === "inProgress") {
    if (needs) return "waiting-on-you";
    return (silenceMs !== null && silenceMs >= TASK_NO_OUTPUT_MS) ? "no-update" : "working";
  }
  const termOutcome = outcomeOfTerminal(item.status);
  if (termOutcome === "skipped") return termOutcome;
  if (text(item.failureKind) || text(item.failureReason) || (typeof item.exitCode === "number" && item.exitCode !== 0) || (typeof item.exitSignal === "number" && item.exitSignal !== 0)) {
    return "failed";
  }
  return termOutcome;
}

function needsOf(fold: ThreadFold, item: MspItem): AgentVM["needs"] {
  for (const req of Object.values(fold.approvals)) {
    if (req.itemId === item.itemId || (text(item.approvalId) !== null && req.approvalId === item.approvalId)) {
      return { kind: "approval", command: describeApproval(req).detail, askedAt: fold.crew?.requests[req.approvalId]?.askedAt ?? null, requestId: req.approvalId };
    }
  }
  for (const req of Object.values(fold.userInputs)) {
    if (req.itemId === item.itemId) {
      return { kind: "input", command: req.questions?.[0]?.question ?? null, askedAt: fold.crew?.requests[req.userInputId]?.askedAt ?? null, requestId: req.userInputId };
    }
  }
  return null;
}

function taskView(item: MspItem, trace: TaskTrace | undefined, ctx: RunContext): AgentVM {
  const { fold, clock } = ctx;
  const toolDesc = describeTool(item);
  const isBackgroundExecution = item.background === true;
  const commandTitle = toolDesc.subject ?? text(item.tool) ?? "task";
  const parentTurn = item.turnId ? fold.turns[item.turnId] : undefined;
  const isUnreportedForeground = !isBackgroundExecution && item.status === "inProgress" && Boolean(parentTurn?.terminal);
  const isCurrentlyRunning = item.status === "inProgress" && !isUnreportedForeground;

  const startTimestamp = trace?.firstSeenAt ?? null;
  const finishTimestamp = isCurrentlyRunning ? null : trace?.endedAt ?? parentTurn?.completedAt ?? null;
  const lastOutputTimestamp = trace?.lastOutputAt ?? null;
  const latestActivityMarker = lastOutputTimestamp ?? startTimestamp;
  const silenceElapsed = isCurrentlyRunning && latestActivityMarker !== null ? Math.max(0, clock - latestActivityMarker) : null;
  const pendingRequest = isCurrentlyRunning ? needsOf(fold, item) : null;

  const resolvedState = isUnreportedForeground
    ? (outcomeOfTerminal(parentTurn?.terminal) === "skipped" ? "skipped" : "unknown")
    : taskState(item, ctx.stale ? null : silenceElapsed, pendingRequest);

  const pendingLookupKey = ctx.sessionId ? pendingKey(ctx.sessionId, item.itemId, 1) : null;
  const pendingFlag = pendingLookupKey ? ctx.pending[pendingLookupKey] ?? null : null;
  const initiatorOrigin = (item.backgroundInitiator === "user" || item.backgroundInitiator === "timeout") ? item.backgroundInitiator : null;

  return {
    id: item.itemId,
    attempt: 1,
    name: commandTitle,
    label: commandTitle,
    display: { prefix: null, short: commandTitle },
    phase: isBackgroundExecution ? "Background" : "Tools",
    kind: "task",
    sourceTurnId: item.turnId ?? null,
    state: resolvedState,
    pending: isCurrentlyRunning && pendingFlag === "stop" ? "stop" : null,
    skippedBy: resolvedState === "skipped" ? (pendingLookupKey && ctx.skipped.has(pendingLookupKey) ? "you" : "muse") : null,
    startedAt: startTimestamp,
    endedAt: finishTimestamp,
    lastEventAt: finishTimestamp ?? lastOutputTimestamp ?? startTimestamp,
    silenceMs: silenceElapsed,
    runningMs: isCurrentlyRunning && startTimestamp !== null ? Math.max(0, clock - startTimestamp) : null,
    durationMs: !isCurrentlyRunning ? num(item.durationMs) ?? (startTimestamp !== null && finishTimestamp !== null ? Math.max(0, finishTimestamp - startTimestamp) : null) : null,
    approx: trace?.approx ?? true,
    tokens: null,
    toolCalls: null,
    attempts: [],
    failure: resolvedState === "failed" ? {
      text: text(item.failureReason) ?? text(item.failureKind) ?? (typeof item.exitCode === "number" && item.exitCode !== 0 ? `Exited with code ${item.exitCode}` : typeof item.exitSignal === "number" && item.exitSignal !== 0 ? `Stopped by signal ${item.exitSignal}` : null),
      at: finishTimestamp,
    } : null,
    task: null,
    shareOfLongest: null,
    quiet: resolvedState === "no-update" ? { thresholdMs: TASK_NO_OUTPUT_MS, longestFinishedMs: null } : null,
    needs: pendingRequest,
    runItemId: null,
    workflowRunId: null,
    taskInfo: {
      command: commandTitle,
      tail: lastLine(item.visibleOutput),
      lastOutputAt: lastOutputTimestamp,
      initiator: initiatorOrigin,
      approvalId: text(item.approvalId),
      background: isBackgroundExecution,
      stoppable: isBackgroundExecution || toolDesc.kind === "shell",
      exitCode: num(item.exitCode),
      exitSignal: num(item.exitSignal),
      look: { kind: toolDesc.kind, verb: toolDesc.verb, subject: toolDesc.subject, mono: toolDesc.mono, note: toolDesc.note },
    },
  };
}

function subagentState(item: MspItem): AgentState {
  if (item.status !== "inProgress") {
    if (text(item.failureKind) || text(item.failureReason)) return "failed";
    return outcomeOfTerminal(item.status);
  }
  const cleanControl = normalizedWord(item.controlStatus);
  if (cleanControl === "awaitinginput" || cleanControl === "awaitingapproval") return "waiting-on-you";
  if (cleanControl === "resultready" || cleanControl === "closing" || cleanControl === "closed") return "done";
  if (cleanControl === "accepted" || cleanControl === "starting") return "scheduled";
  return "working";
}

function subagentView(item: MspItem, ctx: RunContext): AgentVM {
  const subagentIdStr = text(item.subagentId) ?? text(item.childId) ?? text(item.childSessionId) ?? `item:${item.itemId}`;
  const roleName = text(item.role) ?? text(item.name) ?? text(item.title);
  const resolvedDisplayName = roleName ?? `Agent ${numberFor(ctx.numbers, subagentIdStr)}`;
  const computedState = subagentState(item);
  const isAgentLive = LIVE_STATES.has(computedState);
  const parsedRecordedTime = item.recordedAt ? Date.parse(item.recordedAt) : NaN;
  const recordedTimestamp = Number.isFinite(parsedRecordedTime) ? parsedRecordedTime : null;

  const keyRef = ctx.sessionId ? pendingKey(ctx.sessionId, subagentIdStr, 1) : null;
  const pendingDirective = keyRef ? ctx.pending[keyRef] ?? null : null;
  const taskObjective = text(item.objective);

  return {
    id: subagentIdStr,
    attempt: 1,
    name: resolvedDisplayName,
    label: roleName,
    display: displayOf(resolvedDisplayName),
    phase: "Subagents",
    kind: "subagent",
    sourceTurnId: item.turnId ?? null,
    state: computedState,
    pending: isAgentLive && pendingDirective === "stop" ? "stop" : null,
    skippedBy: computedState === "skipped" ? (keyRef && ctx.skipped.has(keyRef) ? "you" : "muse") : null,
    startedAt: null,
    endedAt: isAgentLive ? null : recordedTimestamp,
    lastEventAt: recordedTimestamp,
    silenceMs: null,
    runningMs: null,
    durationMs: num(item.durationMs),
    approx: true,
    tokens: item.usage ?? null,
    toolCalls: num(item.toolCalls),
    attempts: [],
    failure: computedState === "failed" ? { text: text(item.failureReason) ?? text(item.result?.errorKind), at: recordedTimestamp } : null,
    task: taskObjective ? { text: taskObjective, source: "objective" } : null,
    shareOfLongest: null,
    quiet: null,
    needs: computedState === "waiting-on-you" ? { kind: "input", command: null, askedAt: null, requestId: item.itemId } : null,
    runItemId: null,
    workflowRunId: text(item.workflowRunId),
  };
}

const nativeWaitIndexMap = new WeakMap<Record<string, MspItem>, { order: readonly string[]; waits: ReadonlyMap<string, MspItem> }>();
const parsedArgsCache = new WeakMap<MspItem, ReturnType<typeof parseArgs>>();
const parsedOutputCache = new WeakMap<MspItem, ReturnType<typeof parseArgs>>();

function nativeArgs(item: MspItem): ReturnType<typeof parseArgs> {
  if (!parsedArgsCache.has(item)) parsedArgsCache.set(item, parseArgs(item.args));
  return parsedArgsCache.get(item) ?? null;
}

function nativeOutput(item: MspItem): ReturnType<typeof parseArgs> {
  if (!parsedOutputCache.has(item)) parsedOutputCache.set(item, parseArgs(item.visibleOutput));
  return parsedOutputCache.get(item) ?? null;
}

function nativeWaits(fold: ThreadFold, waitToolIds: readonly string[]): ReadonlyMap<string, MspItem> {
  const currentItems = fold.agentItems ?? fold.items;
  const memoized = nativeWaitIndexMap.get(currentItems);
  if (memoized?.order === fold.order) return memoized.waits;

  const gatheredWaits = new Map<string, MspItem>();
  if (waitToolIds.length > 0) {
    const transcriptPosMap = transcriptPositions(fold.order);
    for (const tid of waitToolIds) {
      const waitItem = currentItems[tid];
      if (!waitItem || waitItem.status === "inProgress") continue;
      const targetChildId = text(nativeArgs(waitItem)?.subagent_id);
      if (!targetChildId) continue;
      const existing = gatheredWaits.get(targetChildId);
      if (!existing || (transcriptPosMap.get(tid) ?? -1) > (transcriptPosMap.get(existing.itemId) ?? -1)) {
        gatheredWaits.set(targetChildId, waitItem);
      }
    }
  }
  nativeWaitIndexMap.set(currentItems, { order: fold.order, waits: gatheredWaits });
  return gatheredWaits;
}

function nativeSubagent(spawn: MspItem, waits: ReadonlyMap<string, MspItem>): { id: string; state: AgentState; settled: MspItem | null; result: Record<string, unknown> | null } {
  const spawnOut = nativeOutput(spawn);
  const identifier = text(spawnOut?.subagent_id) ?? `spawn:${spawn.itemId}`;
  const spawnAdmission = outcomeOfTerminal(spawn.status);

  if (spawn.status !== "inProgress" && (spawnAdmission === "skipped" || spawnAdmission === "failed" || text(spawn.failureKind) || text(spawn.failureReason))) {
    return { id: identifier, state: spawnAdmission === "skipped" ? "skipped" : "failed", settled: spawn, result: spawnOut };
  }

  const waitToolItem = waits.get(identifier);
  const waitOutputData = waitToolItem ? nativeOutput(waitToolItem) : null;
  const statusString = normalizedWord(text(waitOutputData?.status) ?? undefined);

  let targetState: AgentState = "working";
  if (waitToolItem) {
    if (["ready", "completed", "complete", "done", "success", "succeeded", "resultready"].includes(statusString)) {
      targetState = "done";
    } else if (["failed", "error", "rejected"].includes(statusString)) {
      targetState = "failed";
    } else if (["cancelled", "canceled", "stopped"].includes(statusString)) {
      targetState = "skipped";
    }
  }
  return { id: identifier, state: targetState, settled: targetState === "working" ? null : waitToolItem ?? null, result: waitOutputData };
}

function spawnView(spawn: MspItem, waits: ReadonlyMap<string, MspItem>, ctx: RunContext): AgentVM {
  const spawnArguments = nativeArgs(spawn);
  const { id, state, settled, result } = nativeSubagent(spawn, waits);
  const roleName = text(spawnArguments?.task_name) ?? text(spawnArguments?.role);
  const resolvedName = roleName ?? `Agent ${numberFor(ctx.numbers, id)}`;
  const spawnStartAt = ctx.fold.crew?.tasks[spawn.itemId]?.firstSeenAt ?? isoMs(spawn.recordedAt);
  const spawnEndAt = state === "working" ? null : (settled ? ctx.fold.crew?.tasks[settled.itemId]?.endedAt ?? isoMs(settled.recordedAt) : null);
  const targetObjective = text(spawnArguments?.objective);
  const keyIdentifier = ctx.sessionId ? pendingKey(ctx.sessionId, id, 1) : null;

  return {
    id,
    attempt: 1,
    name: resolvedName,
    label: roleName,
    display: displayOf(resolvedName),
    phase: "Subagents",
    kind: "subagent",
    sourceTurnId: spawn.turnId ?? null,
    state,
    pending: state === "working" && keyIdentifier && ctx.pending[keyIdentifier] === "stop" ? "stop" : null,
    skippedBy: state === "skipped" ? (keyIdentifier && ctx.skipped.has(keyIdentifier) ? "you" : "muse") : null,
    startedAt: spawnStartAt,
    endedAt: spawnEndAt,
    lastEventAt: spawnEndAt ?? spawnStartAt,
    silenceMs: null,
    runningMs: state === "working" && spawnStartAt !== null ? Math.max(0, ctx.clock - spawnStartAt) : null,
    durationMs: spawnStartAt !== null && spawnEndAt !== null ? Math.max(0, spawnEndAt - spawnStartAt) : null,
    approx: true,
    tokens: null,
    toolCalls: null,
    attempts: [],
    failure: state === "failed" ? { text: text(settled?.failureReason) ?? text(settled?.failureKind) ?? text(result?.summary), at: spawnEndAt } : null,
    task: targetObjective ? { text: targetObjective, source: "objective" } : null,
    shareOfLongest: null,
    quiet: null,
    needs: null,
    runItemId: null,
    workflowRunId: null,
  };
}

function isoMs(isoString: string | null | undefined): number | null {
  if (!isoString) return null;
  const parsedEpoch = Date.parse(isoString);
  return Number.isFinite(parsedEpoch) ? parsedEpoch : null;
}

function researchWorkerState(state: ResearchWorkerState): AgentState {
  switch (state) {
    case "queued": return "scheduled";
    case "working": return "working";
    case "completed": return "done";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "skipped";
  }
}

function researchRunStatus(run: ResearchRunView): RunStatus {
  switch (run.status) {
    case "queued": return "starting";
    case "running": return run.workers.length === 0 ? "starting" : "running";
    case "completed": return "finished";
    case "partial": return "finished-with-failures";
    case "failed": return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function researchPhaseName(roundNumber: number, maxRoundsCount: number): string {
  return maxRoundsCount > 0 ? `Round ${roundNumber} of ${maxRoundsCount}` : `Round ${roundNumber}`;
}

function researchUsage(run: ResearchRunView): TokenUsage | null {
  if (run.usage.totalTokens <= 0) return null;
  return { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, cachedTokens: run.usage.cachedInputTokens };
}

function researchAttempt(worker: ResearchWorkerView, state: AgentState, startedAt: number | null, endedAt: number | null, durationMs: number | null): AttemptVM {
  const attemptEventsList: AttemptEventVM[] = [{ kind: "scheduled", at: null, detail: null }];
  if (state !== "scheduled") attemptEventsList.push({ kind: "started", at: startedAt, detail: null });
  const terminalOutcome: AttemptVM["outcome"] = state === "done" ? "done" : state === "failed" ? "failed" : state === "skipped" ? "skipped" : null;
  if (terminalOutcome !== null) {
    const afterNotice = durationMs !== null ? `after ${durationText(durationMs)}` : null;
    attemptEventsList.push({
      kind: terminalOutcome === "done" ? "completed" : terminalOutcome === "failed" ? "failed" : "cancelled",
      at: endedAt,
      detail: worker.state === "timed_out" ? "timed out" : afterNotice,
    });
  }
  return { attempt: 1, events: attemptEventsList, startedAt, endedAt, outcome: terminalOutcome };
}

function researchRunView(run: ResearchRunView, ctx: RunContext): RunVM {
  const { clock } = ctx;
  const researchItemKey = researchItemId(run.runId);
  const isResearchConcluded = researchEnded(run);
  const startEpoch = isoMs(run.startedAt) ?? isoMs(run.createdAt);
  const endEpoch = isResearchConcluded ? isoMs(run.endedAt) : null;

  const assignedWorkerModel = run.config.models.worker ?? ctx.model;
  const assignedSupervisorModel = run.config.models.supervisor ?? ctx.model;
  const assignedWriterModel = run.config.models.writer ?? ctx.model;
  const modelsAllResolved = assignedWorkerModel !== null && assignedSupervisorModel !== null && assignedWriterModel !== null;
  const hasMixedModelAssignments = modelsAllResolved && (assignedWorkerModel !== assignedSupervisorModel || assignedWorkerModel !== assignedWriterModel);
  const singlePricingModel = modelsAllResolved && !hasMixedModelAssignments ? assignedWorkerModel : null;

  const sortedWorkers = [...run.workers].sort((x, y) => x.round - y.round || x.agentId - y.agentId);
  interface Fact { worker: ResearchWorkerView; state: AgentState; startedAt: number | null; endedAt: number | null; durationMs: number | null }
  const researchFacts: Fact[] = [];
  let maxCompletedWorkerDuration: number | null = null;
  const eventMinuteStamps: number[] = [];

  for (const w of sortedWorkers) {
    const workerStateVal = researchWorkerState(w.state);
    const isLive = LIVE_STATES.has(workerStateVal);
    const wStart = workerStateVal === "scheduled" ? null : isoMs(w.startedAt);
    const wEnd = isLive ? null : isoMs(w.endedAt);
    const wDuration = wStart !== null && wEnd !== null ? Math.max(0, wEnd - wStart) : null;

    if (workerStateVal === "done" && wDuration !== null && (maxCompletedWorkerDuration === null || wDuration > maxCompletedWorkerDuration)) {
      maxCompletedWorkerDuration = wDuration;
    }
    if (wStart !== null) eventMinuteStamps.push(Math.floor(wStart / 60_000));
    if (wEnd !== null) eventMinuteStamps.push(Math.floor(wEnd / 60_000));
    researchFacts.push({ worker: w, state: workerStateVal, startedAt: wStart, endedAt: wEnd, durationMs: wDuration });
  }
  eventMinuteStamps.sort((a, b) => a - b);

  const runCache = runCacheFor(`${ctx.sessionId ?? ""}:${researchItemKey}`);
  const nextCacheChildren = new Map<string, ChildCacheEntry>();
  const workerAgentsList: AgentVM[] = [];

  for (const fact of researchFacts) {
    const { worker, state } = fact;
    const workerId = researchAgentId(run.runId, worker.agentId);
    const workerName = `A${worker.agentId} · ${worker.topic}`;
    const isWorkerLive = LIVE_STATES.has(state);
    const runningElapsed = isWorkerLive && fact.startedAt !== null ? Math.max(0, clock - fact.startedAt) : null;
    const measurement = fact.durationMs ?? runningElapsed;
    const workerSig = `${worker.state}|${fact.startedAt ?? ""}|${fact.endedAt ?? ""}`;
    const cachedEntry = runCache.children.get(workerId);
    const attemptsArray = cachedEntry && cachedEntry.signature === workerSig
      ? cachedEntry.vm.attempts
      : [researchAttempt(worker, state, fact.startedAt, fact.endedAt, fact.durationMs)];

    const candidateAgent: AgentVM = {
      id: workerId,
      attempt: 1,
      name: workerName,
      label: workerName,
      display: { prefix: null, short: workerName },
      phase: researchPhaseName(worker.round, run.maxRounds),
      kind: "research",
      state,
      pending: null,
      skippedBy: state === "skipped" ? "run" : null,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
      lastEventAt: fact.endedAt ?? fact.startedAt,
      silenceMs: null,
      runningMs: runningElapsed,
      durationMs: fact.durationMs,
      approx: false,
      tokens: null,
      toolCalls: worker.toolCalls,
      attempts: attemptsArray,
      failure: state === "failed" ? {
        text: worker.state === "timed_out" ? `Timed out after ${plural(run.config.workerWallTimeMinutes, "minute")}` : null,
        at: fact.endedAt,
      } : null,
      task: { text: worker.topic, source: "objective" },
      shareOfLongest: measurement !== null && maxCompletedWorkerDuration !== null && maxCompletedWorkerDuration > 0 ? measurement / maxCompletedWorkerDuration : null,
      quiet: null,
      needs: null,
      runItemId: researchItemKey,
      workflowRunId: null,
      research: { agentId: worker.agentId, round: worker.round, searches: worker.searches, reads: worker.reads, saved: worker.saved, discovery: worker.discovery, model: assignedWorkerModel, wireState: worker.state },
    };

    const finalAgentVM = (cachedEntry && sameAgent(cachedEntry.vm, candidateAgent)) ? cachedEntry.vm : candidateAgent;
    nextCacheChildren.set(workerId, { vm: finalAgentVM, traces: [], signature: workerSig });
    workerAgentsList.push(finalAgentVM);
  }
  runCache.children = nextCacheChildren;

  const researchPhases = phasesOf(workerAgentsList);
  const researchCounts = runCounts({ phases: researchPhases });
  const computedRunStatus = researchRunStatus(run);
  const totalRunElapsed = startEpoch !== null ? Math.max(0, (endEpoch ?? clock) - startEpoch) : null;
  const totalTokensObj = researchUsage(run);
  const costEstimateUsd = totalTokensObj && singlePricingModel ? costEstimate(totalTokensObj, singlePricingModel, ctx.models) : null;

  let totalWorkerTime: number | null = null;
  for (const ag of workerAgentsList) {
    if (ag.durationMs !== null) totalWorkerTime = (totalWorkerTime ?? 0) + ag.durationMs;
  }

  const livePhase = researchPhases.find((p) => p.agents.some((ag) => LIVE_STATES.has(ag.state))) ?? null;
  const formattedSources = sourcesLine(run.sources);
  const summaryReportText = isResearchConcluded
    ? [formattedSources ?? "No sources were saved", run.reportAvailable ? "The report is in the transcript." : "No report was written."].join("\n")
    : null;

  return {
    itemId: researchItemKey,
    runId: run.runId,
    name: researchThreadTitle(run.question),
    kind: "research",
    research: {
      runId: run.runId,
      status: run.status,
      phase: run.phase,
      round: run.round,
      maxRounds: run.maxRounds,
      question: run.question,
      sources: run.sources,
      ...(run.noCitableSources ? { noCitableSources: true as const } : {}),
      deadlineAt: isResearchConcluded ? null : isoMs(run.researchDeadlineAt),
      reportAvailable: run.reportAvailable,
    },
    status: computedRunStatus,
    revision: 0,
    startedAt: startEpoch,
    endedAt: endEpoch,
    elapsedMs: totalRunElapsed,
    elapsedApprox: false,
    partialHistory: false,
    phases: researchPhases,
    agents: workerAgentsList,
    counts: researchCounts,
    attention: attentionOrder(workerAgentsList),
    runNeeds: [],
    currentPhase: livePhase?.name ?? null,
    plannedKnown: false,
    tokens: totalTokensObj ? { total: run.usage.totalTokens, reported: 0, of: sortedWorkers.length } : null,
    cost: costEstimateUsd !== null && singlePricingModel ? { usd: costEstimateUsd, model: singlePricingModel } : null,
    priceModel: singlePricingModel,
    mixedModels: hasMixedModelAssignments,
    slots: run.config.maxParallel > 0 ? { used: researchCounts.working + researchCounts.finishing + researchCounts.noUpdate, max: run.config.maxParallel } : null,
    pulse: binsOf(eventMinuteStamps, clock),
    longestFinishedMs: maxCompletedWorkerDuration,
    agentTimeMs: totalWorkerTime,
    peakConcurrency: peakOf(workerAgentsList, clock),
    waitedOnYouMs: null,
    retried: 0,
    report: isResearchConcluded ? { summary: summaryReportText, failure: run.status === "interrupted" && run.failure ? interruptedLine(run.failure) : run.failure, handoffs: [] } : null,
    stale: ctx.stale,
    staleAt: ctx.stale ? ctx.staleAt : null,
    clockAt: clock,
  };
}

function monitoredTurn(fold: ThreadFold): TurnInfo | null {
  if (fold.activeTurnId) return fold.turns[fold.activeTurnId] ?? { turnId: fold.activeTurnId };
  const turnsList = Object.values(fold.turns);
  let latestTurn: TurnInfo | null = null;
  let latestTurnTimestamp: number | null = null;

  const comesAfter = (candidateTurn: string, prevTurn: string): boolean => {
    for (let idx = fold.order.length - 1; idx >= 0; idx--) {
      const tId = fold.items[fold.order[idx]!]?.turnId;
      if (tId === candidateTurn) return true;
      if (tId === prevTurn) return false;
    }
    return false;
  };

  for (const turnRecord of turnsList) {
    if (turnRecord.retracted) continue;
    const epochTime = turnRecord.startedAt ?? uuidTime(turnRecord.turnId) ?? turnRecord.completedAt ?? null;
    if (!latestTurn || (epochTime !== null && (latestTurnTimestamp === null || epochTime > latestTurnTimestamp)) || (epochTime === latestTurnTimestamp && comesAfter(turnRecord.turnId, latestTurn.turnId))) {
      latestTurn = turnRecord;
      latestTurnTimestamp = epochTime;
    }
  }
  return latestTurn;
}

export function crewTurnKey(fold: ThreadFold | null | undefined): string {
  const turn = fold ? monitoredTurn(fold) : null;
  return turn ? [fold?.activeTurnId, turn.turnId, turn.startedAt, turn.completedAt, turn.terminal, turn.durationMs, turn.retry?.attempt, turn.retry?.nextAttempt, turn.retry?.reason, turn.error?.message].join(":") : "";
}

function turnRunView(turn: TurnInfo, tools: readonly MspItem[], ctx: RunContext): RunVM {
  const { fold, clock } = ctx;
  const isTurnLive = !turn.terminal && fold.activeTurnId === turn.turnId;
  const turnItemId = `${TURN_ITEM_PREFIX}${turn.turnId}`;
  const startTimestamp = turn.startedAt ?? null;
  const finishTimestamp = isTurnLive ? null : turn.completedAt ?? null;

  const foregroundTools = tools.filter((item) => item.kind === "toolCall" && item.background !== true && item.turnId === turn.turnId);
  const toolAgentRows = foregroundTools.map((it) => taskView(it, fold.crew?.tasks[it.itemId], ctx));

  const approvalNeeds: AgentVM["needs"][] = [
    ...Object.values(fold.approvals)
      .filter((req) => !req.itemId || fold.items[req.itemId]?.background !== true)
      .map((req) => ({ kind: "approval" as const, command: describeApproval(req).detail, askedAt: fold.crew?.requests[req.approvalId]?.askedAt ?? null, requestId: req.approvalId })),
    ...Object.values(fold.userInputs)
      .map((req) => ({ kind: "input" as const, command: req.questions?.[0]?.question ?? null, askedAt: fold.crew?.requests[req.userInputId]?.askedAt ?? null, requestId: req.userInputId })),
  ];

  const currentNeed = isTurnLive ? approvalNeeds[0] ?? null : null;
  const leadState: AgentState = isTurnLive ? (currentNeed ? "waiting-on-you" : "working") : outcomeOfTerminal(turn.terminal);
  const runningToolAgents = toolAgentRows.filter((ag) => LIVE_STATES.has(ag.state));
  const maxActivityTimestamp = toolAgentRows.reduce((highest, ag) => Math.max(highest, ag.lastEventAt ?? 0), startTimestamp ?? 0);
  const lookupKey = ctx.sessionId ? pendingKey(ctx.sessionId, turnItemId, 1) : null;

  const aggregatedUsage: TokenUsage = {};
  let totalCountedTokens = 0;
  let usageHasReported = false;

  for (const callObj of Object.values(fold.meta.calls)) {
    if (callObj.turnId !== turn.turnId) continue;
    usageHasReported = true;
    totalCountedTokens += callObj.promptTokens + callObj.outputTokens;
    for (const tokenProp of ["inputTokens", "outputTokens", "reasoningTokens", "cachedTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
      aggregatedUsage[tokenProp] = (aggregatedUsage[tokenProp] ?? 0) + callObj[tokenProp];
    }
  }

  const turnDuration = turn.durationMs ?? (startTimestamp === null || (!isTurnLive && finishTimestamp === null) ? null : Math.max(0, (isTurnLive ? clock : finishTimestamp!) - startTimestamp));

  const leadAgentVM: AgentVM = {
    id: turnItemId,
    attempt: 1,
    name: "Muse",
    label: "Muse",
    display: { prefix: null, short: "Muse" },
    phase: "Lead",
    kind: "lead",
    sourceTurnId: turn.turnId,
    state: leadState,
    pending: isTurnLive && lookupKey && ctx.pending[lookupKey] === "stop" ? "stop" : null,
    skippedBy: leadState === "skipped" ? "muse" : null,
    startedAt: startTimestamp,
    endedAt: finishTimestamp,
    lastEventAt: finishTimestamp ?? (maxActivityTimestamp || null),
    silenceMs: null,
    runningMs: isTurnLive ? turnDuration : null,
    durationMs: isTurnLive ? null : turnDuration,
    approx: startTimestamp === null,
    tokens: usageHasReported ? aggregatedUsage : null,
    toolCalls: foregroundTools.length,
    attempts: [],
    failure: leadState === "failed" ? { text: turn.error?.message ?? null, at: finishTimestamp } : null,
    task: {
      text: currentNeed ? "Waiting for your response" : runningToolAgents.length ? `Using ${runningToolAgents.length === 1 ? runningToolAgents[0]?.name : `${runningToolAgents.length} tools`}` : isTurnLive ? (turn.retry ? "Retrying the response" : "Working on your prompt") : "Turn ended",
      source: "objective",
    },
    shareOfLongest: null,
    quiet: null,
    needs: currentNeed,
    runItemId: turnItemId,
    workflowRunId: null,
  };

  const combinedAgents = [leadAgentVM, ...toolAgentRows];
  const turnPhases = phasesOf(combinedAgents);
  const turnCounts = runCounts({ phases: turnPhases });
  const turnRunStatus: RunStatus = isTurnLive
    ? "running"
    : leadState === "failed" ? "failed" : leadState === "skipped" ? "stopped" : turnCounts.failed > 0 ? "finished-with-failures" : "finished";

  return {
    itemId: turnItemId,
    runId: turn.turnId,
    name: "Thread activity",
    kind: "turn",
    research: null,
    status: turnRunStatus,
    revision: foregroundTools.length,
    startedAt: startTimestamp,
    endedAt: finishTimestamp,
    elapsedMs: turnDuration,
    elapsedApprox: startTimestamp === null,
    partialHistory: ctx.partialHistory,
    phases: turnPhases,
    agents: combinedAgents,
    counts: turnCounts,
    attention: attentionOrder(combinedAgents),
    runNeeds: [],
    currentPhase: isTurnLive ? "Lead" : null,
    plannedKnown: false,
    tokens: usageHasReported ? { total: totalCountedTokens, reported: 1, of: 1 } : null,
    cost: null,
    slots: null,
    pulse: [],
    longestFinishedMs: null,
    agentTimeMs: null,
    peakConcurrency: null,
    waitedOnYouMs: null,
    retried: 0,
    report: isTurnLive ? null : { summary: null, failure: turn.error?.message ?? null, handoffs: [] },
    stale: ctx.stale,
    staleAt: ctx.staleAt,
    clockAt: clock,
  };
}

function lastKnownAt(fold: ThreadFold): number | null {
  let highestTimestamp: number | null = null;
  const crewState = fold.crew;
  if (!crewState) return null;

  for (const r of Object.values(crewState.runs)) {
    for (const tVal of [r.startedAt, r.endedAt]) {
      if (tVal !== null && (highestTimestamp === null || tVal > highestTimestamp)) highestTimestamp = tVal;
    }
    for (const c of Object.values(r.children)) {
      if (c.lastEventAt !== null && (highestTimestamp === null || c.lastEventAt > highestTimestamp)) highestTimestamp = c.lastEventAt;
    }
  }

  for (const t of Object.values(crewState.tasks)) {
    for (const tVal of [t.firstSeenAt, t.lastOutputAt, t.endedAt]) {
      if (tVal !== null && (highestTimestamp === null || tVal > highestTimestamp)) highestTimestamp = tVal;
    }
  }

  const monitored = monitoredTurn(fold);
  for (const tVal of [monitored?.startedAt, monitored?.completedAt]) {
    if (tVal !== undefined && (highestTimestamp === null || tVal > highestTimestamp)) highestTimestamp = tVal;
  }
  return highestTimestamp;
}

export function crewView(fold: ThreadFold, session: SessionSummary | null, now: number, opts: CrewOptions = {}): CrewVM {
  const sessionId = session?.sessionId ?? null;
  const isStale = opts.stale === true;
  const resolvedStaleAt = isStale ? opts.staleAt ?? lastKnownAt(fold) : null;

  const runContext: RunContext = {
    fold,
    sessionId,
    now,
    clock: isStale ? resolvedStaleAt ?? now : now,
    stale: isStale,
    staleAt: resolvedStaleAt,
    partialHistory: opts.partialHistory === true,
    pending: opts.pending ?? {},
    skipped: new Set(opts.skipped ?? []),
    model: fold.meta.modelId ?? session?.modelId ?? null,
    models: opts.models ?? [],
    numbers: opts.numbers ?? (sessionId ? agentNumbers(sessionId) : new Map()),
  };

  const runsOutput: RunVM[] = [];
  const subagentsOutput: AgentVM[] = [];
  const threadIndexData = threadIndex(fold);

  for (const item of threadIndexData.workflows) runsOutput.push(runView(item, runContext));
  for (const item of threadIndexData.subagents) subagentsOutput.push(subagentView(item, runContext));
  for (const run of opts.researchRuns ?? []) {
    runsOutput.push(researchRunView(run, runContext));
  }

  const currentTurn = monitoredTurn(fold);
  const workflowsInCurrentTurn = currentTurn ? threadIndexData.workflows.filter((item) => item.turnId === currentTurn.turnId) : [];
  if (currentTurn && (workflowsInCurrentTurn.length === 0 || (fold.activeTurnId === currentTurn.turnId && workflowsInCurrentTurn.every((item) => item.status !== "inProgress"))) && !(opts.researchRuns?.some(researchLive))) {
    runsOutput.push(turnRunView(currentTurn, threadIndexData.foreground.get(currentTurn.turnId) ?? [], runContext));
  }

  runsOutput.sort((x, y) => Number(x.kind === "turn") - Number(y.kind === "turn") || (x.startedAt ?? Number.MAX_SAFE_INTEGER) - (y.startedAt ?? Number.MAX_SAFE_INTEGER) || x.itemId.localeCompare(y.itemId));

  const waitToolsMap = nativeWaits(fold, threadIndexData.waits);
  const subagentOrderPositions = new Map(subagentsOutput.map((ag, idx) => [ag.id, idx]));

  for (const spawnId of threadIndexData.spawns) {
    const spawnItem = fold.items[spawnId];
    if (spawnItem) {
      const spawnedAgentVM = spawnView(spawnItem, waitToolsMap, runContext);
      const pos = subagentOrderPositions.get(spawnedAgentVM.id);
      if (pos === undefined) {
        subagentOrderPositions.set(spawnedAgentVM.id, subagentsOutput.length);
        subagentsOutput.push(spawnedAgentVM);
      } else {
        const priorAgent = subagentsOutput[pos]!;
        if (LIVE_STATES.has(priorAgent.state) && !LIVE_STATES.has(spawnedAgentVM.state) && (priorAgent.lastEventAt === null || spawnedAgentVM.endedAt === null || spawnedAgentVM.endedAt >= priorAgent.lastEventAt)) {
          subagentsOutput[pos] = {
            ...priorAgent,
            state: spawnedAgentVM.state,
            endedAt: spawnedAgentVM.endedAt,
            lastEventAt: spawnedAgentVM.lastEventAt,
            durationMs: spawnedAgentVM.durationMs ?? priorAgent.durationMs,
            pending: null,
            failure: spawnedAgentVM.failure,
            needs: null,
            runningMs: null,
          };
        }
      }
    }
  }

  const tasksOutput: AgentVM[] = [];
  for (const bgItem of threadIndexData.background) {
    tasksOutput.push(taskView(bgItem, fold.crew?.tasks[bgItem.itemId], runContext));
  }
  tasksOutput.sort((x, y) => Number(LIVE_STATES.has(y.state)) - Number(LIVE_STATES.has(x.state)) || (x.startedAt ?? 0) - (y.startedAt ?? 0));

  return { runs: runsOutput, tasks: tasksOutput, subagents: subagentsOutput };
}

export function runLive(run: Pick<RunVM, "status">): boolean {
  return run.status === "starting" || run.status === "running";
}

export function crewBusy(fold: ThreadFold, researchRuns?: readonly ResearchRunView[]): boolean {
  if (fold.activeTurnId && !fold.turns[fold.activeTurnId]?.terminal) return true;
  if (researchRuns?.some(researchLive)) return true;

  const idx = threadIndex(fold);
  if (idx.workflows.some((w) => w.status === "inProgress")) return true;

  const waitTools = nativeWaits(fold, idx.waits);
  for (const sub of idx.subagents) {
    if (LIVE_STATES.has(subagentState(sub))) {
      const subId = text(sub.subagentId) ?? text(sub.childId) ?? text(sub.childSessionId);
      const matchedWait = subId ? waitTools.get(subId) : undefined;
      const statusWord = matchedWait ? normalizedWord(text(nativeOutput(matchedWait)?.status) ?? undefined) : "";
      const isSettledWord = ["ready", "completed", "complete", "done", "success", "succeeded", "resultready", "failed", "error", "rejected", "cancelled", "canceled", "stopped"].includes(statusWord);
      const waitEndTime = matchedWait ? fold.crew?.tasks[matchedWait.itemId]?.endedAt ?? isoMs(matchedWait.recordedAt) : null;
      const subRecordedTime = isoMs(sub.recordedAt);
      if (!isSettledWord || (subRecordedTime !== null && waitEndTime !== null && subRecordedTime > waitEndTime)) return true;
    }
  }

  if (idx.background.some((t) => t.status === "inProgress" && fold.crew?.tasks[t.itemId]?.endedAt == null)) return true;

  for (const spawnId of idx.spawns) {
    const spawnObj = fold.items[spawnId];
    if (spawnObj && LIVE_STATES.has(nativeSubagent(spawnObj, waitTools).state)) return true;
  }
  return false;
}

export function summaryLine(run: RunVM): { progress: string; chips: SummaryChip[]; elapsed: string } {
  const { counts } = run;
  const totalCount = counts.total;
  const chipList: SummaryChip[] = [];
  const pendingInputNeeds = run.runNeeds.length + counts.waiting;
  let progressDescription = "";

  if (run.status === "starting") {
    progressDescription = "Starting · no agents scheduled yet";
  } else if (run.status === "running") {
    if (run.research) {
      const inFlight = counts.working + counts.finishing + counts.noUpdate;
      progressDescription = `${phaseLine(run.research)} · ${counts.done} done · ${inFlight} working`;
    } else if (run.plannedKnown) {
      progressDescription = `${run.currentPhase ?? "Finishing"} · ${counts.done} of ${totalCount}`;
    } else {
      const inFlight = counts.working + counts.finishing + counts.noUpdate;
      progressDescription = `${counts.done} done · ${inFlight} working · more may start`;
    }
  } else if (run.status === "finished") {
    progressDescription = run.kind === "turn" && run.agents[0]?.state === "unknown"
      ? "Turn ended · outcome not reported"
      : `Done · ${counts.done} of ${totalCount}`;
  } else if (run.status === "finished-with-failures") {
    progressDescription = `Finished · ${counts.done} of ${totalCount}`;
  } else if (run.status === "stopped") {
    progressDescription = `${stoppedWord(run)} · ${counts.done} of ${totalCount} had landed`;
  } else if (run.status === "failed") {
    progressDescription = `Failed · ${counts.done} of ${totalCount} had landed`;
  }

  if (run.stale) {
    chipList.push({ kind: "stale", count: 1, text: "Last known" });
  } else if (runLive(run)) {
    if (pendingInputNeeds > 0) {
      chipList.push({ kind: "needs", count: pendingInputNeeds, text: `${pendingInputNeeds} ${pendingInputNeeds === 1 ? "needs" : "need"} you` });
    }
    if (counts.failed > 0) {
      chipList.push({ kind: "failed", count: counts.failed, text: `${counts.failed} failed` });
    }
    if (chipList.length === 0 && counts.noUpdate > 0) {
      chipList.push({ kind: "no-update", count: counts.noUpdate, text: `${counts.noUpdate} no update` });
    }
  } else {
    if (run.status === "failed") {
      chipList.push({ kind: "run-failed", count: 1, text: "run failed" });
    }
    if (counts.failed > 0) {
      chipList.push({ kind: "failed", count: counts.failed, text: `${counts.failed} failed` });
    }
    if (counts.skipped > 0 && chipList.length < 2) {
      chipList.push({ kind: "skipped", count: counts.skipped, text: `${counts.skipped} skipped` });
    }
  }

  let elapsedText = "";
  if (run.elapsedMs !== null) {
    if (run.stale) {
      elapsedText = run.staleAt !== null ? `${durationText(run.elapsedMs)} · at ${formatClock(run.staleAt, run.clockAt)}` : durationText(run.elapsedMs);
    } else if (run.elapsedApprox && runLive(run)) {
      elapsedText = aboutText(run.elapsedMs);
    } else {
      elapsedText = durationText(run.elapsedMs);
    }
  }

  return { progress: progressDescription, chips: chipList.slice(0, 2), elapsed: elapsedText };
}

function shortDuration(ms: number | null): string {
  if (ms === null) return "a while";
  const roundedMins = Math.round(ms / 60_000);
  if (roundedMins < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (roundedMins < 60) return `${roundedMins}m`;
  const hrs = Math.floor(roundedMins / 60);
  const leftMins = String(roundedMins % 60).padStart(2, "0");
  return `${hrs}h ${leftMins}m`;
}

function stoppedWord(run: Pick<RunVM, "research">): "Interrupted" | "Stopped" {
  return run.research?.status === "interrupted" ? "Interrupted" : "Stopped";
}

export function headline(counts: Counts, status: RunStatus, elapsedMs: number | null, interrupted = false): string {
  const scheduledCount = counts.total - counts.planned;
  const landedCount = counts.done;
  const landedSummary = `${numberWord(landedCount)} of ${numberWord(scheduledCount)} had landed.`;

  if (status === "stopped") {
    const interruptPrefix = interrupted ? "Interrupted" : "Stopped by you";
    return `${interruptPrefix} after ${shortDuration(elapsedMs)}; ${landedSummary}`;
  }
  if (status === "failed") {
    return `The run failed after ${shortDuration(elapsedMs)}; ${landedSummary}`;
  }
  if (scheduledCount === 0) {
    return "Nothing was scheduled.";
  }
  if (landedCount === scheduledCount) {
    return scheduledCount === 1 ? "The agent landed." : `All ${numberWord(scheduledCount)} landed.`;
  }

  const parts = [`${capitalize(numberWord(landedCount))} of ${numberWord(scheduledCount)} landed`];
  if (counts.skipped > 0) parts.push(`${numberWord(counts.skipped)} skipped`);
  if (counts.failed > 0) parts.push(`${numberWord(counts.failed)} failed`);
  if (counts.unknown > 0) parts.push(`${numberWord(counts.unknown)} not reported`);
  return `${parts.join(", ")}.`;
}

function factLine(run: RunVM): string {
  const gatheredFacts: string[] = [];
  const skippedList = run.agents.filter((a) => a.state === "skipped");
  const failedList = run.agents.filter((a) => a.state === "failed");
  const unknownList = run.agents.filter((a) => a.state === "unknown");
  const attemptsDescription = (ag: AgentVM) => `after ${plural(ag.attempt - (ag.state === "skipped" ? 1 : 0), "failed attempt")}`;

  if (run.research && run.report?.failure) {
    gatheredFacts.push(run.report.failure);
  } else if (run.status === "stopped") {
    gatheredFacts.push(unknownList.length > 0 ? `${plural(unknownList.length, "agent was", "agents were")} still working` : "Nothing was still working");
  } else if (run.status === "failed") {
    gatheredFacts.push(run.report?.failure ?? "Muse has not reported a reason");
  } else if (run.research?.noCitableSources) {
    gatheredFacts.push("No source could be cited for this report");
  } else if (run.research && run.status === "finished-with-failures") {
    gatheredFacts.push("The run ended before every round was done");
  } else if (skippedList.length === 0 && failedList.length === 0 && unknownList.length === 0) {
    gatheredFacts.push(run.research ? "Every round reached its end" : "Every phase reached its end");
  }

  for (const ag of skippedList) {
    const actor = ag.skippedBy === "you" ? "skipped by you" : ag.skippedBy === "run" ? "stopped with the run" : "cancelled by Muse";
    const retryNote = ag.attempt > 1 ? ` ${attemptsDescription(ag)}` : "";
    gatheredFacts.push(`${ag.name} was ${actor}${retryNote}`);
  }

  for (const ag of failedList) {
    gatheredFacts.push(`${ag.name} failed after ${plural(ag.attempt, "attempt")}`);
  }

  if (unknownList.length > 0 && run.status !== "stopped") {
    gatheredFacts.push(`Muse did not report an outcome for ${plural(unknownList.length, "agent")}`);
  }

  const retriedDoneAgents = run.agents.filter((a) => a.attempt > 1 && a.state === "done");
  if (retriedDoneAgents.length > 0) {
    const peakAttempts = Math.max(...retriedDoneAgents.map((a) => a.attempt));
    gatheredFacts.push(`${plural(retriedDoneAgents.length, "agent")} needed ${peakAttempts} attempts`);
  }

  return gatheredFacts.join(" · ");
}

function firstLines(summaryText: string | null, maxLineCount = 4, maxCharCount = 480): string | null {
  if (!summaryText) return null;
  const trimmedLines = summaryText
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, maxLineCount)
    .join("\n");

  if (trimmedLines.length > maxCharCount) {
    return `${trimmedLines.slice(0, maxCharCount).trimEnd()}…`;
  }
  return trimmedLines || null;
}

interface Candidate {
  priority: number;
  order: number;
  highlight: HighlightVM;
}

function highlightsOf(run: RunVM): HighlightVM[] {
  const candidateList: Candidate[] = [];
  const appendUnlanded = (agentsList: AgentVM[], iconName: string, actionVerb: string, asideFn: (ag: AgentVM) => string | null) => {
    if (agentsList.length === 0) return;
    const solitary = agentsList.length === 1 ? agentsList[0]! : null;
    const prominentText = solitary ? solitary.name : `${agentsList.length} agents`;
    candidateList.push({
      priority: 1,
      order: 0,
      highlight: {
        icon: iconName,
        text: solitary ? `1 agent ${actionVerb} ${solitary.name}` : `${agentsList.length} agents ${actionVerb}`,
        strong: prominentText,
        aside: solitary ? asideFn(solitary) : null,
      },
    });
  };

  appendUnlanded(
    run.agents.filter((a) => a.state === "skipped"),
    "MinusCircle",
    "skipped",
    (ag) => (ag.skippedBy === "you" && ag.attempt > 1 ? `after ${plural(ag.attempt - 1, "failed attempt")}` : ag.skippedBy === "run" ? "stopped with the run" : null),
  );
  appendUnlanded(
    run.agents.filter((a) => a.state === "failed"),
    "WarningCircle",
    "failed",
    (ag) => `after ${plural(ag.attempt, "attempt")}`,
  );
  appendUnlanded(
    run.agents.filter((a) => a.state === "unknown"),
    "Question",
    "without a reported outcome",
    () => null,
  );

  const retriedDoneAgents = run.agents.filter((a) => a.attempt > 1 && a.state === "done");
  if (retriedDoneAgents.length > 0) {
    const mostRetried = retriedDoneAgents.reduce((leader, ag) => (ag.attempt > leader.attempt ? ag : leader));
    candidateList.push({
      priority: 1,
      order: 3,
      highlight: {
        icon: "ArrowCounterClockwise",
        text: `Retried ${mostRetried.name} · landed on attempt ${mostRetried.attempt}`,
        strong: mostRetried.name,
        aside: `after ${plural(mostRetried.attempt - 1, "failed attempt")}`,
      },
    });
  }

  const timedAgents = run.agents.filter((a) => a.durationMs !== null);
  if (timedAgents.length > 0) {
    const longestTimed = timedAgents.reduce((leader, ag) => ((ag.durationMs as number) > (leader.durationMs as number) ? ag : leader));
    candidateList.push({
      priority: 2,
      order: 1,
      highlight: {
        icon: "Timer",
        text: `Longest agent ${longestTimed.name} · ${durationText(longestTimed.durationMs)}`,
        strong: longestTimed.name,
        aside: null,
      },
    });
  }

  const agentsWithTokens = run.agents.filter((a) => a.tokens !== null && usageTotal(a.tokens) > 0);
  if (agentsWithTokens.length > 0 && run.tokens) {
    const highestTokenConsumer = agentsWithTokens.reduce((leader, ag) => (usageTotal(ag.tokens) > usageTotal(leader.tokens) ? ag : leader));
    const tokenSharePercentage = run.tokens.total > 0 ? Math.round((usageTotal(highestTokenConsumer.tokens) / run.tokens.total) * 100) : null;
    candidateList.push({
      priority: 3,
      order: 2,
      highlight: {
        icon: "Database",
        text: `Most tokens ${highestTokenConsumer.name} · ${formatTokens(usageTotal(highestTokenConsumer.tokens))}`,
        strong: highestTokenConsumer.name,
        aside: tokenSharePercentage !== null ? `${tokenSharePercentage}% of the run` : null,
      },
    });
  } else {
    const agentsWithCalls = run.agents.filter((a) => a.toolCalls !== null);
    if (agentsWithCalls.length > 0) {
      const highestCaller = agentsWithCalls.reduce((leader, ag) => ((ag.toolCalls as number) > (leader.toolCalls as number) ? ag : leader));
      candidateList.push({
        priority: 3,
        order: 2,
        highlight: {
          icon: "Wrench",
          text: `Most tool calls ${highestCaller.name} · ${highestCaller.toolCalls}`,
          strong: highestCaller.name,
          aside: null,
        },
      });
    }
  }

  if (run.waitedOnYouMs !== null && run.waitedOnYouMs > 0) {
    candidateList.push({
      priority: 4,
      order: 4,
      highlight: {
        icon: "ShieldWarning",
        text: `Waited on you ${durationText(run.waitedOnYouMs)}`,
        strong: durationText(run.waitedOnYouMs),
        aside: null,
      },
    });
  } else if (run.peakConcurrency && run.peakConcurrency.n > 1) {
    candidateList.push({
      priority: 4,
      order: 4,
      highlight: {
        icon: "UsersThree",
        text: `Peak concurrency ${plural(run.peakConcurrency.n, "agent")}`,
        strong: `${run.peakConcurrency.n} agents`,
        aside: `during ${run.peakConcurrency.phase}`,
      },
    });
  }

  const selectedCandidates = [...candidateList]
    .sort((x, y) => x.priority - y.priority || x.order - y.order)
    .slice(0, 4);

  return selectedCandidates
    .sort((x, y) => x.order - y.order || x.priority - y.priority)
    .map((c) => c.highlight);
}

function fingerprintOf(run: RunVM): FingerprintVM {
  const runStartEpoch = run.startedAt;
  const runEndEpoch = run.endedAt ?? run.clockAt;
  if (runStartEpoch === null) {
    return { totalMs: 0, phases: [], lanes: [], partial: true };
  }

  let isPartialView = false;
  const laneList: FingerprintLaneVM[] = [];

  for (const ag of run.agents) {
    if (ag.state === "planned") continue;
    const spanList: FingerprintLaneVM["spans"] = [];
    const lastAttemptIdx = ag.attempts.length - 1;

    ag.attempts.forEach((att, attIdx) => {
      if (att.startedAt === null) {
        isPartialView = true;
        return;
      }
      const attEndTimestamp = att.endedAt ?? (att.outcome === null ? runEndEpoch : null);
      if (attEndTimestamp === null) {
        isPartialView = true;
        return;
      }
      spanList.push({
        startMs: Math.max(0, att.startedAt - runStartEpoch),
        endMs: Math.max(0, attEndTimestamp - runStartEpoch),
        failed: attIdx < lastAttemptIdx || att.outcome === "failed" || att.outcome === "skipped",
      });
    });

    if (spanList.length === 0) isPartialView = true;
    laneList.push({ id: ag.id, name: ag.name, phase: ag.phase, state: ag.state, spans: spanList });
  }

  return {
    totalMs: Math.max(0, runEndEpoch - runStartEpoch),
    phases: run.phases
      .filter((p) => p.state !== "planned")
      .map((p) => ({
        name: p.name,
        startMs: p.startedAt !== null ? Math.max(0, p.startedAt - runStartEpoch) : null,
        endMs: p.endedAt !== null ? Math.max(0, p.endedAt - runStartEpoch) : null,
      })),
    lanes: laneList,
    partial: isPartialView || run.partialHistory,
  };
}

export function reportCoverage(run: Pick<RunVM, "kind" | "tokens">): string | null {
  if (run.kind !== "workflow" || !run.tokens || run.tokens.reported >= run.tokens.of) return null;
  return `${run.tokens.reported} of ${run.tokens.of} reported`;
}

export const RETRIED_TOKENS_NOTE = " · latest attempt of each agent";

export function completionView(run: RunVM): CompletionVM | null {
  if (runLive(run)) return null;
  const nonPlannedTotal = run.counts.total - run.counts.planned;

  const statEntries: StatVM[] = [
    {
      value: String(run.kind === "turn" ? run.agents.filter((a) => a.kind === "task").length : nonPlannedTotal),
      label: run.kind === "turn" ? "tools" : nonPlannedTotal === 1 ? "agent" : "agents",
    },
    {
      value: run.elapsedMs === null ? "—" : run.elapsedApprox ? aboutText(run.elapsedMs) : durationText(run.elapsedMs),
      label: "wall clock",
    },
    run.tokens
      ? {
          value: formatTokens(run.tokens.total),
          label: run.research ? "tokens, the run's own count" : `tokens, reported by Muse${run.retried > 0 ? RETRIED_TOKENS_NOTE : ""}`,
        }
      : { value: "—", label: "tokens not reported" },
  ];

  if (run.cost) {
    statEntries.push({ value: `~${formatCost(run.cost.usd)}`, label: "estimate at list price" });
  }

  let computedHeadline = "";
  if (run.kind === "turn") {
    if (run.status === "failed") computedHeadline = "Turn failed";
    else if (run.status === "stopped") computedHeadline = "Turn stopped";
    else if (run.agents[0]?.state === "done") computedHeadline = "Turn finished";
    else computedHeadline = "Turn ended";
  } else {
    computedHeadline = headline(run.counts, run.status, run.elapsedMs, run.research?.status === "interrupted");
  }

  let computedFactLine = "";
  if (run.kind === "turn") {
    const doneToolsCount = run.agents.filter((a) => a.kind === "task" && a.state === "done").length;
    const failedText = run.counts.failed > 0 ? ` · ${run.counts.failed} failed` : "";
    const unknownText = run.counts.unknown > 0 ? ` · ${plural(run.counts.unknown, "outcome")} not reported` : "";
    computedFactLine = `${plural(doneToolsCount, "tool")} completed${failedText}${unknownText}`;
  } else {
    computedFactLine = factLine(run);
  }

  return {
    headline: computedHeadline,
    factLine: computedFactLine,
    stats: statEntries,
    highlights: highlightsOf(run),
    fingerprint: fingerprintOf(run),
    excerpt: firstLines(run.report?.summary ?? null),
    sheen: run.status === "finished" && nonPlannedTotal > 0 && run.counts.done === nonPlannedTotal,
  };
}

export function sinceYouLeft(run: RunVM, leftAt: number, now: number): SinceYouLeftVM | null {
  if (now - leftAt < SINCE_LEFT_MIN_MS) return null;

  let settledDoneCount = 0;
  let settledFailedCount = 0;

  for (const ag of run.agents) {
    if (ag.endedAt === null || ag.endedAt <= leftAt) continue;
    if (ag.state === "done") settledDoneCount += 1;
    else if (ag.state === "failed") settledFailedCount += 1;
  }

  const startedPhasesList = run.phases
    .filter((p) => p.startedAt !== null && p.startedAt > leftAt)
    .map((p) => p.name);

  const finalRunEndTime = run.endedAt !== null && run.endedAt > leftAt ? run.endedAt : null;
  if (settledDoneCount + settledFailedCount + startedPhasesList.length === 0 && finalRunEndTime === null) {
    return null;
  }

  return {
    leftAt,
    finished: settledDoneCount,
    failed: settledFailedCount,
    phasesStarted: startedPhasesList,
    runFinishedAt: finalRunEndTime,
  };
}

export function announcements(prev: CrewVM | null, next: CrewVM): string[] {
  if (!prev) return [];
  const announcementsList: string[] = [];
  let userAttentionRequired = false;

  const previousRunsMap = new Map(prev.runs.map((r) => [r.itemId, r]));
  for (const currentRun of next.runs) {
    const priorRun = previousRunsMap.get(currentRun.itemId);
    const previouslySeenRequests = new Set(priorRun?.runNeeds.map((n) => n.requestId) ?? []);
    if (currentRun.runNeeds.some((n) => !previouslySeenRequests.has(n.requestId))) {
      userAttentionRequired = true;
    }

    const priorAgentsMap = new Map(priorRun?.agents.map((ag) => [ag.id, ag]) ?? []);
    for (const ag of currentRun.agents) {
      const priorState = priorAgentsMap.get(ag.id);
      if (ag.state === "waiting-on-you" && priorState?.state !== "waiting-on-you") {
        userAttentionRequired = true;
      }
      if (ag.state === "failed" && (priorState?.state !== "failed" || priorState.attempt !== ag.attempt)) {
        announcementsList.push(`${ag.name} failed, attempt ${ag.attempt} of ${ag.attempt}.`);
      }
    }

    const priorPhasesMap = new Map(priorRun?.phases.map((p) => [p.name, p]) ?? []);
    for (const ph of currentRun.phases) {
      const priorPh = priorPhasesMap.get(ph.name);
      if (ph.state !== "live" && ph.state !== "planned" && priorPh && (priorPh.state === "live" || priorPh.state === "planned")) {
        announcementsList.push(`${ph.name} phase finished, ${ph.counts.done} of ${ph.counts.total}.`);
      }
    }

    if (priorRun && runLive(priorRun) && !runLive(currentRun)) {
      announcementsList.push(headline(currentRun.counts, currentRun.status, currentRun.elapsedMs, currentRun.research?.status === "interrupted"));
    }
    if (priorRun && !priorRun.stale && currentRun.stale) {
      announcementsList.push("Connection stale; showing last known state.");
    }
  }

  const priorTasksMap = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const priorT = priorTasksMap.get(t.id);
    if (t.state === "failed" && priorT?.state !== "failed") {
      announcementsList.push(`Background task ${t.name} failed.`);
    }
    if (t.state === "waiting-on-you" && priorT?.state !== "waiting-on-you") {
      userAttentionRequired = true;
    }
  }

  if (userAttentionRequired) {
    announcementsList.unshift("A request needs you.");
  }
  return announcementsList;
}

export interface SidebarSummaryOptions {
  sessionId?: string;
  stale?: boolean;
  staleAt?: number | null;
  researchRuns?: readonly ResearchRunView[];
}

export function sidebarCrewSummary(fold: ThreadFold | null, _live: LiveView | null, now: number, opts: SidebarSummaryOptions = {}): SidebarCrewSummary | null {
  if (!fold) return null;
  const currentCrewView = crewView(fold, null, now, {
    stale: opts.stale,
    staleAt: opts.staleAt,
    numbers: opts.sessionId ? agentNumbers(opts.sessionId) : undefined,
    researchRuns: opts.researchRuns,
  });

  const activeRuns = currentCrewView.runs.filter(runLive);
  const primaryRun = activeRuns[activeRuns.length - 1] ?? currentCrewView.runs[currentCrewView.runs.length - 1] ?? null;
  const totalNeeds = Object.keys(fold.approvals).length + Object.keys(fold.userInputs).length;
  const standaloneAgents = [...currentCrewView.tasks, ...currentCrewView.subagents];
  const runningStandalone = standaloneAgents.filter((ag) => LIVE_STATES.has(ag.state));
  const leadingTask = runningStandalone[0] ?? standaloneAgents[0] ?? null;

  if (currentCrewView.subagents.length > 0 && (!primaryRun || !runLive(primaryRun)) && (runningStandalone.length > 0 || !primaryRun)) {
    const standaloneCounts = runCounts({ phases: phasesOf(standaloneAgents) });
    return {
      groups: [standaloneAgents.map((ag) => ag.state)],
      text: opts.stale ? "Last known" : `${standaloneCounts.done} done · ${runningStandalone.length} working`,
      needs: totalNeeds,
      failed: standaloneCounts.failed,
      noUpdate: standaloneCounts.noUpdate,
      phase: null,
      stale: opts.stale === true,
      task: leadingTask?.kind === "task" ? leadingTask.name : null,
      live: runningStandalone.length > 0,
      endedAt: runningStandalone.length > 0 ? null : leadingTask?.endedAt ?? null,
    };
  }

  if (!primaryRun) {
    if (!leadingTask) return null;
    return {
      groups: [],
      text: leadingTask.name,
      needs: totalNeeds,
      failed: leadingTask.state === "failed" ? 1 : 0,
      noUpdate: leadingTask.state === "no-update" ? 1 : 0,
      phase: null,
      stale: opts.stale === true,
      task: leadingTask.name,
      live: LIVE_STATES.has(leadingTask.state),
      endedAt: leadingTask.endedAt,
    };
  }

  const combinedPhases = [...primaryRun.phases, ...phasesOf(standaloneAgents)];
  const combinedCounts = runCounts({ phases: combinedPhases });
  const isExecutingLive = runLive(primaryRun) || runningStandalone.length > 0;

  let rowDisplayText = "";
  if (primaryRun.stale) {
    const staleTime = primaryRun.staleAt;
    rowDisplayText = staleTime !== null ? `Last known ${shortDuration(Math.max(0, now - staleTime))}` : "Last known";
  } else if (primaryRun.status === "starting") {
    rowDisplayText = "Starting";
  } else if (isExecutingLive) {
    rowDisplayText = primaryRun.plannedKnown
      ? `${primaryRun.currentPhase ?? "Finishing"} · ${combinedCounts.done}/${combinedCounts.total}`
      : `${combinedCounts.done} done · ${combinedCounts.working + combinedCounts.finishing + combinedCounts.noUpdate} working`;
  } else if (primaryRun.status === "stopped") {
    rowDisplayText = `${stoppedWord(primaryRun)} · ${combinedCounts.done} landed`;
  } else if (primaryRun.kind === "turn" && primaryRun.agents[0]?.state === "unknown") {
    rowDisplayText = "Outcome not reported";
  } else {
    rowDisplayText = `${combinedCounts.done} landed`;
  }

  return {
    groups: combinedPhases.map((phase) => phase.agents.map((agent) => agent.state)),
    text: rowDisplayText,
    needs: totalNeeds,
    failed: combinedCounts.failed,
    noUpdate: combinedCounts.noUpdate,
    phase: primaryRun.currentPhase,
    stale: primaryRun.stale,
    task: leadingTask?.kind === "task" ? leadingTask.name : null,
    live: isExecutingLive,
    endedAt: isExecutingLive ? null : primaryRun.endedAt,
  };
}

function foldIsLive(state: AppState, thread: ThreadState | undefined, session?: SessionSummary): boolean {
  return thread !== undefined
    && (thread.load === "ready" || thread.fold.order.length > 0)
    && !thread.stale
    && !thread.stalled
    && !thread.historySync
    && !thread.readOnly
    && !thread.fold.closed
    && state.connection === "open"
    && session?.live?.viewHealth?.status !== "unavailable";
}

export function windowTitleCount(state: AppState): number {
  let pendingSum = 0;
  for (const session of Object.values(state.sessions)) {
    const currentThread = state.threads[session.sessionId];
    if (currentThread && foldIsLive(state, currentThread, session)) {
      pendingSum += Object.keys(currentThread.fold.approvals).length + Object.keys(currentThread.fold.userInputs).length;
    } else {
      pendingSum += (session.live?.pendingApprovals ?? 0) + (session.live?.pendingInputs ?? 0);
    }
  }
  return pendingSum;
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const UNTRACKED_NOTE = "Open a thread to load its agent activity. Disconnected threads show their last known state.";

export function activityView(state: AppState, now: number): ActivityVM {
  const needsYou: ActivityItemVM[] = [];
  const working: ActivityItemVM[] = [];
  const finishedToday: ActivityItemVM[] = [];
  const dayStartTimestamp = startOfDay(now);
  const activeSessionRouteId = state.route.kind === "thread" ? state.route.sessionId : null;
  let batchStopSummary: ActivityVM["stopAll"] = null;
  let hasUntrackedActivity = false;
  let tokensInMonitoredRuns = 0;
  const activeThreadIds = new Set<string>();

  const sortedSessions = Object.values(state.sessions).sort((x, y) => (x.activityAt < y.activityAt ? 1 : x.activityAt > y.activityAt ? -1 : 0));

  for (const sess of sortedSessions) {
    const prjName = projectForCwd(state.projects, sess.cwd)?.displayName ?? sess.cwd;
    const itemBase = { sessionId: sess.sessionId, project: prjName, thread: sess.title };
    const threadStateObj = state.threads[sess.sessionId];

    if (!threadStateObj || !foldIsLive(state, threadStateObj, sess)) {
      const unmonitoredPending = (sess.live?.pendingApprovals ?? 0) + (sess.live?.pendingInputs ?? 0);
      if (unmonitoredPending > 0) {
        needsYou.push({
          ...itemBase,
          itemId: null,
          agentId: null,
          kind: "request",
          text: `${plural(unmonitoredPending, "request")} waiting`,
          sub: null,
          state: "request",
          startedAt: null,
          endedAt: null,
          stale: true,
        });
      }
      if (sess.live?.activeTurnId || unmonitoredPending > 0 || threadStateObj?.stale === true) {
        hasUntrackedActivity = true;
      }
      continue;
    }

    const currentFold = threadStateObj.fold;
    for (const appReq of Object.values(currentFold.approvals)) {
      const desc = describeApproval(appReq);
      needsYou.push({
        ...itemBase,
        itemId: appReq.itemId ?? null,
        agentId: null,
        kind: "request",
        text: desc.title,
        sub: desc.detail,
        state: "request",
        startedAt: currentFold.crew?.requests[appReq.approvalId]?.askedAt ?? null,
        endedAt: null,
        stale: false,
      });
    }

    for (const inputReq of Object.values(currentFold.userInputs)) {
      needsYou.push({
        ...itemBase,
        itemId: inputReq.itemId ?? null,
        agentId: null,
        kind: "request",
        text: "Muse asked a question",
        sub: inputReq.questions?.[0]?.question ?? null,
        state: "request",
        startedAt: currentFold.crew?.requests[inputReq.userInputId]?.askedAt ?? null,
        endedAt: null,
        stale: false,
      });
    }

    const crewData = crewView(currentFold, sess, now, {
      stale: false,
      partialHistory: threadStateObj.truncated,
      pending: state.crew.pending,
      skipped: state.crew.skipped,
      models: state.models,
      researchRuns: threadStateObj.researchRuns,
    });

    let runningRunsCount = 0;
    let runningTasksCount = 0;
    let runningAgentsCount = 0;

    for (const r of crewData.runs) {
      if (runLive(r)) {
        runningRunsCount += 1;
        activeThreadIds.add(sess.sessionId);
        working.push({
          ...itemBase,
          itemId: r.itemId,
          agentId: null,
          kind: "run",
          text: r.name,
          sub: summaryLine(r).progress,
          state: r.counts.waiting > 0 || r.runNeeds.length > 0 ? "waiting-on-you" : r.counts.failed > 0 ? "failed" : "working",
          startedAt: r.startedAt,
          endedAt: null,
          stale: false,
        });
      } else if (r.endedAt !== null && r.endedAt >= dayStartTimestamp) {
        finishedToday.push({
          ...itemBase,
          itemId: r.itemId,
          agentId: null,
          kind: "run",
          text: r.name,
          sub: summaryLine(r).progress,
          state: r.kind === "turn" && r.agents[0]?.state === "unknown" ? "unknown" : r.status === "finished" ? "done" : r.status === "stopped" ? "skipped" : "failed",
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          stale: false,
        });
      }
      if (r.tokens && r.startedAt !== null && r.startedAt >= dayStartTimestamp) {
        tokensInMonitoredRuns += r.tokens.total;
      }
    }

    for (const t of crewData.tasks) {
      if (LIVE_STATES.has(t.state)) {
        runningTasksCount += 1;
        activeThreadIds.add(sess.sessionId);
        working.push({
          ...itemBase,
          itemId: t.id,
          agentId: t.id,
          kind: "task",
          text: t.name,
          sub: t.taskInfo?.tail ?? null,
          state: t.state,
          startedAt: t.startedAt,
          endedAt: null,
          stale: false,
        });
      } else if (t.endedAt !== null && t.endedAt >= dayStartTimestamp) {
        finishedToday.push({
          ...itemBase,
          itemId: t.id,
          agentId: t.id,
          kind: "task",
          text: t.name,
          sub: t.state === "failed" ? `failed · ${t.failure?.text ?? "no reason reported"}` : "finished · no failure reported",
          state: t.state,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          stale: false,
        });
      }
    }

    for (const ag of crewData.subagents) {
      if (LIVE_STATES.has(ag.state)) {
        runningAgentsCount += 1;
        activeThreadIds.add(sess.sessionId);
        working.push({
          ...itemBase,
          itemId: null,
          agentId: ag.id,
          kind: "subagent",
          text: ag.name,
          sub: ag.task?.text ?? null,
          state: ag.state,
          startedAt: ag.startedAt,
          endedAt: null,
          stale: false,
        });
      } else if (ag.endedAt !== null && ag.endedAt >= dayStartTimestamp) {
        finishedToday.push({
          ...itemBase,
          itemId: null,
          agentId: ag.id,
          kind: "subagent",
          text: ag.name,
          sub: ag.failure?.text ?? ag.task?.text ?? null,
          state: ag.state,
          startedAt: ag.startedAt,
          endedAt: ag.endedAt,
          stale: false,
        });
      }
    }

    if (sess.sessionId === activeSessionRouteId && runningRunsCount + runningTasksCount + runningAgentsCount > 0) {
      batchStopSummary = { runs: runningRunsCount, tasks: runningTasksCount, ...(runningAgentsCount > 0 ? { agents: runningAgentsCount } : {}) };
    }
  }

  for (const s of Object.values(state.sessions)) {
    const th = state.threads[s.sessionId];
    if (th?.stale && (s.live?.activeTurnId || crewBusy(th.fold, th.researchRuns))) {
      hasUntrackedActivity = true;
    }
  }

  const isDrawerEmpty = needsYou.length + working.length + finishedToday.length === 0;
  let footerDescription = "";
  if (working.length > 0) {
    const threadWord = plural(activeThreadIds.size, "thread");
    const tokenPart = tokensInMonitoredRuns > 0 ? ` · ${formatTokens(tokensInMonitoredRuns)} tokens in current runs` : "";
    footerDescription = `${working.length} running in ${threadWord}${tokenPart}`;
  } else if (needsYou.length > 0) {
    footerDescription = `${plural(needsYou.length, "request")} waiting for you`;
  } else {
    footerDescription = "Nothing runs and nothing waits for you.";
  }

  return {
    needsYou,
    working,
    finishedToday,
    stopAll: batchStopSummary,
    foot: footerDescription,
    empty: isDrawerEmpty,
    note: hasUntrackedActivity ? UNTRACKED_NOTE : null,
  };
}
