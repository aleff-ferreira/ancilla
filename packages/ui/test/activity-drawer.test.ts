import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActivityDrawer,
  FILTERS,
  activityModel,
  drawerKeyAction,
  stopAllQuestion,
  stopAllText,
  visibleSections,
  type ActivityDrawerProps,
} from "../src/components/crew/ActivityDrawer.js";
import { activityKey, itemElapsed, splitProgress, stopQuestion, stoppable } from "../src/components/crew/ActivityItem.js";
import { MOD } from "../src/components/ui/primitives.js";
import type { ActivityItemVM, ActivityVM } from "../src/model/crew.js";
import type { ViewEvent } from "../src/types.js";
import { APPROVAL_COMMAND, NOW, RUN_NAME, TASK_COMMAND, appState, approvalEvents, fold, runEvents, session, taskEvents, thread } from "./crew-fixtures.js";

const base = { sessionId: "s1", project: "lantern", thread: "Design the offline sync engine", stale: false } as const;
const approval: ActivityItemVM = { ...base, itemId: "call-1", agentId: null, kind: "request", text: "Run a shell command", sub: APPROVAL_COMMAND, state: "request", startedAt: NOW - 100_000, endedAt: null };
const question: ActivityItemVM = { ...base, sessionId: "s2", thread: "Migrate auth to passkeys", itemId: null, agentId: null, kind: "request", text: "Muse asked a question", sub: "Which passkey provider should go first, Apple or Google?", state: "request", startedAt: NOW - 12 * 60_000, endedAt: null };
const elsewhere: ActivityItemVM = { ...base, sessionId: "s3", thread: "Index the docs corpus", itemId: null, agentId: null, kind: "request", text: "2 requests waiting", sub: null, state: "request", startedAt: null, endedAt: null, stale: true };
const run: ActivityItemVM = { ...base, itemId: "wf", agentId: null, kind: "run", text: RUN_NAME, sub: "Judge · 6 of 10", state: "failed", startedAt: NOW - (41 * 60 + 16) * 1000, endedAt: null };
const task: ActivityItemVM = { ...base, itemId: "task-1", agentId: "task-1", kind: "task", text: "npm run test:e2e -- --grep sync", sub: '12 passed · 3 pending · running "merges concurrent edits"', state: "working", startedAt: NOW - 83_000, endedAt: null };
const done: ActivityItemVM = { ...base, itemId: "task-0", agentId: "task-0", kind: "task", text: TASK_COMMAND, sub: "finished · no failure reported", state: "done", startedAt: NOW - 400_000, endedAt: NOW - 48_000 };

const NOTE = "Other threads appear here once Ancilla tracks them (coming in 1.1)";
const VIEW: ActivityVM = {
  needsYou: [approval, question, elsewhere],
  working: [run, task],
  finishedToday: [done],
  stopAll: { runs: 1, tasks: 1 },
  foot: "2 running in 1 thread · 1.1M tokens today",
  empty: false,
  note: NOTE,
};
const QUIET: ActivityVM = { needsYou: [], working: [], finishedToday: [], stopAll: null, foot: "Nothing runs and nothing waits for you.", empty: true, note: null };

