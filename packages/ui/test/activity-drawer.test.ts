import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityDrawer, FILTERS, activityModel, drawerKeyAction, stopAllQuestion, stopAllText, visibleSections, type ActivityDrawerProps } from "../src/components/crew/ActivityDrawer.js";
import { activityKey, itemElapsed, splitProgress, stopQuestion, stoppable } from "../src/components/crew/ActivityItem.js";
import { MOD } from "../src/components/ui/primitives.js";
import type { ActivityItemVM, ActivityVM } from "../src/model/crew.js";
import type { ViewEvent } from "../src/types.js";
import { APPROVAL_COMMAND, NOW, RUN_NAME, TASK_COMMAND, appState, approvalEvents, fold, runEvents, session, taskEvents, thread } from "./crew-fixtures.js";

const DEFAULT_ORIGIN_MS = 1_700_000_000_000;
const TRACKING_NOTE = "Other threads appear here once Ancilla tracks them (coming in 1.1)";

function createMockItem(partial: Partial<ActivityItemVM> = {}): ActivityItemVM {
  return {
    sessionId: "sess-prime",
    project: "ancilla-core",
    thread: "Engine refactor",
    itemId: null,
    agentId: null,
    kind: "request",
    text: "Default item",
    sub: null,
    state: "request",
    startedAt: DEFAULT_ORIGIN_MS - 30_000,
    endedAt: null,
    stale: false,
    ...partial,
  };
}

function createMockActivityVM(custom: Partial<ActivityVM> = {}): ActivityVM {
  return {
    needsYou: [],
    working: [],
    finishedToday: [],
    stopAll: null,
    foot: "Execution summary footer",
    empty: false,
    note: TRACKING_NOTE,
    ...custom,
  };
}

function renderDrawerHtml(customProps: Partial<ActivityDrawerProps> = {}): string {
  const completeProps: ActivityDrawerProps = {
    open: true,
    view: createMockActivityVM(),
    filter: "all",
    now: DEFAULT_ORIGIN_MS,
    onFilter: () => {},
    onOpen: () => {},
    onStop: () => {},
    onStopAll: () => {},
    onClose: () => {},
    ...customProps,
  };
  return renderToStaticMarkup(createElement(ActivityDrawer, completeProps));
}

function cleanHtmlText(rawMarkup: string): string {
  return rawMarkup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("ActivityDrawer accessibility and modal presentation", () => {
  it("renders accessible modal container with platform shortcut chord in header", () => {
    const markup = renderDrawerHtml();
    assert.match(markup, /aria-label="Activity"/);
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);

    const shortcutRegex = new RegExp(
      `<h2[^>]*>[\\s\\S]*Activity[\\s\\S]*<kbd[^>]*>${MOD}</kbd><kbd[^>]*>Shift</kbd><kbd[^>]*>A</kbd>`,
    );
    assert.match(markup, shortcutRegex);
    assert.match(markup, /aria-label="Close"/);
  });

  it("yields empty output when drawer is marked closed", () => {
    const closedHtml = renderDrawerHtml({ open: false });
    assert.equal(closedHtml, "");
  });

  it("displays quiet slate when no active or waiting items exist", () => {
    const quietView = createMockActivityVM({
      needsYou: [],
      working: [],
      finishedToday: [],
      empty: true,
      stopAll: null,
      foot: "Nothing runs and nothing waits for you.",
      note: null,
    });
    const markup = renderDrawerHtml({ view: quietView });
    const textOutput = cleanHtmlText(markup);

    assert.match(textOutput, /All quiet\. Nothing runs and nothing waits for you\./);
    assert.doesNotMatch(markup, /role="list"/);
    assert.doesNotMatch(markup, /Stop everything/);
  });
});

