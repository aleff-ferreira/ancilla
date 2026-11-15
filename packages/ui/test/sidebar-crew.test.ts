import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ThreadRow } from "../src/components/sidebar/Sidebar.js";
import { ActivityButton, activityBadge, activityLabel } from "../src/components/crew/ActivityBadge.js";
import { SidebarCrewRow, sidebarLineShown } from "../src/components/crew/SidebarCrewRow.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { threadStatus, type SidebarEntry } from "../src/model/status.js";
import { Store, type AppState } from "../src/model/store.js";
import type { AgentState, SidebarCrewSummary } from "../src/model/crew.js";
import {
  LIVE,
  NOW,
  appState,
  approvalEvents,
  branchEvents,
  fold,
  runEvents,
  session,
  taskEvents,
  thread,
} from "./crew-fixtures.js";

function buildCrewSummary(customProps: Partial<SidebarCrewSummary> = {}): SidebarCrewSummary {
  const defaultPhases: AgentState[][] = [
    ["done", "done", "done", "done"],
    ["done", "done", "failed"],
    ["working", "no-update"],
    ["planned"],
  ];
  return {
    groups: defaultPhases,
    text: "Judge · 6/10",
    needs: 1,
    failed: 1,
    noUpdate: 1,
    phase: "Judge",
    stale: false,
    task: null,
    live: true,
    endedAt: null,
    ...customProps,
  };
}

function renderCrewRow(item: SidebarCrewSummary | null): string {
  return renderToStaticMarkup(createElement(SidebarCrewRow, { summary: item }));
}

function stripHtml(rawHtml: string): string {
  return rawHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function renderWithAppContext(statePayload: AppState, uiElement: ReturnType<typeof createElement>): string {
  const storeInstance = new Store<AppState>(statePayload);
  const controllerMock = { store: storeInstance } as unknown as AncillaController;
  const wrappedTree = createElement(TooltipProvider, { children: uiElement });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller: controllerMock, children: wrappedTree }));
}

