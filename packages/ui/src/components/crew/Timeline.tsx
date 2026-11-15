import { useEffect, useId, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
import { useNow } from "../../app/context.js";
import { CaretDownIcon, CaretRightIcon, ShieldWarningIcon } from "../ui/icons.js";
import { durationText, runLive, type AgentVM, type RunVM } from "../../model/crew.js";
import { cn } from "../ui/primitives.js";
import { stateWord } from "./panel.js";

export const CANVAS_AT = 200;

const GUTTER = 74;
const AXIS_H = 22;
const LANE_H = 10;
const LANE_GAP = 4;
const PHASE_GAP = 14;
const PACK_GAP = 3;
const SLIM_H = 4;
const TICK_CLEARANCE = 84;
const END_LABEL_CHARS = "now 41m 16s".length;
const CHAR_PX = 6;
const AXIS_TEXT = 14;
const GUTTER_CHARS = 11;

export type LaneFill = "done" | "work" | "fail" | "quiet" | "neutral" | "stale";

export interface LaneSegment {
  readonly x0: number;
  readonly x1: number;
  readonly fill: LaneFill;
  readonly cross: boolean;
}

export interface Lane {
  readonly kind: "lane";
  readonly id: string;
  readonly name: string;
  readonly state: AgentVM["state"];
  readonly word: string;
  readonly y: number;
  readonly segments: LaneSegment[];
  readonly quiet: { readonly x0: number; readonly x1: number } | null;
  readonly placeholder: "planned" | "scheduled" | null;
  readonly live: boolean;
  readonly packed: boolean;
  readonly slim: boolean;
}

export function laneBox(laneHeight: number, lane: Pick<Lane, "y" | "slim">): { y: number; h: number } {
  const isThinTrack = Boolean(lane.slim);
  if (!isThinTrack) {
    return { y: lane.y, h: laneHeight };
  }
  const centeredY = lane.y + (laneHeight - SLIM_H) / 2;
  return { y: centeredY, h: SLIM_H };
}

export interface Band {
  readonly kind: "band";
  readonly id: string;
  readonly name: string;
  readonly y: number;
  readonly cells: { readonly x0: number; readonly x1: number; readonly alpha: number; readonly live: boolean }[];
}

export interface PhaseBlock {
  readonly name: string;
  readonly label: string;
  readonly planned: boolean;
  readonly y: number;
  readonly height: number;
  readonly rows: (Lane | Band)[];
}

export interface Tick {
  readonly x: number;
  readonly label: string | null;
}

export interface Marker {
  readonly x: number;
  readonly kind: "approval" | "input";
  readonly requestId: string;
}

export interface TimelineLayout {
  readonly width: number;
  readonly height: number;
  readonly gutter: number;
  readonly axisHeight: number;
  readonly laneHeight: number;
  readonly endX: number;
  readonly endLabel: string;
  readonly finished: boolean;
  readonly stale: boolean;
  readonly ticks: Tick[];
  readonly phases: PhaseBlock[];
  readonly markers: Marker[];
  readonly lanes: number;
  readonly scale: number;
  readonly start: number;
  readonly clock: number;
  readonly plannedNote: { readonly x: number; readonly y: number } | null;
}

export interface LayoutOptions {
  readonly bands?: ReadonlySet<string>;
}

function computeLaneBounds(lane: Lane): { x0: number; x1: number } {
  const startEdges = lane.segments.map((s) => s.x0);
  const endEdges = lane.segments.map((s) => Math.max(s.x1, s.x0 + 2));
  return {
    x0: Math.min(...startEdges),
    x1: Math.max(...endEdges),
  };
}

function truncateGutterText(rawName: string): string {
  if (rawName.length <= GUTTER_CHARS) return rawName;
  const slicedPrefix = rawName.slice(0, GUTTER_CHARS - 1).trimEnd();
  return `${slicedPrefix}…`;
}

const TICK_INTERVALS_MS: readonly number[] = [
  5_000, 10_000, 15_000, 30_000, 60_000,
  120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000, 7_200_000, 21_600_000,
];

function pickAppropriateTickStep(spanMs: number): number {
  const matchedInterval = TICK_INTERVALS_MS.find((duration) => spanMs / duration <= 7);
  return matchedInterval ?? 21_600_000;
}

function formatTickText(offsetMs: number, intervalMs: number): string {
  if (offsetMs === 0) return "0";
  if (intervalMs < 60_000) {
    const totalSeconds = Math.round(offsetMs / 1000);
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.round(offsetMs / 60_000);
  return `${totalMinutes}m`;
}

function packNonOverlappingRows(lanesList: readonly Lane[]): number[] {
  const rowRightmostEdges: number[] = [];
  return lanesList.map((targetLane) => {
    const leftX = Math.min(...targetLane.segments.map((seg) => seg.x0));
    const rightX = Math.max(...targetLane.segments.map((seg) => seg.x1));
    const matchingRowIndex = rowRightmostEdges.findIndex((lastEdge) => lastEdge + PACK_GAP <= leftX);
    if (matchingRowIndex < 0) {
      rowRightmostEdges.push(rightX);
      return rowRightmostEdges.length - 1;
    }
    rowRightmostEdges[matchingRowIndex] = rightX;
    return matchingRowIndex;
  });
}

export function timelineLayout(run: RunVM, width: number, options: LayoutOptions = {}): TimelineLayout | null {
  const originTimestamp = run.startedAt;
  if (originTimestamp === null) {
    return null;
  }

  const isComplete = !runLive(run);
  const anchorClock = isComplete ? (run.endedAt ?? run.clockAt) : run.clockAt;
  const executionDelta = Math.max(1000, anchorClock - originTimestamp);
  const plotWidth = Math.max(40, width - GUTTER);
  const horizontalScale = plotWidth / (executionDelta * (isComplete ? 1.02 : 1.1));

  const projectToX = (ms: number): number => {
    const timeDelta = Math.max(0, ms - originTimestamp);
    return GUTTER + timeDelta * horizontalScale;
  };

  const endLineX = projectToX(anchorClock);
  const formattedDuration = durationText(executionDelta);
  const endStatusText = run.stale
    ? `last known ${formattedDuration}`
    : isComplete
      ? `finished ${formattedDuration}`
      : `now ${formattedDuration}`;

  const labelOverflowExtra = Math.max(0, endStatusText.length - END_LABEL_CHARS);
  const totalClearance = TICK_CLEARANCE + labelOverflowExtra * CHAR_PX;

  const tickEntries: Tick[] = [];
  const chosenStep = pickAppropriateTickStep(executionDelta);
  for (let cursor = 0; cursor <= executionDelta; cursor += chosenStep) {
    const cursorX = projectToX(originTimestamp + cursor);
    const isObscuredByEndLabel = Math.abs(endLineX - cursorX) < totalClearance;
    const labelVal = isObscuredByEndLabel ? null : formatTickText(cursor, chosenStep);
    tickEntries.push({ x: cursorX, label: labelVal });
  }

  let currentY = AXIS_H + 8;
  let totalLaneCount = 0;
  let plannedNoteAnchor: TimelineLayout["plannedNote"] = null;
  const assembledPhases: PhaseBlock[] = [];

  for (const currentPhase of run.phases) {
    const isPhasePlanned = currentPhase.state === "planned";
    const renderAsBand = options.bands?.has(currentPhase.name) === true && !isPhasePlanned;
    const rowList: (Lane | Band)[] = [];
    let allocatedSlots = 0;

    if (renderAsBand) {
      allocatedSlots = 1;
      const bandObject = densityBand(currentPhase.name, currentPhase.agents, originTimestamp, anchorClock, projectToX, currentY, isComplete);
      rowList.push(bandObject);
    } else {
      const generatedLanes = currentPhase.agents.map((ag, index) => {
        const laneY = currentY + index * (LANE_H + LANE_GAP);
        return laneOf(ag, run, originTimestamp, anchorClock, projectToX, laneY, endLineX);
      });

      const canPackTools = currentPhase.name === "Tools" && generatedLanes.length > 1 && generatedLanes.every((l) => l.placeholder === null && l.segments.length > 0);
      const rowAssignment = canPackTools ? packNonOverlappingRows(generatedLanes) : generatedLanes.map((_, i) => i);
      allocatedSlots = canPackTools ? Math.max(...rowAssignment) + 1 : generatedLanes.length;

      generatedLanes.forEach((origLane, i) => {
        const assignedSlot = rowAssignment[i] as number;
        const targetRowY = currentY + assignedSlot * (LANE_H + LANE_GAP);
        const transformedLane: Lane = {
          ...origLane,
          y: targetRowY,
          packed: canPackTools,
        };

        if (transformedLane.placeholder === "planned" && plannedNoteAnchor === null) {
          plannedNoteAnchor = { x: endLineX - 6, y: targetRowY + 9 };
        }
        rowList.push(transformedLane);
        totalLaneCount += 1;
      });
    }

    const calculatedHeight = Math.max(LANE_H, allocatedSlots * (LANE_H + LANE_GAP) - LANE_GAP);
    assembledPhases.push({
      name: currentPhase.name,
      label: truncateGutterText(currentPhase.name),
      planned: isPhasePlanned,
      y: currentY,
      height: calculatedHeight,
      rows: rowList,
    });
    currentY += calculatedHeight + PHASE_GAP;
  }

  const finalHeight = Math.max(AXIS_H + 8 + LANE_H + 4, currentY - PHASE_GAP + 4);

  const markerList: Marker[] = [];
  for (const needItem of run.runNeeds) {
    if (needItem.askedAt === null || needItem.askedAt < originTimestamp) continue;
    markerList.push({
      x: projectToX(needItem.askedAt),
      kind: needItem.kind,
      requestId: needItem.requestId,
    });
  }

  return {
    width,
    height: finalHeight,
    gutter: GUTTER,
    axisHeight: AXIS_H,
    laneHeight: LANE_H,
    endX: endLineX,
    endLabel: endStatusText,
    finished: isComplete,
    stale: run.stale,
    ticks: tickEntries,
    phases: assembledPhases,
    markers: markerList,
    lanes: totalLaneCount,
    scale: horizontalScale,
    start: originTimestamp,
    clock: anchorClock,
    plannedNote: plannedNoteAnchor,
  };
}

function resolveAgentOutcomeState(state: AgentVM["state"]): AgentVM["attempts"][number]["outcome"] | null {
  if (state === "done") return "done";
  if (state === "failed") return "failed";
  if (state === "skipped") return "skipped";
  if (state === "unknown") return "unknown";
  return null;
}

function laneOf(
  agent: AgentVM,
  run: RunVM,
  start: number,
  clock: number,
  X: (ms: number) => number,
  y: number,
  endX: number,
): Lane {
  const isLeadThread = agent.kind === "lead";
  const defaultLane: Lane = {
    kind: "lane",
    id: agent.id,
    name: agent.name,
    state: agent.state,
    word: stateWord(agent),
    y,
    segments: [],
    quiet: null,
    placeholder: null,
    live: false,
    packed: false,
    slim: isLeadThread,
  };

  if (agent.state === "planned") {
    return { ...defaultLane, placeholder: "planned" };
  }

  const collectedSpans: { from: number; to: number; last: boolean; outcome: AgentVM["attempts"][number]["outcome"] }[] = [];

  agent.attempts.forEach((att, idx) => {
    if (att.startedAt === null) return;
    const isFinalAttempt = idx === agent.attempts.length - 1;
    const targetEnd = att.endedAt ?? (att.outcome === null ? clock : null);
    if (targetEnd === null) return;
    collectedSpans.push({
      from: att.startedAt,
      to: targetEnd,
      last: isFinalAttempt,
      outcome: att.outcome,
    });
  });

  const resolvedOutcome = resolveAgentOutcomeState(agent.state);

  if (collectedSpans.length === 0 && agent.startedAt !== null) {
    const fallbackEnd = agent.endedAt ?? (resolvedOutcome === null ? clock : null);
    if (fallbackEnd !== null) {
      collectedSpans.push({ from: agent.startedAt, to: fallbackEnd, last: true, outcome: resolvedOutcome });
    }
  }

  if (collectedSpans.length === 0 && resolvedOutcome !== null && agent.endedAt !== null && agent.durationMs !== null) {
    const inferredStart = agent.endedAt - agent.durationMs;
    collectedSpans.push({ from: inferredStart, to: agent.endedAt, last: true, outcome: resolvedOutcome });
  }

  if (collectedSpans.length === 0) {
    const queuePlaceholder = agent.state === "scheduled" ? "scheduled" : null;
    return { ...defaultLane, placeholder: queuePlaceholder };
  }

  const liveStateTokens: ReadonlySet<AgentVM["state"]> = new Set(["working", "finishing", "no-update", "waiting-on-you"]);
  const isAgentCurrentlyActive = liveStateTokens.has(agent.state);

  const segmentEntities: LaneSegment[] = collectedSpans.map((sp) => {
    const leftCoord = X(sp.from);
    const computedRightCoord = sp.last && isAgentCurrentlyActive ? endX : X(sp.to);
    const rightCoord = Math.max(leftCoord + 2, computedRightCoord);

    let segmentFill: LaneFill;
    let markWithCross = false;

    if (!sp.last || sp.outcome === "failed") {
      segmentFill = "fail";
      markWithCross = true;
    } else if (sp.outcome === "skipped" || sp.outcome === "unknown") {
      segmentFill = "neutral";
    } else if (sp.outcome === "done") {
      segmentFill = "done";
    } else {
      segmentFill = run.stale ? "stale" : "work";
    }

    return {
      x0: leftCoord,
      x1: rightCoord,
      fill: segmentFill,
      cross: markWithCross,
    };
  });

  let quietRange: Lane["quiet"] = null;
  const quietConfig = agent.quiet;
  const lastEventTime = agent.lastEventAt;
  if (agent.state === "no-update" && quietConfig && lastEventTime !== null && !run.stale) {
    const quietStartX = X(lastEventTime + quietConfig.thresholdMs);
    if (quietStartX < endX) {
      quietRange = { x0: quietStartX, x1: endX };
    }
  }

  return {
    ...defaultLane,
    segments: segmentEntities,
    quiet: quietRange,
    live: isAgentCurrentlyActive,
  };
}

function densityBand(
  name: string,
  agents: readonly AgentVM[],
  start: number,
  clock: number,
  X: (ms: number) => number,
  y: number,
  finished: boolean,
): Band {
  const oneMinuteMs = 60_000;
  const activeIntervals: { from: number; to: number }[] = [];
  let earliestTimestamp = Number.POSITIVE_INFINITY;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const ag of agents) {
    const validAttempts = ag.attempts
      .filter((att) => att.startedAt !== null)
      .map((att) => ({ from: att.startedAt as number, to: att.endedAt ?? clock }));

    if (validAttempts.length === 0 && ag.startedAt !== null) {
      validAttempts.push({ from: ag.startedAt, to: ag.endedAt ?? clock });
    }

    for (const interval of validAttempts) {
      activeIntervals.push(interval);
      earliestTimestamp = Math.min(earliestTimestamp, interval.from);
      latestTimestamp = Math.max(latestTimestamp, interval.to);
    }
  }

  const generatedCells: Band["cells"] = [];
  if (activeIntervals.length > 0) {
    const minuteTallies: number[] = [];
    const minMinuteOffset = Math.floor((earliestTimestamp - start) / oneMinuteMs);
    const maxMinuteOffset = Math.ceil((latestTimestamp - start) / oneMinuteMs);

    for (let m = minMinuteOffset; m < maxMinuteOffset; m += 1) {
      const windowStart = start + m * oneMinuteMs;
      const windowEnd = windowStart + oneMinuteMs;
      const overlappingCount = activeIntervals.filter((intv) => intv.from < windowEnd && intv.to > windowStart).length;
      minuteTallies.push(overlappingCount);
    }

    const peakConcurrency = Math.max(1, ...minuteTallies);
    minuteTallies.forEach((count, i) => {
      if (count === 0) return;
      const bucketStart = start + (minMinuteOffset + i) * oneMinuteMs;
      const bucketEndBound = Math.min(bucketStart + oneMinuteMs, clock);
      const isCellActive = !finished && bucketStart + oneMinuteMs >= clock;

      generatedCells.push({
        x0: X(bucketStart),
        x1: X(bucketEndBound),
        alpha: count / peakConcurrency,
        live: isCellActive,
      });
    });
  }

  return {
    kind: "band",
    id: `band:${name}`,
    name,
    y,
    cells: generatedCells,
  };
}

export function timelineLabel(run: RunVM): string {
  const totalCount = run.counts.total;
  const pluralWord = totalCount === 1 ? "agent" : "agents";
  const durationTextValue = run.elapsedMs === null ? "an unknown time" : durationText(run.elapsedMs);
  const historyAnnotation = run.partialHistory ? ", from loaded history" : "";
  return `Timeline of ${totalCount} ${pluralWord} over ${durationTextValue}${historyAnnotation}`;
}

export interface TimelineProps {
  readonly run: RunVM;
  readonly width: number;
  readonly collapsed: boolean;
  readonly selectedId: string | null;
  readonly closedPhases?: ReadonlySet<string>;
  onLane(id: string): void;
  onToggle(): void;
}

const FILL_COLOR_TOKENS: Record<LaneFill, string> = {
  work: "var(--accent)",
  done: "var(--lane-done)",
  stale: "var(--cell-done)",
  neutral: "var(--bar-fill)",
  quiet: "",
  fail: "",
};

export function legendStates(layout: TimelineLayout): ("done" | "work" | "quiet" | "need" | "fail")[] {
  const uniqueFills = new Set<LaneFill | "live-band" | "done-band">();
  for (const phase of layout.phases) {
    for (const row of phase.rows) {
      if (row.kind === "band") {
        for (const cell of row.cells) {
          uniqueFills.add(cell.live ? "live-band" : "done-band");
        }
        continue;
      }
      for (const segment of row.segments) {
        uniqueFills.add(segment.fill);
      }
      if (row.quiet) {
        uniqueFills.add("quiet");
      }
    }
  }

  const resultStates: ("done" | "work" | "quiet" | "need" | "fail")[] = [];
  if (uniqueFills.has("done") || uniqueFills.has("done-band")) resultStates.push("done");
  if (uniqueFills.has("work") || uniqueFills.has("live-band")) resultStates.push("work");
  if (uniqueFills.has("quiet")) resultStates.push("quiet");
  if (layout.markers.length > 0) resultStates.push("need");
  if (uniqueFills.has("fail")) resultStates.push("fail");
  return resultStates;
}

const LEGEND_SPECS: Record<ReturnType<typeof legendStates>[number], { word: string; swatch: string }> = {
  done: { word: "Done", swatch: "bg-[var(--lane-done)]" },
  work: { word: "Working", swatch: "bg-accent" },
  quiet: { word: "No update", swatch: "bg-[repeating-linear-gradient(135deg,var(--accent)_0_2px,color-mix(in_oklab,var(--accent)_30%,var(--bg-raised))_2px_4px)]" },
  need: { word: "Waiting on you", swatch: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--warn)]" },
  fail: { word: "Failed", swatch: "bg-[repeating-linear-gradient(45deg,var(--danger)_0_2px,var(--hatch-fail)_2px_4px)]" },
};

