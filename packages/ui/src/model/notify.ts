/**
 * Background notification dispatcher and throttle manager.
 * Evaluates pending system events against user focus and suppression policies.
 */

import type { AssistantWaitingView } from "../types.js";

export type NotifyPermission = "granted" | "denied" | "default";

export interface Notifier {
  permission(): Promise<NotifyPermission>;
  request(): Promise<NotifyPermission>;
  show(note: { title: string; body: string; tag: string; onClick?: () => void }): Promise<void>;
}

export interface NotifySettings {
  enabled: boolean;
  focused: boolean;
}

export type NotifyEvent =
  | { kind: "approval"; sessionId: string; thread: string }
  | { kind: "question"; sessionId: string; thread: string }
  | { kind: "finished"; sessionId: string; thread: string; failed: boolean }
  | { kind: "goal"; sessionId: string; thread: string; status: string }
  | { kind: "finishedMany"; count: number; failed: number }
  | { kind: "task"; taskId: string; cause: AssistantWaitingView["cause"]; title: string };

const SUPPRESSION_WINDOW_MS = 20_000;
const MAX_TASK_TITLE_LEN = 60;

function formatQuotedTitle(rawTitle: string): string {
  const sanitized = rawTitle.replace(/\p{C}+/gu, " ").replace(/\s+/g, " ").trim();
  if (sanitized.length === 0) {
    return "A task";
  }
  const truncated = sanitized.length > MAX_TASK_TITLE_LEN
    ? `${sanitized.substring(0, MAX_TASK_TITLE_LEN - 3)}...`
    : sanitized;
  return `"${truncated}"`;
}

function resolveTaskNotification(cause: AssistantWaitingView["cause"], label: string): { title: string; body: string } {
  const descriptions: Record<AssistantWaitingView["cause"], { title: string; body: string }> = {
    approval: { title: "The assistant needs your approval", body: `${label} is waiting for you to approve it.` },
    site: { title: "The assistant is waiting on you", body: `${label} asks before opening a site.` },
    action: { title: "The assistant is waiting on you", body: `${label} asks before it does something on a page.` },
    download: { title: "The assistant is waiting on you", body: `${label} asks where to save a file.` },
    question: { title: "The assistant is waiting on you", body: `${label} has a question for you.` },
    change: { title: "The assistant is waiting on you", body: `${label} asks before it changes something in an account.` },
    blocked: { title: "A task needs you", body: `${label} stopped and is waiting for you.` },
  };
  return descriptions[cause];
}

function eventKey(ev: NotifyEvent): string {
  if (ev.kind === "finishedMany") {
    return ev.kind;
  }
  if (ev.kind === "task") {
    return `task:${ev.taskId}`;
  }
  return `${ev.kind}:${ev.sessionId}`;
}

function buildNotificationPayload(ev: NotifyEvent): { title: string; body: string } {
  switch (ev.kind) {
    case "task":
      return resolveTaskNotification(ev.cause, formatQuotedTitle(ev.title));
    case "approval":
      return { title: "Muse is waiting on you", body: `${ev.thread} wants to run something.` };
    case "question":
      return { title: "Muse asked a question", body: `${ev.thread} is waiting for an answer.` };
    case "finished":
      return ev.failed
        ? { title: "A turn failed", body: `${ev.thread} stopped with an error.` }
        : { title: "Muse finished", body: `${ev.thread} is done.` };
    case "goal":
      return ev.status === "complete"
        ? { title: "Goal complete", body: `${ev.thread} reached its goal.` }
        : { title: "A goal needs attention", body: `${ev.thread} is ${ev.status}.` };
    case "finishedMany":
      return ev.failed > 0
        ? { title: "Threads finished", body: `${ev.count} threads ended, ${ev.failed} with an error.` }
        : { title: "Muse finished", body: `${ev.count} threads are done.` };
  }
}

export class NotificationManager {
  private readonly dispatchLog = new Map<string, number>();

  constructor(
    private readonly provider: Notifier,
    private readonly querySettings: () => NotifySettings,
    private readonly getTimestamp: () => number = () => Date.now(),
  ) {}

  async announce(event: NotifyEvent, onClick?: () => void): Promise<void> {
    const config = this.querySettings();
    if (!config.enabled || config.focused) {
      return;
    }

    const permissionStatus = await this.provider.permission();
    if (permissionStatus !== "granted") {
      return;
    }

    const dedupeKey = eventKey(event);
    const currentTime = this.getTimestamp();
    const lastDispatched = this.dispatchLog.get(dedupeKey);

    if (lastDispatched !== undefined && (currentTime - lastDispatched) < SUPPRESSION_WINDOW_MS) {
      return;
    }

    this.dispatchLog.set(dedupeKey, currentTime);

    const content = buildNotificationPayload(event);
    try {
      await this.provider.show({
        title: content.title,
        body: content.body,
        tag: dedupeKey,
        ...(onClick ? { onClick } : {}),
      });
    } catch {
      // Ignored: notification display errors do not disrupt workflow state.
    }
  }

  forget(sessionId: string): void {
    const suffix = `:${sessionId}`;
    for (const registeredKey of Array.from(this.dispatchLog.keys())) {
      if (registeredKey.endsWith(suffix)) {
        this.dispatchLog.delete(registeredKey);
      }
    }
  }
}
