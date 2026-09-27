import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { formatClock, formatTokens } from "../../model/format.js";
import type { AncillaController } from "../../model/controller.js";
import { formatCost } from "../../model/pricing.js";
import {
  completionView,
  durationText,
  pendingKey,
  runLive,
  sinceYouLeft,
  summaryLine,
  type AgentVM,
  type CompletionVM,
  type PendingAction,
  type RunVM,
  type SinceYouLeftVM,
  type SummaryChip,
  type SwarmVM,
} from "../../model/swarm.js";
import { CaretUpIcon, ChartBarIcon, ClockCounterClockwiseIcon, InfoIcon, RowsIcon, StopCircleIcon } from "../ui/icons.js";
import { Modal } from "../ui/overlays.js";
import { Button, IconButton, Spinner, cn } from "../ui/primitives.js";
import { AgentRow, type ConfirmAction, type RowAction } from "./AgentRow.js";
import { AttentionList, needRowId } from "./AttentionList.js";
import { BackgroundTaskRow } from "./BackgroundTaskRow.js";
import { CompletionReport } from "./CompletionReport.js";
import { focusRequestPanel } from "./HeaderChips.js";
import { Peek } from "./Peek.js";
import { PhaseRail } from "./PhaseRail.js";
import { SinceYouLeft } from "./SinceYouLeft.js";
import { SwarmAnnouncer } from "./SwarmAnnouncer.js";
import { MoreLine, SwarmLine, TaskLine, rolling, taskLive } from "./SwarmLine.js";
import { Ticking } from "./Ticking.js";
import { plural, runKindWord } from "./cardCopy.js";
import { useCardKeys } from "./useCardKeys.js";

/** The key the card keeps its collapsed state under in `prefs.collapsedCards`. */
export function swarmCardKey(sessionId: string): string {
  return `swarm:${sessionId}`;
}

/** How long a finished run keeps its report in the dock, unless dismissed. */
export const REPORT_SHOWN_MS = 24 * 60 * 60_000;
/** How long a finished task or subagent keeps its line. */
export const TASK_SHOWN_MS = 10 * 60_000;
/** More lines than this fold into `+N more`. */
export const LINE_LIMIT = 3;

/** Whether a run that ended still shows its report: it ended within a day and nobody dismissed it. */
export function reportVisible(run: RunVM, now: number, dismissed: boolean): boolean {
  if (runLive(run)) return false;
  if (dismissed) return false;
  const endedAt = run.endedAt ?? run.clockAt;
  return now - endedAt < REPORT_SHOWN_MS;
}

/**
 * A retry the user asked for on a failed agent, before Muse confirms it with a new attempt. The model marks a
 * retry pending only on the attempt it will create, so the row that was clicked reads it from the raw flags here.
 */
export function withPendingRetries(run: RunVM, sessionId: string, pending: Readonly<Record<string, PendingAction>>): RunVM {
  const swapped = new Map<string, AgentVM>();
  for (const agent of run.agents) {
    if (agent.state === "failed" && agent.pending === null && pending[pendingKey(sessionId, agent.id, agent.attempt)] === "retry") {
      swapped.set(agent.id, { ...agent, pending: "retry" });
    }
  }
  if (swapped.size === 0) return run;
  const swap = (agent: AgentVM) => swapped.get(agent.id) ?? agent;
  return {
    ...run,
    agents: run.agents.map(swap),
    attention: run.attention.map(swap),
    phases: run.phases.map((phase) => (phase.agents.some((agent) => swapped.has(agent.id)) ? { ...phase, agents: phase.agents.map(swap) } : phase)),
  };
}

/** The phase the accordion opens by default: the current one, unless every agent in it is already listed above. */
export function defaultOpenPhase(run: RunVM): string | null {
  const current = run.phases.find((phase) => phase.name === run.currentPhase) ?? null;
  if (!current) return null;
  const listed = new Set(run.attention.map((agent) => agent.id));
  return current.agents.every((agent) => listed.has(agent.id)) ? null : current.name;
}

