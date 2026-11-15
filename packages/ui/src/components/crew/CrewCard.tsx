import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { formatClock, formatTokens } from "../../model/format.js";
import type { AncillaController } from "../../model/controller.js";
import { formatCost } from "../../model/pricing.js";
import { completionView, durationText, pendingKey, reportCoverage, runLive, sinceYouLeft, summaryLine } from "../../model/crew.js";
import type { AgentVM, CompletionVM, CrewVM, PendingAction, RunVM, SinceYouLeftVM, SummaryChip } from "../../model/crew.js";
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

/** Key prefix for saving expand/collapse preference in user settings. */
export function crewCardKey(sessionId: string): string {
  return `crew:${sessionId}`;
}

/** Milliseconds duration a finished execution summary remains visible in the dock. */
export const REPORT_SHOWN_MS = 24 * 60 * 60_000;
/** Milliseconds duration a completed background task or subagent remains in feed. */
export const TASK_SHOWN_MS = 10 * 60_000;
/** Maximum individual task lines displayed before folding into count pill. */
export const LINE_LIMIT = 3;

const TITLE_HOLD_DWELL_MS = 900;
const ACTION_HOLD_DWELL_MS = 700;
const LATEST_ACTIONS_WITH_PLAN = 4;
const LATEST_ACTIONS_STANDALONE = 6;

/** Evaluates whether ended execution report should still render in dock. */
export function reportVisible(run: RunVM, now: number, dismissed: boolean): boolean {
  if (runLive(run) || dismissed) {
    return false;
  }
  const completionTime = run.endedAt ?? run.clockAt;
  return now - completionTime < REPORT_SHOWN_MS;
}

/** Selects primary run for card header representation. */
export function primaryRun(
  view: CrewVM,
  sessionId: string,
  now: number,
  dismissedReports: readonly string[],
): RunVM | null {
  const matchingRuns = view.runs.filter(
    (item) => runLive(item) || reportVisible(item, now, dismissedReports.includes(`${sessionId}:${item.itemId}`)),
  );
  const activeOnly = matchingRuns.filter(runLive);
  if (activeOnly.length > 0) {
    return activeOnly[activeOnly.length - 1] as RunVM;
  }
  return matchingRuns.length > 0 ? (matchingRuns[matchingRuns.length - 1] as RunVM) : null;
}

/** Injects optimistic retry state on failed agents prior to server confirmation. */
export function withPendingRetries(
  run: RunVM,
  sessionId: string,
  pending: Readonly<Record<string, PendingAction>>,
): RunVM {
  const retryOverrides = new Map<string, AgentVM>();
  for (const ag of run.agents) {
    if (ag.state === "failed" && ag.pending === null) {
      const actionKey = pendingKey(sessionId, ag.id, ag.attempt);
      if (pending[actionKey] === "retry") {
        retryOverrides.set(ag.id, { ...ag, pending: "retry" });
      }
    }
  }

  if (retryOverrides.size === 0) {
    return run;
  }

  const mapAgent = (agent: AgentVM): AgentVM => retryOverrides.get(agent.id) ?? agent;

  return {
    ...run,
    agents: run.agents.map(mapAgent),
    attention: run.attention.map(mapAgent),
    phases: run.phases.map((ph) => {
      const containsUpdated = ph.agents.some((ag) => retryOverrides.has(ag.id));
      return containsUpdated ? { ...ph, agents: ph.agents.map(mapAgent) } : ph;
    }),
  };
}

/** Computes default phase to unfold in card accordion. */
export function defaultOpenPhase(run: RunVM): string | null {
  const currentPhaseObject = run.phases.find((ph) => ph.name === run.currentPhase) ?? null;
  if (!currentPhaseObject) {
    return null;
  }
  const attentionIdSet = new Set(run.attention.map((ag) => ag.id));
  const areAllAgentsInAttention = currentPhaseObject.agents.every((ag) => attentionIdSet.has(ag.id));
  return areAllAgentsInAttention ? null : currentPhaseObject.name;
}

/** Opens card for given session and moves focus to header. */
export function focusCrewCard(controller: AncillaController, sessionId: string): void {
  controller.setCardExpanded(crewCardKey(sessionId), true);
  if (typeof document === "undefined") {
    return;
  }
  requestAnimationFrame(() => {
    const rootCard = document.querySelector<HTMLElement>(`[data-crew-card="${sessionId}"]`);
    rootCard?.scrollIntoView({ block: "nearest" });
    rootCard?.querySelector<HTMLElement>("[data-crew-focus]")?.focus();
  });
}

/** Builds comprehensive run facts summary string. */
export function headSub(run: RunVM): { text: string } {
  const nonPlannedCount = run.counts.total - run.counts.planned;
  const parts: string[] = [runKindWord(run)];

  if (run.startedAt !== null && !run.elapsedApprox) {
    parts.push(`started ${formatClock(run.startedAt, run.clockAt)}`);
  }

  if (run.kind === "turn") {
    const totalTools = run.agents.filter((ag) => ag.kind === "task").length;
    parts.push(`Muse · ${plural(totalTools, "tool")}`);
  } else {
    const plannedAnnotation = run.counts.planned > 0 ? ` · ${run.counts.planned} planned` : "";
    parts.push(`${plural(nonPlannedCount, "agent")}${plannedAnnotation}`);
  }

  if (run.tokens) {
    const coverageReport = reportCoverage(run);
    const liveSuffix = runLive(run) ? " so far" : "";
    const coverageSuffix = coverageReport ? ` (${coverageReport})` : "";
    parts.push(`${formatTokens(run.tokens.total)} tokens${liveSuffix}${coverageSuffix}`);
  }

  if (run.cost) {
    parts.push(`~${formatCost(run.cost.usd)} est.`);
  }

  return { text: parts.join(" · ") };
}

