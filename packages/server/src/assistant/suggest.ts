import { isDueSoon, isStale } from "./rank.js";
import type { MemoryStore } from "./store.js";
import type { Task, TaskStore } from "./tasks.js";
import type { AssistantProfile } from "./types.js";

/**
 * What the assistant would do next, and why. Every suggestion points at something the user said or something a task
 * left undecided; none comes from a model's idea of what the user might want. Whether the assistant acts on one by
 * itself is the autonomy setting's question: under "ask" it only points out what is waiting on the user, under
 * "suggest" it lists the work it could do, and under "act" it starts the ones that only read.
 */

export type SuggestionKind = "due-commitment" | "stale-memory" | "goal-idle" | "task-needs-you";

export interface Suggestion {
  /** Stable, so that dismissing one stays dismissed. */
  id: string;
  kind: SuggestionKind;
  title: string;
  /** The evidence, in words: what was said and when, or what the task is waiting for. */
  why: string;
  evidence: { memoryId?: string; goalId?: string; taskId?: string };
  action:
    | { type: "task"; goal: string; project: string | null }
    | { type: "confirm-memory"; memoryId: string }
    | { type: "open-task"; taskId: string };
  /** Under "act" the assistant may start this itself: it only reads, and it rests on something the user said in a project. */
  autonomous: boolean;
}

const DAY = 86_400_000;
const DISMISS_MS = 7 * DAY;
const GOAL_IDLE_MS = 7 * DAY;
/** The most tasks the assistant starts on its own in a day: initiative is bounded like everything else. */
export const AUTO_START_PER_DAY = 2;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function short(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function suggest(deps: { memory: MemoryStore; tasks: TaskStore; profile: AssistantProfile; now: number }): Suggestion[] {
  const { memory, tasks, profile, now } = deps;
  const out: Suggestion[] = [];
  const dismissed = (id: string): boolean => {
    const at = memory.getMeta(`dismissed:${id}`);
    return at !== null && now - Number(at) < DISMISS_MS;
  };

  for (const task of tasks.byStatus(["blocked", "unverified"])) {
    out.push({
      id: `task-needs-you:${task.id}`, kind: "task-needs-you", title: `${task.title} needs you`, why: task.reason,
      evidence: { taskId: task.id }, action: { type: "open-task", taskId: task.id }, autonomous: false,
    });
  }
  // Under "ask" the assistant starts nothing and proposes no new work: it only says what is waiting on the user.
  if (profile.autonomy !== "ask") {
    const active = memory.list({ status: "active", limit: 200 }).items;
    for (const item of active) {
      if (isDueSoon(item, now) && item.dueAt !== null) {
        const days = Math.ceil((item.dueAt - now) / DAY);
        const when = days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`;
        const project = item.scope.kind === "project" ? item.scope.key : null;
        out.push({
          id: `due-commitment:${item.id}`, kind: "due-commitment", title: `${short(item.text, 90)} (${when})`,
          why: `You said on ${isoDay(item.observedAt)}: "${short(item.text)}"`, evidence: { memoryId: item.id },
          action: { type: "task", goal: `Gather what is needed for this, and report what is ready and what is missing: ${item.text}`, project },
          autonomous: project !== null,
        });
      } else if (isStale(item, now)) {
        out.push({
          id: `stale-memory:${item.id}`, kind: "stale-memory", title: `Still true? ${short(item.text, 100)}`,
          why: `Saved ${isoDay(item.observedAt)}, last confirmed ${isoDay(item.lastConfirmedAt)}. It is about something that changes.`,
          evidence: { memoryId: item.id }, action: { type: "confirm-memory", memoryId: item.id }, autonomous: false,
        });
      }
    }
    const busy = new Set(tasks.list("all", 500).filter((t: Task) => t.goalId !== null && (now - t.updatedAt < GOAL_IDLE_MS || !["completed", "unverified", "failed", "cancelled"].includes(t.status))).map((t: Task) => t.goalId));
    for (const goal of memory.activeGoals()) {
      if (busy.has(goal.id)) continue;
      out.push({
        id: `goal-idle:${goal.id}`, kind: "goal-idle", title: `Nothing is working toward "${short(goal.text, 90)}"`,
        why: `It is one of your active goals and no task has touched it in the last 7 days.`, evidence: { goalId: goal.id },
        action: { type: "task", goal: `Read the project and draft a short plan, with the first three steps, for this goal: ${goal.text}`, project: null }, autonomous: false,
      });
    }
  }
  return out.filter((s) => !dismissed(s.id));
}

export function dismissSuggestion(memory: MemoryStore, id: string, now: number): void {
  memory.write(() => memory.run("INSERT INTO assistant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`dismissed:${id}`, String(now)]));
}

/**
 * Under "act", starts the suggestions that only read and rest on something the user said, at most a couple a day, and
 * never twice for the same thing. Returns the ids it started. Anything that would change a file is not here: it is
 * offered, and the user starts it.
 */
export function startAutonomous(deps: {
  memory: MemoryStore;
  tasks: TaskStore;
  profile: AssistantProfile;
  now: number;
  start: (suggestion: Suggestion) => Task;
}): string[] {
  const { memory, profile, now } = deps;
  if (profile.autonomy !== "act" || !profile.policy.allowReadOnly) return [];
  let room = AUTO_START_PER_DAY - deps.tasks.countOrigin("suggestion", now - DAY);
  const started: string[] = [];
  for (const s of suggest(deps)) {
    if (room <= 0) break;
    if (!s.autonomous || s.action.type !== "task" || memory.getMeta(`auto:${s.id}`) !== null) continue;
    memory.write(() => memory.run("INSERT INTO assistant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`auto:${s.id}`, String(now)]));
    try {
      deps.start(s);
      started.push(s.id);
      room -= 1;
    } catch {
      /* the limits said no; the suggestion stays listed */
    }
  }
  return started;
}
