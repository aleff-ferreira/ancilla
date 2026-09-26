import type { ProjectView, SessionSummary } from "../types.js";
import type { ThreadFold } from "./fold.js";

/** What a thread needs from the user right now, most urgent first. */
export type ThreadStatus = "approval" | "input" | "running" | "failed" | "unread" | "idle";

export const STATUS_PRIORITY: Record<ThreadStatus, number> = {
  approval: 0,
  input: 1,
  running: 2,
  failed: 3,
  unread: 4,
  idle: 5,
};

export const STATUS_LABEL: Record<ThreadStatus, string> = {
  approval: "Needs approval",
  input: "Needs your answer",
  running: "Working",
  failed: "Failed",
  unread: "Done, not seen yet",
  idle: "Idle",
};

export interface StatusContext {
  fold?: ThreadFold | null;
  /** When the user last looked at this thread (ISO). */
  lastSeen?: string | null;
  /** Activity before this instant counts as seen; set on first run so old history is not "unread". */
  baseline: string;
  /** The thread is open on screen. */
  active: boolean;
}

function later(a: string | null | undefined, b: string): string {
  return a && a > b ? a : b;
}

export function threadStatus(session: SessionSummary, ctx: StatusContext): ThreadStatus {
  const fold = ctx.fold ?? null;
  const approvals = fold ? Object.keys(fold.approvals).length : (session.live?.pendingApprovals ?? 0);
  if (approvals > 0) {
    return "approval";
  }
  const inputs = fold ? Object.keys(fold.userInputs).length : (session.live?.pendingInputs ?? 0);
  if (inputs > 0) {
    return "input";
  }
  const running = fold ? fold.activeTurnId !== null : Boolean(session.live?.activeTurnId);
  if (running) {
    return "running";
  }
  if (ctx.active) {
    return "idle";
  }
  if (session.activityAt > later(ctx.lastSeen, ctx.baseline)) {
    return session.live?.lastTerminal === "failed" ? "failed" : "unread";
  }
  return "idle";
}

export function isLive(status: ThreadStatus): boolean {
  return status === "approval" || status === "input" || status === "running";
}

export interface SidebarEntry {
  session: SessionSummary;
  status: ThreadStatus;
}

/** Settled threads leave the active list, unless they are busy again before the server has caught up. */
export function isSettled(entry: SidebarEntry): boolean {
  return entry.session.settled && !isLive(entry.status);
}

/**
 * Active threads keep a stable order, newest first by when they started or were brought back.
 * Activity never reshuffles them, as in T3 Code; settling and auto-settle keep the list short.
 */
function activeOrder(a: SidebarEntry, b: SidebarEntry): number {
  const keyA = later(a.session.unsettledAt, a.session.createdAt);
  const keyB = later(b.session.unsettledAt, b.session.createdAt);
  return keyA < keyB ? 1 : keyA > keyB ? -1 : 0;
}

/** Settled threads, most recently settled first. */
function settledOrder(a: SidebarEntry, b: SidebarEntry): number {
  const keyA = a.session.settledAt ?? a.session.activityAt;
  const keyB = b.session.settledAt ?? b.session.activityAt;
  return keyA < keyB ? 1 : keyA > keyB ? -1 : 0;
}

export interface ProjectGroup {
  project: ProjectView;
  /** Active threads, in their stable order. */
  entries: SidebarEntry[];
  settled: SidebarEntry[];
  attention: number;
  running: number;
}

/** The project a folder belongs to: the one whose folders include `cwd`, which is the project itself for its own folder. */
export function projectForCwd(projects: ProjectView[], cwd: string | null | undefined): ProjectView | null {
  if (!cwd) {
    return null;
  }
  return projects.find((project) => project.cwd === cwd || project.folders.some((folder) => folder.cwd === cwd)) ?? null;
}

export function groupByProject(projects: ProjectView[], entries: SidebarEntry[]): ProjectGroup[] {
  // A thread belongs to the project whose folders include the one it runs in, not only to a project's own folder.
  const buckets = new Map<string, SidebarEntry[]>();
  const owners = new Map<string, string>();
  for (const project of projects) {
    buckets.set(project.cwd, []);
    owners.set(project.cwd, project.cwd);
    for (const folder of project.folders) {
      owners.set(folder.cwd, project.cwd);
    }
  }
  for (const entry of entries) {
    const owner = owners.get(entry.session.cwd);
    if (owner !== undefined) {
      buckets.get(owner)?.push(entry);
    }
  }
  return projects.map((project) => {
    const all = buckets.get(project.cwd) ?? [];
    return {
      project,
      entries: all.filter((e) => !isSettled(e)).sort(activeOrder),
      settled: all.filter(isSettled).sort(settledOrder),
      attention: all.filter((e) => e.status === "approval" || e.status === "input").length,
      running: all.filter((e) => e.status === "running").length,
    };
  });
}

export type StatusGroupId = "attention" | "running" | "review" | "idle";

export interface StatusGroup {
  id: StatusGroupId;
  label: string;
  entries: SidebarEntry[];
}

const STATUS_GROUPS: { id: StatusGroupId; label: string; statuses: ThreadStatus[] }[] = [
  { id: "attention", label: "Needs you", statuses: ["approval", "input"] },
  { id: "running", label: "Working", statuses: ["running"] },
  { id: "review", label: "Ready for review", statuses: ["failed", "unread"] },
  { id: "idle", label: "Idle", statuses: ["idle"] },
];

/** Active threads by what they need; settled ones are left for `settledEntries`. */
export function groupByStatus(entries: SidebarEntry[]): StatusGroup[] {
  const active = entries.filter((e) => !isSettled(e));
  return STATUS_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    entries: active
      .filter((e) => group.statuses.includes(e.status))
      .sort((a, b) => (a.status !== b.status ? STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] : activeOrder(a, b))),
  })).filter((group) => group.entries.length > 0);
}

export function settledEntries(entries: SidebarEntry[]): SidebarEntry[] {
  return entries.filter(isSettled).sort(settledOrder);
}
