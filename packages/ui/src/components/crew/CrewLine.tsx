import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { durationText, runLive, summaryLine, type AgentVM, type RunVM, type SummaryChip } from "../../model/crew.js";
import { CaretDownIcon, CaretUpIcon, CheckCircleIcon, CircleDashedIcon, ClockCounterClockwiseIcon, HourglassIcon, MinusCircleIcon, ShieldWarningIcon, StopCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { IconButton, Spinner, cn } from "../ui/primitives.js";
import { RollingDigits } from "../ui/sourced.js";
import { Strip } from "./Strip.js";
import { Ticking } from "./Ticking.js";

export interface CrewLineProps {
  readonly run: RunVM;
  readonly expanded: boolean;
  readonly selected?: boolean;
  readonly folded?: boolean;
  readonly className?: string;
  onToggle(): void;
  onChip?(kind: SummaryChip["kind"]): void;
}

const NUMERIC_RUN_TOKEN = /(\d+)/g;

export function rolling(text: string): ReactNode {
  const parts = text.split(NUMERIC_RUN_TOKEN);
  if (parts.length <= 1) {
    return text;
  }
  return parts.map((segment, index) => {
    const isDigits = segment.length > 0 && /^\d+$/.test(segment);
    if (!isDigits) {
      return segment;
    }
    return <RollingDigits key={`num-roll-${index}-${segment}`} value={segment} />;
  });
}

interface ChipSpec {
  readonly toneClass: string;
  readonly renderGlyph: (glyphSize: number) => ReactNode;
}

const SUMMARY_CHIP_SPECS: Readonly<Record<SummaryChip["kind"], ChipSpec>> = Object.freeze({
  needs: {
    toneClass: "need",
    renderGlyph: (px) => <ShieldWarningIcon size={px} />,
  },
  failed: {
    toneClass: "fail",
    renderGlyph: (px) => <WarningCircleIcon size={px} />,
  },
  "no-update": {
    toneClass: "quiet",
    renderGlyph: (px) => <CircleDashedIcon size={px} />,
  },
  stale: {
    toneClass: "stale",
    renderGlyph: (px) => <ClockCounterClockwiseIcon size={px} />,
  },
  skipped: {
    toneClass: "quiet",
    renderGlyph: (px) => <MinusCircleIcon size={px} />,
  },
  "run-failed": {
    toneClass: "fail",
    renderGlyph: (px) => <WarningCircleIcon size={px} />,
  },
});

export function LineChip({ chip, onClick }: { chip: SummaryChip; onClick?: () => void }) {
  const spec = SUMMARY_CHIP_SPECS[chip.kind];
  const renderedContent = (
    <>
      {spec.renderGlyph(12)}
      <span className="lbl">{rolling(chip.text)}</span>
    </>
  );
  const compositeClass = cn("crew-chip", spec.toneClass);

  if (!onClick) {
    return <span className={compositeClass}>{renderedContent}</span>;
  }

  const handleChipClick = (evt: MouseEvent) => {
    evt.stopPropagation();
    onClick();
  };

  return (
    <button
      type="button"
      className={compositeClass}
      aria-label={chip.text}
      onClick={handleChipClick}
    >
      {renderedContent}
    </button>
  );
}

function resolveLeadVisual(run: RunVM): { toneName: string; visualNode: ReactNode } {
  if (run.stale) {
    return { toneName: "mute", visualNode: <ClockCounterClockwiseIcon size={15} /> };
  }
  if (runLive(run)) {
    return { toneName: "work", visualNode: <Spinner size={12} /> };
  }
  if (run.status === "stopped") {
    return { toneName: "mute", visualNode: <StopCircleIcon size={15} /> };
  }
  if (run.status === "failed" || run.counts.failed > 0) {
    return { toneName: "fail", visualNode: <WarningCircleIcon size={15} /> };
  }
  if (run.counts.skipped + run.counts.unknown > 0) {
    return { toneName: "mute", visualNode: <MinusCircleIcon size={15} /> };
  }
  return { toneName: "ok", visualNode: <CheckCircleIcon size={15} /> };
}

function RunLeadGlyph({ run }: { run: RunVM }) {
  const { toneName, visualNode } = resolveLeadVisual(run);
  return (
    <span className={cn("crew-g", toneName)} aria-hidden="true">
      {visualNode}
    </span>
  );
}

function ProgressDisplay({ run, summary }: { run: RunVM; summary: string }) {
  const isStarting = run.status === "starting";
  if (isStarting) {
    return (
      <span className="prog">
        Starting · <b>no agents scheduled yet</b>
      </span>
    );
  }
  const pivot = summary.indexOf(" · ");
  const leadingWord = pivot >= 0 ? summary.slice(0, pivot) : summary;
  const trailingWord = pivot >= 0 ? summary.slice(pivot + 3) : "";

  const isLivePlanned = run.status === "running" && run.plannedKnown;
  if (isLivePlanned) {
    return (
      <span className="prog">
        <span className="word">{leadingWord} · </span>
        <b>{rolling(trailingWord)}</b>
      </span>
    );
  }

  return (
    <span className="prog">
      <b>{rolling(leadingWord)}</b>
      {trailingWord ? <> · {rolling(trailingWord)}</> : null}
    </span>
  );
}

function executeToggleOnActivation(event: KeyboardEvent, toggleFn: () => void): void {
  const isTriggerKey = event.key === "Enter" || event.key === " ";
  if (isTriggerKey) {
    event.preventDefault();
    toggleFn();
  }
}

export function CrewLine({
  run,
  expanded,
  selected = false,
  onToggle,
  onChip,
  folded = false,
  className,
}: CrewLineProps) {
  const lineSummary = summaryLine(run);
  const activeExecution = runLive(run);
  const phaseMatrix = run.phases.map((ph) => ph.agents.map((ag) => ag.state));

  const accessibleSegments = [
    run.name,
    lineSummary.progress,
    lineSummary.chips.length > 0 ? lineSummary.chips.map((ch) => ch.text).join(", ") : null,
    lineSummary.elapsed || null,
  ].filter((item): item is string => Boolean(item));

  const accessibilityLabel = accessibleSegments.join(", ");
  const isStarting = run.status === "starting";

  return (
    <div
      role="button"
      aria-label={accessibilityLabel}
      aria-expanded={expanded}
      tabIndex={selected ? 0 : -1}
      className={cn("crew-line", run.stale && "stale", folded && "folded", className)}
      data-crew-focus="line"
      data-run={run.itemId}
      onClick={onToggle}
      onKeyDown={(evt) => executeToggleOnActivation(evt, onToggle)}
    >
      <RunLeadGlyph run={run} />
      <span className={cn("name")}>{run.name}</span>
      {!isStarting && (
        <Strip
          groups={phaseMatrix}
          size="sm"
          finale={!activeExecution}
          stale={run.stale}
          more={activeExecution && !run.plannedKnown}
          decorative
        />
      )}
      <ProgressDisplay run={run} summary={lineSummary.progress} />
      <span className="min-w-0 flex-1" />
      {lineSummary.chips.map((chip) => {
        const chipAction = onChip && chip.kind !== "stale" ? () => onChip(chip.kind) : undefined;
        return <LineChip key={chip.kind} chip={chip} onClick={chipAction} />;
      })}
      <span className="crew-el">
        {run.stale ? (
          lineSummary.elapsed
        ) : (
          <Ticking
            ms={run.elapsedMs}
            at={run.clockAt}
            live={activeExecution}
            approx={Boolean(run.elapsedApprox && activeExecution)}
          />
        )}
      </span>
      {!folded && (
        <span className="car" aria-hidden="true">
          {expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
        </span>
      )}
    </div>
  );
}

export interface TaskLineProps {
  readonly task: AgentVM;
  readonly clockAt: number;
  readonly expanded: boolean;
  readonly selected?: boolean;
  readonly readOnly?: boolean;
  readonly className?: string;
  onToggle(): void;
  onStop(): void;
}

const ACTIVE_TASK_STATES: ReadonlySet<AgentVM["state"]> = new Set([
  "working",
  "no-update",
  "waiting-on-you",
  "scheduled",
  "finishing",
]);

export function taskLive(task: Pick<AgentVM, "state">): boolean {
  return ACTIVE_TASK_STATES.has(task.state);
}

function resolveTaskOutcome(
  task: AgentVM,
  info: AgentVM["taskInfo"] | null,
): { tailOutput: ReactNode; outcomeTone: string } {
  switch (task.state) {
    case "failed": {
      const failureReason = task.failure?.text ?? "no reason reported";
      return { tailOutput: `failed · ${failureReason}`, outcomeTone: "fail" };
    }
    case "done":
      return { tailOutput: "finished · no failure reported", outcomeTone: "ok" };
    case "skipped":
      return { tailOutput: "stopped", outcomeTone: "" };
    case "waiting-on-you": {
      const promptText = task.needs?.command ? `waiting for you · ${task.needs.command}` : "waiting for you";
      return { tailOutput: promptText, outcomeTone: "" };
    }
    default: {
      const defaultText = info?.tail ?? task.task?.text ?? "Running…";
      return { tailOutput: defaultText, outcomeTone: "" };
    }
  }
}

function TaskStateGlyph({ state }: { state: AgentVM["state"] }) {
  if (state === "failed") {
    return (
      <span className="crew-g fail" aria-hidden="true">
        <WarningCircleIcon size={15} />
      </span>
    );
  }
  if (state === "done") {
    return (
      <span className="crew-g ok" aria-hidden="true">
        <CheckCircleIcon size={15} />
      </span>
    );
  }
  if (state === "skipped" || state === "unknown") {
    return (
      <span className="crew-g mute" aria-hidden="true">
        <StopCircleIcon size={15} />
      </span>
    );
  }
  if (state === "waiting-on-you") {
    return (
      <span className="crew-g need" aria-hidden="true">
        <ShieldWarningIcon size={15} />
      </span>
    );
  }
  return (
    <span className="crew-g work" aria-hidden="true">
      <Spinner size={12} />
    </span>
  );
}

export function TaskLine({
  task,
  clockAt,
  expanded,
  selected = false,
  readOnly = false,
  className,
  onToggle,
  onStop,
}: TaskLineProps) {
  const isLive = taskLive(task);
  const taskDetails = task.taskInfo ?? null;
  const renderedCommand = taskDetails?.command ?? task.name;
  const { tailOutput, outcomeTone } = resolveTaskOutcome(task, taskDetails);
  const trackingDuration = isLive ? task.runningMs : task.durationMs;
  const isStopping = task.pending === "stop";

  const taskTypeDescriptor = task.kind === "subagent" ? "Subagent" : "Background task";
  const ariaDescription = `${taskTypeDescriptor} ${renderedCommand}, ${typeof tailOutput === "string" ? tailOutput : ""}`;

  const handleStopExecution = (e: MouseEvent) => {
    e.stopPropagation();
    onStop();
  };

  const hasNoUpdate = task.state === "no-update" && task.silenceMs !== null;

  return (
    <div
      role="button"
      aria-label={ariaDescription}
      aria-expanded={expanded}
      tabIndex={selected ? 0 : -1}
      data-crew-focus="line"
      data-agent-id={task.id}
      className={cn("crew-line task", className)}
      onClick={onToggle}
      onKeyDown={(evt) => executeToggleOnActivation(evt, onToggle)}
    >
      <TaskStateGlyph state={task.state} />
      <span className="cmd">{renderedCommand}</span>
      <span className={cn("tail", outcomeTone)}>{isStopping ? "Stopping…" : tailOutput}</span>
      {hasNoUpdate ? (
        <span className="crew-tag">
          <HourglassIcon size={11} />
          No output for {durationText(task.silenceMs)}
        </span>
      ) : null}
      {trackingDuration !== null ? (
        <span className="crew-el">
          <Ticking ms={trackingDuration} at={clockAt} live={isLive} />
        </span>
      ) : null}
      {isLive && !readOnly && !isStopping && (
        <IconButton
          size="xs"
          label={`Stop ${renderedCommand}`}
          className="text-subtle"
          onClick={handleStopExecution}
        ><StopCircleIcon size={14} /></IconButton>
      )}
      <span className="car" aria-hidden="true">
        {expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
      </span>
    </div>
  );
}

export function MoreLine({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className="crew-line more"
      data-crew-focus="line"
      tabIndex={-1}
      onClick={onClick}
    >
      <span className="crew-g" aria-hidden="true" />
      <span>+{count} more</span>
    </button>
  );
}
