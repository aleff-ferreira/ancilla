import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { chipCounts, rosterEntries, sortAgents, summaryText } from "../src/components/swarm/panel.js";
import { Roster } from "../src/components/swarm/Roster.js";
import { panelRun } from "../src/components/swarm/SwarmPanel.js";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { pendingKey, type RunVM } from "../src/model/swarm.js";
import type { ViewEvent } from "../src/types.js";
import { Feed, MIN, NOW, S, approvalAt, atNow, attrs, digits, kpi, lantern, lanternDone, lanternFold, lanternRun, launch, panelStore, renderPanel, renderWith, rowTag, textOf } from "./swarm-panel-fixture.js";

/** The rows of the roster grid in order: phase heads by name, agents by id. */
function rows(markup: string): string[] {
  return attrs(markup, "id").filter((id) => id.startsWith("swarm-row-")).map((id) => id.slice("swarm-row-".length));
}

function chips(markup: string): [string, string][] {
  return [...markup.matchAll(/data-filter="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<span[^>]*>(\d+)<\/span>/g)].map((m) => [m[2] as string, m[3] as string]);
}

function subline(markup: string, id: string): string {
  const row = new RegExp(`<div role="row" id="swarm-row-${id}"[\\s\\S]*?</div>(?=<div role="row"|<p |</div></div>)`).exec(markup)?.[0] ?? "";
  const sub = /row-start-2[^>]*>([\s\S]*?)<\/span><\/div>/.exec(row)?.[1] ?? "";
  return textOf(sub);
}

const TASK: ViewEvent = {
  method: "item/started",
  at: S(39, 0),
  params: { item: { itemId: "task-1", kind: "toolCall", status: "inProgress", revision: 1, turnId: "t1", tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true, backgroundInitiator: "user", recordedAt: new Date(S(39, 0)).toISOString() } },
};

describe("SwarmPanel", () => {
  it("is the Swarm aside at the preferred width, docked beside the thread when the window can afford it", () => {
    const markup = renderPanel();
    assert.match(markup, /^<aside id="swarm-panel" aria-label="Swarm" aria-modal="false" tabindex="-1" data-mode="roster" data-layout="narrow" style="--pane-bg:var\(--bg\);width:520px" class="[^"]*relative border-l border-line bg-bg narrow"/);
    assert.match(markup, /aria-label="Resize the Swarm panel"/);
    assert.doesNotMatch(markup, /data-overlay/);
    // F3: the sidebar collapsed, the panel at 800, a 640 px thread column.
    const wide = renderPanel({ prefs: { swarmWidth: 800, sidebarCollapsed: true } });
    assert.match(wide, /data-layout="split"[^>]*style="--pane-bg:var\(--bg\);width:800px" class="[^"]*split"/);
    assert.doesNotMatch(wide, /narrow/);
  });

  it("overlays the thread over a scrim when the remaining column would drop under 560 px", () => {
    // 1440 − 480 (sidebar) − 800 = 160 < 560: the panel overlays; at 284 − 520 it docks (636 ≥ 560).
    const markup = renderPanel({ prefs: { swarmWidth: 800, sidebarWidth: 480 } });
    assert.match(markup, /^<div class="relative w-0 shrink-0 self-stretch" data-overlay=""><div aria-hidden="true" class="absolute inset-y-0 right-0 z-\[var\(--z-overlay\)\] bg-\[oklch\(0\.1_0\.01_255\/0\.32\)\]" style="width:960px"><\/div><aside/);
    assert.match(markup, /--pane-bg:var\(--bg-raised\);width:800px" class="[^"]*overlay absolute inset-y-0 right-0/);
    assert.doesNotMatch(markup, /Resize the Swarm panel/);
    const collapsed = renderPanel({ prefs: { swarmWidth: 800, sidebarWidth: 480, sidebarCollapsed: true } });
    assert.doesNotMatch(collapsed, /data-overlay/, "a collapsed sidebar gives the column its room back");
  });

  it("heads with the run's name, its status pill, Stop run, the menu and close", () => {
    const markup = renderPanel();
    const text = textOf(markup);
    assert.match(text, /^offline-sync-research-design Running Stop run/);
    assert.match(markup, /aria-label="Swarm panel actions"/);
    assert.match(markup, /aria-label="Close the Swarm panel"/);
    const finished = renderPanel({ fold: lanternFold(S(46, 0), [], lanternDone()) }, S(46, 0));
    assert.match(textOf(finished), /^offline-sync-research-design Finished /);
    assert.doesNotMatch(textOf(finished), /Stop run/);
    assert.doesNotMatch(textOf(renderPanel({ thread: { readOnly: true } })), /Stop run/);
  });

  it("sums the run up in one sentence: done of total, the phase, then only what needs attention", () => {
    assert.equal(summaryText(lanternRun()), "6 of 10 done · Judge · 1 failed · 1 no update");
    assert.equal(summaryText(lanternRun(NOW, [approvalAt(S(39, 36))])), "6 of 10 done · Judge · 1 needs you · 1 failed · 1 no update");
    assert.equal(summaryText(lanternRun(S(46, 0), [], lanternDone())), "10 of 10 agents finished · 4 phases");
    assert.equal(summaryText(lanternRun(S(3, 0))), "0 of 10 done · Research");
    const markup = renderPanel();
    assert.match(markup, /data-summary=""/);
    assert.match(textOf(markup), /6 of 10 done · Judge · 1 failed · 1 no update/);
  });

  it("shows six KPI cells while the run goes, with the slots only when the launch reported a policy", () => {
    const markup = renderPanel();
    assert.deepEqual(attrs(markup, "data-kpi"), ["agents", "tokens", "cost", "slots", "pulse", "elapsed"]);
    const agents = kpi(markup, "agents");
    assert.match(textOf(agents), /^Agents 9 \+1 planned 2 working now$/);
    assert.deepEqual(digits(agents), ["9"]);
    const tokens = kpi(markup, "tokens");
    assert.match(textOf(tokens), /^Tokens so far 1\.3M 8 of 9 reported$/);
    const cost = kpi(markup, "cost");
    assert.match(textOf(cost), /^Est\. cost ~\$[\d.]+ at list price$/);
    assert.match(textOf(kpi(markup, "slots")), /^Slots 2 of 16 launch policy$/);
    assert.match(textOf(kpi(markup, "pulse")), /^Pulse · 10 min \d+ events?\/min$/);
    assert.equal((kpi(markup, "pulse").match(/<span class="block w-1/g) ?? []).length, 10, "ten bins");
    assert.match(textOf(kpi(markup, "elapsed")), /^Elapsed 41m 12s started /);
    assert.deepEqual(digits(kpi(markup, "elapsed")), ["41m 12s"]);
    const noPolicy = renderPanel({ fold: applyEvents(emptyFold(), [launch(undefined, null), ...lantern().events]) });
    assert.deepEqual(attrs(noPolicy, "data-kpi"), ["agents", "tokens", "cost", "pulse", "elapsed"]);
  });

  it("never leaves a KPI blank: a dash with the reason under it", () => {
    const early = renderPanel({ fold: lanternFold(S(3, 0)) }, S(3, 0));
    assert.match(textOf(kpi(early, "tokens")), /^Tokens so far — not reported yet$/);
    assert.match(textOf(kpi(early, "cost")), /^Est\. cost — no usage reported yet$/);
    assert.match(textOf(kpi(early, "agents")), /^Agents 4 \+6 planned 4 working now$/);
  });

  it("switches the strip to the finished figures once the run ended", () => {
    const markup = renderPanel({ fold: lanternFold(S(46, 0), [], lanternDone()) }, S(46, 0));
    assert.deepEqual(attrs(markup, "data-kpi"), ["agents", "tokens", "cost", "wall", "agent-time", "peak"]);
    assert.match(textOf(kpi(markup, "agents")), /^Agents 10 1 retried$/);
    assert.match(textOf(kpi(markup, "tokens")), /^Tokens 1\.5M all 10 reported$/);
    assert.match(textOf(kpi(markup, "wall")), /^Wall time 45m 06s started /);
    assert.match(textOf(kpi(markup, "agent-time")), /^Agent time \d+h \d\dm across 10 agents$/);
    assert.match(textOf(kpi(markup, "peak")), /^Peak 4 at once during Research$/);
  });

  it("counts the filter chips from the run and hides a chip with nothing behind it", () => {
    const counts = chipCounts(lanternRun());
    assert.deepEqual(counts, { all: 10, needs: 0, failed: 1, noUpdate: 1, working: 1, done: 6 });
    assert.deepEqual(chips(renderPanel()), [["All", "10"], ["Failed", "1"], ["No update", "1"], ["Working", "1"], ["Done", "6"]]);
    assert.deepEqual(chips(renderPanel({ fold: lanternFold(NOW, [approvalAt(S(39, 36))]) })), [["All", "10"], ["Needs you", "1"], ["Failed", "1"], ["No update", "1"], ["Working", "1"], ["Done", "6"]]);
    const markup = renderPanel({ panel: { filter: "failed" } });
    assert.match(markup, /aria-pressed="true" data-filter="failed"/);
    assert.doesNotMatch(markup, /aria-pressed="true" data-filter="all"/);
    assert.match(markup, /placeholder="Find agent" aria-label="Find agent"/);
    assert.match(markup, /<kbd[^>]*>\/<\/kbd>/);
  });

  it("lists phases in run order, opens the current and the failed ones, and orders rows by time", () => {
    const markup = renderPanel();
    assert.deepEqual(rows(markup), ["phase:Research", "phase:Design", "c-cl", "c-ol", "c-cf", "phase:Judge", "c-jc", "c-jp", "phase:Synthesize"]);
    // Phase spans run from the first start to the last end the fold recorded.
    assert.match(rowTag(markup, "phase:Research"), /tabindex="0" aria-selected="true" aria-expanded="false" aria-label="Research, 4 of 4 done, 660k tokens, 11m 58s"/);
    assert.match(rowTag(markup, "phase:Design"), /aria-expanded="true" aria-label="Design, 2 of 3 done, 1 failed, 468k tokens, 12m 40s"/);
    assert.match(rowTag(markup, "phase:Judge"), /aria-label="Judge, 0 of 2 done, 148k tokens, 16m 02s so far"/);
    assert.match(rowTag(markup, "phase:Synthesize"), /aria-label="Synthesize, 1 planned"/);
    assert.match(markup, /aria-sort="descending"[^>]*>Time/);
    const run = lanternRun();
    const design = run.phases[1]!;
    assert.deepEqual(sortAgents(design.agents, "time").map((a) => a.name), ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]);
    assert.deepEqual(sortAgents(design.agents, "tokens").map((a) => a.name), ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]);
    assert.deepEqual(sortAgents(design.agents, "order").map((a) => a.name), ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]);
    // Nothing reorders while you look (SPEC §9.1): a running agent never overtakes a finished one on a tick.
    const research = run.phases[0]!;
    const mixed = [...research.agents, { ...run.phases[2]!.agents[1]!, startedAt: S(12, 0), runningMs: 60_000 }];
    assert.deepEqual(sortAgents(mixed, "time").map((a) => a.name), ["judge:perf", "research:field-notes", "research:crdt-survey", "research:prior-art", "research:constraints"]);
    assert.deepEqual(sortAgents(mixed.map((a) => ({ ...a, runningMs: a.runningMs === null ? null : a.runningMs + 20 * MIN })), "time").map((a) => a.name)[0], "judge:perf");
    const grid = markup.slice(markup.indexOf('role="grid"'));
    assert.equal((grid.match(/tabindex="0"/g) ?? []).length, 1, "one tabbable row");
  });

  it("gives the tall rows their second line and the compact rows none", () => {
    const markup = renderPanel();
    assert.equal(subline(markup, "c-cf"), "Failed · attempt 2 of 2 · Muse has not reported a reason yet");
    assert.equal(subline(markup, "c-jc"), "Finishing · usage reported 53s ago");
    assert.equal(subline(markup, "c-jp"), "Working No update for 16m 02s");
    assert.equal(subline(markup, "c-cl"), "");
    assert.match(markup, /aria-label="design:conflict-ledger, Failed · 2 attempts, attempt 2 of 2, Muse has not reported a reason yet, 64k tokens, 3m 51s"/);
    assert.match(markup, /aria-label="judge:perf, No update for 16m 02s, 16m 02s"/);
    const pending = renderPanel({ state: { swarm: { panels: {}, activityOpen: false, pending: { [pendingKey("s1", "c-cf", 2)]: "retry" }, skipped: [], leftAt: {}, dismissedReports: [], dismissedRecaps: [] } } });
    assert.equal(subline(pending, "c-cf"), "Retrying · attempt 3 starting · Muse has not confirmed yet");
  });

  it("filters the roster by chip and by name, opening every phase that matches", () => {
    assert.deepEqual(rows(renderPanel({ panel: { filter: "failed" } })), ["phase:Design", "c-cf"]);
    assert.deepEqual(rows(renderPanel({ panel: { filter: "done" } })), ["phase:Research", "c-fn", "c-cs", "c-pa", "c-co", "phase:Design", "c-cl", "c-ol"]);
    assert.deepEqual(rows(renderPanel({ panel: { query: "judge:" } })), ["phase:Judge", "c-jc", "c-jp"]);
    assert.deepEqual(rows(renderPanel({ panel: { query: "ledger" } })), ["phase:Design", "c-cl", "c-cf"]);
    assert.match(renderPanel({ panel: { query: "nothing" } }), /No agent matches\./);
  });

  it("flips a phase's default when the user toggles it", () => {
    assert.deepEqual(rows(renderPanel({ panel: { openPhases: ["Research"] } })).slice(0, 5), ["phase:Research", "c-fn", "c-cs", "c-pa", "c-co"]);
    assert.deepEqual(rows(renderPanel({ panel: { openPhases: ["Design"] } })), ["phase:Research", "phase:Design", "phase:Judge", "c-jc", "c-jp", "phase:Synthesize"]);
    const entries = rosterEntries(lanternRun(), { filter: "all", query: "", openPhases: [], sort: "time", unfolded: new Set() });
    assert.deepEqual(entries.filter((entry) => entry.kind === "phase").map((entry) => (entry.kind === "phase" ? [entry.phase.name, entry.open, entry.current] : null)), [
      ["Research", false, false], ["Design", true, false], ["Judge", true, true], ["Synthesize", false, false],
    ]);
    const finished = rosterEntries(lanternRun(S(46, 0), [], lanternDone()), { filter: "all", query: "", openPhases: [], sort: "time", unfolded: new Set() });
    assert.deepEqual(finished.filter((entry) => entry.kind === "phase").map((entry) => (entry.kind === "phase" ? entry.open : null)), [true, true, true, true], "a finished run opens every phase");
    assert.equal(finished.filter((entry) => entry.kind === "agent").length, 10);
  });

  it("lists a run-level request under the Needs you filter, and keeps it out of the roster otherwise", () => {
    const fold = lanternFold(NOW, [approvalAt(S(39, 36))]);
    const all = renderPanel({ fold });
    assert.equal(rows(all)[0], "phase:Research", "the roster starts with the phases, as in F3");
    assert.match(textOf(all), /1 needs you/, "the summary carries it");
    assert.match(all, /data-marker="approval"/, "and the Timeline marks it");
    const needs = renderPanel({ fold, panel: { filter: "needs" } });
    assert.deepEqual(rows(needs), ["need:ap-1"]);
    assert.match(textOf(needs), /Waiting for you Muse wants to run npm test -- --run conflict Asked 1m 40s ago, during Judge\. Muse does not say which agent asked\./);
    assert.match(needs, /Review/);
  });

  it("folds finished agents behind one row past twelve in a phase", () => {
    const events: ViewEvent[] = [];
    const feed = new Feed();
    for (let i = 0; i < 15; i += 1) feed.schedule(`r-${i}`, `research:agent-${i}`, S(0, 1));
    for (let i = 0; i < 15; i += 1) feed.set(`r-${i}`, { status: "started" }, S(0, 2));
    for (let i = 0; i < 14; i += 1) feed.finish(`r-${i}`, S(1 + i, 0), 60_000 * (i + 1));
    events.push(launch(null), ...feed.events);
    const markup = renderPanel({ fold: applyEvents(emptyFold(), events) }, S(20, 0));
    assert.deepEqual(rows(markup), ["phase:Research", "r-14"], "the working one stays out, the finished fold");
    assert.match(markup, /Show 14 finished/);
  });

  it("opens the inspector in place of the roster in a narrow panel, with the crumb in the head", () => {
    const markup = renderPanel({ panel: { mode: "inspector", inspectId: "c-cf" } });
    assert.match(markup, /data-mode="inspector"/);
    assert.match(markup, /aria-label="Back to the run"/);
    assert.match(textOf(markup), /offline-sync-research-design design:conflict-ledger/);
    assert.match(markup, /<nav aria-label="Inspector"/);
    assert.doesNotMatch(markup, /role="grid"/);
    assert.match(markup, /data-inspector="full"/);
    assert.match(textOf(markup), /esc back to the run j k next \/ previous agent r retry s skip$/);
    const unknown = renderPanel({ panel: { mode: "inspector", inspectId: "nobody" } });
    assert.match(unknown, /data-mode="roster"/, "an agent that is not there shows the roster");
  });

  it("opens the inspector as a column beside the roster from 760 px, under the summary and the Timeline", () => {
    const markup = renderPanel({ prefs: { swarmWidth: 800 }, panel: { mode: "inspector", inspectId: "c-cf" } });
    assert.match(markup, /data-mode="inspector"/);
    assert.match(markup, /role="grid"/);
    assert.match(markup, /data-inspector="column"/);
    assert.match(markup, /data-summary=""/);
    assert.match(markup, /<svg width="768"/);
    assert.doesNotMatch(markup, /<nav aria-label="Inspector"/);
    assert.match(markup, /fill="var\(--bg-active\)"/, "the inspected lane is highlighted");
  });

  it("ends with the key hints", () => {
    assert.match(textOf(renderPanel()), /j k move ↵ inspect space peek n next issue \/ filter x stop esc close$/);
  });

  it("shows a peek under the focused row once Space asks for one, inside the row so the row keeps focus", () => {
    const run = lanternRun();
    const entries = rosterEntries(run, { filter: "all", query: "", openPhases: [], sort: "time", unfolded: new Set() });
    const noop = () => undefined;
    const roster = (peekId: string | null) => atNow(NOW, () => renderWith(panelStore(), createElement(Roster, {
      run, entries, focusId: "c-cf", peekId, finale: false, stale: false, readOnly: false, sort: "time", confirm: null,
      onSort: noop, onFocus: noop, onInspect: noop, onTogglePhase: noop, onUnfold: noop, onAction: noop, onConfirm: noop, onReview: noop, register: noop,
    })));
    assert.doesNotMatch(roster(null), /swarm-peek/, "nothing until Space asks");
    const markup = roster("c-cf");
    assert.equal((markup.match(/class="swarm-peek"/g) ?? []).length, 1, "one peek, under one row");
    const from = markup.indexOf('id="swarm-row-c-cf"');
    const peekAt = markup.indexOf('<div class="swarm-peek"', from);
    assert.ok(peekAt > from && peekAt < markup.indexOf('role="row"', from), "the peek is the focused row's own child, positioned under it");
    assert.match(rowTag(markup, "c-cf"), /tabindex="0" aria-selected="true"/, "the row keeps the tab stop");
    const peek = markup.slice(peekAt, markup.indexOf("close</span>", peekAt));
    assert.match(peek, /^<div class="swarm-peek" role="dialog" aria-modal="false" aria-label="design:conflict-ledger: Design · attempt 2 · /);
    assert.doesNotMatch(peek, /tabindex|<button|<a /, "nothing in it takes focus");
    assert.match(textOf(peek), /Failed/);
    assert.match(textOf(peek), /Design the conflict ledger: define how two devices reconcile\./, "the task from the plan");
    assert.match(textOf(peek), /Attempts 2/);
    assert.match(textOf(peek), /Enter open Esc/);
  });

  it("reads as last known when the feed is not live, with every clock frozen at the last event seen", () => {
    const markup = renderPanel({ state: { connection: "lost" } });
    assert.match(textOf(markup), /^offline-sync-research-design Last known/);
    assert.match(textOf(markup), /Last known · 6 of 10 done · Judge/);
    // The last revision seen was the usage report at 40m 23s, 40m 19s into the run.
    assert.match(textOf(kpi(markup, "elapsed")), /^Last known 40m 19s at /);
    assert.match(markup, /last known 40m 19s/);
    assert.doesNotMatch(markup, /Stop run/);
    assert.doesNotMatch(textOf(markup), /No update for/, "nothing is promoted to no update while stale");
    assert.match(textOf(markup), /Working · no update since it started/, "the fact stays");
  });

  it("shows the run, background tasks and subagents of the thread, and an empty state when there is nothing", () => {
    const tasks = renderPanel({ fold: applyEvents(emptyFold(), [TASK]) });
    assert.match(textOf(tasks), /^Agents and tasks/);
    assert.deepEqual(rows(tasks), ["phase:Background", "task-1"]);
    assert.match(rowTag(tasks, "task-1"), /aria-label="npm run docs:build, Working, You sent it to the background, 2m 16s"/);
    const quiet = renderPanel({ fold: applyEvents(emptyFold(), [{ ...TASK, at: S(30, 0) }]) });
    assert.match(rowTag(quiet, "task-1"), /aria-label="npm run docs:build, No output for 11m 16s, 11m 16s"/, "four minutes without output is said as such");
    assert.doesNotMatch(tasks, /data-kpi/);
    const both = renderPanel({ fold: lanternFold(NOW, [TASK]) });
    assert.deepEqual(rows(both).slice(-2), ["phase:Background", "task-1"]);
    const empty = renderPanel({ fold: emptyFold() });
    assert.match(textOf(empty), /No agents in this thread A workflow's agents and background tasks appear here when Muse starts them\./);
    const loading = renderPanel({ fold: emptyFold(), thread: { load: "loading" } });
    assert.match(textOf(loading), /Loading agent activity/);
  });

  it("picks the newest live run, or the newest run when none is live", () => {
    const live = { itemId: "a", status: "running" } as RunVM;
    const old = { itemId: "b", status: "finished" } as RunVM;
    assert.equal(panelRun([live, old]), live);
    assert.equal(panelRun([old]), old);
    assert.equal(panelRun([]), null);
  });
});
