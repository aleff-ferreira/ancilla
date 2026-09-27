import type { ReactNode } from "react";
import { useNow } from "../../app/context.js";
import { formatTokens } from "../../model/format.js";
import { formatCost } from "../../model/pricing.js";
import { aboutText, durationText, runLive, type RunVM } from "../../model/swarm.js";
import { cn } from "../ui/primitives.js";
import { RollingDigits } from "../ui/sourced.js";
import { clockMinutes } from "./panel.js";
import { Pulse } from "./Pulse.js";

export interface KpiStripProps {
  run: RunVM;
  className?: string;
}

interface Cell {
  key: string;
  label: string;
  /** The figure, rolled when it changes; `—` when absent. */
  value: string;
  /** A unit or qualifier set small beside the figure. */
  unit?: string;
  /** The line under the figure: the breakdown, or the reason the figure is absent. */
  sub: ReactNode;
  /** A sparkline in place of the figure. */
  figure?: ReactNode;
}

/**
 * Six cells that answer "how big, how much, how fast": agents, tokens, cost, slots, pulse and elapsed while the run
 * goes; agents, tokens, cost, wall time, agent time and peak once it ended. `repeat(auto-fit, minmax(126px, 1fr))`
 * puts six across an 800 px panel and three plus three in a 520 one. A figure Muse has not sent is a dash with the
 * reason under it; Slots leaves when the launch reported no policy.
 */
export function KpiStrip(props: KpiStripProps) {
  const { run } = props;
  const live = runLive(run);
  const cells: Cell[] = live ? runningCells(run) : finishedCells(run);
  return (
    <div
      className={cn("mt-2 grid gap-px overflow-hidden rounded-[10px] shadow-[0_0_0_1px_var(--border)]", props.className)}
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(126px, 1fr))" }}
      role="list"
      aria-label="Run figures"
    >
      {cells.map((cell) => (
        // Each cell draws its own hairline ring into the 1 px gaps, so an unfilled slot stays the pane's colour.
        <div key={cell.key} role="listitem" data-kpi={cell.key} className="min-w-0 bg-[var(--pane-bg)] px-2.5 pt-[7px] pb-2 shadow-[0_0_0_1px_var(--border)]">
          <div className="flex items-center gap-1.5 truncate text-2xs text-subtle">{cell.label}</div>
          <div className="mt-px flex h-6 items-baseline gap-1 whitespace-nowrap text-[17px] leading-6 font-semibold tracking-[-0.01em] tabular-nums">
            {cell.figure ?? (
              <>
                {cell.key === "elapsed" && live && !run.stale ? <ElapsedClock run={run} /> : <RollingDigits value={cell.value} className={cn(cell.value === "—" && "text-subtle")} />}
                {cell.unit ? <small className="text-2xs font-medium tracking-normal text-subtle">{cell.unit}</small> : null}
              </>
            )}
          </div>
          <div className="truncate text-2xs text-subtle">{cell.sub}</div>
        </div>
      ))}
    </div>
  );
}

function tokensCell(run: RunVM, live: boolean): Cell {
  const label = live ? "Tokens so far" : "Tokens";
  if (!run.tokens) return { key: "tokens", label, value: "—", sub: "not reported yet" };
  // A research run counts its own tokens; its workers report none, so there is no "of N" to say.
  if (run.research) return { key: "tokens", label, value: formatTokens(run.tokens.total), sub: "the run's own count" };
  const all = run.tokens.reported >= run.tokens.of;
  return { key: "tokens", label, value: formatTokens(run.tokens.total), sub: all ? `all ${run.tokens.of} reported` : `${run.tokens.reported} of ${run.tokens.of} reported` };
}

function costCell(run: RunVM): Cell {
  if (run.cost) return { key: "cost", label: "Est. cost", value: `~${formatCost(run.cost.usd)}`, sub: "at list price" };
  return { key: "cost", label: "Est. cost", value: "—", sub: run.tokens ? "no list price for this model" : "no usage reported yet" };
}

function runningCells(run: RunVM): Cell[] {
  const { counts } = run;
  const scheduled = counts.total - counts.planned;
  const working = counts.working + counts.finishing + counts.noUpdate;
  const cells: Cell[] = [
    {
      key: "agents",
      label: "Agents",
      value: String(scheduled),
      unit: counts.planned > 0 ? `+${counts.planned} planned` : undefined,
      sub: run.plannedKnown || scheduled > 0 ? `${working} working now` : "none scheduled yet",
    },
    tokensCell(run, true),
    costCell(run),
  ];
  if (run.slots) {
    cells.push({ key: "slots", label: "Slots", value: String(run.slots.used), unit: `of ${run.slots.max}`, sub: run.research ? "run config" : "launch policy" });
  }
  const perMinute = run.pulse[run.pulse.length - 1] ?? 0;
  const any = run.pulse.some((bin) => bin > 0);
  cells.push({
    key: "pulse",
    label: "Pulse · 10 min",
    value: String(perMinute),
    figure: <Pulse bins={run.pulse} className="mr-0.5" />,
    sub: any ? `${perMinute} ${perMinute === 1 ? "event" : "events"}/min` : "no events yet",
  });
  if (run.startedAt === null) {
    cells.push({ key: "elapsed", label: "Elapsed", value: "—", sub: "start not loaded" });
  } else {
    cells.push({
      key: "elapsed",
      label: run.stale ? "Last known" : "Elapsed",
      value: run.elapsedApprox ? aboutText(run.elapsedMs ?? 0) : durationText(run.elapsedMs),
      sub: run.stale && run.staleAt !== null ? `at ${clockMinutes(run.staleAt, run.clockAt)}` : run.elapsedApprox ? "start not loaded exactly" : `started ${clockMinutes(run.startedAt, run.clockAt)}`,
    });
  }
  return cells;
}

function finishedCells(run: RunVM): Cell[] {
  const { counts } = run;
  const cells: Cell[] = [
    { key: "agents", label: "Agents", value: String(counts.total), sub: run.retried > 0 ? `${run.retried} retried` : "none retried" },
    tokensCell(run, false),
    costCell(run),
    run.elapsedMs === null
      ? { key: "wall", label: "Wall time", value: "—", sub: "times not loaded" }
      : {
          key: "wall",
          label: "Wall time",
          value: run.elapsedApprox ? aboutText(run.elapsedMs) : durationText(run.elapsedMs),
          sub: run.startedAt !== null && !run.elapsedApprox ? `started ${clockMinutes(run.startedAt, run.clockAt)}` : "start not loaded exactly",
        },
    run.agentTimeMs === null
      ? { key: "agent-time", label: "Agent time", value: "—", sub: "durations not reported" }
      : { key: "agent-time", label: "Agent time", value: durationText(run.agentTimeMs), sub: `across ${counts.total} ${counts.total === 1 ? "agent" : "agents"}` },
    run.peakConcurrency === null
      ? { key: "peak", label: "Peak", value: "—", sub: "times not loaded" }
      : { key: "peak", label: "Peak", value: String(run.peakConcurrency.n), unit: "at once", sub: `during ${run.peakConcurrency.phase}` },
  ];
  return cells;
}

/** The elapsed figure ticks every second on its own, so the rest of the strip is left alone. */
function ElapsedClock(props: { run: RunVM }) {
  const now = useNow(1000);
  const { run } = props;
  const elapsed = (run.elapsedMs ?? 0) + Math.max(0, now - run.clockAt);
  return <RollingDigits value={run.elapsedApprox ? aboutText(elapsed) : durationText(elapsed)} />;
}
