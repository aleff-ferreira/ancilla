import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { formatClock, formatTokens } from "../../model/format.js";
import type { AncillaController } from "../../model/controller.js";
import { formatCost } from "../../model/pricing.js";
import {
  completionView,
  durationText,
  pendingKey,
  reportCoverage,
  runLive,
  sinceYouLeft,
  summaryLine,
  type AgentVM,
  type CompletionVM,
  type CrewVM,
  type PendingAction,
  type RunVM,
  type SinceYouLeftVM,
  type SummaryChip,
} from "../../model/crew.js";
import { actionById, attentionOf, chipsOf, endedCount, glyphOf, planMerges, recentActions, stepSegs, subAction, subText, titleOf, trailOf, type Title } from "../../model/runCard.js";
import type { TaskPlanView } from "../../model/taskPlan.js";
import { CaretDownIcon, CaretUpIcon, ChartBarIcon, ClockCounterClockwiseIcon, InfoIcon, RowsIcon, StopCircleIcon, XCircleIcon } from "../ui/icons.js";
import { Modal, Tip } from "../ui/overlays.js";
import { Button, IconButton, cn } from "../ui/primitives.js";
import { Collapse } from "../ui/sourced.js";
import { AgentRow, type ConfirmAction, type RowAction } from "./AgentRow.js";
import { AttentionList, needRowId } from "./AttentionList.js";
import { BackgroundTaskRow } from "./BackgroundTaskRow.js";
import { CompletionReport } from "./CompletionReport.js";
import { focusRequestPanel } from "./HeaderChips.js";
import { Peek } from "./Peek.js";
import { PhaseRail } from "./PhaseRail.js";
import { SinceYouLeft } from "./SinceYouLeft.js";
import { CrewAnnouncer } from "./CrewAnnouncer.js";
import { LineChip, MoreLine, CrewLine, TaskLine, taskLive } from "./CrewLine.js";
import { ActionLine, Hairline, Latest, PlanSteps, RunGlyph, Spine, Swap, Trail, useDwell } from "./RunParts.js";
import { Ticking } from "./Ticking.js";
import { plural, runKindWord } from "./cardCopy.js";
import { useCardKeys } from "./useCardKeys.js";

/** The key the card keeps its open state under in `prefs.openCards`. */
export function crewCardKey(sessionId: string): string {
  return `crew:${sessionId}`;
}

/** How long a finished run keeps its report in the dock, unless dismissed. */
export const REPORT_SHOWN_MS = 24 * 60 * 60_000;
/** How long a finished task or subagent keeps its line. */
export const TASK_SHOWN_MS = 10 * 60_000;
/** More lines than this fold into `+N more`. */
export const LINE_LIMIT = 3;
/** A title or a call holds this long before the next replaces it. */
const TITLE_DWELL_MS = 900;
const ACTION_DWELL_MS = 700;
/** The latest calls the body lists: fewer beside a plan, which already fills it. */
const LATEST_WITH_PLAN = 4;
const LATEST_ALONE = 6;

/** Whether a run that ended still shows its report: it ended within a day and nobody dismissed it. */
export function reportVisible(run: RunVM, now: number, dismissed: boolean): boolean {
  if (runLive(run)) return false;
  if (dismissed) return false;
  const endedAt = run.endedAt ?? run.clockAt;
  return now - endedAt < REPORT_SHOWN_MS;
}

/**
 * The run the dock's card is about: the newest live one, else the newest report still on show. The thread view asks
 * too, since a plan that belongs to this run is folded into the card and must not also be listed under it.
 */
export function primaryRun(view: CrewVM, sessionId: string, now: number, dismissedReports: readonly string[]): RunVM | null {
  const visible = view.runs.filter((run) => runLive(run) || reportVisible(run, now, dismissedReports.includes(`${sessionId}:${run.itemId}`)));
  const live = visible.filter(runLive);
  return live[live.length - 1] ?? visible[visible.length - 1] ?? null;
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

/** Opens the thread's card and puts focus on it, from the transcript's anchor row. */
export function focusCrewCard(controller: AncillaController, sessionId: string): void {
  controller.setCardExpanded(crewCardKey(sessionId), true);
  if (typeof document === "undefined") return;
  requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(`[data-crew-card="${sessionId}"]`);
    card?.scrollIntoView({ block: "nearest" });
    card?.querySelector<HTMLElement>("[data-crew-focus]")?.focus();
  });
}

/**
 * What a run is made of, as one line: `Workflow · started 14:02 · 9 agents · 1 planned · 1.2M tokens so far (8 of 9 reported) · ~$1.94 est.`
 * While the run goes the total says so far, and while some agents have sent no usage it says how many have: the
 * estimate beside it is built from the same agents. The card keeps it as the footer's tooltip, off the glance.
 */
