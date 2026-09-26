import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { durationText, runLive, summaryLine, type AgentVM, type RunVM, type SummaryChip } from "../../model/swarm.js";
import {
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  ClockCounterClockwiseIcon,
  HourglassIcon,
  MinusCircleIcon,
  ShieldWarningIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "../ui/icons.js";
import { IconButton, Spinner, cn } from "../ui/primitives.js";
import { RollingDigits } from "../ui/sourced.js";
import { Strip } from "./Strip.js";
import { Ticking } from "./Ticking.js";

/**
 * The collapsed Swarm card: one 44 px line per run or task that answers, left to right, whether everything is fine,
 * what needs you and how far along it is (SPEC §6). Chips appear only when something needs attention.
 */

export interface SwarmLineProps {
  run: RunVM;
  expanded: boolean;
  /** The line holds the card's roving tab stop. */
  selected?: boolean;
  onToggle: () => void;
  /** A chip was clicked: the card expands and lands on the first row of that kind. */
  onChip?: (kind: SummaryChip["kind"]) => void;
  /** A line kept beside an expanded card (another run) folds the caret away. */
  folded?: boolean;
}

/** Digits in a phrase roll when they change; the words around them stay put. */
export function rolling(text: string): ReactNode {
  return text.split(/(\d+)/).map((part, index) => (/^\d+$/.test(part) ? <RollingDigits key={index} value={part} /> : part));
}

const CHIP_ICON: Record<SummaryChip["kind"], ReactNode> = {
  needs: <ShieldWarningIcon size={12} />,
  failed: <WarningCircleIcon size={12} />,
  "no-update": <CircleDashedIcon size={12} />,
  stale: <ClockCounterClockwiseIcon size={12} />,
  skipped: <MinusCircleIcon size={12} />,
  "run-failed": <WarningCircleIcon size={12} />,
};

const CHIP_TONE: Record<SummaryChip["kind"], string> = {
  needs: "need",
  failed: "fail",
  "no-update": "quiet",
  stale: "stale",
  skipped: "quiet",
  "run-failed": "fail",
};

export function LineChip(props: { chip: SummaryChip; onClick?: () => void }) {
  const inner = (
    <>
      {CHIP_ICON[props.chip.kind]}
      <span className="lbl">{rolling(props.chip.text)}</span>
    </>
  );
  const className = cn("swarm-chip", CHIP_TONE[props.chip.kind]);
  if (!props.onClick) return <span className={className}>{inner}</span>;
  return (
    <button
      type="button"
      className={className}
      aria-label={props.chip.text}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        props.onClick?.();
      }}
    >
      {inner}
    </button>
  );
}

/** The line's lead glyph: the ring while live, the outcome once it ended, the clock when the feed is not live. */
function LeadGlyph({ run }: { run: RunVM }) {
  if (run.stale) return <span className="swarm-g mute" aria-hidden="true"><ClockCounterClockwiseIcon size={15} /></span>;
  if (runLive(run)) return <span className="swarm-g work" aria-hidden="true"><Spinner size={12} /></span>;
  if (run.status === "stopped") return <span className="swarm-g mute" aria-hidden="true"><StopCircleIcon size={15} /></span>;
  if (run.status === "failed" || run.counts.failed > 0) return <span className="swarm-g fail" aria-hidden="true"><WarningCircleIcon size={15} /></span>;
  if (run.counts.skipped + run.counts.unknown > 0) return <span className="swarm-g mute" aria-hidden="true"><MinusCircleIcon size={15} /></span>;
  return <span className="swarm-g ok" aria-hidden="true"><CheckCircleIcon size={15} /></span>;
}

/** The progress phrase with the phase word set apart, so a narrow card can drop the word and keep the count. */
function Progress({ run, text }: { run: RunVM; text: string }) {
  if (run.status === "starting") {
    return <span className="prog">Starting · <b>no agents scheduled yet</b></span>;
  }
  const dot = text.indexOf(" · ");
  const head = dot < 0 ? text : text.slice(0, dot);
  const rest = dot < 0 ? "" : text.slice(dot + 3);
  if (run.status === "running" && run.plannedKnown) {
    return (
      <span className="prog">
        <span className="word">{head} · </span>
        <b>{rolling(rest)}</b>
      </span>
    );
  }
  return (
    <span className="prog">
      <b>{rolling(head)}</b>
      {rest ? <> · {rolling(rest)}</> : null}
    </span>
  );
}

function toggleKey(event: KeyboardEvent, onToggle: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onToggle();
  }
}

