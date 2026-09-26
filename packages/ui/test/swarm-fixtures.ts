import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, type AppState, type ThreadState } from "../src/model/store.js";
import type { LiveView, ProjectView, SessionSummary, ViewEvent, WorkflowChild } from "../src/types.js";

/** Shared fixtures for the ambient surfaces: a run two agents wide, a background task and an approval, in one thread. */

/** The run started at 14:02:00; every time below is seconds into it. */
export const T0 = Date.UTC(2026, 8, 26, 14, 2, 0);
export const at = (seconds: number): number => T0 + seconds * 1000;
export const NOW = at(80);

export const RUN_NAME = "offline-sync-research-design";
export const TASK_COMMAND = "npm run docs:build";
export const APPROVAL_COMMAND = "npm test -- --run conflict";

const SCRIPT = `export default async function workflow(host) {
  await host.parallel([{ label: "research:notes", input: "Read the notes." }, { label: "judge:perf", input: "Judge it." }]);
}`;

export const LIVE: LiveView = { activeTurnId: "t1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null };

export function session(id: string, title: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id, cwd: "/work/lantern", title, titleSource: "auto", turnCount: 3, modelId: null, origin: "ancilla",
    archived: false, createdAt: "2026-09-26T13:00:00.000Z", activityAt: "2026-09-26T14:03:00.000Z", settled: false, settledAt: null,
    unsettledAt: null, sandboxDisabled: false, accountId: null, live: LIVE, ...extra,
  };
}

export const PROJECT: ProjectView = { cwd: "/work/lantern", displayName: "lantern", pinned: false, activityAt: "2026-09-26T14:03:00.000Z", defaultAccountId: null };

function workflowItem(revision: number, children: WorkflowChild[], when: number): ViewEvent {
  return {
    method: revision === 1 ? "item/started" : "item/updated",
    at: when,
    params: {
      item: {
        itemId: "wf", kind: "workflow", status: "inProgress", revision, turnId: "t1", workflowRunId: "workflow-run-model-tool-call1",
        entryId: RUN_NAME, recordedAt: new Date(when).toISOString(), children,
      },
    },
  };
}

/** The launch and the run at 66 s: research landed, judge under way. */
export function runEvents(): ViewEvent[] {
  return [
    {
      method: "item/completed",
      at: at(0),
      params: {
        item: {
          itemId: "launch", kind: "toolCall", status: "completed", revision: 1, turnId: "t1", tool: "workflow", callId: "call1",
          args: JSON.stringify({ name: RUN_NAME, script: SCRIPT }),
        },
      },
    },
    workflowItem(1, [{ childId: "a", attempt: 1, status: "scheduled", label: "research:notes" }, { childId: "b", attempt: 1, status: "scheduled", label: "judge:perf" }], at(4)),
    workflowItem(2, [{ childId: "a", attempt: 1, status: "started" }, { childId: "b", attempt: 1, status: "started" }], at(6)),
    workflowItem(3, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed", durationMs: 60_000 }, { childId: "b", attempt: 1, status: "started" }], at(66)),
  ];
}

/** A background shell task that has printed two lines. */
export function taskEvents(status = "inProgress"): ViewEvent[] {
  return [
    {
      method: status === "inProgress" ? "item/started" : "item/completed",
      at: at(10),
      params: {
        item: {
          itemId: "task-1", kind: "toolCall", status, revision: 1, turnId: "t1", tool: "shell", background: true,
          args: JSON.stringify({ command: TASK_COMMAND }), recordedAt: new Date(at(10)).toISOString(), visibleOutput: "building\n12 pages",
        },
      },
    },
  ];
}

export function approvalEvents(): ViewEvent[] {
  return [
    {
      method: "approval/requested",
      at: at(70),
      params: { approvalId: "ap-1", sessionId: "s1", availableChoices: [], currentRequirementId: null, subject: { kind: "shell", command: APPROVAL_COMMAND } },
    },
  ];
}

export function branchEvents(branch: string): ViewEvent[] {
  return [{ method: "session/branchChanged", at: at(0), params: { branch } }];
}

export function fold(events: ViewEvent[]): ThreadFold {
  return applyEvents(emptyFold(), events);
}

export function thread(f: ThreadFold, extra: Partial<ThreadState> = {}): ThreadState {
  return { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: f, attachments: [], shellRuns: [], stalled: false, ...extra };
}

export function appState(extra: Partial<AppState> = {}): AppState {
  return { ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open", sessionsLoaded: true, projects: [PROJECT], ...extra };
}
