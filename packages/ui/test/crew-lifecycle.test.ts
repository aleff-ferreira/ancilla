import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityView, crewBusy, crewTurnKey, crewView, sidebarCrewSummary } from "../src/model/crew.js";
import { applyEvents, emptyFold, foldFromLoad, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, type AppState, type ThreadState } from "../src/model/store.js";
import { taskPlanView } from "../src/model/taskPlan.js";
import type { MspItem, SessionSummary, TranscriptLoad, ViewEvent } from "../src/types.js";
import { renderPanel } from "./crew-panel-fixture.js";

const T = Date.UTC(2026, 8, 28, 12);
const SESSION: SessionSummary = {
  sessionId: "s1", title: "Ordinary prompt", cwd: "/work", titleSource: "user", turnCount: 1, modelId: "muse",
  origin: "ancilla", archived: false, createdAt: new Date(T).toISOString(), activityAt: new Date(T).toISOString(),
  settled: false, settledAt: null, unsettledAt: null, sandboxDisabled: false, accountId: null, live: null,
};
const started = (turnId = "current", at = T): ViewEvent => ({ method: "turn/started", at, params: { turnId } });
const ended = (turnId = "current", at: number | undefined = T + 5_000, terminal = "completed"): ViewEvent => ({ method: "turn/completed", at, params: { turnId, terminal } });
const tool = (itemId: string, patch: Partial<MspItem> = {}, at = T + 1_000): ViewEvent => ({
  method: "item/updated", at, params: { item: {
    itemId, kind: "toolCall", revision: 1, status: "completed", turnId: "current", tool: "bash", args: '{"command":"npm run build"}', ...patch,
  } },
});
const spawn = () => tool("spawn", { tool: "subagent_spawn", args: '{"task_name":"Review"}', visibleOutput: '{"subagent_id":"child"}' });

function app(fold: ThreadFold): AppState {
  const thread: ThreadState = { fold, load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, attachments: [], shellRuns: [], researchRuns: [], stalled: false };
  return { ...initialState(defaultPrefs(new Date(T).toISOString())), connection: "open", sessions: { s1: SESSION }, threads: { s1: thread }, route: { kind: "thread", sessionId: "s1" } };
}