/** Assembles live execution count metrics for card footer. */
export function footMeta(run: RunVM): string {
  const countsObj = run.counts;
  const activeCount = countsObj.working + countsObj.finishing + countsObj.noUpdate + countsObj.waiting;
  const parts: string[] = [`${countsObj.done} done`];

  if (countsObj.failed > 0) parts.push(`${countsObj.failed} failed`);
  if (countsObj.skipped > 0) parts.push(`${countsObj.skipped} skipped`);
  if (activeCount > 0) parts.push(`${activeCount} running`);
  if (countsObj.scheduled > 0) parts.push(`${countsObj.scheduled} queued`);
  if (countsObj.planned > 0) parts.push(`${countsObj.planned} planned`);

  return parts.join(" · ");
}

/** Assembles heading status line for an expanded phase section. */
export function phaseHeadText(run: RunVM, name: string): string | null {
  const phaseObj = run.phases.find((ph) => ph.name === name);
  if (!phaseObj) {
    return null;
  }
  const attentionCount = phaseObj.agents.filter((ag) => run.attention.some((att) => att.id === ag.id)).length;
  const unitName = name === "Tools" ? "tool" : "agent";
  const parts: string[] = [
    plural(phaseObj.counts.total, unitName),
    `${phaseObj.counts.done} done`,
  ];

  if (phaseObj.counts.failed > 0) parts.push(`${phaseObj.counts.failed} failed`);
  if (phaseObj.counts.skipped > 0) parts.push(`${phaseObj.counts.skipped} skipped`);
  if (attentionCount > 0) parts.push(`${attentionCount} listed above`);
  if (phaseObj.durationMs !== null) parts.push(durationText(phaseObj.durationMs));
  if (phaseObj.tokens !== null && phaseObj.tokens > 0) parts.push(formatTokens(phaseObj.tokens));

  return parts.join(" · ");
}

/** Formats footer metrics line based on run kind. */
export function footStats(run: RunVM): string {
  if (run.kind !== "turn") {
    return footMeta(run);
  }
  const actionCount = run.agents.filter((ag) => ag.kind === "task").length;
  const parts: string[] = [plural(actionCount, "action")];
  if (run.tokens) {
    const liveSuffix = runLive(run) ? " so far" : "";
    parts.push(`${formatTokens(run.tokens.total)} tokens${liveSuffix}`);
  }
  return parts.join(" · ");
}

export interface CrewCardProps {
  readonly sessionId: string;
  readonly expanded: boolean;
  readonly readOnly: boolean;
  readonly run: RunVM | null;
  readonly completion: CompletionVM | null;
  readonly sinceYouLeft: SinceYouLeftVM | null;
  readonly tasks: AgentVM[];
  readonly openPhase: string | null;
  readonly selectedId: string | null;
  readonly otherRuns?: RunVM[];
  readonly subagents?: AgentVM[];
  readonly plan?: TaskPlanView | null;
  readonly stale?: boolean;
  readonly compact?: boolean;
  readonly sheen?: boolean;
  outputOf?(taskId: string): string | null;
  onToggle(): void;
  onOpenPhase(name: string | null): void;
  onInspect(id: string): void;
  onOpenPanel(view: "roster" | "timeline"): void;
  onAction(id: string, action: RowAction): void;
  onStopRun(): void;
  onDismissReport(): void;
  onDismissRecap(): void;
  onReview(requestId: string): void;
  onSelect?(id: string): void;
  onOpenTranscript?(): void;
}

interface RunHeadProps {
  run: RunVM;
  plan: TaskPlanView | null;
  stale: boolean;
  expanded: boolean;
  rowsId: string;
  receipt: { title: string; sub: string } | null;
  sheen: boolean;
  openPhase: string | null;
  onToggle: () => void;
  onChip: (kind: SummaryChip["kind"]) => void;
  onOpenPhase: (name: string | null) => void;
  onDismiss?: () => void;
}

interface RunHeadButtonProps {
  run: RunVM;
  expanded: boolean;
  rowsId: string;
  label: string;
  shownSource: string;
  shownText: string;
  shownAction: ReturnType<typeof subAction>;
  sub: string | null;
  ticks: ReturnType<typeof trailOf>;
  stale: boolean;
  elapsed: string | null;
  live: boolean;
  onToggle: () => void;
}

