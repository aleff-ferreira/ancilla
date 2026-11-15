import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, emptyFold } from "../src/model/fold.js";
import {
  groupByProject,
  groupByStatus,
  projectForCwd,
  settledEntries,
  threadStatus,
  type SidebarEntry,
} from "../src/model/status.js";
import type { LiveView, ProjectView, SessionSummary } from "../src/types.js";

const REFERENCE_BASELINE_TIME = "2026-10-01T00:00:00.000Z";

function createMockSessionSummary(
  id: string,
  overrides: Partial<SessionSummary> = {},
  liveOverrides: Partial<LiveView> | null = null,
): SessionSummary {
  return {
    sessionId: id,
    title: `Thread ${id}`,
    turnCount: 1,
    cwd: "/projects/client-portal",
    origin: "ancilla",
    titleSource: "auto",
    createdAt: REFERENCE_BASELINE_TIME,
    modelId: null,
    archived: false,
    settled: false,
    activityAt: "2026-10-02T00:00:00.000Z",
    sandboxDisabled: false,
    settledAt: null,
    accountId: null,
    unsettledAt: null,
    live: liveOverrides
      ? {
          activeTurnId: null,
          pendingApprovals: 0,
          turnStartedAt: null,
          pendingInputs: 0,
          lastError: null,
          lastTerminal: null,
          ...liveOverrides,
        }
      : null,
    ...overrides,
  };
}

describe("threadStatus priority and state resolution", () => {
  it("prioritizes user approval over input requests over running tasks in status hierarchy", () => {
    const context = { baseline: REFERENCE_BASELINE_TIME, active: false };

    assert.equal(
      threadStatus(
        createMockSessionSummary("sess_appr", {}, { pendingApprovals: 1, pendingInputs: 1, activeTurnId: "t1" }),
        context,
      ),
      "approval",
    );
    assert.equal(
      threadStatus(
        createMockSessionSummary("sess_input", {}, { pendingInputs: 1, activeTurnId: "t1" }),
        context,
      ),
      "input",
    );
    assert.equal(
      threadStatus(
        createMockSessionSummary("sess_running", {}, { activeTurnId: "t1" }),
        context,
      ),
      "running",
    );
  });

  it("tracks unread status for completed threads until viewed by the developer", () => {
    const completedSession = createMockSessionSummary("sess_done", {}, { lastTerminal: "completed" });

    assert.equal(
      threadStatus(completedSession, { baseline: REFERENCE_BASELINE_TIME, active: false }),
      "unread",
    );
    assert.equal(
      threadStatus(completedSession, {
        baseline: REFERENCE_BASELINE_TIME,
        lastSeen: "2026-10-03T00:00:00.000Z",
        active: false,
      }),
      "idle",
    );
    assert.equal(
      threadStatus(completedSession, {
        baseline: "2026-10-05T00:00:00.000Z",
        active: false,
      }),
      "idle",
    );
    assert.equal(
      threadStatus(completedSession, { baseline: REFERENCE_BASELINE_TIME, active: true }),
      "idle",
    );

    const failedSession = createMockSessionSummary("sess_err", {}, { lastTerminal: "failed" });
    assert.equal(
      threadStatus(failedSession, { baseline: REFERENCE_BASELINE_TIME, active: false }),
      "failed",
    );
  });

  it("ensures live transcript state takes precedence over daemon summary", () => {
    const sessionWithOldTurn = createMockSessionSummary("sess_sync", {}, { activeTurnId: "turn_stale" });
    const completedTurnFold = applyEvent(emptyFold(), {
      method: "turn/completed",
      params: { turnId: "turn_stale", terminal: "completed" },
    });

    assert.equal(
      threadStatus(sessionWithOldTurn, {
        fold: completedTurnFold,
        baseline: "2026-10-05T00:00:00.000Z",
        active: false,
      }),
      "idle",
    );
  });
});