function TimelineLegendView({ layout }: { layout: TimelineLayout }) {
  const swatchBaseClass = "inline-block h-[7px] w-[11px] rounded-sm";
  const displayedStates = legendStates(layout);
  if (displayedStates.length === 0) return null;

  return (
    <span className="hidden items-center gap-2.5 whitespace-nowrap @min-[480px]:inline-flex" aria-hidden="true">
      {displayedStates.map((st) => {
        const spec = LEGEND_SPECS[st];
        return (
          <span key={st} className="inline-flex items-center gap-1.5">
            <i className={cn(swatchBaseClass, spec.swatch)} />
            {spec.word}
          </span>
        );
      })}
    </span>
  );
}

function EndLineMarker(props: { layout: TimelineLayout; live: boolean; lanes: Lane[] }) {
  const { layout, live, lanes } = props;
  const currentTickTime = useNow(1000, live);
  const animatedEndX = live
    ? layout.endX + Math.max(0, currentTickTime - layout.clock) * layout.scale
    : layout.endX;

  const displayElapsed = live ? `now ${durationText(currentTickTime - layout.start)}` : layout.endLabel;
  const strokeColor = layout.finished ? "var(--ok)" : layout.stale ? "var(--border-strong)" : "var(--accent)";
  const textColor = layout.finished ? "var(--ok-text)" : layout.stale ? "var(--fg-subtle)" : "var(--accent-text)";

  return (
    <g data-end-line="">
      {live && animatedEndX > layout.endX &&
        lanes.map((curLane) => {
          const box = laneBox(layout.laneHeight, curLane);
          const rectFill = curLane.quiet ? "var(--hatch)" : "var(--accent)";
          return (
            <rect
              key={curLane.id}
              x={layout.endX - 1}
              y={box.y}
              width={animatedEndX - layout.endX + 1}
              height={box.h}
              rx={curLane.slim ? 2 : 0}
              fill={rectFill}
            />
          );
        })}
      <line
        x1={animatedEndX}
        x2={animatedEndX}
        y1={layout.axisHeight - 4}
        y2={layout.height}
        stroke={strokeColor}
        strokeWidth={1.25}
        strokeDasharray={layout.stale ? "3 2" : undefined}
      />
      <circle cx={animatedEndX} cy={layout.axisHeight - 4} r={2.5} fill={strokeColor} />
      <text
        x={animatedEndX - 7}
        y={AXIS_TEXT}
        fontSize={10}
        fill={textColor}
        textAnchor="end"
        fontWeight={500}
      >
        {displayElapsed}
      </text>
    </g>
  );
}

