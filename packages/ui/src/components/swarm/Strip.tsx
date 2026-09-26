import { memo, type CSSProperties, type ReactNode } from "react";
import { cn } from "../ui/primitives.js";

/**
 * The cell strip: one cell per agent, grouped by phase, in the sidebar row, the collapsed line, the phase
 * rail and the Activity drawer. Colour never stands alone: every state has its own shape, the strip carries
 * a text equivalent, and past 48 cells a phase becomes a proportional bar so the DOM stays small.
 */

/**
 * One agent's state as the strip draws it: the `AgentState` union of model/swarm.ts (workstream A), kept
 * local so the kit ships before the model does. The view-model maps onto it one to one.
 */
export type StripCell =
  | "planned"
  | "scheduled"
  | "working"
  | "finishing"
  | "no-update"
  | "waiting-on-you"
  | "failed"
  | "skipped"
  | "done"
  | "unknown";

/** `sm` is the collapsed line (6×12), `xs` the sidebar and narrow lines (3×8), `md` the head (8×14); `rail` stretches to a phase segment, 8 px tall. */
export type StripSize = "xs" | "sm" | "md" | "rail";

export interface StripProps {
  /** One array per phase, agents in schedule order. An empty phase draws nothing. */
  groups: readonly (readonly StripCell[])[];
  size?: StripSize;
  /** The run ended: done cells turn ok. */
  finale?: boolean;
  /** Play the one sheen along the done cells. Finale only; reduced motion skips it. */
  sheen?: boolean;
  /** The feed is not live: the accent leaves, and what was live reads as last known. */
  stale?: boolean;
  /** The plan is unknown: a trailing dashed cell says more agents may start. */
  more?: boolean;
  /** Past this many agents a phase becomes a proportional bar (48); with `bin: "run"` the whole strip does (the sidebar's 24). */
  binAt?: number;
  bin?: "phase" | "run";
  /** A bar's width in px (the sidebar's 72). A rail bar stretches instead. */
  binWidth?: number;
  /** The text equivalent; `stripLabel` when absent. */
  label?: string;
  /** The text lives beside the strip already (a rail segment's label), so the strip is hidden from readers. */
  decorative?: boolean;
  className?: string;
}

export interface StripCounts {
  total: number;
  done: number;
  /** Working and finishing: both still run. */
  working: number;
  quiet: number;
  need: number;
  failed: number;
  skipped: number;
  unknown: number;
  scheduled: number;
  planned: number;
}

/** The cell vocabulary: the class each state draws with (theme.css `.swarm-cell`). */
const CELL: Record<StripCell, string> = {
  planned: "planned",
  scheduled: "pending",
  working: "work",
  finishing: "finishing",
  "no-update": "quiet",
  "waiting-on-you": "need",
  failed: "fail",
  skipped: "stop",
  done: "done",
  unknown: "unknown",
};

const COUNT: Record<StripCell, keyof Omit<StripCounts, "total">> = {
  planned: "planned",
  scheduled: "scheduled",
  working: "working",
  finishing: "working",
  "no-update": "quiet",
  "waiting-on-you": "need",
  failed: "failed",
  skipped: "skipped",
  done: "done",
  unknown: "unknown",
};

export function stripCounts(groups: readonly (readonly StripCell[])[]): StripCounts {
  const counts: StripCounts = { total: 0, done: 0, working: 0, quiet: 0, need: 0, failed: 0, skipped: 0, unknown: 0, scheduled: 0, planned: 0 };
  for (const cells of groups) {
    for (const cell of cells) {
      counts.total++;
      counts[COUNT[cell]]++;
    }
  }
  return counts;
}

/** What a reader hears for the strip: the counts, attention before momentum, never a bare number. */
export function stripLabel(groups: readonly (readonly StripCell[])[], options: { stale?: boolean; more?: boolean } = {}): string {
  const counts = stripCounts(groups);
  if (counts.total === 0) return options.more ? "No agents scheduled yet, more may start" : "No agents scheduled yet";
  const phases = groups.filter((cells) => cells.length > 0).length;
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.need > 0) parts.push(`${counts.need} ${counts.need === 1 ? "needs" : "need"} you`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.quiet > 0) parts.push(`${counts.quiet} no update`);
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.scheduled > 0) parts.push(`${counts.scheduled} queued`);
  if (counts.planned > 0) parts.push(`${counts.planned} planned`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} ${counts.unknown === 1 ? "outcome" : "outcomes"} not reported`);
  if (options.more) parts.push("more may start");
  const head = `${counts.total} ${counts.total === 1 ? "agent" : "agents"}${phases > 1 ? ` in ${phases} phases` : ""}${options.stale ? ", last known" : ""}`;
  return `${head}: ${parts.join(", ")}`;
}

/** A proportional bar for a phase too big for cells: done, working, no update, needs you, failed, skipped, not reported, pending. */
function Bin({ cells, stale, width }: { cells: readonly StripCell[]; stale: boolean; width: number | undefined }) {
  const counts = stripCounts([cells]);
  const parts: [string, number][] = [
    ["done", counts.done],
    ["work", counts.working],
    ["quiet", counts.quiet],
    ["need", counts.need],
    ["fail", counts.failed],
    ["stop", counts.skipped],
    ["unknown", counts.unknown],
    ["pending", counts.scheduled + counts.planned],
  ];
  const style = width === undefined ? undefined : ({ "--bw": `${width}px` } as CSSProperties);
  return (
    <span className={cn("swarm-bin", stale && "stale")} style={style}>
      {parts.filter(([, count]) => count > 0).map(([kind, count]) => (
        <span key={kind} className={kind} style={{ width: `${((count / counts.total) * 100).toFixed(1)}%` }} />
      ))}
    </span>
  );
}

function sameGroups(before: StripProps["groups"], after: StripProps["groups"]): boolean {
  return before.length === after.length && before.every((cells, i) => cells.length === after[i].length && cells.every((cell, j) => cell === after[i][j]));
}

// A live run re-sends the whole strip on every revision, but only the changed cell needs drawing again.
export const Strip = memo(function Strip({
  groups,
  size = "sm",
  finale = false,
  sheen = false,
  stale = false,
  more = false,
  binAt = 48,
  bin = "phase",
  binWidth,
  label,
  decorative = false,
  className,
}: StripProps) {
  const phases = groups.filter((cells) => cells.length > 0);
  const total = phases.reduce((count, cells) => count + cells.length, 0);
  const cell = (kind: string, key: number): ReactNode => <span key={key} className={cn("swarm-cell", kind, stale && "stale")} />;
  const text = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label ?? stripLabel(groups, { stale, more }) };
  return (
    <span
      {...text}
      className={cn("swarm-strip", size !== "sm" && size, finale && "finale", stale && "stale", finale && sheen && "swarm-sheen", className)}
    >
      {bin === "run" && total > binAt ? (
        <Bin cells={phases.flat()} stale={stale} width={binWidth} />
      ) : (
        phases.map((cells, i) =>
          cells.length > binAt ? (
            <Bin key={i} cells={cells} stale={stale} width={binWidth} />
          ) : (
            <span key={i} className="swarm-phase">{cells.map((state, j) => cell(CELL[state], j))}</span>
          ),
        )
      )}
      {more ? <span className="swarm-phase">{cell("more", 0)}</span> : null}
    </span>
  );
}, (before, after) => (Object.keys({ ...before, ...after }) as (keyof StripProps)[]).every((key) => (key === "groups" ? sameGroups(before.groups, after.groups) : Object.is(before[key], after[key]))));