/** Expands the thread's card and puts focus on it, from the transcript's anchor row. */
export function focusSwarmCard(controller: AncillaController, sessionId: string): void {
  controller.setCardOpen(swarmCardKey(sessionId), true);
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(`[data-swarm-card="${sessionId}"]`);
    card?.scrollIntoView({ block: "nearest" });
    card?.querySelector<HTMLElement>("[data-swarm-focus]")?.focus();
  });
}

/** The head's sub line: `Workflow · started 14:02 · 9 agents · 1 planned · 1.1M tokens · ~$4.18 est.` */
export function headSub(run: RunVM): { long: ReactNode; text: string } {
  const scheduled = run.counts.total - run.counts.planned;
  const parts: ReactNode[] = [runKindWord(run)];
  const texts: string[] = [runKindWord(run)];
  if (run.startedAt !== null && !run.elapsedApprox) {
    const started = `started ${formatClock(run.startedAt, run.clockAt)}`;
    parts.push(started);
    texts.push(started);
  }
  const agents = `${plural(scheduled, "agent")}${run.counts.planned > 0 ? ` · ${run.counts.planned} planned` : ""}`;
  parts.push(agents);
  texts.push(agents);
  if (run.tokens) {
    const tokens = `${formatTokens(run.tokens.total)} tokens`;
    parts.push(tokens);
    texts.push(tokens);
  }
  if (run.cost) {
    const cost = `~${formatCost(run.cost.usd)} est.`;
    parts.push(<span key="cost" className="opt">{cost}</span>);
    texts.push(cost);
  }
  const long = parts.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]));
  return { long, text: texts.join(" · ") };
}

/** The footer's counts while the run is live: `6 done · 1 failed · 2 running · 1 planned`. */
export function footMeta(run: RunVM): string {
  const { counts } = run;
  const running = counts.working + counts.finishing + counts.noUpdate + counts.waiting;
  const parts = [`${counts.done} done`];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (running > 0) parts.push(`${running} running`);
  if (counts.scheduled > 0) parts.push(`${counts.scheduled} queued`);
  if (counts.planned > 0) parts.push(`${counts.planned} planned`);
  return parts.join(" · ");
}

/** The open phase's section head: `Design 3 agents · 2 done · 1 failed · 1 listed above · 12m 40s · 468k`. */
export function phaseHeadText(run: RunVM, name: string): string | null {
  const phase = run.phases.find((candidate) => candidate.name === name);
  if (!phase) return null;
  const listed = phase.agents.filter((agent) => run.attention.some((candidate) => candidate.id === agent.id)).length;
  const parts = [plural(phase.counts.total, "agent"), `${phase.counts.done} done`];
  if (phase.counts.failed > 0) parts.push(`${phase.counts.failed} failed`);
  if (phase.counts.skipped > 0) parts.push(`${phase.counts.skipped} skipped`);
  if (listed > 0) parts.push(`${listed} listed above`);
  if (phase.durationMs !== null) parts.push(durationText(phase.durationMs));
  if (phase.tokens !== null && phase.tokens > 0) parts.push(formatTokens(phase.tokens));
  return parts.join(" · ");
}

export interface SwarmCardProps {
  sessionId: string;
  /** The run the card is about; null when the thread has only background tasks or subagents. */
  run: RunVM | null;
  /** Other runs shown as lines beside it, oldest first. */
  otherRuns?: RunVM[];
  /** Background tasks, running first. */
  tasks: AgentVM[];
  subagents?: AgentVM[];
  /** Present once the run ended: the card is the report. */
  completion: CompletionVM | null;
  sinceYouLeft: SinceYouLeftVM | null;
  expanded: boolean;
  /** Exactly one open phase or none (remembered per run by the caller). */
  openPhase: string | null;
  /** The row holding the roving tab stop; null puts it on the first item. */
  selectedId: string | null;
  readOnly: boolean;
  stale?: boolean;
  /** A request panel sits under the card, so the body's cap drops (SPEC §3.3). */
  compact?: boolean;
  /** Play the finale sheen this render (once per run, the caller decides). */
  sheen?: boolean;
  /** The task's output so far, for its Output button. */
  outputOf?: (taskId: string) => string | null;
  onToggle: () => void;
  onOpenPhase: (name: string | null) => void;
  onSelect?: (id: string) => void;
  onInspect: (id: string) => void;
  onOpenPanel: (view: "roster" | "timeline") => void;
  onAction: (id: string, action: RowAction) => void;
  onStopRun: () => void;
  onDismissReport: () => void;
  onDismissRecap: () => void;
  /** Review or Answer: the request panel takes focus. */
  onReview: (requestId: string) => void;
  onOpenTranscript?: () => void;
}