export function headSub(run: RunVM): { text: string } {
  const scheduled = run.counts.total - run.counts.planned;
  const texts: string[] = [runKindWord(run)];
  if (run.startedAt !== null && !run.elapsedApprox) texts.push(`started ${formatClock(run.startedAt, run.clockAt)}`);
  texts.push(run.kind === "turn" ? `Muse · ${plural(run.agents.filter((agent) => agent.kind === "task").length, "tool")}` : `${plural(scheduled, "agent")}${run.counts.planned > 0 ? ` · ${run.counts.planned} planned` : ""}`);
  if (run.tokens) {
    const coverage = reportCoverage(run);
    texts.push(`${formatTokens(run.tokens.total)} tokens${runLive(run) ? " so far" : ""}${coverage ? ` (${coverage})` : ""}`);
  }
  if (run.cost) texts.push(`~${formatCost(run.cost.usd)} est.`);
  return { text: texts.join(" · ") };
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
  const parts = [plural(phase.counts.total, name === "Tools" ? "tool" : "agent"), `${phase.counts.done} done`];
  if (phase.counts.failed > 0) parts.push(`${phase.counts.failed} failed`);
  if (phase.counts.skipped > 0) parts.push(`${phase.counts.skipped} skipped`);
  if (listed > 0) parts.push(`${listed} listed above`);
  if (phase.durationMs !== null) parts.push(durationText(phase.durationMs));
  if (phase.tokens !== null && phase.tokens > 0) parts.push(formatTokens(phase.tokens));
  return parts.join(" · ");
}

/** What the footer says beside its buttons: a prompt's calls and tokens, a workflow's counts. */
export function footStats(run: RunVM): string {
  if (run.kind !== "turn") return footMeta(run);
  const calls = run.agents.filter((agent) => agent.kind === "task").length;
  const parts = [plural(calls, "action")];
  if (run.tokens) parts.push(`${formatTokens(run.tokens.total)} tokens${runLive(run) ? " so far" : ""}`);
  return parts.join(" · ");
}

