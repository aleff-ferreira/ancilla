import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { PlanPanel } from "../src/components/requests/Requests.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import type { AgentVM, CrewVM, RunVM } from "../src/model/crew.js";
import { applyEvents, emptyFold, foldFromLoad, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, Store } from "../src/model/store.js";
import { taskPlanItems, taskPlanView, type TaskPlanView } from "../src/model/taskPlan.js";
import type { TranscriptLoad, ViewEvent } from "../src/types.js";

const T0 = Date.parse("2026-09-28T12:00:00.000Z");
const ITEMS = [{ text: "Read the code", status: "completed" }, { text: "Implement the change", status: "in_progress", active_form: "Implementing the change" }, { text: "Verify the result", status: "pending" }];
const started = (turnId = "t1", at = T0): ViewEvent => ({ method: "turn/started", params: { turnId }, at });
const changed = (items: unknown = ITEMS, at = T0 + 1_000): ViewEvent => ({ method: "session/todoListChanged", params: { items, viewCursor: `v:s:${at}` }, at });
const ended = (terminal = "completed"): ViewEvent => ({ method: "turn/completed", params: { turnId: "t1", terminal }, at: T0 + 2_000 });
const running = () => applyEvents(emptyFold(), [started(), changed()]);
const render = (view: TaskPlanView, hidden = false) => {
  const prefs = defaultPrefs("2026-09-28T00:00:00.000Z");
  if (hidden) prefs.hiddenCards.push("plan:s1");
  const controller = { store: new Store(initialState(prefs)) } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children:
    createElement(TooltipProvider, { children: createElement(PlanPanel, { sessionId: "s1", view }) }) }));
};

