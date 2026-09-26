import { useEffect, useId, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
import { useNow } from "../../app/context.js";
import { CaretDownIcon, CaretRightIcon, ShieldWarningIcon } from "../ui/icons.js";
import { durationText, runLive, type AgentVM, type RunVM } from "../../model/swarm.js";
import { Kbd, cn } from "../ui/primitives.js";
import { stateWord } from "./panel.js";

/** SVG up to this many lanes; a canvas above it. */
export const CANVAS_AT = 200;

const GUTTER = 74;
const AXIS_H = 18;
const LANE_H = 8;
const LANE_GAP = 2.5;
const PHASE_GAP = 8;
/** A tick label this close to the now label is dropped (the mock's 84 px, for `now 41m 16s`); a longer end label clears more. */
const TICK_CLEARANCE = 84;
const END_LABEL_CHARS = "now 41m 16s".length;
const CHAR_PX = 6;

export type LaneFill = "done" | "work" | "fail" | "quiet" | "neutral" | "stale";

export interface LaneSegment {
  x0: number;
  x1: number;
  fill: LaneFill;
  /** An attempt that failed or was replaced: an × marks its end. */
  cross: boolean;
}

export interface Lane {
  kind: "lane";
  id: string;
  name: string;
  state: AgentVM["state"];
  /** The state word, for the lane's title. */
  word: string;
  y: number;
  segments: LaneSegment[];
  /** A no-update tail, hatched from where the silence became remarkable. */
  quiet: { x0: number; x1: number } | null;
  /** A placeholder for an agent with no lane yet: dashed for planned, solid for queued. */
  placeholder: "planned" | "scheduled" | null;
  /** The lane is still growing: its last segment ends at the clock. */
  live: boolean;
}

export interface Band {
  kind: "band";
  id: string;
  name: string;
  y: number;
  /** One cell per minute: how many agents ran, as a share of the phase's peak. */
  cells: { x0: number; x1: number; alpha: number; live: boolean }[];
}

export interface PhaseBlock {
  name: string;
  /** The name as the 74 px gutter shows it; the roster has it in full. */
  label: string;
  planned: boolean;
  y: number;
  height: number;
  rows: (Lane | Band)[];
}

export interface Tick {
  x: number;
  label: string | null;
}

export interface Marker {
  x: number;
  kind: "approval" | "input";
  requestId: string;
}

export interface TimelineLayout {
  width: number;
  height: number;
  gutter: number;
  axisHeight: number;
  laneHeight: number;
  /** Where the now or finished line stands, at the run's clock. */
  endX: number;
  endLabel: string;
  finished: boolean;
  stale: boolean;
  ticks: Tick[];
  phases: PhaseBlock[];
  markers: Marker[];
  lanes: number;
  /** Pixels per millisecond, so a later clock can extend the live lanes. */
  scale: number;
  /** The run's start in epoch ms, the origin of `x`. */
  start: number;
  /** The clock the layout was drawn at. */
  clock: number;
  /** The text "planned, not scheduled yet" sits before the end line on the first planned lane. */
  plannedNote: { x: number; y: number } | null;
}

export interface LayoutOptions {
  /** Phases drawn as a density band instead of lanes (the canvas, for closed phases). */
  bands?: ReadonlySet<string>;
}

/** What fits in the gutter at 11 px medium: about eleven characters. */
const GUTTER_CHARS = 11;

function gutterLabel(name: string): string {
  return name.length <= GUTTER_CHARS ? name : `${name.slice(0, GUTTER_CHARS - 1).trimEnd()}…`;
}

function tickStep(totalMs: number): number {
  const minutes = totalMs / 60_000;
  if (minutes <= 90) return 10;
  if (minutes <= 240) return 30;
  return 60;
}

/** The chart's geometry (final.js `timeline`): gutter 74, lanes 8 px, 2.5 px gaps, 8 px between phases, ticks by ten minutes. */
export function timelineLayout(run: RunVM, width: number, options: LayoutOptions = {}): TimelineLayout | null {
  const start = run.startedAt;
  if (start === null) return null;
  const finished = !runLive(run);
  const clock = finished ? (run.endedAt ?? run.clockAt) : run.clockAt;
  const total = Math.max(1000, clock - start);
  const plot = Math.max(40, width - GUTTER);
  const scale = plot / (total * (finished ? 1.02 : 1.1));
  const X = (ms: number) => GUTTER + Math.max(0, ms - start) * scale;
  const endX = X(clock);

  const elapsed = durationText(total);
  const endLabel = run.stale ? `last known ${elapsed}` : finished ? `finished ${elapsed}` : `now ${elapsed}`;
  const clearance = TICK_CLEARANCE + Math.max(0, endLabel.length - END_LABEL_CHARS) * CHAR_PX;
  const ticks: Tick[] = [];
  const step = tickStep(total);
  for (let m = 0; m * 60_000 <= total; m += step) {
    const x = X(start + m * 60_000);
    ticks.push({ x, label: Math.abs(endX - x) < clearance ? null : m === 0 ? "0" : `${m}m` });
  }

  let y = AXIS_H + 6;
  let lanes = 0;
  let plannedNote: TimelineLayout["plannedNote"] = null;
  const phases: PhaseBlock[] = [];
  for (const phase of run.phases) {
    const planned = phase.state === "planned";
    const band = options.bands?.has(phase.name) === true && !planned;
    const n = band ? 1 : phase.agents.length;
    const height = Math.max(LANE_H, n * (LANE_H + LANE_GAP) - LANE_GAP);
    const rows: (Lane | Band)[] = [];
    if (band) {
      rows.push(densityBand(phase.name, phase.agents, start, clock, X, y, finished));
    } else {
      phase.agents.forEach((agent, i) => {
        const ly = y + i * (LANE_H + LANE_GAP);
        const lane = laneOf(agent, run, start, clock, X, ly, endX);
        if (lane.placeholder === "planned" && plannedNote === null) plannedNote = { x: endX - 6, y: ly + 8.5 };
        rows.push(lane);
        lanes += 1;
      });
    }
    phases.push({ name: phase.name, label: gutterLabel(phase.name), planned, y, height, rows });
    y += height + PHASE_GAP;
  }
  const height = Math.max(AXIS_H + 6 + LANE_H + 4, y - PHASE_GAP + 4);

  const markers: Marker[] = [];
  for (const need of run.runNeeds) {
    if (need.askedAt === null || need.askedAt < start) continue;
    markers.push({ x: X(need.askedAt), kind: need.kind, requestId: need.requestId });
  }

  return {
    width,
    height,
    gutter: GUTTER,
    axisHeight: AXIS_H,
    laneHeight: LANE_H,
    endX,
    endLabel,
    finished,
    stale: run.stale,
    ticks,
    phases,
    markers,
    lanes,
    scale,
    start,
    clock,
    plannedNote,
  };
}

function laneOf(agent: AgentVM, run: RunVM, start: number, clock: number, X: (ms: number) => number, y: number, endX: number): Lane {
  const base: Lane = { kind: "lane", id: agent.id, name: agent.name, state: agent.state, word: stateWord(agent), y, segments: [], quiet: null, placeholder: null, live: false };
  if (agent.state === "planned") return { ...base, placeholder: "planned" };
  const spans: { from: number; to: number; last: boolean; outcome: AgentVM["attempts"][number]["outcome"] }[] = [];
  agent.attempts.forEach((attempt, index) => {
    if (attempt.startedAt === null) return;
    const last = index === agent.attempts.length - 1;
    const to = attempt.endedAt ?? (attempt.outcome === null ? clock : null);
    if (to === null) return;
    spans.push({ from: attempt.startedAt, to, last, outcome: attempt.outcome });
  });
  const outcome = agent.state === "done" ? "done" : agent.state === "failed" ? "failed" : agent.state === "skipped" ? "skipped" : agent.state === "unknown" ? "unknown" : null;
  if (spans.length === 0 && agent.startedAt !== null) {
    const ended = agent.endedAt ?? (outcome === null ? clock : null);
    if (ended !== null) spans.push({ from: agent.startedAt, to: ended, last: true, outcome });
  }
  // A start never seen (the agent went from queued to its end within one revision): Muse's own duration, back from the end seen.
  if (spans.length === 0 && outcome !== null && agent.endedAt !== null && agent.durationMs !== null) {
    spans.push({ from: agent.endedAt - agent.durationMs, to: agent.endedAt, last: true, outcome });
  }
  if (spans.length === 0) return { ...base, placeholder: agent.state === "scheduled" ? "scheduled" : null };
  const liveStates = new Set<AgentVM["state"]>(["working", "finishing", "no-update", "waiting-on-you"]);
  const live = liveStates.has(agent.state);
  const segments: LaneSegment[] = spans.map((span) => {
    const x0 = X(span.from);
    const x1 = Math.max(x0 + 2, span.last && live ? endX : X(span.to));
    let fill: LaneFill;
    let cross = false;
    if (!span.last || span.outcome === "failed") {
      fill = "fail";
      cross = true;
    } else if (span.outcome === "skipped" || span.outcome === "unknown") {
      fill = "neutral";
    } else if (span.outcome === "done") {
      fill = "done";
    } else {
      fill = run.stale ? "stale" : "work";
    }
    return { x0, x1, fill, cross };
  });
  let quiet: Lane["quiet"] = null;
  if (agent.state === "no-update" && agent.quiet && agent.lastEventAt !== null && !run.stale) {
    const from = X(agent.lastEventAt + agent.quiet.thresholdMs);
    if (from < endX) quiet = { x0: from, x1: endX };
  }
  void start;
  return { ...base, segments, quiet, live };
}

/** One row for a closed phase: how many of its agents ran in each minute, as a share of its peak. */
function densityBand(name: string, agents: readonly AgentVM[], start: number, clock: number, X: (ms: number) => number, y: number, finished: boolean): Band {
  const minute = 60_000;
  const spans: { from: number; to: number }[] = [];
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const agent of agents) {
    const own = agent.attempts.filter((attempt) => attempt.startedAt !== null).map((attempt) => ({ from: attempt.startedAt as number, to: attempt.endedAt ?? clock }));
    if (own.length === 0 && agent.startedAt !== null) own.push({ from: agent.startedAt, to: agent.endedAt ?? clock });
    for (const span of own) {
      spans.push(span);
      first = Math.min(first, span.from);
      last = Math.max(last, span.to);
    }
  }
  const cells: Band["cells"] = [];
  if (spans.length > 0) {
    const counts: number[] = [];
    const from = Math.floor((first - start) / minute);
    const to = Math.ceil((last - start) / minute);
    for (let m = from; m < to; m += 1) {
      const t0 = start + m * minute;
      const t1 = t0 + minute;
      counts.push(spans.filter((span) => span.from < t1 && span.to > t0).length);
    }
    const peak = Math.max(1, ...counts);
    counts.forEach((count, i) => {
      if (count === 0) return;
      const t0 = start + (from + i) * minute;
      cells.push({ x0: X(t0), x1: X(Math.min(t0 + minute, clock)), alpha: count / peak, live: !finished && t0 + minute >= clock });
    });
  }
  return { kind: "band", id: `band:${name}`, name, y, cells };
}