function TimelineSvg(props: { run: RunVM; layout: TimelineLayout; selectedId: string | null; onLane(id: string): void }) {
  const { layout, run, selectedId, onLane } = props;
  const sanitizedId = useId().replace(/:/g, "");
  const quietPatternId = `pq${sanitizedId}`;
  const failPatternId = `pf${sanitizedId}`;
  const horizontalPlotArea = layout.width - layout.gutter;

  const resolveFillUrl = (fill: LaneFill): string => {
    if (fill === "fail") return `url(#${failPatternId})`;
    if (fill === "quiet") return `url(#${quietPatternId})`;
    return FILL_COLOR_TOKENS[fill];
  };

  const activeLiveLanes = layout.phases.flatMap((ph) =>
    ph.rows.filter((r): r is Lane => r.kind === "lane" && r.live),
  );

  return (
    <svg
      width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={timelineLabel(run)}
      style={{ maxWidth: "100%" }}
      className="block font-sans"
    >
      <defs>
        <pattern id={failPatternId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect x={0} width={2} height={4} fill="var(--danger)" />
          <rect x={2} width={2} height={4} fill="var(--hatch-fail)" />
        </pattern>
        <pattern id={quietPatternId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
          <rect x={0} width={2} height={4} fill="var(--accent)" />
          <rect x={2} width={2} height={4} fill="color-mix(in oklab, var(--accent) 30%, var(--bg))" />
        </pattern>
      </defs>

      {layout.ticks.map((tk, idx) => (
        <g key={idx}>
          {tk.label !== null && (
            <text
              x={tk.x}
              y={AXIS_TEXT}
              fontSize={10}
              fill="var(--fg-subtle)"
              textAnchor={tk.label === "0" ? "start" : "middle"}
            >
              {tk.label}
            </text>
          )}
          <line
            x1={tk.x}
            x2={tk.x}
            y1={layout.axisHeight}
            y2={layout.height}
            stroke="var(--border)"
            strokeWidth={1}
            opacity={0.7}
          />
        </g>
      ))}

      {layout.phases.map((ph) => {
        const titleAnchorY = ph.y + layout.laneHeight / 2 + 4;
        const phaseTitleColor = ph.planned ? "var(--fg-subtle)" : "var(--fg-muted)";

        return (
          <g key={ph.name} data-phase={ph.name}>
            <text
              x={0}
              y={titleAnchorY}
              fontSize={11}
              fontWeight={500}
              fill={phaseTitleColor}
            >
              {ph.label !== ph.name && <title>{ph.name}</title>}
              {ph.label}
            </text>

            {ph.rows.map((rowItem) => {
              if (rowItem.kind === "band") {
                return (
                  <g key={rowItem.id} data-band={rowItem.name}>
                    {rowItem.cells.map((cl, cellIndex) => {
                      const cellWidth = Math.max(1, cl.x1 - cl.x0);
                      const bandColor = cl.live ? "var(--accent)" : "var(--lane-done)";
                      const bandOpacity = 0.25 + 0.75 * cl.alpha;

                      return (
                        <rect
                          key={cellIndex}
                          x={cl.x0}
                          y={rowItem.y}
                          width={cellWidth}
                          height={layout.laneHeight}
                          fill={bandColor}
                          opacity={bandOpacity}
                        />
                      );
                    })}
                  </g>
                );
              }

              const isLaneActiveSelection = selectedId === rowItem.id;
              const hasNoPlaceholder = !rowItem.placeholder;

              return (
                <g
                  key={rowItem.id}
                  data-lane={rowItem.id}
                  className={rowItem.placeholder ? undefined : "cursor-pointer"}
                  onClick={hasNoPlaceholder ? () => onLane(rowItem.id) : undefined}
                >
                  <title>{`${rowItem.name} · ${rowItem.word}`}</title>
                  {isLaneActiveSelection && (
                    rowItem.packed ? (
                      <rect
                        x={computeLaneBounds(rowItem).x0 - 4}
                        y={rowItem.y - 3}
                        width={computeLaneBounds(rowItem).x1 - computeLaneBounds(rowItem).x0 + 8}
                        height={layout.laneHeight + 6}
                        rx={4}
                        fill="var(--bg-active)"
                      />
                    ) : (
                      <rect
                        x={layout.gutter - 4}
                        y={rowItem.y - 3}
                        width={horizontalPlotArea + 4}
                        height={layout.laneHeight + 6}
                        rx={4}
                        fill="var(--bg-active)"
                      />
                    )
                  )}

                  {rowItem.placeholder && (
                    <rect
                      x={layout.endX + 4}
                      y={rowItem.y}
                      width={22}
                      height={layout.laneHeight}
                      rx={3}
                      fill="none"
                      stroke="var(--border-strong)"
                      strokeDasharray={rowItem.placeholder === "planned" ? "2 2" : undefined}
                    />
                  )}

                  {rowItem.segments.map((seg, sIdx) => {
                    const geometry = laneBox(layout.laneHeight, rowItem);
                    const segWidth = Math.max(2, seg.x1 - seg.x0);
                    const cornerRadius = rowItem.slim ? 2 : 3;

                    return (
                      <rect
                        key={sIdx}
                        className="crew-lane-seg"
                        x={seg.x0}
                        y={geometry.y}
                        width={segWidth}
                        height={geometry.h}
                        rx={cornerRadius}
                        fill={resolveFillUrl(seg.fill)}
                      />
                    );
                  })}

                  {rowItem.quiet && (
                    <rect
                      x={rowItem.quiet.x0}
                      y={laneBox(layout.laneHeight, rowItem).y}
                      width={Math.max(1, rowItem.quiet.x1 - rowItem.quiet.x0)}
                      height={laneBox(layout.laneHeight, rowItem).h}
                      rx={rowItem.slim ? 2 : 3}
                      fill={`url(#${quietPatternId})`}
                      data-quiet=""
                    />
                  )}

                  {rowItem.segments
                    .filter((seg) => seg.cross)
                    .map((crossSeg, crossIndex) => (
                      <path
                        key={`cross-${crossIndex}`}
                        d={`M${crossSeg.x1 - 8} ${rowItem.y + 2.5} l5 ${layout.laneHeight - 5} M${crossSeg.x1 - 3} ${rowItem.y + 2.5} l-5 ${layout.laneHeight - 5}`}
                        stroke="var(--bg)"
                        strokeWidth={1.5}
                      />
                    ))}

                  {rowItem.packed ? (
                    <rect
                      x={computeLaneBounds(rowItem).x0 - 2}
                      y={rowItem.y - 2}
                      width={computeLaneBounds(rowItem).x1 - computeLaneBounds(rowItem).x0 + 4}
                      height={layout.laneHeight + 4}
                      fill="transparent"
                    />
                  ) : (
                    <rect
                      x={layout.gutter}
                      y={rowItem.y - 2}
                      width={horizontalPlotArea}
                      height={layout.laneHeight + 4}
                      fill="transparent"
                    />
                  )}
                </g>
              );
            })}
          </g>
        );
      })}

      {layout.plannedNote && (
        <text
          x={layout.plannedNote.x}
          y={layout.plannedNote.y}
          fontSize={10}
          fill="var(--fg-subtle)"
          textAnchor="end"
        >
          planned, not scheduled yet
        </text>
      )}

      {layout.markers.map((mk) => (
        <g key={mk.requestId} data-marker={mk.kind}>
          <line
            x1={mk.x}
            x2={mk.x}
            y1={layout.axisHeight + 14}
            y2={layout.height}
            stroke="var(--warn)"
            strokeWidth={1.25}
            strokeDasharray="2 2"
          />
          <rect
            x={mk.x - 6}
            y={layout.axisHeight + 1}
            width={12}
            height={12}
            rx={3}
            fill="var(--warn-soft)"
          />
          <ShieldWarningIcon
            size={8}
            weight="fill"
            x={mk.x - 4}
            y={layout.axisHeight + 3}
            color="var(--warn-text)"
          />
        </g>
      ))}

      <EndLineMarker
        layout={layout}
        live={runLive(run) && !run.stale}
        lanes={activeLiveLanes}
      />
    </svg>
  );
}

function TimelineCanvas(props: { run: RunVM; layout: TimelineLayout; selectedId: string | null; onLane(id: string): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { layout, selectedId, onLane, run } = props;

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;

    const deviceScale = window.devicePixelRatio || 1;
    canvasElement.width = Math.round(layout.width * deviceScale);
    canvasElement.height = Math.round(layout.height * deviceScale);

    const renderingContext = canvasElement.getContext("2d");
    if (!renderingContext) return;
    renderingContext.scale(deviceScale, deviceScale);

    const computedStyles = getComputedStyle(canvasElement);
    const readCssToken = (name: string, fallback: string): string => {
      const rawVal = computedStyles.getPropertyValue(name).trim();
      return rawVal.length > 0 ? rawVal : fallback;
    };

    const palette = {
      done: readCssToken("--lane-done", "#6a6"),
      work: readCssToken("--accent", "#48f"),
      danger: readCssToken("--danger", "#d44"),
      hatchFail: readCssToken("--hatch-fail", "#844"),
      neutral: readCssToken("--bar-fill", "#888"),
      stale: readCssToken("--cell-done", "#999"),
      border: readCssToken("--border", "#8884"),
      strong: readCssToken("--border-strong", "#8888"),
      subtle: readCssToken("--fg-subtle", "#888"),
      muted: readCssToken("--fg-muted", "#aaa"),
      active: readCssToken("--bg-active", "#8882"),
      bg: readCssToken("--bg", "#111"),
      warn: readCssToken("--warn", "#da3"),
      ok: readCssToken("--ok", "#4a4"),
    };

    renderingContext.clearRect(0, 0, layout.width, layout.height);
    renderingContext.font = "10px sans-serif";
    renderingContext.textBaseline = "alphabetic";

    for (const tk of layout.ticks) {
      renderingContext.strokeStyle = palette.border;
      renderingContext.beginPath();
      renderingContext.moveTo(tk.x, layout.axisHeight);
      renderingContext.lineTo(tk.x, layout.height);
      renderingContext.stroke();

      if (tk.label !== null) {
        renderingContext.fillStyle = palette.subtle;
        renderingContext.textAlign = tk.label === "0" ? "start" : "center";
        renderingContext.fillText(tk.label, tk.x, AXIS_TEXT);
      }
    }

    const drawDiagonalHatch = (
      hatchX: number,
      hatchY: number,
      hatchW: number,
      hatchH: number,
      strokeColor: string,
      bgColor: string,
      degAngle: number,
    ) => {
      renderingContext.save();
      renderingContext.beginPath();
      renderingContext.rect(hatchX, hatchY, hatchW, hatchH);
      renderingContext.clip();

      renderingContext.fillStyle = bgColor;
      renderingContext.fillRect(hatchX, hatchY, hatchW, hatchH);

      renderingContext.strokeStyle = strokeColor;
      renderingContext.lineWidth = 2;
      const stripeInterval = 4;

      for (let s = -hatchH; s < hatchW + hatchH; s += stripeInterval) {
        renderingContext.beginPath();
        if (degAngle === 45) {
          renderingContext.moveTo(hatchX + s, hatchY + hatchH);
          renderingContext.lineTo(hatchX + s + hatchH, hatchY);
        } else {
          renderingContext.moveTo(hatchX + s, hatchY);
          renderingContext.lineTo(hatchX + s + hatchH, hatchY + hatchH);
        }
        renderingContext.stroke();
      }
      renderingContext.restore();
    };

    renderingContext.font = "500 11px sans-serif";

    for (const ph of layout.phases) {
      renderingContext.fillStyle = ph.planned ? palette.subtle : palette.muted;
      renderingContext.textAlign = "start";
      renderingContext.fillText(ph.label, 0, ph.y + layout.laneHeight / 2 + 4);

      for (const rowObj of ph.rows) {
        if (rowObj.kind === "band") {
          for (const cell of rowObj.cells) {
            renderingContext.globalAlpha = 0.25 + 0.75 * cell.alpha;
            renderingContext.fillStyle = cell.live ? palette.work : palette.done;
            renderingContext.fillRect(cell.x0, rowObj.y, Math.max(1, cell.x1 - cell.x0), layout.laneHeight);
          }
          renderingContext.globalAlpha = 1;
          continue;
        }

        if (selectedId === rowObj.id) {
          renderingContext.fillStyle = palette.active;
          if (rowObj.packed) {
            const bounds = computeLaneBounds(rowObj);
            renderingContext.fillRect(bounds.x0 - 4, rowObj.y - 3, bounds.x1 - bounds.x0 + 8, layout.laneHeight + 6);
          } else {
            renderingContext.fillRect(layout.gutter - 4, rowObj.y - 3, layout.width - layout.gutter + 4, layout.laneHeight + 6);
          }
        }

        if (rowObj.placeholder) {
          renderingContext.strokeStyle = palette.strong;
          renderingContext.setLineDash(rowObj.placeholder === "planned" ? [2, 2] : []);
          renderingContext.strokeRect(layout.endX + 4, rowObj.y, 22, layout.laneHeight);
          renderingContext.setLineDash([]);
        }

        for (const seg of rowObj.segments) {
          const segWidth = Math.max(2, seg.x1 - seg.x0);
          const box = laneBox(layout.laneHeight, rowObj);

          if (seg.fill === "fail") {
            drawDiagonalHatch(seg.x0, box.y, segWidth, box.h, palette.danger, palette.hatchFail, 45);
          } else {
            const fillColor = seg.fill === "done"
              ? palette.done
              : seg.fill === "work"
                ? palette.work
                : seg.fill === "stale"
                  ? palette.stale
                  : palette.neutral;
            renderingContext.fillStyle = fillColor;
            renderingContext.fillRect(seg.x0, box.y, segWidth, box.h);
          }

          if (seg.cross) {
            renderingContext.strokeStyle = palette.bg;
            renderingContext.lineWidth = 1.5;
            renderingContext.beginPath();
            renderingContext.moveTo(seg.x1 - 7, rowObj.y + 2);
            renderingContext.lineTo(seg.x1 - 3, rowObj.y + layout.laneHeight - 2);
            renderingContext.moveTo(seg.x1 - 3, rowObj.y + 2);
            renderingContext.lineTo(seg.x1 - 7, rowObj.y + layout.laneHeight - 2);
            renderingContext.stroke();
          }
        }

        if (rowObj.quiet) {
          const quietW = Math.max(1, rowObj.quiet.x1 - rowObj.quiet.x0);
          drawDiagonalHatch(rowObj.quiet.x0, rowObj.y, quietW, layout.laneHeight, palette.work, palette.bg, 135);
        }
      }
    }

    renderingContext.font = "10px sans-serif";
    if (layout.plannedNote) {
      renderingContext.fillStyle = palette.subtle;
      renderingContext.textAlign = "end";
      renderingContext.fillText("planned, not scheduled yet", layout.plannedNote.x, layout.plannedNote.y);
    }

    for (const mk of layout.markers) {
      renderingContext.strokeStyle = palette.warn;
      renderingContext.setLineDash([2, 2]);
      renderingContext.lineWidth = 1.25;
      renderingContext.beginPath();
      renderingContext.moveTo(mk.x, layout.axisHeight + 14);
      renderingContext.lineTo(mk.x, layout.height);
      renderingContext.stroke();
      renderingContext.setLineDash([]);
      renderingContext.fillStyle = palette.warn;
      renderingContext.fillRect(mk.x - 6, layout.axisHeight + 1, 12, 12);
    }

    renderingContext.strokeStyle = layout.finished ? palette.ok : layout.stale ? palette.strong : palette.work;
    renderingContext.lineWidth = 1;
    renderingContext.setLineDash(layout.finished ? [] : [3, 2]);
    renderingContext.beginPath();
    renderingContext.moveTo(layout.endX, layout.axisHeight - 4);
    renderingContext.lineTo(layout.endX, layout.height);
    renderingContext.stroke();
    renderingContext.setLineDash([]);

    renderingContext.font = "500 10px sans-serif";
    renderingContext.fillStyle = layout.finished ? palette.ok : layout.stale ? palette.subtle : palette.work;
    renderingContext.textAlign = "end";
    renderingContext.fillText(layout.endLabel, layout.endX - 7, AXIS_TEXT);
  }, [layout, selectedId]);

  const handleCanvasClick = (ev: MouseEvent<HTMLCanvasElement>) => {
    const boundingBox = ev.currentTarget.getBoundingClientRect();
    const clickX = ev.clientX - boundingBox.left;
    const clickY = ev.clientY - boundingBox.top;

    for (const ph of layout.phases) {
      for (const rowItem of ph.rows) {
        if (rowItem.kind !== "lane" || rowItem.placeholder) continue;
        const isYMatch = clickY >= rowItem.y - 2 && clickY <= rowItem.y + layout.laneHeight + 2;
        if (!isYMatch) continue;

        if (!rowItem.packed) {
          onLane(rowItem.id);
          return;
        }

        const b = computeLaneBounds(rowItem);
        const isXMatch = clickX >= b.x0 - 2 && clickX <= b.x1 + 2;
        if (isXMatch) {
          onLane(rowItem.id);
          return;
        }
      }
    }
  };

  const canvasStyle: CSSProperties = { width: layout.width, height: layout.height, maxWidth: "100%" };
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={timelineLabel(run)}
      className="block cursor-pointer"
      style={canvasStyle}
      onClick={handleCanvasClick}
      data-lanes={layout.lanes}
    />
  );
}

