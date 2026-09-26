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
  order: number;
  /** Payload totals alone cannot report a running child's present state. */
  inferred: boolean;
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

function status(value: RecordValue): AgentActivityStatus {
  // The item/child's terminal outcome is the strongest evidence. Control states add detail
  // while a standalone subagent item remains open.
  if (text(value["terminal"])) return state(value["terminal"]);
  const lifecycle = state(value["status"]);
  if (terminal(lifecycle)) return lifecycle;
  const control = state(value["controlStatus"]);
  return control !== "unknown" ? control : lifecycle;
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

function observation(item: MspItem, value: RecordValue, order: number, durableId: string | null): Observation {
  const childSessionId = text(value["childSessionId"]);
  const parsedAt = item.recordedAt ? Date.parse(item.recordedAt) : NaN;
  const currentStatus = status(value);
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
    order,
    inferred: false,
  };
}

function workflowObservations(item: MspItem, order: number): Observation[] {
  const payload = reconciled(item.message);
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
    const agent = observation(item, child, order, id);
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
    const agent = observation(item, {}, order, id);
    // A successfully reconciled workflow can recover missing final child records. Failure or
    // cancellation of a run does not imply every one of its children failed or was cancelled.
    agent.status = state(item.status) === "completed" ? "completed" : "unknown";
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
function compare(left: Observation, right: Observation): number {
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

/** The thread's reported children. The parent turn ending never settles a child that is still working. */
export function agentActivityView(fold: ThreadFold): AgentActivityView {
  const observations: Observation[] = [];
  let order = 0;
  for (const item of Object.values(fold.agentItems ?? fold.items)) {
    if (item?.kind === "workflow") observations.push(...workflowObservations(item, order));
    if (item?.kind === "subagent") {
      observations.push(observation(item, item, order, text(item.subagentId) ?? text(item["childId"])));
    }
    order++;
  }
  const sessions = new Map<string, string>();
  for (const observation of observations) {
    if (observation.durableId && observation.childSessionId) sessions.set(observation.childSessionId, observation.durableId);
  }
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const id = observation.durableId ?? (observation.childSessionId ? sessions.get(observation.childSessionId) : null) ?? observation.id;
    const group = groups.get(id);
    if (group) group.push(observation);
    else groups.set(id, [observation]);
  }
  const rows: { agent: AgentActivity; order: number; at: number | null }[] = [];
  let ordinal = 0;
  for (const [id, group] of groups) {
    ordinal++;
    group.sort(compare);
    const latest = group[group.length - 1];
    const sameAttempt = group.filter((entry) => entry.attempt === latest.attempt);
    const mostRecent = [...sameAttempt].reverse();
    const findText = (key: "name" | "objective" | "workflowRunId" | "childSessionId"): string | null =>
      [...(key === "name" || key === "objective" ? sameAttempt : group)].reverse().map((entry) => entry[key]).find((value) => value !== null) ?? null;
    rows.push({
      agent: {
        id,
        name: findText("name") ?? `Agent ${ordinal}`,
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
