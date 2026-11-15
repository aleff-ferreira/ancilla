import type { ReactNode } from "react";
import { useNow } from "../../app/context.js";
import { formatTokens } from "../../model/format.js";
import { NO_PRICE_REASON, formatCost } from "../../model/pricing.js";
import { aboutText, durationText, reportCoverage, runLive, type RunVM } from "../../model/crew.js";
import { cn } from "../ui/primitives.js";
import { RollingDigits } from "../ui/sourced.js";
import { clockMinutes } from "./panel.js";
import { Pulse } from "./Pulse.js";

export interface KpiStripProps {
  readonly run: RunVM;
  readonly className?: string;
}

export interface Cell {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly sub: ReactNode;
  readonly title?: string;
  readonly figure?: ReactNode;
}

export function tokensCell(run: RunVM, live: boolean): Cell {
  const header = live ? "Tokens so far" : "Tokens";
  if (!run.tokens) {
    return { key: "tokens", label: header, value: "—", sub: "not reported yet" };
  }
  if (run.research) {
    return { key: "tokens", label: header, value: formatTokens(run.tokens.total), sub: "the run's own count" };
  }
  const isFullyReported = run.tokens.reported >= run.tokens.of;
  const statusNote = isFullyReported
    ? `all ${run.tokens.of} reported`
    : `${run.tokens.reported} of ${run.tokens.of} reported`;

  return {
    key: "tokens",
    label: header,
    value: formatTokens(run.tokens.total),
    sub: statusNote,
  };
}

export function costCell(run: RunVM): Cell {
  const coverageNote = reportCoverage(run);
  if (run.cost) {
    const subtitle = coverageNote ? `at list price · ${coverageNote}` : "at list price";
    return {
      key: "cost",
      label: "Est. cost",
      value: `~${formatCost(run.cost.usd)}`,
      sub: subtitle,
    };
  }

  const baseMissingCell = { key: "cost", label: "Est. cost", value: "—" };

  if (!run.tokens) {
    return { ...baseMissingCell, sub: "no usage reported yet" };
  }

  if (run.mixedModels) {
    return {
      ...baseMissingCell,
      sub: "Mixed models",
      title: "The roles of this run ran on different models, so no single list price applies.",
    };
  }

  if (run.priceModel) {
    return {
      ...baseMissingCell,
      sub: `no list price for ${run.priceModel}`,
      title: `${run.priceModel}: ${NO_PRICE_REASON}`,
    };
  }

  return {
    ...baseMissingCell,
    sub: "model not resolved",
    title: "Neither the run nor the thread names the model it ran on.",
  };
}

function resolvePulseDetails(pulseBins: readonly number[]): { rate: number; descriptor: string } {
  const latestCount = pulseBins[pulseBins.length - 1] ?? 0;
  const hasActivity = pulseBins.some((vol) => vol > 0);
  const eventUnit = latestCount === 1 ? "event" : "events";
  const descriptor = hasActivity ? `${latestCount} ${eventUnit}/min` : "no events yet";
  return { rate: latestCount, descriptor };
}

function resolveRunningElapsedSub(run: RunVM): string {
  if (run.stale && run.staleAt !== null) {
    return `at ${clockMinutes(run.staleAt, run.clockAt)}`;
  }
  if (run.elapsedApprox) {
    return "start not loaded exactly";
  }
  return `started ${clockMinutes(run.startedAt ?? run.clockAt, run.clockAt)}`;
}

function buildTurnKpiCells(run: RunVM, live: boolean): Cell[] {
  const allTasks = run.agents.filter((ag) => ag.kind === "task");
  const finishedTasks = allTasks.filter((ag) => ag.state === "done");
  const timingSub = run.elapsedMs === null ? "timing not reported" : run.stale ? "last known" : "this prompt";
  const tokenMetric = tokensCell(run, live);

  return [
    {
      key: "tools",
      label: "Tools",
      value: String(allTasks.length),
      sub: `${finishedTasks.length} completed`,
    },
    tokenMetric,
    {
      key: "elapsed",
      label: live ? "Elapsed" : "Wall time",
      value: durationText(run.elapsedMs),
      sub: timingSub,
    },
  ];
}

function assembleSlotsCell(run: RunVM): Cell | null {
  if (!run.slots) return null;
  const slotContext = run.research ? "run config" : "launch policy";
  return {
    key: "slots",
    label: "Slots",
    value: String(run.slots.used),
    unit: `of ${run.slots.max}`,
    sub: slotContext,
  };
}

function assemblePulseCell(run: RunVM): Cell {
  const { rate, descriptor } = resolvePulseDetails(run.pulse);
  return {
    key: "pulse",
    label: "Pulse · 10 min",
    value: String(rate),
    figure: <Pulse bins={run.pulse} className="mr-0.5" />,
    sub: descriptor,
  };
}

function assembleElapsedRunningCell(run: RunVM): Cell {
  const hasNoStartTime = run.startedAt === null;
  if (hasNoStartTime) {
    return { key: "elapsed", label: "Elapsed", value: "—", sub: "start not loaded" };
  }
  const elapsedText = run.elapsedApprox ? aboutText(run.elapsedMs ?? 0) : durationText(run.elapsedMs);
  const elapsedHeader = run.stale ? "Last known" : "Elapsed";
  return {
    key: "elapsed",
    label: elapsedHeader,
    value: elapsedText,
    sub: resolveRunningElapsedSub(run),
  };
}