interface Line {
  id: string;
  node: ReactNode;
}

/**
 * The Swarm card in the dock (SPEC §2, L1 and L2): one line per live run or task while collapsed; the head, phase
 * rail, attention list, one open phase, task rows and footer when expanded; the completion report once the run
 * ended. Every prop that is a view-model comes from model/swarm.ts; this component only lays it out.
 */
export function SwarmCard(props: SwarmCardProps) {
  const { run, tasks, expanded, readOnly } = props;
  const otherRuns = props.otherRuns ?? [];
  const subagents = props.subagents ?? [];
  const stale = props.stale ?? false;
  const clockAt = run?.clockAt ?? tasks[0]?.lastEventAt ?? Date.now();
  const rootRef = useRef<HTMLElement>(null);
  const rowsId = useId();
  const [confirming, setConfirming] = useState<{ id: string; action: ConfirmAction } | null>(null);
  const [peekId, setPeekId] = useState<string | null>(null);
  const [stopAsk, setStopAsk] = useState(false);

  const agentsById = useMemo(() => {
    const map = new Map<string, AgentVM>();
    for (const agent of [...(run?.agents ?? []), ...tasks, ...subagents]) map.set(agent.id, agent);
    return map;
  }, [run, tasks, subagents]);

  const onConfirm = useCallback((id: string, action: ConfirmAction | null) => setConfirming(action ? { id, action } : null), []);
  const chipTarget = (kind: SummaryChip["kind"]): string | null => {
    if (!run) return null;
    if (kind === "needs") return run.runNeeds[0] ? needRowId(run.runNeeds[0]) : (run.attention.find((agent) => agent.state === "waiting-on-you")?.id ?? null);
    if (kind === "failed" || kind === "run-failed") return run.attention.find((agent) => agent.state === "failed")?.id ?? null;
    if (kind === "no-update") return run.attention.find((agent) => agent.state === "no-update")?.id ?? null;
    return null;
  };
  const onChip = (kind: SummaryChip["kind"]) => {
    if (!expanded) props.onToggle();
    const target = chipTarget(kind);
    if (target) {
      props.onSelect?.(target);
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(target)}"]`)?.focus());
    }
  };

  const onKeyDown = useCardKeys(rootRef, {
    escape: () => {
      if (peekId !== null) {
        setPeekId(null);
      } else if (confirming) {
        setConfirming(null);
      } else if (expanded) {
        props.onToggle();
        requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>("[data-swarm-focus]")?.focus());
      }
    },
    toggle: props.onToggle,
    openPhase: (name) => props.onOpenPhase(props.openPhase === name ? null : name),
    inspect: (id) => (id.startsWith("need:") ? props.onReview(id.slice(5)) : props.onInspect(id)),
    peek: (id) => setPeekId((current) => (current === id ? null : id)),
    retry: (id) => props.onAction(id, "retry"),
    skip: (id) => setConfirming({ id, action: "skip" }),
    stop: (id) => {
      const agent = agentsById.get(id);
      // A research worker takes no stop of its own: the run does.
      if (agent?.kind === "research") return;
      if (agent && (agent.kind === "task" || agent.kind === "subagent")) props.onAction(id, "stop");
      else if (agent) setConfirming({ id, action: "stop" });
    },
    stopRun: () => {
      if (run && runLive(run) && !readOnly && !stale) setStopAsk(true);
    },
  });

  // A peek follows its row: when the row leaves the list, so does the peek.
  useEffect(() => {
    if (peekId !== null && !agentsById.has(peekId)) setPeekId(null);
  }, [peekId, agentsById]);

  // While expanded, the primary run's and the tasks' lines stay in the markup folded away: the narrowest container
  // (SPEC §3.2, 360 px) shows them instead of the expanded body, and the expanded state survives for when it grows.
  const fold = expanded ? "fold" : undefined;
  const lines: Line[] = [];
  for (const other of otherRuns) {
    lines.push({ id: other.itemId, node: <SwarmLine key={other.itemId} run={other} expanded={false} folded={expanded} onToggle={props.onToggle} onChip={onChip} /> });
  }
  if (run) {
    lines.push({ id: run.itemId, node: <SwarmLine key={run.itemId} run={run} expanded={expanded} selected={props.selectedId === null || props.selectedId === run.itemId} className={fold} onToggle={props.onToggle} onChip={onChip} /> });
  }
  for (const task of [...tasks, ...subagents]) {
    lines.push({
      id: task.id,
      node: (
        <TaskLine
          key={task.id}
          task={task}
          clockAt={clockAt}
          expanded={expanded}
          selected={props.selectedId === task.id || (props.selectedId === null && !run && lines.length === 0)}
          readOnly={readOnly}
          className={fold}
          onToggle={props.onToggle}
          onStop={() => props.onAction(task.id, "stop")}
        />
      ),
    });
  }
  const foldedLines = lines.filter((entry) => !otherRuns.some((other) => other.itemId === entry.id)).map((entry) => entry.node);

  const peekFor = (id: string): ReactNode => {
    const agent = peekId === id ? agentsById.get(id) : undefined;
    return agent ? <Peek agent={agent} run={run} stale={stale} /> : null;
  };

  const taskRows = (items: AgentVM[], title: string, hide: boolean): ReactNode => {
    if (items.length === 0) return null;
    return (
      <>
        <div className="swarm-sec">
          {title} <span className="n">{items.length}</span>
          {hide ? (
            <>
              <span className="min-w-0 flex-1" />
              <button type="button" className="lnk" onClick={props.onToggle}>
                Hide <CaretUpIcon size={11} />
              </button>
            </>
          ) : null}
        </div>
        <div role="grid" aria-label={title} className="flex flex-col">
          {items.map((task) => (
            <div key={task.id} className="relative">
              {task.kind === "task" ? (
                <BackgroundTaskRow
                  task={task}
                  clockAt={clockAt}
                  selected={props.selectedId === task.id}
                  readOnly={readOnly}
                  stale={stale}
                  output={props.outputOf?.(task.id) ?? null}
                  onStop={() => props.onAction(task.id, "stop")}
                  onSelect={props.onSelect}
                  onInspect={props.onInspect}
                  onReview={props.onReview}
                />
              ) : (
                <AgentRow
                  agent={task}
                  variant="compact"
                  selected={props.selectedId === task.id}
                  readOnly={readOnly}
                  stale={stale}
                  clockAt={clockAt}
                  onAction={props.onAction}
                  onInspect={props.onInspect}
                  onSelect={props.onSelect}
                />
              )}
              {peekFor(task.id)}
            </div>
          ))}
        </div>
      </>
    );
  };

  let body: ReactNode;
  if (!expanded) {
    const shown = lines.slice(0, LINE_LIMIT).map((line) => line.node);
    body = (
      <>
        {shown}
        {lines.length > LINE_LIMIT ? <MoreLine count={lines.length - LINE_LIMIT} onClick={props.onToggle} /> : null}
      </>
    );
  } else if (run && props.completion) {
    body = (
      <>
        {otherRuns.map((other) => lines.find((line) => line.id === other.itemId)?.node)}
        <div className="swarm-expanded">
          <CompletionReport
            run={run}
            completion={props.completion}
            expanded
            sheen={props.sheen}
            compact={props.compact}
            onToggle={props.onToggle}
            onOpenPanel={props.onOpenPanel}
            onDismiss={props.onDismissReport}
            onOpenTranscript={props.onOpenTranscript}
          />
          {tasks.length + subagents.length > 0 ? (
            <div className="swarm-body pt-0">
              {taskRows(subagents, "Subagents", false)}
              {taskRows(tasks, "Background", false)}
            </div>
          ) : null}
        </div>
        {foldedLines}
      </>
    );
  } else if (run) {
    const openPhase = props.openPhase ? run.phases.find((phase) => phase.name === props.openPhase) ?? null : null;
    const listed = new Set(run.attention.map((agent) => agent.id));
    const phaseRows = openPhase ? openPhase.agents.filter((agent) => !listed.has(agent.id)) : [];
    const sub = headSub(run);
    const notice = stale ? (
      <div className="swarm-note">
        <ClockCounterClockwiseIcon size={13} />
        <span>
          <b>Last known{run.staleAt !== null ? ` at ${formatClock(run.staleAt, run.clockAt)}` : ""}</b> · Muse is not reachable, nothing has been lost
        </span>
      </div>
    ) : run.partialHistory ? (
      <div className="swarm-note">
        <InfoIcon size={13} />
        <span>
          <b>Counts are from loaded history.</b> The earliest revisions of this run were not loaded, so{" "}
          {run.agents.some((agent) => agent.label === null) ? `${plural(run.agents.filter((agent) => agent.label === null).length, "agent has", "agents have")} no name yet and ` : ""}
          the start time is approximate. Nothing here is lost; it is just not loaded.
        </span>
      </div>
    ) : null;
    body = (
      <>
        {otherRuns.map((other) => lines.find((line) => line.id === other.itemId)?.node)}
        <div className="swarm-run swarm-expanded" data-run={run.itemId}>
          <div className="swarm-head">
            <button type="button" className="toggle" aria-expanded aria-controls={rowsId} data-swarm-focus="head" data-run={run.itemId} title={sub.text} onClick={props.onToggle}>
              <span className={cn("swarm-tile", stale && "mute")} aria-hidden="true">
                {stale ? <ClockCounterClockwiseIcon size={15} /> : <Spinner size={12} />}
              </span>
              <span className="tt">
                <span className="nm">{run.name}</span>
                <span className="sub long">{sub.long}</span>
                <span className="sub short">
                  {runKindWord(run)} · <Ticking ms={run.elapsedMs} at={run.clockAt} live={!stale} approx={run.elapsedApprox} />
                </span>
              </span>
            </button>
            <span className="swarm-el">
              {stale ? summaryLine(run).elapsed : <Ticking ms={run.elapsedMs} at={run.clockAt} live approx={run.elapsedApprox} />}
            </span>
            <IconButton size="sm" label="Collapse" onClick={props.onToggle}>
              <CaretUpIcon size={14} />
            </IconButton>
          </div>
          <div id={rowsId} className={cn("swarm-body", props.compact && "compact")}>
            {notice}
            <PhaseRail phases={run.phases} openPhase={props.openPhase} finale={false} stale={stale} rowsId={rowsId} onOpen={props.onOpenPhase} />
            {!stale ? (
              <AttentionList
                items={run.attention}
                runNeeds={run.runNeeds}
                clockAt={run.clockAt}
                selectedId={props.selectedId}
                readOnly={readOnly}
                confirming={confirming}
                onAction={props.onAction}
                onInspect={props.onInspect}
                onSelect={props.onSelect}
                onConfirm={onConfirm}
                onReview={props.onReview}
              />
            ) : null}
            {openPhase ? (
              <>
                <div className="swarm-sec">
                  {openPhase.name} <span className="n">{phaseHeadText(run, openPhase.name)}</span>
                  <span className="min-w-0 flex-1" />
                  <button type="button" className="lnk" onClick={() => props.onOpenPhase(null)}>
                    Hide <CaretUpIcon size={11} />
                  </button>
                </div>
                <div role="grid" aria-label={`${openPhase.name} agents`} className="flex flex-col">
                  {phaseRows.map((agent) => (
                    <div key={agent.id} className="relative">
                      <AgentRow
                        agent={agent}
                        variant="compact"
                        selected={props.selectedId === agent.id}
                        readOnly={readOnly}
                        stale={stale}
                        clockAt={run.clockAt}
                        confirm={confirming?.id === agent.id ? confirming.action : null}
                        onAction={props.onAction}
                        onInspect={props.onInspect}
                        onSelect={props.onSelect}
                        onConfirm={onConfirm}
                      />
                      {peekFor(agent.id)}
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {taskRows(subagents, "Subagents", false)}
            {taskRows(tasks, "Background", false)}
            <div className="swarm-foot">
              <Button size="xs" variant="ghost" onClick={() => props.onOpenPanel("roster")}>
                <RowsIcon size={12} />
                <span className="lbl">All {rolling(String(run.counts.total))} agents</span>
              </Button>
              <Button size="xs" variant="ghost" onClick={() => props.onOpenPanel("timeline")}>
                <ChartBarIcon size={12} />
                <span className="lbl">Timeline</span>
              </Button>
              <span className="min-w-0 flex-1" />
              <span className="meta">{rolling(footMeta(run))}</span>
              {runLive(run) && !readOnly && !stale ? (
                <Button size="xs" variant="ghost" style={{ color: "var(--danger-text)" }} onClick={() => setStopAsk(true)}>
                  <StopCircleIcon size={12} />
                  <span className="lbl">Stop run</span>
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        {foldedLines}
      </>
    );
  } else {
    body = (
      <>
        <div className="swarm-body compact swarm-expanded">
          {taskRows(subagents, "Subagents", tasks.length === 0)}
          {taskRows(tasks, "Background", true)}
        </div>
        {foldedLines}
      </>
    );
  }

  const working = run ? run.counts.working + run.counts.finishing + run.counts.noUpdate + run.counts.waiting : 0;
  return (
    <>
      {props.sinceYouLeft ? <SinceYouLeft recap={props.sinceYouLeft} clockAt={clockAt} onDismiss={props.onDismissRecap} /> : null}
      <section
        ref={rootRef}
        aria-label="Agents and tasks"
        data-swarm-card={props.sessionId}
        className={cn("swarm-card @container enter-up overflow-hidden rounded-2xl bg-raised shadow-card", stale && "swarm-stale")}
        onKeyDown={onKeyDown}
      >
        {body}
      </section>
      {run ? (
        <Modal open={stopAsk} onOpenChange={setStopAsk} title={`Stop the run ${run.name}?`} description={`${plural(working, "working agent")} will be cancelled. Finished work stays.`}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStopAsk(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setStopAsk(false);
                props.onStopRun();
              }}
            >
              <StopCircleIcon size={13} /> Stop run
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- the connected card

/** Runs whose finale sheen already played in this session, so a revisit does not play it again. */
const sheened = new Set<string>();

export interface SwarmDockCardProps {
  sessionId: string;
  view: SwarmVM;
  stale: boolean;
  readOnly: boolean;
  /** A request panel sits under the card. */
  compact: boolean;
}

/**
 * The card as the dock mounts it: reads the prefs and the Swarm state, keeps the open phase and the roving
 * selection per run, decides which runs and tasks still belong in the dock, and routes every action to the
 * controller. Renders nothing when the thread has nothing live and no fresh report: idle cost is zero.
 */
export function SwarmDockCard(props: SwarmDockCardProps) {
  const controller = useController();
  const { sessionId, view } = props;
  const key = swarmCardKey(sessionId);
  const expanded = useApp((s) => !s.prefs.collapsedCards.includes(key));
  const dismissedReports = useApp((s) => s.swarm.dismissedReports);
  const pending = useApp((s) => s.swarm.pending);
  const leftAt = useApp((s) => s.swarm.leftAt[sessionId] ?? null);
  const now = view.runs[0]?.clockAt ?? Date.now();

  const visibleRuns = view.runs.filter((run) => runLive(run) || reportVisible(run, now, dismissedReports.includes(`${sessionId}:${run.itemId}`)));
  const liveRuns = visibleRuns.filter(runLive);
  const primary = liveRuns[liveRuns.length - 1] ?? visibleRuns[visibleRuns.length - 1] ?? null;
  const run = useMemo(() => (primary ? withPendingRetries(primary, sessionId, pending) : null), [primary, sessionId, pending]);
  const otherRuns = visibleRuns.filter((candidate) => candidate !== primary);
  const recent = (agent: AgentVM) => taskLive(agent) || (agent.endedAt !== null && now - agent.endedAt < TASK_SHOWN_MS);
  const tasks = view.tasks.filter(recent);
  const subagents = view.subagents.filter(recent);

  const [phaseChoice, setPhaseChoice] = useState<{ runId: string; name: string | null } | null>(null);
  const [selection, setSelection] = useState<{ runId: string | null; id: string } | null>(null);
  const runId = run?.itemId ?? null;
  const openPhase = run ? (phaseChoice?.runId === run.itemId ? phaseChoice.name : defaultOpenPhase(run)) : null;
  const selectedId = selection && selection.runId === runId ? selection.id : null;

  // The recap is decided once, when the thread's run is first seen after coming back; it stays until dismissed.
  const [recap, setRecap] = useState<SinceYouLeftVM | null>(null);
  const recapDecided = useRef<string | null>(null);
  useEffect(() => {
    if (!run || recapDecided.current === run.itemId) return;
    recapDecided.current = run.itemId;
    if (leftAt === null) return;
    const found = sinceYouLeft(run, leftAt, now);
    if (found) setRecap(found);
    else controller.markLeft(sessionId, null);
  }, [run, leftAt, now, controller, sessionId]);

  const completion = useMemo(() => (run && !runLive(run) ? completionView(run) : null), [run]);
  const sheen = Boolean(completion?.sheen && run && !sheened.has(`${sessionId}:${run.itemId}`));
  useEffect(() => {
    if (completion?.sheen && run) sheened.add(`${sessionId}:${run.itemId}`);
  }, [completion, run, sessionId]);

  const agentOf = useCallback(
    (id: string): AgentVM | null => [...(run?.agents ?? []), ...view.tasks, ...view.subagents].find((agent) => agent.id === id) ?? null,
    [run, view],
  );
  const onAction = useCallback(
    (id: string, action: RowAction) => {
      const agent = agentOf(id);
      if (!agent) return;
      if (action === "review" || action === "answer") {
        focusRequestPanel(agent.needs?.requestId ?? null);
        return;
      }
      // Research workers run on their own; the rows offer nothing, and a key lands here with nothing to send.
      if (agent.kind === "research") return;
      // Stop on a workflow agent is a skip: the run goes on without it.
      const routed = action === "stop" && agent.kind === "workflow" ? "skip" : action;
      void controller.swarmAction(sessionId, agent, routed);
    },
    [agentOf, controller, sessionId],
  );
  const onOpenPanel = useCallback(
    (which: "roster" | "timeline") => {
      const panel = controller.store.get().swarm.panels[sessionId];
      if (which === "timeline" && !(panel?.timelineOpen ?? false)) controller.toggleTimeline(sessionId);
      controller.toggleSwarmPanel(true);
    },
    [controller, sessionId],
  );
  const onSelect = useCallback((id: string) => setSelection({ runId, id }), [runId]);
  const outputOf = useCallback(
    (taskId: string) => {
      const item = controller.store.get().threads[sessionId]?.fold.items[taskId];
      return item?.visibleOutput ?? null;
    },
    [controller, sessionId],
  );

  if (!run && tasks.length === 0 && subagents.length === 0) {
    return null;
  }
  return (
    <>
      <SwarmAnnouncer view={view} quiet={props.stale} />
      <SwarmCard
        sessionId={sessionId}
        run={run}
        otherRuns={otherRuns}
        tasks={tasks}
        subagents={subagents}
        completion={completion}
        sinceYouLeft={recap}
        expanded={expanded}
        openPhase={openPhase}
        selectedId={selectedId}
        readOnly={props.readOnly}
        stale={props.stale}
        compact={props.compact}
        sheen={sheen}
        outputOf={outputOf}
        onToggle={() => controller.setCardOpen(key, !expanded)}
        onOpenPhase={(name) => run && setPhaseChoice({ runId: run.itemId, name })}
        onSelect={onSelect}
        onInspect={(id) => controller.inspectAgent(sessionId, id)}
        onOpenPanel={onOpenPanel}
        onAction={onAction}
        onStopRun={() => run && void controller.stopRun(sessionId, run.itemId)}
        onDismissReport={() => run && controller.dismissReport(sessionId, run.itemId)}
        onDismissRecap={() => {
          setRecap(null);
          controller.dismissRecap(sessionId);
        }}
        onReview={(requestId) => focusRequestPanel(requestId)}
        onOpenTranscript={run ? () => document.querySelector(`[data-swarm-anchor="${CSS.escape(run.itemId)}"]`)?.scrollIntoView({ block: "center" }) : undefined}
      />
    </>
  );
}