function TimelineBodyContent(props: {
  layout: TimelineLayout | null;
  run: RunVM;
  selectedId: string | null;
  onLane: (id: string) => void;
}) {
  const { layout, run, selectedId, onLane } = props;
  if (!layout) {
    return (
      <p className="px-4 pb-2.5 text-xs text-subtle">
        Times are not loaded for this run, so there is nothing to draw yet.
      </p>
    );
  }
  return (
    <div className="max-h-[38vh] overflow-y-auto px-4 pb-2">
      {layout.lanes > CANVAS_AT ? (
        <TimelineCanvas run={run} layout={layout} selectedId={selectedId} onLane={onLane} />
      ) : (
        <TimelineSvg run={run} layout={layout} selectedId={selectedId} onLane={onLane} />
      )}
    </div>
  );
}

export function Timeline(props: TimelineProps) {
  const { run, width, collapsed, selectedId, closedPhases, onLane, onToggle } = props;

  const computedLayout = useMemo(() => {
    const totalAgentsCount = run.phases.reduce((acc, ph) => acc + ph.agents.length, 0);
    const shouldUseBands = totalAgentsCount > CANVAS_AT;
    return timelineLayout(run, width, shouldUseBands ? { bands: closedPhases } : {});
  }, [run, width, closedPhases]);

  const hasLoadedHistory = Boolean(run.partialHistory);

  return (
    <section
      aria-label="Timeline"
      className="shrink-0 border-b border-line"
      data-collapsed={collapsed || undefined}
    >
      <div className="flex h-[30px] items-center gap-2 pr-4 pl-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="-ml-1 inline-flex h-6 items-center gap-2 rounded-md px-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
        >
          <span className="flex w-3 justify-center text-subtle">
            {collapsed ? <CaretRightIcon size={11} /> : <CaretDownIcon size={11} />}
          </span>
          Timeline
        </button>
        {hasLoadedHistory && (
          <span className="text-2xs text-subtle">from loaded history</span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-2.5 text-2xs text-subtle">
          {!collapsed && computedLayout !== null && <TimelineLegendView layout={computedLayout} />}
        </span>
      </div>

      {!collapsed && (
        <TimelineBodyContent
          layout={computedLayout}
          run={run}
          selectedId={selectedId}
          onLane={onLane}
        />
      )}
    </section>
  );
}
