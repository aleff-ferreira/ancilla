import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CANVAS_AT,
  Timeline,
  laneBox,
  legendStates,
  timelineLabel,
  timelineLayout,
  type Lane,
  type TimelineLayout,
} from "../src/components/crew/Timeline.js";
import { crewView, type RunVM } from "../src/model/crew.js";
import {
  Feed,
  NOW,
  S,
  SESSION,
  approvalAt,
  atNow,
  fold,
  lantern,
  lanternDone,
  lanternRun,
  launch,
} from "./crew-panel-fixture.js";

const DEFAULT_VIEWPORT_WIDTH = 488;

function lookupLane(layout: TimelineLayout, agentName: string): Lane {
  for (const phase of layout.phases) {
    for (const row of phase.rows) {
      if (row.kind === "lane" && row.name === agentName) {
        return row;
      }
    }
  }
  throw new Error(`Lane not found for agent: ${agentName}`);
}

function buildLayoutSnapshot(run: RunVM): TimelineLayout {
  const chartLayout = timelineLayout(run, DEFAULT_VIEWPORT_WIDTH);
  assert.ok(chartLayout, "Timeline layout must exist for an initialized run");
  return chartLayout;
}

function renderTimelineHtml(
  run: RunVM,
  extraProps: Partial<Parameters<typeof Timeline>[0]> = {},
): string {
  return atNow(run.clockAt, () => {
    const timelineProps = {
      run,
      width: DEFAULT_VIEWPORT_WIDTH,
      collapsed: false,
      selectedId: null,
      onLane: () => undefined,
      onToggle: () => undefined,
      ...extraProps,
    };
    return renderToStaticMarkup(createElement(Timeline, timelineProps));
  });
}

function createLargeScaleRun(agentCount: number): RunVM {
  const feed = new Feed();
  for (let idx = 0; idx < agentCount; idx += 1) {
    feed.schedule(`b-${idx}`, `audit:agent-${idx}`, S(0, 1));
  }
  for (let idx = 0; idx < agentCount; idx += 1) {
    feed.set(`b-${idx}`, { status: "started" }, S(0, 2));
  }
  const stream = fold([launch(null), ...feed.events], S(5, 0));
  const runVM = crewView(stream, SESSION, S(5, 0)).runs[0];
  if (!runVM) {
    throw new Error("Failed to construct large scale run");
  }
  return runVM;
}

const PROMPT_TURN_EPOCH = Date.UTC(2026, 8, 28, 12);
const PROMPT_SESSION_BLUEPRINT = Object.freeze({
  sessionId: "thread",
  title: "Ordinary prompt",
  cwd: "/work",
  titleSource: "user" as const,
  turnCount: 1,
  modelId: "muse",
  origin: "ancilla" as const,
  archived: false,
  createdAt: new Date(PROMPT_TURN_EPOCH).toISOString(),
  activityAt: new Date(PROMPT_TURN_EPOCH).toISOString(),
  settled: false,
  settledAt: null,
  unsettledAt: null,
  sandboxDisabled: false,
  accountId: null,
  live: null,
});

function createPromptTurnRun(
  toolCalls: readonly (readonly [string, number, number | null])[],
  elapsedMs: number,
): RunVM {
  const startTurnEvent = {
    method: "turn/started" as const,
    at: PROMPT_TURN_EPOCH,
    params: { turnId: "t1" },
  };

  const createItemPayload = (callId: string, itemStatus: string, rev: number) => ({
    itemId: callId,
    kind: "toolCall" as const,
    tool: "bash",
    args: JSON.stringify({ command: `run ${callId}` }),
    turnId: "t1",
    status: itemStatus,
    revision: rev,
  });

  const wireEvents = toolCalls.flatMap(([callId, startOffset, finishOffset]) => {
    const initialStartedEvent = {
      method: "item/started" as const,
      at: PROMPT_TURN_EPOCH + startOffset,
      params: { item: createItemPayload(callId, "inProgress", 1) },
    };
    if (finishOffset === null) {
      return [initialStartedEvent];
    }
    const completedEvent = {
      method: "item/completed" as const,
      at: PROMPT_TURN_EPOCH + finishOffset,
      params: {
        item: {
          ...createItemPayload(callId, "completed", 2),
          exitCode: 0,
        },
      },
    };
    return [initialStartedEvent, completedEvent];
  });

  const orderedEvents = [startTurnEvent, ...wireEvents].sort((evtA, evtB) => evtA.at - evtB.at);
  const evaluationClock = PROMPT_TURN_EPOCH + elapsedMs;
  const threadStateFold = fold(orderedEvents as never, evaluationClock);
  const resolvedRun = crewView(threadStateFold, PROMPT_SESSION_BLUEPRINT as never, evaluationClock).runs[0];
  if (!resolvedRun) {
    throw new Error("Failed to construct prompt turn run");
  }
  return resolvedRun;
}

