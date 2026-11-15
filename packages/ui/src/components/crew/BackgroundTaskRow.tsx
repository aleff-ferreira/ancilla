import { useState, type ReactNode } from "react";
import { durationText, type AgentVM } from "../../model/crew.js";
import { ArrowClockwiseIcon, FileTextIcon, HourglassIcon, StopCircleIcon } from "../ui/icons.js";
import { Button, cn } from "../ui/primitives.js";
import { Tip } from "../ui/overlays.js";
import { StateGlyph } from "./StateGlyph.js";
import { Ticking } from "./Ticking.js";
import { initiatorText } from "./cardCopy.js";
import { taskLive } from "./CrewLine.js";

type TaskActionTrigger = () => void;
type TaskSelectCallback = (taskId: string) => void;
type TaskInspectCallback = (taskId: string) => void;
type TaskReviewCallback = (reqIdentifier: string) => void;

export interface BackgroundTaskRowProps {
  task: AgentVM;
  selected: boolean;
  onStop: TaskActionTrigger;
  clockAt: number;
  readOnly: boolean;
  output?: string | null;
  stale?: boolean;
  onInspect?: TaskInspectCallback;
  onSelect?: TaskSelectCallback;
  onReview?: TaskReviewCallback;
}

function resolveTaskStatus(
  currentTask: AgentVM,
  isStopping: boolean,
  initiatorPhrase: string | null
): string {
  const st = currentTask.state;
  if (st === "failed") {
    const reasonText = currentTask.failure?.text ?? "no reason reported";
    return `failed · ${reasonText}`;
  }
  if (st === "done") {
    return "finished · no failure reported";
  }
  if (st === "skipped") {
    return "stopped";
  }
  if (st === "unknown") {
    return "outcome not reported";
  }
  if (st === "waiting-on-you") {
    const reqCmd = currentTask.needs?.command;
    return reqCmd ? `Waiting for you · ${reqCmd}` : "Waiting for you";
  }
  if (isStopping) {
    return "Stopping…";
  }
  return initiatorPhrase ?? "Running";
}

function resolveSilenceNotice(currentTask: AgentVM): string | null {
  const isNoUpdate = currentTask.state === "no-update";
  const silence = currentTask.silenceMs;
  if (isNoUpdate && silence !== null) {
    return `No output for ${durationText(silence)}`;
  }
  return null;
}

function composeTaskAriaSummary(
  cmdName: string,
  statusSentence: string,
  silenceNotice: string | null,
  tailOutput: string | null
): string {
  const base = `Background task ${cmdName}: ${statusSentence}`;
  const silencePart = silenceNotice ? `, ${silenceNotice}` : "";
  const tailPart = tailOutput ? `, ${tailOutput}` : "";
  return `${base}${silencePart}${tailPart}`;
}

function LiveSubtitleContent({
  statusMessage,
  silenceNotice,
  tailText,
}: {
  statusMessage: string;
  silenceNotice: string | null;
  tailText: string | null;
}) {
  const tagContent = silenceNotice ? (
    <span className="crew-tag">
      <HourglassIcon size={11} />
      {silenceNotice}
    </span>
  ) : null;

  return (
    <>
      <span>{statusMessage}</span>
      {tagContent}
      <span className="out" title={tailText ?? undefined}>
        {tailText ?? "Running…"}
      </span>
    </>
  );
}

function SettledSubtitleContent({
  statusMessage,
  isDone,
  isFailed,
  tailText,
}: {
  statusMessage: string;
  isDone: boolean;
  isFailed: boolean;
  tailText: string | null;
}) {
  const outcomeClass = cn("out", isDone && "ok", isFailed && "fail");
  return (
    <>
      <span className={outcomeClass}>{statusMessage}</span>
      {tailText ? <span className="out" title={tailText}>{tailText}</span> : null}
    </>
  );
}