function RunHeadTriggerButton({
  run,
  expanded,
  rowsId,
  label,
  shownSource,
  shownText,
  shownAction,
  sub,
  ticks,
  stale,
  elapsed,
  live,
  onToggle,
}: RunHeadButtonProps): ReactElement {
  const currentGlyph = glyphOf(run);

  return (
    <button
      type="button"
      className="run-hit after:absolute after:inset-0 after:content-['']"
      aria-expanded={expanded}
      aria-controls={rowsId}
      aria-label={label}
      data-crew-focus="head"
      data-run={run.itemId}
      onClick={onToggle}
    >
      <RunGlyph glyph={currentGlyph} />
      <span className="run-tx">
        <Swap id={`${shownSource}:${shownText}`} className="run-title" title={shownText}>
          {shownText}
        </Swap>
        <span className="run-sub">
          {shownAction ? (
            <Swap
              id={`${shownAction.id}:${shownAction.live}`}
              lite
              className="h-[18px] min-w-0 flex-[0_1_auto]"
            >
              <ActionLine action={shownAction} />
            </Swap>
          ) : sub ? (
            <span className="min-w-0 truncate">{sub}</span>
          ) : null}
          <Trail ticks={ticks} />
          <span className="crew-el run-el-sub">
            {stale ? elapsed : <Ticking ms={run.elapsedMs} at={run.clockAt} live={live} approx={run.elapsedApprox && live} />}
          </span>
        </span>
      </span>
    </button>
  );
}

interface RunHeadSideProps {
  chips: ReturnType<typeof chipsOf>;
  stale: boolean;
  elapsed: string | null;
  run: RunVM;
  live: boolean;
  onChip: (kind: SummaryChip["kind"]) => void;
  onDismiss?: () => void;
}

function RunHeadSideTray({
  chips,
  stale,
  elapsed,
  run,
  live,
  onChip,
  onDismiss,
}: RunHeadSideProps): ReactElement {
  return (
    <span className="side">
      {chips.map((chipItem) => (
        <LineChip
          key={chipItem.kind}
          chip={chipItem}
          onClick={chipItem.kind !== "stale" ? () => onChip(chipItem.kind) : undefined}
        />
      ))}
      <span className="crew-el">
        {stale ? elapsed : <Ticking ms={run.elapsedMs} at={run.clockAt} live={live} approx={run.elapsedApprox && live} />}
      </span>
      {onDismiss ? (
        <Tip label="Dismiss">
          <IconButton
            size="xs"
            label="Dismiss turn summary"
            className="text-subtle"
            onClick={onDismiss}
          >
            <XCircleIcon size={14} />
          </IconButton>
        </Tip>
      ) : null}
      <span className="inline-flex size-5 items-center justify-center text-subtle" aria-hidden="true">
        <CaretDownIcon className="run-car" size={13} />
      </span>
    </span>
  );
}

function RunHeadProgressRail({
  run,
  plan,
  merged,
  beat,
  live,
  stale,
  expanded,
  sheen,
  rowsId,
  openPhase,
  onToggle,
  onOpenPhase,
}: {
  run: RunVM;
  plan: TaskPlanView | null;
  merged: boolean;
  beat: number;
  live: boolean;
  stale: boolean;
  expanded: boolean;
  sheen: boolean;
  rowsId: string;
  openPhase: string | null;
  onToggle: () => void;
  onOpenPhase: (name: string | null) => void;
}): ReactElement {
  if (run.kind === "turn") {
    const completedPlanCount = plan ? plan.items.filter((it) => it.status === "completed").length : 0;
    return (
      <div className="run-rail">
        {merged && plan ? (
          <>
            <Spine segs={stepSegs(plan)} label="Plan steps completed" />
            <span className="cnt">{completedPlanCount}/{plan.items.length}</span>
          </>
        ) : (
          <Hairline beat={beat} finished={!live} />
        )}
      </div>
    );
  }

  return (
    <div className="run-phases">
      <PhaseRail
        phases={run.phases}
        openPhase={openPhase}
        finale={!live}
        stale={stale}
        sheen={sheen}
        rowsId={rowsId}
        onOpen={(phaseName) => {
          if (!expanded) {
            onToggle();
          }
          onOpenPhase(phaseName);
        }}
      />
    </div>
  );
}

function RunHead(props: RunHeadProps): ReactElement {
  const { run, plan, stale, expanded, receipt } = props;
  const isLive = runLive(run);
  const isTurn = run.kind === "turn";
  const lineData = summaryLine(run);

  const initialTitle: Title = receipt ? { text: receipt.title, source: "end" } : titleOf(run, plan);
  const dwellKey = `${initialTitle.source}\u0001${initialTitle.text}`;
  const resolvedKey = useDwell(dwellKey, !isLive || initialTitle.source === "need" ? 0 : TITLE_HOLD_DWELL_MS);
  const [activeSource, ...textParts] = resolvedKey.split("\u0001");
  const activeText = textParts.join("\u0001");

  const resolvedTitle: Title = { text: activeText, source: activeSource as Title["source"] };
  const candidateAction = isLive && !receipt && resolvedTitle.source !== "action" ? subAction(run) : null;
  const heldActionId = useDwell(candidateAction ? candidateAction.id : null, ACTION_HOLD_DWELL_MS);
  const activeAction = candidateAction ? actionById(run, heldActionId ?? candidateAction.id) ?? candidateAction : null;

  const subtitleText = receipt ? receipt.sub : subText(run, resolvedTitle);
  const isPlanMerged = plan !== null && planMerges(run, plan);
  const trailTicks = isTurn ? trailOf(run) : [];
  const beatIndex = isTurn ? endedCount(run) : 0;
  const summaryChips = chipsOf(run);
  const elapsedText = lineData.elapsed;

  const subjectSuffix = activeAction?.subject ? ` ${activeAction.subject}` : "";
  const actionPhrase = activeAction ? `, ${activeAction.verb}${subjectSuffix}` : "";
  const subPhrase = subtitleText ? `, ${subtitleText}` : "";
  const elapsedPhrase = elapsedText ? `, ${elapsedText}` : "";
  const fullAriaLabel = `${activeText}${subPhrase}${actionPhrase}${elapsedPhrase}`;

  return (
    <>
      <div className="run-head">
        <RunHeadTriggerButton
          run={run}
          expanded={expanded}
          rowsId={props.rowsId}
          label={fullAriaLabel}
          shownSource={activeSource}
          shownText={activeText}
          shownAction={activeAction}
          sub={subtitleText}
          ticks={trailTicks}
          stale={stale}
          elapsed={elapsedText}
          live={isLive}
          onToggle={props.onToggle}
        />
        <RunHeadSideTray
          chips={summaryChips}
          stale={stale}
          elapsed={elapsedText}
          run={run}
          live={isLive}
          onChip={props.onChip}
          onDismiss={props.onDismiss}
        />
      </div>
      <RunHeadProgressRail
        run={run}
        plan={plan}
        merged={isPlanMerged}
        beat={beatIndex}
        live={isLive}
        stale={stale}
        expanded={expanded}
        sheen={props.sheen}
        rowsId={props.rowsId}
        openPhase={props.openPhase}
        onToggle={props.onToggle}
        onOpenPhase={props.onOpenPhase}
      />
    </>
  );
}

