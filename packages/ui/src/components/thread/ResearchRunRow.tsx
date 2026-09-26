import { useEffect, useRef, useState } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { formatTokens } from "../../model/format.js";
import { phaseLine, researchClock, researchLive, researchReported, sourcesLine, STATUS_WORD, WORKER_STATE_WORD, workerChip } from "../../model/research.js";
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
 * from inside the thread, so the row is the only trace of it here.
 */
export function ResearchRunRow(props: { run: ResearchRunView; sessionId: string }) {
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
      {reported ? <Report run={run} sessionId={props.sessionId} /> : null}
      {!live && !reported ? <Ended run={run} /> : null}
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

/** What a running run is doing: phase and time left, then the workers, then the counts and Stop. */
function Progress(props: { run: ResearchRunView }) {
  const { run } = props;
  const controller = useController();
  const stopWrites = useApp((s) => s.researchStopWrites);
  const stopping = useApp((s) => Boolean(s.busy[`research-stop:${run.runId}`]));
  const now = useNow(1000);
  const clock = researchClock(run, now);
  const sources = sourcesLine(run.sources);
  const pending = run.runId.startsWith("pending:");
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span data-research-phase>{phaseLine(run)}</span>
        {clock.remainingMs !== null ? (
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
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant="secondary" disabled={stopping} aria-label="Stop the research run">
                {stopping ? <Spinner size={11} /> : null}
                Stop
                <CaretDownIcon size={11} className="ml-1 opacity-60" />
              </Button>
            </MenuTrigger>
            <MenuContent side="top" align="end" className="w-[300px]">
              <MenuItem hint={stopWrites ? "Default" : undefined} onSelect={() => void controller.stopResearch(run.runId, true)}>
                Stop and write from what it has
              </MenuItem>
              <MenuItem hint={stopWrites ? undefined : "Default"} onSelect={() => void controller.stopResearch(run.runId, false)}>
                Stop now, no report
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
    </div>
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

/** The report, read on first sight since the stream does not carry it, folded past a screen's worth. */
function Report(props: { run: ResearchRunView; sessionId: string }) {
  const { run } = props;
  const controller = useController();
  const [expanded, setExpanded] = useState(false);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (run.report === null && run.reportAvailable && asked.current !== run.runId) {
      asked.current = run.runId;
      void controller.openResearchReport(run.runId);
    }
  }, [controller, run.runId, run.report, run.reportAvailable]);
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
      {run.report ? (
        <div className={cn("relative", long && !expanded && "max-h-[300px] overflow-hidden")}>
          <Markdown text={run.report} />
          {long && !expanded ? <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-raised to-transparent" /> : null}
        </div>
      ) : run.reportAvailable ? (
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Spinner size={10} /> Reading the report
        </p>
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
