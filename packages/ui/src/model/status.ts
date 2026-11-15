/**
 * Thread status categorization, navigation grouping, and lifecycle prioritization.
 * Sorts sidebar conversation entries by urgency and project association.
 */

import type { ProjectView, SessionSummary } from "../types.js";
import type { ThreadFold } from "./fold.js";

export type ThreadStatus = "approval" | "input" | "running" | "failed" | "unread" | "idle";

export const STATUS_PRIORITY: Record<ThreadStatus, number> = Object.freeze({
  approval: 0,
  input: 1,
  running: 2,
  failed: 3,
  unread: 4,
  idle: 5,
});

export const STATUS_LABEL: Record<ThreadStatus, string> = Object.freeze({
  approval: "Needs approval",
  input: "Needs your answer",
  running: "Working",
  failed: "Failed",
  unread: "Done, not seen yet",
  idle: "Idle",
});

export interface StatusContext {
  readonly fold?: ThreadFold | null;
  readonly lastSeen?: string | null;
  readonly baseline: string;
  readonly active: boolean;
}

export function threadStatus(session: SessionSummary, ctx: StatusContext): ThreadStatus {
  const activeFold = ctx.fold ?? null;

  const approvalCount = activeFold
    ? Object.keys(activeFold.approvals).length
    : (session.live?.pendingApprovals ?? 0);
  if (approvalCount > 0) {
    return "approval";
  }

  const inputCount = activeFold
    ? Object.keys(activeFold.userInputs).length
    : (session.live?.pendingInputs ?? 0);
  if (inputCount > 0) {
    return "input";
  }

  const hasRunningTurn = activeFold
    ? activeFold.activeTurnId !== null
    : Boolean(session.live?.activeTurnId);
  if (hasRunningTurn) {
    return "running";
  }

  if (ctx.active) {
    return "idle";
  }

  const effectiveBaseline = ctx.lastSeen && ctx.lastSeen > ctx.baseline
    ? ctx.lastSeen
    : ctx.baseline;

  if (session.activityAt > effectiveBaseline) {
    return session.live?.lastTerminal === "failed" ? "failed" : "unread";
  }

  return "idle";
}

export function isLive(status: ThreadStatus): boolean {
  return status === "approval" || status === "input" || status === "running";
}

export interface SidebarEntry {
  readonly session: SessionSummary;
  readonly status: ThreadStatus;
}

export function isSettled(entry: SidebarEntry): boolean {
  return Boolean(entry.session.settled) && !isLive(entry.status);
}

function compareActiveEntries(a: SidebarEntry, b: SidebarEntry): number {
  const timeA = a.session.unsettledAt && a.session.unsettledAt > a.session.createdAt
    ? a.session.unsettledAt
    : a.session.createdAt;
  const timeB = b.session.unsettledAt && b.session.unsettledAt > b.session.createdAt
    ? b.session.unsettledAt
    : b.session.createdAt;
  return timeB.localeCompare(timeA);
}

function compareSettledEntries(a: SidebarEntry, b: SidebarEntry): number {
  const timeA = a.session.settledAt || a.session.activityAt;
  const timeB = b.session.settledAt || b.session.activityAt;
  return timeB.localeCompare(timeA);
}

export interface ProjectGroup {
  readonly project: ProjectView;
  readonly entries: SidebarEntry[];
  readonly settled: SidebarEntry[];
  readonly attention: number;
  readonly running: number;
}

export function projectForCwd(
  projects: ProjectView[],
  cwd: string | null | undefined,
): ProjectView | null {
  if (!cwd) {
    return null;
  }
  for (const proj of projects) {
    if (proj.cwd === cwd) {
      return proj;
    }
    if (proj.folders && proj.folders.some((f) => f.cwd === cwd)) {
      return proj;
    }
  }
  return null;
}

export function groupByProject(projects: ProjectView[], entries: SidebarEntry[]): ProjectGroup[] {
  const cwdToRoot = new Map<string, string>();
  const bucketStorage = new Map<string, SidebarEntry[]>();

  for (const item of projects) {
    cwdToRoot.set(item.cwd, item.cwd);
    bucketStorage.set(item.cwd, []);
    for (const nestedFolder of item.folders) {
      cwdToRoot.set(nestedFolder.cwd, item.cwd);
    }
  }

  for (const e of entries) {
    const parentPath = cwdToRoot.get(e.session.cwd);
    if (parentPath !== undefined) {
      bucketStorage.get(parentPath)?.push(e);
    }
  }

  return projects.map((targetProject) => {
    const grouped = bucketStorage.get(targetProject.cwd) || [];
    const activeEntries: SidebarEntry[] = [];
    const settledEntriesList: SidebarEntry[] = [];
    let attentionCount = 0;
    let runningCount = 0;

    for (const candidate of grouped) {
      if (isSettled(candidate)) {
        settledEntriesList.push(candidate);
      } else {
        activeEntries.push(candidate);
        if (candidate.status === "approval" || candidate.status === "input") {
          attentionCount += 1;
        } else if (candidate.status === "running") {
          runningCount += 1;
        }
      }
    }

    activeEntries.sort(compareActiveEntries);
    settledEntriesList.sort(compareSettledEntries);

    return {
      project: targetProject,
      entries: activeEntries,
      settled: settledEntriesList,
      attention: attentionCount,
      running: runningCount,
    };
  });
}

export type StatusGroupId = "attention" | "running" | "review" | "idle";

export interface StatusGroup {
  readonly id: StatusGroupId;
  readonly label: string;
  readonly entries: SidebarEntry[];
}

const STATUS_GROUPS: readonly {
  readonly id: StatusGroupId;
  readonly label: string;
  readonly statuses: readonly ThreadStatus[];
}[] = [
  { id: "attention", label: "Needs you", statuses: ["approval", "input"] },
  { id: "running", label: "Working", statuses: ["running"] },
  { id: "review", label: "Ready for review", statuses: ["failed", "unread"] },
  { id: "idle", label: "Idle", statuses: ["idle"] },
];

export function groupByStatus(entries: SidebarEntry[]): StatusGroup[] {
  const activeOnly = entries.filter((e) => !isSettled(e));
  const resultCategories: StatusGroup[] = [];

  for (const groupMeta of STATUS_GROUPS) {
    const matched = activeOnly.filter((item) => groupMeta.statuses.includes(item.status));
    if (matched.length > 0) {
      matched.sort((first, second) => {
        const priorityDelta = STATUS_PRIORITY[first.status] - STATUS_PRIORITY[second.status];
        return priorityDelta !== 0 ? priorityDelta : compareActiveEntries(first, second);
      });
      resultCategories.push({
        id: groupMeta.id,
        label: groupMeta.label,
        entries: matched,
      });
    }
  }

  return resultCategories;
}

export function settledEntries(entries: SidebarEntry[]): SidebarEntry[] {
  return entries.filter(isSettled).sort(compareSettledEntries);
}
