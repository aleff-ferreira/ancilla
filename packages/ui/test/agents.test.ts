import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentActivityView } from "../src/model/agents.js";
import { applyEvents, emptyFold, foldFromLoad } from "../src/model/fold.js";
import type { MspItem, TranscriptLoad, WorkflowChild } from "../src/types.js";

function workflow(children: WorkflowChild[], extra: Partial<MspItem> = {}): MspItem {
  return { itemId: "workflow-1", kind: "workflow", revision: 1, status: "inProgress", turnId: "turn-1", workflowRunId: "run-1", children, ...extra };
}

function subagent(id: string, extra: Partial<MspItem> = {}): MspItem {
  return { itemId: `subagent-${id}`, kind: "subagent", revision: 1, status: "inProgress", turnId: "turn-1", subagentId: id, ...extra };
}

function child(id: string, status: string, extra: Partial<WorkflowChild> = {}): WorkflowChild {
  return { childId: id, attempt: 1, status, ...extra };
}

function fold(...items: MspItem[]) {
  return applyEvents(emptyFold(), items.map((item) => ({ method: "item/updated", params: { item } })));
}

function load(...items: MspItem[]): TranscriptLoad {
  return {
    session: null, msp: null, truncated: true, readOnly: false, readOnlyReason: null,
    pending: { approvals: [], userInputs: [] },
    events: items.map((item) => ({ method: "item/updated", params: { item } })),
  };
}

function payload(agents: { agent: string; duration_ms?: number; tool_calls?: number }[]): string {
  return `<workflow-launch-reconciled>${JSON.stringify({ agents_activity: agents, final_summary: { status: "completed", summary: "The pairs agree; sum = 42." } })}</workflow-launch-reconciled>`;
}

