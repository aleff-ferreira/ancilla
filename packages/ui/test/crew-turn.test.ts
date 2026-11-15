import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityView, canStopAgent, crewBusy, crewTurnKey, crewView, sidebarCrewSummary } from "../src/model/crew.js";
import { applyEvent, applyEvents, emptyFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, type ThreadState } from "../src/model/store.js";
import type { MspItem, SessionSummary, ViewEvent } from "../src/types.js";
import { subline } from "../src/components/crew/panel.js";

const T = Date.UTC(2026, 8, 28, 12);
const session: SessionSummary = { sessionId: "thread", title: "Ordinary prompt", cwd: "/work", titleSource: "user", turnCount: 1, modelId: "muse", origin: "ancilla", archived: false, createdAt: new Date(T).toISOString(), activityAt: new Date(T).toISOString(), settled: false, settledAt: null, unsettledAt: null, sandboxDisabled: false, accountId: null, live: null };
const start: ViewEvent = { method: "turn/started", at: T, params: { turnId: "turn-1" } };
function tool(id: string, patch: Partial<MspItem> = {}, at = T + 1000): ViewEvent {
  return { method: "item/updated", at, params: { item: { itemId: id, kind: "toolCall", tool: "bash", args: '{"command":"npm run build"}', turnId: "turn-1", status: "inProgress", revision: 1, ...patch } } };
}
const finish = (terminal = "completed"): ViewEvent => ({ method: "turn/completed", at: T + 5000, params: { turnId: "turn-1", terminal } });

