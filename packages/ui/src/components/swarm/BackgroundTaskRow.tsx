import { useState } from "react";
import { durationText, type AgentVM } from "../../model/swarm.js";
import { ArrowClockwiseIcon, FileTextIcon, HourglassIcon, StopCircleIcon } from "../ui/icons.js";
import { Button, cn } from "../ui/primitives.js";
import { Tip } from "../ui/overlays.js";
import { StateGlyph } from "./StateGlyph.js";
import { Ticking } from "./Ticking.js";
import { initiatorText } from "./cardCopy.js";
import { taskLive } from "./SwarmLine.js";

export interface BackgroundTaskRowProps {
  task: AgentVM;
  clockAt: number;
  selected: boolean;
  readOnly: boolean;
  stale?: boolean;
  /** The task's output so far, for the Output button; null when the thread does not hold it. */
  output?: string | null;
  onStop: () => void;
  onSelect?: (id: string) => void;
  onInspect?: (id: string) => void;
  /** Review on a task that waits for you: the request panel takes focus. */
  onReview?: (requestId: string) => void;
}

/**
 * A background task in the expanded card: the command, who sent it to the background, its last output line, and
 * Stop while it runs; Output once it ended. Run again is not routed in this version, so it is not offered.
 */
export function BackgroundTaskRow(props: BackgroundTaskRowProps) {
  const { task } = props;
  const [showOutput, setShowOutput] = useState(false);
  const live = taskLive(task);
  const info = task.taskInfo ?? null;
  const command = info?.command ?? task.name;
  const stopping = task.pending === "stop";
  const who = initiatorText(info?.initiator ?? null);
  const tail = info?.tail ?? null;
  const elapsed = live ? task.runningMs : task.durationMs;
  let status: string;
  if (task.state === "failed") status = `failed · ${task.failure?.text ?? "no reason reported"}`;
  else if (task.state === "done") status = "finished · no failure reported";
  else if (task.state === "skipped") status = "stopped";
  else if (task.state === "unknown") status = "outcome not reported";
  else if (task.state === "waiting-on-you") status = task.needs?.command ? `Waiting for you · ${task.needs.command}` : "Waiting for you";
  else if (stopping) status = "Stopping…";
  else status = who ?? "Running";
  const noOutput = task.state === "no-update" && task.silenceMs !== null ? `No output for ${durationText(task.silenceMs)}` : null;
  return (
    <div
      role="row"
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      data-swarm-focus="row"
      data-agent-id={task.id}
      data-agent-kind="task"
      data-agent-state={task.state}
      className={cn("swarm-task", props.selected && "sel")}
      aria-label={`Background task ${command}: ${status}${noOutput ? `, ${noOutput}` : ""}${tail ? `, ${tail}` : ""}`}
      onFocus={() => props.onSelect?.(task.id)}
      onClick={() => props.onInspect?.(task.id)}
    >
      <StateGlyph agent={task} stale={props.stale} />
      <div className="l1">
        <span className="cmd" title={command}>{command}</span>
      </div>
      <span className="l2">
        {live ? (
          <>
            <span>{status}</span>
            {noOutput ? <span className="swarm-tag"><HourglassIcon size={11} />{noOutput}</span> : null}
            <span className="out" title={tail ?? undefined}>{tail ?? "Running…"}</span>
          </>
        ) : (
          <>
            <span className={cn("out", task.state === "done" && "ok", task.state === "failed" && "fail")}>{status}</span>
            {tail ? <span className="out" title={tail}>{tail}</span> : null}
          </>
        )}
      </span>
      <span className="acts">
        {elapsed !== null ? (
          <span className="swarm-el">
            <Ticking ms={elapsed} at={props.clockAt} live={live && !props.stale} />
          </span>
        ) : null}
        {live && task.state === "waiting-on-you" && task.needs && props.onReview ? (
          <Button size="xs" variant="secondary" onClick={(event) => { event.stopPropagation(); props.onReview?.(task.needs?.requestId ?? ""); }}>
            <span className="lbl">Review</span>
          </Button>
        ) : null}
        {live && !props.readOnly && !props.stale && !stopping ? (
          <Button size="xs" variant="ghost" aria-label={`Stop ${command}`} onClick={(event) => { event.stopPropagation(); props.onStop(); }}>
            <StopCircleIcon size={12} />
            <span className="lbl">Stop</span>
          </Button>
        ) : null}
        {!live && props.output ? (
          <Button size="xs" variant="ghost" aria-expanded={showOutput} onClick={(event) => { event.stopPropagation(); setShowOutput((value) => !value); }}>
            <FileTextIcon size={12} />
            <span className="lbl">Output</span>
          </Button>
        ) : null}
        {task.state === "failed" ? (
          <Tip label="Muse does not offer running a background task again">
            <Button size="xs" variant="ghost" disabled aria-label={`Run ${command} again`}>
              <ArrowClockwiseIcon size={12} />
              <span className="lbl">Run again</span>
            </Button>
          </Tip>
        ) : null}
      </span>
      {showOutput && props.output ? (
        <pre className="col-span-3 mt-1 max-h-44 overflow-auto rounded-lg bg-sunken px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg shadow-[0_0_0_1px_var(--border)] [overflow-wrap:anywhere]">
          {props.output}
        </pre>
      ) : null}
    </div>
  );
}
