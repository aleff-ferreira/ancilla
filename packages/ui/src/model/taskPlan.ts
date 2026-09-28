import type { CrewVM } from "./crew.js";
import type { ThreadFold } from "./fold.js";

export type TaskStepStatus = "pending" | "inProgress" | "completed" | "cancelled" | "failed" | "unknown";
export type TaskPlanState = "working" | "waiting" | "idle" | "stopped" | "stale" | "previous" | "complete";

export interface TaskStepView {
  text: string;
  activeForm: string | null;
  /** What Muse reported for this step. Runtime context never marks a step complete. */
  status: TaskStepStatus;
}

export interface TaskPlanView {
  items: TaskStepView[];
  done: number;
  cancelled: number;
  remaining: number;
  activeIndex: number;
  state: TaskPlanState;
  label: string;
  detail: string;
  /** Only a live, associated turn or worker can animate a reported active step. */
  animate: boolean;
  updatedAt: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stepStatus(value: unknown): TaskStepStatus {
  if (typeof value !== "string") return "unknown";
  switch (value.replace(/[_\s-]/g, "").toLowerCase()) {
    case "pending": case "todo": case "notstarted": return "pending";
    case "inprogress": return "inProgress";
    case "completed": case "complete": case "done": return "completed";
    case "cancelled": case "canceled": case "skipped": return "cancelled";
    case "failed": return "failed";
    default: return "unknown";
  }
}

/** Muse's saved todos use snake-case states; older projections also used `content` for the label. */
export function taskPlanItems(value: unknown): TaskStepView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TaskStepView[] => {
    const row = record(entry);
    const text = row ? nonempty(row["text"]) ?? nonempty(row["content"]) : null;
    if (!row || !text) return [];
    return [{ text, status: stepStatus(row["status"]), activeForm: nonempty(row["activeForm"]) ?? nonempty(row["active_form"]) }];
  });
}

const LIVE_STATES = new Set(["scheduled", "working", "finishing", "no-update", "waiting-on-you"]);

/** Workers may outlive the lead turn. Only those belonging to the plan's source turn keep its activity live. */
function workersRunning(fold: ThreadFold, crew: CrewVM | null | undefined, turnId: string | null): boolean {
  if (!crew || !turnId) return false;
  const belongs = (itemId: string | null) => itemId !== null && fold.items[itemId]?.turnId === turnId;
  return crew.runs.some((run) => run.kind === "workflow" && belongs(run.itemId) &&
    (run.status === "starting" || run.status === "running")) ||
    crew.tasks.some((task) => belongs(task.id) && LIVE_STATES.has(task.state)) ||
    crew.subagents.some((agent) => agent.sourceTurnId === turnId && LIVE_STATES.has(agent.state));
}

/**
 * The task plan and its execution context. An ended turn does not prove an unfinished step succeeded; an
 * unrelated new prompt does not resume the old plan. Keep the reported work visible and explain the difference.
 */
export function taskPlanView(fold: ThreadFold, options: { stale?: boolean; crew?: CrewVM | null } = {}): TaskPlanView | null {
  const items = taskPlanItems(fold.meta.todoList);
  if (items.length === 0) return null;
  const done = items.filter((item) => item.status === "completed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const remaining = items.length - done - cancelled;
  const activeIndex = items.findIndex((item) => item.status === "inProgress");
  const observedAt = fold.meta.observed?.todoList?.at;
  const updatedAt = typeof observedAt === "number" && Number.isFinite(observedAt) && Math.abs(observedAt) <= 8_640_000_000_000_000 ? observedAt : null;
  const sourceTurn = fold.meta.todoTurnId ?? null;
  const turn = sourceTurn ? fold.turns[sourceTurn] : undefined;
  const activeTurn = fold.activeTurnId ? fold.turns[fold.activeTurnId] : undefined;
  // An old fold may lack a turn association. A timestamp can establish that its plan arrived during the current turn.
  const associated = sourceTurn ? sourceTurn === fold.activeTurnId : Boolean(fold.activeTurnId && updatedAt !== null &&
    activeTurn?.startedAt !== undefined && updatedAt >= activeTurn.startedAt);
  const current = associated && !fold.closed;
  const workers = !fold.closed && workersRunning(fold, options.crew, sourceTurn);
  const pendingRequest = [...Object.values(fold.approvals), ...Object.values(fold.userInputs)].some((request) => {
    const requestTurn = request.turnId ?? (request.itemId ? fold.items[request.itemId]?.turnId : undefined);
    return requestTurn ? requestTurn === (sourceTurn ?? fold.activeTurnId) : current;
  });
  const count = `${remaining} ${remaining === 1 ? "step remains" : "steps remain"} unconfirmed`;
  let state: TaskPlanState;
  let label: string;
  let detail: string;
  if (remaining === 0) {
    state = "complete";
    label = cancelled > 0 ? "Settled" : "Complete";
    detail = cancelled > 0 ? `${done} completed · ${cancelled} cancelled` : "Muse marked every step complete.";
  } else if (options.stale || fold.closed) {
    state = "stale";
    label = "Last known";
    detail = "Live progress is unavailable. These are the last step statuses Muse reported.";
  } else if ((current || workers) && pendingRequest) {
    state = "waiting";
    label = "Waiting for you";
    detail = "An approval or answer is needed before this work can continue.";
  } else if (current || workers) {
    state = "working";
    label = current ? "Working" : "Workers running";
    detail = activeIndex >= 0 ? "Step statuses update when Muse reports a plan change." : "Muse is working; no plan step is marked active yet.";
  } else if (fold.activeTurnId) {
    state = "previous";
    label = "Previous plan";
    detail = "A newer turn is running. Muse has not updated this plan for it.";
  } else if (turn?.terminal && ["failed", "cancelled", "canceled", "interrupted", "stopped"].includes(turn.terminal)) {
    state = "stopped";
    label = turn.terminal === "failed" ? "Turn failed" : "Stopped";
    detail = `${count}. Their completion was not reported.`;
  } else {
    state = "idle";
    label = turn?.terminal && turn.terminal !== "unknown" ? "Turn finished" : "Not running";
    detail = `${count}. Muse has not marked them complete.`;
  }
  return { items, done, cancelled, remaining, activeIndex, state, label, detail, animate: state === "working", updatedAt };
}
