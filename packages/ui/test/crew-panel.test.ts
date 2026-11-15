import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { chipCounts, rosterEntries, sortAgents, summaryText } from "../src/components/crew/panel.js";
import { Roster } from "../src/components/crew/Roster.js";
import { panelRun } from "../src/components/crew/CrewPanel.js";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { researchThreadTitle } from "../src/model/research.js";
import { pendingKey, type RunVM } from "../src/model/crew.js";
import type { ViewEvent } from "../src/types.js";
import { RESEARCH_NOW, runningResearch } from "./fixtures/research.js";
import { Feed, MIN, NOW, S, approvalAt, atNow, attrs, digits, kpi, lantern, lanternDone, lanternFold, lanternRun, launch, panelStore, renderPanel, renderWith, rowTag, textOf, type PanelSetup } from "./crew-panel-fixture.js";

function getRosterRowIds(html: string): string[] {
  const allIds = attrs(html, "id");
  const prefix = "crew-row-";
  return allIds.filter((item) => item.startsWith(prefix)).map((item) => item.slice(prefix.length));
}

function parseFilterChipCatalog(html: string): Array<[string, string]> {
  const chipRegex = /data-filter="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<span[^>]*>(\d+)<\/span>/g;
  const matches = [...html.matchAll(chipRegex)];
  return matches.map((cand) => [cand[2] as string, cand[3] as string]);
}

function retrieveRowSubline(html: string, agentIdentifier: string): string {
  const rowPattern = new RegExp(`<div role="row" id="crew-row-${agentIdentifier}"[\\s\\S]*?</div>(?=<div role="row"|<p |</div></div>)`);
  const matchedRow = rowPattern.exec(html)?.[0] ?? "";
  const sublineHtml = /row-start-2[^>]*>([\s\S]*?)<\/span><\/div>/.exec(matchedRow)?.[1] ?? "";
  return textOf(sublineHtml);
}

const SAMPLE_BACKGROUND_TASK: ViewEvent = {
  method: "item/started",
  at: S(39, 0),
  params: {
    item: {
      itemId: "task-1",
      kind: "toolCall",
      status: "inProgress",
      revision: 1,
      turnId: "t1",
      tool: "bash",
      args: JSON.stringify({ command: "npm run docs:build" }),
      background: true,
      backgroundInitiator: "user",
      recordedAt: new Date(S(39, 0)).toISOString(),
    },
  },
};