describe("ActivityDrawer item rendering across kinds and states", () => {
  it("formats user confirmation queries and shell execution requests", () => {
    const shellItem = createMockItem({
      itemId: "cmd-ask-1",
      kind: "request",
      text: "Run a shell command",
      sub: APPROVAL_COMMAND,
    });
    const shellMarkup = renderDrawerHtml({
      view: createMockActivityVM({ needsYou: [shellItem] }),
    });

    assert.match(shellMarkup, /Muse wants to run a shell command/);
    const escapedCmd = APPROVAL_COMMAND.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    assert.match(shellMarkup, new RegExp(`<code[^>]*>${escapedCmd}</code>`));
    assert.match(shellMarkup, /Review<\/button>/);
  });

  it("renders interactive query prompts and handles unparsed background requests", () => {
    const questionItem = createMockItem({
      sessionId: "sess-q",
      thread: "Passkey setup",
      kind: "request",
      text: "Muse asked a question",
      sub: "Which passkey provider should go first, Apple or Google?",
      startedAt: DEFAULT_ORIGIN_MS - 600_000,
    });
    const qMarkup = renderDrawerHtml({
      view: createMockActivityVM({ needsYou: [questionItem] }),
    });
    assert.match(qMarkup, /Answer<\/button>/);
    assert.match(qMarkup, /Muse asks<\/b> · “Which passkey provider should go first, Apple or Google\?”/);

    const unparsedWaitItem = createMockItem({
      sessionId: "sess-ext",
      kind: "request",
      text: "2 requests waiting",
      sub: null,
      stale: true,
    });
    const waitMarkup = renderDrawerHtml({
      view: createMockActivityVM({ needsYou: [unparsedWaitItem] }),
    });
    assert.doesNotMatch(waitMarkup, /Muse wants to 2 requests/);
    assert.match(waitMarkup, /<b class="font-medium text-fg">2 requests waiting<\/b>/);
  });

  it("renders workflow run items with visual strip, progress milestones, and stop trigger", () => {
    const workflowItem = createMockItem({
      itemId: "run-wf-9",
      kind: "run",
      text: RUN_NAME,
      sub: "Judge · 6 of 10",
      state: "failed",
      startedAt: DEFAULT_ORIGIN_MS - 2_500_000,
    });

    const runKey = activityKey(workflowItem);
    const markup = renderDrawerHtml({
      view: createMockActivityVM({ working: [workflowItem] }),
      runs: {
        [runKey]: {
          groups: [["done", "done"], ["working", "failed"]],
          chips: [{ kind: "failed", count: 1, text: "1 failed" }],
        },
      },
    });

    assert.ok(markup.includes(`aria-label="Stop ${RUN_NAME}"`));
    assert.match(markup, /class="crew-strip"/);
    assert.match(markup, /Judge · <b class="font-medium text-fg">6 of 10<\/b>/);
    assert.match(markup, /Open<\/button>/);
    assert.match(markup, /1 failed<\/span>/);
  });

  it("displays running commands in monospace font and finished commands with outcomes", () => {
    const activeTask = createMockItem({
      itemId: "task-live",
      agentId: "task-live",
      kind: "task",
      text: "npm run test:e2e -- --grep sync",
      sub: '12 passed · 3 pending · running "merges concurrent edits"',
      state: "working",
      startedAt: DEFAULT_ORIGIN_MS - 75_000,
    });
    const completedTask = createMockItem({
      itemId: "task-ended",
      agentId: "task-ended",
      kind: "task",
      text: TASK_COMMAND,
      sub: "finished · no failure reported",
      state: "done",
      startedAt: DEFAULT_ORIGIN_MS - 300_000,
      endedAt: DEFAULT_ORIGIN_MS - 25_000,
    });

    const markup = renderDrawerHtml({
      view: createMockActivityVM({
        working: [activeTask],
        finishedToday: [completedTask],
      }),
    });

    assert.match(markup, /<code class="[^"]*font-mono[^"]*">npm run test:e2e -- --grep sync<\/code>/);
    assert.match(markup, /›<\/span><span class="min-w-0 truncate">12 passed · 3 pending · running &quot;merges concurrent edits&quot;<\/span>/);
    assert.match(markup, /aria-label="Stop npm run test:e2e -- --grep sync"/);

    assert.match(markup, new RegExp(`<code[^>]*>${TASK_COMMAND.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}<\\/code>`));
    assert.match(markup, /finished · no failure reported/);
    assert.doesNotMatch(markup, new RegExp(`aria-label="Stop ${TASK_COMMAND.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"`));
  });

  it("positions experimental tracker note directly following the working section", () => {
    const sampleView = createMockActivityVM({
      needsYou: [createMockItem({ text: "Request A" })],
      working: [createMockItem({ kind: "task", text: "Task B", state: "working" })],
      finishedToday: [createMockItem({ kind: "task", text: "Done C", state: "done" })],
      note: TRACKING_NOTE,
    });

    const fullText = cleanHtmlText(renderDrawerHtml({ view: sampleView }));
    // Skip past the filter chips at the top which repeat section labels
    const bodyContent = fullText.slice(fullText.indexOf("Finished today 1") + 16);
    const idxWorking = bodyContent.indexOf("Working 1");
    const idxBanner = bodyContent.indexOf(TRACKING_NOTE);
    const idxFinished = bodyContent.indexOf("Finished today 1");

    assert.ok(idxWorking >= 0, "Working section exists in body");
    assert.ok(idxWorking < idxBanner, "Working precedes Tracking Notice");
    assert.ok(idxBanner < idxFinished, "Tracking Notice precedes Finished");

    const omittedNoteText = cleanHtmlText(renderDrawerHtml({ view: { ...sampleView, note: null } }));
    assert.doesNotMatch(omittedNoteText, new RegExp(TRACKING_NOTE));

    const filteredText = cleanHtmlText(renderDrawerHtml({ view: sampleView, filter: "needs" }));
    assert.doesNotMatch(filteredText, new RegExp(TRACKING_NOTE));
  });
});