describe("Crew lifecycle reconciliation", () => {
  it("keeps the latest completed turn selected when older history is backfilled later", () => {
    const current = applyEvents(emptyFold(), [started(), ended()]);
    const load: TranscriptLoad = {
      session: SESSION,
      msp: { status: "idle", activeTurnId: null, modelId: "muse", approvalMode: null, workspaceRoot: "/work", turnCount: 2 },
      events: [started("older", T - 10_000), ended("older", T - 5_000)],
      truncated: true, pending: { approvals: [], userInputs: [] }, pendingComplete: false,
      readOnly: false, readOnlyReason: null, historyUnavailable: true,
    };
    const merged = foldFromLoad(load, current);
    assert.deepEqual(Object.keys(merged.turns), ["current", "older"], "the older turn really was inserted later");
    const run = crewView(merged, SESSION, T + 10_000).runs.at(-1);
    assert.equal(run?.runId, "current");
    assert.equal(run?.endedAt, T + 5_000);
  });

  it("invalidates the lifecycle memo when only the authoritative active turn changes", () => {
    const running = applyEvents(emptyFold(), [started()]);
    const noLongerActive = { ...running, activeTurnId: null };
    assert.notEqual(crewTurnKey(running), crewTurnKey(noLongerActive));
    assert.equal(crewView(running, SESSION, T + 1_000).runs[0]?.status, "running");
    assert.notEqual(crewView(noLongerActive, SESSION, T + 1_000).runs[0]?.status, "running");
  });

  it("does not keep a terminal turn's clock running when its end timestamp was not reported", () => {
    const fold = applyEvents(emptyFold(), [started(), { method: "turn/completed", params: { turnId: "current", terminal: "completed" } }]);
    const first = crewView(fold, SESSION, T + 10_000).runs[0];
    const later = crewView(fold, SESSION, T + 60_000).runs[0];
    assert.equal(first?.elapsedMs, null);
    assert.equal(later?.elapsedMs, null);
    assert.equal(later?.agents[0]?.durationMs, null);
    assert.equal(later?.agents[0]?.runningMs, null);
  });

  it("keeps a known duration when the end timestamp is absent", () => {
    const fold = applyEvents(emptyFold(), [started(), { method: "turn/completed", params: { turnId: "current", terminal: "completed", durationMs: 2_500 } }]);
    assert.equal(crewView(fold, SESSION, T + 60_000).runs[0]?.elapsedMs, 2_500);
  });

  it("keeps a provisional unknown outcome unknown in Activity", () => {
    const fold = applyEvents(emptyFold(), [started(), ended("current", T + 5_000, "unknown")]);
    const view = activityView(app(fold), T + 10_000);
    assert.equal(view.working.length, 0);
    assert.equal(view.finishedToday.length, 1);
    assert.equal(view.finishedToday[0]?.state, "unknown");
    assert.doesNotMatch(view.finishedToday[0]?.sub ?? "", /^Done/);
  });

  it("does not label a signal-terminated shell as successful", () => {
    const fold = applyEvents(emptyFold(), [started(), tool("signal", { exitSignal: 15 })]);
    const row = crewView(fold, SESSION, T + 2_000).runs[0]?.agents.find((agent) => agent.id === "signal");
    assert.ok(row);
    assert.ok(row.state === "failed" || row.state === "skipped", `Signal 15 should settle without success, got ${row.state}`);
    assert.equal(row.runningMs, null);
  });

  it("reconciles a terminal native wait with a legacy subagent still marked in progress", () => {
    const fold = applyEvents(emptyFold(), [
      started(),
      { method: "session/todoListChanged", params: { items: [{ text: "Review changes", status: "in_progress" }] }, at: T + 100 },
      spawn(),
      tool("legacy", { kind: "subagent", status: "inProgress", subagentId: "child" }, T + 2_000),
      tool("wait", { tool: "subagent_wait", args: '{"subagent_id":"child"}', visibleOutput: '{"status":"ready"}' }, T + 4_000),
      ended(),
    ]);
    const crew = crewView(fold, SESSION, T + 6_000);
    assert.equal(crew.subagents.length, 1, "one durable child has one row");
    assert.equal(crew.subagents[0]?.state, "done");
    assert.equal(crew.subagents[0]?.sourceTurnId, "current");
    assert.equal(crewBusy(fold), false, "a superseded legacy snapshot must not keep monitoring live");
    assert.equal(taskPlanView(fold, { crew })?.animate, false, "the plan stops once associated workers settle");
    assert.equal(taskPlanView(fold, { crew })?.done, 0, "worker completion does not prove a plan step complete");
  });

  it("keeps standalone work live and counted after its lead completes", () => {
    const fold = applyEvents(emptyFold(), [started(), spawn(), tool("background", { status: "inProgress", background: true }), ended()]);
    const summary = sidebarCrewSummary(fold, null, T + 6_000);
    assert.equal(summary?.live, true);
    assert.equal(summary?.groups.flat().filter((state) => state === "working").length, 2);
    const view = activityView(app(fold), T + 6_000);
    assert.equal(view.working.filter((item) => item.kind === "task" || item.kind === "subagent").length, 2);
    const html = renderPanel({ fold, session: SESSION, panel: { filter: "working" } }, T + 6_000);
    const workingChip = /<button[^>]*data-filter="working"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
    assert.match(workingChip, /<span[^>]*>2<\/span>/);
    assert.match(html, /id="crew-row-background"/);
    assert.match(html, /id="crew-row-child"/);
    assert.doesNotMatch(html, /id="crew-row-turn:current"/);
  });
});