export function SwarmLine({ run, expanded, selected = false, onToggle, onChip, folded = false }: SwarmLineProps) {
  const line = summaryLine(run);
  const live = runLive(run);
  const groups = run.phases.map((phase) => phase.agents.map((agent) => agent.state));
  const label = `${run.name}, ${line.progress}${line.chips.length > 0 ? `, ${line.chips.map((chip) => chip.text).join(", ")}` : ""}${line.elapsed ? `, ${line.elapsed}` : ""}`;
  return (
    <div
      role="button"
      tabIndex={selected ? 0 : -1}
      aria-expanded={expanded}
      aria-label={label}
      data-swarm-focus="line"
      data-run={run.itemId}
      className={cn("swarm-line", run.stale && "stale", folded && "folded")}
      onClick={onToggle}
      onKeyDown={(event) => toggleKey(event, onToggle)}
    >
      <LeadGlyph run={run} />
      <span className="name">{run.name}</span>
      {run.status !== "starting" ? (
        <Strip groups={groups} size="sm" finale={!live} stale={run.stale} more={live && !run.plannedKnown} decorative />
      ) : null}
      <Progress run={run} text={line.progress} />
      <span className="min-w-0 flex-1" />
      {line.chips.map((chip) => (
        <LineChip key={chip.kind} chip={chip} onClick={onChip && chip.kind !== "stale" ? () => onChip(chip.kind) : undefined} />
      ))}
      <span className="swarm-el">
        {run.stale ? (
          line.elapsed
        ) : (
          <>
            <Ticking ms={run.elapsedMs} at={run.clockAt} live={live} approx={run.elapsedApprox && live} />
          </>
        )}
      </span>
      {folded ? null : <span className="car" aria-hidden="true">{expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}</span>}
    </div>
  );
}

export interface TaskLineProps {
  task: AgentVM;
  /** The instant the task's clocks were read at (`RunVM.clockAt`, or the view's now). */
  clockAt: number;
  expanded: boolean;
  selected?: boolean;
  readOnly?: boolean;
  onToggle: () => void;
  onStop: () => void;
}

/** Whether a task or subagent is still going. */
export function taskLive(task: Pick<AgentVM, "state">): boolean {
  return task.state === "working" || task.state === "no-update" || task.state === "waiting-on-you" || task.state === "scheduled" || task.state === "finishing";
}

/** A background task's line: the command, its last output line, and Stop while it runs; a subagent's reads the same way. */
export function TaskLine({ task, clockAt, expanded, selected = false, readOnly = false, onToggle, onStop }: TaskLineProps) {
  const live = taskLive(task);
  const info = task.taskInfo ?? null;
  const command = info?.command ?? task.name;
  let tail: ReactNode;
  let tone = "";
  if (task.state === "failed") {
    tail = `failed · ${task.failure?.text ?? "no reason reported"}`;
    tone = "fail";
  } else if (task.state === "done") {
    tail = "finished · no failure reported";
    tone = "ok";
  } else if (task.state === "skipped") {
    tail = "stopped";
  } else if (task.state === "waiting-on-you") {
    tail = task.needs?.command ? `waiting for you · ${task.needs.command}` : "waiting for you";
  } else {
    tail = info?.tail ?? task.task?.text ?? "Running…";
  }
  const glyph = task.state === "failed" ? (
    <span className="swarm-g fail" aria-hidden="true"><WarningCircleIcon size={15} /></span>
  ) : task.state === "done" ? (
    <span className="swarm-g ok" aria-hidden="true"><CheckCircleIcon size={15} /></span>
  ) : task.state === "skipped" || task.state === "unknown" ? (
    <span className="swarm-g mute" aria-hidden="true"><StopCircleIcon size={15} /></span>
  ) : task.state === "waiting-on-you" ? (
    <span className="swarm-g need" aria-hidden="true"><ShieldWarningIcon size={15} /></span>
  ) : (
    <span className="swarm-g work" aria-hidden="true"><Spinner size={12} /></span>
  );
  const elapsed = live ? task.runningMs : task.durationMs;
  const stopping = task.pending === "stop";
  return (
    <div
      role="button"
      tabIndex={selected ? 0 : -1}
      aria-expanded={expanded}
      aria-label={`${task.kind === "subagent" ? "Subagent" : "Background task"} ${command}, ${typeof tail === "string" ? tail : ""}`}
      data-swarm-focus="line"
      data-agent-id={task.id}
      className="swarm-line task"
      onClick={onToggle}
      onKeyDown={(event) => toggleKey(event, onToggle)}
    >
      {glyph}
      <span className="cmd">{command}</span>
      <span className={cn("tail", tone)}>{stopping ? "Stopping…" : tail}</span>
      {task.state === "no-update" && task.silenceMs !== null ? (
        <span className="swarm-tag"><HourglassIcon size={11} />No output for {durationText(task.silenceMs)}</span>
      ) : null}
      {elapsed !== null ? (
        <span className="swarm-el">
          <Ticking ms={elapsed} at={clockAt} live={live} />
        </span>
      ) : null}
      {live && !readOnly && !stopping ? (
        <IconButton
          size="xs"
          label={`Stop ${command}`}
          className="text-subtle"
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
        >
          <StopCircleIcon size={14} />
        </IconButton>
      ) : null}
      <span className="car" aria-hidden="true">{expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}</span>
    </div>
  );
}

/** Past three lines the rest fold into one: a button that expands the card. */
export function MoreLine(props: { count: number; onClick: () => void }) {
  return (
    <button type="button" className="swarm-line more" data-swarm-focus="line" tabIndex={-1} onClick={props.onClick}>
      <span className="swarm-g" aria-hidden="true" />
      <span>+{props.count} more</span>
    </button>
  );
}