describe("SidebarCrewRow Component Presentation", () => {
  it("renders micro progress strip alongside phase description and failure diagnostics", () => {
    const html = renderCrewRow(buildCrewSummary());
    assert.match(html, /class="crew-strip xs"/);
    assert.match(html, /aria-label="10 agents in 4 phases: 6 done, 1 failed, 1 no update, 1 working, 1 planned"/);
    assert.match(stripHtml(html), /Judge · 6\/10 1 failed 1 no update/);
    assert.match(html, /text-danger-text"><svg[^>]*>.*?<\/svg>1<span class="sr-only"> failed<\/span>/);
    assert.doesNotMatch(html, /finale|stale|crew-bin/);
    assert.strictEqual(renderCrewRow(null), "");
  });

  it("suppresses single input badge while enumerating multiple pending human requests", () => {
    const singleRequest = renderCrewRow(buildCrewSummary({ needs: 1 }));
    assert.doesNotMatch(singleRequest, /need you/);

    const dualRequest = renderCrewRow(buildCrewSummary({ needs: 2 }));
    assert.match(dualRequest, /text-warn-text"><svg[^>]*>.*?<\/svg>2<span class="sr-only"> need you<\/span>/);
  });

  it("condenses extensive agent clusters exceeding 24 members into 72px summary bin", () => {
    const largeFleetPhases: AgentState[][] = [
      Array.from({ length: 198 }, () => "done" as const),
      Array.from({ length: 38 }, () => "working" as const),
      Array.from({ length: 4 }, () => "failed" as const),
    ];
    const fleetSummary = buildCrewSummary({
      groups: largeFleetPhases,
      text: "198/240",
      failed: 4,
      noUpdate: 0,
    });
    const html = renderCrewRow(fleetSummary);
    assert.match(html, /<span class="crew-bin" style="--bw:72px">/);
    assert.doesNotMatch(html, /crew-phase/);
    assert.match(stripHtml(html), /198\/240 4 failed/);
  });

  it("styles finished runs with finale sheen and reflects disconnected feeds as stale", () => {
    const completed = buildCrewSummary({
      groups: [["done", "done", "done"]],
      text: "3 landed",
      failed: 0,
      noUpdate: 0,
      live: false,
      endedAt: NOW,
    });
    assert.match(renderCrewRow(completed), /class="crew-strip xs finale"/);

    const disconnected = renderCrewRow(buildCrewSummary({ text: "Last known 12m", stale: true }));
    assert.match(disconnected, /class="crew-strip xs stale"/);
    assert.match(stripHtml(disconnected), /Last known 12m/);
  });

  it("displays isolated background execution command in monospaced typography", () => {
    const taskOnly = buildCrewSummary({
      groups: [],
      text: "npm run docs:build",
      task: "npm run docs:build",
      failed: 0,
      noUpdate: 0,
      needs: 0,
    });
    const html = renderCrewRow(taskOnly);
    assert.doesNotMatch(html, /crew-strip/);
    assert.match(html, /<span class="truncate font-mono">npm run docs:build<\/span>/);
    assert.strictEqual(stripHtml(html), "npm run docs:build");
  });

  it("governs line visibility based on active execution and thread read status", () => {
    assert.strictEqual(sidebarLineShown(buildCrewSummary(), "approval", true), true);
    assert.strictEqual(sidebarLineShown(buildCrewSummary({ live: false, endedAt: NOW }), "unread", false), true);
    assert.strictEqual(sidebarLineShown(buildCrewSummary({ live: false, endedAt: NOW }), "failed", false), true);
    assert.strictEqual(sidebarLineShown(buildCrewSummary({ live: false, endedAt: NOW }), "idle", false), false);
    assert.strictEqual(
      sidebarLineShown(buildCrewSummary({ live: false, endedAt: NOW }), "idle", true),
      true,
      "retaining line while active task finishes",
    );
    assert.strictEqual(sidebarLineShown(buildCrewSummary({ live: false, endedAt: null }), "unread", false), false);
  });
});

describe("ThreadRow Slot Rendering Policy", () => {
  const activeSessionItem = session("s1", "Design the offline sync engine");
  const idleSessionItem = session("s2", "Migrate auth to passkeys", { live: { ...LIVE, activeTurnId: null } });
  const mockAppState = appState({
    sessions: { s1: activeSessionItem, s2: idleSessionItem },
    threads: {
      s1: thread(fold([...branchEvents("sync/design"), ...runEvents(), ...taskEvents(), ...approvalEvents()])),
      s2: thread(fold(branchEvents("auth/passkeys"))),
    },
  });

  function renderRowEntry(targetSession: typeof activeSessionItem): string {
    const computedStatus = threadStatus(targetSession, {
      fold: mockAppState.threads[targetSession.sessionId]?.fold ?? null,
      lastSeen: null,
      baseline: "2026-09-26T00:00:00.000Z",
      active: false,
    });
    const entryData: SidebarEntry = { session: targetSession, status: computedStatus };
    return renderWithAppContext(
      mockAppState,
      createElement(ThreadRow, { entry: entryData, active: false, now: NOW }),
    );
  }

  it("substitutes git branch display with crew telemetry strip during active runs", () => {
    const markup = renderRowEntry(activeSessionItem);
    assert.match(markup, /data-crew-row=""/);
    assert.match(markup, /class="crew-strip xs"/);
    assert.match(stripHtml(markup), /Judge · 1\/3/);
    assert.doesNotMatch(markup, /sync\/design/, "branch should be hidden in presence of crew strip");
    assert.match(markup, />Approval</);
    assert.match(markup, /attention-pulse/);
  });

  it("retains git branch indicator on quiet sessions without active crew runs", () => {
    const markup = renderRowEntry(idleSessionItem);
    assert.match(markup, /auth\/passkeys/);
    assert.doesNotMatch(markup, /data-crew-row|crew-strip/);
  });
});

describe("ActivityBadge Aggregation & Label Formatting", () => {
  it("evaluates aggregate action count across sessions and styles badge amber on required user input", () => {
    const dualState = appState({
      sessions: {
        s1: session("s1", "Design the offline sync engine"),
        s2: session("s2", "Migrate auth to passkeys", {
          live: { ...LIVE, activeTurnId: null, pendingInputs: 1 },
        }),
      },
      threads: {
        s1: thread(fold([...runEvents(), ...taskEvents(), ...approvalEvents()])),
      },
    });

    const badgeMetrics = activityBadge(dualState, NOW);
    assert.deepStrictEqual(badgeMetrics, { count: 4, needs: 2 });
    assert.strictEqual(activityLabel({ count: 4, needs: 2 }), "Activity, 2 need you, 2 working");
    assert.strictEqual(activityLabel({ count: 1, needs: 1 }), "Activity, 1 needs you");
    assert.strictEqual(activityLabel({ count: 3, needs: 0 }), "Activity, 3 working");
    assert.strictEqual(activityLabel({ count: 0, needs: 0 }), "Activity");

    const markup = renderWithAppContext(dualState, createElement(ActivityButton));
    assert.match(markup, /aria-label="Activity, 2 need you, 2 working"/);
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, /bg-warn[^"]*"[^>]*>4<\/span>/);
  });

  it("suppresses badge when idle and applies blue accent styling when agents operate autonomously", () => {
    const emptyApp = renderWithAppContext(appState(), createElement(ActivityButton));
    assert.match(emptyApp, /aria-label="Activity"/);
    assert.doesNotMatch(emptyApp, /bg-warn|bg-accent/);

    const autonomousApp = appState({
      sessions: { s1: session("s1", "Design the offline sync engine") },
      threads: { s1: thread(fold([...runEvents(), ...taskEvents()])) },
    });
    const autonomousMetrics = activityBadge(autonomousApp, NOW);
    assert.deepStrictEqual(autonomousMetrics, { count: 2, needs: 0 });

    const autonomousHtml = renderWithAppContext(autonomousApp, createElement(ActivityButton));
    assert.match(autonomousHtml, /bg-accent[^"]*"[^>]*>2<\/span>/);
  });
});
