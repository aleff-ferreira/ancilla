import type { QuestionView } from "../browser/sites.js";
import { awaitsApproval, type Task } from "./tasks.js";

/**
 * Whether a task has stopped for the person, and why: the one place that says so. The call, the status the screens read and
 * the notification all ask here. Only what a task cannot go on without counts. A task the person paused themselves, one
 * that was switched off with the assistant, one that finished and wants a look are not waiting on anyone, and say nothing
 * out loud.
 */
export type WaitingCause =
  /** A change the voice proposed, which only a click on the screen lets run. */
  | "approval"
  /** A web task asks before opening a site. */
  | "site"
  /** A web task asks before it does something on a page that changes something. */
  | "action"
  /** A web task asks which folder a file may be saved in. */
  | "download"
  /** A web task is asking, and what the question is has just gone. */
  | "question"
  /** A task on a connected account asks before it changes something in it (a comment, a merge). */
  | "change"
  /** A task stopped and asks the person what to do. */
  | "blocked";

export interface WaitingTask {
  id: string;
  title: string;
  cause: WaitingCause;
  /** Why, as the task itself says it. It changes when the task asks something else, so a second question is not the first again. */
  reason: string;
}

/** What one status carries: a few that wait are worth naming, a crowd is a count. */
export const MAX_WAITING = 10;

/** `question` is what a web task is asking now (the runner knows), or null when it is not known. */
export function waitingCause(
  task: Pick<Task, "origin" | "status" | "startedAt" | "sessionId">,
  question: QuestionView | null,
  needsUser: ((sessionId: string) => boolean) | null = null,
): WaitingCause | null {
  if (awaitsApproval(task)) return "approval";
  if (task.status === "blocked") return "blocked";
  if (task.status === "running" && task.sessionId && needsUser?.(task.sessionId)) return "approval";
  // A connector task is only ever running, over, or paused with a change in front of the person.
  if (task.origin === "connector" && task.status === "paused") return "change";
  if (task.origin === "browse" && task.status === "paused") {
    if (!question) return "question";
    if (question.type === "site") return "site";
    return question.download ? "download" : "action";
  }
  return null;
}

/** The tasks that wait on the person among `tasks`, in the order given, at most `MAX_WAITING`. */
export function waitingTasks(
  tasks: readonly Task[],
  questionOf: (taskId: string) => QuestionView | null,
  needsUser: ((sessionId: string) => boolean) | null = null,
): WaitingTask[] {
  const out: WaitingTask[] = [];
  for (const task of tasks) {
    const cause = waitingCause(task, task.origin === "browse" ? questionOf(task.id) : null, needsUser);
    if (cause) {
      const reason = task.status === "running" && cause === "approval" ? "Waiting for your approval in the task thread." : task.reason;
      out.push({ id: task.id, title: task.title, cause, reason });
    }
    if (out.length >= MAX_WAITING) break;
  }
  return out;
}