describe("Timeline coordinate geometry and phase hierarchy", () => {
  it("structures dedicated lanes sequentially per agent across phases with standard vertical gaps", () => {
    const layout = buildLayoutSnapshot(lanternRun());
    assert.strictEqual(layout.lanes, 10);

    const phaseRowSummary = layout.phases.map((p) => [p.name, p.rows.length]);
    assert.deepStrictEqual(phaseRowSummary, [
      ["Research", 4],
      ["Design", 3],
      ["Judge", 2],
      ["Synthesize", 1],
    ]);

    assert.strictEqual(layout.gutter, 74);
    assert.strictEqual(layout.laneHeight, 10);
    assert.strictEqual(layout.axisHeight, 22);
    assert.strictEqual(layout.width, DEFAULT_VIEWPORT_WIDTH);

    const firstPhase = layout.phases[0]!;
    assert.strictEqual(firstPhase.y, 30);
    assert.strictEqual(firstPhase.height, 4 * 14 - 4);

    const secondPhase = layout.phases[1]!;
    const expectedSecondPhaseY = firstPhase.y + firstPhase.height + 14;
    assert.strictEqual(secondPhase.y, expectedSecondPhaseY);

    const finalPhase = layout.phases[3]!;
    assert.strictEqual(layout.height, finalPhase.y + finalPhase.height + 4);

    for (const phase of layout.phases) {
      for (const row of phase.rows) {
        assert.strictEqual(row.kind, "lane");
        assert.strictEqual(row.packed, false);
        assert.strictEqual(row.slim, false);
      }
    }
  });

  it("scales temporal axis leaving right-edge headroom and omits tick labels colliding with now", () => {
    const layout = buildLayoutSnapshot(lanternRun());
    const availablePlotWidth = DEFAULT_VIEWPORT_WIDTH - 74;
    const expectedEndX = 74 + availablePlotWidth / 1.1;

    assert.ok(Math.abs(layout.endX - expectedEndX) < 1e-6);
    assert.strictEqual(layout.endLabel, "now 41m 12s");
    assert.strictEqual(layout.finished, false);

    const extractedTickLabels = layout.ticks.map((t) => t.label);
    assert.deepStrictEqual(extractedTickLabels, ["0", "10m", "20m", "30m", null]);

    const secondTick = layout.ticks[1]!;
    const tickIntervalMs = (secondTick.x - 74) / layout.scale;
    assert.ok(Math.abs(tickIntervalMs - 10 * 60_000) < 1e-6);

    const totalDurationMs = NOW - S(0, 4);
    assert.ok(totalDurationMs > 0);
  });

  it("renders completed agents as solid done segments and failed retries as hatched crossed segments", () => {
    const layout = buildLayoutSnapshot(lanternRun());

    const doneLane = lookupLane(layout, "research:field-notes");
    assert.deepStrictEqual(
      doneLane.segments.map((seg) => [seg.fill, seg.cross]),
      [["done", false]],
    );
    assert.strictEqual(doneLane.live, false);

    const failedLane = lookupLane(layout, "design:conflict-ledger");
    assert.deepStrictEqual(
      failedLane.segments.map((seg) => [seg.fill, seg.cross]),
      [
        ["fail", true],
        ["fail", true],
      ],
    );

    const computeX = (timestampMs: number) => 74 + (timestampMs - S(0, 4)) * layout.scale;
    assert.ok(Math.abs(failedLane.segments[0]!.x0 - computeX(S(12, 12))) < 1e-6);
    assert.ok(Math.abs(failedLane.segments[0]!.x1 - computeX(S(14, 20))) < 1e-6);
    assert.ok(Math.abs(failedLane.segments[1]!.x0 - computeX(S(14, 22))) < 1e-6);
    assert.ok(Math.abs(failedLane.segments[1]!.x1 - computeX(S(18, 13))) < 1e-6);
  });

  it("extends in-progress lane to current clock and shades quiet lanes past peer completion duration", () => {
    const layout = buildLayoutSnapshot(lanternRun());

    const liveLane = lookupLane(layout, "judge:correctness");
    assert.deepStrictEqual(
      liveLane.segments.map((seg) => seg.fill),
      ["work"],
    );
    assert.strictEqual(liveLane.segments[0]!.x1, layout.endX);
    assert.strictEqual(liveLane.live, true);
    assert.strictEqual(liveLane.quiet, null);

    const quietLane = lookupLane(layout, "judge:perf");
    assert.strictEqual(quietLane.state, "no-update");
    assert.ok(quietLane.quiet !== null);

    const computeX = (timestampMs: number) => 74 + (timestampMs - S(0, 4)) * layout.scale;
    const expectedQuietStartX = computeX(S(25, 14) + 760_000);
    assert.ok(Math.abs(quietLane.quiet!.x0 - expectedQuietStartX) < 1e-6);
    assert.strictEqual(quietLane.quiet!.x1, layout.endX);
  });

  it("renders planned agents as dashed placeholders beyond now with corresponding planned notes", () => {
    const layout = buildLayoutSnapshot(lanternRun());
    const plannedLane = lookupLane(layout, "synthesize:report");

    assert.strictEqual(plannedLane.placeholder, "planned");
    assert.strictEqual(plannedLane.segments.length, 0);

    const expectedNoteCoordinates = {
      x: layout.endX - 6,
      y: plannedLane.y + 9,
    };
    assert.deepStrictEqual(layout.plannedNote, expectedNoteCoordinates);
  });

  it("projects run-level approval requests directly onto the time axis", () => {
    const approvalTimestamp = S(39, 36);
    const layoutWithApproval = buildLayoutSnapshot(lanternRun(NOW, [approvalAt(approvalTimestamp)]));

    assert.strictEqual(layoutWithApproval.markers.length, 1);
    assert.strictEqual(layoutWithApproval.markers[0]!.kind, "approval");

    const expectedMarkerX = 74 + (approvalTimestamp - S(0, 4)) * layoutWithApproval.scale;
    assert.ok(Math.abs(layoutWithApproval.markers[0]!.x - expectedMarkerX) < 1e-6);

    const layoutWithoutApproval = buildLayoutSnapshot(lanternRun());
    assert.strictEqual(layoutWithoutApproval.markers.length, 0);
  });

  it("transitions active now axis to finished status once run completes preserving retry history", () => {
    const completedLayout = buildLayoutSnapshot(lanternRun(S(46, 0), [], lanternDone()));
    assert.strictEqual(completedLayout.finished, true);
    assert.strictEqual(completedLayout.endLabel, "finished 45m 06s");

    const plotWidth = DEFAULT_VIEWPORT_WIDTH - 74;
    const expectedCompletedEndX = 74 + plotWidth / 1.02;
    assert.ok(Math.abs(completedLayout.endX - expectedCompletedEndX) < 1e-6);

    const retriedLane = lookupLane(completedLayout, "design:conflict-ledger");
    const segmentOutcomes = retriedLane.segments.map((seg) => [seg.fill, seg.cross]);
    assert.deepStrictEqual(segmentOutcomes, [
      ["fail", true],
      ["fail", true],
      ["done", false],
    ]);
    assert.strictEqual(retriedLane.live, false);
    assert.strictEqual(completedLayout.plannedNote, null);
    assert.strictEqual(completedLayout.lanes, 10);
  });

  it("freezes timeline rendering at stale timestamp and removes live highlighting", () => {
    const staleLayout = buildLayoutSnapshot(lanternRun(NOW, [], lantern(), { stale: true, staleAt: NOW }));
    assert.strictEqual(staleLayout.stale, true);
    assert.strictEqual(staleLayout.endLabel, "last known 41m 12s");

    const staleTickLabels = staleLayout.ticks.map((t) => t.label);
    assert.deepStrictEqual(staleTickLabels, ["0", "10m", "20m", null, null]);

    const correctnessLane = lookupLane(staleLayout, "judge:correctness");
    assert.deepStrictEqual(
      correctnessLane.segments.map((seg) => seg.fill),
      ["stale"],
    );

    const perfLane = lookupLane(staleLayout, "judge:perf");
    assert.strictEqual(perfLane.quiet, null);
  });

  it("yields empty chart state when start timestamp is absent", () => {
    const emptyFeed = new Feed();
    const unstartedRun = crewView(fold([launch(null)]), SESSION, NOW).runs[0];
    assert.strictEqual(unstartedRun, undefined);
    void emptyFeed;

    const partialRun = { ...lanternRun(), startedAt: null } as RunVM;
    assert.strictEqual(timelineLayout(partialRun, DEFAULT_VIEWPORT_WIDTH), null);

    const htmlOutput = renderTimelineHtml(partialRun);
    assert.match(htmlOutput, /Times are not loaded for this run/);
  });

  it("adjusts axis tick intervals to 30-minute steps for extended multi-hour runs", () => {
    const longFeed = new Feed();
    longFeed.schedule("a", "audit:a", S(0, 0)).set("a", { status: "started" }, S(0, 1));

    const extendedRun = crewView(fold([launch(null), ...longFeed.events], S(200, 0)), SESSION, S(200, 0)).runs[0]!;
    const extendedLayout = buildLayoutSnapshot(extendedRun);

    const initialFourTicks = extendedLayout.ticks.map((t) => t.label).slice(0, 4);
    assert.deepStrictEqual(initialFourTicks, ["0", "30m", "60m", "90m"]);
  });
});

