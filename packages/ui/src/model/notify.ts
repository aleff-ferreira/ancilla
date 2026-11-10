/**
 * Telling the user something happened while they were looking elsewhere. The shell supplies the
 * notifier: a browser has the Notifications API, a desktop shell has whatever its OS ships. Nothing
 * here touches either, so the decision of what is worth announcing stays testable on its own.
 */

import type { AssistantWaitingView } from "../types.js";

export type NotifyPermission = "granted" | "denied" | "default";

export interface Notifier {
  /** What the user has already decided, without asking them again. */
  permission(): Promise<NotifyPermission>;
  /** Asks once. Browsers only honour this from a real user gesture, which is why it is not automatic. */
  request(): Promise<NotifyPermission>;
  /** `onClick` is what pressing the notice does, for a shell that can hear it; one that cannot just brings the window forward. */
  show(note: { title: string; body: string; tag: string; onClick?: () => void }): Promise<void>;
}

export interface NotifySettings {
  /** The user's switch. Off means nothing is raised, whatever happens. */
  enabled: boolean;
  /** True while the window has their attention: there is nothing to tell someone who is watching. */
  focused: boolean;
}

/** Something that happened in a thread which might be worth interrupting someone for. */
export type NotifyEvent =
  | { kind: "approval"; sessionId: string; thread: string }
  | { kind: "question"; sessionId: string; thread: string }
  | { kind: "finished"; sessionId: string; thread: string; failed: boolean }
  | { kind: "goal"; sessionId: string; thread: string; status: string }
  /** Several turns that ended while the app was not hearing the stream, said once instead of once each. */
  | { kind: "finishedMany"; count: number; failed: number }
  /** An assistant task stopped for the person: an approval, a web task's question, a task that asks what to do. */
  | { kind: "task"; taskId: string; cause: AssistantWaitingView["cause"]; title: string };

/** One thread flapping between states should not buzz over and over. */
const REPEAT_MS = 20_000;

/** The most of a task's name a notice carries: it can be read on a lock screen, and it is only a name. */
const TASK_NAME_MAX = 60;

/** A task's name as one short line in quotes: no control characters, no breaks, and nothing but the name. */
function quotedName(title: string): string {
  const line = title.replace(/\p{C}+/gu, " ").replace(/\s+/g, " ").trim();
  if (line === "") {
    return "A task";
  }
  return `"${line.length > TASK_NAME_MAX ? `${line.slice(0, TASK_NAME_MAX - 3)}...` : line}"`;
}

function taskCopy(cause: AssistantWaitingView["cause"], name: string): { title: string; body: string } {
  switch (cause) {
    case "approval":
      return { title: "The assistant needs your approval", body: `${name} is waiting for you to approve it.` };
    case "site":
      return { title: "The assistant is waiting on you", body: `${name} asks before opening a site.` };
    case "action":
      return { title: "The assistant is waiting on you", body: `${name} asks before it does something on a page.` };
    case "download":
      return { title: "The assistant is waiting on you", body: `${name} asks where to save a file.` };
    case "question":
      return { title: "The assistant is waiting on you", body: `${name} has a question for you.` };
    case "blocked":
      return { title: "A task needs you", body: `${name} stopped and is waiting for you.` };
  }
}

function tagOf(event: NotifyEvent): string {
  switch (event.kind) {
    case "finishedMany":
      return event.kind;
    case "task":
      return `task:${event.taskId}`;
    default:
      return `${event.kind}:${event.sessionId}`;
  }
}

function copy(event: NotifyEvent): { title: string; body: string } {
  switch (event.kind) {
    case "task":
      return taskCopy(event.cause, quotedName(event.title));
    case "approval":
      return { title: "Muse is waiting on you", body: `${event.thread} wants to run something.` };
    case "question":
      return { title: "Muse asked a question", body: `${event.thread} is waiting for an answer.` };
    case "finished":
      return event.failed
        ? { title: "A turn failed", body: `${event.thread} stopped with an error.` }
        : { title: "Muse finished", body: `${event.thread} is done.` };
    case "goal":
      return event.status === "complete"
        ? { title: "Goal complete", body: `${event.thread} reached its goal.` }
        : { title: "A goal needs attention", body: `${event.thread} is ${event.status}.` };
    case "finishedMany":
      return event.failed > 0
        ? { title: "Threads finished", body: `${event.count} threads ended, ${event.failed} with an error.` }
        : { title: "Muse finished", body: `${event.count} threads are done.` };
  }
}

/**
 * Decides what actually reaches the user. Everything is dropped while the window is focused or the
 * switch is off, nothing is raised without permission already granted, and the same thread saying
 * the same thing twice in quick succession is said once.
 */
export class NotificationManager {
  private readonly shown = new Map<string, number>();

  constructor(
    private readonly notifier: Notifier,
    private readonly settings: () => NotifySettings,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `onClick` is where pressing the notice should lead, when the shell can hear a press. */
  async announce(event: NotifyEvent, onClick?: () => void): Promise<void> {
    const { enabled, focused } = this.settings();
    if (!enabled || focused) {
      return;
    }
    // Never asks here: a browser only grants permission from a user gesture, so the settings page asks.
    if ((await this.notifier.permission()) !== "granted") {
      return;
    }
    const tag = tagOf(event);
    const at = this.now();
    if (at - (this.shown.get(tag) ?? Number.NEGATIVE_INFINITY) < REPEAT_MS) {
      return;
    }
    this.shown.set(tag, at);
    const { title, body } = copy(event);
    try {
      await this.notifier.show({ title, body, tag, ...(onClick ? { onClick } : {}) });
    } catch {
      // A notifier that refuses is not worth breaking a turn over.
    }
  }

  /** Lets a thread (or a task, by its id) announce itself again, once the user has dealt with whatever it said. */
  forget(sessionId: string): void {
    for (const key of [...this.shown.keys()]) {
      if (key.endsWith(`:${sessionId}`)) {
        this.shown.delete(key);
      }
    }
  }
}
