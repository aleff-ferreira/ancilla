import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { TaskRow } from "../src/components/assistant/TasksPanel.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import type { AssistantTaskView } from "../src/types.js";

/**
 * A web task in the Tasks list: worked on by the assistant's own browser, so it has no turns to count and nothing to pause or
 * try again; while it waits for a site it shows the question with its four answers; what it found is shown as what it is.
 */

const task = (over: Partial<AssistantTaskView> = {}): AssistantTaskView => ({
  id: "t_1",
  title: "Look at A",
  goal: "Look at A",
  status: "running",
  reason: "Opened a.example",
  origin: "browse",
  cwd: "/work/atlas",
  sessionId: null,
  allowWrites: false,
  maxTurns: 6,
  maxMinutes: 30,
  turnsUsed: 0,
  retryAt: null,
  startedAt: 1,
  finishedAt: null,
  result: "",
  createdAt: 1,
  updatedAt: 1,
  progress: { done: 0, total: 1 },
  ...over,
});

function render(t: AssistantTaskView): string {
  const controller = { assistant: async () => ({}) } as unknown as AncillaController;
  const row = createElement(TaskRow, { task: t, now: 10, open: false, onToggle: () => undefined, changed: () => undefined, bump: 0 });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: row }) }));
}

describe("a web task in the Tasks list", () => {
  it("shows what it is, what it is doing, and only what can be done to it: stop it", () => {
    const html = render(task());
    assert.match(html, /Web task/);
    assert.match(html, /Opened a\.example/);
    assert.match(html, /reads web pages only, in its own browser/);
    assert.doesNotMatch(html, /turns/);
    assert.doesNotMatch(html, />Pause</);
    assert.doesNotMatch(html, />Resume</);
    assert.doesNotMatch(html, /Allow for this task/);
    assert.match(html, />Cancel</);
  });

  it("asks which site it may open when it waits, with four answers, and says that it needs the person", () => {
    const html = render(task({ status: "paused", reason: "Waiting for your approval to open https://a.example." }));
    assert.match(html, /Needs your OK/);
    assert.match(html, /Waiting for your approval to open https:\/\/a\.example\./);
    for (const label of ["Allow for this task", "Always allow", "Not now", "Block"]) assert.match(html, new RegExp(`>${label}<`), label);
    assert.doesNotMatch(html, />Resume</, "a web task cannot be resumed: it is waiting for an answer");
    assert.doesNotMatch(html, />Approve</);
    assert.match(html, />Cancel</);
  });

  it("shows the answer it found as what it is, and offers no retry when it ends", () => {
    const found = render(task({ status: "completed", reason: "Done after 2 steps.", result: "From the web (not checked):\nA says hello.\nPages: https://a.example/", progress: { done: 1, total: 1 }, finishedAt: 5 }));
    assert.match(found, /From the web \(not checked\):/);
    assert.match(found, /A says hello\./);
    assert.match(found, /Pages: https:\/\/a\.example\//);
    assert.doesNotMatch(found, />Cancel</, "it is over");
    const failed = render(task({ status: "failed", reason: "It used all 25 steps without an answer.", finishedAt: 5 }));
    assert.match(failed, /It used all 25 steps without an answer\./);
    assert.doesNotMatch(failed, /Try again/, "a web task is asked for again, not retried");
  });

  it("leaves the tasks of a Muse thread as they were: turns, pause, resume, and the proposal's approval", () => {
    const plain = render(task({ origin: "user", reason: "Turn 1 is running", progress: { done: 0, total: 2 }, turnsUsed: 1 }));
    assert.match(plain, /0 of 2 steps/);
    assert.match(plain, /1 of 6 turns/);
    assert.match(plain, />Pause</);
    assert.doesNotMatch(plain, /Web task/);
    assert.match(render(task({ origin: "user", status: "paused", reason: "Paused by you." })), />Resume</);
    assert.match(render(task({ origin: "user", status: "failed", reason: "It failed." })), /Try again/);
    const proposal = render(task({ origin: "voice", status: "paused", startedAt: null, reason: "Proposed by voice. Waiting for your approval to change files in atlas." }));
    assert.match(proposal, /Needs your approval/);
    assert.match(proposal, />Approve</);
    assert.match(proposal, />Decline</);
  });
});
