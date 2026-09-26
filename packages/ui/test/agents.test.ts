import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentFeedRecovered, agentNumbers, markAgentFeed } from "../src/model/agents.js";
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

describe("agentNumbers", () => {
  it("keeps a thread's agent numbers across views and apart from other threads", () => {
    const numbers = agentNumbers("thread-numbers-a");
    assert.equal(agentNumbers("thread-numbers-a"), numbers);
    assert.notEqual(agentNumbers("thread-numbers-b"), numbers);
    numbers.set("x", 1);
    numbers.set("y", 2);
    assert.equal(agentNumbers("thread-numbers-a").get("y"), 2);
    assert.equal(agentNumbers("thread-numbers-b").get("y"), undefined);
  });

  it("forgets the least recently shown threads first", () => {
    const first = agentNumbers("thread-lru-0");
    first.set("a", 1);
    for (let i = 1; i <= 64; i += 1) agentNumbers(`thread-lru-${i}`);
    assert.notEqual(agentNumbers("thread-lru-0"), first);
    assert.equal(agentNumbers("thread-lru-0").get("a"), undefined);
  });
});

describe("the agent feed mark", () => {
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
    assert.deepEqual(Object.keys(read.agentItems!).sort(), ["workflow-0", "workflow-1"]);
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
});
