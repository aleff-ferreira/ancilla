// Goal model: tracking, record parsing, checklist display, and prompt creation
import type { ThreadFold } from "./fold.js";
export interface GoalRecord {
  goalId: string | null;
  objective: string;
  status: string;
  percentComplete: number;
  currentWork: string | null;
  nextWork: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  lastProgressAt: number | null;
  tokensUsed: number | null;
  tokenBudget: number | null;
}
export const GOAL_TOOLS: ReadonlySet<string> = new Set([
  "create_goal",
  "update_goal",
  "report_progress",
  "get_goal",
]);
export type GoalTone = "active" | "paused" | "done" | "attention" | "ended";
const STATUS_DICTIONARY: Record<string, { label: string; tone: GoalTone }> = {
  active: { label: "In progress", tone: "active" },
  paused: { label: "Paused", tone: "paused" },
  complete: { label: "Done", tone: "done" },
  blocked: { label: "Blocked", tone: "attention" },
  budget_limited: { label: "Out of budget", tone: "attention" },
  usage_limited: { label: "Usage limit reached", tone: "attention" },
  cleared: { label: "Cleared", tone: "ended" },
  cancelled: { label: "Cancelled", tone: "ended" },
  superseded: { label: "Replaced", tone: "ended" },
  abandoned: { label: "Abandoned", tone: "ended" },
};
export interface GoalView {
  objective: string;
  status: string;
  label: string;
  tone: GoalTone;
  percent: number;
  currentWork: string | null;
  nextWork: string | null;
  startedAt: number | null;
  endedAt: number | null;
  pausedMs: number;
  lastProgressAt: number | null;
  turns: number;
  turnIds: string[];
  tokens: number;
  tokenBudget: number | null;
  tokensUsed: number | null;
}
function parseNumber(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}
function parseString(val: unknown): string | null {
  return typeof val === "string" && val.trim().length > 0 ? val : null;
}
export function parseGoalRecord(output: string | undefined): GoalRecord | null {
  if (output == null || output === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const payload = (parsed as Record<string, unknown>)["goal"];
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const data = payload as Record<string, unknown>;
  const objective = parseString(data["objective"]);
  if (objective == null) {
    return null;
  }
  const recordResult: GoalRecord = {
    goalId: parseString(data["goal_id"]),
    objective: objective,
    status: parseString(data["status"]) ?? "active",
    percentComplete: parseNumber(data["percent_complete"]) ?? 0,
    currentWork: parseString(data["current_work"]),
    nextWork: parseString(data["next_work"]),
    createdAt: parseNumber(data["created_at_ms"]),
    updatedAt: parseNumber(data["updated_at_ms"]),
    lastProgressAt: parseNumber(data["last_progress_at_ms"]),
    tokensUsed: parseNumber(data["tokens_used"]),
    tokenBudget: parseNumber(data["token_budget"]),
  };
  return recordResult;
}
export function latestGoalRecord(fold: ThreadFold): { record: GoalRecord; turnId: string | null } | null {
  for (let idx = fold.order.length - 1; idx >= 0; idx--) {
    const itemId = fold.order[idx] as string;
    const item = fold.items[itemId];
    const isGoalToolCall = item?.kind === "toolCall" && item.tool != null && GOAL_TOOLS.has(item.tool);
    if (isGoalToolCall && item.status === "completed") {
      const parsed = parseGoalRecord(item.visibleOutput);
      if (parsed) {
        return { record: parsed, turnId: item.turnId ?? null };
      }
    }
  }
  return null;
}
export function statusLabel(status: string): { label: string; tone: GoalTone } {
  const match = STATUS_DICTIONARY[status];
  if (match) return match;
  const normalized = status.replace(/[_-]+/g, " ").trim();
  const titleCased = normalized.length > 0 ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : "Unknown";
  return { label: titleCased, tone: "paused" };
}
function calculateGoalTurns(fold: ThreadFold, startTime: number, endTime: number | null, setTurnId: string | null): Set<string> {
  const relevantTurns = new Set<string>();
  if (setTurnId) relevantTurns.add(setTurnId);
  const pauseList = fold.meta.goalPauses;
  const isPausedAt = (ts: number) => pauseList.some((p) => ts > p.from && ts < (p.to ?? Number.POSITIVE_INFINITY));
  const isWithinGoalWindow = (ts: number) => ts >= startTime && (endTime === null || ts <= endTime) && !isPausedAt(ts);
  for (const id of fold.order) {
    const item = fold.items[id];
    if (!item?.turnId || !item.recordedAt) continue;
    const itemTime = Date.parse(item.recordedAt);
    if (!Number.isNaN(itemTime) && isWithinGoalWindow(itemTime)) {
      relevantTurns.add(item.turnId);
    }
  }
  for (const turn of Object.values(fold.turns)) {
    if (turn.startedAt !== undefined && isWithinGoalWindow(turn.startedAt)) {
      relevantTurns.add(turn.turnId);
    }
  }
  return relevantTurns;
}
export function goalView(fold: ThreadFold): GoalView | null {
  const metaGoal = fold.meta.goal;
  const toolEntry = latestGoalRecord(fold);
  if (!metaGoal && (fold.meta.goalSeen || !toolEntry)) {
    return null;
  }
  const objective = metaGoal?.objective ?? toolEntry?.record.objective ?? "";
  const matchingRecord = toolEntry && toolEntry.record.objective === objective ? toolEntry.record : null;
  const status = metaGoal?.status ?? matchingRecord?.status ?? "active";
  const { label: statusDisplayLabel, tone: statusDisplayTone } = statusLabel(status);
  const startedAt = matchingRecord?.createdAt ?? fold.meta.goalSince;
  const endedAt = statusDisplayTone === "active" ? null : (fold.meta.goalStatusAt ?? (matchingRecord && matchingRecord.status === status ? matchingRecord.updatedAt : null));
  const activeTurns = startedAt === null ? new Set<string>() : calculateGoalTurns(fold, startedAt, endedAt, matchingRecord ? toolEntry?.turnId ?? null : null);
  let totalTokens = 0;
  for (const call of Object.values(fold.meta.calls)) {
    if (call.turnId && activeTurns.has(call.turnId)) {
      totalTokens += call.promptTokens + call.outputTokens;
    }
  }
  const rawPercent = metaGoal?.percentComplete ?? matchingRecord?.percentComplete ?? 0;
  const percent = Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0));
  const totalPausedMs = fold.meta.goalPauses.reduce((acc, p) => acc + (p.to === null ? 0 : Math.max(0, p.to - p.from)), 0);
  const projectedGoalView: GoalView = {
    objective: objective,
    status: status,
    label: statusDisplayLabel,
    tone: statusDisplayTone,
    percent: percent,
    currentWork: metaGoal?.currentWork ?? matchingRecord?.currentWork ?? null,
    nextWork: metaGoal?.nextWork ?? matchingRecord?.nextWork ?? null,
    startedAt: startedAt,
    endedAt: endedAt,
    pausedMs: totalPausedMs,
    lastProgressAt: matchingRecord?.lastProgressAt ?? null,
    turns: activeTurns.size,
    turnIds: [...activeTurns],
    tokens: totalTokens,
    tokenBudget: matchingRecord?.tokenBudget ?? null,
    tokensUsed: matchingRecord?.tokensUsed ?? null,
  };
  return projectedGoalView;
}
export function goalPrompt(objective: string): string {
  const trimmedObjective = objective.trim();
  return `Create a goal with your create_goal tool. Objective: ${trimmedObjective}\nThen work toward it until it is complete.`;
}