export interface CrewCardProps {
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
  /** The plan Muse reported, when it belongs to this run: its steps become the card's spine and its body. */
  plan?: TaskPlanView | null;
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

interface HeadProps {
  run: RunVM;
  plan: TaskPlanView | null;
  stale: boolean;
  expanded: boolean;
  /** The id of the body the head opens, which the phase rail's segments also control. */
  rowsId: string;
  /** A prompt that ended: its headline and fact line stand in for the live words, and the card can be dismissed. */
  receipt: { title: string; sub: string } | null;
  sheen: boolean;
  onToggle: () => void;
  onChip: (kind: SummaryChip["kind"]) => void;
  onOpenPhase: (name: string | null) => void;
  openPhase: string | null;
  onDismiss?: () => void;
}

/**
 * The card's head: what is happening in a line, the call going now beneath it, the chips that need you, the time, and
 * the spine. The whole head opens the body; only the chips answer on their own.
 */
function RunHead(props: HeadProps) {
  const { run, plan, stale, expanded, receipt } = props;
  const live = runLive(run);
  const turn = run.kind === "turn";
  const line = summaryLine(run);
  const title: Title = receipt ? { text: receipt.title, source: "end" } : titleOf(run, plan);
  const wanted = `${title.source}\u0001${title.text}`;
  const shownKey = useDwell(wanted, !live || title.source === "need" ? 0 : TITLE_DWELL_MS);
  const [shownSource, ...rest] = shownKey.split("\u0001");
  const shownText = rest.join("\u0001");
  // What sits under the first line follows the line that is on show, not the one waiting behind its dwell.
  const shownTitle: Title = { text: shownText, source: shownSource as Title["source"] };
  const action = live && !receipt && shownTitle.source !== "action" ? subAction(run) : null;
  const shownActionId = useDwell(action ? action.id : null, ACTION_DWELL_MS);
  const shownAction = action ? actionById(run, shownActionId ?? action.id) ?? action : null;
  const sub = receipt ? receipt.sub : subText(run, shownTitle);
  const merged = plan !== null && planMerges(run, plan);
  const ticks = turn ? trailOf(run) : [];
  const beat = turn ? endedCount(run) : 0;
  const glyph = glyphOf(run);
  const chips = chipsOf(run);
  const elapsed = line.elapsed;
  const label = `${shownText}${sub ? `, ${sub}` : ""}${shownAction ? `, ${shownAction.verb} ${shownAction.subject ?? ""}`.trimEnd() : ""}${elapsed ? `, ${elapsed}` : ""}`;
  const done = merged ? plan.items.filter((item) => item.status === "completed").length : 0;
  return (
    <>
      <div className="run-head">
        <button
          type="button"
          className="run-hit after:absolute after:inset-0 after:content-['']"
          aria-expanded={expanded}
          aria-controls={props.rowsId}
          aria-label={label}
          data-crew-focus="head"
          data-run={run.itemId}
          onClick={props.onToggle}
        >
          <RunGlyph glyph={glyph} />
          <span className="run-tx">
            <Swap id={`${shownSource}:${shownText}`} className="run-title" title={shownText}>{shownText}</Swap>
            <span className="run-sub">
              {shownAction ? (
                <Swap id={`${shownAction.id}:${shownAction.live}`} lite className="h-[18px] min-w-0 flex-[0_1_auto]">
                  <ActionLine action={shownAction} />
                </Swap>
              ) : sub ? (
                <span className="min-w-0 truncate">{sub}</span>
              ) : null}
              <Trail ticks={ticks} />
              {/* Beside the first line while the card is wide; under it when it is narrow, where the title needs the room. */}
              <span className="crew-el run-el-sub">{stale ? elapsed : <Ticking ms={run.elapsedMs} at={run.clockAt} live={live} approx={run.elapsedApprox && live} />}</span>
            </span>
          </span>
        </button>
        <span className="side">
          {chips.map((chip) => (
            <LineChip key={chip.kind} chip={chip} onClick={chip.kind !== "stale" ? () => props.onChip(chip.kind) : undefined} />
          ))}
          <span className="crew-el">
            {stale ? elapsed : <Ticking ms={run.elapsedMs} at={run.clockAt} live={live} approx={run.elapsedApprox && live} />}
          </span>
          {props.onDismiss ? (
            <Tip label="Dismiss">
              <IconButton size="xs" label="Dismiss turn summary" className="text-subtle" onClick={props.onDismiss}>
                <XCircleIcon size={14} />
              </IconButton>
            </Tip>
          ) : null}
          <span className="inline-flex size-5 items-center justify-center text-subtle" aria-hidden="true">
            <CaretDownIcon size={13} className="run-car" />
          </span>
        </span>
      </div>
      {turn ? (
        <div className="run-rail">
          {merged ? (
            <>
              <Spine segs={stepSegs(plan)} label="Plan steps completed" />
              <span className="cnt">{done}/{plan.items.length}</span>
            </>
          ) : (
            <Hairline beat={beat} finished={!live} />
          )}
        </div>
      ) : (
        <div className="run-phases">
          <PhaseRail
            phases={run.phases}
            openPhase={props.openPhase}
            finale={!live}
            stale={stale}
            sheen={props.sheen}
            rowsId={props.rowsId}
            onOpen={(name) => {
              if (!expanded) props.onToggle();
              props.onOpenPhase(name);
            }}
          />
        </div>
      )}
    </>
  );
}

/**
 * The Crew card in the dock: one calm surface per run. A glance (what is happening, the call going now, a spine) is
 * always there; opening it brings the steps, the latest calls, what needs you and the controls. Every view-model
 * comes from model/crew.ts and model/runCard.ts; this component only lays it out.
 */
export function CrewCard(props: CrewCardProps) {
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
      // The body opens over a quarter of a second; focus lands once the row is there to take it.
      window.setTimeout(() => rootRef.current?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(target)}"]`)?.focus(), expanded ? 0 : 280);
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
        requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>("[data-crew-focus]")?.focus());
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