describe("Timeline prompt tool packing and thread representation", () => {
  it("packs consecutive non-overlapping tool executions into shared row and wraps overlaps", () => {
    const executionSchedule = [
      ["a", 1_000, 3_000],
      ["b", 4_000, 9_000],
      ["c", 5_000, 7_000],
      ["d", 10_000, 12_000],
    ] as const;

    const promptRun = createPromptTurnRun(executionSchedule, 14_000);
    const layout = buildLayoutSnapshot(promptRun);

    const toolsPhase = layout.phases.find((p) => p.name === "Tools")!;
    const locateRowY = (taskTag: string) => {
      const match = toolsPhase.rows.find((r) => r.kind === "lane" && r.name === `run ${taskTag}`);
      return (match as Lane).y;
    };

    const rowYA = locateRowY("a");
    const rowYB = locateRowY("b");
    const rowYD = locateRowY("d");
    const rowYC = locateRowY("c");

    assert.strictEqual(rowYA, rowYB);
    assert.strictEqual(rowYD, rowYA);
    assert.strictEqual(rowYC, rowYA + 14);

    assert.strictEqual(toolsPhase.height, 2 * 14 - 4);
    assert.strictEqual(layout.lanes, 5);

    for (const row of toolsPhase.rows as Lane[]) {
      assert.strictEqual(row.packed, true);
    }
  });

  it("renders lead agent as centered four-pixel thread beneath tool calls", () => {
    const executionSchedule = [
      ["a", 1_000, 3_000],
      ["b", 4_000, null],
    ] as const;

    const promptRun = createPromptTurnRun(executionSchedule, 6_000);
    const layout = buildLayoutSnapshot(promptRun);

    const leadLane = layout.phases.find((p) => p.name === "Lead")!.rows[0] as Lane;
    assert.strictEqual(leadLane.slim, true);

    const calculatedLeadBox = laneBox(layout.laneHeight, leadLane);
    assert.deepStrictEqual(calculatedLeadBox, { y: leadLane.y + 3, h: 4 });

    const standardBox = laneBox(layout.laneHeight, { y: 50, slim: false });
    assert.deepStrictEqual(standardBox, { y: 50, h: 10 });

    const htmlOutput = renderTimelineHtml(promptRun);
    assert.match(
      htmlOutput,
      /<rect class="crew-lane-seg" x="[\d.]+" y="[\d.]+" width="[\d.]+" height="4" rx="2"/,
    );
  });

  it("maintains standalone row configuration when single invocation has no peers", () => {
    const promptRun = createPromptTurnRun([["a", 1_000, 3_000]], 5_000);
    const toolsPhase = buildLayoutSnapshot(promptRun).phases.find((p) => p.name === "Tools")!;

    assert.strictEqual((toolsPhase.rows as Lane[]).length, 1);
    assert.strictEqual((toolsPhase.rows[0] as Lane).packed, false);
  });

  it("scales temporal axis intervals appropriately for compact short-duration prompts", () => {
    const briefRun = buildLayoutSnapshot(createPromptTurnRun([["a", 1_000, 3_000]], 38_000));
    const briefTicks = briefRun.ticks.map((t) => t.label).slice(0, 4);
    assert.deepStrictEqual(briefTicks, ["0", "10s", "20s", null]);

    const mediumRun = buildLayoutSnapshot(createPromptTurnRun([["a", 1_000, 3_000]], 5 * 60_000 + 2_000));
    const mediumTicks = mediumRun.ticks.map((t) => t.label).slice(0, 6);
    assert.deepStrictEqual(mediumTicks, ["0", "1m", "2m", "3m", null, null]);
  });

  it("restricts legend badges strictly to visual states currently drawn in chart", () => {
    const promptRun = createPromptTurnRun([["a", 1_000, 3_000], ["b", 4_000, null]], 6_000);
    const promptLayout = buildLayoutSnapshot(promptRun);

    assert.deepStrictEqual(legendStates(promptLayout), ["done", "work"]);

    const markup = renderTimelineHtml(promptRun);
    assert.ok(markup.includes("</i>Done</span>") && markup.includes("</i>Working</span>"));

    const unrepresentedBadges = ["No update", "Waiting on you", "Failed"];
    for (const badgeLabel of unrepresentedBadges) {
      assert.ok(!markup.includes(`</i>${badgeLabel}</span>`));
    }

    const fullLanternLayout = buildLayoutSnapshot(lanternRun(NOW, [approvalAt(S(39, 36))]));
    assert.deepStrictEqual(legendStates(fullLanternLayout), ["done", "work", "quiet", "need", "fail"]);
  });
});

