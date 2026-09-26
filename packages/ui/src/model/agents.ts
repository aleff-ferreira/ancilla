import type { MspItem } from "../types.js";
import type { ThreadFold } from "./fold.js";
import { reconciled } from "./workflow.js";

export type AgentActivityStatus = "working" | "waiting" | "completed" | "failed" | "stopped" | "unknown";

export interface AgentActivity {
  id: string;
  name: string;
  objective: string | null;
  activity: string | null;
  status: AgentActivityStatus;
  source: "workflow" | "subagent";
  turnId: string | null;
  durationMs: number | null;
  toolCalls: number | null;
  attempt: number;
  workflowRunId: string | null;
  childSessionId: string | null;
}

export interface AgentActivityView {
  agents: AgentActivity[];
  total: number;
  working: number;
  waiting: number;
  completed: number;
  failed: number;
  stopped: number;
  unknown: number;
}

type RecordValue = Record<string, unknown>;
interface Observation extends Omit<AgentActivity, "name"> {
  name: string | null;
  durableId: string | null;
  itemId: string;
  revision: number;
  at: number | null;
  /** Payload totals alone cannot report a running child's present state. */
  inferred: boolean;
}
interface Entry extends Observation {
  order: number;
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function attempt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function state(value: unknown): AgentActivityStatus {
  switch (text(value)?.replace(/[\s_-]/g, "").toLowerCase()) {
    case "inprogress": case "running": case "working": case "started": case "starting": case "usage":
      return "working";
    case "scheduled": case "queued": case "pending": case "waiting": case "paused": case "blocked":
    case "idle": case "interrupted": case "awaitinginput": case "awaitingapproval": case "accepted":
    case "recoverypending": case "manualreconciliation": case "closing":
      return "waiting";
    case "completed": case "complete": case "succeeded": case "success": case "done": case "resultready":
      return "completed";
    case "failed": case "error": case "rejected": case "timedout":
      return "failed";
    case "cancelled": case "canceled": case "stopped": case "closed": case "skipped":
      return "stopped";
    default:
      return "unknown";
  }
}

/** A reported outcome is terminal whatever its value; one this version does not know is terminal-unknown. */
function outcome(value: unknown): AgentActivityStatus {
  const result = state(value);
  return terminal(result) ? result : "unknown";
}

function childStatus(value: RecordValue, runEnded: boolean): AgentActivityStatus {
  // The child's terminal outcome is the strongest evidence. Its lifecycle (scheduled, started,
  // usage) is not the item-status enum, so it is read as reported while the run is open.
  if (text(value["terminal"])) return outcome(value["terminal"]);
  const lifecycle = state(value["status"]);
  // A run item stays open until the run ends, so none of its children can still be queued or
  // running once it has settled. Their own outcome was never recorded, and the run's does not
  // say what it was.
  return runEnded && !terminal(lifecycle) ? "unknown" : lifecycle;
}

function itemStatus(value: RecordValue): AgentActivityStatus {
  if (text(value["terminal"])) return outcome(value["terminal"]);
  // Item status is an open enum and the terminal authority: anything but inProgress has settled,
  // and an unrecognized value is terminal-unknown. Control states add detail only while it is open.
  const lifecycle = text(value["status"]);
  if (lifecycle && lifecycle !== "inProgress") return outcome(lifecycle);
  const control = state(value["controlStatus"]);
  return control !== "unknown" ? control : state(lifecycle);
}

function name(value: RecordValue): string | null {
  for (const key of ["label", "name", "title", "role"]) {
    const candidate = text(value[key]);
    if (candidate && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(candidate)) {
      if (key === "label" && /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(candidate)) {
        return candidate[0].toUpperCase() + candidate.slice(1).replace(/[-_]/g, " ");
      }
      return candidate;
    }
  }
  return null;
}

function observation(item: MspItem, value: RecordValue, currentStatus: AgentActivityStatus, durableId: string | null): Observation {
  const childSessionId = text(value["childSessionId"]);
  const parsedAt = item.recordedAt ? Date.parse(item.recordedAt) : NaN;
  return {
    id: durableId ?? childSessionId ?? `item:${item.itemId}`,
    durableId,
    name: name(value),
    objective: text(value["objective"]),
    // A phase is genuine child metadata, whereas a workflow's label/objective belongs to the run.
    activity: currentStatus === "working" || currentStatus === "waiting"
      ? text(value["phase"])
      : null,
    status: currentStatus,
    source: item.kind === "workflow" ? "workflow" : "subagent",
    turnId: text(item.turnId),
    durationMs: metric(value["durationMs"]),
    toolCalls: metric(value["toolCalls"]),
    attempt: attempt(value["attempt"]),
    workflowRunId: text(item.workflowRunId),
    childSessionId,
    itemId: item.itemId,
    revision: metric(value["revision"]) ?? item.revision,
    at: Number.isFinite(parsedAt) ? parsedAt : null,
    inferred: false,
  };
}

/**
 * An item's observations depend on nothing but the item, and the fold replaces an item rather than
 * changing it. A long swarm thread therefore parses each run's reconciliation once, not once per revision
 * of every other item.
 */
const observed = new WeakMap<MspItem, readonly Observation[]>();

function itemObservations(item: MspItem): readonly Observation[] {
  let result = observed.get(item);
  if (!result) {
    result = item.kind === "workflow" ? workflowObservations(item)
      : item.kind === "subagent" ? [observation(item, item, itemStatus(item), text(item.subagentId) ?? text(item["childId"]))]
      : [];
    observed.set(item, result);
  }
  return result;
}

function workflowObservations(item: MspItem): Observation[] {
  const payload = reconciled(item.message);
  const runEnded = typeof item.status === "string" && item.status !== "inProgress";
  const activity = new Map<string, RecordValue>();
  if (Array.isArray(payload?.agents_activity)) {
    for (const raw of payload.agents_activity) {
      const entry = record(raw);
      const id = text(entry?.["agent"]);
      if (entry && id) activity.set(id, entry);
    }
  }
  const children: Observation[] = [];
  const reported = new Set<string>();
  const latestAttempts = new Map<string, number>();
  for (const child of Array.isArray(item.children) ? item.children : []) {
    if (child && typeof child.childId === "string") latestAttempts.set(child.childId, Math.max(latestAttempts.get(child.childId) ?? 1, attempt(child.attempt)));
  }
  for (const raw of Array.isArray(item.children) ? item.children : []) {
    const child = record(raw);
    const id = text(child?.["childId"]);
    if (!child || !id) continue;
    const agent = observation(item, child, childStatus(child, runEnded), id);
    const extra = activity.get(id);
    // Reconciliation totals are reported per durable child, not per attempt. They must not
    // become an earlier attempt's duration when the workflow contains its retry as well.
    if (agent.attempt === latestAttempts.get(id)) {
      agent.durationMs ??= metric(extra?.["duration_ms"]);
      agent.toolCalls ??= metric(extra?.["tool_calls"]);
    }
    children.push(agent);
    reported.add(id);
  }
  for (const [id, extra] of activity) {
    if (reported.has(id)) continue;
    // A successfully reconciled workflow can recover missing final child records. Failure or
    // cancellation of a run does not imply every one of its children failed or was cancelled.
    const agent = observation(item, {}, state(item.status) === "completed" ? "completed" : "unknown", id);
    agent.durationMs = metric(extra["duration_ms"]);
    agent.toolCalls = metric(extra["tool_calls"]);
    agent.inferred = true;
    children.push(agent);
  }
  return children;
}

function terminal(value: AgentActivityStatus): boolean {
  return value === "completed" || value === "failed" || value === "stopped";
}

/** Order two reports of the same durable child, without comparing unrelated item revisions. */
function compare(left: Entry, right: Entry): number {
  if (left.attempt !== right.attempt) return left.attempt - right.attempt;
  if (left.itemId === right.itemId && left.revision !== right.revision) return left.revision - right.revision;
  if (left.at !== null && right.at !== null && left.at !== right.at) return left.at - right.at;
  if (left.inferred !== right.inferred) return left.inferred ? -1 : 1;
  // With no comparable clock, an explicit final outcome is stronger than a still-open item.
  if (terminal(left.status) !== terminal(right.status)) return terminal(left.status) ? 1 : -1;
  return left.order - right.order;
}

const STATUS_ORDER: Record<AgentActivityStatus, number> = {
  working: 0, waiting: 1, unknown: 2, failed: 3, stopped: 4, completed: 5,
};

/**
 * Numbers for agents that report no name, by durable identity. A number is handed out once, in order of
 * first appearance, and never moves to another agent: not when an earlier run gains a child, and not when
 * a capped reload drops older runs.
 */
export type AgentNumbers = Map<string, number>;

const numbered = new Map<string, AgentNumbers>();
const NUMBERED_THREADS = 64;

/** A thread's agent numbers for as long as the app runs, so reopening the thread keeps them too. */
export function agentNumbers(sessionId: string): AgentNumbers {
  const numbers = numbered.get(sessionId) ?? new Map<string, number>();
  // Least recently shown threads are forgotten first; only anonymous agents take an entry.
  numbered.delete(sessionId);
  numbered.set(sessionId, numbers);
  for (const stale of numbered.keys()) {
    if (numbered.size <= NUMBERED_THREADS) break;
    numbered.delete(stale);
  }
  return numbers;
}

/**
 * The thread's reported children. The parent turn ending never settles a child that is still working.
 * Without `numbers`, anonymous agents are numbered by their position in this fold alone.
 */
export function agentActivityView(fold: ThreadFold, numbers: AgentNumbers = new Map()): AgentActivityView {
  const entries: Entry[] = [];
  let order = 0;
  for (const item of Object.values(fold.agentItems ?? fold.items)) {
    if (item?.kind === "workflow" || item?.kind === "subagent") {
      for (const observation of itemObservations(item)) entries.push({ ...observation, order });
    }
    order++;
  }
  const sessions = new Map<string, string>();
  for (const entry of entries) {
    if (entry.durableId && entry.childSessionId) sessions.set(entry.childSessionId, entry.durableId);
  }
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const id = entry.durableId ?? (entry.childSessionId ? sessions.get(entry.childSessionId) : null) ?? entry.id;
    const group = groups.get(id);
    if (group) group.push(entry);
    else groups.set(id, [entry]);
  }
  const number = (id: string): number => {
    let value = numbers.get(id);
    if (value === undefined) {
      value = numbers.size + 1;
      numbers.set(id, value);
    }
    return value;
  };
  const rows: { agent: AgentActivity; order: number; at: number | null }[] = [];
  for (const [id, group] of groups) {
    group.sort(compare);
    const latest = group[group.length - 1];
    const sameAttempt = group.filter((entry) => entry.attempt === latest.attempt);
    const mostRecent = [...sameAttempt].reverse();
    const findText = (key: "name" | "objective" | "workflowRunId" | "childSessionId"): string | null =>
      [...(key === "name" || key === "objective" ? sameAttempt : group)].reverse().map((entry) => entry[key]).find((value) => value !== null) ?? null;
    rows.push({
      agent: {
        id,
        name: findText("name") ?? `Agent ${number(id)}`,
        objective: findText("objective"),
        activity: latest.activity,
        status: latest.status,
        source: group.some((entry) => entry.source === "subagent") ? "subagent" : "workflow",
        turnId: latest.turnId,
        durationMs: mostRecent.map((entry) => entry.durationMs).find((value) => value !== null) ?? null,
        toolCalls: mostRecent.map((entry) => entry.toolCalls).find((value) => value !== null) ?? null,
        attempt: latest.attempt,
        workflowRunId: findText("workflowRunId"),
        childSessionId: findText("childSessionId"),
      },
      order: Math.max(...group.map((entry) => entry.order)),
      at: latest.at,
    });
  }
  rows.sort((left, right) => STATUS_ORDER[left.agent.status] - STATUS_ORDER[right.agent.status]
    || Number(right.agent.turnId === fold.activeTurnId) - Number(left.agent.turnId === fold.activeTurnId)
    || (left.at !== null && right.at !== null ? right.at - left.at : 0)
    || right.order - left.order);
  const result: AgentActivityView = { agents: rows.map((row) => row.agent), total: rows.length, working: 0, waiting: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const agent of result.agents) result[agent.status]++;
  return result;
}