describe("CrewPanel layout, docking geometry, and overlay presentation", () => {
  it("mounts docked aside at designated 520px narrow default width", () => {
    const markup = renderPanel();
    assert.match(markup, /^<aside id="crew-panel" aria-label="Crew" aria-modal="false" tabindex="-1" data-mode="roster" data-layout="narrow" style="--pane-bg:var\(--bg\);width:520px" class="[^"]*relative border-l border-line bg-bg narrow"/);
    assert.match(markup, /aria-label="Resize the Crew panel"/);
    assert.doesNotMatch(markup, /data-overlay/);

    const widePane = renderPanel({ prefs: { crewWidth: 800, sidebarCollapsed: true } });
    assert.match(widePane, /data-layout="split"[^>]*style="--pane-bg:var\(--bg\);width:800px" class="[^"]*split"/);
    assert.doesNotMatch(widePane, /narrow/);
  });

  it("transitions to backdrop scrim overlay when viewport remaining space falls below threshold", () => {
    const overlayMarkup = renderPanel({ prefs: { crewWidth: 800, sidebarWidth: 480 } });
    assert.match(overlayMarkup, /^<div class="relative w-0 shrink-0 self-stretch" data-overlay=""><div aria-hidden="true" class="absolute inset-y-0 right-0 z-\[var\(--z-overlay\)\] bg-\[oklch\(0\.1_0\.01_255\/0\.32\)\]" style="width:960px"><\/div><aside/);
    assert.match(overlayMarkup, /--pane-bg:var\(--bg-raised\);width:800px" class="[^"]*overlay absolute inset-y-0 right-0/);
    assert.doesNotMatch(overlayMarkup, /Resize the Crew panel/);

    const restoredMarkup = renderPanel({ prefs: { crewWidth: 800, sidebarWidth: 480, sidebarCollapsed: true } });
    assert.doesNotMatch(restoredMarkup, /data-overlay/);
  });

  it("renders header banner with run title, status badge, action controls, and close trigger", () => {
    const activeHtml = renderPanel();
    const visibleText = textOf(activeHtml);

    assert.match(visibleText, /^offline-sync-research-design Running Stop run/);
    assert.match(activeHtml, /aria-label="Crew panel actions"/);
    assert.match(activeHtml, /aria-label="Close the Crew panel"/);

    const completedHtml = renderPanel({ fold: lanternFold(S(46, 0), [], lanternDone()) }, S(46, 0));
    assert.match(textOf(completedHtml), /^offline-sync-research-design Finished /);
    assert.doesNotMatch(textOf(completedHtml), /Stop run/);

    const readOnlyHtml = renderPanel({ thread: { readOnly: true } });
    assert.doesNotMatch(textOf(readOnlyHtml), /Stop run/);
  });
});

describe("CrewPanel telemetry strip and KPI metric cells", () => {
  it("renders summary badge in markup reflecting active run status", () => {
    const markup = renderPanel();
    assert.match(textOf(markup), /6 of 10 done · Judge · 1 failed · 1 no update/);
    assert.match(markup, /data-summary=""/);
  });

  it("formats concise summary sentences for diverse workflow stages", () => {
    assert.equal(summaryText(lanternRun(S(3, 0))), "0 of 10 done · Research");
    assert.equal(summaryText(lanternRun(S(46, 0), [], lanternDone())), "10 of 10 agents finished · 4 phases");
    assert.equal(summaryText(lanternRun()), "6 of 10 done · Judge · 1 failed · 1 no update");
    assert.equal(summaryText(lanternRun(NOW, [approvalAt(S(39, 36))])), "6 of 10 done · Judge · 1 needs you · 1 failed · 1 no update");
  });

  it("renders six real-time KPI metrics during execution including launch slot capacity and pulse histogram", () => {
    const markup = renderPanel();
    assert.deepEqual(attrs(markup, "data-kpi"), ["agents", "tokens", "cost", "slots", "pulse", "elapsed"]);

    const agentCell = kpi(markup, "agents");
    assert.match(textOf(agentCell), /^Agents 9 \+1 planned 2 working now$/);
    assert.deepEqual(digits(agentCell), ["9"]);

    const tokenCell = kpi(markup, "tokens");
    assert.match(textOf(tokenCell), /^Tokens so far 1\.2M 8 of 9 reported$/);

    const costCell = kpi(markup, "cost");
    assert.match(textOf(costCell), /^Est\. cost ~\$[\d.]+ at list price · 8 of 9 reported$/);

    const slotCell = kpi(markup, "slots");
    assert.match(textOf(slotCell), /^Slots 2 of 16 launch policy$/);

    const pulseCell = kpi(markup, "pulse");
    assert.match(textOf(pulseCell), /^Pulse · 10 min \d+ events?\/min$/);
    const pulseBins = pulseCell.match(/<span class="block w-1/g) ?? [];
    assert.equal(pulseBins.length, 10);

    const elapsedCell = kpi(markup, "elapsed");
    assert.match(textOf(elapsedCell), /^Elapsed 41m 12s started /);
    assert.deepEqual(digits(elapsedCell), ["41m 12s"]);

    const unconfiguredPolicy = renderPanel({ fold: applyEvents(emptyFold(), [launch(undefined, null), ...lantern().events]) });
    assert.deepEqual(attrs(unconfiguredPolicy, "data-kpi"), ["agents", "tokens", "cost", "pulse", "elapsed"]);
  });

  it("renders descriptive fallbacks when metric telemetry is not yet recorded", () => {
    const initialHtml = renderPanel({ fold: lanternFold(S(3, 0)) }, S(3, 0));
    assert.match(textOf(kpi(initialHtml, "tokens")), /^Tokens so far — not reported yet$/);
    assert.match(textOf(kpi(initialHtml, "cost")), /^Est\. cost — no usage reported yet$/);
    assert.match(textOf(kpi(initialHtml, "agents")), /^Agents 4 \+6 planned 4 working now$/);
  });

  it("transitions telemetry strip to final post-run metrics upon workflow completion", () => {
    const finishedHtml = renderPanel({ fold: lanternFold(S(46, 0), [], lanternDone()) }, S(46, 0));
    assert.deepEqual(attrs(finishedHtml, "data-kpi"), ["agents", "tokens", "cost", "wall", "agent-time", "peak"]);

    assert.match(textOf(kpi(finishedHtml, "agents")), /^Agents 10 1 retried$/);
    assert.match(textOf(kpi(finishedHtml, "tokens")), /^Tokens 1\.4M all 10 reported$/);
    assert.match(textOf(kpi(finishedHtml, "wall")), /^Wall time 45m 06s started /);
    assert.match(textOf(kpi(finishedHtml, "agent-time")), /^Agent time \d+h \d\dm across 10 agents$/);
    assert.match(textOf(kpi(finishedHtml, "peak")), /^Peak 4 at once during Research$/);
  });
});

describe("CrewPanel roster ordering, phase accordion, and filtering", () => {
  it("computes accurate chip tallies and suppresses categories with zero members", () => {
    const metrics = chipCounts(lanternRun());
    assert.deepEqual(metrics, { all: 10, needs: 0, failed: 1, noUpdate: 1, working: 1, done: 6 });

    assert.deepEqual(parseFilterChipCatalog(renderPanel()), [
      ["All", "10"],
      ["Failed", "1"],
      ["No update", "1"],
      ["Working", "1"],
      ["Done", "6"],
    ]);

    const withApprovalHtml = renderPanel({ fold: lanternFold(NOW, [approvalAt(S(39, 36))]) });
    assert.deepEqual(parseFilterChipCatalog(withApprovalHtml), [
      ["All", "10"],
      ["Needs you", "1"],
      ["Failed", "1"],
      ["No update", "1"],
      ["Working", "1"],
      ["Done", "6"],
    ]);

    const activeFilterHtml = renderPanel({ panel: { filter: "failed" } });
    assert.match(activeFilterHtml, /aria-pressed="true" data-filter="failed"/);
    assert.doesNotMatch(activeFilterHtml, /aria-pressed="true" data-filter="all"/);
    assert.match(activeFilterHtml, /placeholder="Find agent" aria-label="Find agent"/);
    assert.match(activeFilterHtml, /<kbd[^>]*>\/<\/kbd>/);
  });

  it("arranges phases in workflow order with chronological agent sorting", () => {
    const html = renderPanel();
    assert.deepEqual(getRosterRowIds(html), [
      "phase:Research",
      "phase:Design",
      "c-cl",
      "c-ol",
      "c-cf",
      "phase:Judge",
      "c-jc",
      "c-jp",
      "phase:Synthesize",
    ]);

    assert.match(rowTag(html, "phase:Research"), /tabindex="0" aria-selected="true" aria-expanded="false" aria-label="Research, 4 of 4 done, 618k tokens, 11m 58s"/);
    assert.match(rowTag(html, "phase:Design"), /aria-expanded="true" aria-label="Design, 2 of 3 done, 1 failed, 445k tokens, 12m 40s"/);
    assert.match(rowTag(html, "phase:Judge"), /aria-label="Judge, 0 of 2 done, 138k tokens, 16m 02s so far"/);
    assert.match(rowTag(html, "phase:Synthesize"), /aria-label="Synthesize, 1 planned"/);
    assert.match(html, /aria-sort="descending"[^>]*>Time/);

    const activeModel = lanternRun();
    const designPhase = activeModel.phases[1]!;
    assert.deepEqual(sortAgents(designPhase.agents, "time").map((a) => a.name), ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]);
    assert.deepEqual(sortAgents(designPhase.agents, "tokens").map((a) => a.name), ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]);
    assert.deepEqual(sortAgents(designPhase.agents, "order").map((a) => a.name), ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]);

    const researchPhase = activeModel.phases[0]!;
    const mixedAgents = [...researchPhase.agents, { ...activeModel.phases[2]!.agents[1]!, startedAt: S(12, 0), runningMs: 60_000 }];
    assert.deepEqual(sortAgents(mixedAgents, "time").map((a) => a.name), ["judge:perf", "research:field-notes", "research:crdt-survey", "research:prior-art", "research:constraints"]);

    const tickedAgents = mixedAgents.map((a) => ({ ...a, runningMs: a.runningMs === null ? null : a.runningMs + 20 * MIN }));
    assert.equal(sortAgents(tickedAgents, "time").map((a) => a.name)[0], "judge:perf");

    const gridContent = html.slice(html.indexOf('role="grid"'));
    const tabbableCount = (gridContent.match(/tabindex="0"/g) ?? []).length;
    assert.equal(tabbableCount, 1);
  });

  it("renders secondary descriptive lines on tall rows while keeping compact rows clean", () => {
    const html = renderPanel();
    assert.equal(retrieveRowSubline(html, "c-cf"), "Failed · attempt 2 of 2 · Muse has not reported a reason yet");
    assert.equal(retrieveRowSubline(html, "c-jc"), "Finishing · usage reported 53s ago");
    assert.equal(retrieveRowSubline(html, "c-jp"), "Working No update for 16m 02s");
    assert.equal(retrieveRowSubline(html, "c-cl"), "");

    assert.match(html, /aria-label="design:conflict-ledger, Failed · 2 attempts, attempt 2 of 2, Muse has not reported a reason yet, 59k tokens, 3m 51s"/);
    assert.match(html, /aria-label="judge:perf, No update for 16m 02s, 16m 02s"/);

    const pendingStateHtml = renderPanel({
      state: {
        crew: {
          panels: {},
          activityOpen: false,
          pending: { [pendingKey("s1", "c-cf", 2)]: "retry" },
          skipped: [],
          leftAt: {},
          dismissedReports: [],
          dismissedRecaps: [],
        },
      },
    });
    assert.equal(retrieveRowSubline(pendingStateHtml, "c-cf"), "Retrying · attempt 3 starting · Muse has not confirmed yet");
  });

  it("filters roster rows based on status chip and search query term", () => {
    assert.deepEqual(getRosterRowIds(renderPanel({ panel: { filter: "failed" } })), ["phase:Design", "c-cf"]);
    assert.deepEqual(getRosterRowIds(renderPanel({ panel: { filter: "done" } })), [
      "phase:Research",
      "c-fn",
      "c-cs",
      "c-pa",
      "c-co",
      "phase:Design",
      "c-cl",
      "c-ol",
    ]);

    assert.deepEqual(getRosterRowIds(renderPanel({ panel: { query: "judge:" } })), ["phase:Judge", "c-jc", "c-jp"]);
    assert.deepEqual(getRosterRowIds(renderPanel({ panel: { query: "ledger" } })), ["phase:Design", "c-cl", "c-cf"]);
    assert.match(renderPanel({ panel: { query: "nothing" } }), /No agent matches\./);
  });

  it("updates phase accordion expansion upon user toggle and expands all on finish", () => {
    const researchOnly = getRosterRowIds(renderPanel({ panel: { openPhases: ["Research"] } }));
    assert.deepEqual(researchOnly.slice(0, 5), ["phase:Research", "c-fn", "c-cs", "c-pa", "c-co"]);

    const designToggled = getRosterRowIds(renderPanel({ panel: { openPhases: ["Design"] } }));
    assert.deepEqual(designToggled, ["phase:Research", "phase:Design", "phase:Judge", "c-jc", "c-jp", "phase:Synthesize"]);

    const entries = rosterEntries(lanternRun(), { filter: "all", query: "", openPhases: [], sort: "time", unfolded: new Set() });
    assert.deepEqual(
      entries.filter((e) => e.kind === "phase").map((e) => (e.kind === "phase" ? [e.phase.name, e.open, e.current] : null)),
      [
        ["Research", false, false],
        ["Design", true, false],
        ["Judge", true, true],
        ["Synthesize", false, false],
      ],
    );

    const finishedEntries = rosterEntries(lanternRun(S(46, 0), [], lanternDone()), {
      filter: "all",
      query: "",
      openPhases: [],
      sort: "time",
      unfolded: new Set(),
    });
    assert.deepEqual(
      finishedEntries.filter((e) => e.kind === "phase").map((e) => (e.kind === "phase" ? e.open : null)),
      [true, true, true, true],
    );
    assert.equal(finishedEntries.filter((e) => e.kind === "agent").length, 10);
  });

  it("surfaces run-level requests exclusively within the Needs you filter", () => {
    const approvalFold = lanternFold(NOW, [approvalAt(S(39, 36))]);
    const generalView = renderPanel({ fold: approvalFold });

    assert.equal(getRosterRowIds(generalView)[0], "phase:Research");
    assert.match(textOf(generalView), /1 needs you/);
    assert.match(generalView, /data-marker="approval"/);

    const needsOnly = renderPanel({ fold: approvalFold, panel: { filter: "needs" } });
    assert.deepEqual(getRosterRowIds(needsOnly), ["need:ap-1"]);
    assert.match(textOf(needsOnly), /Waiting for you Muse wants to run npm test -- --run conflict Asked 1m 40s ago, during Judge\. Muse does not say which agent asked\./);
    assert.match(needsOnly, /Review/);
  });

  it("folds completed agent rows into a summary counter when phase exceeds twelve agents", () => {
    const rawEvents: ViewEvent[] = [];
    const simulatedFeed = new Feed();
    for (let idx = 0; idx < 15; idx += 1) simulatedFeed.schedule(`r-${idx}`, `research:agent-${idx}`, S(0, 1));
    for (let idx = 0; idx < 15; idx += 1) simulatedFeed.set(`r-${idx}`, { status: "started" }, S(0, 2));
    for (let idx = 0; idx < 14; idx += 1) simulatedFeed.finish(`r-${idx}`, S(1 + idx, 0), 60_000 * (idx + 1));
    rawEvents.push(launch(null), ...simulatedFeed.events);

    const foldedHtml = renderPanel({ fold: applyEvents(emptyFold(), rawEvents) }, S(20, 0));
    assert.deepEqual(getRosterRowIds(foldedHtml), ["phase:Research", "r-14"]);
    assert.match(foldedHtml, /Show 14 finished/);
  });
});