describe("ActivityDrawer section filtering and metrics breakdown", () => {
  it("accurately computes section distributions and filter chip indicators", () => {
    const populatedView = createMockActivityVM({
      needsYou: [createMockItem({ text: "N1" }), createMockItem({ text: "N2" }), createMockItem({ text: "N3" })],
      working: [createMockItem({ kind: "run", text: "R1", state: "working" }), createMockItem({ kind: "task", text: "T1", state: "working" })],
      finishedToday: [createMockItem({ kind: "task", text: "D1", state: "done" })],
    });

    const markup = renderDrawerHtml({ view: populatedView });
    const textOutput = cleanHtmlText(markup);

    assert.match(textOutput, /All 6 Needs you 3 Working 2 Finished today 1/);
    assert.match(markup, /aria-pressed="true"[^>]*>All/);
    assert.match(markup, /aria-pressed="false"[^>]*>(<span[^>]*><\/span>)?Needs you/);

    const visibleCatalog = visibleSections(populatedView, "all");
    assert.deepEqual(
      visibleCatalog.map((sec) => [sec.id, sec.items.length]),
      [["needs", 3], ["running", 2], ["finished", 1]],
    );

    const singleCategory = visibleSections(populatedView, "running");
    assert.deepEqual(singleCategory.map((sec) => sec.id), ["running"]);

    const emptyFinishedView = { ...populatedView, finishedToday: [] };
    assert.deepEqual(
      visibleSections(emptyFinishedView, "all").map((sec) => sec.id),
      ["needs", "running"],
    );

    const emptySectionMarkup = renderDrawerHtml({ view: emptyFinishedView, filter: "finished" });
    assert.match(cleanHtmlText(emptySectionMarkup), /Finished today 0 None right now\./);

    assert.deepEqual(FILTERS.map((f) => f.key), ["1", "2", "3", "4"]);
  });
});

