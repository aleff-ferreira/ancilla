import type {
  ApprovalRequest, LiveView, ModelOption, MspItem, ResearchPhase, ResearchRunView, ResearchStatus, ResearchWorkerState, ResearchWorkerView,
  SessionSummary, TokenUsage, UserInputRequest, WorkflowChild,
} from "../types.js";
import { agentNumbers, type AgentNumbers } from "./agents.js";
import { uuidTime, type ChildTrace, type RequestTrace, type RunTrace, type TaskTrace, type ThreadFold } from "./fold.js";
import { describeApproval, describeTool, formatClock, formatTokens, lastLine, parseArgs } from "./format.js";
import { costOf, formatCost, listedPrice } from "./pricing.js";
import { phaseLine, researchEnded, researchLive, researchThreadTitle, sourcesLine } from "./research.js";
import { projectForCwd } from "./status.js";
import type { AppState, ThreadState } from "./store.js";
import { TERMINAL_FAILURES, reconciled } from "./workflow.js";

/**
 * The view-models behind the Crew card, panel, sidebar rows and Activity drawer. Everything here is derived from
 * what Muse sent and what the fold traced about the order it arrived in: a state is never inferred from the clock
 * alone. The one clock rule is the no-update threshold, and that is reported as a fact ("no update for 4m 12s"),
 * never as a verdict. A thread's DeepResearch runs join the same view from the store's summaries, so a research
 * worker is an agent here like any other; the daemon reports those whole, so nothing about them is traced.
 */

export type AgentState =
  | "planned" | "scheduled" | "working" | "finishing" | "no-update"
  | "waiting-on-you" | "failed" | "skipped" | "done" | "unknown";

export type AgentKind = "workflow" | "subagent" | "task" | "research";

/** What a run is: a Muse workflow, or a DeepResearch run the daemon supervises. */
export type RunKind = "workflow" | "research";

/** What the daemon counts for a research worker; the run's report carries what the worker found. */
export type ResearchAgentInfo = {
  agentId: number;
  round: number;
  searches: number;
  reads: number;
  saved: number;
  /** A discovery worker looks for topics rather than answers. */
  discovery: boolean;
  /** The worker model the run's config names, when it names one. */
  model: string | null;
  /** The daemon's own word for the worker, for the copy that has one. */
  wireState: ResearchWorkerState;
};

/** The research run's own facts that the generic run fields cannot carry. */
export interface ResearchRunInfo {
  runId: string;
  status: ResearchStatus;
  phase: ResearchPhase;
  round: number;
  maxRounds: number;
  question: string;
  sources: ResearchRunView["sources"];
  /** When the window routes the run to writing; null once it has ended or before it started. */
  deadlineAt: number | null;
  /** The run wrote a report, which the transcript row shows. */
  reportAvailable: boolean;
}

/** An action this client sent that Muse has not confirmed with a revision yet. */
export type PendingAction = "retry" | "stop";

export type SkippedBy = "you" | "run" | "muse";

export interface AttemptEventVM {
  kind: "scheduled" | "started" | "usage" | "completed" | "failed" | "cancelled" | "unknown";
  /** Null when no revision carrying this step had a time. */
  at: number | null;
  detail: string | null;
}

export interface AttemptVM {
  attempt: number;
  /** Oldest first. */
  events: AttemptEventVM[];
  startedAt: number | null;
  endedAt: number | null;
  /** Null while the attempt is still going. */
  outcome: "done" | "failed" | "skipped" | "unknown" | null;
}

export interface AgentVM {
  /** Durable id: the workflow child id, the subagent id, or the background task's item id. */
  id: string;
  attempt: number;
  /** The label as Muse sent it, never humanized; `Agent N` when Muse sent none. */
  name: string;
  /** The label Muse sent, or null when the row is numbered. */
  label: string | null;
  /** `judge:` / `perf`; the prefix is null when the name has no colon. */
  display: { prefix: string | null; short: string };
  phase: string;
  kind: AgentKind;
  state: AgentState;
  pending: PendingAction | null;
  /** Why a skipped agent stopped: this client asked, the run was stopped, or Muse cancelled it. */
  skippedBy: SkippedBy | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The last revision that touched this (id, attempt). */
  lastEventAt: number | null;
  /** Clock minus `lastEventAt` while working or finishing; for a task, since its last output. */
  silenceMs: number | null;
  /** Clock minus `startedAt` while not terminal. */
  runningMs: number | null;
  /** Muse's own duration once it stopped, else the traced one. */
  durationMs: number | null;
  /** Times were read off a capped history, so they are approximate. */
  approx: boolean;
  tokens: TokenUsage | null;
  /** Tool calls, which Muse reports for workflow agents only when the run ends. */
  toolCalls: number | null;
  attempts: AttemptVM[];
  failure: { text: string | null; at: number | null } | null;
  task: { text: string; source: "script" | "objective" } | null;
  /** Duration over the longest finished agent in the run; may exceed 1. Running time while under way. */
  shareOfLongest: number | null;
  /** Present when the state is `no-update`. */
  quiet: { thresholdMs: number; longestFinishedMs: number | null } | null;
  /** A request this row can be tied to: a background task's approval. Workflow agents get none in v1. */
  needs: { kind: "approval" | "input"; command: string | null; askedAt: number | null; requestId: string } | null;
  /** The run this workflow agent belongs to, for the controls. */
  runItemId: string | null;
  workflowRunId: string | null;
  taskInfo?: { command: string; tail: string | null; lastOutputAt: number | null; initiator: "user" | "timeout" | null; approvalId: string | null };
  /** Present on a research worker: its counters, as the daemon reports them. */
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
  /** In schedule order. */
  agents: AgentVM[];
  counts: Counts;
  state: "planned" | "live" | "done" | "done-with-failures" | "done-skipped";
  startedAt: number | null;
  endedAt: number | null;
  /** From the first start to the last end, when both are known. */
  durationMs: number | null;
  /** Latched usage added up; null when no agent reported. */
  tokens: number | null;
}

export type RunStatus = "starting" | "running" | "finished" | "finished-with-failures" | "stopped" | "failed";

export interface RunNeedVM {
  kind: "approval" | "input";
  /** The command an approval wants to run, or the question asked. */
  command: string | null;
  askedAt: number | null;
  requestId: string;
  /** The phase that was current when it was asked, when the times allow saying. */
  phase: string | null;
}

export interface RunVM {
  /** The workflow item's id, or `research:<runId>` for a research run. */
  itemId: string;
  runId: string | null;
  /** `Item.entryId`, else the script's slug, else `Workflow`; a research run's question, cut to a line. */
  name: string;
  kind: RunKind;
  /** Present on a research run. */
  research: ResearchRunInfo | null;
  status: RunStatus;
  revision: number;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  /** The first revision was cut by the history cap, so the elapsed time is an upper bound. */
  elapsedApprox: boolean;
  /** Early revisions are missing or some agents carry no name. */
  partialHistory: boolean;
  phases: PhaseVM[];
  /** Every agent, planned ones last, in schedule order. */
  agents: AgentVM[];
  counts: Counts;
  /** Waiting on you, then failed, then no update; stable within a class. */
  attention: AgentVM[];
  /** Requests raised while the run is live that no agent can be named for (v1). */
  runNeeds: RunNeedVM[];
  currentPhase: string | null;
  /** The planned total came from the launch script. */
  plannedKnown: boolean;
  tokens: { total: number; reported: number; of: number } | null;
  cost: { usd: number; model: string } | null;
  slots: { used: number; max: number } | null;
  /** Ten bins of revisions per minute, oldest first. */
  pulse: number[];
  longestFinishedMs: number | null;
  /** Agents' durations added up; larger than the wall clock, since they run together. */
  agentTimeMs: number | null;
  peakConcurrency: { n: number; phase: string } | null;
  waitedOnYouMs: number | null;
  /** Agents that needed more than one attempt. */
  retried: number;
  report: { summary: string | null; failure: string | null; handoffs: { agent: string; description: string }[] } | null;
  stale: boolean;
  staleAt: number | null;
  /** The instant every running clock was read at: `now`, or the moment the feed went stale. */
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
  /** An icon name for the row: Timer, Database, Wrench, ArrowCounterClockwise, ShieldWarning, UsersThree, MinusCircle, WarningCircle, Question. */
  icon: string;
  /** The whole line, plain; `strong` is the part of it to set in bold. */
  text: string;
  strong: string;
  aside: string | null;
}

export interface FingerprintLaneVM {
  id: string;
  name: string;
  phase: string;
  state: AgentState;
  /** Offsets from the run's start, one span per attempt that started. */
  spans: { startMs: number; endMs: number; failed: boolean }[];
}

export interface FingerprintVM {
  totalMs: number;
  phases: { name: string; startMs: number | null; endMs: number | null }[];
  lanes: FingerprintLaneVM[];
  /** Some agents have no times, so the picture comes from loaded history only. */
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
  /** The command of a thread that only has a background task. */
  task: string | null;
  /** The run summarized is still going. */
  live: boolean;
  endedAt: number | null;
}

export interface ActivityItemVM {
  sessionId: string;
  /** The run or task item; null for a request row or a thread-level note. */
  itemId: string | null;
  /** The agent id the drawer's Open should inspect, when it stands for one. */
  agentId: string | null;
  kind: "run" | "task" | "subagent" | "request";
  project: string;
  thread: string;
  text: string;
  sub: string | null;
  state: AgentState | "request";
  startedAt: number | null;
  endedAt: number | null;
  /** A row for a thread whose fold may have missed events; what it shows is last known. */
  stale: boolean;
}

export interface ActivityVM {
  needsYou: ActivityItemVM[];
  working: ActivityItemVM[];
  finishedToday: ActivityItemVM[];
  /** What Stop everything would stop in the open thread; null when nothing. */
  stopAll: { runs: number; tasks: number } | null;
  foot: string;
  empty: boolean;
  /** The v1 note for threads Ancilla does not fold. */
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
  /** The history read was capped. */
  partialHistory?: boolean;
  /** Actions this client sent, by `pendingKey`. */
  pending?: Readonly<Record<string, PendingAction>>;
  /** Skips this client sent, by `pendingKey`, so a cancelled attempt reads "Skipped by you". */
  skipped?: readonly string[];
  sessionModel?: string | null;
  models?: readonly ModelOption[];
  numbers?: AgentNumbers;
  /** The thread's DeepResearch runs, from the store; each becomes a run beside the workflow ones. */
  researchRuns?: readonly ResearchRunView[];
}

export type SummaryChip = { kind: "needs" | "failed" | "no-update" | "stale" | "skipped" | "run-failed"; count: number; text: string };

/** The key `pending` and `skipped` use for one attempt of one agent. */
export function pendingKey(sessionId: string, agentId: string, attempt: number): string {
  return `${sessionId}:${agentId}:${attempt}`;
}

/** A research run's item id: `research:<runId>`, so the controls can tell it from a workflow item by its prefix. */
export const RESEARCH_ITEM_PREFIX = "research:";

export function researchItemId(runId: string): string {
  return `${RESEARCH_ITEM_PREFIX}${runId}`;
}

/** The research run id an item id names, or null for a workflow item. */
export function researchRunIdOf(itemId: string): string | null {
  return itemId.startsWith(RESEARCH_ITEM_PREFIX) ? itemId.slice(RESEARCH_ITEM_PREFIX.length) : null;
}

/** A research worker's agent id: `research:<runId>:A<agentId>`, stable across the run's revisions. */
export function researchAgentId(runId: string, agentId: number): string {
  return `${researchItemId(runId)}:A${agentId}`;
}

/** `2 searches · 3 reads · 1 saved`, or `no calls yet` before the worker has made one. */
export function researchCounters(info: Pick<ResearchAgentInfo, "searches" | "reads" | "saved">): string {
  const parts: string[] = [];
  if (info.searches > 0) parts.push(plural(info.searches, "search", "searches"));
  if (info.reads > 0) parts.push(plural(info.reads, "read"));
  if (info.saved > 0) parts.push(`${info.saved} saved`);
  return parts.length > 0 ? parts.join(" · ") : "no calls yet";
}

/** Nothing shorter than this is ever remarkable: real agents take minutes. */
export const NO_UPDATE_FLOOR_MS = 4 * 60_000;
/** A background task that printed nothing for this long says so. */
export const TASK_NO_OUTPUT_MS = 4 * 60_000;
/** Children scheduled this close together were one burst, when their labels carry no phase. */
const BURST_GAP_MS = 2_000;
const PULSE_BINS = 10;
/** A recap is worth showing after this long away. */
const SINCE_LEFT_MIN_MS = 5 * 60_000;

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
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function plural(n: number, word: string, words = `${word}s`): string {
  return `${n} ${n === 1 ? word : words}`;
}

/** Tokens an agent used: what went in, what came out, and what it thought, as Muse counts them apart. */
export function usageTotal(usage: TokenUsage | null | undefined): number {
  return usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0) : 0;
}