describe("Timeline DOM markup and high-density canvas rendering", () => {
  it("structures accessible SVG with lane groups, legend indicators, and descriptive titles", () => {
    const representativeRun = lanternRun(NOW, [approvalAt(S(39, 36))]);
    const markup = renderTimelineHtml(representativeRun);

    assert.strictEqual(timelineLabel(representativeRun), "Timeline of 10 agents over 41m 12s");
    assert.match(
      markup,
      /<svg width="488" height="\d+(\.\d+)?" viewBox="0 0 488 [\d.]+" role="img" aria-label="Timeline of 10 agents over 41m 12s"/,
    );

    const laneDataCount = (markup.match(/data-lane="/g) || []).length;
    assert.strictEqual(laneDataCount, 10);

    const quietHatchCount = (markup.match(/data-quiet=""/g) || []).length;
    assert.strictEqual(quietHatchCount, 1);

    const markerCount = (markup.match(/data-marker="approval"/g) || []).length;
    assert.strictEqual(markerCount, 1);

    assert.match(markup, /planned, not scheduled yet/);
    const hasNowLabel = /now 41m 12s/.test(markup);
    assert.strictEqual(hasNowLabel, true);
    assert.match(markup, /data-end-line=""/);

    const activeBadges = ["Done", "Working", "No update", "Waiting on you", "Failed"];
    for (const badge of activeBadges) {
      assert.ok(markup.includes(`</i>${badge}</span>`));
    }

    assert.doesNotMatch(markup, /<kbd/);
    assert.match(markup, /<title>judge:perf · No update for 16m 02s<\/title>/);
    assert.doesNotMatch(markup, /from loaded history/);
  });

  it("annotates aria accessibility label when temporal metrics derive from loaded history", () => {
    const historicalRun = { ...lanternRun(), partialHistory: true } as RunVM;
    const markup = renderTimelineHtml(historicalRun);

    assert.match(markup, /from loaded history/);
    assert.match(markup, /aria-label="Timeline of 10 agents over 41m 12s, from loaded history"/);
  });

  it("highlights focused lane row and renders collapsed state banner when collapsed", () => {
    const baseRun = lanternRun();
    const targetedAgentId = baseRun.agents.find((a) => a.name === "judge:perf")!.id;

    const highlightedMarkup = renderTimelineHtml(baseRun, { selectedId: targetedAgentId });
    assert.match(
      highlightedMarkup,
      /<rect x="70" y="[\d.]+" width="418" height="16" rx="4" fill="var\(--bg-active\)"/,
    );

    const collapsedMarkup = renderTimelineHtml(baseRun, { collapsed: true });
    assert.match(collapsedMarkup, /data-collapsed="true"/);
    assert.doesNotMatch(collapsedMarkup, /role="img"/);
    assert.match(collapsedMarkup, /aria-expanded="false"/);
  });

  it("switches rendering pipeline to HTML5 Canvas past 200 lanes and aggregates closed phases into bands", () => {
    const denseRun = createLargeScaleRun(CANVAS_AT + 5);
    const canvasMarkup = renderTimelineHtml(denseRun);

    assert.match(canvasMarkup, /<canvas role="img" aria-label="Timeline of 205 agents over 4m 59s"/);
    assert.doesNotMatch(canvasMarkup, /<svg width="488"/);

    const bandedLayout = timelineLayout(denseRun, DEFAULT_VIEWPORT_WIDTH, {
      bands: new Set(["Audit"]),
    });
    assert.ok(bandedLayout);
    assert.strictEqual(bandedLayout.phases[0]!.rows.length, 1);
    assert.strictEqual(bandedLayout.phases[0]!.rows[0]!.kind, "band");
    assert.strictEqual(bandedLayout.lanes, 0);

    const boundaryRun = createLargeScaleRun(CANVAS_AT);
    const boundaryLayout = timelineLayout(boundaryRun, DEFAULT_VIEWPORT_WIDTH);
    assert.strictEqual(boundaryLayout!.lanes, CANVAS_AT);

    const svgBoundaryMarkup = renderTimelineHtml(boundaryRun);
    assert.match(svgBoundaryMarkup, /<svg width="488"/);
  });
});
