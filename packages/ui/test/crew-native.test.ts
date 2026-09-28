import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { crewBusy, crewView } from "../src/model/crew.js";
import type { MspItem, ViewEvent } from "../src/types.js";

const START = Date.UTC(2026, 8, 25, 14);
const END = START + 60_000;

function itemEvent(item: MspItem): ViewEvent {
  return { method: "item/completed", params: { item } };
}

function spawn(id = "child-1", patch: Partial<MspItem> = {}): MspItem {
  return {
    itemId: `spawn-${id}`, kind: "toolCall", tool: "subagent_spawn", status: "completed", revision: 2,
    turnId: "turn-1", recordedAt: new Date(START).toISOString(),
    args: JSON.stringify({ command_id: `spawn-command-${id}`, objective: "Read the module.", role: "reviewer", task_name: `review-${id}` }),
    visibleOutput: JSON.stringify({ status: "accepted", subagent_id: id, work_id: `work-${id}`, agent_path: `main/review-${id}/1`, task_ref: `subagent-task://${id}/1` }),
    ...patch,
  };
}

function wait(status: string, id = "child-1", patch: Partial<MspItem> = {}): MspItem {
  return {
    itemId: `wait-${id}`, kind: "toolCall", tool: "subagent_wait", status: "completed", revision: 2,
    turnId: "turn-1", recordedAt: new Date(END).toISOString(),
    args: JSON.stringify({ command_id: `wait-command-${id}`, subagent_id: id, timeout_ms: 120_000, wait_for: "result" }),
    // Muse 1.4.0's saved native-agent projection uses "ready", not "completed".
    visibleOutput: JSON.stringify({ status, subagent_id: id, task_ref: `subagent-task://${id}/1`, summary: "The module was reviewed.", workspace: {}, evidence_refs: [] }),
    ...patch,
  };
}

function projection(items: MspItem[]) {
  const fold = applyEvents(emptyFold(), items.map(itemEvent));
  return { fold, view: crewView(fold, null, END + 10_000) };
}