  const plan = run && props.plan && planMerges(run, props.plan) ? props.plan : null;
  const lines: Line[] = [];
  // Lines beside the primary run: another run, and while the card is shut the tasks and subagents.
  for (const other of otherRuns) {
    lines.push({ id: other.itemId, node: <CrewLine key={other.itemId} run={other} expanded={false} folded onToggle={props.onToggle} onChip={onChip} /> });
  }
  if (!expanded) {
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
            onToggle={props.onToggle}
            onStop={() => props.onAction(task.id, "stop")}
          />
        ),
      });
    }
  }
  const shownLines = lines.slice(0, LINE_LIMIT).map((line) => line.node);
  const moreLines = lines.length > LINE_LIMIT ? <MoreLine count={lines.length - LINE_LIMIT} onClick={props.onToggle} /> : null;

  const peekFor = (id: string): ReactNode => {
    const agent = peekId === id ? agentsById.get(id) : undefined;
    return agent ? <Peek agent={agent} run={run} stale={stale} /> : null;
  };

  /** Rows for tasks or subagents; `hide` adds the link that shuts the card, for a thread that has no run to carry the head. */
  const taskRows = (items: AgentVM[], title: string, hide = false): ReactNode => {
    if (items.length === 0) return null;
    return (
      <>
        <div className="run-sec">
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

  let primary: ReactNode = null;
  if (run && props.completion && run.kind !== "turn") {
    primary = (
      <CompletionReport
        run={run}
        completion={props.completion}
        expanded={expanded}
        sheen={props.sheen}
        compact={props.compact}
        onToggle={props.onToggle}
        onOpenPanel={props.onOpenPanel}
        onDismiss={props.onDismissReport}
        onOpenTranscript={props.onOpenTranscript}
      />
    );
    if (expanded && tasks.length + subagents.length > 0) {
      primary = (
        <>
          {primary}
          <div className="crew-body pt-0">
            {taskRows(subagents, "Subagents")}
            {taskRows(tasks, "Background")}
          </div>
        </>
      );
    }
  } else if (run) {
    const live = runLive(run);
    const receipt = props.completion ? { title: props.completion.headline, sub: props.completion.factLine } : null;
    // A prompt has no phases to open: the plan and the latest calls say what its rail would.
    const openPhase = run.kind !== "turn" && props.openPhase ? run.phases.find((phase) => phase.name === props.openPhase) ?? null : null;
    const attention = attentionOf(run);
    const listed = new Set(attention.map((agent) => agent.id));
    const phaseRows = openPhase ? openPhase.agents.filter((agent) => !listed.has(agent.id)) : [];
    const recent = run.kind === "turn" ? recentActions(run, plan ? LATEST_WITH_PLAN : LATEST_ALONE) : [];
    const notice = stale ? (
      <div className="crew-note">
        <ClockCounterClockwiseIcon size={13} />
        <span>
          <b>Last known{run.staleAt !== null ? ` at ${formatClock(run.staleAt, run.clockAt)}` : ""}</b> · Muse is not reachable, nothing has been lost
        </span>
      </div>
    ) : run.partialHistory ? (
      <div className="crew-note">
        <InfoIcon size={13} />
        <span>
          <b>Counts are from loaded history.</b> The earliest revisions of this run were not loaded, so{" "}
          {run.agents.some((agent) => agent.label === null) ? `${plural(run.agents.filter((agent) => agent.label === null).length, "agent has", "agents have")} no name yet and ` : ""}
          the start time is approximate. Nothing here is lost; it is just not loaded.
        </span>
      </div>
    ) : null;
    const stats = footStats(run);
    primary = (
      <div className="crew-run" data-run={run.itemId} data-completion={receipt && run.kind === "turn" ? "turn" : undefined}>
        <RunHead
          run={run}
          plan={plan}
          stale={stale}
          expanded={expanded}
          rowsId={rowsId}
          receipt={receipt}
          sheen={Boolean(props.sheen)}
          onToggle={props.onToggle}
          onChip={onChip}
          onOpenPhase={props.onOpenPhase}
          openPhase={props.openPhase}
          onDismiss={receipt ? props.onDismissReport : undefined}
        />
        <Collapse open={expanded}>
          <div id={rowsId} className={cn("crew-body run-body", props.compact && "compact")}>
            {notice}
            {!stale && live ? (
              <AttentionList
                items={attention}
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
            {plan ? (
              <>
                <div className="run-sec">
                  Steps <span className="n">{plan.done} of {plan.items.length}</span>
                </div>
                <PlanSteps view={plan} />
              </>
            ) : null}
            {recent.length > 0 ? (
              <>
                <div className="run-sec">Latest</div>
                <Latest items={recent} />
              </>
            ) : null}
            {openPhase ? (
              <>
                <div className="run-sec">
                  {openPhase.name} <span className="n">{phaseHeadText(run, openPhase.name)}</span>
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
            {taskRows(subagents, "Subagents")}
            {taskRows(tasks, "Background")}
            <div className="run-foot">
              <Button size="xs" variant="ghost" onClick={() => props.onOpenPanel("roster")}>
                <RowsIcon size={12} />
                <span className="lbl">{run.kind === "turn" ? "Activity" : `All ${run.counts.total} agents`}</span>
              </Button>
              <Button size="xs" variant="ghost" onClick={() => props.onOpenPanel("timeline")}>
                <ChartBarIcon size={12} />
                <span className="lbl">Timeline</span>
              </Button>
              <span className="stats" title={headSub(run).text}>{stats}</span>
              {live && !readOnly && !stale ? (
                <Button size="xs" variant="ghost" style={{ color: "var(--danger-text)" }} onClick={() => setStopAsk(true)}>
                  <StopCircleIcon size={12} />
                  <span className="lbl">Stop</span>
                </Button>
              ) : null}
            </div>
          </div>
        </Collapse>
      </div>
    );
  } else {
    primary = (
      <Collapse open={expanded}>
        <div className="crew-body compact">
          {taskRows(subagents, "Subagents", tasks.length === 0)}
          {taskRows(tasks, "Background", true)}
        </div>
      </Collapse>
    );
  }

  const working = run ? run.counts.working + run.counts.finishing + run.counts.noUpdate + run.counts.waiting : 0;
  const waiting = run ? run.runNeeds.length > 0 || run.counts.waiting > 0 : false;
  // Live and fine: the only state in which the card gives off light.
  const glowing = run !== null && runLive(run) && !stale && !waiting;
  return (
    <>
      {props.sinceYouLeft ? <SinceYouLeft recap={props.sinceYouLeft} clockAt={clockAt} onDismiss={props.onDismissRecap} /> : null}
      <section
        ref={rootRef}
        aria-label="Agents and tasks"
        data-crew-card={props.sessionId}
        data-open={expanded}
        data-live={glowing || undefined}
        data-stale={stale || undefined}
        data-wait={waiting || undefined}
        className={cn("crew-card run-card @container enter-up overflow-hidden rounded-xl bg-raised shadow-panel", stale && "crew-stale")}
        onKeyDown={onKeyDown}
      >
        {primary}
        {shownLines}
        {moreLines}
      </section>
      {run ? (
        <Modal
          open={stopAsk}
          onOpenChange={setStopAsk}
          title={run.kind === "turn" ? "Stop this turn?" : `Stop the run ${run.name}?`}
          description={run.kind === "turn" ? "Muse stops working on your prompt. Finished work stays." : `${plural(working, "working agent")} will be cancelled. Finished work stays.`}
        >
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
              <StopCircleIcon size={13} /> {run.kind === "turn" ? "Stop turn" : "Stop run"}
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

export interface CrewDockCardProps {
  sessionId: string;
  view: CrewVM;
  stale: boolean;
  readOnly: boolean;
  /** A request panel sits under the card. */
  compact: boolean;
  /** The thread's plan, already left out when the user closed it; the card folds it in when it is the run's own. */
  plan?: TaskPlanView | null;
}

/**
 * The card as the dock mounts it: reads the prefs and the Crew state, keeps the open phase and the roving
 * selection per run, decides which runs and tasks still belong in the dock, and routes every action to the
 * controller. Renders nothing when the thread has nothing live and no fresh report: idle cost is zero.
 */
export function CrewDockCard(props: CrewDockCardProps) {
  const controller = useController();
  const { sessionId, view } = props;
  const key = crewCardKey(sessionId);
  const expanded = useApp((s) => s.prefs.openCards.includes(key));
  const dismissedReports = useApp((s) => s.crew.dismissedReports);
  const pending = useApp((s) => s.crew.pending);
  const leftAt = useApp((s) => s.crew.leftAt[sessionId] ?? null);
  const now = view.runs[0]?.clockAt ?? Date.now();

  const visibleRuns = view.runs.filter((run) => runLive(run) || reportVisible(run, now, dismissedReports.includes(`${sessionId}:${run.itemId}`)));
  const primary = primaryRun(view, sessionId, now, dismissedReports);
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
      void controller.crewAction(sessionId, agent, routed);
    },
    [agentOf, controller, sessionId],
  );
  const onOpenPanel = useCallback(
    (which: "roster" | "timeline") => {
      const panel = controller.store.get().crew.panels[sessionId];
      if (which === "timeline" && !(panel?.timelineOpen ?? false)) controller.toggleTimeline(sessionId);
      controller.toggleCrewPanel(true);
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
      <CrewAnnouncer view={view} quiet={props.stale} />
      <CrewCard
        sessionId={sessionId}
        run={run}
        otherRuns={otherRuns}
        tasks={tasks}
        subagents={subagents}
        completion={completion}
        sinceYouLeft={recap}
        plan={props.plan ?? null}
        expanded={expanded}
        openPhase={openPhase}
        selectedId={selectedId}
        readOnly={props.readOnly}
        stale={props.stale}
        compact={props.compact}
        sheen={sheen}
        outputOf={outputOf}
        onToggle={() => controller.setCardExpanded(key, !expanded)}
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
        onOpenTranscript={run ? () => document.querySelector(`[data-crew-anchor="${CSS.escape(run.itemId)}"]`)?.scrollIntoView({ block: "center" }) : undefined}
      />
    </>
  );
}
