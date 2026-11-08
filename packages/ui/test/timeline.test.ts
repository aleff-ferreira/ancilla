import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CANVAS_AT, Timeline, laneBox, legendStates, timelineLabel, timelineLayout, type Lane, type TimelineLayout } from "../src/components/crew/Timeline.js";
import { crewView, type RunVM } from "../src/model/crew.js";
import { Feed, NOW, S, SESSION, approvalAt, atNow, fold, lantern, lanternDone, lanternRun, launch } from "./crew-panel-fixture.js";

const WIDTH = 488;

function lane(layout: TimelineLayout, name: string): Lane {
  for (const phase of layout.phases) {
    for (const row of phase.rows) if (row.kind === "lane" && row.name === name) return row;
  }
  throw new Error(`no lane ${name}`);
}

function layoutOf(run: RunVM): TimelineLayout {
  const layout = timelineLayout(run, WIDTH);
  assert.ok(layout, "the run has a start, so there is a chart");
  return layout;
}

function render(run: RunVM, extra: Partial<Parameters<typeof Timeline>[0]> = {}): string {
  return atNow(run.clockAt, () => renderToStaticMarkup(createElement(Timeline, { run, width: WIDTH, collapsed: false, selectedId: null, onLane: () => undefined, onToggle: () => undefined, ...extra })));
}

/** A run with `n` agents in one phase, all working, for the canvas threshold. */
function bigRun(n: number): RunVM {
  const feed = new Feed();
  for (let i = 0; i < n; i += 1) feed.schedule(`b-${i}`, `audit:agent-${i}`, S(0, 1));
  for (let i = 0; i < n; i += 1) feed.set(`b-${i}`, { status: "started" }, S(0, 2));
  const f = fold([launch(null), ...feed.events], S(5, 0));
  const run = crewView(f, SESSION, S(5, 0)).runs[0];
  if (!run) throw new Error("no run");
  return run;
}