interface StaleOrPartialNoticeProps {
  readonly stale: boolean;
  readonly run: RunVM;
}

function CardNoticeBanner({ stale, run }: StaleOrPartialNoticeProps): ReactElement | null {
  if (stale) {
    const staleTimeSuffix = run.staleAt !== null ? ` at ${formatClock(run.staleAt, run.clockAt)}` : "";
    return (
      <div className="crew-note">
        <ClockCounterClockwiseIcon size={13} />
        <span>
          <b>Last known{staleTimeSuffix}</b> · Muse is not reachable, nothing has been lost
        </span>
      </div>
    );
  }

  if (run.partialHistory) {
    const unlabelledCount = run.agents.filter((ag) => ag.label === null).length;
    const unlabelledPhrase = unlabelledCount > 0
      ? `${plural(unlabelledCount, "agent has", "agents have")} no name yet and `
      : "";

    return (
      <div className="crew-note">
        <InfoIcon size={13} />
        <span>
          <b>Counts are from loaded history.</b> The earliest revisions of this run were not loaded, so{" "}
          {unlabelledPhrase}the start time is approximate. Nothing here is lost; it is just not loaded.
        </span>
      </div>
    );
  }

  return null;
}

interface FooterControlsProps {
  run: RunVM;
  live: boolean;
  readOnly: boolean;
  stale: boolean;
  statsText: string;
  onOpenPanel: (view: "roster" | "timeline") => void;
  onRequestStop: () => void;
}

function CardFooterTray({
  run,
  live,
  readOnly,
  stale,
  statsText,
  onOpenPanel,
  onRequestStop,
}: FooterControlsProps): ReactElement {
  const rosterButtonLabel = run.kind === "turn" ? "Activity" : `All ${run.counts.total} agents`;
  const canStop = live && !readOnly && !stale;

  return (
    <div className="run-foot">
      <Button size="xs" variant="ghost" onClick={() => onOpenPanel("roster")}>
        <RowsIcon size={12} />
        <span className="lbl">{rosterButtonLabel}</span>
      </Button>
      <Button size="xs" variant="ghost" onClick={() => onOpenPanel("timeline")}>
        <ChartBarIcon size={12} />
        <span className="lbl">Timeline</span>
      </Button>
      <span className="stats" title={headSub(run).text}>
        {statsText}
      </span>
      {canStop ? (
        <Button
          size="xs"
          variant="ghost"
          style={{ color: "var(--danger-text)" }}
          onClick={onRequestStop}
        >
          <StopCircleIcon size={12} />
          <span className="lbl">Stop</span>
        </Button>
      ) : null}
    </div>
  );
}