/** `41m 16s`, `4s`, `2h 13m`: seconds stay while the run is under an hour, so a line visibly ticks. */
export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "";
  }
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `about 41m`: a duration whose start was not seen exactly. */
export function aboutText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `about ${minutes}m`;
  }
  return `about ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** Numbers as words up to twelve, digits above, for the completion headline. */
export function numberWord(n: number): string {
  return n >= 0 && n < WORDS.length ? (WORDS[n] as string) : String(n);
}

// ---------------------------------------------------------------- sigil

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const SIGIL_FALLBACK: readonly (readonly boolean[])[] = [
  [false, true, true, true, false],
  [true, false, true, false, true],
  [true, true, true, true, true],
  [true, false, false, false, true],
  [false, true, false, true, false],
];

const sigils = new Map<string, boolean[][]>();
const SIGIL_CACHE = 4096;

/**
 * A deterministic 5×5 mirrored pixel mark for a name: the same name gives the same grid on every surface. Salts
 * are tried until the grid reads well (9 to 15 lit cells, four rows and every source column used, a middle row,
 * and a top or bottom row), which the fallback shape guarantees when no salt does.
 */
export function sigilGrid(name: string): boolean[][] {
  const cached = sigils.get(name);
  if (cached) {
    return cached;
  }
  let grid: boolean[][] | null = null;
  for (let salt = 0; salt < 64 && grid === null; salt += 1) {
    const h = fnv1a(`${name}#${salt}`);
    const rows: boolean[][] = [];
    let lit = 0;
    for (let r = 0; r < 5; r += 1) {
      const a = ((h >>> (r * 3)) & 1) === 1;
      const b = ((h >>> (r * 3 + 1)) & 1) === 1;
      const c = ((h >>> (r * 3 + 2)) & 1) === 1;
      rows.push([a, b, c, b, a]);
      lit += (a ? 2 : 0) + (b ? 2 : 0) + (c ? 1 : 0);
    }
    const rowsUsed = rows.filter((row) => row.some(Boolean)).length;
    const colsUsed = [0, 1, 2].filter((col) => rows.some((row) => row[col])).length;
    const middle = (rows[2] as boolean[]).some(Boolean);
    const edge = (rows[0] as boolean[]).some(Boolean) || (rows[4] as boolean[]).some(Boolean);
    if (lit >= 9 && lit <= 15 && rowsUsed >= 4 && colsUsed === 3 && middle && edge) {
      grid = rows;
    }
  }
  const result = grid ?? SIGIL_FALLBACK.map((row) => [...row]);
  if (sigils.size >= SIGIL_CACHE) {
    sigils.delete(sigils.keys().next().value as string);
  }
  sigils.set(name, result);
  return result;
}

// ---------------------------------------------------------------- launch script and policy

export interface Plan {
  /** Labels in script order. */
  labels: string[];
  /** Each label's `input` literal, when the script gave one. */
  inputs: Record<string, string>;
  /** Every label was a plain literal; a template with `${}` in it means the real plan is not knowable here. */
  complete: boolean;
}

interface ScanObject {
  index: number;
  label: string | null;
  input: string | null;
  dynamic: boolean;
}

/** A string literal starting at `i` (which holds the quote); returns the text and where it ends, never throwing. */
function readString(source: string, i: number): { value: string; end: number; dynamic: boolean } {
  const quote = source[i] as string;
  let value = "";
  let dynamic = false;
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j] as string;
    if (ch === "\\" && j + 1 < source.length) {
      const next = source[j + 1] as string;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      j += 2;
      continue;
    }
    if (ch === quote) {
      return { value, end: j + 1, dynamic };
    }
    if (quote === "`" && ch === "$" && source[j + 1] === "{") {
      dynamic = true;
    }
    if (ch === "\n" && quote !== "`") {
      // An unterminated line string: take what was read and carry on after the line.
      return { value, end: j + 1, dynamic };
    }
    value += ch;
    j += 1;
  }
  return { value, end: source.length, dynamic };
}

/**
 * The agents a generated workflow script plans, read off its `host.parallel([{ label, input }])` literals without
 * running a line of it. The scan is a tolerant tokenizer: comments and strings are skipped as units, every object
 * literal with a string `label` counts, and malformed JavaScript ends the scan rather than raising. Null when the
 * script never calls `host.parallel` or `host.agent`, or names no agent.
 */
export function readPlan(script: string | undefined): Plan | null {
  if (!script || !/\bhost\s*\.\s*(parallel|agent)\s*\(/.test(script)) {
    return null;
  }
  const objects: ScanObject[] = [];
  const stack: ScanObject[] = [];
  let index = 0;
  let i = 0;
  const n = script.length;
  while (i < n) {
    const ch = script[i] as string;
    if (ch === "/" && script[i + 1] === "/") {
      const end = script.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "/" && script[i + 1] === "*") {
      const end = script.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = readString(script, i).end;
      continue;
    }
    if (ch === "{") {
      const object: ScanObject = { index: index++, label: null, input: null, dynamic: false };
      stack.push(object);
      objects.push(object);
      i += 1;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(script[j] as string)) {
        j += 1;
      }
      const word = script.slice(i, j);
      i = j;
      if ((word === "label" || word === "input") && stack.length > 0) {
        let k = i;
        while (k < n && /\s/.test(script[k] as string)) {
          k += 1;
        }
        if (script[k] === ":") {
          k += 1;
          while (k < n && /\s/.test(script[k] as string)) {
            k += 1;
          }
          const quote = script[k];
          if (quote === '"' || quote === "'" || quote === "`") {
            const literal = readString(script, k);
            const top = stack[stack.length - 1] as ScanObject;
            if (word === "label") {
              top.label = literal.value;
              top.dynamic ||= literal.dynamic;
            } else {
              top.input = literal.value;
            }
            i = literal.end;
          }
        }
      }
      continue;
    }
    i += 1;
  }
  const labels: string[] = [];
  const inputs: Record<string, string> = {};
  let complete = true;
  for (const object of objects.sort((a, b) => a.index - b.index)) {
    if (object.label === null || object.label.trim() === "") {
      continue;
    }
    labels.push(object.label);
    complete &&= !object.dynamic;
    if (object.input !== null) {
      inputs[object.label] = object.input;
    }
  }
  return labels.length > 0 ? { labels, inputs, complete } : null;
}

export interface LaunchPolicy {
  maxParallelAgents: number | null;
  childLimit: number | null;
  tokenBudget: number | null;
}