describe("Sidebar project thread grouping and status partitioning", () => {
  const mockProjects: ProjectView[] = [
    {
      cwd: "/projects/client-portal",
      displayName: "client-portal",
      pinned: false,
      activityAt: REFERENCE_BASELINE_TIME,
      defaultAccountId: null,
      folders: [{ cwd: "/projects/client-portal", displayName: "client-portal" }],
    },
    {
      cwd: "/projects/api-service",
      displayName: "api-service",
      pinned: false,
      activityAt: REFERENCE_BASELINE_TIME,
      defaultAccountId: null,
      folders: [
        { cwd: "/projects/api-service", displayName: "api-service" },
        { cwd: "/projects/api-service/docs", displayName: "docs" },
      ],
    },
  ];

  const mockEntries: SidebarEntry[] = [
    {
      session: createMockSessionSummary("old_active", {
        createdAt: "2026-10-01T01:00:00.000Z",
        activityAt: "2026-10-09T00:00:00.000Z",
      }),
      status: "idle",
    },
    {
      session: createMockSessionSummary("new_active", {
        createdAt: "2026-10-04T00:00:00.000Z",
      }),
      status: "unread",
    },
    {
      session: createMockSessionSummary("in_progress", {
        createdAt: "2026-10-01T00:30:00.000Z",
      }),
      status: "running",
    },
    {
      session: createMockSessionSummary("resumed_thread", {
        createdAt: "2026-09-01T00:00:00.000Z",
        unsettledAt: "2026-10-05T00:00:00.000Z",
      }),
      status: "idle",
    },
    {
      session: createMockSessionSummary("shelved_recent", {
        settled: true,
        settledAt: "2026-10-03T00:00:00.000Z",
      }),
      status: "idle",
    },
    {
      session: createMockSessionSummary("shelved_older", {
        settled: true,
        settledAt: "2026-10-02T00:00:00.000Z",
      }),
      status: "idle",
    },
    {
      session: createMockSessionSummary(
        "resumed_with_approval",
        { settled: true, settledAt: "2026-10-02T00:00:00.000Z" },
        { pendingApprovals: 1 },
      ),
      status: "approval",
    },
    {
      session: createMockSessionSummary("api_thread_1", { cwd: "/projects/api-service" }),
      status: "idle",
    },
    {
      session: createMockSessionSummary("api_docs_thread", {
        cwd: "/projects/api-service/docs",
        createdAt: "2026-10-05T00:00:00.000Z",
      }),
      status: "running",
    },
    {
      session: createMockSessionSummary("unmapped_project_thread", { cwd: "/projects/external-tool" }),
      status: "idle",
    },
  ];

  it("groups active project threads stably while archiving settled sessions", () => {
    const groups = groupByProject(mockProjects, mockEntries);
    assert.deepEqual(
      groups.map((g) => g.project.cwd),
      ["/projects/client-portal", "/projects/api-service"],
    );

    assert.deepEqual(
      groups[0]?.entries.map((e) => e.session.sessionId),
      ["resumed_thread", "new_active", "old_active", "in_progress", "resumed_with_approval"],
    );
    assert.deepEqual(
      groups[0]?.settled.map((e) => e.session.sessionId),
      ["shelved_recent", "shelved_older"],
    );
    assert.equal(groups[0]?.attention, 1);
    assert.equal(groups[0]?.running, 1);

    assert.deepEqual(
      groups[1]?.entries.map((e) => e.session.sessionId),
      ["api_docs_thread", "api_thread_1"],
    );
    assert.equal(groups[1]?.running, 1);
  });

  it("resolves project ownership for base folders and attached subdirectories", () => {
    assert.equal(projectForCwd(mockProjects, "/projects/api-service/docs")?.cwd, "/projects/api-service");
    assert.equal(projectForCwd(mockProjects, "/projects/api-service")?.cwd, "/projects/api-service");
    assert.equal(projectForCwd(mockProjects, "/projects/client-portal")?.cwd, "/projects/client-portal");
    assert.equal(projectForCwd(mockProjects, "/projects/external-tool"), null);
    assert.equal(projectForCwd(mockProjects, null), null);
  });

  it("partitions entries by status categories while segregating shelved items", () => {
    const nonRunningEntries = mockEntries.filter((e) => e.status !== "running");
    const statusGroups = groupByStatus(nonRunningEntries);

    assert.deepEqual(
      statusGroups.map((g) => g.id),
      ["attention", "review", "idle"],
    );
    assert.deepEqual(
      statusGroups[0]?.entries.map((e) => e.session.sessionId),
      ["resumed_with_approval"],
    );
    assert.deepEqual(
      statusGroups[2]?.entries.map((e) => e.session.sessionId),
      ["resumed_thread", "old_active", "api_thread_1", "unmapped_project_thread"],
    );

    assert.deepEqual(
      settledEntries(mockEntries).map((e) => e.session.sessionId),
      ["shelved_recent", "shelved_older"],
    );
  });
});
