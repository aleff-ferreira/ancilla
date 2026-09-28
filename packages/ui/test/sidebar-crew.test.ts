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
import { LIVE, NOW, appState, approvalEvents, branchEvents, fold, runEvents, session, taskEvents, thread } from "./crew-fixtures.js";

const RUN: AgentState[][] = [["done", "done", "done", "done"], ["done", "done", "failed"], ["working", "no-update"], ["planned"]];

function summary(extra: Partial<SidebarCrewSummary> = {}): SidebarCrewSummary {
  return { groups: RUN, text: "Judge · 6/10", needs: 1, failed: 1, noUpdate: 1, phase: "Judge", stale: false, task: null, live: true, endedAt: null, ...extra };
}

function render(value: SidebarCrewSummary | null): string {
  return renderToStaticMarkup(createElement(SidebarCrewRow, { summary: value }));
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** A server-rendered component under the app's providers, on the state given. */
function inApp(state: AppState, element: ReturnType<typeof createElement>): string {
  const store = new Store<AppState>(state);
  const controller = { store } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: element }) }));
}

describe("SidebarCrewRow", () => {
  it("draws the micro strip, the phase and the counts, with the strip's own label for readers", () => {
    const markup = render(summary());
    assert.match(markup, /class="crew-strip xs"/);
    assert.match(markup, /aria-label="10 agents in 4 phases: 6 done, 1 failed, 1 no update, 1 working, 1 planned"/);
    assert.match(text(markup), /Judge · 6\/10 1 failed 1 no update/);
    assert.match(markup, /text-danger-text"><svg[^>]*>.*?<\/svg>1<span class="sr-only"> failed<\/span>/);
    assert.doesNotMatch(markup, /finale|stale|crew-bin/);
    assert.equal(render(null), "");
  });

  it("leaves one request to the row's glyph and word, and counts them only past that", () => {
    assert.doesNotMatch(render(summary({ needs: 1 })), /need you/);
    assert.match(render(summary({ needs: 2 })), /text-warn-text"><svg[^>]*>.*?<\/svg>2<span class="sr-only"> need you<\/span>/);
  });

  it("bins the whole run past 24 agents into a 72 px bar", () => {
    const big = summary({ groups: [Array.from({ length: 198 }, () => "done" as const), Array.from({ length: 38 }, () => "working" as const), Array.from({ length: 4 }, () => "failed" as const)], text: "198/240", failed: 4, noUpdate: 0 });
    const markup = render(big);
    assert.match(markup, /<span class="crew-bin" style="--bw:72px">/);
    assert.doesNotMatch(markup, /crew-phase/);
    assert.match(text(markup), /198\/240 4 failed/);
  });

  it("turns the strip ok once the run has landed, and stale while the feed is last known", () => {
    assert.match(render(summary({ groups: [["done", "done", "done"]], text: "3 landed", failed: 0, noUpdate: 0, live: false, endedAt: NOW })), /class="crew-strip xs finale"/);
    const stale = render(summary({ text: "Last known 12m", stale: true }));
    assert.match(stale, /class="crew-strip xs stale"/);
    assert.match(text(stale), /Last known 12m/);
  });

  it("shows a thread that only has a background task as its command in mono", () => {
    const markup = render(summary({ groups: [], text: "npm run docs:build", task: "npm run docs:build", failed: 0, noUpdate: 0, needs: 0 }));
    assert.doesNotMatch(markup, /crew-strip/);
    assert.match(markup, /<span class="truncate font-mono">npm run docs:build<\/span>/);
    assert.equal(text(markup), "npm run docs:build");
  });

  it("shows while a run or task is live, and once one has landed until the thread is seen", () => {
    assert.equal(sidebarLineShown(summary(), "approval", true), true);
    assert.equal(sidebarLineShown(summary({ live: false, endedAt: NOW }), "unread", false), true);
    assert.equal(sidebarLineShown(summary({ live: false, endedAt: NOW }), "failed", false), true);
    assert.equal(sidebarLineShown(summary({ live: false, endedAt: NOW }), "idle", false), false);
    assert.equal(sidebarLineShown(summary({ live: false, endedAt: NOW }), "idle", true), true, "a live task keeps the line after the run landed");
    assert.equal(sidebarLineShown(summary({ live: false, endedAt: null }), "unread", false), false);
  });
});

describe("ThreadRow with a crew", () => {
  const running = session("s1", "Design the offline sync engine");
  const quiet = session("s2", "Migrate auth to passkeys", { live: { ...LIVE, activeTurnId: null } });
  const state = appState({
    sessions: { s1: running, s2: quiet },
    threads: {
      s1: thread(fold([...branchEvents("sync/design"), ...runEvents(), ...taskEvents(), ...approvalEvents()])),
      s2: thread(fold(branchEvents("auth/passkeys"))),
    },
  });
  const row = (entry: SidebarEntry) => inApp(state, createElement(ThreadRow, { entry, active: false, now: NOW }));
  const status = (s: typeof running) => threadStatus(s, { fold: state.threads[s.sessionId]?.fold ?? null, lastSeen: null, baseline: "2026-09-26T00:00:00.000Z", active: false });

  it("puts the strip where the branch was, and keeps the row's word", () => {
    const markup = row({ session: running, status: status(running) });
    assert.match(markup, /data-crew-row=""/);
    assert.match(markup, /class="crew-strip xs"/);
    assert.match(text(markup), /Judge · 1\/3/);
    assert.doesNotMatch(markup, /sync\/design/, "the branch leaves the second line while a strip is present");
    assert.match(markup, />Approval</, "today's word stays");
    assert.match(markup, /attention-pulse/, "today's glyph stays");
  });

  it("keeps the branch on a thread without a run", () => {
    const markup = row({ session: quiet, status: status(quiet) });
    assert.match(markup, /auth\/passkeys/);
    assert.doesNotMatch(markup, /data-crew-row|crew-strip/);
  });
});

describe("ActivityButton", () => {
  it("counts the requests waiting anywhere and what runs in the folded threads, amber while anything needs you", () => {
    const state = appState({
      sessions: {
        s1: session("s1", "Design the offline sync engine"),
        s2: session("s2", "Migrate auth to passkeys", { live: { ...LIVE, activeTurnId: null, pendingInputs: 1 } }),
      },
      threads: { s1: thread(fold([...runEvents(), ...taskEvents(), ...approvalEvents()])) },
    });
    assert.deepEqual(activityBadge(state, NOW), { count: 4, needs: 2 });
    assert.equal(activityLabel({ count: 4, needs: 2 }), "Activity, 2 need you, 2 working");
    assert.equal(activityLabel({ count: 1, needs: 1 }), "Activity, 1 needs you");
    assert.equal(activityLabel({ count: 3, needs: 0 }), "Activity, 3 working");
    assert.equal(activityLabel({ count: 0, needs: 0 }), "Activity");
    const markup = inApp(state, createElement(ActivityButton));
    assert.match(markup, /aria-label="Activity, 2 need you, 2 working"/);
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, /bg-warn[^"]*"[^>]*>4<\/span>/);
  });

  it("carries no badge when all is quiet, and turns blue when only work is under way", () => {
    const quiet = inApp(appState(), createElement(ActivityButton));
    assert.match(quiet, /aria-label="Activity"/);
    assert.doesNotMatch(quiet, /bg-warn|bg-accent/);
    const working = appState({ sessions: { s1: session("s1", "Design the offline sync engine") }, threads: { s1: thread(fold([...runEvents(), ...taskEvents()])) } });
    assert.deepEqual(activityBadge(working, NOW), { count: 2, needs: 0 });
    assert.match(inApp(working, createElement(ActivityButton)), /bg-accent[^"]*"[^>]*>2<\/span>/);
  });
});
