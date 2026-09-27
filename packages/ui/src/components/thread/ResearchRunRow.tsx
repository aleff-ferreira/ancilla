import { useCallback, useEffect, useRef, useState } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { formatTokens } from "../../model/format.js";
import {
  phaseLine,
  preferredStopAction,
  reportView,
  researchClock,
  researchLive,
  researchReported,
  sourcesLine,
  STATUS_WORD,
  STOP_ACTION_ORDER,
  STOP_ACTIONS,
  STOPPING_LINE,
  WORKER_STATE_WORD,
  workerChip,
  type ResearchStopAction,
} from "../../model/research.js";
import { durationText } from "../../model/swarm.js";
import type { ResearchRunView, ResearchWorkerView } from "../../types.js";
import { BinocularsIcon, CaretDownIcon, CheckCircleIcon, CircleDashedIcon, ClockIcon, StopCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { CopyButton, Markdown } from "../ui/Markdown.js";
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from "../ui/overlays.js";
import { Button, Spinner, cn } from "../ui/primitives.js";

/** Reports longer than this many lines start folded; about twelve lines of prose fit the clamp height. */
const FOLD_LINES = 14;

/**
 * A DeepResearch run in the transcript, between the turns it sits among by time. While it runs: the phase, the
 * clocks, a chip per worker and the counts; once it ends: the report, or why there is none. Muse never saw the run
 * from inside the thread, so the row is the only trace of it here. `latest` marks the newest finished run in the
 * thread, the one that reads its report on sight; an older one offers to.
 */
export function ResearchRunRow(props: { run: ResearchRunView; sessionId: string; latest: boolean }) {
  const { run } = props;
  const live = researchLive(run);
  const reported = researchReported(run);
  return (
    <section
      className="enter-up flex flex-col gap-2.5 rounded-xl bg-raised px-4 py-3.5 shadow-card"
      aria-label={`Deep research: ${run.question}`}
      data-research-status={run.status}
    >
      <div className="flex items-center gap-2">
        <BinocularsIcon size={14} className={cn("shrink-0", live ? "text-accent-text" : "text-subtle")} />
        <span className="shrink-0 text-xs text-muted">Deep research</span>
        <span className="min-w-0 flex-1" />
        <Heading run={run} live={live} />
      </div>
      <p className="text-md leading-relaxed font-medium text-fg [overflow-wrap:anywhere]">{run.question}</p>
      {live ? <Progress run={run} /> : null}
      {reported ? <Report run={run} sessionId={props.sessionId} latest={props.latest} /> : null}
      {!live && !reported ? <Ended run={run} /> : null}
      {!live ? <RunAgain run={run} sessionId={props.sessionId} /> : null}
    </section>
  );
}

/** The status word, and the clock while it matters: `Researching · 4m 12s`, `Report · 8m 03s`, `Failed`. */
function Heading(props: { run: ResearchRunView; live: boolean }) {
  const now = useNow(1000, props.live);
  const clock = researchClock(props.run, now);
  const tone = props.run.status === "failed" ? "text-danger-text" : props.live ? "text-accent-text" : "text-muted";
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs tabular-nums", tone)}>
      {props.live ? <Spinner size={11} /> : null}
      <span>{STATUS_WORD[props.run.status]}</span>
      {clock.elapsedMs !== null ? <span className="text-subtle">· {durationText(clock.elapsedMs)}</span> : null}
    </span>
  );
}

/**
 * What a running run is doing: phase and time left, then the workers, then the counts and Stop. Once a stop is
 * asked for, the phase line says so and Stop goes away until the stream says how the run ended.
 */