function render(overrides: Partial<ActivityDrawerProps> = {}): string {
  const props: ActivityDrawerProps = {
    open: true,
    view: VIEW,
    filter: "all",
    now: NOW,
    onFilter() {},
    onOpen() {},
    onStop() {},
    onStopAll() {},
    onClose() {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ActivityDrawer, props));
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("ActivityDrawer", () => {
  it("is a modal dialog named Activity, with its chord in the head and a Close button", () => {
    const markup = render();
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);
    assert.match(markup, /aria-label="Activity"/);
    // MOD reads the platform, and Node reports a Mac as one, so a macOS runner renders Cmd here.
    assert.match(markup, new RegExp(`<h2[^>]*>.*Activity.*<kbd[^>]*>${MOD}</kbd><kbd[^>]*>Shift</kbd><kbd[^>]*>A</kbd>`));
    assert.match(markup, /aria-label="Close"/);
    assert.equal(render({ open: false }), "");
  });

  it("shows the three sections with their counts, and the filter chips add up", () => {
    const plain = text(render());
    assert.match(plain, /All 6 Needs you 3 Working 2 Finished today 1/);
    assert.match(plain, /Needs you 3 lantern Design the offline sync engine/);
    assert.match(plain, /Working 2 lantern/);
    assert.match(plain, /Finished today 1 lantern/);
    const markup = render();
    assert.match(markup, /aria-pressed="true"[^>]*>All/);
    assert.match(markup, /aria-pressed="false"[^>]*>(<span[^>]*><\/span>)?Needs you/);
  });

  it("says what each request wants and offers Review or Answer", () => {
    const markup = render();
    assert.match(markup, /Muse wants to run a shell command/);
    assert.match(markup, new RegExp(`<code[^>]*>${APPROVAL_COMMAND.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}</code>`));
    assert.match(markup, /Review<\/button>/);
    assert.match(markup, /Muse asks<\/b> · “Which passkey provider should go first, Apple or Google\?”/);
    assert.match(markup, /Answer<\/button>/);
    // A thread this client does not fold: the server's count, and Review still opens the thread.
    assert.match(markup, /<b class="font-medium text-fg">2 requests waiting<\/b>/);
    assert.doesNotMatch(markup, /Muse wants to 2 requests/);
  });

  it("gives a run its strip, its progress with the count in bold, its chips, and Open and Stop", () => {
    const key = activityKey(run);
    const markup = render({ runs: { [key]: { groups: [["done", "done"], ["working", "failed"]], chips: [{ kind: "failed", count: 1, text: "1 failed" }] } } });
    assert.match(markup, /class="crew-strip"/);
    assert.match(markup, /Judge · <b class="font-medium text-fg">6 of 10<\/b>/);
    assert.match(markup, /1 failed<\/span>/);
    assert.match(markup, /Open<\/button>/);
    assert.match(markup, new RegExp(`aria-label="Stop ${RUN_NAME}"`));
    // Without the extras the row still reads; nothing is invented.
    assert.doesNotMatch(render(), /crew-strip/);
  });

  it("shows a running task's command in mono with its last line under it, and a finished one with its outcome", () => {
    const markup = render();
    assert.match(markup, /<code class="[^"]*font-mono[^"]*">npm run test:e2e -- --grep sync<\/code>/);
    assert.match(markup, /›<\/span><span class="min-w-0 truncate">12 passed · 3 pending · running &quot;merges concurrent edits&quot;<\/span>/);
    assert.match(markup, /aria-label="Stop npm run test:e2e -- --grep sync"/);
    assert.match(markup, /npm run docs:build<\/code><span class="min-w-0 truncate">finished · no failure reported<\/span>/);
    assert.doesNotMatch(markup, /aria-label="Stop npm run docs:build"/);
  });

  it("carries the v1 note for threads it does not track, after the Working section", () => {
    // Past the filter chips, which carry the same words.
    const plain = text(render());
    const body = plain.slice(plain.indexOf("Needs you 3 lantern"));
    const working = body.indexOf("Working 2 lantern");
    const note = body.indexOf(NOTE);
    const finished = body.indexOf("Finished today 1");
    assert.ok(working > 0 && working < note && note < finished, body);
    assert.doesNotMatch(text(render({ view: { ...VIEW, note: null } })), new RegExp(NOTE));
    assert.doesNotMatch(text(render({ filter: "needs" })), new RegExp(NOTE));
  });

  it("offers Stop everything only when it can say what it stops, with the foot copy", () => {
    const markup = render();
    assert.match(text(markup), /Stop everything stops 1 run and 1 task in this thread\. Approvals stay open\. Stop everything/);
    const calm = render({ view: { ...VIEW, stopAll: null } });
    assert.doesNotMatch(calm, /Stop everything/);
    assert.match(text(calm), /2 running in 1 thread · 1\.1M tokens today/);
    assert.equal(stopAllText({ runs: 2, tasks: 0 }), "Stop everything stops 2 runs in this thread. Approvals stay open.");
    assert.equal(stopAllQuestion({ runs: 2, tasks: 1 }), "Stop everything? Stops 2 runs and 1 task. Approvals stay open.");
    assert.equal(stopAllText({ runs: 0, tasks: 0, agents: 1 }), "Stop everything stops 1 native agent in this thread. Approvals stay open.");
    assert.equal(stopAllQuestion({ runs: 1, tasks: 2, agents: 3 }), "Stop everything? Stops 1 run, 2 tasks and 3 native agents. Approvals stay open.");
  });

  it("is all quiet when nothing runs and nothing waits", () => {
    const markup = render({ view: QUIET });
    assert.match(text(markup), /All quiet\. Nothing runs and nothing waits for you\./);
    assert.doesNotMatch(markup, /Stop everything|Needs you 0|role="list"/);
  });

  it("filters to one section, and names an empty one rather than hiding it", () => {
    assert.deepEqual(visibleSections(VIEW, "all").map((section) => [section.id, section.items.length]), [["needs", 3], ["running", 2], ["finished", 1]]);
    assert.deepEqual(visibleSections(VIEW, "running").map((section) => section.id), ["running"]);
    assert.deepEqual(visibleSections({ ...VIEW, finishedToday: [] }, "all").map((section) => section.id), ["needs", "running"]);
    assert.match(text(render({ view: { ...VIEW, finishedToday: [] }, filter: "finished" })), /Finished today 0 None right now\./);
    assert.deepEqual(FILTERS.map((filter) => filter.key), ["1", "2", "3", "4"]);
  });

  it("maps the keys: j k and the arrows move, Enter opens, x stops, the digits filter, nothing with a modifier", () => {
    const key = (k: string, extra: Partial<Parameters<typeof drawerKeyAction>[0]> = {}) => drawerKeyAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra });
    assert.deepEqual(key("j"), { kind: "move", delta: 1 });
    assert.deepEqual(key("ArrowDown"), { kind: "move", delta: 1 });
    assert.deepEqual(key("k"), { kind: "move", delta: -1 });
    assert.deepEqual(key("ArrowUp"), { kind: "move", delta: -1 });
    assert.deepEqual(key("Enter"), { kind: "open" });
    assert.deepEqual(key("x"), { kind: "stop" });
    assert.deepEqual(key("1"), { kind: "filter", filter: "all" });
    assert.deepEqual(key("2"), { kind: "filter", filter: "needs" });
    assert.deepEqual(key("3"), { kind: "filter", filter: "running" });
    assert.deepEqual(key("4"), { kind: "filter", filter: "finished" });
    assert.equal(key("5"), null);
    assert.equal(key("Escape"), null);
    assert.equal(key("j", { ctrlKey: true }), null);
    assert.equal(key("j", { metaKey: true }), null);
    assert.equal(key("Enter", { target: { tagName: "BUTTON" } as unknown as EventTarget }), null, "a button keeps its own Enter");
    assert.equal(key("j", { target: { tagName: "INPUT" } as unknown as EventTarget }), null);
  });

  it("knows which rows can be stopped and what stopping asks", () => {
    assert.equal(stoppable(run), true);
    assert.equal(stoppable(task), true);
    assert.equal(stoppable(done), false);
    assert.equal(stoppable(approval), false);
    assert.equal(stopQuestion(run), `Stop the run ${RUN_NAME}? Working agents will be cancelled. Finished work stays.`);
    assert.equal(stopQuestion(run, { groups: [["done"], ["working", "no-update"]], chips: [] }), `Stop the run ${RUN_NAME}? 2 working agents will be cancelled. Finished work stays.`);
    assert.equal(stopQuestion(task), "Stop npm run test:e2e -- --grep sync?");
  });

  it("counts the elapsed time from the start, or from the end once there is one", () => {
    assert.equal(itemElapsed(run, NOW), "41m 16s");
    assert.equal(itemElapsed(approval, NOW), "1m 40s");
    assert.equal(itemElapsed(done, NOW), "48s");
    assert.equal(itemElapsed(elsewhere, NOW), "");
    assert.deepEqual(splitProgress("Judge · 6 of 10"), ["Judge · ", "6 of 10"]);
    assert.deepEqual(splitProgress("Stopped · 4 of 10 had landed"), ["Stopped · ", "4 of 10 had landed"]);
    assert.deepEqual(splitProgress("6 done · 3 working · more may start"), ["6 done · 3 working · more may start", null]);
    assert.deepEqual(splitProgress(null), ["", null]);
  });

  it("builds the model from the app's state: the run's cells and chips, and what Stop everything names", () => {
    const state = appState({
      route: { kind: "thread", sessionId: "s1" },
      sessions: { s1: session("s1", "Design the offline sync engine") },
      threads: { s1: thread(fold([...runEvents(), ...taskEvents(), ...approvalEvents()])) },
    });
    const model = activityModel(state, NOW);
    assert.deepEqual(model.view.needsYou.map((item) => [item.kind, item.text, item.sub]), [["request", "Run a shell command", APPROVAL_COMMAND]]);
    assert.deepEqual(model.view.working.map((item) => [item.kind, item.text, item.state]), [["run", RUN_NAME, "waiting-on-you"], ["task", TASK_COMMAND, "working"]]);
    assert.deepEqual(model.view.stopAll, { runs: 1, tasks: 1 });
    const key = activityKey(model.view.working[0] as ActivityItemVM);
    assert.deepEqual(model.runs[key], { groups: [["done"], ["working"]], chips: [{ kind: "needs", count: 1, text: "1 needs you" }] });
    assert.deepEqual(model.stopNames, { runs: [RUN_NAME], tasks: [TASK_COMMAND] });
    const markup = renderToStaticMarkup(createElement(ActivityDrawer, { open: true, view: model.view, runs: model.runs, stopNames: model.stopNames, filter: "all", now: NOW, onFilter() {}, onOpen() {}, onStop() {}, onStopAll() {}, onClose() {} }));
    assert.match(markup, /class="crew-strip"/);
    assert.match(markup, /1 needs you/);
    assert.match(text(markup), /Stop everything stops 1 run and 1 task in this thread/);
  });

  it("offers bulk stop for native-only work and names only the live agents in the open thread", () => {
    const native = (id: string, status: string, controlStatus?: string): ViewEvent => ({
      method: "item/updated", at: NOW,
      params: { item: {
        itemId: `item-${id}`, kind: "subagent", subagentId: id, status, revision: 1,
        role: id, controlStatus, recordedAt: new Date(NOW).toISOString(),
      } },
    });
    const events = [native("review", "inProgress"), native("queued", "inProgress", "starting"), native("done", "completed")];
    const state = appState({
      route: { kind: "thread", sessionId: "s1" },
      sessions: { s1: session("s1", "Review the module", { live: null }), s2: session("s2", "Other thread", { live: null }) },
      threads: { s1: thread(fold(events)), s2: thread(fold([native("elsewhere", "inProgress")])) },
    });
    const model = activityModel(state, NOW);
    assert.deepEqual(model.view.stopAll, { runs: 0, tasks: 0, agents: 2 });
    assert.deepEqual(model.stopNames, { runs: [], tasks: [], agents: ["review", "queued"] });
    assert.equal(model.view.working.filter((item) => item.kind === "subagent").length, 3, "the list still includes other threads");
    assert.deepEqual(model.view.finishedToday.map((item) => item.text), ["done"]);
    const markup = render({ view: model.view, stopNames: model.stopNames });
    assert.match(text(markup), /Stop everything stops 2 native agents in this thread/);

    const away = activityModel({ ...state, route: { kind: "home" } }, NOW);
    assert.equal(away.view.stopAll, null);
    assert.equal(away.stopNames, null);
  });
});
