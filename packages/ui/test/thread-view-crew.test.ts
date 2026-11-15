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
import { APPROVAL, S, SESSION as BASE_SESSION, lantern, launch, textOf as extractText } from "./fixtures/lantern.js";
import { runningResearch } from "./fixtures/research.js";

const DEFAULT_LIVE_STATE: LiveView = {
  activeTurnId: "t1",
  turnStartedAt: null,
  pendingApprovals: 0,
  pendingInputs: 0,
  lastTerminal: null,
  lastError: null,
};

const DEFAULT_SESSION_DATA: SessionSummary = {
  ...BASE_SESSION,
  live: DEFAULT_LIVE_STATE,
};

function createThreadState(customFields: Partial<ThreadState> = {}): ThreadState {
  return {
    load: "ready",
    error: null,
    readOnly: false,
    readOnlyReason: null,
    truncated: false,
    fold: emptyFold(),
    attachments: [],
    shellRuns: [],
    researchRuns: [],
    stalled: false,
    ...customFields,
  };
}

function buildFold(eventsList: ViewEvent[]): ThreadFold {
  return applyEvents(emptyFold(), eventsList);
}

function renderThreadView(
  stateOverrides: Partial<AppState>,
  userPreferences: Partial<AppState["prefs"]> = {},
): string {
  const mergedPrefs = { ...defaultPrefs("2026-09-26T00:00:00.000Z"), ...userPreferences };
  const storeInstance = new Store<AppState>({
    ...initialState(mergedPrefs),
    connection: "open",
    sessions: { s1: DEFAULT_SESSION_DATA },
    ...stateOverrides,
  });

  const stubController = {
    store: storeInstance,
    setCardOpen() {},
    markLeft() {},
  } as unknown as AncillaController;

  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).includes("useLayoutEffect does nothing on the server")) {
      originalConsoleError(...args);
    }
  };

  try {
    const wrappedView = createElement(TooltipProvider, {
      children: createElement(ThreadView, { sessionId: "s1" }),
    });
    return renderToStaticMarkup(
      createElement(ControllerProvider, { controller: stubController, children: wrappedView }),
    );
  } finally {
    console.error = originalConsoleError;
  }
}

function extractCardSection(renderedHtml: string): string {
  const match = /<section aria-label="Agents and tasks"[\s\S]*?<\/section>/.exec(renderedHtml);
  return match ? match[0] : "";
}

function createActiveWorkflowFold(): ThreadFold {
  const startEvent: ViewEvent = {
    method: "turn/started",
    params: { turnId: "t1" },
    at: S(0, 0),
  };
  return buildFold([startEvent, launch(), ...lantern().events]);
}

