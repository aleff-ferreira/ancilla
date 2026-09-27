import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { focusRequestPanel } from "../src/components/crew/HeaderChips.js";
import { ThreadView } from "../src/components/thread/ThreadView.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, Store, type AppState, type ThreadState } from "../src/model/store.js";
import type { LiveView, SessionSummary, ViewEvent } from "../src/types.js";
import { APPROVAL, S, SESSION as LANTERN, lantern, launch, textOf as text } from "./fixtures/lantern.js";
import { runningResearch } from "./fixtures/research.js";

const LIVE: LiveView = { activeTurnId: "t1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null };
const SESSION: SessionSummary = { ...LANTERN, live: LIVE };

function thread(extra: Partial<ThreadState> = {}): ThreadState {
  return { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(), attachments: [], shellRuns: [], researchRuns: [], stalled: false, ...extra };
}

function fold(events: ViewEvent[]): ThreadFold {
  return applyEvents(emptyFold(), events);
}

/** A server-rendered ThreadView. */
function render(state: Partial<AppState>, prefs: Partial<AppState["prefs"]> = {}): string {
  const store = new Store<AppState>({ ...initialState({ ...defaultPrefs("2026-09-26T00:00:00.000Z"), ...prefs }), connection: "open", sessions: { s1: SESSION }, ...state });
  const controller = { store, setCardOpen() {}, markLeft() {} } as unknown as AncillaController;
  // The composer's layout effects only matter in a browser; React says so on every server render.
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

function card(markup: string): string {
  return /<section aria-label="Agents and tasks"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
}

/** The lantern run with its turn still going, as a thread Muse is working in. */
function running(): ThreadFold {
  return fold([{ method: "turn/started", params: { turnId: "t1" }, at: S(0, 0) }, launch(), ...lantern().events]);
}

describe("ThreadView with the Crew card", () => {
  it("renders no card, no strip and no live region for an idle thread", () => {
    const markup = render({ threads: { s1: thread() }, sessions: { s1: { ...SESSION, live: null } } });
    assert.doesNotMatch(markup, /aria-label="Agents"/, "the old Agents panel is gone");
    assert.doesNotMatch(markup, /Agents and tasks|crew-line|crew-card/);
    assert.doesNotMatch(markup, /data-crew-announcer/);
    assert.doesNotMatch(markup, /working solo|No agents yet|Lead agent/);
  });

  it("mounts the card in the dock, above the request panel, once the thread has a live run", () => {
    const markup = render({ threads: { s1: thread({ fold: running() }) } });
    const section = card(markup);
    assert.ok(section, "the card is there");
    assert.match(text(section), /offline-sync-research-design/);
    assert.equal((section.match(/class="crew-strip rail"/g) ?? []).length, 4, "the rail's four segments");
    assert.equal((markup.match(/data-crew-announcer/g) ?? []).length, 1, "one live region for the crew");
    const header = /<header[\s\S]*?<\/header>/.exec(markup)?.[0] ?? "";
    assert.doesNotMatch(header, /aria-live|role="status"/, "the header has no live region");
    assert.doesNotMatch(card(markup), /aria-live|role="status"/, "nor does the card itself");
    // The run's transcript row points at the dock.
    assert.match(text(markup), /Started workflow offline-sync-research-design · 10 agents in 4 phases in the dock/);
    assert.doesNotMatch(markup, /WorkflowCard|aria-label="Workflow"/);
    // Expanded by default: the head, the rail and the footer.
    assert.match(section, /class="crew-head"/);
    assert.match(section, /role="tablist"/);
    assert.match(text(section), /All 10 agents/);
  });

  it("mounts the card for a live research run, labelled Deep research, with a rail segment per round", () => {
    const markup = render({ threads: { s1: thread({ researchRuns: [runningResearch()] }) }, sessions: { s1: { ...SESSION, live: null } } });
    const section = card(markup);
    assert.ok(section, "the card is there without any Muse item");
    assert.match(text(section), /Deep research/);
    assert.equal((section.match(/class="crew-strip rail"/g) ?? []).length, 2, "one segment per round");
    assert.match(section, /data-agent-kind="research"/);
    assert.match(text(section), /Round 1 of 12/);
    assert.match(text(section), /All 3 agents/);
    assert.match(text(section), /Stop run/);
    assert.match(markup, /class="n @max-\[700px\]:hidden" aria-hidden="true">3</, "the Crew toggle counts the workers");
    assert.doesNotMatch(markup, /No agents in this thread/);
  });

  it("collapses to lines when the card is collapsed in the prefs", () => {
    const markup = render({ threads: { s1: thread({ fold: running() }) } }, { collapsedCards: ["crew:s1"] });
    const section = card(markup);
    assert.match(section, /class="crew-line"/);
    assert.doesNotMatch(section, /crew-head/);
  });

  it("puts the Crew toggle with its count before the files toggle, and the Working clock in the header", () => {
    const markup = render({ threads: { s1: thread({ fold: running() }) } });
    const crewAt = markup.indexOf('aria-label="Show the Crew panel"');
    const filesAt = markup.indexOf('aria-label="Show files"');
    assert.ok(crewAt > 0 && filesAt > crewAt, "Crew toggle, then files");
    assert.match(markup, /class="n @max-\[700px\]:hidden" aria-hidden="true">10</);
    assert.match(markup, /class="crew-status"><span[^>]*class="spin-ring[^>]*><\/span><span class="@max-\[420px\]:hidden">Working</);
    assert.doesNotMatch(markup, /Needs you/);
  });

  it("shows Needs you · N and Waiting for you while a request is open, and the run-level need row in the card", () => {
    const withApproval = fold([launch(), ...lantern().events, APPROVAL]);
    const markup = render({ threads: { s1: thread({ fold: withApproval }) } });
    assert.match(markup, /aria-label="Needs you: 1 request"/);
    assert.match(text(markup), /Needs you · 1/);
    assert.match(markup, /Waiting for you<\/span><\/span>/);
    assert.match(card(markup), /class="crew-att run"/);
    assert.match(text(card(markup)), /Muse does not say which agent asked/);
    assert.ok(markup.indexOf('aria-label="Agents and tasks"') < markup.indexOf('aria-label="Approval needed"'), "the card sits above the request panel");
    assert.match(markup, /<section aria-label="Approval needed" data-request-id="ap1"/, "the panel carries its request id, so Review can find it");
    assert.match(card(markup), /class="crew-body compact"/, "the body's cap drops with a request panel present");
  });

  it("switches the slot beside the thread: files, the Crew panel, or nothing", () => {
    const state = { threads: { s1: thread({ fold: running() }) } };
    assert.match(render(state, { sidePanel: "files", filesOpen: true }), /<aside/);
    assert.doesNotMatch(render(state, { sidePanel: "files", filesOpen: true }), /aria-label="Crew"/);
    assert.match(render(state, { sidePanel: "crew" }), /<aside[^>]*aria-label="Crew"/);
    assert.doesNotMatch(render(state, { sidePanel: "none" }), /<aside/);
    assert.match(render(state, { sidePanel: "crew" }), /aria-label="Hide the Crew panel"/);
  });

  it("shows a background task as a line, with the old strip gone", () => {
    const events: ViewEvent[] = [
      { method: "item/started", at: S(39, 53), params: { item: { itemId: "task-e2e", kind: "toolCall", status: "inProgress", revision: 1, turnId: "t1", tool: "shell", args: JSON.stringify({ command: "npm run test:e2e -- --grep sync" }) } } },
      { method: "item/updated", at: S(39, 54), params: { item: { itemId: "task-e2e", kind: "toolCall", status: "inProgress", revision: 2, turnId: "t1", tool: "shell", args: JSON.stringify({ command: "npm run test:e2e -- --grep sync" }), background: true, backgroundInitiator: "user", visibleOutput: "12 passed · 3 pending" } } },
    ];
    const markup = render({ threads: { s1: thread({ fold: fold(events) }) } });
    const section = card(markup);
    assert.match(section, /class="cmd"[^>]*>npm run test:e2e -- --grep sync</);
    assert.match(text(section), /Background 1/);
    assert.doesNotMatch(markup, /running in the background/);
    const lines = render({ threads: { s1: thread({ fold: fold(events) }) } }, { collapsedCards: ["crew:s1"] });
    assert.match(card(lines), /class="crew-line task"/);
  });

  it("says last known while the feed is not live, without a spinner", () => {
    const markup = render({ threads: { s1: thread({ fold: running() }) }, connection: "connecting" });
    const section = card(markup);
    assert.match(section, /class="crew-line stale"|crew-stale/);
    assert.doesNotMatch(section, /spin-ring/);
  });
});

/** A request panel as `focusRequestPanel` handles it: scrolled into view, its button focused, its ring flashed. */
class FakePanel {
  scrolled = false;
  focused = false;
  flashed = false;
  readonly offsetWidth = 0;
  readonly classList = {
    add: (name: string) => { if (name === "crew-flash") this.flashed = true; },
    remove: () => undefined,
  };
  constructor(readonly id: string) {}
  scrollIntoView(): void { this.scrolled = true; }
  querySelector(): { focus(): void } { return { focus: () => { this.focused = true; } }; }
}

describe("focusRequestPanel", () => {
  it("brings the panel carrying the request id into view, else the first request panel", () => {
    const approval = new FakePanel("ap1");
    const question = new FakePanel("q1");
    const scope = globalThis as { document?: unknown; window?: unknown; CSS?: unknown };
    const previous = { document: scope.document, window: scope.window, CSS: scope.CSS };
    // The dock as the two lookups see it: a panel by its id, or the first one in order.
    scope.document = {
      querySelector: (selector: string) => (selector.startsWith("[data-request-id=") ? [approval, question].find((panel) => selector.includes(`"${panel.id}"`)) ?? null : approval),
    };
    scope.window = { setTimeout: () => 0 };
    scope.CSS = { escape: (value: string) => value };
    try {
      assert.equal(focusRequestPanel("q1"), true);
      assert.ok(question.scrolled && question.focused && question.flashed, "the question panel, found by its id");
      assert.equal(approval.scrolled, false, "not the first panel");
      assert.equal(focusRequestPanel("gone"), true);
      assert.ok(approval.scrolled && approval.focused, "an id no panel carries falls back to the first");
      approval.focused = false;
      assert.equal(focusRequestPanel(), true);
      assert.ok(approval.focused, "as does asking with no id");
      scope.document = { querySelector: () => null };
      assert.equal(focusRequestPanel("q1"), false, "false when no panel is in the document");
    } finally {
      for (const key of ["document", "window", "CSS"] as const) {
        if (previous[key] === undefined) delete scope[key];
        else scope[key] = previous[key];
      }
    }
  });
});