/** The chart's text equivalent; the roster is its table. */
export function timelineLabel(run: RunVM): string {
  const n = run.counts.total;
  const elapsed = run.elapsedMs === null ? "an unknown time" : durationText(run.elapsedMs);
  return `Timeline of ${n} ${n === 1 ? "agent" : "agents"} over ${elapsed}${run.partialHistory ? ", from loaded history" : ""}`;
}

export interface TimelineProps {
  run: RunVM;
  /** The chart's width in px: the panel's less its 16 px sides. */
  width: number;
  collapsed: boolean;
  selectedId: string | null;
  /** Phases closed in the roster, drawn as density bands once the chart is on canvas. */
  closedPhases?: ReadonlySet<string>;
  onLane(id: string): void;
  onToggle(): void;
}

const FILLS: Record<LaneFill, string> = {
  done: "var(--lane-done)",
  work: "var(--accent)",
  fail: "",
  quiet: "",
  neutral: "var(--bar-fill)",
  stale: "var(--cell-done)",
};

/** The Timeline section: its head with the legend, then the chart, on SVG up to 200 lanes and on canvas above. */
export function Timeline(props: TimelineProps) {
  const { run } = props;
  const layout = useMemo(() => {
    const lanes = run.phases.reduce((n, phase) => n + phase.agents.length, 0);
    return timelineLayout(run, props.width, lanes > CANVAS_AT ? { bands: props.closedPhases } : {});
  }, [run, props.width, props.closedPhases]);
  return (
    <section aria-label="Timeline" className="shrink-0 border-b border-line" data-collapsed={props.collapsed || undefined}>
      <div className="flex h-[30px] items-center gap-2 pr-4 pl-3">
        <button
          type="button"
          aria-expanded={!props.collapsed}
          onClick={props.onToggle}
          className="-ml-1 inline-flex h-6 items-center gap-2 rounded-md px-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
        >
          <span className="flex w-3 justify-center text-subtle">{props.collapsed ? <CaretRightIcon size={11} /> : <CaretDownIcon size={11} />}</span>
          Timeline
        </button>
        {run.partialHistory ? <span className="text-2xs text-subtle">from loaded history</span> : null}
        <span className="ml-auto flex min-w-0 items-center gap-2.5 text-2xs text-subtle">
          {props.collapsed ? null : <Legend />}
          <Kbd className="h-4 min-w-4 text-[10.5px]">t</Kbd>
        </span>
      </div>
      {props.collapsed ? null : layout === null ? (
        <p className="px-4 pb-2.5 text-xs text-subtle">Times are not loaded for this run, so there is nothing to draw yet.</p>
      ) : (
        <div className="max-h-[38vh] overflow-y-auto px-4 pb-2">
          {layout.lanes > CANVAS_AT ? (
            <TimelineCanvas run={run} layout={layout} selectedId={props.selectedId} onLane={props.onLane} />
          ) : (
            <TimelineSvg run={run} layout={layout} selectedId={props.selectedId} onLane={props.onLane} />
          )}
        </div>
      )}
    </section>
  );
}