describe("Activity navigation and keyboard command dispatcher", () => {
  it("translates navigational keys, actions, and numeric filter shortcuts", () => {
    const dispatch = (stroke: string, extraAttrs: Partial<Parameters<typeof drawerKeyAction>[0]> = {}) =>
      drawerKeyAction({
        key: stroke,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        ...extraAttrs,
      });

    assert.deepEqual(dispatch("j"), { kind: "move", delta: 1 });
    assert.deepEqual(dispatch("ArrowDown"), { kind: "move", delta: 1 });
    assert.deepEqual(dispatch("k"), { kind: "move", delta: -1 });
    assert.deepEqual(dispatch("ArrowUp"), { kind: "move", delta: -1 });
    assert.deepEqual(dispatch("Enter"), { kind: "open" });
    assert.deepEqual(dispatch("x"), { kind: "stop" });

    assert.deepEqual(dispatch("1"), { kind: "filter", filter: "all" });
    assert.deepEqual(dispatch("2"), { kind: "filter", filter: "needs" });
    assert.deepEqual(dispatch("3"), { kind: "filter", filter: "running" });
    assert.deepEqual(dispatch("4"), { kind: "filter", filter: "finished" });

    assert.equal(dispatch("5"), null);
    assert.equal(dispatch("Escape"), null);

    assert.equal(dispatch("j", { ctrlKey: true }), null);
    assert.equal(dispatch("k", { metaKey: true }), null);
    assert.equal(dispatch("ArrowDown", { altKey: true }), null);

    const mockBtn = { tagName: "BUTTON" } as unknown as EventTarget;
    assert.equal(dispatch("Enter", { target: mockBtn }), null);

    const mockInput = { tagName: "INPUT" } as unknown as EventTarget;
    assert.equal(dispatch("j", { target: mockInput }), null);

    const mockTextArea = { tagName: "TEXTAREA" } as unknown as EventTarget;
    assert.equal(dispatch("x", { target: mockTextArea }), null);
  });

  it("evaluates stoppable states and formats confirmation dialogue copy", () => {
    const runItem = createMockItem({ itemId: "wf", kind: "run", text: RUN_NAME, state: "failed" });
    const taskItem = createMockItem({ itemId: "task-live", agentId: "task-live", kind: "task", text: "npm run test:e2e -- --grep sync", state: "working" });
    const doneItem = createMockItem({ itemId: "task-done", agentId: "task-done", kind: "task", text: TASK_COMMAND, state: "done", endedAt: NOW - 50_000 });
    const reqItem = createMockItem({ itemId: "req-1", kind: "request", state: "request" });

    assert.equal(stoppable(runItem), true);
    assert.equal(stoppable(taskItem), true);
    assert.equal(stoppable(doneItem), false);
    assert.equal(stoppable(reqItem), false);

    assert.equal(
      stopQuestion(runItem),
      `Stop the run ${RUN_NAME}? Working agents will be cancelled. Finished work stays.`,
    );
    assert.equal(
      stopQuestion(runItem, { groups: [["done"], ["working", "no-update"]], chips: [] }),
      `Stop the run ${RUN_NAME}? 2 working agents will be cancelled. Finished work stays.`,
    );
    assert.equal(stopQuestion(taskItem), "Stop npm run test:e2e -- --grep sync?");
  });

  it("calculates formatted durations from timestamps", () => {
    const runItem = createMockItem({ startedAt: NOW - (41 * 60 + 16) * 1000 });
    const approvalItem = createMockItem({ startedAt: NOW - 100_000 });
    const completedItem = createMockItem({ startedAt: NOW - 400_000, endedAt: NOW - 48_000 });
    const timelessItem = createMockItem({ startedAt: null, endedAt: null });

    assert.equal(itemElapsed(timelessItem, NOW), "");
    assert.equal(itemElapsed(runItem, NOW), "41m 16s");
    assert.equal(itemElapsed(completedItem, NOW), "48s");
    assert.equal(itemElapsed(approvalItem, NOW), "1m 40s");
  });

  it("decomposes run progress status strings into prefix and metrics", () => {
    assert.deepEqual(splitProgress(null), ["", null]);
    assert.deepEqual(splitProgress("6 done · 3 working · more may start"), ["6 done · 3 working · more may start", null]);
    assert.deepEqual(splitProgress("Judge · 6 of 10"), ["Judge · ", "6 of 10"]);
    assert.deepEqual(splitProgress("Stopped · 4 of 10 had landed"), ["Stopped · ", "4 of 10 had landed"]);
  });
});