/** The thread's agent items when its live view last reported itself unavailable; null until the thread has loaded. */
export interface AgentFeedMark {
  sessionId: string;
  items: Record<string, MspItem> | null;
}

/** Keeps the first loaded snapshot for as long as the live view stays unavailable, and forgets it once it recovers. */
export function markAgentFeed(mark: AgentFeedMark | null, sessionId: string, unavailable: boolean, loaded: Record<string, MspItem> | null): AgentFeedMark | null {
  if (!unavailable) return null;
  if (mark?.sessionId === sessionId && (mark.items !== null || loaded === null)) return mark;
  return { sessionId, items: loaded };
}

/**
 * Agent revisions arrived after the live view reported itself unavailable, while the lead was idle. With
 * no turn running, nothing else can be confused with the background agents' own progress, so what the
 * panel shows is current rather than last known. While a turn runs, the lead's own recovery decides.
 */
export function agentFeedRecovered(mark: AgentFeedMark | null, sessionId: string, items: Record<string, MspItem> | null, idle: boolean): boolean {
  if (!idle || !items || mark?.sessionId !== sessionId || !mark.items || mark.items === items) return false;
  for (const [id, item] of Object.entries(items)) {
    if (item.kind !== "workflow" && item.kind !== "subagent") continue;
    const before = mark.items[id];
    if (!before || item.revision > before.revision) return true;
  }
  return false;
}