describe("native subagents reported as tool calls", () => {
  it("settles the ready result emitted by Muse 1.4.0", () => {
    const { fold, view } = projection([spawn(), wait("ready")]);
    const agent = view.subagents[0];
    assert.equal(view.subagents.length, 1);
    assert.equal(agent?.id, "child-1");
    assert.equal(agent?.name, "review-child-1");
    assert.equal(agent?.state, "done");
    assert.equal(agent?.startedAt, START);
    assert.equal(agent?.endedAt, END);
    assert.equal(agent?.durationMs, 60_000);
    assert.equal(agent?.runningMs, null);
    assert.equal(crewBusy(fold), false);
  });

  it("keeps spawn-only agents busy after the lead's turn has ended", () => {
    const fold = applyEvents(emptyFold(), [
      itemEvent(spawn()),
      { method: "turn/completed", params: { turnId: "turn-1", terminal: "completed" } },
    ]);
    assert.equal(crewView(fold, null, END).subagents[0]?.state, "working");
    assert.equal(crewBusy(fold), true);
  });

  it("remains busy until every native agent reports an outcome", () => {
    const { fold, view } = projection([spawn(), spawn("child-2"), wait("ready"), wait("timeout", "child-2")]);
    assert.deepEqual(view.subagents.map((agent) => agent.state), ["done", "working"]);
    assert.equal(crewBusy(fold), true);
    const ended = applyEvents(fold, [itemEvent(wait("ready", "child-2", { revision: 3 }))]);
    assert.equal(crewBusy(ended), false);
  });

  it("does not turn completed waits, timeouts or unrecognized output into child completion", () => {
    for (const output of ["", "not JSON", "{}", ...["timeout", "timed_out", "pending", "running", "future_status"].map((status) => JSON.stringify({ status }))]) {
      const { fold, view } = projection([spawn(), wait("ready", "child-1", { visibleOutput: output })]);
      assert.equal(view.subagents[0]?.state, "working", output);
      assert.equal(view.subagents[0]?.endedAt, null, output);
      assert.equal(crewBusy(fold), true, output);
    }
    const open = projection([spawn(), wait("ready", "child-1", { status: "inProgress" })]);
    assert.equal(open.view.subagents[0]?.state, "working");
    assert.equal(crewBusy(open.fold), true);
  });

  it("preserves reported failure and stop outcomes", () => {
    for (const status of ["failed", "error", "rejected"]) {
      const { fold, view } = projection([spawn(), wait(status)]);
      assert.equal(view.subagents[0]?.state, "failed");
      assert.equal(view.subagents[0]?.failure?.text, "The module was reviewed.");
      assert.equal(crewBusy(fold), false);
    }
    for (const status of ["cancelled", "canceled", "stopped"]) {
      const { fold, view } = projection([spawn(), wait(status)]);
      assert.equal(view.subagents[0]?.state, "skipped");
      assert.equal(view.subagents[0]?.endedAt, END);
      assert.equal(crewBusy(fold), false);
    }
  });

  it("does not keep failed or cancelled spawn admissions busy", () => {
    for (const patch of [
      { status: "failed", failureReason: "No worker slot was admitted." },
      { status: "completed", failureKind: "tool_error", failureReason: "No worker slot was admitted." },
      { status: "cancelled" },
    ]) {
      const { fold, view } = projection([spawn("child-1", { ...patch, visibleOutput: "" })]);
      assert.equal(view.subagents[0]?.state, patch.status === "cancelled" ? "skipped" : "failed");
      assert.equal(view.subagents[0]?.endedAt, START);
      assert.equal(crewBusy(fold), false);
    }
  });

  it("keeps existing completion vocabulary and ignores waits for another child", () => {
    for (const status of ["completed", "complete", "done", "success", "succeeded", "result_ready"]) {
      const { fold, view } = projection([spawn(), wait(status)]);
      assert.equal(view.subagents[0]?.state, "done", status);
      assert.equal(crewBusy(fold), false, status);
    }
    const other = projection([spawn(), wait("ready", "different-child")]);
    assert.equal(other.view.subagents[0]?.state, "working");
    assert.equal(crewBusy(other.fold), true);
  });

  it("keeps the newest wait when an earlier wait's metadata arrives late", () => {
    const before = applyEvents(emptyFold(), [
      itemEvent(spawn()),
      { method: "item/delta", params: { itemId: "old-wait", field: "output", delta: " " } },
      itemEvent(wait("ready", "child-1", { itemId: "new-wait" })),
    ]);
    assert.equal(crewView(before, null, END).subagents[0]?.state, "done");
    const after = applyEvents(before, [itemEvent(wait("timeout", "child-1", {
      itemId: "old-wait", recordedAt: new Date(END + 10_000).toISOString(),
    }))]);
    assert.deepEqual(after.order, ["spawn-child-1", "old-wait", "new-wait"]);
    assert.deepEqual(Object.keys(after.agentItems ?? {}), ["spawn-child-1", "new-wait", "old-wait"]);
    assert.equal(crewView(after, null, END + 20_000).subagents[0]?.state, "done", "transcript order wins over metadata arrival and timestamps");
    assert.equal(crewBusy(after), false);
  });

  it("keeps native rows in transcript order when spawn metadata arrives late", () => {
    const fold = applyEvents(emptyFold(), [
      { method: "item/delta", params: { itemId: "spawn-child-1", field: "output", delta: " " } },
      itemEvent(spawn("child-2")),
      itemEvent(spawn("child-1")),
    ]);
    assert.deepEqual(crewView(fold, null, END).subagents.map((agent) => agent.id), ["child-1", "child-2"]);
  });

  it("keeps launch correlation order when two launches share a name and earlier metadata arrives late", () => {
    const launch = (id: string): MspItem => ({
      itemId: `launch-${id}`, kind: "toolCall", tool: "workflow", status: "completed", revision: 2, turnId: "turn-1",
      args: JSON.stringify({ name: "review", script: `export default async function workflow(host) { return host.parallel([{ label: "${id}:worker", input: "Read the module." }]); }` }),
    });
    const fold = applyEvents(emptyFold(), [
      { method: "item/delta", params: { itemId: "launch-older", field: "output", delta: " " } },
      itemEvent(launch("newer")),
      itemEvent({ itemId: "run", kind: "workflow", status: "inProgress", revision: 1, turnId: "turn-1", entryId: "review", workflowRunId: "opaque-run-id", children: [] }),
      itemEvent(launch("older")),
    ]);
    assert.deepEqual(crewView(fold, null, END).runs[0]?.agents.map((agent) => agent.name), ["older:worker"]);
  });

  it("matches a thousand native agents with one pass over wait arguments", () => {
    const count = 1000;
    let reads = 0;
    const items: MspItem[] = [{ itemId: "prose", kind: "agentMessage", status: "inProgress", revision: 1, text: "Working" }];
    for (let index = 0; index < count; index += 1) {
      const id = `child-${index}`;
      items.push(spawn(id), wait("ready", id));
    }
    const fold = applyEvents(emptyFold(), items.map(itemEvent));
    for (const item of Object.values(fold.items)) {
      if (item.tool !== "subagent_wait") continue;
      const args = item.args;
      Object.defineProperty(item, "args", { enumerable: true, get: () => { reads += 1; return args; } });
    }
    assert.equal(crewBusy(fold), false);
    const agents = crewView(fold, null, END).subagents;
    assert.equal(agents.length, count);
    assert.ok(agents.every((agent) => agent.state === "done"));
    assert.equal(reads, count, "each wait is normalized once for busy and view together, never once per spawn");
    const prose = applyEvents(fold, [{ method: "item/delta", params: { itemId: "prose", field: "text", delta: "…" } }]);
    assert.equal(crewBusy(prose), false);
    assert.equal(crewView(prose, null, END).subagents.length, count);
    assert.equal(reads, count, "ordinary prose reuses normalized native waits");
  });
});