describe("execution-aware task plans", () => {
  it("accepts the saved Muse todo shapes and older text aliases without inventing statuses", () => {
    assert.deepEqual(taskPlanItems([
      { text: "One", status: "in_progress", active_form: "Working on one" },
      { content: "Two", status: "inProgress", activeForm: "Working on two" },
      { text: "Three", status: "completed" },
      { text: "Four", status: "cancelled" },
      { text: "Five", status: "unrecognized" },
      null, { status: "completed" }, { text: " " },
    ]), [
      { text: "One", status: "inProgress", activeForm: "Working on one" },
      { text: "Two", status: "inProgress", activeForm: "Working on two" },
      { text: "Three", status: "completed", activeForm: null },
      { text: "Four", status: "cancelled", activeForm: null },
      { text: "Five", status: "unknown", activeForm: null },
    ]);
    assert.deepEqual(taskPlanItems(null), []);
    assert.equal(taskPlanView(emptyFold()), null);
  });

  it("tracks the turn that reported the plan and normalizes active steps immediately", () => {
    const fold = running();
    const view = taskPlanView(fold)!;
    assert.equal(fold.meta.todoTurnId, "t1");
    assert.equal(view.state, "working");
    assert.equal(view.animate, true);
    assert.equal(view.activeIndex, 1);
    assert.equal(view.done, 1);
    assert.equal(view.updatedAt, T0 + 1_000);
    assert.equal(view.items[1]?.status, "inProgress");
  });

  it("stops stale active animations at turn completion without making incomplete steps successful", () => {
    const fold = applyEvents(running(), [ended()]);
    const view = taskPlanView(fold)!;
    assert.equal(view.state, "idle");
    assert.equal(view.label, "Turn finished");
    assert.equal(view.animate, false);
    assert.equal(view.done, 1);
    assert.equal(view.remaining, 2);
    assert.equal(view.items[1]?.status, "inProgress", "the reported intent remains intact");
    assert.equal(fold.meta.todoList?.[1]?.status, "in_progress", "the wire snapshot was not mutated");
    assert.match(view.detail, /2 steps remain unconfirmed/);
  });

  it("shows interruptions and failures without rewriting the task's declared status", () => {
    for (const terminal of ["failed", "cancelled", "interrupted"]) {
      const view = taskPlanView(applyEvents(running(), [ended(terminal)]))!;
      assert.equal(view.state, "stopped");
      assert.equal(view.label, terminal === "failed" ? "Turn failed" : "Stopped");
      assert.equal(view.done, 1);
      assert.equal(view.animate, false);
    }
  });

  it("does not revive an old plan when an unrelated prompt starts", () => {
    const previous = applyEvents(running(), [ended(), started("t2", T0 + 3_000)]);
    assert.equal(taskPlanView(previous)?.state, "previous");
    assert.equal(taskPlanView(previous)?.animate, false);
    const updated = applyEvents(previous, [changed([{ text: "New task", status: "in_progress" }], T0 + 4_000)]);
    assert.equal(updated.meta.todoTurnId, "t2");
    assert.equal(taskPlanView(updated)?.state, "working");
    assert.equal(taskPlanView(updated)?.items[0]?.text, "New task");
  });

  it("honors an explicit turn association even when another turn is live", () => {
    const fold = applyEvents(running(), [ended(), started("t2", T0 + 3_000), {
      method: "session/todoListChanged", params: { items: ITEMS, turnId: "t1" }, at: T0 + 4_000,
    }]);
    assert.equal(fold.meta.todoTurnId, "t1");
    assert.equal(taskPlanView(fold)?.state, "previous");
  });

  it("suspends active markers while an approval or answer gates the same turn", () => {
    for (const method of ["approval/requested", "userInput/requested"] as const) {
      const params = method === "approval/requested"
        ? { approvalId: "a1", sessionId: "s1", turnId: "t1" }
        : { userInputId: "q1", sessionId: "s1", turnId: "t1", questions: [] };
      const fold = applyEvents(running(), [{ method, params }]);
      assert.equal(taskPlanView(fold)?.state, "waiting");
      assert.equal(taskPlanView(fold)?.animate, false);
    }
    const blocked = applyEvents(running(), [{ method: "approval/requested", params: { approvalId: "a1", turnId: "t1" } }]);
    const resolved = applyEvents(blocked, [{ method: "approval/resolved", params: { approvalId: "a1", decision: "approved" } }]);
    assert.equal(taskPlanView(resolved)?.state, "working");
  });

  it("marks disconnected or unloaded execution last-known, not still running", () => {
    assert.equal(taskPlanView(running(), { stale: true })?.state, "stale");
    assert.equal(taskPlanView({ ...running(), closed: true })?.animate, false);
    assert.equal(taskPlanView(running(), { stale: true })?.done, 1);
  });

  it("keeps associated background tasks and native workers live after their lead ends", () => {
    const fold: ThreadFold = { ...applyEvents(running(), [ended()]), items: {
      task: { itemId: "task", kind: "toolCall", revision: 1, status: "inProgress", turnId: "t1", background: true },
      workflow: { itemId: "workflow", kind: "workflow", revision: 1, status: "inProgress", turnId: "t1" },
    } };
    const cases: CrewVM[] = [
      { runs: [], tasks: [{ id: "task", state: "working" } as AgentVM], subagents: [] },
      { runs: [], tasks: [], subagents: [{ id: "native", sourceTurnId: "t1", state: "working" } as AgentVM] },
      { runs: [{ itemId: "workflow", kind: "workflow", status: "running" } as RunVM], tasks: [], subagents: [] },
    ];
    for (const crew of cases) {
      const view = taskPlanView(fold, { crew })!;
      assert.equal(view.label, "Workers running");
      assert.equal(view.animate, true);
      assert.equal(view.done, 1);
    }
    const other: CrewVM = { runs: [], tasks: [], subagents: [{ id: "other", sourceTurnId: "t2", state: "working" } as AgentVM] };
    assert.equal(taskPlanView(fold, { crew: other })?.animate, false);
    const settled: CrewVM = { runs: [], tasks: [], subagents: [{ id: "native", sourceTurnId: "t1", state: "done" } as AgentVM] };
    assert.equal(taskPlanView(fold, { crew: settled })?.animate, false);
  });

  it("does not mistake an unrelated research run for activity on a native plan", () => {
    const crew: CrewVM = { runs: [{ itemId: "research:r1", kind: "research", status: "running" } as RunVM], tasks: [], subagents: [] };
    assert.equal(taskPlanView(applyEvents(running(), [ended()]), { crew })?.animate, false);
  });

  it("retains completed and cancelled results, and honors an explicit plan clear", () => {
    const complete = applyEvents(running(), [changed(ITEMS.map((item) => ({ ...item, status: "completed" }))), ended()]);
    assert.equal(taskPlanView(complete)?.state, "complete");
    assert.equal(taskPlanView(complete)?.done, 3);
    const settled = applyEvents(complete, [changed([{ text: "Done", status: "completed" }, { text: "Removed", status: "cancelled" }])]);
    assert.equal(taskPlanView(settled)?.label, "Settled");
    assert.equal(taskPlanView(settled)?.done, 1);
    assert.equal(taskPlanView(settled)?.cancelled, 1);
    assert.equal(taskPlanView(applyEvents(complete, [changed([])])), null);
  });

  it("does not let a delayed partial history replace a newer plan or its turn association", () => {
    const live = applyEvents(running(), [ended(), started("t2", T0 + 3_000), changed([{ text: "Current", status: "in_progress" }], T0 + 4_000)]);
    const load = { events: [started(), changed()], historyUnavailable: true, pending: { approvals: [], userInputs: [] }, pendingComplete: false } as unknown as TranscriptLoad;
    const merged = foldFromLoad(load, live);
    assert.equal(merged.meta.todoTurnId, "t2");
    assert.equal(taskPlanView(merged)?.items[0]?.text, "Current");
  });

  it("uses timing evidence for old folds without a plan turn id, and rejects an impossible clock", () => {
    const fold = running();
    delete fold.meta.todoTurnId;
    assert.equal(taskPlanView(fold)?.animate, true);
    const newer = applyEvents(fold, [ended(), started("t2", T0 + 3_000)]);
    assert.equal(taskPlanView(newer)?.animate, false);
    newer.meta.observed = { todoList: { cursor: null, at: Number.MAX_VALUE } };
    assert.equal(taskPlanView(newer)?.updatedAt, null);
  });
});

describe("Plan panel presentation", () => {
  it("shows the real active step, accessible progress, and update time", () => {
    const html = render(taskPlanView(running())!);
    assert.match(html, /Implementing the change/);
    assert.match(html, /aria-current="step"/);
    assert.match(html, /aria-label="In progress"/);
    assert.match(html, /aria-label="Plan steps completed" aria-valuemin="0" aria-valuemax="3" aria-valuenow="1"/);
    assert.match(html, /dateTime="2026-09-28T12:00:01.000Z"/);
  });

  it("explains an unconfirmed ended step without leaving a running spinner or active verb", () => {
    const html = render(taskPlanView(applyEvents(running(), [ended()]))!);
    assert.match(html, /Turn finished/);
    assert.match(html, /Implement the change/);
    assert.match(html, /last active/);
    assert.doesNotMatch(html, /Implementing the change|aria-current="step"|aria-label="In progress"/);
    assert.match(html, /2 steps remain unconfirmed/);
  });

  it("retains a compact completed summary that can be expanded and respects hiding", () => {
    const fold = applyEvents(running(), [changed(ITEMS.map((item) => ({ ...item, status: "completed" }))), ended()]);
    const view = taskPlanView(fold)!;
    const html = render(view);
    assert.match(html, /Complete/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /<ol/);
    assert.equal(render(view, true), "");
  });
});
