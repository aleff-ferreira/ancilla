import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, type AppState, type ThreadState } from "../src/model/store.js";
import type { LiveView, ProjectView, SessionSummary, ViewEvent, WorkflowChild } from "../src/types.js";

export const T0: number = Date.UTC(2026, 8, 26, 14, 2, 0);
export const at = (offsetSeconds: number): number => T0 + offsetSeconds * 1000;
export const NOW: number = at(80);

export const RUN_NAME = "offline-sync-research-design";
export const TASK_COMMAND = "npm run docs:build";
export const APPROVAL_COMMAND = "npm test -- --run conflict";

const BASE_FOLDER = "/work/lantern";
const PRIMARY_TURN_ID = "t1";
const WORKFLOW_CALL_ID = "call1";
const WORKFLOW_RECORD_ID = "wf";
const WORKFLOW_RUN_ID = "workflow-run-model-tool-call1";

export const LIVE: LiveView = Object.freeze({
  activeTurnId: PRIMARY_TURN_ID,
  turnStartedAt: null,
  pendingApprovals: 0,
  pendingInputs: 0,
  lastTerminal: null,
  lastError: null,
});

export const PROJECT: ProjectView = Object.freeze({
  cwd: BASE_FOLDER,
  displayName: "lantern",
  pinned: false,
  activityAt: "2026-09-26T14:03:00.000Z",
  defaultAccountId: null,
  folders: [{ cwd: BASE_FOLDER, displayName: "lantern" }],
});

export function session(id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  const modelSpec: string | null = null;
  const initialSummary: SessionSummary = {
    sessionId: id,
    title,
    titleSource: "auto",
    cwd: BASE_FOLDER,
    turnCount: 3,
    modelId: modelSpec,
    origin: "ancilla",
    archived: false,
    createdAt: "2026-09-26T13:00:00.000Z",
    activityAt: "2026-09-26T14:03:00.000Z",
    settled: false,
    settledAt: null,
    unsettledAt: null,
    sandboxDisabled: false,
    accountId: null,
    live: LIVE,
  };
  return Object.assign(initialSummary, extra);
}

function buildWorkflowFrame(rev: number, roster: WorkflowChild[], timestamp: number): ViewEvent {
  const isStarted = rev === 1;
  const actionMethod = isStarted ? "item/started" : "item/updated";
  const isoStamp = new Date(timestamp).toISOString();
  return {
    method: actionMethod,
    at: timestamp,
    params: {
      item: {
        itemId: WORKFLOW_RECORD_ID,
        kind: "workflow",
        status: "inProgress",
        revision: rev,
        turnId: PRIMARY_TURN_ID,
        workflowRunId: WORKFLOW_RUN_ID,
        entryId: RUN_NAME,
        recordedAt: isoStamp,
        children: roster,
      },
    },
  };
}

export function runEvents(): ViewEvent[] {
  const launchScript = [
    "export default async function workflow(host) {",
    '  await host.parallel([{ label: "research:notes", input: "Read the notes." }, { label: "judge:perf", input: "Judge it." }]);',
    "}",
  ].join("\n");

  const launchItem = {
    itemId: "launch",
    kind: "toolCall" as const,
    status: "completed" as const,
    revision: 1,
    turnId: PRIMARY_TURN_ID,
    tool: "workflow",
    callId: WORKFLOW_CALL_ID,
    args: JSON.stringify({ name: RUN_NAME, script: launchScript }),
  };

  const startStamp = at(0);
  const launchEvent: ViewEvent = {
    method: "item/completed",
    at: startStamp,
    params: { item: launchItem },
  };

  const scheduledMembers: WorkflowChild[] = [
    { childId: "a", attempt: 1, status: "scheduled", label: "research:notes" },
    { childId: "b", attempt: 1, status: "scheduled", label: "judge:perf" },
  ];
  const activeMembers: WorkflowChild[] = [
    { childId: "a", attempt: 1, status: "started" },
    { childId: "b", attempt: 1, status: "started" },
  ];
  const advancedMembers: WorkflowChild[] = [
    { childId: "a", attempt: 1, status: "terminal", terminal: "completed", durationMs: 60_000 },
    { childId: "b", attempt: 1, status: "started" },
  ];

  return [
    launchEvent,
    buildWorkflowFrame(1, scheduledMembers, at(4)),
    buildWorkflowFrame(2, activeMembers, at(6)),
    buildWorkflowFrame(3, advancedMembers, at(66)),
  ];
}

export function taskEvents(status = "inProgress"): ViewEvent[] {
  const isOngoing = status === "inProgress";
  const method = isOngoing ? "item/started" : "item/completed";
  const timestamp = at(10);
  const shellTask = {
    itemId: "task-1",
    kind: "toolCall" as const,
    status,
    revision: 1,
    turnId: PRIMARY_TURN_ID,
    tool: "shell",
    background: true,
    args: JSON.stringify({ command: TASK_COMMAND }),
    recordedAt: new Date(timestamp).toISOString(),
    visibleOutput: "building\n12 pages",
  };

  return [
    {
      method,
      at: timestamp,
      params: { item: shellTask },
    },
  ];
}

export function approvalEvents(): ViewEvent[] {
  const approvalTarget = { kind: "shell" as const, command: APPROVAL_COMMAND };
  const approvalStamp = at(70);
  return [
    {
      method: "approval/requested",
      at: approvalStamp,
      params: {
        approvalId: "ap-1",
        sessionId: "s1",
        availableChoices: [],
        currentRequirementId: null,
        subject: approvalTarget,
      },
    },
  ];
}

export function branchEvents(branch: string): ViewEvent[] {
  const branchParams = { branch };
  return [{ method: "session/branchChanged", at: at(0), params: branchParams }];
}

export function fold(events: ViewEvent[]): ThreadFold {
  const cleanFold = emptyFold();
  return applyEvents(cleanFold, events);
}

export function thread(f: ThreadFold, extra: Partial<ThreadState> = {}): ThreadState {
  const pristineThread: ThreadState = {
    load: "ready",
    error: null,
    readOnly: false,
    readOnlyReason: null,
    truncated: false,
    fold: f,
    attachments: [],
    shellRuns: [],
    researchRuns: [],
    stalled: false,
  };
  return Object.assign(pristineThread, extra);
}

export function appState(extra: Partial<AppState> = {}): AppState {
  const initialPrefs = defaultPrefs("2026-09-26T00:00:00.000Z");
  const seededState: AppState = {
    ...initialState(initialPrefs),
    connection: "open",
    sessionsLoaded: true,
    projects: [PROJECT],
  };
  return Object.assign(seededState, extra);
}