function StopRunConfirmationModal({
  isOpen,
  run,
  onKeep,
  onConfirm,
}: {
  isOpen: boolean;
  run: RunVM;
  onKeep: () => void;
  onConfirm: () => void;
}): ReactElement {
  const activeCount = run.counts.working + run.counts.finishing + run.counts.noUpdate + run.counts.waiting;
  const isTurn = run.kind === "turn";
  const modalTitle = isTurn ? "Stop this turn?" : `Stop the run ${run.name}?`;
  const modalDesc = isTurn
    ? "Muse stops working on your prompt. Finished work stays."
    : `${plural(activeCount, "working agent")} will be cancelled. Finished work stays.`;

  return (
    <Modal
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
      title={modalTitle}
      description={modalDesc}
    >
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onKeep}>
          Keep
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          <StopCircleIcon size={13} /> {isTurn ? "Stop turn" : "Stop run"}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * CrewCard component: renders concise card in transcript dock summarizing run execution.
 */
export function CrewCard(props: CrewCardProps): ReactElement {
  const { run, tasks, expanded, readOnly } = props;
  const otherRuns = props.otherRuns ?? [];
  const subagents = props.subagents ?? [];
  const isStale = props.stale ?? false;
  const currentClockAt = run?.clockAt ?? tasks[0]?.lastEventAt ?? Date.now();

  const cardRootRef = useRef<HTMLElement>(null);
  const uniqueRowsId = useId();
  const [activeConfirmation, setActiveConfirmation] = useState<{ id: string; action: ConfirmAction } | null>(null);
  const [activePeekId, setActivePeekId] = useState<string | null>(null);
  const [isStopAskOpen, setIsStopAskOpen] = useState(false);

  const lookupAgentsMap = useMemo(() => {
    const dict = new Map<string, AgentVM>();
    for (const ag of [...(run?.agents ?? []), ...tasks, ...subagents]) {
      dict.set(ag.id, ag);
    }
    return dict;
  }, [run, tasks, subagents]);

  const handleConfirmationChange = useCallback(
    (agentId: string, action: ConfirmAction | null) => {
      setActiveConfirmation(action ? { id: agentId, action } : null);
    },
    [],
  );

  const resolveChipFocusTarget = (chipKind: SummaryChip["kind"]): string | null => {
    if (!run) {
      return null;
    }
    if (chipKind === "needs") {
      return run.runNeeds[0]
        ? needRowId(run.runNeeds[0])
        : (run.attention.find((ag) => ag.state === "waiting-on-you")?.id ?? null);
    }
    if (chipKind === "failed" || chipKind === "run-failed") {
      return run.attention.find((ag) => ag.state === "failed")?.id ?? null;
    }
    if (chipKind === "no-update") {
      return run.attention.find((ag) => ag.state === "no-update")?.id ?? null;
    }
    return null;
  };

  const handleChipClick = (chipKind: SummaryChip["kind"]) => {
    if (!expanded) {
      props.onToggle();
    }
    const focusTarget = resolveChipFocusTarget(chipKind);
    if (focusTarget) {
      props.onSelect?.(focusTarget);
      const delayMs = expanded ? 0 : 280;
      window.setTimeout(() => {
        cardRootRef.current?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(focusTarget)}"]`)?.focus();
      }, delayMs);
    }
  };

  const handleKeyMapAction = useCardKeys(cardRootRef, {
    escape: () => {
      if (activePeekId !== null) {
        setActivePeekId(null);
      } else if (activeConfirmation) {
        setActiveConfirmation(null);
      } else if (expanded) {
        props.onToggle();
        requestAnimationFrame(() => {
          cardRootRef.current?.querySelector<HTMLElement>("[data-crew-focus]")?.focus();
        });
      }
    },
    toggle: props.onToggle,
    openPhase: (name) => props.onOpenPhase(props.openPhase === name ? null : name),
    inspect: (id) => (id.startsWith("need:") ? props.onReview(id.slice(5)) : props.onInspect(id)),
    peek: (id) => setActivePeekId((cur) => (cur === id ? null : id)),
    retry: (id) => props.onAction(id, "retry"),
    skip: (id) => setActiveConfirmation({ id, action: "skip" }),
    stop: (id) => {
      const targetAgent = lookupAgentsMap.get(id);
      if (targetAgent?.kind === "research") {
        return;
      }
      if (targetAgent && (targetAgent.kind === "task" || targetAgent.kind === "subagent")) {
        props.onAction(id, "stop");
      } else if (targetAgent) {
        setActiveConfirmation({ id, action: "stop" });
      }
    },
    stopRun: () => {
      if (run && runLive(run) && !readOnly && !isStale) {
        setIsStopAskOpen(true);
      }
    },
  });

  useEffect(() => {
    if (activePeekId !== null && !lookupAgentsMap.has(activePeekId)) {
      setActivePeekId(null);
    }
  }, [activePeekId, lookupAgentsMap]);

  const activeMergedPlan = run && props.plan && planMerges(run, props.plan) ? props.plan : null;

  const foldedLineItems: { id: string; node: ReactNode }[] = [];
  for (const extraRun of otherRuns) {
    foldedLineItems.push({
      id: extraRun.itemId,
      node: (
        <CrewLine
          key={extraRun.itemId}
          run={extraRun}
          expanded={false}
          folded
          onToggle={props.onToggle}
          onChip={handleChipClick}
        />
      ),
    });
  }

  if (!expanded) {
    for (const bgItem of [...tasks, ...subagents]) {
      foldedLineItems.push({
        id: bgItem.id,
        node: (
          <TaskLine
            key={bgItem.id}
            task={bgItem}
            clockAt={currentClockAt}
            expanded={expanded}
            selected={props.selectedId === bgItem.id || (props.selectedId === null && !run && foldedLineItems.length === 0)}
            readOnly={readOnly}
            onToggle={props.onToggle}
            onStop={() => props.onAction(bgItem.id, "stop")}
          />
        ),
      });
    }
  }

  const visibleSummaryLines = foldedLineItems.slice(0, LINE_LIMIT).map((it) => it.node);
  const remainingCountPill = foldedLineItems.length > LINE_LIMIT ? (
    <MoreLine count={foldedLineItems.length - LINE_LIMIT} onClick={props.onToggle} />
  ) : null;

  const renderPeekView = (agentId: string): ReactNode => {
    const peekAgent = activePeekId === agentId ? lookupAgentsMap.get(agentId) : undefined;
    return peekAgent ? <Peek agent={peekAgent} run={run} stale={isStale} /> : null;
  };

interface TaskSectionHeadingProps {
  readonly title: string;
  readonly count: number;
  readonly showHideToggle: boolean;
  onToggle: () => void;
}

function TaskSectionHeading({
  title,
  count,
  showHideToggle,
  onToggle,
}: TaskSectionHeadingProps): ReactElement {
  return (
    <div className="run-sec">
      {title} <span className="n">{count}</span>
      {showHideToggle ? <span className="min-w-0 flex-1" /> : null}
      {showHideToggle ? (
        <button type="button" className="lnk" onClick={onToggle}>
          <span>Hide</span>
          <CaretUpIcon className="shrink-0" size={11} />
        </button>
      ) : null}
    </div>
  );
}

  const renderTaskRowsSection = (
    itemsList: AgentVM[],
    sectionTitle: string,
    showHideToggle = false,
  ): ReactNode => {
    if (itemsList.length === 0) {
      return null;
    }
    return (
      <>
        <TaskSectionHeading
          title={sectionTitle}
          count={itemsList.length}
          showHideToggle={showHideToggle}
          onToggle={props.onToggle}
        />
        <div role="grid" aria-label={sectionTitle} className="flex flex-col">
          {itemsList.map((taskItem) => (
            <div key={taskItem.id} className="relative">
              {taskItem.kind === "task" ? (
                <BackgroundTaskRow
                  task={taskItem}
                  clockAt={currentClockAt}
                  selected={props.selectedId === taskItem.id}
                  readOnly={readOnly}
                  stale={isStale}
                  output={props.outputOf?.(taskItem.id) ?? null}
                  onStop={() => props.onAction(taskItem.id, "stop")}
                  onSelect={props.onSelect}
                  onInspect={props.onInspect}
                  onReview={props.onReview}
                />
              ) : (
                <AgentRow
                  agent={taskItem}
                  variant="compact"
                  selected={props.selectedId === taskItem.id}
                  readOnly={readOnly}
                  stale={isStale}
                  clockAt={currentClockAt}
                  onAction={props.onAction}
                  onInspect={props.onInspect}
                  onSelect={props.onSelect}
                />
              )}
              {renderPeekView(taskItem.id)}
            </div>
          ))}
        </div>
      </>
    );
  };

  let primaryBodyContent: ReactNode = null;
  if (run && props.completion && run.kind !== "turn") {
    primaryBodyContent = (
      <CompletionReport
        onToggle={props.onToggle}
        run={run}
        onOpenPanel={props.onOpenPanel}
        completion={props.completion}
        compact={props.compact}
        onDismiss={props.onDismissReport}
        sheen={props.sheen}
        onOpenTranscript={props.onOpenTranscript}
        expanded={expanded}
      />
    );
    if (expanded && tasks.length + subagents.length > 0) {
      primaryBodyContent = (
        <>
          {primaryBodyContent}
          <div className="crew-body pt-0">
            {renderTaskRowsSection(subagents, "Subagents")}
            {renderTaskRowsSection(tasks, "Background")}
          </div>
        </>
      );
    }
  } else if (run) {
    const isRunActive = runLive(run);
    const receiptSummary = props.completion
      ? { title: props.completion.headline, sub: props.completion.factLine }
      : null;
    const unfoldedPhaseObject = run.kind !== "turn" && props.openPhase
      ? run.phases.find((ph) => ph.name === props.openPhase) ?? null
      : null;
    const attentionAgentsList = attentionOf(run);
    const attentionIdSet = new Set(attentionAgentsList.map((ag) => ag.id));
    const phaseAgentsList = unfoldedPhaseObject
      ? unfoldedPhaseObject.agents.filter((ag) => !attentionIdSet.has(ag.id))
      : [];
    const recentActivityList = run.kind === "turn"
      ? recentActions(run, activeMergedPlan ? LATEST_ACTIONS_WITH_PLAN : LATEST_ACTIONS_STANDALONE)
      : [];
    const formattedStats = footStats(run);

    primaryBodyContent = (
      <div
        className="crew-run"
        data-run={run.itemId}
        data-completion={receiptSummary && run.kind === "turn" ? "turn" : undefined}
      >
        <RunHead
          run={run}
          plan={activeMergedPlan}
          stale={isStale}
          expanded={expanded}
          rowsId={uniqueRowsId}
          receipt={receiptSummary}
          sheen={Boolean(props.sheen)}
          openPhase={props.openPhase}
          onToggle={props.onToggle}
          onChip={handleChipClick}
          onOpenPhase={props.onOpenPhase}
          onDismiss={receiptSummary ? props.onDismissReport : undefined}
        />
        <Collapse open={expanded}>
          <div id={uniqueRowsId} className={cn("crew-body run-body", props.compact && "compact")}>
            <CardNoticeBanner stale={isStale} run={run} />

            {!isStale && isRunActive ? (
              <AttentionList
                readOnly={readOnly}
                selectedId={props.selectedId}
                runNeeds={run.runNeeds}
                confirming={activeConfirmation}
                clockAt={run.clockAt}
                items={attentionAgentsList}
                onAction={props.onAction}
                onConfirm={handleConfirmationChange}
                onInspect={props.onInspect}
                onReview={props.onReview}
                onSelect={props.onSelect}
              />
            ) : null}

            {activeMergedPlan ? (
              <>
                <div className="run-sec">
                  Steps <span className="n">{activeMergedPlan.done} of {activeMergedPlan.items.length}</span>
                </div>
                <PlanSteps view={activeMergedPlan} />
              </>
            ) : null}

            {recentActivityList.length > 0 ? (
              <>
                <div className="run-sec">Latest</div>
                <Latest items={recentActivityList} />
              </>
            ) : null}

            {unfoldedPhaseObject ? (
              <>
                <div className="run-sec">
                  {unfoldedPhaseObject.name}{" "}
                  <span className="n">{phaseHeadText(run, unfoldedPhaseObject.name)}</span>
                </div>
                <div role="grid" aria-label={`${unfoldedPhaseObject.name} agents`} className="flex flex-col">
                  {phaseAgentsList.map((agentItem) => (
                    <div key={agentItem.id} className="relative">
                      <AgentRow
                        variant="compact"
                        agent={agentItem}
                        readOnly={readOnly}
                        selected={props.selectedId === agentItem.id}
                        clockAt={run.clockAt}
                        stale={isStale}
                        confirm={activeConfirmation?.id === agentItem.id ? activeConfirmation.action : null}
                        onInspect={props.onInspect}
                        onAction={props.onAction}
                        onConfirm={handleConfirmationChange}
                        onSelect={props.onSelect}
                      />
                      {renderPeekView(agentItem.id)}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {renderTaskRowsSection(subagents, "Subagents")}
            {renderTaskRowsSection(tasks, "Background")}

            <CardFooterTray
              run={run}
              live={isRunActive}
              readOnly={readOnly}
              stale={isStale}
              statsText={formattedStats}
              onOpenPanel={props.onOpenPanel}
              onRequestStop={() => setIsStopAskOpen(true)}
            />
          </div>
        </Collapse>
      </div>
    );
  } else {
    primaryBodyContent = (
      <Collapse open={expanded}>
        <div className="crew-body compact">
          {renderTaskRowsSection(subagents, "Subagents", tasks.length === 0)}
          {renderTaskRowsSection(tasks, "Background", true)}
        </div>
      </Collapse>
    );
  }

  const isWaitingAttention = run ? run.runNeeds.length > 0 || run.counts.waiting > 0 : false;
  const isGlowingActive = run !== null && runLive(run) && !isStale && !isWaitingAttention;

  return (
    <>
      {props.sinceYouLeft ? (
        <SinceYouLeft
          recap={props.sinceYouLeft}
          clockAt={currentClockAt}
          onDismiss={props.onDismissRecap}
        />
      ) : null}
      <section
        ref={cardRootRef}
        aria-label="Agents and tasks"
        data-crew-card={props.sessionId}
        data-open={expanded}
        data-live={isGlowingActive || undefined}
        data-stale={isStale || undefined}
        data-wait={isWaitingAttention || undefined}
        className={cn(
          "crew-card run-card @container enter-up overflow-hidden rounded-xl bg-raised shadow-panel",
          isStale && "crew-stale",
        )}
        onKeyDown={handleKeyMapAction}
      >
        {primaryBodyContent}
        {visibleSummaryLines}
        {remainingCountPill}
      </section>
      {run ? (
        <StopRunConfirmationModal
          isOpen={isStopAskOpen}
          run={run}
          onKeep={() => setIsStopAskOpen(false)}
          onConfirm={() => {
            setIsStopAskOpen(false);
            props.onStopRun();
          }}
        />
      ) : null}
    </>
  );
}

// ============================================================================
// Dock Connected Card
// ============================================================================

const playedSheensRegistry = new Set<string>();

export interface CrewDockCardProps {
  readonly sessionId: string;
  readonly view: CrewVM;
  readonly stale: boolean;
  readonly readOnly: boolean;
  readonly compact: boolean;
  readonly plan?: TaskPlanView | null;
}

/** Connected card container mounted in transcript dock. */
export function CrewDockCard(props: CrewDockCardProps): ReactElement | null {
  const dockController = useController();
  const { sessionId, view } = props;
  const storageCardKey = crewCardKey(sessionId);

  const isCardExpanded = useApp((s) => s.prefs.openCards.includes(storageCardKey));
  const dismissedReportsList = useApp((s) => s.crew.dismissedReports);
  const pendingActionsStore = useApp((s) => s.crew.pending);
  const sessionLeftTimestamp = useApp((s) => s.crew.leftAt[sessionId] ?? null);
  const referenceTime = view.runs[0]?.clockAt ?? Date.now();

  const activeVisibleRuns = view.runs.filter(
    (item) => runLive(item) || reportVisible(item, referenceTime, dismissedReportsList.includes(`${sessionId}:${item.itemId}`)),
  );
  const topPrimaryRun = primaryRun(view, sessionId, referenceTime, dismissedReportsList);

  const targetRun = useMemo(
    () => (topPrimaryRun ? withPendingRetries(topPrimaryRun, sessionId, pendingActionsStore) : null),
    [topPrimaryRun, sessionId, pendingActionsStore],
  );

  const secondaryRunsList = activeVisibleRuns.filter((r) => r !== topPrimaryRun);
  const isAgentRecent = (agent: AgentVM): boolean => {
    return taskLive(agent) || (agent.endedAt !== null && referenceTime - agent.endedAt < TASK_SHOWN_MS);
  };
  const activeTasksList = view.tasks.filter(isAgentRecent);
  const activeSubagentsList = view.subagents.filter(isAgentRecent);

  const [activePhaseOverride, setActivePhaseOverride] = useState<{ runId: string; name: string | null } | null>(null);
  const [selectedRowState, setSelectedRowState] = useState<{ runId: string | null; id: string } | null>(null);

  const currentRunId = targetRun?.itemId ?? null;
  const unfoldedPhaseName = targetRun
    ? activePhaseOverride?.runId === targetRun.itemId
      ? activePhaseOverride.name
      : defaultOpenPhase(targetRun)
    : null;
  const highlightedRowId = selectedRowState && selectedRowState.runId === currentRunId ? selectedRowState.id : null;

  const [sessionRecapData, setSessionRecapData] = useState<SinceYouLeftVM | null>(null);
  const decidedRecapRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!targetRun || decidedRecapRunIdRef.current === targetRun.itemId) {
      return;
    }
    decidedRecapRunIdRef.current = targetRun.itemId;
    if (sessionLeftTimestamp === null) {
      return;
    }
    const computedRecap = sinceYouLeft(targetRun, sessionLeftTimestamp, referenceTime);
    if (computedRecap) {
      setSessionRecapData(computedRecap);
    } else {
      dockController.markLeft(sessionId, null);
    }
  }, [targetRun, sessionLeftTimestamp, referenceTime, dockController, sessionId]);

  const completionReportModel = useMemo(
    () => (targetRun && !runLive(targetRun) ? completionView(targetRun) : null),
    [targetRun],
  );

  const sheenEventKey = `${sessionId}:${targetRun?.itemId}`;
  const shouldPlaySheen = Boolean(completionReportModel?.sheen && targetRun && !playedSheensRegistry.has(sheenEventKey));

  useEffect(() => {
    if (completionReportModel?.sheen && targetRun) {
      playedSheensRegistry.add(sheenEventKey);
    }
  }, [completionReportModel, targetRun, sheenEventKey]);

  const lookupAgentById = useCallback(
    (id: string): AgentVM | null => {
      const candidates = [...(targetRun?.agents ?? []), ...view.tasks, ...view.subagents];
      return candidates.find((ag) => ag.id === id) ?? null;
    },
    [targetRun, view],
  );

  const handleAgentRowAction = useCallback(
    (id: string, action: RowAction) => {
      const targetAgent = lookupAgentById(id);
      if (!targetAgent) {
        return;
      }
      if (action === "review" || action === "answer") {
        focusRequestPanel(targetAgent.needs?.requestId ?? null);
        return;
      }
      if (targetAgent.kind === "research") {
        return;
      }
      const mappedAction = action === "stop" && targetAgent.kind === "workflow" ? "skip" : action;
      void dockController.crewAction(sessionId, targetAgent, mappedAction);
    },
    [dockController, lookupAgentById, sessionId],
  );

  const handleOpenPanelShortcut = useCallback(
    (panelView: "roster" | "timeline") => {
      const currentPanelPref = dockController.store.get().crew.panels[sessionId];
      if (panelView === "timeline" && !(currentPanelPref?.timelineOpen ?? false)) {
        dockController.toggleTimeline(sessionId);
      }
      dockController.toggleCrewPanel(true);
    },
    [dockController, sessionId],
  );

  const handleRowSelection = useCallback(
    (id: string) => {
      setSelectedRowState({ runId: currentRunId, id });
    },
    [currentRunId],
  );

  const fetchOutputForTask = useCallback(
    (taskId: string): string | null => {
      const itemRecord = dockController.store.get().threads[sessionId]?.fold.items[taskId];
      return itemRecord?.visibleOutput ?? null;
    },
    [dockController, sessionId],
  );

  if (!targetRun && activeTasksList.length === 0 && activeSubagentsList.length === 0) {
    return null;
  }

  return (
    <>
      <CrewAnnouncer view={view} quiet={props.stale} />
      <CrewCard
        sessionId={sessionId}
        run={targetRun}
        otherRuns={secondaryRunsList}
        tasks={activeTasksList}
        subagents={activeSubagentsList}
        completion={completionReportModel}
        sinceYouLeft={sessionRecapData}
        plan={props.plan ?? null}
        expanded={isCardExpanded}
        openPhase={unfoldedPhaseName}
        selectedId={highlightedRowId}
        readOnly={props.readOnly}
        stale={props.stale}
        compact={props.compact}
        sheen={shouldPlaySheen}
        outputOf={fetchOutputForTask}
        onToggle={() => dockController.setCardExpanded(storageCardKey, !isCardExpanded)}
        onOpenPhase={(phName) => targetRun && setActivePhaseOverride({ runId: targetRun.itemId, name: phName })}
        onSelect={handleRowSelection}
        onInspect={(id) => dockController.inspectAgent(sessionId, id)}
        onOpenPanel={handleOpenPanelShortcut}
        onAction={handleAgentRowAction}
        onStopRun={() => targetRun && void dockController.stopRun(sessionId, targetRun.itemId)}
        onDismissReport={() => targetRun && dockController.dismissReport(sessionId, targetRun.itemId)}
        onDismissRecap={() => {
          setSessionRecapData(null);
          dockController.dismissRecap(sessionId);
        }}
        onReview={(reqId) => focusRequestPanel(reqId)}
        onOpenTranscript={
          targetRun
            ? () => document.querySelector(`[data-crew-anchor="${CSS.escape(targetRun.itemId)}"]`)?.scrollIntoView({ block: "center" })
            : undefined
        }
      />
    </>
  );
}