describe("Timeline layout", () => {
  it("lays one lane per agent under its phase, in run order, with room to breathe", () => {
    const layout = layoutOf(lanternRun());
    assert.equal(layout.lanes, 10);
    assert.deepEqual(layout.phases.map((phase) => [phase.name, phase.rows.length]), [["Research", 4], ["Design", 3], ["Judge", 2], ["Synthesize", 1]]);
    assert.equal(layout.gutter, 74);
    assert.equal(layout.laneHeight, 10);
    assert.equal(layout.axisHeight, 22);
    assert.equal(layout.width, WIDTH);
    const research = layout.phases[0]!;
    assert.equal(research.y, 30, "the first lane sits 8 px under the axis");
    assert.equal(research.height, 4 * 14 - 4, "10 px lanes with 4 px gaps");
    assert.equal(layout.phases[1]!.y, research.y + research.height + 14, "14 px between phases");
    assert.equal(layout.height, layout.phases[3]!.y + layout.phases[3]!.height + 4);
    assert.ok(layout.phases.every((phase) => phase.rows.every((row) => row.kind === "lane" && !row.packed && !row.slim)), "a workflow's agents each keep a lane of their own");
  });

  it("scales the plot so now sits a tenth short of the right edge, and drops a tick label that would touch it", () => {
    const layout = layoutOf(lanternRun());
    const plot = WIDTH - 74;
    const total = NOW - S(0, 4);
    assert.ok(Math.abs(layout.endX - (74 + plot / 1.1)) < 1e-6);
    assert.equal(layout.endLabel, "now 41m 12s");
    assert.equal(layout.finished, false);
    assert.deepEqual(layout.ticks.map((tick) => tick.label), ["0", "10m", "20m", "30m", null], "40m is within 84 px of now");
    assert.ok(Math.abs((layout.ticks[1]!.x - 74) / layout.scale - 10 * 60_000) < 1e-6, "ticks are ten minutes apart");
    assert.ok(total > 0);
  });

  it("draws a finished agent as one done segment and a retried failure as hatched segments with crosses on one lane", () => {
    const layout = layoutOf(lanternRun());
    const done = lane(layout, "research:field-notes");
    assert.deepEqual(done.segments.map((segment) => [segment.fill, segment.cross]), [["done", false]]);
    assert.equal(done.live, false);
    const failed = lane(layout, "design:conflict-ledger");
    assert.deepEqual(failed.segments.map((segment) => [segment.fill, segment.cross]), [["fail", true], ["fail", true]]);
    const px = (ms: number) => 74 + (ms - S(0, 4)) * layout.scale;
    assert.ok(Math.abs(failed.segments[0]!.x0 - px(S(12, 12))) < 1e-6);
    assert.ok(Math.abs(failed.segments[0]!.x1 - px(S(14, 20))) < 1e-6);
    assert.ok(Math.abs(failed.segments[1]!.x0 - px(S(14, 22))) < 1e-6);
    assert.ok(Math.abs(failed.segments[1]!.x1 - px(S(18, 13))) < 1e-6);
  });

  it("grows a working lane to now, and hatches a no-update lane from where the silence became remarkable", () => {
    const layout = layoutOf(lanternRun());
    const finishing = lane(layout, "judge:correctness");
    assert.deepEqual(finishing.segments.map((segment) => segment.fill), ["work"]);
    assert.equal(finishing.segments[0]!.x1, layout.endX);
    assert.equal(finishing.live, true);
    assert.equal(finishing.quiet, null);
    const quiet = lane(layout, "judge:perf");
    assert.equal(quiet.state, "no-update");
    assert.ok(quiet.quiet, "the tail is hatched");
    const px = (ms: number) => 74 + (ms - S(0, 4)) * layout.scale;
    assert.ok(Math.abs(quiet.quiet!.x0 - px(S(25, 14) + 760_000)) < 1e-6, "accent up to the longest finished sibling's duration, then the hatch");
    assert.equal(quiet.quiet!.x1, layout.endX);
  });

  it("gives a planned agent a dashed placeholder after now with the note before it", () => {
    const layout = layoutOf(lanternRun());
    const planned = lane(layout, "synthesize:report");
    assert.equal(planned.placeholder, "planned");
    assert.deepEqual(planned.segments, []);
    assert.deepEqual(layout.plannedNote, { x: layout.endX - 6, y: planned.y + 9 });
  });

  it("marks a run-level request on the axis at the time it was first seen", () => {
    const layout = layoutOf(lanternRun(NOW, [approvalAt(S(39, 36))]));
    assert.equal(layout.markers.length, 1);
    assert.equal(layout.markers[0]!.kind, "approval");
    assert.ok(Math.abs(layout.markers[0]!.x - (74 + (S(39, 36) - S(0, 4)) * layout.scale)) < 1e-6);
    assert.deepEqual(layoutOf(lanternRun()).markers, []);
  });

  it("replaces the now line with a finished line once the run ended, and keeps every attempt on its lane", () => {
    const layout = layoutOf(lanternRun(S(46, 0), [], lanternDone()));
    assert.equal(layout.finished, true);
    assert.equal(layout.endLabel, "finished 45m 06s");
    const plot = WIDTH - 74;
    assert.ok(Math.abs(layout.endX - (74 + plot / 1.02)) < 1e-6, "a finished chart keeps two percent of headroom");
    const retried = lane(layout, "design:conflict-ledger");
    assert.deepEqual(retried.segments.map((segment) => [segment.fill, segment.cross]), [["fail", true], ["fail", true], ["done", false]]);
    assert.equal(retried.live, false);
    assert.equal(layout.plannedNote, null, "nothing is planned once the run is over");
    assert.equal(layout.lanes, 10);
  });

  it("freezes a stale run at its last known clock and takes the accent off its live lanes", () => {
    const layout = layoutOf(lanternRun(NOW, [], lantern(), { stale: true, staleAt: NOW }));
    assert.equal(layout.stale, true);
    assert.equal(layout.endLabel, "last known 41m 12s");
    assert.deepEqual(layout.ticks.map((tick) => tick.label), ["0", "10m", "20m", null, null], "a longer end label clears the 30m tick too");
    assert.deepEqual(lane(layout, "judge:correctness").segments.map((segment) => segment.fill), ["stale"]);
    assert.equal(lane(layout, "judge:perf").quiet, null, "nothing is promoted to no update while stale");
  });

  it("has no chart before the run's start is known", () => {
    const feed = new Feed();
    const run = crewView(fold([launch(null)]), SESSION, NOW).runs[0];
    assert.equal(run, undefined);
    void feed;
    const partial = { ...lanternRun(), startedAt: null } as RunVM;
    assert.equal(timelineLayout(partial, WIDTH), null);
    assert.match(render(partial), /Times are not loaded for this run/);
  });

  it("spreads the ticks out for a run that goes on for hours", () => {
    const feed = new Feed();
    feed.schedule("a", "audit:a", S(0, 0)).set("a", { status: "started" }, S(0, 1));
    const run = crewView(fold([launch(null), ...feed.events], S(200, 0)), SESSION, S(200, 0)).runs[0]!;
    const layout = layoutOf(run);
    assert.deepEqual(layout.ticks.map((tick) => tick.label).slice(0, 4), ["0", "30m", "60m", "90m"]);
  });
});