function buildRunningKpiCells(run: RunVM): Cell[] {
  const stats = run.counts;
  const scheduledCount = stats.total - stats.planned;
  const activeCount = stats.working + stats.finishing + stats.noUpdate;
  const agentSub = run.plannedKnown || scheduledCount > 0 ? `${activeCount} working now` : "none scheduled yet";
  const agentUnit = stats.planned > 0 ? `+${stats.planned} planned` : undefined;

  const agentCell: Cell = {
    key: "agents",
    label: "Agents",
    value: String(scheduledCount),
    unit: agentUnit,
    sub: agentSub,
  };

  const tokenCell = tokensCell(run, true);
  const costMetric = costCell(run);
  const optionalSlots = assembleSlotsCell(run);
  const pulseCell = assemblePulseCell(run);
  const elapsedCell = assembleElapsedRunningCell(run);

  const resultList: Cell[] = [agentCell, tokenCell, costMetric];
  if (optionalSlots) {
    resultList.push(optionalSlots);
  }
  resultList.push(pulseCell, elapsedCell);
  return resultList;
}

function assembleWallTimeCell(run: RunVM): Cell {
  if (run.elapsedMs === null) {
    return { key: "wall", label: "Wall time", value: "—", sub: "times not loaded" };
  }
  const wallSub = run.startedAt !== null && !run.elapsedApprox
    ? `started ${clockMinutes(run.startedAt, run.clockAt)}`
    : "start not loaded exactly";
  const durationSummary = run.elapsedApprox ? aboutText(run.elapsedMs) : durationText(run.elapsedMs);
  return {
    key: "wall",
    label: "Wall time",
    value: durationSummary,
    sub: wallSub,
  };
}

function assembleAgentTimeCell(run: RunVM): Cell {
  const totalAgents = run.counts.total;
  if (run.agentTimeMs === null) {
    return { key: "agent-time", label: "Agent time", value: "—", sub: "durations not reported" };
  }
  const pluralSuffix = totalAgents === 1 ? "agent" : "agents";
  return {
    key: "agent-time",
    label: "Agent time",
    value: durationText(run.agentTimeMs),
    sub: `across ${totalAgents} ${pluralSuffix}`,
  };
}

function assemblePeakConcurrencyCell(run: RunVM): Cell {
  const peakData = run.peakConcurrency;
  if (!peakData) {
    return { key: "peak", label: "Peak", value: "—", sub: "times not loaded" };
  }
  return {
    key: "peak",
    label: "Peak",
    value: String(peakData.n),
    unit: "at once",
    sub: `during ${peakData.phase}`,
  };
}

function buildFinishedKpiCells(run: RunVM): Cell[] {
  const stats = run.counts;
  const retrySub = run.retried > 0 ? `${run.retried} retried` : "none retried";
  const tokenCell = tokensCell(run, false);
  const costMetric = costCell(run);
  const wallCell = assembleWallTimeCell(run);
  const agentTimeCell = assembleAgentTimeCell(run);
  const peakCell = assemblePeakConcurrencyCell(run);

  return [
    { key: "agents", label: "Agents", value: String(stats.total), sub: retrySub },
    tokenCell,
    costMetric,
    wallCell,
    agentTimeCell,
    peakCell,
  ];
}

function ActiveElapsedCounter({ run }: { run: RunVM }) {
  const currentTime = useNow(1000);
  const timeOffset = Math.max(0, currentTime - run.clockAt);
  const totalElapsed = (run.elapsedMs ?? 0) + timeOffset;
  const formattedTime = run.elapsedApprox ? aboutText(totalElapsed) : durationText(totalElapsed);
  return <RollingDigits value={formattedTime} />;
}

function KpiCellCard({ cell, isLive, run }: { cell: Cell; isLive: boolean; run: RunVM }) {
  const isLiveElapsed = cell.key === "elapsed" && isLive && !run.stale;
  const isMissingFigure = cell.value === "—";
  const tooltipText = cell.title ?? (typeof cell.sub === "string" ? cell.sub : undefined);

  return (
    <div
      key={cell.key}
      role="listitem"
      data-kpi={cell.key}
      className="min-w-0 bg-[var(--pane-bg)] px-2.5 pt-[7px] pb-2 shadow-[0_0_0_1px_var(--border)]"
    >
      <div className={cn("flex items-center gap-1.5 truncate text-2xs text-subtle")}>{cell.label}</div>
      <div className={cn("mt-px flex h-6 items-baseline gap-1 whitespace-nowrap text-[17px] leading-6 font-semibold tracking-[-0.01em] tabular-nums")}>
        {cell.figure ? (
          cell.figure
        ) : (
          <>
            {isLiveElapsed ? (
              <ActiveElapsedCounter run={run} />
            ) : (
              <RollingDigits value={cell.value} className={cn(isMissingFigure && "text-subtle")} />
            )}
            {cell.unit && (
              <small className="text-2xs font-medium tracking-normal text-subtle">{cell.unit}</small>
            )}
          </>
        )}
      </div>
      <div className="line-clamp-2 break-words text-2xs text-subtle" title={tooltipText}>
        {cell.sub}
      </div>
    </div>
  );
}

export function KpiStrip(props: KpiStripProps) {
  const runData = props.run;
  const isExecutionLive = runLive(runData);

  const displayedCells = runData.kind === "turn"
    ? buildTurnKpiCells(runData, isExecutionLive)
    : isExecutionLive
      ? buildRunningKpiCells(runData)
      : buildFinishedKpiCells(runData);

  const stripContainerStyle = { gridTemplateColumns: "repeat(auto-fit, minmax(126px, 1fr))" };
  const stripCompositeClass = cn("mt-2 grid gap-px overflow-hidden rounded-[10px] shadow-[0_0_0_1px_var(--border)]", props.className);

  return (
    <div
      role="list"
      aria-label="Run figures"
      className={stripCompositeClass}
      style={stripContainerStyle}
    >
      {displayedCells.map((item) => (
        <KpiCellCard key={item.key} cell={item} isLive={isExecutionLive} run={runData} />
      ))}
    </div>
  );
}