/** The limits the launch tool reported in its output, or null when the output is not that JSON. */
export function readLaunchPolicy(visibleOutput: string | undefined): LaunchPolicy | null {
  const parsed = parseArgs(visibleOutput);
  if (!parsed) {
    return null;
  }
  const policy = record(parsed["policy"]);
  return {
    maxParallelAgents: num(parsed["maxParallelAgents"]),
    childLimit: policy ? num(policy["childLimit"]) : null,
    tokenBudget: num(parsed["tokenBudget"]) ?? (policy ? num(policy["tokenBudget"]) : null),
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

const launches = new WeakMap<MspItem, LaunchInfo>();
const plans = new Map<string, Plan | null>();
const PLAN_CACHE = 32;

/** What the tool call that launched a run says about it, parsed once per item revision. */
function launchInfo(item: MspItem): LaunchInfo {
  const cached = launches.get(item);
  if (cached) {
    return cached;
  }
  const outer = parseArgs(item.args);
  const inner = outer && typeof outer["args"] === "string" ? (parseArgs(outer["args"]) ?? outer) : outer;
  const script = text(inner?.["script"]) ?? text(outer?.["script"]) ?? undefined;
  let plan: Plan | null = null;
  if (script) {
    if (plans.has(script)) {
      plan = plans.get(script) ?? null;
    } else {
      plan = readPlan(script);
      if (plans.size >= PLAN_CACHE) {
        plans.delete(plans.keys().next().value as string);
      }
      plans.set(script, plan);
    }
  }
  const info: LaunchInfo = {
    itemId: item.itemId,
    callId: text(item.callId),
    name: text(inner?.["name"]) ?? text(outer?.["name"]),
    plan,
    policy: readLaunchPolicy(item.visibleOutput),
    turnId: text(item.turnId),
  };
  launches.set(item, info);
  return info;
}

interface ThreadIndex {
  /** Tool calls that launched a workflow. */
  launches: string[];
  /** `subagent_spawn` tool calls. */
  spawns: string[];
  /** `subagent_wait` tool calls. */
  waits: string[];
}

const indexes = new WeakMap<Record<string, MspItem>, { order: readonly string[]; index: ThreadIndex }>();
const itemPositions = new WeakMap<readonly string[], ReadonlyMap<string, number>>();

function transcriptPositions(order: readonly string[]): ReadonlyMap<string, number> {
  let positions = itemPositions.get(order);
  if (!positions) {
    positions = new Map(order.map((id, position) => [id, position]));
    itemPositions.set(order, positions);
  }
  return positions;
}

/**
 * Where the thread's launch and subagent tool calls are. Tool metadata can arrive after an output placeholder,
 * so invalidate on the small Crew index, not just transcript order. Prose deltas leave this index alone.
 */
function threadIndex(fold: ThreadFold): ThreadIndex {
  const items = fold.agentItems ?? fold.items;
  const cached = indexes.get(items);
  if (cached?.order === fold.order) {
    return cached.index;
  }
  const index: ThreadIndex = { launches: [], spawns: [], waits: [] };
  for (const item of Object.values(items)) {
    if (item.kind !== "toolCall") {
      continue;
    }
    if (item.tool === "workflow") {
      index.launches.push(item.itemId);
    } else if (item.tool === "subagent_spawn") {
      index.spawns.push(item.itemId);
    } else if (item.tool === "subagent_wait") {
      index.waits.push(item.itemId);
    }
  }
  // The launch fallback picks the first matching name in its turn, and native rows keep first-opened order.
  // Index insertion follows metadata arrival, which can be later than the item's output placeholder.
  if (index.launches.length > 1 || index.spawns.length > 1) {
    const positions = transcriptPositions(fold.order);
    const compare = (a: string, b: string): number => (positions.get(a) ?? -1) - (positions.get(b) ?? -1);
    index.launches.sort(compare);
    index.spawns.sort(compare);
  }
  indexes.set(items, { order: fold.order, index });
  return index;
}

/** The launch behind a run: by the call id the run id embeds or the payload names, else the same turn's launch. */
function launchFor(fold: ThreadFold, run: MspItem, payloadCallId: string | null): LaunchInfo | null {
  const index = threadIndex(fold);
  if (index.launches.length === 0) {
    return null;
  }
  const infos = index.launches.map((id) => fold.items[id]).filter((item): item is MspItem => item !== undefined).map(launchInfo);
  const runId = text(run.workflowRunId);
  const byCall = infos.find((info) => info.callId !== null && (info.callId === payloadCallId || (runId !== null && runId.endsWith(info.callId))));
  if (byCall) {
    return byCall;
  }
  const entryId = text(run.entryId);
  const byTurn = infos.filter((info) => info.turnId !== null && info.turnId === text(run.turnId));
  return byTurn.find((info) => entryId !== null && info.name === entryId) ?? (byTurn.length === 1 ? (byTurn[0] as LaunchInfo) : null) ?? (infos.length === 1 ? (infos[0] as LaunchInfo) : null);
}

// ---------------------------------------------------------------- the state machine

type Outcome = "done" | "failed" | "skipped" | "unknown";

function normalizedWord(value: string | undefined): string {
  return (value ?? "").replace(/[\s_-]/g, "").toLowerCase();
}

/** Muse's terminal word as the four outcomes the rows show; any word this version does not know is unknown. */
function outcomeOfTerminal(terminal: string | undefined): Outcome {
  switch (normalizedWord(terminal)) {
    case "completed": case "complete": case "succeeded": case "success": case "done":
      return "done";
    case "failed": case "error": case "rejected": case "timedout":
      return "failed";
    case "cancelled": case "canceled": case "stopped": case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

/** The outcome of an attempt, or null while it is still going. */
export function childOutcome(child: WorkflowChild): Outcome | null {
  if (text(child.terminal)) {
    return outcomeOfTerminal(child.terminal);
  }
  switch (normalizedWord(child.status)) {
    case "completed": case "complete": case "succeeded": case "success": case "done":
      return "done";
    case "terminal":
      return "unknown";
    default:
      return null;
  }
}

function lifecycleState(status: string | undefined): "scheduled" | "finishing" | "working" {
  switch (normalizedWord(status)) {
    case "scheduled": case "queued": case "pending":
      return "scheduled";
    case "usage":
      return "finishing";
    default:
      return "working";
  }
}

function childKey(child: { childId: string; attempt: number }): string {
  return `${child.childId}:${child.attempt}`;
}

/** The label split for display: `judge:` and `perf`. */
function displayOf(name: string): AgentVM["display"] {
  const colon = name.indexOf(":");
  return colon > 0 ? { prefix: name.slice(0, colon + 1), short: name.slice(colon + 1) } : { prefix: null, short: name };
}

/** The phase a label names with its prefix, capitalized: `research:field-notes` is in `Research`. */
function prefixPhase(label: string | null): string | null {
  if (!label) {
    return null;
  }
  const colon = label.indexOf(":");
  const prefix = colon > 0 ? label.slice(0, colon).trim() : "";
  return prefix ? capitalize(prefix) : null;
}

const payloads = new WeakMap<MspItem, ReturnType<typeof reconciled>>();

function payloadOf(item: MspItem): ReturnType<typeof reconciled> {
  if (payloads.has(item)) {
    return payloads.get(item) ?? null;
  }
  const parsed = reconciled(item.message);
  payloads.set(item, parsed);
  return parsed;
}

interface DurableChild {
  childId: string;
  /** Every attempt the item still lists, oldest first. */
  entries: WorkflowChild[];
  latest: WorkflowChild;
  /** The trace per attempt number, for attempts the item still lists and ones it dropped. */
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

const runCaches = new Map<string, RunCache>();
const RUN_CACHES = 64;

function runCacheFor(key: string): RunCache {
  const cache = runCaches.get(key) ?? { children: new Map() };
  runCaches.delete(key);
  runCaches.set(key, cache);
  for (const stale of runCaches.keys()) {
    if (runCaches.size <= RUN_CACHES) break;
    runCaches.delete(stale);
  }
  return cache;
}

function sameOptional<T extends Record<string, unknown>>(a: T | null | undefined, b: T | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const key of Object.keys(a)) {
    if (a[key] !== b[key]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

/** Two rows that would render the same: the cached one keeps its identity so the row above it never re-renders. */
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
  const events: AttemptEventVM[] = [];
  const stage = entry ? lifecycleState(entry.status) : "working";
  const started = trace?.startedAt !== undefined || (entry !== undefined && stage !== "scheduled") || outcome !== null;
  events.push({ kind: "scheduled", at: trace?.scheduledAt ?? null, detail: trace?.approx && trace.scheduledAt !== undefined ? "about" : null });
  if (started) {
    events.push({ kind: "started", at: trace?.startedAt ?? null, detail: null });
  }
  if (trace?.usageAt !== undefined || trace?.usage !== undefined || (entry !== undefined && stage === "finishing")) {
    const usage = trace?.usage ?? entry?.usage;
    events.push({ kind: "usage", at: trace?.usageAt ?? null, detail: usage ? `${formatTokens(usageTotal(usage))} tokens` : null });
  }
  if (outcome !== null) {
    const since = trace?.startedAt !== undefined && terminalAt !== null ? terminalAt - trace.startedAt : null;
    const duration = num(entry?.durationMs) ?? trace?.durationMs ?? since;
    const after = duration !== null && duration >= 0 ? `after ${durationText(duration)}` : null;
    events.push({
      kind: outcome === "done" ? "completed" : outcome === "failed" ? "failed" : outcome === "skipped" ? "cancelled" : "unknown",
      at: terminalAt,
      detail: outcome === "unknown" ? "Muse did not report an outcome" : after,
    });
  }
  return events;
}

/** When an attempt ended, from the trace: its terminal revision, else its completion revision. */
function attemptEnd(trace: ChildTrace | undefined): number | null {
  return trace?.terminalAt ?? trace?.completedAt ?? null;
}

function buildAttempts(durable: DurableChild, runEnded: boolean): AttemptVM[] {
  const numbers = [...new Set([...durable.traces.keys(), ...durable.entries.map((entry) => entry.attempt)])].sort((a, b) => a - b);
  return numbers.map((attempt) => {
    const entry = durable.entries.find((candidate) => candidate.attempt === attempt);
    const trace = durable.traces.get(attempt);
    const latest = attempt === durable.latest.attempt;
    // An attempt the item no longer lists was replaced by a retry: it ended with the word the trace kept, or none.
    const outcome = entry
      ? (childOutcome(entry) ?? (runEnded ? "unknown" : null))
      : trace?.terminal ? outcomeOfTerminal(trace.terminal) : latest && !runEnded ? null : "unknown";
    const endedAt = outcome === null ? null : attemptEnd(trace);
    return {
      attempt,
      events: attemptEvents(entry, trace, outcome, endedAt),
      startedAt: trace?.startedAt ?? null,
      endedAt,
      outcome,
    };
  });
}

interface RunContext {
  fold: ThreadFold;
  sessionId: string | null;
  now: number;
  /** The instant clocks are read at: `now`, or when the feed went stale. */
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

/** The phase each child belongs to: Muse's own word, else the label's prefix, else the scheduling burst. */
function assignPhases(children: DurableChild[]): Map<string, string> {
  const phases = new Map<string, string>();
  const unnamed: DurableChild[] = [];
  let prefixed = false;
  for (const child of children) {
    const own = text(child.latest.phase) ?? [...child.entries].reverse().map((entry) => text(entry.phase)).find((value) => value !== null) ?? null;
    const prefix = prefixPhase(child.label);
    if (own) {
      phases.set(child.childId, own);
    } else if (prefix) {
      phases.set(child.childId, prefix);
      prefixed = true;
    } else {
      unnamed.push(child);
    }
  }
  if (unnamed.length === 0) {
    return phases;
  }
  // Waves are only a story when no label tells one; next to named phases the rest are simply agents.
  if (prefixed || unnamed.some((child) => child.scheduledAt === null)) {
    for (const child of unnamed) phases.set(child.childId, "Agents");
    return phases;
  }
  const ordered = [...unnamed].sort((a, b) => (a.scheduledAt as number) - (b.scheduledAt as number));
  const bursts: DurableChild[][] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const child of ordered) {
    const at = child.scheduledAt as number;
    if (at - last > BURST_GAP_MS || bursts.length === 0) {
      bursts.push([]);
    }
    (bursts[bursts.length - 1] as DurableChild[]).push(child);
    last = at;
  }
  bursts.forEach((burst, index) => {
    for (const child of burst) phases.set(child.childId, bursts.length === 1 ? "Agents" : `Wave ${index + 1}`);
  });
  return phases;
}

function emptyCounts(): Counts {
  return { total: 0, planned: 0, scheduled: 0, working: 0, finishing: 0, noUpdate: 0, waiting: 0, failed: 0, skipped: 0, done: 0, unknown: 0 };
}

function count(counts: Counts, state: AgentState): void {
  counts.total += 1;
  switch (state) {
    case "planned": counts.planned += 1; break;
    case "scheduled": counts.scheduled += 1; break;
    case "working": counts.working += 1; break;
    case "finishing": counts.finishing += 1; break;
    case "no-update": counts.noUpdate += 1; break;
    case "waiting-on-you": counts.waiting += 1; break;
    case "failed": counts.failed += 1; break;
    case "skipped": counts.skipped += 1; break;
    case "done": counts.done += 1; break;
    case "unknown": counts.unknown += 1; break;
  }
}

/** The run's counts from its phases; the same numbers the run carries, for a caller holding only phases. */
export function runCounts(run: Pick<RunVM, "phases">): Counts {
  const counts = emptyCounts();
  for (const phase of run.phases) {
    for (const agent of phase.agents) count(counts, agent.state);
  }
  return counts;
}

/** Waiting on you, then failed, then no update, each class in the order given. */
export function attentionOrder(agents: readonly AgentVM[]): AgentVM[] {
  const waiting: AgentVM[] = [];
  const failed: AgentVM[] = [];
  const quiet: AgentVM[] = [];
  for (const agent of agents) {
    if (agent.state === "waiting-on-you") waiting.push(agent);
    else if (agent.state === "failed") failed.push(agent);
    else if (agent.state === "no-update") quiet.push(agent);
  }
  return [...waiting, ...failed, ...quiet];
}

/**
 * How long a working agent may go without a revision before the run says so: four minutes, or the longest agent that
 * finished in this run, whichever is more. Null before any agent has finished: with nothing to compare against,
 * silence is not remarkable.
 */
export function noUpdateThresholdMs(run: Pick<RunVM, "longestFinishedMs">): number | null {
  return run.longestFinishedMs === null ? null : Math.max(NO_UPDATE_FLOOR_MS, run.longestFinishedMs);
}

function phaseState(counts: Counts): PhaseVM["state"] {
  if (counts.total > 0 && counts.planned === counts.total) return "planned";
  if (counts.scheduled + counts.working + counts.finishing + counts.noUpdate + counts.waiting + counts.planned > 0) return "live";
  if (counts.failed + counts.unknown > 0) return "done-with-failures";
  if (counts.skipped > 0) return "done-skipped";
  return "done";
}

/** Groups agents by the phase they carry, in the order phases first appear; planned agents go in their phases last. */
export function phasesOf(agents: readonly AgentVM[]): PhaseVM[] {
  const byName = new Map<string, AgentVM[]>();
  for (const agent of agents) {
    if (agent.state === "planned") continue;
    const list = byName.get(agent.phase);
    if (list) list.push(agent);
    else byName.set(agent.phase, [agent]);
  }
  for (const agent of agents) {
    if (agent.state !== "planned") continue;
    const list = byName.get(agent.phase);
    if (list) list.push(agent);
    else byName.set(agent.phase, [agent]);
  }
  const phases: PhaseVM[] = [];
  for (const [name, members] of byName) {
    const counts = emptyCounts();
    let startedAt: number | null = null;
    let endedAt: number | null = null;
    let allEnded = true;
    let tokens: number | null = null;
    for (const agent of members) {
      count(counts, agent.state);
      if (agent.startedAt !== null && (startedAt === null || agent.startedAt < startedAt)) startedAt = agent.startedAt;
      if (ENDED_STATES.has(agent.state)) {
        if (agent.endedAt !== null && (endedAt === null || agent.endedAt > endedAt)) endedAt = agent.endedAt;
      } else {
        allEnded = false;
      }
      if (agent.tokens) tokens = (tokens ?? 0) + usageTotal(agent.tokens);
    }
    if (!allEnded) endedAt = null;
    phases.push({
      name,
      agents: members,
      counts,
      state: phaseState(counts),
      startedAt,
      endedAt,
      durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
      tokens,
    });
  }
  return phases;
}

/** Ten bins of revisions per minute ending at `clock`, oldest first. */
export function pulseBins(trace: RunTrace | undefined, clock: number): number[] {
  return binsOf(trace?.eventMinutes ?? [], clock);
}

/** The pulse over any list of event minutes, sorted ascending. */
function binsOf(eventMinutes: readonly number[], clock: number): number[] {
  const bins = new Array<number>(PULSE_BINS).fill(0);
  const last = Math.floor(clock / 60_000);
  const first = last - PULSE_BINS + 1;
  for (let i = eventMinutes.length - 1; i >= 0; i -= 1) {
    const minute = eventMinutes[i] as number;
    if (minute < first) break;
    if (minute <= last) bins[minute - first] = (bins[minute - first] as number) + 1;
  }
  return bins;
}

/** An estimate in dollars at the model's list price; null without a price or without usage. */
export function costEstimate(tokens: TokenUsage | null | undefined, modelId: string | null, models: readonly ModelOption[] = []): number | null {
  if (!tokens || !modelId) return null;
  const catalog = models.find((m) => m.modelId === modelId)?.cost ?? null;
  const price = catalog ? { input: catalog.input, output: catalog.output, cached: catalog.cached, currency: catalog.currency ?? "USD" } : listedPrice(modelId);
  if (!price) return null;
  const input = tokens.inputTokens ?? 0;
  const cached = Math.min(input, tokens.cacheReadTokens || tokens.cachedTokens || 0);
  return costOf(price, { promptTokens: input, outputTokens: (tokens.outputTokens ?? 0) + (tokens.reasoningTokens ?? 0), cachedTokens: cached });
}

/** The most agents that were ever running at once, and the phase most of them were in then. */
function peakOf(agents: readonly AgentVM[], clock: number): RunVM["peakConcurrency"] {
  const edges: { at: number; delta: number; phase: string }[] = [];
  for (const agent of agents) {
    for (const attempt of agent.attempts) {
      if (attempt.startedAt === null) continue;
      const end = attempt.endedAt ?? (attempt.outcome === null ? clock : null);
      if (end === null || end < attempt.startedAt) continue;
      edges.push({ at: attempt.startedAt, delta: 1, phase: agent.phase });
      edges.push({ at: end, delta: -1, phase: agent.phase });
    }
  }
  if (edges.length === 0) return null;
  // Ends before starts at the same instant, so a handover between agents does not count as two.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  const open = new Map<string, number>();
  let running = 0;
  let best = 0;
  let bestPhase = "";
  for (const edge of edges) {
    running += edge.delta;
    open.set(edge.phase, (open.get(edge.phase) ?? 0) + edge.delta);
    if (running > best) {
      best = running;
      let top = 0;
      for (const [phase, n] of open) {
        if (n > top) {
          top = n;
          bestPhase = phase;
        }
      }
    }
  }
  return best > 0 ? { n: best, phase: bestPhase } : null;
}

/** The phase that was current at `at`: the first, in order, with an agent that had started and not ended by then. */
function phaseAt(phases: readonly PhaseVM[], at: number): string | null {
  for (const phase of phases) {
    for (const agent of phase.agents) {
      const started = agent.startedAt ?? agent.attempts.find((attempt) => attempt.startedAt !== null)?.startedAt ?? null;
      if (started === null || started > at) continue;
      if (agent.endedAt === null || agent.endedAt >= at) return phase.name;
    }
  }
  return null;
}

function requestCommand(fold: ThreadFold, id: string, kind: RequestTrace["kind"]): string | null {
  if (kind === "approval") {
    const request = fold.approvals[id];
    return request ? describeApproval(request).detail : null;
  }
  const request = fold.userInputs[id];
  return request?.questions?.[0]?.question ?? null;
}

/** The background task item a request is tied to, when its item is one. */
function taskOfRequest(fold: ThreadFold, request: ApprovalRequest | UserInputRequest): string | null {
  const itemId = text(request.itemId);
  return itemId && fold.items[itemId]?.background === true ? itemId : null;
}

function runStatusOf(item: MspItem, children: readonly DurableChild[], counts: Counts): RunStatus {
  if (item.status === "inProgress") return children.length === 0 ? "starting" : "running";
  if (normalizedWord(item.status) === "cancelled" || normalizedWord(item.status) === "canceled") return "stopped";
  if (TERMINAL_FAILURES.has(item.status)) return "failed";
  return counts.failed + counts.skipped + counts.unknown > 0 ? "finished-with-failures" : "finished";
}

function runView(item: MspItem, ctx: RunContext): RunVM {
  const { fold, clock } = ctx;
  const trace = fold.crew?.runs[item.itemId];
  const payload = payloadOf(item);
  const launch = launchFor(fold, item, text(payload?.call_id));
  const plan = launch?.plan ?? null;
  const ended = item.status !== "inProgress";
  const runId = text(item.workflowRunId);

  // Merge attempts per durable child. Rows keep the order agents were first scheduled in, which the trace
  // remembers even when a retry moves the agent within the item.
  const byId = new Map<string, DurableChild>();
  const traced = new Map<string, [number, ChildTrace][]>();
  if (trace) {
    for (const key of Object.keys(trace.children)) {
      const colon = key.lastIndexOf(":");
      const childId = key.slice(0, colon);
      const attempt = Number(key.slice(colon + 1));
      if (!Number.isInteger(attempt)) continue;
      const list = traced.get(childId);
      if (list) list.push([attempt, trace.children[key] as ChildTrace]);
      else traced.set(childId, [[attempt, trace.children[key] as ChildTrace]]);
    }
  }
  const present = new Set<string>();
  for (const child of Array.isArray(item.children) ? item.children : []) {
    if (child && typeof child.childId === "string") present.add(child.childId);
  }
  for (const childId of traced.keys()) {
    if (present.has(childId)) byId.set(childId, { childId, entries: [], latest: { childId, attempt: 0, status: "" }, traces: new Map(), label: null, scheduledAt: null });
  }
  for (const child of Array.isArray(item.children) ? item.children : []) {
    if (!child || typeof child.childId !== "string") continue;
    const attempt = Number.isInteger(child.attempt) && child.attempt > 0 ? child.attempt : 1;
    const entry = attempt === child.attempt ? child : { ...child, attempt };
    const durable = byId.get(child.childId);
    if (durable) {
      durable.entries.push(entry);
      if (entry.attempt > durable.latest.attempt) durable.latest = entry;
    } else {
      byId.set(child.childId, { childId: child.childId, entries: [entry], latest: entry, traces: new Map(), label: null, scheduledAt: null });
    }
  }
  for (const [childId, list] of traced) {
    const durable = byId.get(childId);
    if (!durable) continue;
    for (const [attempt, childTrace] of list) durable.traces.set(attempt, childTrace);
  }
  for (const durable of byId.values()) {
    durable.entries.sort((a, b) => a.attempt - b.attempt);
    for (const entry of durable.entries) {
      if (!durable.traces.has(entry.attempt)) durable.traces.set(entry.attempt, undefined);
    }
    // The label from the newest attempt that carried one; a retry that came without one keeps the agent's name.
    const attempts = [...durable.traces.keys()].sort((a, b) => b - a);
    durable.label = [...durable.entries].reverse().map((entry) => text(entry.label)).find((value) => value !== null)
      ?? attempts.map((attempt) => text(durable.traces.get(attempt)?.label)).find((value) => value !== null)
      ?? null;
    const first = durable.traces.get(Math.min(...durable.traces.keys()));
    durable.scheduledAt = first?.scheduledAt ?? first?.startedAt ?? uuidTime(durable.childId);
  }
  const children = [...byId.values()];
  const phaseNames = assignPhases(children);

  // Reconciliation totals are per durable child and arrive when the run ends.
  const activity = new Map<string, { durationMs: number | null; toolCalls: number | null }>();
  if (Array.isArray(payload?.agents_activity)) {
    for (const raw of payload.agents_activity) {
      const entry = record(raw);
      const id = text(entry?.["agent"]);
      if (entry && id) activity.set(id, { durationMs: num(entry["duration_ms"]), toolCalls: num(entry["tool_calls"]) });
    }
  }

  // First pass: the facts each attempt reports, so the threshold can be taken from the run's own evidence.
  interface Fact { durable: DurableChild; outcome: Outcome | null; trace: ChildTrace | undefined; startedAt: number | null; endedAt: number | null; durationMs: number | null }
  const facts: Fact[] = [];
  let longestFinishedMs: number | null = null;
  for (const durable of children) {
    const latest = durable.latest;
    const traceNow = durable.traces.get(latest.attempt);
    const outcome = childOutcome(latest) ?? (ended ? "unknown" : null);
    const startedAt = traceNow?.startedAt ?? null;
    const endedAt = outcome === null ? null : attemptEnd(traceNow) ?? (ended ? trace?.endedAt ?? null : null);
    const reported = num(latest.durationMs) ?? activity.get(durable.childId)?.durationMs ?? null;
    const durationMs = outcome === null ? null : reported ?? (startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null);
    if (outcome === "done" && durationMs !== null && (longestFinishedMs === null || durationMs > longestFinishedMs)) longestFinishedMs = durationMs;
    facts.push({ durable, outcome, trace: traceNow, startedAt, endedAt, durationMs });
  }
  const thresholdMs = ended || ctx.stale ? null : noUpdateThresholdMs({ longestFinishedMs });
  const failureText = text(payload?.latest_failure) ?? text(item.failureReason);
  let lastFailed: Fact | null = null;
  for (const fact of facts) {
    if (fact.outcome === "failed" && (lastFailed === null || (fact.endedAt ?? 0) >= (lastFailed.endedAt ?? 0))) lastFailed = fact;
  }
  const stopped = normalizedWord(item.status) === "cancelled" || normalizedWord(item.status) === "canceled";

  // Second pass: the rows, reusing the cached one wherever nothing about it changed.
  const cache = runCacheFor(`${ctx.sessionId ?? ""}:${item.itemId}`);
  const next = new Map<string, ChildCacheEntry>();
  const agents: AgentVM[] = [];
  let unnamed = false;
  for (const fact of facts) {
    const { durable, outcome } = fact;
    const latest = durable.latest;
    const traceNow = fact.trace;
    const key = ctx.sessionId ? pendingKey(ctx.sessionId, durable.childId, latest.attempt) : null;
    let state: AgentState;
    if (outcome !== null) {
      state = outcome;
    } else {
      state = lifecycleState(latest.status);
      if (state !== "scheduled" && thresholdMs !== null && traceNow?.lastEventAt !== undefined && traceNow.lastEventAt !== null && clock - traceNow.lastEventAt >= thresholdMs) {
        state = "no-update";
      }
    }
    const live = outcome === null;
    const pendingFlag = key ? ctx.pending[key] ?? null : null;
    const pending: PendingAction | null = pendingFlag === "retry" && live ? "retry" : pendingFlag === "stop" && live ? "stop" : null;
    const skippedBy: SkippedBy | null = outcome === "skipped" ? (key && ctx.skipped.has(key) ? "you" : stopped ? "run" : "muse") : null;
    const label = durable.label;
    if (label === null) unnamed = true;
    const name = label ?? `Agent ${numberFor(ctx.numbers, durable.childId)}`;
    const cached = cache.children.get(durable.childId);
    const traces = [...durable.traces.keys()].sort((a, b) => a - b).map((attempt) => durable.traces.get(attempt));
    const signature = `${latest.attempt}|${latest.status}|${latest.terminal ?? ""}|${ended ? 1 : 0}|${durable.entries.length}`;
    const attempts = cached && cached.signature === signature && cached.traces.length === traces.length && cached.traces.every((t, i) => t === traces[i])
      ? cached.vm.attempts
      : buildAttempts(durable, ended);
    const silenceMs = live && state !== "scheduled" && traceNow?.lastEventAt !== undefined && traceNow.lastEventAt !== null ? Math.max(0, clock - traceNow.lastEventAt) : null;
    const runningMs = live && fact.startedAt !== null ? Math.max(0, clock - fact.startedAt) : null;
    const measure = fact.durationMs ?? runningMs;
    const failure = outcome === "failed"
      ? { text: fact === lastFailed ? failureText : null, at: fact.endedAt }
      : null;
    const taskText = label !== null ? plan?.inputs[label] ?? null : null;
    // The newest attempt that reported usage. Muse does not say whether a retry's usage covers earlier attempts,
    // so adding attempts up could count tokens twice; the newest report is the agent's.
    const tokens = traceNow?.usage ?? latest.usage ?? attempts.slice().reverse().map((attempt) => durable.traces.get(attempt.attempt)?.usage).find((usage) => usage !== undefined) ?? null;
    const candidate: AgentVM = {
      id: durable.childId,
      attempt: latest.attempt,
      name,
      label,
      display: displayOf(name),
      phase: phaseNames.get(durable.childId) ?? "Agents",
      kind: "workflow",
      state,
      pending,
      skippedBy,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
      lastEventAt: traceNow?.lastEventAt ?? null,
      silenceMs,
      runningMs,
      durationMs: fact.durationMs,
      approx: traceNow?.approx ?? false,
      tokens,
      toolCalls: activity.get(durable.childId)?.toolCalls ?? null,
      attempts,
      failure,
      task: taskText !== null ? { text: taskText, source: "script" } : null,
      shareOfLongest: measure !== null && longestFinishedMs !== null && longestFinishedMs > 0 ? measure / longestFinishedMs : null,
      quiet: state === "no-update" ? { thresholdMs: thresholdMs as number, longestFinishedMs } : null,
      needs: null,
      runItemId: item.itemId,
      workflowRunId: runId,
    };
    const vm = cached && sameAgent(cached.vm, candidate) ? cached.vm : candidate;
    next.set(durable.childId, { vm, traces, signature });
    agents.push(vm);
  }
  cache.children = next;

  // Agents the script plans that Muse has not scheduled yet; once the run is over they never existed.
  const plannedKnown = plan !== null && plan.complete;
  if (plannedKnown && !ended) {
    const known = new Set(children.map((child) => child.label));
    for (const label of plan.labels) {
      if (known.has(label)) continue;
      known.add(label);
      const taskText = plan.inputs[label] ?? null;
      agents.push({
        id: `planned:${label}`,
        attempt: 0,
        name: label,
        label,
        display: displayOf(label),
        phase: prefixPhase(label) ?? "Agents",
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
        task: taskText !== null ? { text: taskText, source: "script" } : null,
        shareOfLongest: null,
        quiet: null,
        needs: null,
        runItemId: item.itemId,
        workflowRunId: runId,
      });
    }
  }

  const phases = phasesOf(agents);
  const counts = runCounts({ phases });
  const status = runStatusOf(item, children, counts);
  const startedAt = trace?.startedAt ?? null;
  const endedAt = ended ? trace?.endedAt ?? null : null;
  const elapsedMs = startedAt !== null ? Math.max(0, (endedAt ?? clock) - startedAt) : null;

  let tokenTotal = 0;
  let reported = 0;
  const usageSum: TokenUsage = {};
  let agentTimeMs: number | null = null;
  let retried = 0;
  for (const agent of agents) {
    if (agent.tokens) {
      reported += 1;
      tokenTotal += usageTotal(agent.tokens);
      for (const field of ["inputTokens", "outputTokens", "reasoningTokens", "cachedTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        const value = agent.tokens[field];
        if (value !== undefined) usageSum[field] = (usageSum[field] ?? 0) + value;
      }
    }
    if (agent.durationMs !== null) agentTimeMs = (agentTimeMs ?? 0) + agent.durationMs;
    if (agent.attempt > 1) retried += 1;
  }
  const usd = reported > 0 ? costEstimate(usageSum, ctx.model, ctx.models) : null;
  const policy = launch?.policy ?? null;
  const slotsMax = policy?.maxParallelAgents ?? policy?.childLimit ?? null;

  // Requests raised while the run is live that no agent can be named for; a task's own request stays with the task.
  const runNeeds: RunNeedVM[] = [];
  if (!ended) {
    const requests: { id: string; kind: RequestTrace["kind"]; request: ApprovalRequest | UserInputRequest }[] = [
      ...Object.values(fold.approvals).map((request) => ({ id: request.approvalId, kind: "approval" as const, request })),
      ...Object.values(fold.userInputs).map((request) => ({ id: request.userInputId, kind: "input" as const, request })),
    ];
    for (const { id, kind, request } of requests) {
      if (taskOfRequest(fold, request) !== null) continue;
      const askedAt = fold.crew?.requests[id]?.askedAt ?? null;
      runNeeds.push({ kind, command: requestCommand(fold, id, kind), askedAt, requestId: id, phase: askedAt !== null ? phaseAt(phases, askedAt) : null });
    }
  }

  let waitedOnYouMs: number | null = null;
  if (startedAt !== null && fold.crew) {
    for (const request of Object.values(fold.crew.requests)) {
      if (request.askedAt === null || request.askedAt < startedAt || (endedAt !== null && request.askedAt > endedAt)) continue;
      waitedOnYouMs = (waitedOnYouMs ?? 0) + Math.max(0, (request.decidedAt ?? (endedAt ?? clock)) - request.askedAt);
    }
  }

  const current = phases.find((phase) => phase.agents.some((agent) => LIVE_STATES.has(agent.state)))
    ?? phases.find((phase) => phase.agents.some((agent) => agent.state === "planned"))
    ?? null;
  const handoffs = Array.isArray((payload as Record<string, unknown> | null)?.["workspace_handoffs"])
    ? ((payload as Record<string, unknown>)["workspace_handoffs"] as unknown[]).map(record).filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({ agent: text(entry["agent"]) ?? "", description: text(entry["description"]) ?? "" })).filter((entry) => entry.agent || entry.description)
    : [];

  return {
    itemId: item.itemId,
    runId,
    name: text(item.entryId) ?? launch?.name ?? slugOf(text(item.scriptId)) ?? "Workflow",
    kind: "workflow",
    research: null,
    status,
    revision: item.revision,
    startedAt,
    endedAt,
    elapsedMs,
    elapsedApprox: trace?.approx ?? true,
    partialHistory: ctx.partialHistory || unnamed || (trace?.approx ?? false),
    phases,
    agents,
    counts,
    attention: attentionOrder(agents),
    runNeeds,
    currentPhase: current?.name ?? null,
    plannedKnown,
    tokens: reported > 0 ? { total: tokenTotal, reported, of: children.length } : null,
    cost: usd !== null && ctx.model ? { usd, model: ctx.model } : null,
    slots: slotsMax !== null ? { used: counts.working + counts.finishing + counts.noUpdate, max: slotsMax } : null,
    pulse: pulseBins(trace, clock),
    longestFinishedMs,
    agentTimeMs,
    peakConcurrency: peakOf(agents, clock),
    waitedOnYouMs,
    retried,
    report: ended ? { summary: text(payload?.final_summary?.summary), failure: failureText, handoffs } : null,
    stale: ctx.stale,
    staleAt: ctx.stale ? ctx.staleAt : null,
    clockAt: clock,
  };
}

/** `generated.workflow.offline-sync` reads as `offline-sync`. */
function slugOf(scriptId: string | null): string | null {
  if (!scriptId) return null;
  return scriptId.replace(/^generated\.(?:workflow\.)?/, "") || scriptId;
}

function numberFor(numbers: AgentNumbers, id: string): number {
  let value = numbers.get(id);
  if (value === undefined) {
    value = numbers.size + 1;
    numbers.set(id, value);
  }
  return value;
}

// ---------------------------------------------------------------- background tasks and subagents

function taskState(item: MspItem, silenceMs: number | null, needs: AgentVM["needs"]): AgentState {
  if (item.status === "inProgress") {
    if (needs) return "waiting-on-you";
    return silenceMs !== null && silenceMs >= TASK_NO_OUTPUT_MS ? "no-update" : "working";
  }
  if (text(item.failureKind) || text(item.failureReason)) return "failed";
  const outcome = outcomeOfTerminal(item.status);
  return outcome;
}

/** The pending request tied to an item, by the item's `approvalId` or the request's `itemId`. */
function needsOf(fold: ThreadFold, item: MspItem): AgentVM["needs"] {
  for (const request of Object.values(fold.approvals)) {
    if (request.itemId === item.itemId || (text(item.approvalId) !== null && request.approvalId === item.approvalId)) {
      return { kind: "approval", command: describeApproval(request).detail, askedAt: fold.crew?.requests[request.approvalId]?.askedAt ?? null, requestId: request.approvalId };
    }
  }
  for (const request of Object.values(fold.userInputs)) {
    if (request.itemId === item.itemId) {
      return { kind: "input", command: request.questions?.[0]?.question ?? null, askedAt: fold.crew?.requests[request.userInputId]?.askedAt ?? null, requestId: request.userInputId };
    }
  }
  return null;
}

function taskView(item: MspItem, trace: TaskTrace | undefined, ctx: RunContext): AgentVM {
  const { fold, clock } = ctx;
  const command = describeTool(item).subject ?? text(item.tool) ?? "task";
  const live = item.status === "inProgress";
  const startedAt = trace?.firstSeenAt ?? null;
  const endedAt = live ? null : trace?.endedAt ?? null;
  const lastOutputAt = trace?.lastOutputAt ?? null;
  const since = lastOutputAt ?? startedAt;
  const silenceMs = live && since !== null ? Math.max(0, clock - since) : null;
  const needs = live ? needsOf(fold, item) : null;
  const state = taskState(item, ctx.stale ? null : silenceMs, needs);
  const key = ctx.sessionId ? pendingKey(ctx.sessionId, item.itemId, 1) : null;
  const pendingFlag = key ? ctx.pending[key] ?? null : null;
  const initiator = item.backgroundInitiator === "user" || item.backgroundInitiator === "timeout" ? item.backgroundInitiator : null;
  return {
    id: item.itemId,
    attempt: 1,
    name: command,
    label: command,
    display: { prefix: null, short: command },
    phase: "Background",
    kind: "task",
    state,
    pending: live && pendingFlag === "stop" ? "stop" : null,
    skippedBy: state === "skipped" ? (key && ctx.skipped.has(key) ? "you" : "muse") : null,
    startedAt,
    endedAt,
    lastEventAt: lastOutputAt ?? startedAt,
    silenceMs,
    runningMs: live && startedAt !== null ? Math.max(0, clock - startedAt) : null,
    durationMs: !live && startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
    approx: trace?.approx ?? true,
    tokens: null,
    toolCalls: null,
    attempts: [],
    failure: state === "failed" ? { text: text(item.failureReason) ?? text(item.failureKind), at: endedAt } : null,
    task: null,
    shareOfLongest: null,
    quiet: state === "no-update" ? { thresholdMs: TASK_NO_OUTPUT_MS, longestFinishedMs: null } : null,
    needs,
    runItemId: null,
    workflowRunId: null,
    taskInfo: { command, tail: lastLine(item.visibleOutput), lastOutputAt, initiator, approvalId: text(item.approvalId) },
  };
}

function subagentState(item: MspItem): AgentState {
  if (item.status !== "inProgress") {
    if (text(item.failureKind) || text(item.failureReason)) return "failed";
    return outcomeOfTerminal(item.status);
  }
  switch (normalizedWord(item.controlStatus)) {
    case "awaitinginput": case "awaitingapproval":
      return "waiting-on-you";
    case "resultready": case "closing": case "closed":
      return "done";
    case "accepted": case "starting":
      return "scheduled";
    default:
      return "working";
  }
}

function subagentView(item: MspItem, ctx: RunContext): AgentVM {
  const id = text(item.subagentId) ?? text(item["childId"]) ?? text(item.childSessionId) ?? `item:${item.itemId}`;
  const label = text(item.role) ?? text(item["name"]) ?? text(item["title"]);
  const name = label ?? `Agent ${numberFor(ctx.numbers, id)}`;
  const state = subagentState(item);
  const live = LIVE_STATES.has(state);
  const recorded = item.recordedAt ? Date.parse(item.recordedAt) : NaN;
  const at = Number.isFinite(recorded) ? recorded : null;
  const key = ctx.sessionId ? pendingKey(ctx.sessionId, id, 1) : null;
  const pendingFlag = key ? ctx.pending[key] ?? null : null;
  const objective = text(item.objective);
  return {
    id,
    attempt: 1,
    name,
    label,
    display: displayOf(name),
    phase: "Subagents",
    kind: "subagent",
    state,
    pending: live && pendingFlag === "stop" ? "stop" : null,
    skippedBy: state === "skipped" ? (key && ctx.skipped.has(key) ? "you" : "muse") : null,
    startedAt: null,
    endedAt: live ? null : at,
    lastEventAt: at,
    silenceMs: null,
    runningMs: null,
    durationMs: num(item.durationMs),
    approx: true,
    tokens: item.usage ?? null,
    toolCalls: num(item["toolCalls"]),
    attempts: [],
    failure: state === "failed" ? { text: text(item.failureReason) ?? text(item.result?.errorKind), at } : null,
    task: objective ? { text: objective, source: "objective" } : null,
    shareOfLongest: null,
    quiet: null,
    needs: state === "waiting-on-you" ? { kind: "input", command: null, askedAt: null, requestId: item.itemId } : null,
    runItemId: null,
    workflowRunId: text(item.workflowRunId),
  };
}

const nativeWaitIndexes = new WeakMap<Record<string, MspItem>, { order: readonly string[]; waits: ReadonlyMap<string, MspItem> }>();

/** Match each child once, using transcript order even when a wait's tool metadata arrived late. */
function nativeWaits(fold: ThreadFold, ids: readonly string[]): ReadonlyMap<string, MspItem> {
  const items = fold.agentItems ?? fold.items;
  const cached = nativeWaitIndexes.get(items);
  if (cached?.order === fold.order) return cached.waits;
  const waits = new Map<string, MspItem>();
  if (ids.length > 0) {
    const positions = transcriptPositions(fold.order);
    for (const id of ids) {
      const item = items[id];
      if (!item || item.status === "inProgress") continue;
      const childId = text(parseArgs(item.args)?.["subagent_id"]);
      if (!childId) continue;
      const previous = waits.get(childId);
      if (!previous || (positions.get(id) ?? -1) > (positions.get(previous.itemId) ?? -1)) waits.set(childId, item);
    }
  }
  nativeWaitIndexes.set(items, { order: fold.order, waits });
  return waits;
}

/** A wait tool finishing is not the child finishing: only its reported result settles the child. */
function nativeSubagent(spawn: MspItem, waits: ReadonlyMap<string, MspItem>): { id: string; state: AgentState; settled: MspItem | null; result: Record<string, unknown> | null } {
  const output = parseArgs(spawn.visibleOutput);
  const id = text(output?.["subagent_id"]) ?? `spawn:${spawn.itemId}`;
  const admission = outcomeOfTerminal(spawn.status);
  if (spawn.status !== "inProgress" && (admission === "skipped" || admission === "failed" || text(spawn.failureKind) || text(spawn.failureReason))) {
    return { id, state: admission === "skipped" ? "skipped" : "failed", settled: spawn, result: output };
  }
  const wait = waits.get(id);
  const waitOutput = wait ? parseArgs(wait.visibleOutput) : null;
  const word = normalizedWord(text(waitOutput?.["status"]) ?? undefined);
  const state: AgentState = !wait ? "working"
    : ["ready", "completed", "complete", "done", "success", "succeeded", "resultready"].includes(word) ? "done"
    : ["failed", "error", "rejected"].includes(word) ? "failed"
    : ["cancelled", "canceled", "stopped"].includes(word) ? "skipped"
    : "working";
  return { id, state, settled: state === "working" ? null : wait ?? null, result: waitOutput };
}

/** A native subagent Muse surfaced as a `subagent_spawn` tool call, with its `subagent_wait` when one landed. */
function spawnView(spawn: MspItem, waits: ReadonlyMap<string, MspItem>, ctx: RunContext): AgentVM {
  const args = parseArgs(spawn.args);
  const { id, state, settled, result } = nativeSubagent(spawn, waits);
  const label = text(args?.["task_name"]) ?? text(args?.["role"]);
  const name = label ?? `Agent ${numberFor(ctx.numbers, id)}`;
  const startedRaw = spawn.recordedAt ? Date.parse(spawn.recordedAt) : NaN;
  const endedRaw = settled?.recordedAt ? Date.parse(settled.recordedAt) : NaN;
  const startedAt = Number.isFinite(startedRaw) ? startedRaw : null;
  const endedAt = state === "working" ? null : Number.isFinite(endedRaw) ? endedRaw : null;
  const objective = text(args?.["objective"]);
  const key = ctx.sessionId ? pendingKey(ctx.sessionId, id, 1) : null;
  return {
    id,
    attempt: 1,
    name,
    label,
    display: displayOf(name),
    phase: "Subagents",
    kind: "subagent",
    state,
    pending: state === "working" && key && ctx.pending[key] === "stop" ? "stop" : null,
    skippedBy: state === "skipped" ? (key && ctx.skipped.has(key) ? "you" : "muse") : null,
    startedAt,
    endedAt,
    lastEventAt: endedAt ?? startedAt,
    silenceMs: null,
    runningMs: state === "working" && startedAt !== null ? Math.max(0, ctx.clock - startedAt) : null,
    durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
    approx: true,
    tokens: null,
    toolCalls: null,
    attempts: [],
    failure: state === "failed" ? { text: text(settled?.failureReason) ?? text(settled?.failureKind) ?? text(result?.["summary"]), at: endedAt } : null,
    task: objective ? { text: objective, source: "objective" } : null,
    shareOfLongest: null,
    quiet: null,
    needs: null,
    runItemId: null,
    workflowRunId: null,
  };
}

// ---------------------------------------------------------------- research runs

/** An ISO time as epoch milliseconds, or null when the wire sent none or something unreadable. */
function isoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The daemon's worker word as the row's state: a timed-out worker failed, a cancelled one was skipped. */
function researchWorkerState(state: ResearchWorkerState): AgentState {
  switch (state) {
    case "queued": return "scheduled";
    case "working": return "working";
    case "completed": return "done";
    case "failed": case "timed_out": return "failed";
    case "cancelled": return "skipped";
  }
}

/**
 * The run's status as the card says it. A queued run, or one still scoping with no worker out, is starting; a
 * partial report is a finish with failures, since the run ended short of what it planned; a cancelled or
 * interrupted run was stopped, by the user or by the daemon going down under it.
 */
function researchRunStatus(run: ResearchRunView): RunStatus {
  switch (run.status) {
    case "queued": return "starting";
    case "running": return run.workers.length === 0 ? "starting" : "running";
    case "completed": return "finished";
    case "partial": return "finished-with-failures";
    case "failed": return "failed";
    case "cancelled": case "interrupted": return "stopped";
  }
}

/** `Round 2 of 12`: the phase a worker's round names, and the header the rail and the roster show for it. */
function researchPhaseName(round: number, maxRounds: number): string {
  return maxRounds > 0 ? `Round ${round} of ${maxRounds}` : `Round ${round}`;
}

/** The run's usage as the token shape the pricing path takes; the daemon counts cached input apart. */
function researchUsage(run: ResearchRunView): TokenUsage | null {
  if (run.usage.totalTokens <= 0) return null;
  return { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, cachedTokens: run.usage.cachedInputTokens };
}

/** The lifecycle of a worker as one attempt, so the Timeline and the fingerprint draw it like any other lane. */
function researchAttempt(worker: ResearchWorkerView, state: AgentState, startedAt: number | null, endedAt: number | null, durationMs: number | null): AttemptVM {
  const events: AttemptEventVM[] = [{ kind: "scheduled", at: null, detail: null }];
  if (state !== "scheduled") events.push({ kind: "started", at: startedAt, detail: null });
  const outcome: AttemptVM["outcome"] = state === "done" ? "done" : state === "failed" ? "failed" : state === "skipped" ? "skipped" : null;
  if (outcome !== null) {
    const after = durationMs !== null ? `after ${durationText(durationMs)}` : null;
    events.push({ kind: outcome === "done" ? "completed" : outcome === "failed" ? "failed" : "cancelled", at: endedAt, detail: worker.state === "timed_out" ? "timed out" : after });
  }
  return { attempt: 1, events, startedAt, endedAt, outcome };
}

/**
 * A DeepResearch run as a run of the Crew surfaces. The daemon sends the run whole on every change, workers and
 * counters included, so every field here is read straight off it: the rounds are the phases, a worker is an
 * agent, and the run's own usage stands for the tokens, since workers do not report theirs. Nothing about a
 * research run waits on the user, and its workers take no control of their own: the supervisor runs them.
 */
function researchRunView(run: ResearchRunView, ctx: RunContext): RunVM {
  const { clock } = ctx;
  const itemId = researchItemId(run.runId);
  const ended = researchEnded(run);
  const startedAt = isoMs(run.startedAt) ?? isoMs(run.createdAt);
  const endedAt = ended ? isoMs(run.endedAt) : null;
  const workerModel = run.config.models.worker ?? run.config.models.supervisor ?? run.config.models.writer ?? null;

  // Rounds in order, and within a round the daemon's numbering, so the phases read in the order they ran.
  const workers = [...run.workers].sort((a, b) => a.round - b.round || a.agentId - b.agentId);
  interface Fact { worker: ResearchWorkerView; state: AgentState; startedAt: number | null; endedAt: number | null; durationMs: number | null }
  const facts: Fact[] = [];
  let longestFinishedMs: number | null = null;
  const eventMinutes: number[] = [];
  for (const worker of workers) {
    const state = researchWorkerState(worker.state);
    const live = LIVE_STATES.has(state);
    const workerStart = state === "scheduled" ? null : isoMs(worker.startedAt);
    const workerEnd = live ? null : isoMs(worker.endedAt);
    const durationMs = workerStart !== null && workerEnd !== null ? Math.max(0, workerEnd - workerStart) : null;
    if (state === "done" && durationMs !== null && (longestFinishedMs === null || durationMs > longestFinishedMs)) longestFinishedMs = durationMs;
    if (workerStart !== null) eventMinutes.push(Math.floor(workerStart / 60_000));
    if (workerEnd !== null) eventMinutes.push(Math.floor(workerEnd / 60_000));
    facts.push({ worker, state, startedAt: workerStart, endedAt: workerEnd, durationMs });
  }
  eventMinutes.sort((a, b) => a - b);

  const cache = runCacheFor(`${ctx.sessionId ?? ""}:${itemId}`);
  const next = new Map<string, ChildCacheEntry>();
  const agents: AgentVM[] = [];
  for (const fact of facts) {
    const { worker, state } = fact;
    const id = researchAgentId(run.runId, worker.agentId);
    const name = `A${worker.agentId} · ${worker.topic}`;
    const live = LIVE_STATES.has(state);
    const runningMs = live && fact.startedAt !== null ? Math.max(0, clock - fact.startedAt) : null;
    const measure = fact.durationMs ?? runningMs;
    const signature = `${worker.state}|${fact.startedAt ?? ""}|${fact.endedAt ?? ""}`;
    const cached = cache.children.get(id);
    const attempts = cached && cached.signature === signature ? cached.vm.attempts : [researchAttempt(worker, state, fact.startedAt, fact.endedAt, fact.durationMs)];
    const candidate: AgentVM = {
      id,
      attempt: 1,
      name,
      label: name,
      // A topic may hold a colon of its own, so the name is never split into a prefix.
      display: { prefix: null, short: name },
      phase: researchPhaseName(worker.round, run.maxRounds),
      kind: "research",
      state,
      pending: null,
      // A worker is only ever cancelled by its run: a stop, or the window closing under it.
      skippedBy: state === "skipped" ? "run" : null,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
      lastEventAt: fact.endedAt ?? fact.startedAt,
      silenceMs: null,
      runningMs,
      durationMs: fact.durationMs,
      approx: false,
      tokens: null,
      toolCalls: worker.toolCalls,
      attempts,
      failure: state === "failed"
        ? { text: worker.state === "timed_out" ? `Timed out after ${plural(run.config.workerWallTimeMinutes, "minute")}` : null, at: fact.endedAt }
        : null,
      task: { text: worker.topic, source: "objective" },
      shareOfLongest: measure !== null && longestFinishedMs !== null && longestFinishedMs > 0 ? measure / longestFinishedMs : null,
      quiet: null,
      needs: null,
      runItemId: itemId,
      workflowRunId: null,
      research: { agentId: worker.agentId, round: worker.round, searches: worker.searches, reads: worker.reads, saved: worker.saved, discovery: worker.discovery, model: workerModel, wireState: worker.state },
    };
    const vm = cached && sameAgent(cached.vm, candidate) ? cached.vm : candidate;
    next.set(id, { vm, traces: [], signature });
    agents.push(vm);
  }
  cache.children = next;

  const phases = phasesOf(agents);
  const counts = runCounts({ phases });
  const status = researchRunStatus(run);
  const elapsedMs = startedAt !== null ? Math.max(0, (endedAt ?? clock) - startedAt) : null;
  const usage = researchUsage(run);
  const usd = usage && workerModel ? costEstimate(usage, workerModel, ctx.models) : null;
  let agentTimeMs: number | null = null;
  for (const agent of agents) {
    if (agent.durationMs !== null) agentTimeMs = (agentTimeMs ?? 0) + agent.durationMs;
  }
  const current = phases.find((phase) => phase.agents.some((agent) => LIVE_STATES.has(agent.state))) ?? null;
  const sources = sourcesLine(run.sources);
  const summary = ended
    ? [sources ?? "No sources were saved", run.reportAvailable ? "The report is in the transcript." : "No report was written."].join("\n")
    : null;

  return {
    itemId,
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
      deadlineAt: ended ? null : isoMs(run.researchDeadlineAt),
      reportAvailable: run.reportAvailable,
    },
    status,
    revision: 0,
    startedAt,
    endedAt,
    elapsedMs,
    elapsedApprox: false,
    partialHistory: false,
    phases,
    agents,
    counts,
    attention: attentionOrder(agents),
    runNeeds: [],
    currentPhase: current?.name ?? null,
    // The daemon plans rounds as it goes, so no total is ever known ahead.
    plannedKnown: false,
    // The usage is the run's own; workers report none, so nothing is "reported" by an agent.
    tokens: usage ? { total: run.usage.totalTokens, reported: 0, of: workers.length } : null,
    cost: usd !== null && workerModel ? { usd, model: workerModel } : null,
    slots: run.config.maxParallel > 0 ? { used: counts.working + counts.finishing + counts.noUpdate, max: run.config.maxParallel } : null,
    pulse: binsOf(eventMinutes, clock),
    longestFinishedMs,
    agentTimeMs,
    peakConcurrency: peakOf(agents, clock),
    waitedOnYouMs: null,
    retried: 0,
    report: ended ? { summary, failure: run.failure, handoffs: [] } : null,
    stale: ctx.stale,
    staleAt: ctx.stale ? ctx.staleAt : null,
    clockAt: clock,
  };
}

// ---------------------------------------------------------------- the view

function lastKnownAt(fold: ThreadFold): number | null {
  let last: number | null = null;
  const crew = fold.crew;
  if (!crew) return null;
  for (const run of Object.values(crew.runs)) {
    for (const at of [run.startedAt, run.endedAt]) {
      if (at !== null && (last === null || at > last)) last = at;
    }
    for (const child of Object.values(run.children)) {
      if (child.lastEventAt !== null && (last === null || child.lastEventAt > last)) last = child.lastEventAt;
    }
  }
  for (const task of Object.values(crew.tasks)) {
    for (const at of [task.firstSeenAt, task.lastOutputAt, task.endedAt]) {
      if (at !== null && (last === null || at > last)) last = at;
    }
  }
  return last;
}

/**
 * Everything the agents surfaces show for one thread. `now` is read once; when the feed is stale every clock
 * freezes at `staleAt` (or the last event seen), nothing is promoted to no-update, and the rows say last known.
 */
export function crewView(fold: ThreadFold, session: SessionSummary | null, now: number, opts: CrewOptions = {}): CrewVM {
  const sessionId = session?.sessionId ?? null;
  const stale = opts.stale === true;
  const staleAt = stale ? opts.staleAt ?? lastKnownAt(fold) : null;
  const ctx: RunContext = {
    fold,
    sessionId,
    now,
    clock: stale ? staleAt ?? now : now,
    stale,
    staleAt,
    partialHistory: opts.partialHistory === true,
    pending: opts.pending ?? {},
    skipped: new Set(opts.skipped ?? []),
    model: opts.sessionModel ?? fold.meta.modelId ?? session?.modelId ?? null,
    models: opts.models ?? [],
    numbers: opts.numbers ?? (sessionId ? agentNumbers(sessionId) : new Map()),
  };
  const runs: RunVM[] = [];
  const subagents: AgentVM[] = [];
  const items = Object.values(fold.agentItems ?? fold.items);
  for (const item of items) {
    if (item.kind === "workflow") {
      runs.push(runView(item, ctx));
    } else if (item.kind === "subagent") {
      subagents.push(subagentView(item, ctx));
    }
  }
  for (const run of opts.researchRuns ?? []) {
    runs.push(researchRunView(run, ctx));
  }
  runs.sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) || a.itemId.localeCompare(b.itemId));
  const index = threadIndex(fold);
  const waits = nativeWaits(fold, index.waits);
  for (const id of index.spawns) {
    const spawn = fold.items[id];
    if (spawn) subagents.push(spawnView(spawn, waits, ctx));
  }
  const tasks: AgentVM[] = [];
  for (const [id, trace] of Object.entries(fold.crew?.tasks ?? {})) {
    const item = fold.items[id];
    if (item?.kind === "toolCall" && item.background === true) tasks.push(taskView(item, trace, ctx));
  }
  tasks.sort((a, b) => Number(LIVE_STATES.has(b.state)) - Number(LIVE_STATES.has(a.state)) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return { runs, tasks, subagents };
}

/** Whether a run is still going. */
export function runLive(run: Pick<RunVM, "status">): boolean {
  return run.status === "starting" || run.status === "running";
}

/**
 * Whether anything in the thread's agents may still be working, without building the view: a live run with an
 * attempt not yet settled, an open subagent, a background task still running, or a research run still out.
 */
export function crewBusy(fold: ThreadFold, researchRuns?: readonly ResearchRunView[]): boolean {
  if (researchRuns?.some(researchLive)) return true;
  for (const item of Object.values(fold.agentItems ?? fold.items)) {
    if (item.kind === "workflow") {
      if (item.status === "inProgress" && Array.isArray(item.children) && item.children.some((child) => child && childOutcome(child) === null)) return true;
    } else if (item.kind === "subagent" && item.status === "inProgress") {
      return true;
    }
  }
  for (const [id, task] of Object.entries(fold.crew?.tasks ?? {})) {
    const item = fold.items[id];
    if (task.endedAt === null && item?.background === true && item.status === "inProgress") return true;
  }
  const index = threadIndex(fold);
  const waits = nativeWaits(fold, index.waits);
  for (const id of index.spawns) {
    const spawn = fold.items[id];
    if (spawn && LIVE_STATES.has(nativeSubagent(spawn, waits).state)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the collapsed line

/** The collapsed line's words: progress, at most two chips, and the elapsed time. */
export function summaryLine(run: RunVM): { progress: string; chips: SummaryChip[]; elapsed: string } {
  const { counts } = run;
  const total = counts.total;
  const chips: SummaryChip[] = [];
  const needs = run.runNeeds.length + counts.waiting;
  let progress: string;
  switch (run.status) {
    case "starting":
      progress = "Starting · no agents scheduled yet";
      break;
    case "running":
      if (run.research) {
        // A research run plans its rounds as it goes, so the line leads with the phase the daemon reports.
        progress = `${phaseLine(run.research)} · ${counts.done} done · ${counts.working + counts.finishing + counts.noUpdate} working`;
      } else if (run.plannedKnown) {
        progress = `${run.currentPhase ?? "Finishing"} · ${counts.done} of ${total}`;
      } else {
        progress = `${counts.done} done · ${counts.working + counts.finishing + counts.noUpdate} working · more may start`;
      }
      break;
    case "finished":
      progress = `Done · ${counts.done} of ${total}`;
      break;
    case "finished-with-failures":
      progress = `Finished · ${counts.done} of ${total}`;
      break;
    case "stopped":
      progress = `Stopped · ${counts.done} of ${total} had landed`;
      break;
    case "failed":
      progress = `Failed · ${counts.done} of ${total} had landed`;
      break;
  }
  if (run.stale) {
    chips.push({ kind: "stale", count: 1, text: "Last known" });
  } else if (runLive(run)) {
    if (needs > 0) chips.push({ kind: "needs", count: needs, text: `${needs} ${needs === 1 ? "needs" : "need"} you` });
    if (counts.failed > 0) chips.push({ kind: "failed", count: counts.failed, text: `${counts.failed} failed` });
    if (chips.length === 0 && counts.noUpdate > 0) chips.push({ kind: "no-update", count: counts.noUpdate, text: `${counts.noUpdate} no update` });
  } else {
    if (run.status === "failed") chips.push({ kind: "run-failed", count: 1, text: "run failed" });
    if (counts.failed > 0) chips.push({ kind: "failed", count: counts.failed, text: `${counts.failed} failed` });
    if (counts.skipped > 0 && chips.length < 2) chips.push({ kind: "skipped", count: counts.skipped, text: `${counts.skipped} skipped` });
  }
  let elapsed = "";
  if (run.elapsedMs !== null) {
    if (run.stale) {
      elapsed = run.staleAt !== null ? `${durationText(run.elapsedMs)} · at ${formatClock(run.staleAt, run.clockAt)}` : durationText(run.elapsedMs);
    } else if (run.elapsedApprox && runLive(run)) {
      elapsed = aboutText(run.elapsedMs);
    } else {
      elapsed = durationText(run.elapsedMs);
    }
  }
  return { progress, chips: chips.slice(0, 2), elapsed };
}

// ---------------------------------------------------------------- completion

function shortDuration(ms: number | null): string {
  if (ms === null) return "a while";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "All ten landed." and its variants, from the counts of the agents that were scheduled. */
export function headline(counts: Counts, status: RunStatus, elapsedMs: number | null): string {
  const total = counts.total - counts.planned;
  const landed = counts.done;
  const had = `${numberWord(landed)} of ${numberWord(total)} had landed.`;
  if (status === "stopped") return `Stopped by you after ${shortDuration(elapsedMs)}; ${had}`;
  if (status === "failed") return `The run failed after ${shortDuration(elapsedMs)}; ${had}`;
  if (total === 0) return "Nothing was scheduled.";
  if (landed === total) return total === 1 ? "The agent landed." : `All ${numberWord(total)} landed.`;
  const parts = [`${capitalize(numberWord(landed))} of ${numberWord(total)} landed`];
  if (counts.skipped > 0) parts.push(`${numberWord(counts.skipped)} skipped`);
  if (counts.failed > 0) parts.push(`${numberWord(counts.failed)} failed`);
  if (counts.unknown > 0) parts.push(`${numberWord(counts.unknown)} not reported`);
  return `${parts.join(", ")}.`;
}

function factLine(run: RunVM): string {
  const facts: string[] = [];
  const skipped = run.agents.filter((agent) => agent.state === "skipped");
  const failed = run.agents.filter((agent) => agent.state === "failed");
  const unknown = run.agents.filter((agent) => agent.state === "unknown");
  const attemptsOf = (agent: AgentVM) => `after ${plural(agent.attempt - (agent.state === "skipped" ? 1 : 0), "failed attempt")}`;
  if (run.research && run.report?.failure) {
    // The daemon says why a research run ended short, whatever the status; a partial report carries it too.
    facts.push(run.report.failure);
  } else if (run.status === "stopped") {
    facts.push(unknown.length > 0 ? `${plural(unknown.length, "agent was", "agents were")} still working` : "Nothing was still working");
  } else if (run.status === "failed") {
    facts.push(run.report?.failure ?? "Muse has not reported a reason");
  } else if (run.research && run.status === "finished-with-failures") {
    facts.push("The run ended before every round was done");
  } else if (skipped.length === 0 && failed.length === 0 && unknown.length === 0) {
    facts.push(run.research ? "Every round reached its end" : "Every phase reached its end");
  }
  for (const agent of skipped) {
    facts.push(`${agent.name} was ${agent.skippedBy === "you" ? "skipped by you" : agent.skippedBy === "run" ? "stopped with the run" : "cancelled by Muse"}${agent.attempt > 1 ? ` ${attemptsOf(agent)}` : ""}`);
  }
  for (const agent of failed) {
    facts.push(`${agent.name} failed after ${plural(agent.attempt, "attempt")}`);
  }
  if (unknown.length > 0 && run.status !== "stopped") {
    facts.push(`Muse did not report an outcome for ${plural(unknown.length, "agent")}`);
  }
  const retried = run.agents.filter((agent) => agent.attempt > 1 && agent.state === "done");
  if (retried.length > 0) {
    const most = Math.max(...retried.map((agent) => agent.attempt));
    facts.push(`${plural(retried.length, "agent")} needed ${most} attempts`);
  }
  return facts.join(" · ");
}

function firstLines(summary: string | null, lines = 4, chars = 480): string | null {
  if (!summary) return null;
  const kept = summary.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(0, lines).join("\n");
  return kept.length > chars ? `${kept.slice(0, chars).trimEnd()}…` : kept || null;
}

interface Candidate {
  priority: number;
  order: number;
  highlight: HighlightVM;
}

/** At most four highlights, chosen by priority, shown with what did not land first. */
function highlightsOf(run: RunVM): HighlightVM[] {
  const candidates: Candidate[] = [];
  const notLanded = (agents: AgentVM[], icon: string, what: string, aside: (agent: AgentVM) => string | null) => {
    if (agents.length === 0) return;
    const one = agents.length === 1 ? (agents[0] as AgentVM) : null;
    const strong = one ? one.name : `${agents.length} agents`;
    candidates.push({ priority: 1, order: 0, highlight: { icon, text: one ? `1 agent ${what} ${one.name}` : `${agents.length} agents ${what}`, strong, aside: one ? aside(one) : null } });
  };
  notLanded(run.agents.filter((agent) => agent.state === "skipped"), "MinusCircle", "skipped", (agent) => agent.skippedBy === "you" && agent.attempt > 1 ? `after ${plural(agent.attempt - 1, "failed attempt")}` : agent.skippedBy === "run" ? "stopped with the run" : null);
  notLanded(run.agents.filter((agent) => agent.state === "failed"), "WarningCircle", "failed", (agent) => `after ${plural(agent.attempt, "attempt")}`);
  notLanded(run.agents.filter((agent) => agent.state === "unknown"), "Question", "without a reported outcome", () => null);
  const retried = run.agents.filter((agent) => agent.attempt > 1 && agent.state === "done");
  if (retried.length > 0) {
    const most = retried.reduce((best, agent) => (agent.attempt > best.attempt ? agent : best));
    candidates.push({ priority: 1, order: 3, highlight: { icon: "ArrowCounterClockwise", text: `Retried ${most.name} · landed on attempt ${most.attempt}`, strong: most.name, aside: `after ${plural(most.attempt - 1, "failed attempt")}` } });
  }
  const timed = run.agents.filter((agent) => agent.durationMs !== null);
  if (timed.length > 0) {
    const longest = timed.reduce((best, agent) => ((agent.durationMs as number) > (best.durationMs as number) ? agent : best));
    candidates.push({ priority: 2, order: 1, highlight: { icon: "Timer", text: `Longest agent ${longest.name} · ${durationText(longest.durationMs)}`, strong: longest.name, aside: null } });
  }
  const withTokens = run.agents.filter((agent) => agent.tokens !== null && usageTotal(agent.tokens) > 0);
  if (withTokens.length > 0 && run.tokens) {
    const most = withTokens.reduce((best, agent) => (usageTotal(agent.tokens) > usageTotal(best.tokens) ? agent : best));
    const share = run.tokens.total > 0 ? Math.round((usageTotal(most.tokens) / run.tokens.total) * 100) : null;
    candidates.push({ priority: 3, order: 2, highlight: { icon: "Database", text: `Most tokens ${most.name} · ${formatTokens(usageTotal(most.tokens))}`, strong: most.name, aside: share !== null ? `${share}% of the run` : null } });
  } else {
    const withCalls = run.agents.filter((agent) => agent.toolCalls !== null);
    if (withCalls.length > 0) {
      const most = withCalls.reduce((best, agent) => ((agent.toolCalls as number) > (best.toolCalls as number) ? agent : best));
      candidates.push({ priority: 3, order: 2, highlight: { icon: "Wrench", text: `Most tool calls ${most.name} · ${most.toolCalls}`, strong: most.name, aside: null } });
    }
  }
  if (run.waitedOnYouMs !== null && run.waitedOnYouMs > 0) {
    candidates.push({ priority: 4, order: 4, highlight: { icon: "ShieldWarning", text: `Waited on you ${durationText(run.waitedOnYouMs)}`, strong: durationText(run.waitedOnYouMs), aside: null } });
  } else if (run.peakConcurrency && run.peakConcurrency.n > 1) {
    candidates.push({ priority: 4, order: 4, highlight: { icon: "UsersThree", text: `Peak concurrency ${plural(run.peakConcurrency.n, "agent")}`, strong: `${run.peakConcurrency.n} agents`, aside: `during ${run.peakConcurrency.phase}` } });
  }
  const chosen = [...candidates].sort((a, b) => a.priority - b.priority || a.order - b.order).slice(0, 4);
  return chosen.sort((a, b) => a.order - b.order || a.priority - b.priority).map((candidate) => candidate.highlight);
}

function fingerprintOf(run: RunVM): FingerprintVM {
  const start = run.startedAt;
  const end = run.endedAt ?? run.clockAt;
  if (start === null) {
    return { totalMs: 0, phases: [], lanes: [], partial: true };
  }
  let partial = false;
  const lanes: FingerprintLaneVM[] = [];
  for (const agent of run.agents) {
    if (agent.state === "planned") continue;
    const spans: FingerprintLaneVM["spans"] = [];
    const last = agent.attempts.length - 1;
    agent.attempts.forEach((attempt, index) => {
      if (attempt.startedAt === null) {
        partial = true;
        return;
      }
      const to = attempt.endedAt ?? (attempt.outcome === null ? end : null);
      if (to === null) {
        partial = true;
        return;
      }
      spans.push({
        startMs: Math.max(0, attempt.startedAt - start),
        endMs: Math.max(0, to - start),
        failed: index < last || attempt.outcome === "failed" || attempt.outcome === "skipped",
      });
    });
    if (spans.length === 0) partial = true;
    lanes.push({ id: agent.id, name: agent.name, phase: agent.phase, state: agent.state, spans });
  }
  return {
    totalMs: Math.max(0, end - start),
    phases: run.phases.filter((phase) => phase.state !== "planned").map((phase) => ({
      name: phase.name,
      startMs: phase.startedAt !== null ? Math.max(0, phase.startedAt - start) : null,
      endMs: phase.endedAt !== null ? Math.max(0, phase.endedAt - start) : null,
    })),
    lanes,
    partial: partial || run.partialHistory,
  };
}

/** The report card for a run that has ended; null while it runs. */
export function completionView(run: RunVM): CompletionVM | null {
  if (runLive(run)) return null;
  const scheduled = run.counts.total - run.counts.planned;
  const stats: StatVM[] = [
    { value: String(scheduled), label: scheduled === 1 ? "agent" : "agents" },
    { value: run.elapsedApprox ? aboutText(run.elapsedMs ?? 0) : durationText(run.elapsedMs), label: "wall clock" },
    run.tokens ? { value: formatTokens(run.tokens.total), label: run.research ? "tokens, the run's own count" : "tokens, reported by Muse" } : { value: "—", label: "tokens not reported" },
  ];
  if (run.cost) stats.push({ value: `~${formatCost(run.cost.usd)}`, label: "estimate at list price" });
  return {
    headline: headline(run.counts, run.status, run.elapsedMs),
    factLine: factLine(run),
    stats,
    highlights: highlightsOf(run),
    fingerprint: fingerprintOf(run),
    excerpt: firstLines(run.report?.summary ?? null),
    sheen: run.status === "finished" && scheduled > 0 && run.counts.done === scheduled,
  };
}

/** What changed since the user left, once they were away five minutes and something moved; else null. */
export function sinceYouLeft(run: RunVM, leftAt: number, now: number): SinceYouLeftVM | null {
  if (now - leftAt < SINCE_LEFT_MIN_MS) return null;
  let finished = 0;
  let failed = 0;
  for (const agent of run.agents) {
    if (agent.endedAt === null || agent.endedAt <= leftAt) continue;
    if (agent.state === "done") finished += 1;
    else if (agent.state === "failed") failed += 1;
  }
  const phasesStarted = run.phases.filter((phase) => phase.startedAt !== null && phase.startedAt > leftAt).map((phase) => phase.name);
  const runFinishedAt = run.endedAt !== null && run.endedAt > leftAt ? run.endedAt : null;
  if (finished + failed + phasesStarted.length === 0 && runFinishedAt === null) return null;
  return { leftAt, finished, failed, phasesStarted, runFinishedAt };
}

// ---------------------------------------------------------------- announcements

/** Only what the live region may say: a request, a failure, a phase or run ending, a stale feed, a task failing. */
export function announcements(prev: CrewVM | null, next: CrewVM): string[] {
  if (!prev) return [];
  const out: string[] = [];
  let request = false;
  const prevRuns = new Map(prev.runs.map((run) => [run.itemId, run]));
  for (const run of next.runs) {
    const before = prevRuns.get(run.itemId);
    const seen = new Set(before?.runNeeds.map((need) => need.requestId) ?? []);
    if (run.runNeeds.some((need) => !seen.has(need.requestId))) request = true;
    const beforeAgents = new Map(before?.agents.map((agent) => [agent.id, agent]) ?? []);
    for (const agent of run.agents) {
      const was = beforeAgents.get(agent.id);
      if (agent.state === "waiting-on-you" && was?.state !== "waiting-on-you") request = true;
      if (agent.state === "failed" && (was?.state !== "failed" || was.attempt !== agent.attempt)) {
        out.push(`${agent.name} failed, attempt ${agent.attempt} of ${agent.attempt}.`);
      }
    }
    const beforePhases = new Map(before?.phases.map((phase) => [phase.name, phase]) ?? []);
    for (const phase of run.phases) {
      const was = beforePhases.get(phase.name);
      if (phase.state !== "live" && phase.state !== "planned" && was && (was.state === "live" || was.state === "planned")) {
        out.push(`${phase.name} phase finished, ${phase.counts.done} of ${phase.counts.total}.`);
      }
    }
    if (before && runLive(before) && !runLive(run)) {
      out.push(headline(run.counts, run.status, run.elapsedMs));
    }
    if (before && !before.stale && run.stale) {
      out.push("Connection stale; showing last known state.");
    }
  }
  const prevTasks = new Map(prev.tasks.map((task) => [task.id, task]));
  for (const task of next.tasks) {
    const was = prevTasks.get(task.id);
    if (task.state === "failed" && was?.state !== "failed") out.push(`Background task ${task.name} failed.`);
    if (task.state === "waiting-on-you" && was?.state !== "waiting-on-you") request = true;
  }
  if (request) out.unshift("A request needs you.");
  return out;
}

// ---------------------------------------------------------------- sidebar, activity, title

export interface SidebarSummaryOptions {
  sessionId?: string;
  stale?: boolean;
  staleAt?: number | null;
  researchRuns?: readonly ResearchRunView[];
}

/**
 * The sidebar row's second line for a thread whose fold this client holds; null when it has no run or task. `live`
 * is the server's view of the thread, which carries no agent counts today (v1.1 will), so a thread this client
 * does not fold gets no strip: the row keeps the word it shows now.
 */
export function sidebarCrewSummary(fold: ThreadFold | null, _live: LiveView | null, now: number, opts: SidebarSummaryOptions = {}): SidebarCrewSummary | null {
  if (!fold) return null;
  const view = crewView(fold, null, now, { stale: opts.stale, staleAt: opts.staleAt, numbers: opts.sessionId ? agentNumbers(opts.sessionId) : undefined, researchRuns: opts.researchRuns });
  const running = view.runs.filter(runLive);
  const run = running[running.length - 1] ?? view.runs[view.runs.length - 1] ?? null;
  const needs = Object.keys(fold.approvals).length + Object.keys(fold.userInputs).length;
  const task = view.tasks.find((candidate) => LIVE_STATES.has(candidate.state)) ?? view.tasks[0] ?? null;
  if (!run) {
    if (!task) return null;
    return { groups: [], text: task.name, needs, failed: task.state === "failed" ? 1 : 0, noUpdate: task.state === "no-update" ? 1 : 0, phase: null, stale: opts.stale === true, task: task.name, live: LIVE_STATES.has(task.state), endedAt: task.endedAt };
  }
  const { counts } = run;
  const isLive = runLive(run);
  let text: string;
  if (run.stale) {
    const at = run.staleAt;
    text = at !== null ? `Last known ${shortDuration(Math.max(0, now - at))}` : "Last known";
  } else if (run.status === "starting") {
    text = "Starting";
  } else if (isLive) {
    text = run.plannedKnown ? `${run.currentPhase ?? "Finishing"} · ${counts.done}/${counts.total}` : `${counts.done} done · ${counts.working + counts.finishing + counts.noUpdate} working`;
  } else if (run.status === "stopped") {
    text = `Stopped · ${counts.done} landed`;
  } else {
    text = `${counts.done} landed`;
  }
  return {
    groups: run.phases.map((phase) => phase.agents.map((agent) => agent.state)),
    text,
    needs,
    failed: counts.failed,
    noUpdate: counts.noUpdate,
    phase: run.currentPhase,
    stale: run.stale,
    task: task && !isLive ? task.name : null,
    live: isLive,
    endedAt: run.endedAt,
  };
}

/** Whether a thread's fold stands for what the thread is doing now. */
function foldIsLive(state: AppState, thread: ThreadState | undefined): boolean {
  return thread !== undefined && (thread.load === "ready" || thread.fold.order.length > 0) && !thread.stale && !thread.fold.closed && state.connection === "open";
}

/** Requests waiting across every thread: the fold's when this client holds the thread live, else the server's count. */
export function windowTitleCount(state: AppState): number {
  let total = 0;
  for (const session of Object.values(state.sessions)) {
    const thread = state.threads[session.sessionId];
    if (thread && foldIsLive(state, thread)) {
      total += Object.keys(thread.fold.approvals).length + Object.keys(thread.fold.userInputs).length;
    } else {
      total += (session.live?.pendingApprovals ?? 0) + (session.live?.pendingInputs ?? 0);
    }
  }
  return total;
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const UNTRACKED_NOTE = "Other threads appear here once Ancilla tracks them (coming in 1.1)";

/**
 * The Activity drawer: every request waiting anywhere, then what runs and what finished today in the threads
 * this client folds. A thread it does not fold (never opened, or stale since the stream dropped) shows only its
 * requests, and the note says so.
 */
export function activityView(state: AppState, now: number): ActivityVM {
  const needsYou: ActivityItemVM[] = [];
  const working: ActivityItemVM[] = [];
  const finishedToday: ActivityItemVM[] = [];
  const dayStart = startOfDay(now);
  const open = state.route.kind === "thread" ? state.route.sessionId : null;
  let stopAll: ActivityVM["stopAll"] = null;
  let untracked = false;
  let tokensToday = 0;
  const threadsWorking = new Set<string>();
  const sessions = Object.values(state.sessions).sort((a, b) => (a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0));
  for (const session of sessions) {
    const project = projectForCwd(state.projects, session.cwd)?.displayName ?? session.cwd;
    const base = { sessionId: session.sessionId, project, thread: session.title };
    const thread: ThreadState | undefined = state.threads[session.sessionId];
    if (!thread || !foldIsLive(state, thread)) {
      const pending = (session.live?.pendingApprovals ?? 0) + (session.live?.pendingInputs ?? 0);
      if (pending > 0) {
        needsYou.push({ ...base, itemId: null, agentId: null, kind: "request", text: `${plural(pending, "request")} waiting`, sub: null, state: "request", startedAt: null, endedAt: null, stale: true });
      }
      if (session.live?.activeTurnId || pending > 0 || thread?.stale === true) untracked = true;
      continue;
    }
    const fold = thread.fold;
    for (const request of Object.values(fold.approvals)) {
      const described = describeApproval(request);
      needsYou.push({ ...base, itemId: request.itemId ?? null, agentId: null, kind: "request", text: described.title, sub: described.detail, state: "request", startedAt: fold.crew?.requests[request.approvalId]?.askedAt ?? null, endedAt: null, stale: false });
    }
    for (const request of Object.values(fold.userInputs)) {
      needsYou.push({ ...base, itemId: request.itemId ?? null, agentId: null, kind: "request", text: "Muse asked a question", sub: request.questions?.[0]?.question ?? null, state: "request", startedAt: fold.crew?.requests[request.userInputId]?.askedAt ?? null, endedAt: null, stale: false });
    }
    const view = crewView(fold, session, now, {
      stale: false,
      partialHistory: thread.truncated,
      pending: state.crew.pending,
      skipped: state.crew.skipped,
      models: state.models,
      researchRuns: thread.researchRuns,
    });
    let runs = 0;
    let tasks = 0;
    for (const run of view.runs) {
      if (runLive(run)) {
        runs += 1;
        threadsWorking.add(session.sessionId);
        working.push({ ...base, itemId: run.itemId, agentId: null, kind: "run", text: run.name, sub: summaryLine(run).progress, state: run.counts.waiting > 0 || run.runNeeds.length > 0 ? "waiting-on-you" : run.counts.failed > 0 ? "failed" : "working", startedAt: run.startedAt, endedAt: null, stale: false });
      } else if (run.endedAt !== null && run.endedAt >= dayStart) {
        finishedToday.push({ ...base, itemId: run.itemId, agentId: null, kind: "run", text: run.name, sub: summaryLine(run).progress, state: run.status === "finished" ? "done" : run.status === "stopped" ? "skipped" : "failed", startedAt: run.startedAt, endedAt: run.endedAt, stale: false });
      }
      if (run.tokens && run.startedAt !== null && run.startedAt >= dayStart) tokensToday += run.tokens.total;
    }
    for (const task of view.tasks) {
      if (LIVE_STATES.has(task.state)) {
        tasks += 1;
        threadsWorking.add(session.sessionId);
        working.push({ ...base, itemId: task.id, agentId: task.id, kind: "task", text: task.name, sub: task.taskInfo?.tail ?? null, state: task.state, startedAt: task.startedAt, endedAt: null, stale: false });
      } else if (task.endedAt !== null && task.endedAt >= dayStart) {
        finishedToday.push({ ...base, itemId: task.id, agentId: task.id, kind: "task", text: task.name, sub: task.state === "failed" ? `failed · ${task.failure?.text ?? "no reason reported"}` : "finished · no failure reported", state: task.state, startedAt: task.startedAt, endedAt: task.endedAt, stale: false });
      }
    }
    for (const agent of view.subagents) {
      if (LIVE_STATES.has(agent.state)) {
        threadsWorking.add(session.sessionId);
        working.push({ ...base, itemId: null, agentId: agent.id, kind: "subagent", text: agent.name, sub: agent.task?.text ?? null, state: agent.state, startedAt: agent.startedAt, endedAt: null, stale: false });
      }
    }
    if (session.sessionId === open && runs + tasks > 0) stopAll = { runs, tasks };
  }
  for (const session of Object.values(state.sessions)) {
    const thread = state.threads[session.sessionId];
    if (thread?.stale && (session.live?.activeTurnId || crewBusy(thread.fold, thread.researchRuns))) untracked = true;
  }
  const empty = needsYou.length + working.length + finishedToday.length === 0;
  const foot = working.length > 0
    ? `${working.length} running in ${plural(threadsWorking.size, "thread")}${tokensToday > 0 ? ` · ${formatTokens(tokensToday)} tokens today` : ""}`
    : needsYou.length > 0 ? `${plural(needsYou.length, "request")} waiting for you` : "Nothing runs and nothing waits for you.";
  return { needsYou, working, finishedToday, stopAll, foot, empty, note: untracked ? UNTRACKED_NOTE : null };
}