const TURN_START = Date.UTC(2026, 8, 28, 12);
const turnSession = { sessionId: "thread", title: "Ordinary prompt", cwd: "/work", titleSource: "user", turnCount: 1, modelId: "muse", origin: "ancilla", archived: false, createdAt: new Date(TURN_START).toISOString(), activityAt: new Date(TURN_START).toISOString(), settled: false, settledAt: null, unsettledAt: null, sandboxDisabled: false, accountId: null, live: null } as const;

/** A prompt's run: tool calls given as [id, start, end], an end of null for one still going. */
function turnRun(calls: readonly (readonly [string, number, number | null])[], now: number): RunVM {
  const events = [{ method: "turn/started", at: TURN_START, params: { turnId: "t1" } } as const];
  const item = (id: string, status: string, revision: number) => ({ itemId: id, kind: "toolCall", tool: "bash", args: JSON.stringify({ command: `run ${id}` }), turnId: "t1", status, revision });
  const wire = calls.flatMap(([id, from, to]) => [
    { method: "item/started", at: TURN_START + from, params: { item: item(id, "inProgress", 1) } },
    ...(to === null ? [] : [{ method: "item/completed", at: TURN_START + to, params: { item: { ...item(id, "completed", 2), exitCode: 0 } } }]),
  ]);
  const run = crewView(fold([...events, ...wire].sort((a, b) => a.at - b.at) as never, TURN_START + now), turnSession as never, TURN_START + now).runs[0];
  if (!run) throw new Error("no run");
  return run;
}

describe("Timeline of a prompt", () => {
  it("packs calls that did not overlap into one row, and puts a call that did on the next", () => {
    // a and b follow one another; c runs while b does, so it cannot share b's row.
    const run = turnRun([["a", 1_000, 3_000], ["b", 4_000, 9_000], ["c", 5_000, 7_000], ["d", 10_000, 12_000]], 14_000);
    const layout = layoutOf(run);
    const tools = layout.phases.find((phase) => phase.name === "Tools")!;
    const rowOf = (name: string) => (tools.rows.find((row) => row.kind === "lane" && row.name === `run ${name}`) as Lane).y;
    assert.equal(rowOf("a"), rowOf("b"), "b starts after a ended, so they share a row");
    assert.equal(rowOf("d"), rowOf("a"), "so does d, which starts after b ended");
    assert.equal(rowOf("c"), rowOf("a") + 14, "c overlaps b and takes the row under it");
    assert.equal(tools.height, 2 * 14 - 4, "two rows, not four lanes");
    assert.equal(layout.lanes, 5, "the lead and four calls are all lanes still");
    assert.ok((tools.rows as Lane[]).every((row) => row.packed), "each knows its row is shared, so a click takes only its own capsule");
  });

  it("draws the lead as a thin thread under the calls, centred in its row", () => {
    const layout = layoutOf(turnRun([["a", 1_000, 3_000], ["b", 4_000, null]], 6_000));
    const lead = layout.phases.find((phase) => phase.name === "Lead")!.rows[0] as Lane;
    assert.equal(lead.slim, true);
    assert.deepEqual(laneBox(layout.laneHeight, lead), { y: lead.y + 3, h: 4 });
    assert.deepEqual(laneBox(layout.laneHeight, { y: 50, slim: false }), { y: 50, h: 10 });
    const markup = render(turnRun([["a", 1_000, 3_000], ["b", 4_000, null]], 6_000));
    assert.match(markup, /<rect class="crew-lane-seg" x="[\d.]+" y="[\d.]+" width="[\d.]+" height="4" rx="2"/, "the thread is four pixels tall");
  });

  it("keeps one lane per call when a placeholder has no time to place it by", () => {
    const run = turnRun([["a", 1_000, 3_000]], 5_000);
    const tools = layoutOf(run).phases.find((phase) => phase.name === "Tools")!;
    assert.equal((tools.rows as Lane[]).length, 1);
    assert.equal((tools.rows[0] as Lane).packed, false, "a single call has nothing to share a row with");
  });

  it("labels a short run's axis in seconds and minutes it can read, not with only a zero", () => {
    const short = layoutOf(turnRun([["a", 1_000, 3_000]], 38_000));
    assert.deepEqual(short.ticks.map((tick) => tick.label).slice(0, 4), ["0", "10s", "20s", null], "the last label would touch now");
    const minutes = layoutOf(turnRun([["a", 1_000, 3_000]], 5 * 60_000 + 2_000));
    assert.deepEqual(minutes.ticks.map((tick) => tick.label).slice(0, 6), ["0", "1m", "2m", "3m", null, null], "the 4m and 5m labels would touch the now label");
  });

  it("keys only the states it draws", () => {
    const layout = layoutOf(turnRun([["a", 1_000, 3_000], ["b", 4_000, null]], 6_000));
    assert.deepEqual(legendStates(layout), ["done", "work"]);
    const markup = render(turnRun([["a", 1_000, 3_000], ["b", 4_000, null]], 6_000));
    assert.ok(markup.includes("</i>Done</span>") && markup.includes("</i>Working</span>"));
    for (const word of ["No update", "Waiting on you", "Failed"]) assert.ok(!markup.includes(`</i>${word}</span>`), `${word} is not drawn, so it is not keyed`);
    assert.deepEqual(legendStates(layoutOf(lanternRun(NOW, [approvalAt(S(39, 36))]))), ["done", "work", "quiet", "need", "fail"]);
  });
});