describe("CrewPanel inspector integration, row peeking, and accessibility", () => {
  it("mounts full-screen inspector view in narrow mode and renders breadcrumbs", () => {
    const inspectorHtml = renderPanel({ panel: { mode: "inspector", inspectId: "c-cf" } });
    assert.match(inspectorHtml, /data-mode="inspector"/);
    assert.match(inspectorHtml, /aria-label="Back to the run"/);
    assert.match(textOf(inspectorHtml), /offline-sync-research-design design:conflict-ledger/);
    assert.match(inspectorHtml, /<nav aria-label="Inspector"/);
    assert.doesNotMatch(inspectorHtml, /role="grid"/);
    assert.match(inspectorHtml, /data-inspector="full"/);
    assert.match(textOf(inspectorHtml), /esc back to the run j k next \/ previous agent r retry s skip$/);

    const fallbackHtml = renderPanel({ panel: { mode: "inspector", inspectId: "nobody" } });
    assert.match(fallbackHtml, /data-mode="roster"/);
  });

  it("displays inspector as split column alongside roster at wide viewports", () => {
    const splitHtml = renderPanel({ prefs: { crewWidth: 800 }, panel: { mode: "inspector", inspectId: "c-cf" } });
    assert.match(splitHtml, /data-mode="inspector"/);
    assert.match(splitHtml, /role="grid"/);
    assert.match(splitHtml, /data-inspector="column"/);
    assert.match(splitHtml, /data-summary=""/);
    assert.match(splitHtml, /<svg width="768"/);
    assert.doesNotMatch(splitHtml, /<nav aria-label="Inspector"/);
    assert.match(splitHtml, /fill="var\(--bg-active\)"/);
  });

  it("displays keyboard navigation hints footer", () => {
    assert.match(textOf(renderPanel()), /j k move ↵ inspect space peek n next issue \/ filter x stop esc close$/);
  });

  it("displays expandable row peek overlay upon spacebar activation while maintaining focus", () => {
    const activeRun = lanternRun();
    const entryList = rosterEntries(activeRun, { filter: "all", query: "", openPhases: [], sort: "time", unfolded: new Set() });
    const noopFn = () => undefined;

    const renderRosterWithPeek = (targetPeekId: string | null) =>
      atNow(NOW, () =>
        renderWith(
          panelStore(),
          createElement(Roster, {
            run: activeRun,
            entries: entryList,
            focusId: "c-cf",
            peekId: targetPeekId,
            finale: false,
            stale: false,
            readOnly: false,
            sort: "time",
            confirm: null,
            onSort: noopFn,
            onFocus: noopFn,
            onInspect: noopFn,
            onTogglePhase: noopFn,
            onUnfold: noopFn,
            onAction: noopFn,
            onConfirm: noopFn,
            onReview: noopFn,
            register: noopFn,
          }),
        ),
      );

    assert.doesNotMatch(renderRosterWithPeek(null), /crew-peek/);

    const peekMarkup = renderRosterWithPeek("c-cf");
    const peekCount = (peekMarkup.match(/class="crew-peek"/g) ?? []).length;
    assert.equal(peekCount, 1);

    const startPos = peekMarkup.indexOf('id="crew-row-c-cf"');
    const peekPos = peekMarkup.indexOf('<div class="crew-peek"', startPos);
    assert.ok(peekPos > startPos && peekPos < peekMarkup.indexOf('role="row"', startPos));
    assert.match(rowTag(peekMarkup, "c-cf"), /tabindex="0" aria-selected="true"/);

    const peekSegment = peekMarkup.slice(peekPos, peekMarkup.indexOf("close</span>", peekPos));
    assert.match(peekSegment, /^<div class="crew-peek" role="dialog" aria-modal="false" aria-label="design:conflict-ledger: Design · attempt 2 · /);
    assert.doesNotMatch(peekSegment, /tabindex|<button|<a /);
    assert.match(textOf(peekSegment), /Failed/);
    assert.match(textOf(peekSegment), /Design the conflict ledger: define how two devices reconcile\./);
    assert.match(textOf(peekSegment), /Attempts 2/);
    assert.match(textOf(peekSegment), /Enter open Esc/);
  });

  it("freezes clocks and reflects last-known state when connection drops", () => {
    const disconnectedHtml = renderPanel({ state: { connection: "lost" } });
    assert.match(textOf(disconnectedHtml), /^offline-sync-research-design Last known/);
    assert.match(textOf(disconnectedHtml), /Last known · 6 of 10 done · Judge/);
    assert.match(textOf(kpi(disconnectedHtml, "elapsed")), /^Last known 40m 19s at /);
    assert.match(disconnectedHtml, /last known 40m 19s/);
    assert.doesNotMatch(disconnectedHtml, /Stop run/);
    assert.doesNotMatch(textOf(disconnectedHtml), /No update for/);
    assert.match(textOf(disconnectedHtml), /Working · no update since it started/);
  });
});

describe("CrewPanel research workflows, background tasks, and run selector", () => {
  it("renders background task lists and handles empty/loading session conditions", () => {
    const taskOnlyHtml = renderPanel({ fold: applyEvents(emptyFold(), [SAMPLE_BACKGROUND_TASK]) });
    assert.match(textOf(taskOnlyHtml), /^Agents and tasks/);
    assert.deepEqual(getRosterRowIds(taskOnlyHtml), ["phase:Background", "task-1"]);
    assert.match(rowTag(taskOnlyHtml, "task-1"), /aria-label="npm run docs:build, Working, You sent it to the background, 2m 16s"/);

    const silentTaskHtml = renderPanel({ fold: applyEvents(emptyFold(), [{ ...SAMPLE_BACKGROUND_TASK, at: S(30, 0) }]) });
    assert.match(rowTag(silentTaskHtml, "task-1"), /aria-label="npm run docs:build, No output for 11m 16s, 11m 16s"/);
    assert.doesNotMatch(taskOnlyHtml, /data-kpi/);

    const combinedHtml = renderPanel({ fold: lanternFold(NOW, [SAMPLE_BACKGROUND_TASK]) });
    assert.deepEqual(getRosterRowIds(combinedHtml).slice(-2), ["phase:Background", "task-1"]);

    const blankThreadHtml = renderPanel({ fold: emptyFold() });
    assert.match(textOf(blankThreadHtml), /No agents in this thread Send a prompt to follow Muse, its tools, delegated agents and background tasks here\./);

    const loadingHtml = renderPanel({ fold: emptyFold(), thread: { load: "loading" } });
    assert.match(textOf(loadingHtml), /Loading agent activity/);
  });

  it("selects newest active run with priority over terminated historical runs", () => {
    const activeCandidate = { itemId: "a", status: "running" } as RunVM;
    const historicCandidate = { itemId: "b", status: "finished" } as RunVM;

    assert.equal(panelRun([activeCandidate, historicCandidate]), activeCandidate);
    assert.equal(panelRun([historicCandidate]), historicCandidate);
    assert.equal(panelRun([]), null);
  });

  const activeResearchFixture = runningResearch();
  const buildResearchSetup = (customPanel?: PanelSetup["panel"]): PanelSetup => ({
    fold: emptyFold(),
    thread: { researchRuns: [activeResearchFixture] },
    ...(customPanel ? { panel: customPanel } : {}),
  });

  it("renders specialized research run roster grouped by research rounds without worker controls", () => {
    const researchHtml = renderPanel(buildResearchSetup(), RESEARCH_NOW);
    const visibleText = textOf(researchHtml);

    assert.ok(visibleText.startsWith(`${researchThreadTitle(activeResearchFixture.question)} Running Stop run`));
    assert.match(visibleText, /Researching, round 2 of 12 · 1 done · 1 working · 1 failed/);
    assert.deepEqual(getRosterRowIds(researchHtml), [
      "phase:Round 1 of 12",
      "research:run-1:A1",
      "research:run-1:A2",
      "phase:Round 2 of 12",
      "research:run-1:A3",
    ]);

    assert.equal(retrieveRowSubline(researchHtml, "research:run-1:A1"), "Done · 2 searches · 3 reads · 1 saved");
    assert.equal(retrieveRowSubline(researchHtml, "research:run-1:A2"), "Failed · 1 search · the run does not say why");
    assert.equal(retrieveRowSubline(researchHtml, "research:run-1:A3"), "Working · 2 searches · 1 read");

    assert.match(textOf(kpi(researchHtml, "tokens")), /^Tokens so far 91k the run's own count$/);
    assert.match(textOf(kpi(researchHtml, "cost")), /^Est\. cost ~\$[\d.]+ at list price$/);
    assert.match(textOf(kpi(researchHtml, "slots")), /^Slots 1 of 3 run config$/);
    assert.deepEqual(parseFilterChipCatalog(researchHtml), [
      ["All", "3"],
      ["Failed", "1"],
      ["Working", "1"],
      ["Done", "1"],
    ]);

    assert.doesNotMatch(visibleText, /Retry|Skip/);
    assert.doesNotMatch(visibleText, /No agents in this thread/);
  });

  it("inspects research worker telemetry counters and explains automated supervisor control", () => {
    const inspectedHtml = renderPanel(buildResearchSetup({ mode: "inspector", inspectId: "research:run-1:A2" }), RESEARCH_NOW);
    const detailText = textOf(inspectedHtml);

    assert.match(detailText, /A2 · Primer's functional colour roles Round 1 of 12 · Research worker/);
    assert.match(inspectedHtml, /data-callout="failed"/);
    assert.match(detailText, /Failed after 40s The run does not report why a worker failed\. Its report may say\. Research workers run on their own: the supervisor decides/);
    assert.doesNotMatch(detailText, /Retry agent|Skip and continue|Stop agent/);
    assert.match(detailText, /Task the topic the supervisor gave it Primer's functional colour roles/);

    assert.deepEqual(attrs(inspectedHtml, "data-fact").slice(0, 3), ["status", "started", "ended"]);
    assert.match(detailText, /Searches 1 Reads 0 Saved 0 Tool calls 1 Model muse-spark-1\.3 Result Its findings go into the run's report Round 1/);
    assert.match(detailText, /What the run reports for a worker: its state and its counters\./);

    const activeWorkerHtml = renderPanel(buildResearchSetup({ mode: "inspector", inspectId: "research:run-1:A3" }), RESEARCH_NOW);
    assert.match(textOf(activeWorkerHtml), /Started Round 2 of 12 .*Working · 2 searches · 1 read The counters move as the worker calls its tools now/);
  });
});