function Legend() {
  const swatch = "inline-block h-[7px] w-[11px] rounded-sm";
  return (
    <span className="hidden items-center gap-2.5 whitespace-nowrap @min-[480px]:inline-flex" aria-hidden="true">
      <span className="inline-flex items-center gap-1.5"><i className={cn(swatch, "bg-[var(--lane-done)]")} />Done</span>
      <span className="inline-flex items-center gap-1.5"><i className={cn(swatch, "bg-accent")} />Working</span>
      <span className="inline-flex items-center gap-1.5"><i className={cn(swatch, "bg-[repeating-linear-gradient(135deg,var(--accent)_0_2px,color-mix(in_oklab,var(--accent)_30%,var(--bg-raised))_2px_4px)]")} />No update</span>
      <span className="inline-flex items-center gap-1.5"><i className={cn(swatch, "bg-transparent shadow-[inset_0_0_0_1.5px_var(--warn)]")} />Waiting on you</span>
      <span className="inline-flex items-center gap-1.5"><i className={cn(swatch, "bg-[repeating-linear-gradient(45deg,var(--danger)_0_2px,var(--hatch-fail)_2px_4px)]")} />Failed</span>
    </span>
  );
}

function TimelineSvg(props: { run: RunVM; layout: TimelineLayout; selectedId: string | null; onLane(id: string): void }) {
  const { layout, run } = props;
  const uid = useId().replace(/:/g, "");
  const quietId = `pq${uid}`;
  const failId = `pf${uid}`;
  const plot = layout.width - layout.gutter;
  const fillOf = (fill: LaneFill) => (fill === "fail" ? `url(#${failId})` : fill === "quiet" ? `url(#${quietId})` : FILLS[fill]);
  const liveLanes = layout.phases.flatMap((phase) => phase.rows.filter((row): row is Lane => row.kind === "lane" && row.live));
  return (
    <svg
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={timelineLabel(run)}
      className="block font-sans"
      style={{ maxWidth: "100%" }}
    >
      <defs>
        <pattern id={quietId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
          <rect width="2" height="4" fill="var(--accent)" />
          <rect x="2" width="2" height="4" fill="color-mix(in oklab, var(--accent) 30%, var(--bg))" />
        </pattern>
        <pattern id={failId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2" height="4" fill="var(--danger)" />
          <rect x="2" width="2" height="4" fill="var(--hatch-fail)" />
        </pattern>
      </defs>
      {layout.ticks.map((tick, index) => (
        <g key={index}>
          {tick.label !== null ? (
            <text x={tick.x} y={11} fontSize={10} fill="var(--fg-subtle)" textAnchor={tick.label === "0" ? "start" : "middle"}>{tick.label}</text>
          ) : null}
          <line x1={tick.x} x2={tick.x} y1={layout.axisHeight} y2={layout.height} stroke="var(--border)" strokeWidth={1} />
        </g>
      ))}
      {layout.phases.map((phase) => (
        <g key={phase.name} data-phase={phase.name}>
          <text x={0} y={phase.y + Math.min(phase.height, 16) / 2 + 4} fontSize={11} fontWeight={500} fill={phase.planned ? "var(--fg-subtle)" : "var(--fg-muted)"}>
            {phase.label !== phase.name ? <title>{phase.name}</title> : null}
            {phase.label}
          </text>
          {phase.rows.map((row) =>
            row.kind === "band" ? (
              <g key={row.id} data-band={row.name}>
                {row.cells.map((cell, index) => (
                  <rect key={index} x={cell.x0} y={row.y} width={Math.max(1, cell.x1 - cell.x0)} height={layout.laneHeight} fill={cell.live ? "var(--accent)" : "var(--lane-done)"} opacity={0.25 + 0.75 * cell.alpha} />
                ))}
              </g>
            ) : (
              <g key={row.id} data-lane={row.id} className={row.placeholder ? undefined : "cursor-pointer"} onClick={row.placeholder ? undefined : () => props.onLane(row.id)}>
                <title>{`${row.name} · ${row.word}`}</title>
                {props.selectedId === row.id ? <rect x={layout.gutter - 4} y={row.y - 2.5} width={plot + 4} height={layout.laneHeight + 5} rx={3} fill="var(--bg-active)" /> : null}
                {row.placeholder ? (
                  <rect x={layout.endX + 4} y={row.y} width={22} height={layout.laneHeight} rx={2} fill="none" stroke="var(--border-strong)" strokeDasharray={row.placeholder === "planned" ? "2 2" : undefined} />
                ) : null}
                {row.segments.map((segment, index) => (
                  <rect key={index} className="swarm-lane-seg" x={segment.x0} y={row.y} width={Math.max(2, segment.x1 - segment.x0)} height={layout.laneHeight} rx={2} fill={fillOf(segment.fill)} />
                ))}
                {row.quiet ? <rect x={row.quiet.x0} y={row.y} width={Math.max(1, row.quiet.x1 - row.quiet.x0)} height={layout.laneHeight} rx={2} fill={`url(#${quietId})`} data-quiet="" /> : null}
                {row.segments.filter((segment) => segment.cross).map((segment, index) => (
                  <path key={`x${index}`} d={`M${segment.x1 - 7} ${row.y + 2} l4 ${layout.laneHeight - 4} M${segment.x1 - 3} ${row.y + 2} l-4 ${layout.laneHeight - 4}`} stroke="var(--bg)" strokeWidth={1.5} />
                ))}
                <rect x={layout.gutter} y={row.y - 1.25} width={plot} height={layout.laneHeight + 2.5} fill="transparent" />
              </g>
            ),
          )}
        </g>
      ))}
      {layout.plannedNote ? (
        <text x={layout.plannedNote.x} y={layout.plannedNote.y} fontSize={10} fill="var(--fg-subtle)" textAnchor="end">planned, not scheduled yet</text>
      ) : null}
      {layout.markers.map((marker) => (
        <g key={marker.requestId} data-marker={marker.kind}>
          <line x1={marker.x} x2={marker.x} y1={layout.axisHeight + 14} y2={layout.height} stroke="var(--warn)" strokeWidth={1.25} strokeDasharray="2 2" />
          <rect x={marker.x - 6} y={layout.axisHeight + 1} width={12} height={12} rx={3} fill="var(--warn-soft)" />
          <ShieldWarningIcon size={8} weight="fill" x={marker.x - 4} y={layout.axisHeight + 3} color="var(--warn-text)" />
        </g>
      ))}
      <EndLine layout={layout} live={runLive(run) && !run.stale} lanes={liveLanes} />
    </svg>
  );
}

/** The now line, ticking each second on its own, with the live lanes grown to it; a finished run's ok line stands still. */
function EndLine(props: { layout: TimelineLayout; live: boolean; lanes: Lane[] }) {
  const { layout } = props;
  const now = useNow(1000, props.live);
  const x = props.live ? layout.endX + Math.max(0, now - layout.clock) * layout.scale : layout.endX;
  const elapsed = props.live ? `now ${durationText(now - layout.start)}` : layout.endLabel;
  const stroke = layout.finished ? "var(--ok)" : layout.stale ? "var(--border-strong)" : "var(--accent)";
  const text = layout.finished ? "var(--ok-text)" : layout.stale ? "var(--fg-subtle)" : "var(--accent-text)";
  return (
    <g data-end-line="">
      {props.live && x > layout.endX
        ? props.lanes.map((lane) => <rect key={lane.id} x={layout.endX - 1} y={lane.y} width={x - layout.endX + 1} height={layout.laneHeight} fill={lane.quiet ? "var(--hatch)" : "var(--accent)"} />)
        : null}
      <line x1={x} x2={x} y1={layout.axisHeight - 2} y2={layout.height} stroke={stroke} strokeWidth={1} strokeDasharray={layout.finished ? undefined : "3 2"} />
      <text x={x - 4} y={11} fontSize={10} fill={text} textAnchor="end" fontWeight={500}>{elapsed}</text>
    </g>
  );
}

/** Past 200 lanes the chart is painted, with the roster's closed phases as density bands. */
function TimelineCanvas(props: { run: RunVM; layout: TimelineLayout; selectedId: string | null; onLane(id: string): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { layout } = props;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(layout.width * ratio);
    canvas.height = Math.round(layout.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const styles = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const colors = {
      done: token("--lane-done", "#6a6"),
      work: token("--accent", "#48f"),
      danger: token("--danger", "#d44"),
      hatchFail: token("--hatch-fail", "#844"),
      neutral: token("--bar-fill", "#888"),
      stale: token("--cell-done", "#999"),
      border: token("--border", "#8884"),
      strong: token("--border-strong", "#8888"),
      subtle: token("--fg-subtle", "#888"),
      muted: token("--fg-muted", "#aaa"),
      active: token("--bg-active", "#8882"),
      bg: token("--bg", "#111"),
      warn: token("--warn", "#da3"),
      ok: token("--ok", "#4a4"),
    };
    ctx.clearRect(0, 0, layout.width, layout.height);
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "alphabetic";
    for (const tick of layout.ticks) {
      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(tick.x, layout.axisHeight);
      ctx.lineTo(tick.x, layout.height);
      ctx.stroke();
      if (tick.label !== null) {
        ctx.fillStyle = colors.subtle;
        ctx.textAlign = tick.label === "0" ? "start" : "center";
        ctx.fillText(tick.label, tick.x, 11);
      }
    }
    const hatch = (x: number, y: number, w: number, h: number, a: string, b: string, angle: number) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = b;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = a;
      ctx.lineWidth = 2;
      const step = 4;
      for (let s = -h; s < w + h; s += step) {
        ctx.beginPath();
        if (angle === 45) {
          ctx.moveTo(x + s, y + h);
          ctx.lineTo(x + s + h, y);
        } else {
          ctx.moveTo(x + s, y);
          ctx.lineTo(x + s + h, y + h);
        }
        ctx.stroke();
      }
      ctx.restore();
    };
    ctx.font = "500 11px sans-serif";
    for (const phase of layout.phases) {
      ctx.fillStyle = phase.planned ? colors.subtle : colors.muted;
      ctx.textAlign = "start";
      ctx.fillText(phase.label, 0, phase.y + Math.min(phase.height, 16) / 2 + 4);
      for (const row of phase.rows) {
        if (row.kind === "band") {
          for (const cell of row.cells) {
            ctx.globalAlpha = 0.25 + 0.75 * cell.alpha;
            ctx.fillStyle = cell.live ? colors.work : colors.done;
            ctx.fillRect(cell.x0, row.y, Math.max(1, cell.x1 - cell.x0), layout.laneHeight);
          }
          ctx.globalAlpha = 1;
          continue;
        }
        if (props.selectedId === row.id) {
          ctx.fillStyle = colors.active;
          ctx.fillRect(layout.gutter - 4, row.y - 2.5, layout.width - layout.gutter + 4, layout.laneHeight + 5);
        }
        if (row.placeholder) {
          ctx.strokeStyle = colors.strong;
          ctx.setLineDash(row.placeholder === "planned" ? [2, 2] : []);
          ctx.strokeRect(layout.endX + 4, row.y, 22, layout.laneHeight);
          ctx.setLineDash([]);
        }
        for (const segment of row.segments) {
          const w = Math.max(2, segment.x1 - segment.x0);
          if (segment.fill === "fail") hatch(segment.x0, row.y, w, layout.laneHeight, colors.danger, colors.hatchFail, 45);
          else {
            ctx.fillStyle = segment.fill === "done" ? colors.done : segment.fill === "work" ? colors.work : segment.fill === "stale" ? colors.stale : colors.neutral;
            ctx.fillRect(segment.x0, row.y, w, layout.laneHeight);
          }
          if (segment.cross) {
            ctx.strokeStyle = colors.bg;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(segment.x1 - 7, row.y + 2);
            ctx.lineTo(segment.x1 - 3, row.y + layout.laneHeight - 2);
            ctx.moveTo(segment.x1 - 3, row.y + 2);
            ctx.lineTo(segment.x1 - 7, row.y + layout.laneHeight - 2);
            ctx.stroke();
          }
        }
        if (row.quiet) hatch(row.quiet.x0, row.y, Math.max(1, row.quiet.x1 - row.quiet.x0), layout.laneHeight, colors.work, colors.bg, 135);
      }
    }
    ctx.font = "10px sans-serif";
    if (layout.plannedNote) {
      ctx.fillStyle = colors.subtle;
      ctx.textAlign = "end";
      ctx.fillText("planned, not scheduled yet", layout.plannedNote.x, layout.plannedNote.y);
    }
    for (const marker of layout.markers) {
      ctx.strokeStyle = colors.warn;
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(marker.x, layout.axisHeight + 14);
      ctx.lineTo(marker.x, layout.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.warn;
      ctx.fillRect(marker.x - 6, layout.axisHeight + 1, 12, 12);
    }
    ctx.strokeStyle = layout.finished ? colors.ok : layout.stale ? colors.strong : colors.work;
    ctx.lineWidth = 1;
    ctx.setLineDash(layout.finished ? [] : [3, 2]);
    ctx.beginPath();
    ctx.moveTo(layout.endX, layout.axisHeight - 2);
    ctx.lineTo(layout.endX, layout.height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "500 10px sans-serif";
    ctx.fillStyle = layout.finished ? colors.ok : layout.stale ? colors.subtle : colors.work;
    ctx.textAlign = "end";
    ctx.fillText(layout.endLabel, layout.endX - 4, 11);
  }, [layout, props.selectedId]);
  const onClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    for (const phase of layout.phases) {
      for (const row of phase.rows) {
        if (row.kind === "lane" && !row.placeholder && y >= row.y - 1.25 && y <= row.y + layout.laneHeight + 1.25) {
          props.onLane(row.id);
          return;
        }
      }
    }
  };
  const style: CSSProperties = { width: layout.width, height: layout.height, maxWidth: "100%" };
  return <canvas ref={ref} role="img" aria-label={timelineLabel(props.run)} className="block cursor-pointer" style={style} onClick={onClick} data-lanes={layout.lanes} />;
}