describe("ordinary prompt monitoring", () => {
  it("shows the real lead immediately and refreshes its lifecycle without rebuilding for prose", () => {
    const initial = applyEvent(emptyFold(), start);
    const run = crewView(initial, session, T).runs[0];
    assert.equal(run?.kind, "turn");
    assert.equal(run?.agents[0]?.name, "Muse");
    assert.equal(run?.agents[0]?.state, "working");
    assert.equal(crewBusy(initial), true);
    const delta = applyEvent(initial, { method: "item/delta", at: T + 1000, params: { itemId: "text", turnId: "turn-1", field: "text", delta: "Working" } });
    assert.equal(crewTurnKey(delta), crewTurnKey(initial));
    const ended = applyEvent(delta, finish());
    assert.notEqual(crewTurnKey(ended), crewTurnKey(initial));
    assert.equal(crewView(ended, session, T + 5000).runs[0]?.agents[0]?.state, "done");
    assert.equal(crewBusy(ended), false);
  });

  it("keeps foreground completion, output and exact timing in the turn roster", () => {
    const fold = applyEvents(emptyFold(), [start, tool("build"), tool("build", { status: "completed", revision: 2, visibleOutput: "Build ready", exitCode: 0 }, T + 3000)]);
    const row = crewView(fold, session, T + 4000).runs[0]?.agents.find((agent) => agent.id === "build");
    assert.equal(row?.phase, "Tools");
    assert.equal(row?.state, "done");
    assert.equal(row?.durationMs, 2000);
    assert.equal(row?.taskInfo?.tail, "Build ready");
    assert.equal(row?.taskInfo?.background, false);
    assert.equal(row?.taskInfo?.exitCode, 0);
    assert.equal(fold.crew.tasks.build?.endedAt, T + 3000);
  });

  it("does not claim the user backgrounded foreground tools or unattributed background tasks", () => {
    const fold = applyEvents(emptyFold(), [start, tool("foreground"), tool("background", { background: true })]);
    const view = crewView(fold, session, T + 2000);
    const foreground = view.runs[0]!.agents.find((agent) => agent.id === "foreground")!;
    assert.deepEqual(subline(foreground, view.runs[0]!)?.rest, []);
    assert.deepEqual(subline(view.tasks[0]!, null)?.rest, []);
  });

  it("moves the same task to Background without duplicate tool rows", () => {
    const fold = applyEvents(emptyFold(), [start, tool("build"), tool("build", { revision: 2, background: true })]);
    const view = crewView(fold, session, T + 2000);
    assert.equal(view.runs[0]?.agents.filter((agent) => agent.id === "build").length, 0);
    assert.equal(view.tasks[0]?.id, "build");
    assert.equal(view.tasks[0]?.startedAt, T + 1000);
    assert.equal(sidebarCrewSummary(fold, null, T + 2000)?.task, "npm run build");
  });

  it("marks a nonzero exit as failure and does not offer task/stop for a file read", () => {
    const fold = applyEvents(emptyFold(), [start, tool("failed", { status: "completed", exitCode: 2 }), tool("read", { tool: "read_file", args: '{"path":"README.md"}' })]);
    const run = crewView(fold, session, T + 2000).runs[0]!;
    assert.equal(run.agents.find((agent) => agent.id === "failed")?.state, "failed");
    assert.equal(canStopAgent(run.agents.find((agent) => agent.id === "read")!), false);
    assert.equal(canStopAgent(run.agents[0]!), true);
  });

  it("does not leave a foreground tool working after the turn ends without its result", () => {
    const fold = applyEvents(emptyFold(), [start, tool("build"), finish()]);
    const row = crewView(fold, session, T + 6000).runs[0]?.agents.find((agent) => agent.id === "build");
    assert.equal(row?.state, "unknown");
    assert.equal(row?.endedAt, T + 5000);
    assert.equal(crewBusy(fold), false);
    const cancelled = applyEvents(emptyFold(), [start, tool("build"), finish("cancelled")]);
    assert.equal(crewView(cancelled, session, T + 6000).runs[0]?.agents.find((agent) => agent.id === "build")?.state, "skipped");
  });

  it("keeps background work and native agents visible after the lead finishes", () => {
    const fold = applyEvents(emptyFold(), [start, tool("build", { background: true }), tool("spawn", { tool: "subagent_spawn", status: "completed", args: '{"task_name":"Review"}', visibleOutput: '{"subagent_id":"child"}' }), finish()]);
    const view = crewView(fold, session, T + 6000);
    assert.equal(view.runs[0]?.status, "finished");
    assert.equal(view.tasks[0]?.state, "working");
    assert.equal(view.subagents[0]?.state, "working");
    assert.equal(view.subagents[0]?.sourceTurnId, "turn-1");
    assert.equal(sidebarCrewSummary(fold, null, T + 6000)?.live, true);
    assert.equal(crewBusy(fold), true);
  });

  it("resumes lead monitoring when a workflow finishes during the same prompt", () => {
    let fold = applyEvents(emptyFold(), [start, tool("workflow", { kind: "workflow", workflowRunId: "wf-1", entryId: "Review", children: [] })]);
    assert.deepEqual(crewView(fold, session, T + 2000).runs.map((run) => run.kind), ["workflow"]);
    fold = applyEvents(fold, [tool("workflow", { kind: "workflow", status: "completed", revision: 2, workflowRunId: "wf-1", entryId: "Review", children: [] }, T + 2500), tool("build", {}, T + 3000)]);
    const current = crewView(fold, session, T + 4000).runs.at(-1);
    assert.equal(current?.kind, "turn");
    assert.equal(current?.status, "running");
    assert.ok(current?.agents.some((agent) => agent.id === "build" && agent.state === "working"));
  });

  it("includes finished native agents in Activity and uses live event timestamps", () => {
    const fold = applyEvents(emptyFold(), [start, tool("spawn", { tool: "subagent_spawn", status: "completed", visibleOutput: '{"subagent_id":"child"}' }), tool("wait", { tool: "subagent_wait", status: "completed", args: '{"subagent_id":"child"}', visibleOutput: '{"status":"ready"}' }, T + 4000), finish()]);
    const thread: ThreadState = { fold, load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, attachments: [], shellRuns: [], researchRuns: [], stalled: false };
    const state = { ...initialState(defaultPrefs(new Date(T).toISOString())), connection: "open" as const, sessions: { thread: session }, threads: { thread } };
    const agent = activityView(state, T + 6000).finishedToday.find((item) => item.kind === "subagent");
    assert.equal(agent?.agentId, "child");
    assert.equal(agent?.state, "done");
    assert.equal(agent?.endedAt, T + 4000);
  });
});