function TaskOutputDrawer({ text }: { text: string }) {
  return (
    <pre className="col-span-3 mt-1 max-h-44 overflow-auto rounded-lg bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg shadow-[0_0_0_1px_var(--border)] [overflow-wrap:anywhere]">
      {text}
    </pre>
  );
}

export function BackgroundTaskRow(props: BackgroundTaskRowProps) {
  const { task } = props;
  const [outputOpen, setOutputOpen] = useState(false);

  const isLive = taskLive(task);
  const taskDetails = task.taskInfo ?? null;
  const commandLabel = taskDetails?.command ?? task.name;
  const isStopping = task.pending === "stop";
  const initiatorLabel = initiatorText(taskDetails?.initiator ?? null);
  const tailOutput = taskDetails?.tail ?? null;
  const runDuration = isLive ? task.runningMs : task.durationMs;

  const statusLabel = resolveTaskStatus(task, isStopping, initiatorLabel);
  const silenceNotice = resolveSilenceNotice(task);
  const rowAriaLabel = composeTaskAriaSummary(commandLabel, statusLabel, silenceNotice, tailOutput);

  const isStaleFeed = Boolean(props.stale);
  const isReadOnly = Boolean(props.readOnly);
  const canShowStop = isLive && !isReadOnly && !isStaleFeed && !isStopping;
  const canShowReview = isLive && task.state === "waiting-on-you" && Boolean(task.needs) && Boolean(props.onReview);
  const canToggleOutput = !isLive && Boolean(props.output);
  const hasFailed = task.state === "failed";

  const rowAttributes = {
    role: "row" as const,
    "aria-selected": props.selected,
    tabIndex: props.selected ? 0 : -1,
    "data-crew-focus": "row",
    "data-agent-id": task.id,
    "data-agent-kind": "task",
    "data-agent-state": task.state,
    className: cn("crew-task", props.selected && "sel"),
    "aria-label": rowAriaLabel,
    onFocus: () => props.onSelect?.(task.id),
    onClick: () => props.onInspect?.(task.id),
  };

  return (
    <div {...rowAttributes}>
      <StateGlyph agent={task} stale={props.stale} />
      <div className="l1">
        <span className="cmd" title={commandLabel}>
          {commandLabel}
        </span>
      </div>
      <span className="l2">
        {isLive ? (
          <LiveSubtitleContent
            statusMessage={statusLabel}
            silenceNotice={silenceNotice}
            tailText={tailOutput}
          />
        ) : (
          <SettledSubtitleContent
            statusMessage={statusLabel}
            isDone={task.state === "done"}
            isFailed={hasFailed}
            tailText={tailOutput}
          />
        )}
      </span>
      <span className="acts">
        {runDuration !== null ? (
          <span className="crew-el">
            <Ticking ms={runDuration} at={props.clockAt} live={isLive && !isStaleFeed} />
          </span>
        ) : null}
        {canShowReview ? (
          <Button
            size="xs"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              props.onReview?.(task.needs?.requestId ?? "");
            }}
          >
            <span className="lbl">Review</span>
          </Button>
        ) : null}
        {canShowStop ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Stop ${commandLabel}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onStop();
            }}
          >
            <StopCircleIcon size={12} />
            <span className="lbl">Stop</span>
          </Button>
        ) : null}
        {canToggleOutput ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={outputOpen}
            onClick={(e) => {
              e.stopPropagation();
              setOutputOpen((cur) => !cur);
            }}
          >
            <FileTextIcon size={12} />
            <span className="lbl">Output</span>
          </Button>
        ) : null}
        {hasFailed ? (
          <Tip label="Muse does not offer running a background task again">
            <Button size="xs" variant="ghost" disabled aria-label={`Run ${commandLabel} again`}>
              <ArrowClockwiseIcon size={12} />
              <span className="lbl">Run again</span>
            </Button>
          </Tip>
        ) : null}
      </span>
      {outputOpen && props.output ? <TaskOutputDrawer text={props.output} /> : null}
    </div>
  );
}