describe("ThreadView Dock & Crew Card Integration", () => {
  it("omits crew card, rail strip, and live announcer when session is idle", () => {
    const idleHtml = renderThreadView({
      threads: { s1: createThreadState() },
      sessions: { s1: { ...DEFAULT_SESSION_DATA, live: null } },
    });
    assert.doesNotMatch(idleHtml, /aria-label="Agents"/);
    assert.doesNotMatch(idleHtml, /Agents and tasks|crew-line|crew-card/);
    assert.doesNotMatch(idleHtml, /data-crew-announcer/);
    assert.doesNotMatch(idleHtml, /working solo|No agents yet|Lead agent/);
  });

  it("mounts docked card above pending requests when active workflow is running", () => {
    const activeHtml = renderThreadView({
      threads: { s1: createThreadState({ fold: createActiveWorkflowFold() }) },
    });
    const cardMarkup = extractCardSection(activeHtml);
    assert.ok(cardMarkup.length > 0, "Docked card should be rendered");
    assert.match(extractText(cardMarkup), /offline-sync-research-design/);

    const railSegments = (cardMarkup.match(/class="crew-strip rail"/g) ?? []).length;
    assert.strictEqual(railSegments, 4, "Should display four execution rail segments");

    const announcerRegions = (activeHtml.match(/data-crew-announcer/g) ?? []).length;
    assert.strictEqual(announcerRegions, 1, "Should mount dedicated announcer region");

    const headerMarkup = /<header[\s\S]*?<\/header>/.exec(activeHtml)?.[0] ?? "";
    assert.doesNotMatch(headerMarkup, /aria-live|role="status"/);
    assert.doesNotMatch(cardMarkup, /aria-live|role="status"/);

    assert.match(
      extractText(activeHtml),
      /Started workflow offline-sync-research-design · 10 agents in 4 phases in the dock/,
    );
    assert.doesNotMatch(activeHtml, /WorkflowCard|aria-label="Workflow"/);

    assert.match(cardMarkup, /class="run-head"/);
    assert.match(cardMarkup, /role="tablist"/);
    assert.doesNotMatch(extractText(cardMarkup), /All 10 agents/);

    const expandedHtml = renderThreadView(
      { threads: { s1: createThreadState({ fold: createActiveWorkflowFold() }) } },
      { openCards: ["crew:s1"] },
    );
    assert.match(extractText(extractCardSection(expandedHtml)), /All 10 agents/);
  });

  it("renders deep research card with round segments and stop control", () => {
    const researchHtml = renderThreadView(
      {
        threads: { s1: createThreadState({ researchRuns: [runningResearch()] }) },
        sessions: { s1: { ...DEFAULT_SESSION_DATA, live: null } },
      },
      { openCards: ["crew:s1"] },
    );
    const researchCard = extractCardSection(researchHtml);
    assert.ok(researchCard.length > 0);
    assert.match(researchCard, /title="Deep research · /);

    const roundSegments = (researchCard.match(/class="crew-strip rail"/g) ?? []).length;
    assert.strictEqual(roundSegments, 2);
    assert.match(researchCard, /data-agent-kind="research"/);
    assert.match(extractText(researchCard), /Round 1 of 12/);
    assert.match(extractText(researchCard), /All 3 agents/);
    assert.match(researchCard, /<span class="lbl">Stop<\/span>/);
    assert.match(researchHtml, /class="n @max-\[700px\]:hidden" aria-hidden="true">3</);
    assert.doesNotMatch(researchHtml, /No agents in this thread/);
  });

  it("reflects collapsed and expanded states via data-open attribute", () => {
    const collapsedCard = extractCardSection(
      renderThreadView({ threads: { s1: createThreadState({ fold: createActiveWorkflowFold() }) } }),
    );
    assert.match(collapsedCard, /data-open="false"/);
    assert.doesNotMatch(collapsedCard, /class="crew-body/);

    const expandedCard = extractCardSection(
      renderThreadView(
        { threads: { s1: createThreadState({ fold: createActiveWorkflowFold() }) } },
        { openCards: ["crew:s1"] },
      ),
    );
    assert.match(expandedCard, /data-open="true"/);
    assert.match(expandedCard, /class="crew-body run-body"/);
  });

  it("places Crew trigger and running spinner before file navigation controls", () => {
    const html = renderThreadView({
      threads: { s1: createThreadState({ fold: createActiveWorkflowFold() }) },
    });
    const crewButtonIndex = html.indexOf('aria-label="Show the Crew panel"');
    const filesButtonIndex = html.indexOf('aria-label="Show files"');
    assert.ok(crewButtonIndex > 0 && filesButtonIndex > crewButtonIndex);

    assert.match(html, /class="n @max-\[700px\]:hidden" aria-hidden="true">10</);
    assert.match(
      html,
      /class="crew-status"><span[^>]*class="spin-ring[^>]*><\/span><span class="@max-\[420px\]:hidden">Working/,
    );
    assert.doesNotMatch(html, /Needs you/);
  });

  it("displays needs-you alert banner and compacts card body when input is required", () => {
    const approvalFold = buildFold([launch(), ...lantern().events, APPROVAL]);
    const html = renderThreadView(
      { threads: { s1: createThreadState({ fold: approvalFold }) } },
      { openCards: ["crew:s1"] },
    );
    assert.match(html, /aria-label="Needs you: 1 request"/);
    assert.match(extractText(html), /Needs you · 1/);
    assert.match(html, /Waiting for you<\/span><\/span>/);

    const card = extractCardSection(html);
    assert.match(card, /class="crew-att run"/);
    assert.match(extractText(card), /Muse does not say which agent asked/);

    const cardPos = html.indexOf('aria-label="Agents and tasks"');
    const panelPos = html.indexOf('aria-label="Approval needed"');
    assert.ok(cardPos < panelPos, "Card must precede request panel in DOM structure");
    assert.match(html, /<section aria-label="Approval needed" data-request-id="ap1"/);
    assert.match(card, /class="crew-body run-body compact"/);
    assert.match(card, /data-wait="true"/);
  });

  it("toggles sidebar drawer visibility among files, crew, and collapsed states", () => {
    const threadData = { threads: { s1: createThreadState({ fold: createActiveWorkflowFold() }) } };

    const filesOpened = renderThreadView(threadData, { sidePanel: "files", filesOpen: true });
    assert.match(filesOpened, /<aside/);
    assert.doesNotMatch(filesOpened, /aria-label="Crew"/);

    const crewOpened = renderThreadView(threadData, { sidePanel: "crew" });
    assert.match(crewOpened, /<aside[^>]*aria-label="Crew"/);
    assert.match(crewOpened, /aria-label="Hide the Crew panel"/);

    const collapsed = renderThreadView(threadData, { sidePanel: "none" });
    assert.doesNotMatch(collapsed, /<aside/);
  });

  it("presents background task in compact line view with command details", () => {
    const taskEventsList: ViewEvent[] = [
      {
        method: "item/started",
        at: S(39, 53),
        params: {
          item: {
            itemId: "task-e2e",
            kind: "toolCall",
            status: "inProgress",
            revision: 1,
            turnId: "t1",
            tool: "shell",
            args: JSON.stringify({ command: "npm run test:e2e -- --grep sync" }),
          },
        },
      },
      {
        method: "item/updated",
        at: S(39, 54),
        params: {
          item: {
            itemId: "task-e2e",
            kind: "toolCall",
            status: "inProgress",
            revision: 2,
            turnId: "t1",
            tool: "shell",
            args: JSON.stringify({ command: "npm run test:e2e -- --grep sync" }),
            background: true,
            backgroundInitiator: "user",
            visibleOutput: "12 passed · 3 pending",
          },
        },
      },
    ];
    const compactHtml = renderThreadView({
      threads: { s1: createThreadState({ fold: buildFold(taskEventsList) }) },
    });
    const compactCard = extractCardSection(compactHtml);
    assert.match(compactCard, /class="crew-line task"/);
    assert.match(compactCard, /class="cmd"[^>]*>npm run test:e2e -- --grep sync</);

    const openedHtml = renderThreadView(
      { threads: { s1: createThreadState({ fold: buildFold(taskEventsList) }) } },
      { openCards: ["crew:s1"] },
    );
    const openedCard = extractCardSection(openedHtml);
    assert.match(openedCard, /class="cmd"[^>]*>npm run test:e2e -- --grep sync</);
    assert.match(extractText(openedCard), /Background 1/);
    assert.doesNotMatch(openedCard, /class="crew-line task"/);
    assert.doesNotMatch(openedHtml, /running in the background/);
  });

  it("designates disconnected feed as stale without spinner ring", () => {
    const staleHtml = renderThreadView({
      threads: { s1: createThreadState({ fold: createActiveWorkflowFold() }) },
      connection: "connecting",
    });
    const section = extractCardSection(staleHtml);
    assert.match(section, /class="crew-line stale"|crew-stale/);
    assert.doesNotMatch(section, /spin-ring/);
  });

  it("maintains working header state while background task remains in flight", () => {
    const bgActivityFold = buildFold([
      { method: "turn/started", at: S(0, 0), params: { turnId: "t1" } },
      {
        method: "item/started",
        at: S(0, 1),
        params: {
          item: {
            itemId: "background",
            kind: "toolCall",
            status: "inProgress",
            revision: 1,
            turnId: "t1",
            tool: "bash",
            args: '{"command":"npm run watch"}',
            background: true,
          },
        },
      },
      { method: "turn/completed", at: S(0, 2), params: { turnId: "t1", terminal: "completed" } },
    ]);
    const threadConfig = { threads: { s1: createThreadState({ fold: bgActivityFold }) } };
    const html = renderThreadView(threadConfig);
    const headerHtml = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    assert.match(extractText(headerHtml), /Working/);
    assert.doesNotMatch(extractText(headerHtml), /Crew landed|Done/);
    assert.doesNotMatch(extractCardSection(html), /Muse did not attach a report|crew-landed/);

    const disconnectedHtml = renderThreadView({ ...threadConfig, connection: "connecting" });
    const disconnectedHeader = /<header[\s\S]*?<\/header>/.exec(disconnectedHtml)?.[0] ?? "";
    assert.match(extractText(disconnectedHeader), /Last known/);
    assert.doesNotMatch(disconnectedHeader, /spin-ring/);
  });

  it("avoids premature completion claims when turn terminates with unknown outcome", () => {
    const timestamp = Date.now();
    const unknownFold = buildFold([
      { method: "turn/started", at: timestamp - 2000, params: { turnId: "t1" } },
      { method: "turn/completed", at: timestamp, params: { turnId: "t1", terminal: "unknown" } },
    ]);
    const html = renderThreadView({ threads: { s1: createThreadState({ fold: unknownFold }) } });
    const headerHtml = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    assert.doesNotMatch(extractText(headerHtml), /Crew landed|Done|Working/);
    assert.match(extractText(extractCardSection(html)), /Turn ended/);
  });
});

interface SimulatedRequestPanel {
  panelId: string;
  scrolled: boolean;
  focused: boolean;
  flashed: boolean;
  offsetWidth: number;
  classList: {
    add: (cls: string) => void;
    remove: () => void;
  };
  scrollIntoView: () => void;
  querySelector: () => { focus: () => void };
}

function createSimulatedPanel(id: string): SimulatedRequestPanel {
  let wasFlashed = false;
  let wasFocused = false;
  let wasScrolled = false;

  return {
    panelId: id,
    get scrolled() {
      return wasScrolled;
    },
    get focused() {
      return wasFocused;
    },
    get flashed() {
      return wasFlashed;
    },
    offsetWidth: 0,
    classList: {
      add: (name: string) => {
        if (name === "crew-flash") wasFlashed = true;
      },
      remove: () => {},
    },
    scrollIntoView: () => {
      wasScrolled = true;
    },
    querySelector: () => ({
      focus: () => {
        wasFocused = true;
      },
    }),
  };
}

describe("Interactive Request Navigation (focusRequestPanel)", () => {
  it("locates specified request panel by id or defaults to initial request card", () => {
    const approvalCard = createSimulatedPanel("ap1");
    const questionCard = createSimulatedPanel("q1");

    const envRoot = globalThis as { document?: unknown; window?: unknown; CSS?: unknown };
    const savedGlobals = {
      document: envRoot.document,
      window: envRoot.window,
      CSS: envRoot.CSS,
    };

    envRoot.document = {
      querySelector: (selector: string) => {
        if (selector.startsWith("[data-request-id=")) {
          const matched = [approvalCard, questionCard].find((p) => selector.includes(`"${p.panelId}"`));
          return matched ?? null;
        }
        return approvalCard;
      },
    };
    envRoot.window = { setTimeout: () => 0 };
    envRoot.CSS = { escape: (raw: string) => raw };

    try {
      const qResult = focusRequestPanel("q1");
      assert.strictEqual(qResult, true);
      assert.ok(questionCard.scrolled && questionCard.focused && questionCard.flashed);
      assert.strictEqual(approvalCard.scrolled, false);

      const unknownResult = focusRequestPanel("nonexistent");
      assert.strictEqual(unknownResult, true);
      assert.ok(approvalCard.scrolled && approvalCard.focused);

      const defaultResult = focusRequestPanel();
      assert.strictEqual(defaultResult, true);

      envRoot.document = { querySelector: () => null };
      const missingResult = focusRequestPanel("q1");
      assert.strictEqual(missingResult, false);
    } finally {
      if (savedGlobals.document === undefined) delete envRoot.document;
      else envRoot.document = savedGlobals.document;

      if (savedGlobals.window === undefined) delete envRoot.window;
      else envRoot.window = savedGlobals.window;

      if (savedGlobals.CSS === undefined) delete envRoot.CSS;
      else envRoot.CSS = savedGlobals.CSS;
    }
  });
});