describe("agentActivityView", () => {
  it("has no agents until the stream reports actual children", () => {
    const view = agentActivityView(fold(
      workflow([]),
      { itemId: "reminder", kind: "reminderChild", revision: 1, status: "inProgress", childSessionId: "memory", reminderAgentId: "memory-reminder" },
      { itemId: "launch", kind: "toolCall", revision: 1, status: "completed", tool: "workflow", args: JSON.stringify({ objective: "Launch four agents" }) },
    ));
    assert.deepEqual(view, { agents: [], total: 0, working: 0, waiting: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 });
  });

  it("projects the native five-child workflow with honest labels, status, and totals", () => {
    const ids = [
      "01a0dbae-727a-7543-b502-a584a609ad8b",
      "01a0dbae-72bf-7cb1-84a2-da91875329f1",
      "01a0dbae-736e-7a23-a41f-910153b1fb39",
      "01a0dbae-7417-7393-aa84-1772b37cc031",
      "01a0dbae-abd5-7f03-b343-0122881cd74d",
    ];
    const labels = ["read-alpha", "read-beta", "verify-alpha", "verify-beta", "synthesis-sum"];
    const scheduled = workflow(ids.map((id, index) => child(id, "scheduled", { label: labels[index] })));
    const live = workflow(ids.map((id, index) => child(id, index < 4 ? "terminal" : "usage", index < 4 ? { terminal: "completed", durationMs: 8000 } : {})), { revision: 24 });
    const view = agentActivityView(fold(scheduled, live));
    assert.equal(view.total, 5);
    assert.equal(view.working, 1);
    assert.equal(view.completed, 4);
    assert.equal(view.agents[0].name, "Synthesis sum");
    assert.equal(view.agents[0].id, ids[4]);
    assert.ok(view.agents.every((agent) => agent.objective === null && agent.activity === null));

    const final = workflow(ids.map((id) => child(id, "terminal", { terminal: "completed", durationMs: 8000 })), {
      revision: 27,
      status: "completed",
      message: payload(ids.map((id, index) => ({ agent: id, duration_ms: 8000, tool_calls: index === 4 ? 5 : 1 }))),
    });
    const complete = agentActivityView(fold(scheduled, live, final));
    assert.equal(complete.completed, 5);
    assert.equal(complete.working, 0);
    assert.equal(complete.agents.reduce((total, agent) => total + (agent.toolCalls ?? 0), 0), 9);
    assert.deepEqual(complete.agents.map((agent) => agent.name).sort(), ["Read alpha", "Read beta", "Verify alpha", "Verify beta", "Synthesis sum"].sort());
  });

  it("distinguishes queued, active, completed, failed, stopped, and unrecognized states", () => {
    const view = agentActivityView(fold(workflow([
      child("queued", "scheduled"), child("paused", "paused"), child("running", "started"), child("usage", "usage"),
      child("done", "terminal", { terminal: "completed" }), child("direct-done", "completed"),
      child("failed", "terminal", { terminal: "timedOut" }), child("cancelled", "terminal", { terminal: "cancelled" }),
      child("unknown", "futureLifecycleState"), child("terminal-unknown", "terminal"),
    ])));
    assert.equal(view.waiting, 2);
    assert.equal(view.working, 2);
    assert.equal(view.completed, 2);
    assert.equal(view.failed, 1);
    assert.equal(view.stopped, 1);
    assert.equal(view.unknown, 2);
    assert.deepEqual(view.agents.map((agent) => agent.status), ["working", "working", "waiting", "waiting", "unknown", "unknown", "failed", "stopped", "completed", "completed"]);
  });

  it("counts a workflow child and its standalone item once, combining explicit metadata", () => {
    const view = agentActivityView(fold(
      workflow([child("reader", "started", { label: "Read alpha" })], { recordedAt: "2026-09-25T12:00:00Z", message: payload([{ agent: "reader", tool_calls: 2 }]) }),
      subagent("reader", { objective: "Read alpha.txt and return its integer", role: "reader", childSessionId: "reader-session", status: "completed", durationMs: 4500, recordedAt: "2026-09-25T12:00:05Z" }),
    ));
    assert.equal(view.total, 1);
    assert.equal(view.completed, 1);
    assert.deepEqual(view.agents[0], {
      id: "reader", name: "reader", objective: "Read alpha.txt and return its integer", activity: null, status: "completed",
      source: "subagent", turnId: "turn-1", durationMs: 4500, toolCalls: 2, attempt: 1, workflowRunId: "run-1", childSessionId: "reader-session",
    });
  });

  it("deduplicates unaddressable subagent items only when an explicit session connects them", () => {
    const view = agentActivityView(fold(
      subagent("durable", { childSessionId: "session-1" }),
      subagent("other-record", { subagentId: undefined, childSessionId: "session-1", status: "completed" }),
      subagent("separate", { subagentId: undefined, childSessionId: "session-2" }),
    ));
    assert.equal(view.total, 2);
    assert.equal(view.agents.find((agent) => agent.id === "durable")?.status, "completed");
    assert.equal(view.agents.find((agent) => agent.id === "session-2")?.status, "working");
  });

  it("uses the latest retry without reviving the old failure or its task metrics", () => {
    const view = agentActivityView(fold(
      subagent("reader", { status: "failed", durationMs: 3000, role: "old assignment", toolCalls: 8, attempt: 1, recordedAt: "2026-09-25T12:10:00Z" }),
      workflow([
        child("reader", "started", { attempt: 2 }),
        child("reader", "terminal", { attempt: 1, terminal: "failed", label: "old assignment", durationMs: 3000 }),
      ], { recordedAt: "2026-09-25T12:00:00Z" }),
    ));
    assert.equal(view.total, 1);
    assert.equal(view.working, 1);
    assert.equal(view.agents[0].attempt, 2);
    assert.equal(view.agents[0].durationMs, null);
    assert.equal(view.agents[0].toolCalls, null);
    assert.equal(view.agents[0].name, "Agent 1");
  });

  it("ignores stale revisions after a later revision completes the agent", () => {
    const view = agentActivityView(fold(
      workflow([child("one", "scheduled", { label: "Check types" })]),
      workflow([child("one", "terminal", { terminal: "completed" })], { revision: 5, status: "completed" }),
      workflow([child("one", "started")], { revision: 3 }),
    ));
    assert.equal(view.completed, 1);
    assert.equal(view.agents[0].name, "Check types");
  });

  it("retains known labels across a capped history reload without retaining old status or phase", () => {
    const previous = fold(workflow([child("one", "started", { label: "read-alpha", phase: "Reading file" })]));
    const incoming = workflow([child("one", "terminal", { terminal: "completed", durationMs: 1000 })], { revision: 8, status: "completed" });
    const loaded = foldFromLoad(load(incoming), previous);
    const agent = agentActivityView(loaded).agents[0];
    assert.equal(agent.name, "Read alpha");
    assert.equal(agent.status, "completed");
    assert.equal(agent.activity, null);
    assert.equal(agent.durationMs, 1000);
    assert.equal(loaded.agentItems?.[incoming.itemId], loaded.items[incoming.itemId]);
    assert.equal(loaded.items[incoming.itemId].children?.[0].phase, undefined);
    assert.equal(previous.items[incoming.itemId].children?.[0].status, "started");
    assert.equal(incoming.children?.[0].label, undefined);
  });

  it("never resurrects omitted children or workflows or labels from another retry on reload", () => {
    const previous = fold(
      workflow([child("one", "completed", { label: "Old assignment" }), child("omitted", "completed", { label: "Gone child" })]),
      workflow([child("other", "completed", { label: "Gone workflow" })], { itemId: "old-workflow" }),
    );
    const loaded = foldFromLoad(load(workflow([child("one", "started", { attempt: 2 })], { revision: 8 })), previous);
    const view = agentActivityView(loaded);
    assert.equal(view.total, 1);
    assert.equal(view.agents[0].name, "Agent 1");
    assert.equal(view.agents[0].attempt, 2);
    assert.equal(loaded.items["old-workflow"], undefined);
    assert.deepEqual(loaded.items["workflow-1"].children?.map((entry) => entry.childId), ["one"]);
  });

  it("prefers labels reported by refreshed history over previously observed labels", () => {
    const previous = fold(workflow([child("one", "started", { label: "Old label" })]));
    const loaded = foldFromLoad(load(
      workflow([child("one", "scheduled", { label: "New label" })], { revision: 3 }),
      workflow([child("one", "completed")], { revision: 8 }),
    ), previous);
    assert.equal(agentActivityView(loaded).agents[0].name, "New label");
    assert.equal(agentActivityView(loaded).agents[0].status, "completed");
  });

  it("prefers a timestamped newer report over a stale duplicate's terminal state", () => {
    const view = agentActivityView(fold(
      workflow([child("one", "started")], { recordedAt: "2026-09-25T12:05:00Z" }),
      subagent("one", { status: "completed", recordedAt: "2026-09-25T12:00:00Z" }),
    ));
    assert.equal(view.total, 1);
    assert.equal(view.working, 1);
  });

  it("does not treat parent completion, cancellation, or an idle history load as child completion", () => {
    for (const terminal of ["completed", "cancelled", "failed"]) {
      const loaded = applyEvents(fold(workflow([child("background", "started")], { turnId: "previous" })), [
        { method: "turn/completed", params: { turnId: "previous", terminal } },
      ]);
      const view = agentActivityView(loaded);
      assert.equal(view.working, 1, terminal);
      assert.equal(view.completed, 0, terminal);
    }
  });

  it("recovers completed agents and metrics from reconciliation when child snapshots are absent", () => {
    const view = agentActivityView(fold(workflow([], {
      status: "completed", message: payload([{ agent: "one", duration_ms: 2000, tool_calls: 3 }, { agent: "two", duration_ms: 0, tool_calls: 0 }]),
    })));
    assert.equal(view.total, 2);
    assert.equal(view.completed, 2);
    assert.equal(view.working, 0);
    assert.deepEqual(view.agents.map((agent) => [agent.durationMs, agent.toolCalls]), [[2000, 3], [0, 0]]);
  });

  it("does not invent live states or individual failures from workflow totals", () => {
    for (const status of ["inProgress", "failed", "cancelled"]) {
      const view = agentActivityView(fold(workflow([], { status, message: payload([{ agent: "one", tool_calls: 2 }]) })));
      assert.equal(view.unknown, 1, status);
      assert.equal(view.working, 0, status);
      assert.equal(view.failed, 0, status);
    }
  });

  it("includes payload-only agents without losing explicitly reported child outcomes", () => {
    const view = agentActivityView(fold(workflow([child("one", "terminal", { terminal: "failed" })], {
      status: "completed", message: payload([{ agent: "one", tool_calls: 1 }, { agent: "two", tool_calls: 2 }]),
    })));
    assert.equal(view.total, 2);
    assert.equal(view.failed, 1);
    assert.equal(view.completed, 1);
  });

  it("uses child phases only as reported activity and clears them once terminal", () => {
    const active = workflow([child("one", "started", { phase: "Checking imports" })], { objective: "Build the entire application" });
    const before = agentActivityView(fold(active));
    assert.equal(before.agents[0].activity, "Checking imports");
    assert.equal(before.agents[0].objective, null);
    const after = agentActivityView(fold(active, workflow([child("one", "terminal", { terminal: "completed", phase: "Checking imports" })], { revision: 2 })));
    assert.equal(after.agents[0].activity, null);
  });

  it("uses stable numbered names for opaque identities and never treats result references as sessions", () => {
    const id = "01a0dbae-727a-7543-b502-a584a609ad8b";
    const view = agentActivityView(fold(workflow([
      child(id, "completed", { label: id, resultRef: `subagent-result://${id}/task/some-task#5` }),
      child("second", "started", { label: `Agent ${id}` }),
    ])));
    assert.deepEqual(view.agents.map((agent) => agent.name), ["Agent 2", "Agent 1"]);
    assert.ok(view.agents.every((agent) => agent.childSessionId === null));
  });

  it("humanizes machine task labels while preserving proper names and acronyms", () => {
    const view = agentActivityView(fold(workflow([
      child("one", "started", { label: "read-alpha" }),
      child("two", "started", { label: "verify_beta" }),
      child("three", "started", { label: "Review PostgreSQL APIs" }),
    ])));
    assert.deepEqual(view.agents.map((agent) => agent.name), ["Read alpha", "Verify beta", "Review PostgreSQL APIs"]);
  });

  it("sorts current work and waiting agents before history without losing historical work", () => {
    const loaded = fold(
      workflow([child("old-done", "completed"), child("old-working", "started")], { itemId: "old-run", turnId: "old-turn" }),
      workflow([child("new-working", "started"), child("new-waiting", "scheduled")], { itemId: "new-run", turnId: "current-turn" }),
    );
    loaded.activeTurnId = "current-turn";
    const view = agentActivityView(loaded);
    assert.deepEqual(view.agents.map((agent) => agent.id), ["new-working", "old-working", "new-waiting", "old-done"]);
    assert.equal(view.total, 4);
    assert.equal(view.working, 2);
    assert.equal(view.waiting, 1);
  });

  it("honors standalone control states while keeping terminal outcomes authoritative", () => {
    const view = agentActivityView(fold(
      subagent("accepted", { controlStatus: "accepted" }),
      subagent("recovery", { controlStatus: "recoveryPending" }),
      subagent("paused", { controlStatus: "paused" }),
      subagent("ready", { controlStatus: "resultReady" }),
      subagent("failed", { status: "failed", controlStatus: "running" }),
      subagent("cancelled", { status: "cancelled", controlStatus: "running" }),
    ));
    assert.equal(view.waiting, 3);
    assert.equal(view.completed, 1);
    assert.equal(view.failed, 1);
    assert.equal(view.stopped, 1);
    assert.equal(view.working, 0);
  });

  it("ignores malformed reconciliation and invalid measurements", () => {
    const view = agentActivityView(fold(workflow([child("one", "started", { durationMs: -1 })], {
      message: JSON.stringify({ agents_activity: "not an array" }),
    }), subagent("two", { durationMs: Infinity, toolCalls: NaN })));
    assert.equal(view.total, 2);
    assert.ok(view.agents.every((agent) => agent.durationMs === null && agent.toolCalls === null));
    assert.equal(agentActivityView(fold(workflow([], { message: "<workflow-launch-reconciled>{oops</workflow-launch-reconciled>" }))).total, 0);
  });
});
