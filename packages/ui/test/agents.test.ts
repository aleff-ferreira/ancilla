import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentActivityView, agentFeedRecovered, agentNumbers, markAgentFeed, type AgentNumbers } from "../src/model/agents.js";
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

  it("never shows a child of a settled run as still queued or running", () => {
    for (const status of ["cancelled", "failed", "completed", "timedOut", "futureTerminal"]) {
      const view = agentActivityView(fold(workflow([
        child("stale", "started", { label: "Stale child", phase: "Reading" }), child("queued", "scheduled"),
        child("done", "terminal", { terminal: "completed" }), child("failed", "terminal", { terminal: "failed" }),
      ], { status, revision: 9 })));
      assert.deepEqual(view.agents.map((agent) => [agent.id, agent.status]).sort(), [["done", "completed"], ["failed", "failed"], ["queued", "unknown"], ["stale", "unknown"]], status);
      assert.equal(view.working + view.waiting, 0, status);
      assert.equal(view.agents.find((agent) => agent.id === "stale")?.activity, null, status);
    }
    // A later revision that only settles the run still settles what the panel says about its children.
    const progressed = agentActivityView(fold(
      workflow([child("one", "started", { label: "read-a" })], { revision: 3 }),
      workflow([child("one", "started")], { revision: 4, status: "cancelled" }),
    ));
    assert.deepEqual(progressed.agents.map((agent) => [agent.name, agent.status]), [["Read a", "unknown"]]);
    // While the run is open its children's own lifecycle stands.
    assert.equal(agentActivityView(fold(workflow([child("one", "started")]))).working, 1);
  });

  it("treats any settled standalone item status as terminal, and unrecognized ones as terminal-unknown", () => {
    const view = agentActivityView(fold(
      subagent("abandoned", { status: "abandoned", controlStatus: "running" }),
      subagent("interrupted", { status: "interrupted", controlStatus: "running" }),
      subagent("idle", { status: "interrupted" }),
      subagent("rejected", { status: "rejected", controlStatus: "running" }),
      subagent("timed-out", { status: "timedOut", controlStatus: "running" }),
      subagent("cancelled", { status: "cancelled", controlStatus: "paused" }),
      subagent("open", { controlStatus: "running" }),
      subagent("awaiting", { controlStatus: "awaitingApproval" }),
    ));
    const status = Object.fromEntries(view.agents.map((agent) => [agent.id, agent.status]));
    assert.deepEqual(status, {
      abandoned: "unknown", interrupted: "unknown", idle: "unknown", rejected: "failed", "timed-out": "failed",
      cancelled: "stopped", open: "working", awaiting: "waiting",
    });
    // A reported terminal outcome is terminal even when this version does not know its name.
    const child = agentActivityView(fold(workflow([{ childId: "odd", attempt: 1, status: "terminal", terminal: "interrupted" }])));
    assert.equal(child.agents[0].status, "unknown");
  });

  it("keeps each anonymous agent's number when runs gain children or older history is dropped", () => {
    const numbers: AgentNumbers = new Map();
    const names = (view: ReturnType<typeof agentActivityView>) => Object.fromEntries(view.agents.map((agent) => [agent.id, agent.name]));
    const first = workflow([child("a", "started"), child("b", "started")], { itemId: "w1" });
    const second = workflow([child("c", "started"), child("named", "started", { label: "read-alpha" })], { itemId: "w2", turnId: "turn-2" });
    assert.deepEqual(names(agentActivityView(fold(first, second), numbers)), { a: "Agent 1", b: "Agent 2", c: "Agent 3", named: "Read alpha" });
    const grown = workflow([child("a", "started"), child("b", "started"), child("d", "scheduled")], { itemId: "w1", revision: 2 });
    assert.deepEqual(names(agentActivityView(fold(first, second, grown), numbers)), { a: "Agent 1", b: "Agent 2", c: "Agent 3", d: "Agent 4", named: "Read alpha" });
    // A capped reload that no longer holds the first run.
    assert.deepEqual(names(agentActivityView(fold(second), numbers)), { c: "Agent 3", named: "Read alpha" });
    // A retry is the same agent, and a label reported later names it without renumbering anyone else.
    const later = workflow([child("c", "started", { attempt: 2 }), child("e", "started")], { itemId: "w2", revision: 5, turnId: "turn-2" });
    assert.deepEqual(names(agentActivityView(fold(second, later), numbers)), { c: "Agent 3", e: "Agent 5" });
    const labelled = workflow([child("c", "started", { attempt: 2, label: "verify-beta" }), child("e", "started")], { itemId: "w2", revision: 6, turnId: "turn-2" });
    assert.deepEqual(names(agentActivityView(fold(labelled), numbers)), { c: "Verify beta", e: "Agent 5" });
  });

  it("keeps a thread's agent numbers across views and apart from other threads", () => {
    const numbers = agentNumbers("thread-numbers-a");
    assert.equal(agentNumbers("thread-numbers-a"), numbers);
    assert.notEqual(agentNumbers("thread-numbers-b"), numbers);
    agentActivityView(fold(workflow([child("x", "started"), child("y", "started")])), numbers);
    assert.equal(agentActivityView(fold(workflow([child("y", "started")])), agentNumbers("thread-numbers-a")).agents[0].name, "Agent 2");
    assert.equal(agentActivityView(fold(workflow([child("y", "started")])), agentNumbers("thread-numbers-b")).agents[0].name, "Agent 1");
  });

  it("parses a run's reconciliation once per revision, not on every recompute", () => {
    let reads = 0;
    const base = fold(workflow([], { status: "completed" }));
    const message = payload([{ agent: "one", tool_calls: 1 }]);
    // The fold keeps this object until a newer revision replaces it.
    Object.defineProperty(base.agentItems!["workflow-1"], "message", { enumerable: true, get: () => { reads++; return message; } });
    assert.equal(agentActivityView(base).completed, 1);
    const after = applyEvents(base, [{ method: "item/updated", params: { item: subagent("other") } }]);
    assert.equal(agentActivityView(after).total, 2);
    assert.equal(agentActivityView(after).total, 2);
    assert.equal(reads, 1);
  });

  it("counts agent progress after the live view went unavailable as recovery only while the lead is idle", () => {
    const loaded = fold(workflow([child("bg", "started", { label: "Background" })], { turnId: "finished" }));
    const items = () => loaded.agentItems!;
    // Not loaded yet: nothing to compare against, and the first load is not progress.
    let mark = markAgentFeed(null, "s1", true, "loading", emptyFold().agentItems!);
    assert.equal(markAgentFeed(mark, "s1", true, "loading", emptyFold().agentItems!), mark);
    assert.equal(agentFeedRecovered(mark, "s1", items(), true), false);
    mark = markAgentFeed(mark, "s1", true, "ready", items());
    assert.equal(mark?.items, items());
    assert.equal(markAgentFeed(mark, "s1", true, "ready", items()), mark);
    assert.equal(agentFeedRecovered(mark, "s1", items(), true), false);
    // Unrelated items, or an agent item's replay at the same revision, are not progress.
    const replay = applyEvents(loaded, [
      { method: "item/updated", params: { item: { itemId: "note", kind: "agentMessage", revision: 1, status: "completed", text: "hi" } } },
      { method: "item/updated", params: { item: workflow([child("bg", "started")], { turnId: "finished" }) } },
    ]);
    assert.equal(agentFeedRecovered(markAgentFeed(mark, "s1", true, "ready", replay.agentItems!), "s1", replay.agentItems!, true), false);
    const progressed = applyEvents(loaded, [{ method: "item/updated", params: { item: workflow([child("bg", "terminal", { terminal: "completed" })], { turnId: "finished", revision: 2, status: "completed" }) } }]);
    const kept = markAgentFeed(mark, "s1", true, "ready", progressed.agentItems!);
    assert.equal(kept, mark);
    assert.equal(agentFeedRecovered(kept, "s1", progressed.agentItems!, true), true);
    assert.equal(agentFeedRecovered(kept, "s1", progressed.agentItems!, false), false);
    assert.equal(agentFeedRecovered(kept, "other", progressed.agentItems!, true), false);
    // A new standalone agent is progress too.
    const spawned = applyEvents(loaded, [{ method: "item/updated", params: { item: subagent("late", { turnId: "finished" }) } }]);
    assert.equal(agentFeedRecovered(mark, "s1", spawned.agentItems!, true), true);
    // Once the view recovers, the next outage starts from what the thread holds then.
    assert.equal(markAgentFeed(kept, "s1", false, "ready", progressed.agentItems!), null);
    assert.equal(markAgentFeed(null, "s1", true, "ready", progressed.agentItems!)?.items, progressed.agentItems);
    assert.equal(markAgentFeed(kept, "s2", true, "ready", spawned.agentItems!)?.sessionId, "s2");
  });

  it("does not take what a history read brings back for agents reporting in live", () => {
    const loaded = fold(workflow([child("bg", "started", { label: "Background" })], { turnId: "finished" }));
    const marked = markAgentFeed(null, "s1", true, "ready", loaded.agentItems!);
    // The unavailable notice starts a read. Nothing counts while it is in flight, and what it lands with is
    // the new baseline: here an older finished run a capped load never had, and a revision the feed had
    // missed before the outage.
    const reading = markAgentFeed(marked, "s1", true, "loading", loaded.agentItems!);
    assert.notEqual(reading, marked);
    assert.equal(markAgentFeed(reading, "s1", true, "loading", loaded.agentItems!), reading);
    const read = foldFromLoad({ ...load(
      workflow([child("old", "terminal", { terminal: "completed" })], { itemId: "workflow-0", turnId: "turn-0", status: "completed" }),
      workflow([child("bg", "started", { label: "Background", phase: "Reading" })], { turnId: "finished", revision: 2 }),
    ), historyUnavailable: true }, loaded);
    assert.equal(agentActivityView(read).total, 2);
    assert.equal(agentFeedRecovered(reading, "s1", read.agentItems!, true), false);
    const landed = markAgentFeed(reading, "s1", true, "ready", read.agentItems!);
    assert.equal(landed?.items, read.agentItems);
    assert.equal(landed?.reading, false);
    assert.equal(agentFeedRecovered(landed, "s1", read.agentItems!, true), false);
    // Only a revision arriving after that read shows the agents are reporting in again.
    const live = applyEvents(read, [{ method: "item/updated", params: { item: workflow([child("bg", "terminal", { terminal: "completed" })], { turnId: "finished", revision: 3, status: "completed" }) } }]);
    assert.equal(agentFeedRecovered(landed, "s1", live.agentItems!, true), true);
    // A read that fails changes nothing: the earlier baseline stands, and live progress after it still counts.
    const failed = markAgentFeed(reading, "s1", true, "error", loaded.agentItems!);
    assert.equal(failed?.items, loaded.agentItems);
    assert.equal(failed?.reading, false);
    assert.equal(agentFeedRecovered(failed, "s1", loaded.agentItems!, true), false);
    assert.equal(agentFeedRecovered(failed, "s1", live.agentItems!, true), true);
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
