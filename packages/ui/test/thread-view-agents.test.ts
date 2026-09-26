import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ThreadView } from "../src/components/thread/ThreadView.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, Store, type AppState, type ThreadState } from "../src/model/store.js";
import type { LiveView, MspItem, SessionSummary } from "../src/types.js";

const LIVE: LiveView = { activeTurnId: "turn-live", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null };

const SESSION: SessionSummary = {
  sessionId: "s1", cwd: "/work/app", title: "Swarm", titleSource: "auto", turnCount: 3, modelId: null, origin: "ancilla",
  archived: false, createdAt: "2026-09-25T00:00:00.000Z", activityAt: "2026-09-25T00:00:00.000Z", settled: false, settledAt: null,
  unsettledAt: null, sandboxDisabled: false, accountId: null, live: LIVE,
};

function thread(extra: Partial<ThreadState> = {}): ThreadState {
  return { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(), attachments: [], shellRuns: [], stalled: false, ...extra };
}

/** The agents section of a server-rendered ThreadView, as its text. */
function agentsText(state: Partial<AppState>): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-25T00:00:00.000Z")), connection: "open", sessions: { s1: SESSION }, ...state });
  const controller = { store } as unknown as AncillaController;
  // The composer's layout effects only matter in a browser; React says so on every server render.
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) error(...args);
  };
  let markup: string;
  try {
    markup = renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(ThreadView, { sessionId: "s1" }) }) }));
  } finally {
    console.error = error;
  }
  const section = /<section aria-label="Agents"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
  return section.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function workflow(children: MspItem["children"]): MspItem {
  return { itemId: "wf", kind: "workflow", revision: 1, status: "inProgress", turnId: "turn-live", children };
}

describe("ThreadView agents panel", () => {
  it("does not claim a thread has no agents while its history is still being read", () => {
    for (const load of ["idle", "loading"] as const) {
      const text = agentsText({ threads: { s1: thread({ load }) } });
      assert.match(text, /Loading agent activity/, load);
      assert.doesNotMatch(text, /No agents yet|working solo|no agents recorded/, load);
    }
    // Before the stream says hello the connection is not open; that is still not a record of no agents.
    const early = agentsText({ connection: "connecting", threads: { s1: thread({ load: "loading" }) } });
    assert.match(early, /Loading agent activity/);
    assert.doesNotMatch(early, /no agents recorded/);
  });

  it("says when agent activity could not be loaded instead of reporting none", () => {
    const text = agentsText({ threads: { s1: thread({ load: "error", error: "boom" }) } });
    assert.match(text, /Agent activity not loaded/);
    assert.doesNotMatch(text, /No agents yet/);
  });

  it("shows what a thread already holds while it reloads, and the empty state once loaded", () => {
    const fold = applyEvents(emptyFold(), [{ method: "item/updated", params: { item: workflow([{ childId: "one", attempt: 1, status: "started", label: "read-alpha" }]) } }]);
    assert.match(agentsText({ threads: { s1: thread({ load: "loading", fold }) } }), /Read alpha/);
    assert.match(agentsText({ threads: { s1: thread() }, sessions: { s1: { ...SESSION, live: null } } }), /No agents yet/);
  });

  it("shows background agents as last known while the live view is unavailable and nothing has moved since", () => {
    const fold = applyEvents(emptyFold(), [{ method: "item/updated", params: { item: { ...workflow([{ childId: "one", attempt: 1, status: "started" }]), turnId: "finished" } } }]);
    const live = { ...LIVE, activeTurnId: null, viewHealth: { status: "unavailable", reason: "projectionUnavailable" } };
    const text = agentsText({ threads: { s1: thread({ fold }) }, sessions: { s1: { ...SESSION, live } } });
    assert.match(text, /Last known activity/);
    assert.match(text, /1 was working/);
    assert.doesNotMatch(agentsText({ threads: { s1: thread({ fold }) }, sessions: { s1: { ...SESSION, live: { ...live, viewHealth: null } } } }), /Last known/);
  });

  it("labels totals from a capped history as covering only the loaded history", () => {
    const fold = applyEvents(emptyFold(), [{ method: "item/updated", params: { item: workflow([{ childId: "one", attempt: 1, status: "completed" }]) } }]);
    assert.match(agentsText({ threads: { s1: thread({ fold, truncated: true }) } }), /1 completed in loaded history/);
    assert.match(agentsText({ threads: { s1: thread({ truncated: true }) } }), /No agents in loaded history/);
    assert.doesNotMatch(agentsText({ threads: { s1: thread({ fold }) } }), /loaded history/);
  });
});
