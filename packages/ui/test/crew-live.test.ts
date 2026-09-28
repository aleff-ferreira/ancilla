import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crewView } from "../src/model/crew.js";
import { applyEvent, emptyFold } from "../src/model/fold.js";
import type { MspItem, ViewEvent } from "../src/types.js";

const T = Date.UTC(2026, 8, 27, 12);
const item = (patch: Partial<MspItem>): ViewEvent => ({
  method: "item/updated",
  at: T,
  params: { item: { itemId: "tool", kind: "toolCall", status: "inProgress", revision: 1, ...patch } },
});

describe("live Crew projection", () => {
  it("invalidates the Crew view when a running command moves to the background", () => {
    const before = applyEvent(emptyFold(), item({ tool: "bash", args: '{"command":"npm run build"}' }));
    assert.equal(crewView(before, null, T).tasks.length, 0);
    const after = applyEvent(before, item({ revision: 2, tool: "bash", args: '{"command":"npm run build"}', background: true }));
    assert.equal(after.order, before.order, "no new transcript item is needed");
    assert.notEqual(after.agentItems, before.agentItems, "the memoized panel must update without waiting for another item or a clock tick");
    assert.equal(after.agentItems?.tool, after.items.tool);
    assert.equal(crewView(after, null, T).tasks[0]?.name, "npm run build");
  });

  it("discovers a native agent when its tool name arrives after an output placeholder", () => {
    const before = applyEvent(emptyFold(), { method: "item/delta", params: { itemId: "spawn", field: "output", delta: " " } });
    assert.equal(crewView(before, null, T).subagents.length, 0);
    const after = applyEvent(before, item({ itemId: "spawn", tool: "subagent_spawn", status: "completed", args: '{"task_name":"review","objective":"Review the change"}', visibleOutput: '{"subagent_id":"child-1"}' }));
    assert.equal(after.order, before.order);
    assert.equal(crewView(after, null, T).subagents[0]?.id, "child-1");
  });

  it("publishes streamed native-agent output to the Crew index", () => {
    const before = applyEvent(emptyFold(), item({ tool: "subagent_spawn", args: '{"task_name":"review"}' }));
    const after = applyEvent(before, { method: "item/delta", params: { itemId: "tool", field: "output", delta: '{"subagent_id":"child-1"}' } });
    assert.notEqual(after.agentItems, before.agentItems);
    assert.equal(after.agentItems?.tool, after.items.tool);
    assert.equal(crewView(after, null, T).subagents[0]?.id, "child-1");
  });

  it("publishes background output even when the delta has no timestamp", () => {
    const before = applyEvent(emptyFold(), item({ tool: "bash", background: true }));
    const after = applyEvent(before, { method: "item/delta", params: { itemId: "tool", field: "output", delta: "Build complete\n" } });
    assert.equal(after.crew, before.crew, "an untimed delta adds no trace time");
    assert.notEqual(after.agentItems, before.agentItems);
    assert.equal(crewView(after, null, T).tasks[0]?.taskInfo?.tail, "Build complete");
  });

  it("keeps Crew's index stable for ordinary transcript text and foreground tools", () => {
    const before = applyEvent(emptyFold(), item({ tool: "subagent_spawn", args: '{"task_name":"review"}' }));
    const message = applyEvent(before, { method: "item/delta", params: { itemId: "message", field: "text", delta: "Working" } });
    const foreground = applyEvent(message, item({ itemId: "foreground", tool: "bash" }));
    assert.equal(message.agentItems, before.agentItems);
    assert.equal(foreground.agentItems, before.agentItems);
    assert.deepEqual(Object.keys(before.agentItems ?? {}), ["tool"]);
  });

  it("removes an item from the Crew index if its new revision is no longer Crew activity", () => {
    const before = applyEvent(emptyFold(), item({ tool: "bash", background: true }));
    const after = applyEvent(before, item({ revision: 2, tool: "bash", background: false }));
    assert.notEqual(after.agentItems, before.agentItems);
    assert.equal(after.agentItems?.tool, undefined);
    assert.equal(crewView(after, null, T).tasks.length, 0);
  });
});