describe("Activity model projection and bulk cancellation", () => {
  it("formats bulk termination questions and descriptive summaries", () => {
    assert.equal(
      stopAllText({ runs: 2, tasks: 0 }),
      "Stop everything stops 2 runs in this thread. Approvals stay open.",
    );
    assert.equal(
      stopAllQuestion({ runs: 2, tasks: 1 }),
      "Stop everything? Stops 2 runs and 1 task. Approvals stay open.",
    );
    assert.equal(
      stopAllText({ runs: 0, tasks: 0, agents: 1 }),
      "Stop everything stops 1 native agent in this thread. Approvals stay open.",
    );
    assert.equal(
      stopAllQuestion({ runs: 1, tasks: 2, agents: 3 }),
      "Stop everything? Stops 1 run, 2 tasks and 3 native agents. Approvals stay open.",
    );

    const markup = renderDrawerHtml({
      view: createMockActivityVM({
        stopAll: { runs: 1, tasks: 1 },
      }),
    });
    assert.match(cleanHtmlText(markup), /Stop everything stops 1 run and 1 task in this thread\. Approvals stay open\. Stop everything/);

    const calmView = createMockActivityVM({
      stopAll: null,
      foot: "2 running in 1 thread · 1.1M tokens in current runs",
    });
    const calmMarkup = renderDrawerHtml({ view: calmView });
    assert.doesNotMatch(calmMarkup, /Stop everything/);
    assert.match(cleanHtmlText(calmMarkup), /2 running in 1 thread · 1\.1M tokens in current runs/);
  });

  it("synthesizes activity model projection from complete application state", () => {
    const rawEvents = [...runEvents(), ...taskEvents(), ...approvalEvents()];
    const hydratedState = appState({
      route: { kind: "thread", sessionId: "s1" },
      sessions: { s1: session("s1", "Design the offline sync engine") },
      threads: { s1: thread(fold(rawEvents)) },
    });

    const projection = activityModel(hydratedState, NOW);
    assert.deepEqual(
      projection.view.needsYou.map((i) => [i.kind, i.text, i.sub]),
      [["request", "Run a shell command", APPROVAL_COMMAND]],
    );
    assert.deepEqual(
      projection.view.working.map((i) => [i.kind, i.text, i.state]),
      [["run", RUN_NAME, "waiting-on-you"], ["task", TASK_COMMAND, "working"]],
    );
    assert.deepEqual(projection.view.stopAll, { runs: 1, tasks: 1 });

    const targetKey = activityKey(projection.view.working[0] as ActivityItemVM);
    assert.deepEqual(projection.runs[targetKey], {
      groups: [["done"], ["working"]],
      chips: [{ kind: "needs", count: 1, text: "1 needs you" }],
    });
    assert.deepEqual(projection.stopNames, {
      runs: [RUN_NAME],
      tasks: [TASK_COMMAND],
    });

    const rendered = renderToStaticMarkup(
      createElement(ActivityDrawer, {
        open: true,
        view: projection.view,
        runs: projection.runs,
        stopNames: projection.stopNames,
        filter: "all",
        now: NOW,
        onFilter: () => {},
        onOpen: () => {},
        onStop: () => {},
        onStopAll: () => {},
        onClose: () => {},
      }),
    );

    assert.match(rendered, /class="crew-strip"/);
    assert.match(rendered, /1 needs you/);
    assert.match(cleanHtmlText(rendered), /Stop everything stops 1 run and 1 task in this thread/);
  });

  it("identifies active native subagents and restricts bulk cancellation to focused session", () => {
    const createSubagentEvent = (agentId: string, status: string, ctrl?: string): ViewEvent => ({
      method: "item/updated",
      at: NOW,
      params: {
        item: {
          itemId: `item-${agentId}`,
          kind: "subagent",
          subagentId: agentId,
          status,
          revision: 1,
          role: agentId,
          controlStatus: ctrl,
          recordedAt: new Date(NOW).toISOString(),
        },
      },
    });

    const sessEvents = [
      createSubagentEvent("review", "inProgress"),
      createSubagentEvent("queued", "inProgress", "starting"),
      createSubagentEvent("done", "completed"),
    ];

    const compositeState = appState({
      route: { kind: "thread", sessionId: "s1" },
      sessions: {
        s1: session("s1", "Review module", { live: null }),
        s2: session("s2", "Background thread", { live: null }),
      },
      threads: {
        s1: thread(fold(sessEvents)),
        s2: thread(fold([createSubagentEvent("elsewhere", "inProgress")])),
      },
    });

    const modelResult = activityModel(compositeState, NOW);
    assert.deepEqual(modelResult.view.stopAll, { runs: 0, tasks: 0, agents: 2 });
    assert.deepEqual(modelResult.stopNames, { runs: [], tasks: [], agents: ["review", "queued"] });
    assert.equal(
      modelResult.view.working.filter((item) => item.kind === "subagent").length,
      3,
      "global working catalog includes subagents from background sessions",
    );
    assert.deepEqual(
      modelResult.view.finishedToday.map((item) => item.text),
      ["done"],
    );

    const rendered = renderDrawerHtml({
      view: modelResult.view,
      stopNames: modelResult.stopNames,
    });
    assert.match(cleanHtmlText(rendered), /Stop everything stops 2 native agents in this thread/);

    const outsideHomeState = activityModel({ ...compositeState, route: { kind: "home" } }, NOW);
    assert.equal(outsideHomeState.view.stopAll, null);
    assert.equal(outsideHomeState.stopNames, null);
  });
});
