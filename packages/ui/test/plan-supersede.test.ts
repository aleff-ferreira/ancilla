/**
 * A plan is the record of one prompt. The finished plan of the last prompt must not stand in the dock beside the work
 * of the next one saying Complete, from the moment that prompt is sent.
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ThreadView } from "../src/components/thread/ThreadView.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { applyEvents, emptyFold, type LocalEcho, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, Store, type AppState, type ThreadState } from "../src/model/store.js";
import { taskPlanView } from "../src/model/taskPlan.js";
import type { LiveView, SessionSummary, ViewEvent } from "../src/types.js";
import { SESSION as BASE } from "./fixtures/lantern.js";

const T0 = Date.parse("2026-11-08T09:00:00.000Z");
// The card of a run that ended shows its report for a day, by the real clock. The story told here happens in one minute,
// so the clock stands in it, whatever day the tests are run: left to run, they would fail from the day after T0 on.
before(() => mock.timers.enable({ apis: ["Date"], now: T0 + 60_000 }));
after(() => mock.timers.reset());
const DONE = [{ text: "Read the code", status: "completed" }, { text: "Change it", status: "completed" }, { text: "Check it", status: "completed" }];
const OPEN = [{ text: "Read the code", status: "completed" }, { text: "Change it", status: "in_progress", active_form: "Changing it" }, { text: "Check it", status: "pending" }];
const started = (turnId: string, at: number): ViewEvent => ({ method: "turn/started", params: { turnId }, at });
const ended = (turnId: string, at: number): ViewEvent => ({ method: "turn/completed", params: { turnId, terminal: "completed" }, at });
const planned = (items: unknown, turnId: string, at: number): ViewEvent => ({ method: "session/todoListChanged", params: { items, turnId }, at });
const call = (id: string, turnId: string, at: number): ViewEvent => ({
  method: "item/started", params: { item: { itemId: id, kind: "toolCall", tool: "bash", status: "inProgress", revision: 1, turnId, args: JSON.stringify({ command: "npm test" }) } }, at,
});
const echo = (disposition: LocalEcho["disposition"], turnId: string | null = null): LocalEcho => ({ localId: `e-${disposition}`, text: "and now this", turnId, disposition, createdAt: T0 + 9_000 });

/** The first prompt finished with every step done. */
const finished = (): ThreadFold => applyEvents(emptyFold(), [started("t1", T0), planned(DONE, "t1", T0 + 1_000), ended("t1", T0 + 2_000)]);

const SESSION: SessionSummary = { ...BASE, live: null };
const LIVE: LiveView = { activeTurnId: "t2", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null };

function render(fold: ThreadFold, live: LiveView | null): string {
  const thread: ThreadState = { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold, attachments: [], shellRuns: [], researchRuns: [], stalled: false };
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-11-08T00:00:00.000Z")), connection: "open", sessions: { s1: { ...SESSION, live } }, threads: { s1: thread } });
  const controller = { store, setCardOpen() {}, markLeft() {} } as unknown as AncillaController;
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) error(...args);
  };
  try {
    return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(ThreadView, { sessionId: "s1" }) }) }));
  } finally {
    console.error = error;
  }
}

const planCard = (markup: string): boolean => markup.includes('aria-label="Plan"');

describe("a plan settled for an earlier prompt", () => {
  it("is the record while nothing newer has happened: Complete, the spine of the card that reports that prompt", () => {
    const view = taskPlanView(finished())!;
    assert.equal(view.state, "complete");
    assert.equal(view.superseded, false);
    const markup = render(finished(), null);
    assert.equal(planCard(markup), false, "its own prompt's plan is part of that prompt's card, not a second card");
    assert.match(markup, /aria-label="Turn finished[^"]*"/, "the card that reports the prompt");
    assert.match(markup, /role="progressbar" aria-label="Plan steps completed"[^>]*aria-valuenow="3"/, "with the finished plan as its spine");
  });

  it("is an earlier prompt's the moment a newer one is sent, before Muse says its turn began", () => {
    for (const disposition of ["sending", "started"] as const) {
      const fold = { ...finished(), echoes: [echo(disposition)] };
      const view = taskPlanView(fold)!;
      assert.equal(view.superseded, true, `${disposition}: a prompt is on its way`);
      assert.equal(view.state, "previous");
      assert.equal(view.label, "Previous plan");
      assert.equal(view.remaining, 0);
      assert.equal(view.animate, false);
    }
  });

  it("is gone while the newer prompt runs, whether or not it has a plan yet, and the live card is there", () => {
    const fold = applyEvents(finished(), [started("t2", T0 + 5_000), call("c1", "t2", T0 + 6_000)]);
    assert.equal(taskPlanView(fold)?.superseded, true);
    const markup = render(fold, LIVE);
    assert.equal(planCard(markup), false, "the finished plan does not stand beside the live card");
    assert.match(markup, /aria-label="Agents and tasks"/, "the live card is there");
    assert.doesNotMatch(markup, /Muse marked every step complete/);
  });

  it("stays gone after the newer prompt ends without a plan of its own", () => {
    const fold = applyEvents(finished(), [started("t2", T0 + 5_000), ended("t2", T0 + 8_000)]);
    assert.equal(taskPlanView(fold)?.superseded, true, "a later prompt began after the plan was reported");
    assert.equal(planCard(render(fold, null)), false);
  });

  it("does not come back as the newer prompt's own plan: that one is part of the live card", () => {
    const fold = applyEvents(finished(), [started("t2", T0 + 5_000), planned(OPEN, "t2", T0 + 6_000), call("c1", "t2", T0 + 6_500)]);
    const view = taskPlanView(fold)!;
    assert.equal(view.turnId, "t2");
    assert.equal(view.superseded, false, "it is the running prompt's own");
    assert.equal(view.state, "working");
    const markup = render(fold, LIVE);
    assert.equal(planCard(markup), false, "folded into the run card, not a second card");
    assert.match(markup, /role="progressbar" aria-label="Plan steps completed"/, "the steps are the card's spine");
    assert.match(markup, /Changing it/);
  });
});

describe("what does not make a plan old", () => {
  it("a steer, a queued follow-up or an unconfirmed send while the plan's own prompt runs", () => {
    const running = applyEvents(emptyFold(), [started("t1", T0), planned(OPEN, "t1", T0 + 1_000)]);
    for (const disposition of ["sending", "started", "steered", "queued", "unconfirmed"] as const) {
      const view = taskPlanView({ ...running, echoes: [echo(disposition, "t1")] })!;
      assert.equal(view.superseded, false, `${disposition}: it is the same prompt`);
      assert.equal(view.state, "working");
    }
  });

  it("a queued, steered or unconfirmed message after the prompt ended is not a new prompt either", () => {
    for (const disposition of ["steered", "queued", "unconfirmed"] as const) {
      assert.equal(taskPlanView({ ...finished(), echoes: [echo(disposition)] })?.superseded, false, disposition);
    }
  });

  it("steps nobody confirmed: an earlier prompt's unfinished plan is kept, as Previous plan, so the open work is not hidden", () => {
    const fold = applyEvents(emptyFold(), [started("t1", T0), planned(OPEN, "t1", T0 + 1_000), ended("t1", T0 + 2_000), started("t2", T0 + 3_000)]);
    const view = taskPlanView(fold)!;
    assert.equal(view.superseded, true);
    assert.equal(view.state, "previous");
    assert.equal(view.remaining, 2);
    assert.equal(planCard(render(fold, LIVE)), true, "still a card of its own");
  });
});