function Progress(props: { run: ResearchRunView }) {
  const { run } = props;
  const controller = useController();
  const stopWrites = useApp((s) => s.researchStopWrites);
  const stopping = useApp((s) => s.researchStopping[run.runId] ?? null);
  const now = useNow(1000);
  const clock = researchClock(run, now);
  const sources = sourcesLine(run.sources);
  const pending = run.runId.startsWith("pending:");
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span data-research-phase>{stopping ? STOPPING_LINE[stopping] : phaseLine(run)}</span>
        {clock.remainingMs !== null && !stopping ? (
          <span className="text-subtle tabular-nums">{clock.remainingMs > 0 ? `${durationText(clock.remainingMs)} left in the window` : "Window spent, wrapping up"}</span>
        ) : null}
      </p>
      {run.workers.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Workers">
          {run.workers.map((worker) => (
            <WorkerChip key={`${worker.round}-${worker.agentId}`} worker={worker} />
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-subtle tabular-nums">{sources ?? "No sources yet"}</span>
        {run.usage.totalTokens > 0 ? <span className="text-xs text-subtle tabular-nums">{formatTokens(run.usage.totalTokens)} tokens</span> : null}
        <span className="min-w-0 flex-1" />
        {pending ? null : (
          <StopControl
            preferred={preferredStopAction(stopWrites)}
            disabled={stopping !== null}
            onStop={(action) => void controller.stopResearch(run.runId, action === "write")}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Stop as a split button: the button does what the switch in the composer popover prefers, and the chevron
 * offers both ways with the preferred one marked. One ring around both halves, so it reads as one control.
 */
function StopControl(props: { preferred: ResearchStopAction; disabled: boolean; onStop: (action: ResearchStopAction) => void }) {
  const chosen = STOP_ACTIONS[props.preferred];
  return (
    <span className={cn("inline-flex h-7 items-stretch overflow-hidden rounded-md bg-raised shadow-btn", props.disabled && "opacity-45")}>
      <button
        type="button"
        disabled={props.disabled}
        aria-label="Stop the research run"
        title={chosen.title}
        data-stop-action={props.preferred}
        onClick={() => props.onStop(props.preferred)}
        className="inline-flex items-center px-2.5 text-sm font-medium text-fg transition-colors duration-150 ease-out hover:bg-hover disabled:pointer-events-none"
      >
        Stop
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            disabled={props.disabled}
            aria-label="Other ways to stop"
            className="inline-flex w-6 items-center justify-center border-l border-line text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg disabled:pointer-events-none"
          >
            <CaretDownIcon size={11} />
          </button>
        </MenuTrigger>
        <MenuContent side="top" align="end" className="w-[300px]">
          {STOP_ACTION_ORDER.map((action) => (
            <MenuItem key={action} hint={action === props.preferred ? "Default" : undefined} onSelect={() => props.onStop(action)}>
              {STOP_ACTIONS[action].label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </span>
  );
}

/** A worker as one chip: its state glyph, `A1 · topic · 3 searches · 2 reads`. The words carry the state. */
function WorkerChip(props: { worker: ResearchWorkerView }) {
  const { worker } = props;
  return (
    <li
      className={cn(
        "inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-md px-1.5 text-2xs font-medium tabular-nums",
        worker.state === "failed" || worker.state === "timed_out" ? "bg-danger-soft text-danger-text" : "bg-active text-muted",
      )}
      title={`${WORKER_STATE_WORD[worker.state]}${worker.discovery ? " · discovery" : ""}`}
      data-worker-state={worker.state}
    >
      <WorkerGlyph state={worker.state} />
      <span className="truncate">{workerChip(worker)}</span>
      <span className="sr-only">{WORKER_STATE_WORD[worker.state]}</span>
    </li>
  );
}

function WorkerGlyph(props: { state: ResearchWorkerView["state"] }) {
  switch (props.state) {
    case "working":
      return <Spinner size={10} className="text-accent-text" />;
    case "completed":
      return <CheckCircleIcon size={12} className="text-ok" />;
    case "failed":
      return <WarningCircleIcon size={12} className="text-danger" />;
    case "timed_out":
      return <ClockIcon size={12} className="text-danger" />;
    case "cancelled":
      return <StopCircleIcon size={12} className="text-subtle" />;
    case "queued":
      return <CircleDashedIcon size={12} className="text-subtle" />;
  }
}

/**
 * The report, which the stream does not carry: the newest finished run reads it on sight, an older one when asked,
 * and a read that fails leaves a button rather than a spinner. Folded past a screen's worth.
 */
function Report(props: { run: ResearchRunView; sessionId: string; latest: boolean }) {
  const { run } = props;
  const controller = useController();
  const reading = useApp((s) => Boolean(s.busy[`research-report:${run.runId}`]));
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef<string | null>(null);
  const read = useCallback(() => {
    if (controller.store.get().busy[`research-report:${run.runId}`]) {
      return;
    }
    asked.current = run.runId;
    setFailed(false);
    void controller.openResearchReport(run.runId).then((ok) => {
      // A read that failed frees the run to be asked for again, from the button that takes the spinner's place.
      if (!ok) {
        asked.current = null;
        setFailed(true);
      }
    });
  }, [controller, run.runId]);
  useEffect(() => {
    if (props.latest && run.report === null && run.reportAvailable && asked.current !== run.runId) {
      read();
    }
  }, [props.latest, read, run.report, run.reportAvailable, run.runId]);
  const view = reportView(run, { latest: props.latest, reading, failed });
  const lines = run.report ? run.report.split("\n").length : 0;
  const long = lines > FOLD_LINES;
  const open = () => {
    if (run.reportPath && controller.openFile(props.sessionId, run.reportPath)) {
      return;
    }
    controller.toast("info", run.reportPath ? "The report is outside this project" : "The report has no file yet", run.reportPath ?? undefined);
  };
  return (
    <div className="flex flex-col gap-2">
      {run.status === "partial" && run.failure ? (
        <p className="flex items-start gap-1.5 text-xs text-warn-text">
          <WarningCircleIcon size={13} className="mt-px shrink-0" />
          <span>Written from what the workers had found: {run.failure}</span>
        </p>
      ) : null}
      {view === "report" && run.report ? (
        <div className={cn("relative", long && !expanded && "max-h-[300px] overflow-hidden")}>
          <Markdown text={run.report} />
          {long && !expanded ? <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-raised to-transparent" /> : null}
        </div>
      ) : view === "reading" ? (
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Spinner size={10} /> Reading the report
        </p>
      ) : view === "read" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className={cn("text-xs", failed ? "text-danger-text" : "text-subtle")}>{failed ? "Could not read the report." : "The report is ready to read."}</p>
          <Button size="sm" variant="secondary" onClick={read}>
            Read the report
          </Button>
        </div>
      ) : (
        <p className="text-xs text-subtle">The run ended without a report to show.</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {long ? (
          <button type="button" onClick={() => setExpanded((v) => !v)} className="rounded-md px-1.5 py-0.5 text-xs text-subtle hover:bg-hover hover:text-fg">
            {expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
        {run.report ? <CopyButton text={run.report} label="Copy the report" /> : null}
        {run.reportPath ? (
          <Tip label={run.reportPath}>
            <Button size="sm" variant="ghost" onClick={open}>
              Open report.md
            </Button>
          </Tip>
        ) : null}
      </div>
    </div>
  );
}

/** A run that ended with nothing to read: why, and for an interrupted one the Resume that is not here yet. */
function Ended(props: { run: ResearchRunView }) {
  const { run } = props;
  const failed = run.status === "failed";
  const text =
    run.failure ??
    (run.status === "cancelled"
      ? "Stopped before it wrote a report."
      : run.status === "interrupted"
        ? "Ancilla restarted while the run was going, so it stopped where it was."
        : "The run ended without saying why.");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className={cn("flex min-w-0 flex-1 items-start gap-1.5 text-xs", failed ? "text-danger-text" : "text-muted")}>
        <WarningCircleIcon size={13} className="mt-px shrink-0" />
        <span className="[overflow-wrap:anywhere]">{text}</span>
      </p>
      {run.status === "interrupted" ? (
        <Tip label="Coming in a later release">
          <span tabIndex={0} className="inline-flex rounded-lg">
            <Button size="sm" variant="secondary" disabled>
              Resume
            </Button>
          </span>
        </Tip>
      ) : null}
    </div>
  );
}

/**
 * Edit and run again for a run that has ended, whatever way it ended: Edit puts the question back in the
 * composer with research mode armed, Run again starts it as it was, with the same window and workers.
 */
function RunAgain(props: { run: ResearchRunView; sessionId: string }) {
  const controller = useController();
  const readOnly = useApp((s) => s.threads[props.sessionId]?.readOnly ?? false);
  const live = useApp((s) => s.threads[props.sessionId]?.researchRuns.some(researchLive) ?? false);
  if (readOnly) return null;
  const { run } = props;
  const again = () =>
    void controller.startResearch(props.sessionId, run.question, {
      windowMinMinutes: run.config.windowMinMinutes,
      windowMaxMinutes: run.config.windowMaxMinutes,
      maxParallel: run.config.maxParallel,
    });
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Tip label="Put the question back in the composer, with research on, to change it">
        <Button size="sm" variant="ghost" onClick={() => controller.editResearchQuestion(props.sessionId, run.question)}>
          Edit question
        </Button>
      </Tip>
      <Tip label={live ? "A research run is already going in this thread" : "Research the same question again, with the same window and workers"}>
        <span tabIndex={live ? 0 : -1} className="inline-flex rounded-lg">
          <Button size="sm" variant="ghost" disabled={live} onClick={again}>
            Run again
          </Button>
        </span>
      </Tip>
    </div>
  );
}