describe("Timeline markup", () => {
  it("is an image with the roster as its table, one group per lane and the legend, and no key hint", () => {
    const run = lanternRun(NOW, [approvalAt(S(39, 36))]);
    const markup = render(run);
    assert.equal(timelineLabel(run), "Timeline of 10 agents over 41m 12s");
    assert.match(markup, /<svg width="488" height="\d+(\.\d+)?" viewBox="0 0 488 [\d.]+" role="img" aria-label="Timeline of 10 agents over 41m 12s"/);
    assert.equal((markup.match(/data-lane="/g) ?? []).length, 10);
    assert.equal((markup.match(/data-quiet=""/g) ?? []).length, 1, "one hatched tail");
    assert.equal((markup.match(/data-marker="approval"/g) ?? []).length, 1);
    assert.match(markup, /planned, not scheduled yet/);
    assert.match(markup, /now 41m 12s/);
    assert.match(markup, /data-end-line=""/);
    for (const word of ["Done", "Working", "No update", "Waiting on you", "Failed"]) assert.ok(markup.includes(`</i>${word}</span>`), word);
    assert.doesNotMatch(markup, /<kbd/, "the t key is named by the panel's menu, not by the chart's head");
    assert.match(markup, /<title>judge:perf · No update for 16m 02s<\/title>/);
    assert.doesNotMatch(markup, /from loaded history/);
  });

  it("says when the times come from loaded history", () => {
    const run = { ...lanternRun(), partialHistory: true } as RunVM;
    const markup = render(run);
    assert.match(markup, /from loaded history/);
    assert.match(markup, /aria-label="Timeline of 10 agents over 41m 12s, from loaded history"/);
  });

  it("highlights the inspected lane and folds away when collapsed", () => {
    const run = lanternRun();
    const selected = render(run, { selectedId: run.agents.find((agent) => agent.name === "judge:perf")!.id });
    assert.match(selected, /<rect x="70" y="[\d.]+" width="418" height="16" rx="4" fill="var\(--bg-active\)"/);
    const collapsed = render(run, { collapsed: true });
    assert.match(collapsed, /data-collapsed="true"/);
    assert.doesNotMatch(collapsed, /role="img"/);
    assert.match(collapsed, /aria-expanded="false"/);
  });

  it("paints on a canvas past 200 lanes, with the roster's closed phases as density bands", () => {
    const run = bigRun(CANVAS_AT + 5);
    const markup = render(run);
    assert.match(markup, /<canvas role="img" aria-label="Timeline of 205 agents over 4m 59s"/);
    assert.doesNotMatch(markup, /<svg width="488"/);
    const banded = timelineLayout(run, WIDTH, { bands: new Set(["Audit"]) });
    assert.ok(banded);
    assert.equal(banded.phases[0]!.rows.length, 1);
    assert.equal(banded.phases[0]!.rows[0]!.kind, "band");
    assert.equal(banded.lanes, 0);
    assert.equal(timelineLayout(bigRun(CANVAS_AT), WIDTH)!.lanes, CANVAS_AT, "exactly 200 lanes stay on SVG");
    assert.match(render(bigRun(CANVAS_AT)), /<svg width="488"/);
  });
});
