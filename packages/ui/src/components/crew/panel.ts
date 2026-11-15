import { formatClock, formatTokens } from "../../model/format.js";
import { phaseLine } from "../../model/research.js";
import { initiatorText, plural } from "./cardCopy.js";
import type { CrewFilter } from "../../model/store.js";
import { durationText, pendingKey, phasesOf, researchCounters, runLive, usageTotal, type AgentState, type AgentVM, type PendingAction, type PhaseVM, type RunNeedVM, type RunVM } from "../../model/crew.js";

/**
 * Common formatting and layout calculation utilities for the Crew panel, roster, and inspector.
 */
export const FILTERS: readonly CrewFilter[] = ["all", "needs", "failed", "no-update", "working", "done"];

const LIVE_AGENT_STATES = new Set<AgentState>(["scheduled", "working", "finishing", "no-update", "waiting-on-you"]);
const TERMINAL_AGENT_STATES = new Set<AgentState>(["failed", "skipped", "done", "unknown"]);
const TWO_LINE_ROW_STATES = new Set<AgentState>(["failed", "no-update", "waiting-on-you", "working", "finishing"]);

export function isLive(agent: Pick<AgentVM, "state">): boolean {
  return LIVE_AGENT_STATES.has(agent.state);
}

export function isEnded(agent: Pick<AgentVM, "state">): boolean {
  return TERMINAL_AGENT_STATES.has(agent.state);
}

export function isTall(agent: Pick<AgentVM, "state" | "pending" | "research">): boolean {
  const hasQueuedAction = agent.pending !== null;
  const isMultiLine = TWO_LINE_ROW_STATES.has(agent.state);
  const isLiveResearch = agent.research !== undefined && agent.state !== "scheduled";
  return hasQueuedAction || isMultiLine || isLiveResearch;
}

export function withPending(run: RunVM, sessionId: string, pending: Readonly<Record<string, PendingAction>>): RunVM {
  if (Object.keys(pending).length === 0) return run;

  let hasPatched = false;
  const updatedAgents = run.agents.map((agent) => {
    if (agent.pending !== null || agent.state !== "failed") {
      return agent;
    }
    const token = pendingKey(sessionId, agent.id, agent.attempt);
    const actionFlag = pending[token];
    if (actionFlag === undefined) {
      return agent;
    }
    hasPatched = true;
    return { ...agent, pending: actionFlag };
  });

  if (!hasPatched) return run;

  const agentIndex = new Map(updatedAgents.map((a) => [a.id, a]));
  const synchronizedPhases = run.phases.map((phase) => ({
    ...phase,
    agents: phase.agents.map((a) => agentIndex.get(a.id) ?? a),
  }));

  const synchronizedAttention = run.attention.map((a) => agentIndex.get(a.id) ?? a);

  return {
    ...run,
    agents: updatedAgents,
    phases: synchronizedPhases,
    attention: synchronizedAttention,
  };
}

export function filterMatches(agent: Pick<AgentVM, "state">, filter: CrewFilter): boolean {
  const st = agent.state;
  if (filter === "all") return true;
  if (filter === "needs") return st === "waiting-on-you";
  if (filter === "failed") return st === "failed";
  if (filter === "no-update") return st === "no-update";
  if (filter === "working") return st === "working" || st === "finishing";
  if (filter === "done") return st === "done";
  return false;
}

export function queryMatches(agent: Pick<AgentVM, "name" | "display">, query: string): boolean {
  const searchPattern = query.trim().toLowerCase();
  if (!searchPattern) return true;
  const matchesName = agent.name.toLowerCase().includes(searchPattern);
  const matchesPrefix = agent.display.prefix ? agent.display.prefix.toLowerCase().startsWith(searchPattern) : false;
  return matchesName || matchesPrefix;
}

export interface ChipCounts {
  readonly all: number;
  readonly needs: number;
  readonly failed: number;
  readonly noUpdate: number;
  readonly working: number;
  readonly done: number;
}

export function chipCounts(run: Pick<RunVM, "counts" | "runNeeds">): ChipCounts {
  const tally = run.counts;
  const pendingRequestsCount = run.runNeeds.length + tally.waiting;
  const activeProcessingCount = tally.working + tally.finishing;
  return {
    all: tally.total,
    needs: pendingRequestsCount,
    failed: tally.failed,
    noUpdate: tally.noUpdate,
    working: activeProcessingCount,
    done: tally.done,
  };
}

export function visibleFilters(counts: ChipCounts): CrewFilter[] {
  const activeChips: CrewFilter[] = ["all"];
  if (counts.needs > 0) activeChips.push("needs");
  if (counts.failed > 0) activeChips.push("failed");
  if (counts.noUpdate > 0) activeChips.push("no-update");
  if (counts.working > 0) activeChips.push("working");
  if (counts.done > 0) activeChips.push("done");
  return activeChips;
}

const FILTER_LABELS: Readonly<Record<CrewFilter, string>> = Object.freeze({
  all: "All",
  needs: "Needs you",
  failed: "Failed",
  "no-update": "No update",
  working: "Working",
  done: "Done",
});

export function filterLabel(filter: CrewFilter): string {
  return FILTER_LABELS[filter];
}

export function filterCount(counts: ChipCounts, filter: CrewFilter): number {
  if (filter === "all") return counts.all;
  if (filter === "needs") return counts.needs;
  if (filter === "failed") return counts.failed;
  if (filter === "no-update") return counts.noUpdate;
  if (filter === "working") return counts.working;
  return counts.done;
}

export type RosterSort = "order" | "time" | "tokens";

export function measureOf(agent: Pick<AgentVM, "durationMs" | "runningMs">): number | null {
  return agent.durationMs ?? agent.runningMs;
}

export function sortAgents(agents: readonly AgentVM[], sort: RosterSort): AgentVM[] {
  if (sort === "order") return [...agents];

  const computeAgentWeight = (item: AgentVM): number | null => {
    if (sort === "time") {
      if (isLive(item)) {
        return item.startedAt !== null ? Number.MAX_SAFE_INTEGER - item.startedAt : Number.MAX_SAFE_INTEGER;
      }
      return measureOf(item);
    }
    return item.tokens ? usageTotal(item.tokens) : null;
  };

  const prioritized = agents.map((agent, originalIdx) => ({
    agent,
    originalIdx,
    score: agent.state === "planned" ? null : computeAgentWeight(agent),
  }));

  prioritized.sort((left, right) => {
    if (left.score === null && right.score === null) return left.originalIdx - right.originalIdx;
    if (left.score === null) return 1;
    if (right.score === null) return -1;
    return right.score - left.score || left.originalIdx - right.originalIdx;
  });

  return prioritized.map((entry) => entry.agent);
}

export const FOLD_FINISHED_AT = 12;

export type RosterEntry =
  | { readonly kind: "phase"; readonly id: string; readonly phase: PhaseVM; readonly open: boolean; readonly current: boolean; readonly pseudo: boolean }
  | { readonly kind: "need"; readonly id: string; readonly need: RunNeedVM }
  | { readonly kind: "agent"; readonly id: string; readonly agent: AgentVM; readonly phase: string }
  | { readonly kind: "fold"; readonly id: string; readonly phase: string; readonly count: number };

export interface RosterOptions {
  readonly query: string;
  readonly filter: CrewFilter;
  readonly sort: RosterSort;
  readonly openPhases: readonly string[];
  readonly unfolded: ReadonlySet<string>;
  readonly subagents?: readonly AgentVM[];
  readonly tasks?: readonly AgentVM[];
}

export function phaseOpen(phase: PhaseVM, currentPhaseName: string | null, toggledPhases: readonly string[]): boolean {
  const isFocusedPhase = currentPhaseName === null || phase.name === currentPhaseName;
  const hasActiveIncidents = phase.counts.failed > 0 || phase.state === "live";
  const defaultExpansion = phase.state !== "planned" && (isFocusedPhase || hasActiveIncidents);
  const isUserOverridden = toggledPhases.includes(phase.name);
  return isUserOverridden ? !defaultExpansion : defaultExpansion;
}

export function rosterEntries(run: RunVM | null, opts: RosterOptions): RosterEntry[] {
  const entries: RosterEntry[] = [];
  const hasActiveFilters = opts.filter !== "all" || opts.query.trim().length > 0;

  if (run && opts.filter === "needs" && opts.query.trim() === "") {
    for (const req of run.runNeeds) {
      entries.push({ kind: "need", id: `need:${req.requestId}`, need: req });
    }
  }

  const auxiliaryPhases: PhaseVM[] = [];
  if (opts.tasks && opts.tasks.length > 0) auxiliaryPhases.push(...phasesOf(opts.tasks));
  if (opts.subagents && opts.subagents.length > 0) auxiliaryPhases.push(...phasesOf(opts.subagents));

  const allPhaseDescriptors: { phase: PhaseVM; isAuxiliary: boolean }[] = [];
  if (run) {
    for (const p of run.phases) allPhaseDescriptors.push({ phase: p, isAuxiliary: false });
  }
  for (const aux of auxiliaryPhases) {
    allPhaseDescriptors.push({ phase: aux, isAuxiliary: true });
  }

  for (const { phase, isAuxiliary } of allPhaseDescriptors) {
    const candidates = phase.agents.filter((a) => filterMatches(a, opts.filter) && queryMatches(a, opts.query));
    if (hasActiveFilters && candidates.length === 0) {
      continue;
    }

    let isExpanded: boolean;
    if (hasActiveFilters) {
      isExpanded = true;
    } else if (isAuxiliary) {
      isExpanded = phase.agents.some(isLive) || opts.openPhases.includes(phase.name);
    } else {
      isExpanded = phaseOpen(phase, run?.currentPhase ?? null, opts.openPhases);
    }

    const isCurrentActivePhase = !isAuxiliary && phase.name === (run?.currentPhase ?? null);
    entries.push({
      kind: "phase",
      id: `phase:${phase.name}`,
      phase,
      open: isExpanded,
      current: isCurrentActivePhase,
      pseudo: isAuxiliary,
    });

    if (!isExpanded) continue;

    const orderedWorkers = sortAgents(candidates, opts.sort);
    const completedWorkers = orderedWorkers.filter((a) => a.state === "done");
    const shouldFoldCompleted = !hasActiveFilters && completedWorkers.length > FOLD_FINISHED_AT && !opts.unfolded.has(phase.name);

    for (const worker of orderedWorkers) {
      if (shouldFoldCompleted && worker.state === "done") continue;
      entries.push({ kind: "agent", id: worker.id, agent: worker, phase: phase.name });
    }

    if (shouldFoldCompleted) {
      entries.push({ kind: "fold", id: `fold:${phase.name}`, phase: phase.name, count: completedWorkers.length });
    }
  }

  return entries;
}

export function focusOrder(entries: readonly RosterEntry[], agentsOnly = false): string[] {
  return entries
    .filter((entry) => (agentsOnly ? entry.kind === "agent" : entry.kind !== "fold"))
    .map((entry) => entry.id);
}

export function issueOrder(run: RunVM | null, entries: readonly RosterEntry[]): string[] {
  const agentIdentifiers = new Set(entries.filter((entry) => entry.kind === "agent").map((entry) => entry.id));
  const prioritizedIds: string[] = [];

  for (const item of entries) {
    if (item.kind === "need") prioritizedIds.push(item.id);
  }

  for (const attent of run?.attention ?? []) {
    if (agentIdentifiers.has(attent.id)) prioritizedIds.push(attent.id);
  }

  for (const item of entries) {
    if (item.kind === "agent" && item.agent.kind !== "workflow") {
      const isUrgentState = item.agent.state === "waiting-on-you" || item.agent.state === "failed" || item.agent.state === "no-update";
      if (isUrgentState && !prioritizedIds.includes(item.id)) {
        prioritizedIds.push(item.id);
      }
    }
  }

  return prioritizedIds;
}

export function entryHeight(entry: RosterEntry): number {
  if (entry.kind === "phase") return 34;
  if (entry.kind === "need") return 44;
  if (entry.kind === "fold") return 28;
  return isTall(entry.agent) ? 44 : 32;
}

export function clockSeconds(timestampMs: number): string {
  const d = new Date(timestampMs);
  const hrs = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, "0");
  const secs = String(d.getSeconds()).padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

export function clockMinutes(timestampMs: number, referenceNow: number): string {
  return formatClock(timestampMs, referenceNow);
}

export function silenceText(agent: Pick<AgentVM, "silenceMs">): string {
  const silenceSpan = agent.silenceMs ?? 0;
  return durationText(silenceSpan);
}

export function skippedWord(agent: Pick<AgentVM, "skippedBy">): string {
  const cause = agent.skippedBy;
  if (cause === "you") return "Skipped by you";
  if (cause === "run") return "Stopped with the run";
  return "Cancelled by Muse";
}

export function stateWord(agent: Pick<AgentVM, "state" | "pending" | "silenceMs" | "skippedBy" | "attempt" | "kind" | "taskInfo">): string {
  if (agent.pending === "retry") return `Retrying · attempt ${agent.attempt + 1} starting`;
  if (agent.pending === "stop") return "Stopping…";

  const st = agent.state;
  if (st === "planned") return "Planned · not scheduled yet";
  if (st === "scheduled") return "Queued · waiting for a slot";
  if (st === "working") return "Working";
  if (st === "finishing") return "Finishing";
  if (st === "no-update") {
    const isTaskItem = agent.kind === "task";
    const silenceDesc = silenceText(agent);
    return isTaskItem ? `No output for ${silenceDesc}` : `No update for ${silenceDesc}`;
  }
  if (st === "waiting-on-you") return "Waiting for you";
  if (st === "failed") return agent.attempt > 1 ? `Failed · ${agent.attempt} attempts` : "Failed";
  if (st === "skipped") return skippedWord(agent);
  if (st === "done") return agent.attempt > 1 ? `Done · attempt ${agent.attempt}` : "Done";
  return "Outcome not reported";
}

export function stateTone(agent: Pick<AgentVM, "state" | "pending">): "fail" | "need" | "work" | "ok" | "mute" {
  if (agent.pending !== null) return "work";
  const st = agent.state;
  if (st === "failed") return "fail";
  if (st === "waiting-on-you") return "need";
  if (st === "working" || st === "finishing" || st === "no-update") return "work";
  if (st === "done") return "ok";
  return "mute";
}

export interface Subline {
  readonly word: string;
  readonly rest: string[];
  readonly tone: "fail" | "need" | "work" | "mute";
  readonly mono?: boolean;
  readonly tag?: string;
}

function agoText(referenceTime: number | null, baseClock: number): string | null {
  if (referenceTime === null) return null;
  const elapsed = Math.max(0, baseClock - referenceTime);
  return `${durationText(elapsed)} ago`;
}

function formatResearchWorkerSubline(agent: AgentVM): Subline | null {
  if (!agent.research) return null;
  const metrics = researchCounters(agent.research);
  const st = agent.state;
  if (st === "working") return { word: "Working", tone: "work", rest: [metrics] };
  if (st === "failed") {
    const failLabel = agent.research.wireState === "timed_out" ? "Timed out" : "Failed";
    const causeDesc = agent.failure?.text ?? "the run does not say why";
    return { word: failLabel, tone: "fail", rest: [metrics, causeDesc] };
  }
  if (st === "done") return { word: "Done", tone: "mute", rest: [metrics] };
  if (st === "skipped") return { word: skippedWord(agent), tone: "mute", rest: [metrics] };
  return null;
}

export function subline(agent: AgentVM, run: Pick<RunVM, "clockAt" | "longestFinishedMs"> | null): Subline | null {
  const clockReference = run?.clockAt ?? agent.lastEventAt ?? 0;

  if (agent.pending === "retry") {
    return { word: "Retrying", tone: "work", rest: [`attempt ${agent.attempt + 1} starting`, "Muse has not confirmed yet"] };
  }
  if (agent.pending === "stop") {
    return { word: "Stopping…", tone: "work", rest: ["Muse has not confirmed yet"] };
  }

  if (agent.research) {
    return formatResearchWorkerSubline(agent);
  }

  const st = agent.state;
  if (st === "failed") {
    const attemptDescriptor = `attempt ${agent.attempt} of ${agent.attempt}`;
    if (agent.failure?.text) {
      return { word: "Failed", tone: "fail", rest: [attemptDescriptor, agent.failure.text], mono: true };
    }
    return { word: "Failed", tone: "fail", rest: [attemptDescriptor, "Muse has not reported a reason yet"] };
  }

  if (st === "no-update") {
    const isTaskWorker = agent.kind === "task";
    const durationNotice = silenceText(agent);
    const tagNotice = isTaskWorker ? `No output for ${durationNotice}` : `No update for ${durationNotice}`;
    const leadWord = isTaskWorker ? "Running" : "Working";
    return { word: leadWord, tone: "work", rest: [], tag: tagNotice };
  }

  if (st === "waiting-on-you") {
    const askedInterval = agoText(agent.needs?.askedAt ?? null, clockReference);
    const intentDetail = agent.needs?.kind === "input"
      ? "asks a question"
      : agent.needs?.command
      ? `run ${agent.needs.command}`
      : "wants to run a command";
    const extraDetails = askedInterval ? [intentDetail, `asked ${askedInterval}`] : [intentDetail];
    const isCommandMono = Boolean(agent.needs?.command && agent.needs.kind !== "input");
    return { word: "Waiting for you", tone: "need", rest: extraDetails, mono: isCommandMono };
  }

  if (st === "finishing") {
    const lastAttempt = agent.attempts[agent.attempts.length - 1];
    const usageEvt = lastAttempt?.events.find((evt) => evt.kind === "usage");
    const usageAgo = agoText(usageEvt?.at ?? null, clockReference);
    const completionDetail = usageAgo ? `usage reported ${usageAgo}` : "usage reported · completion follows";
    return { word: "Finishing", tone: "work", rest: [completionDetail] };
  }

  if (st === "working") {
    if (agent.kind === "task") {
      const initiatorNotice = agent.taskInfo?.background === false ? null : initiatorText(agent.taskInfo?.initiator ?? null);
      const trailingOutput = agent.taskInfo?.tail;
      const subParts: string[] = [];
      if (initiatorNotice) subParts.push(initiatorNotice);
      if (trailingOutput) subParts.push(trailingOutput);
      return { word: "Running", tone: "work", rest: subParts, mono: Boolean(trailingOutput) };
    }

    const hadZeroProgressSinceStart = agent.lastEventAt !== null && agent.startedAt !== null && agent.lastEventAt <= agent.startedAt;
    if (hadZeroProgressSinceStart) {
      return { word: "Working", tone: "work", rest: ["no update since it started"] };
    }

    const startAge = agoText(agent.startedAt, clockReference);
    const startNotice = startAge ? `started ${startAge}` : "start time not recorded";
    return { word: "Working", tone: "work", rest: [startNotice] };
  }

  return null;
}

export function tokensText(agent: Pick<AgentVM, "tokens">): string {
  const tokenCount = agent.tokens ? usageTotal(agent.tokens) : 0;
  return tokenCount > 0 ? formatTokens(tokenCount) : "—";
}

export function timeText(agent: Pick<AgentVM, "durationMs" | "runningMs" | "state">): string {
  const elapsedSpan = measureOf(agent);
  return elapsedSpan === null ? "—" : durationText(elapsedSpan);
}

export function rowLabel(agent: AgentVM, run: Pick<RunVM, "clockAt" | "longestFinishedMs"> | null): string {
  const primaryState = stateWord(agent);
  const narrativeTokens = [agent.name, primaryState];
  const subDetails = subline(agent, run);
  if (subDetails) {
    narrativeTokens.push(...subDetails.rest);
    if (subDetails.tag && subDetails.tag !== primaryState) {
      narrativeTokens.push(subDetails.tag);
    }
  }
  const tokenMetric = tokensText(agent);
  if (tokenMetric !== "—") {
    narrativeTokens.push(`${tokenMetric} tokens`);
  }
  const timeMetric = timeText(agent);
  if (timeMetric !== "—") {
    narrativeTokens.push(timeMetric);
  }
  return narrativeTokens.join(", ");
}

export function phaseLabel(phase: PhaseVM, run: Pick<RunVM, "clockAt"> | null): string {
  const parts: string[] = [phase.name];
  if (phase.state === "planned") {
    parts.push(`${phase.counts.planned} planned`);
  } else {
    parts.push(`${phase.counts.done} of ${phase.counts.total} done`);
  }
  if (phase.counts.failed > 0) {
    parts.push(`${phase.counts.failed} failed`);
  }
  if (phase.tokens !== null) {
    parts.push(`${formatTokens(phase.tokens)} tokens`);
  }
  const durationReadout = phaseTime(phase, run);
  if (durationReadout !== "—") {
    parts.push(durationReadout);
  }
  return parts.join(", ");
}

export function phaseTime(phase: PhaseVM, run: Pick<RunVM, "clockAt"> | null): string {
  if (phase.durationMs !== null) {
    return durationText(phase.durationMs);
  }
  if (phase.startedAt !== null && run && phase.state === "live") {
    const liveSpan = Math.max(0, run.clockAt - phase.startedAt);
    return `${durationText(liveSpan)} so far`;
  }
  return "—";
}

export interface SummaryPart {
  readonly text: string;
  readonly tone?: "need" | "fail" | "quiet";
  readonly strong?: boolean;
}

export function summaryParts(run: RunVM): SummaryPart[] {
  const counts = run.counts;
  const segments: SummaryPart[] = [];
  if (run.stale) {
    segments.push({ text: "Last known" });
  }

  const runStatus = run.status;
  if (runStatus === "starting") {
    segments.push({ text: "Starting", strong: true }, { text: "no agents scheduled yet" });
    return segments;
  }

  if (runStatus === "running") {
    if (run.kind === "turn") {
      const leadState = run.agents[0]?.state;
      const statusTitle = leadState === "waiting-on-you" ? "Waiting for you" : leadState === "working" ? "Muse working" : "Work continues";
      const finishedToolsCount = run.agents.filter((a) => a.kind === "task" && a.state === "done").length;
      segments.push({ text: statusTitle, strong: true }, { text: `${plural(finishedToolsCount, "tool")} completed` });
    } else if (run.research) {
      const activeResearchWorkers = counts.working + counts.finishing + counts.noUpdate;
      segments.push({ text: phaseLine(run.research), strong: true }, { text: `${counts.done} done` }, { text: `${activeResearchWorkers} working` });
    } else if (run.plannedKnown) {
      segments.push({ text: `${counts.done} of ${counts.total} done`, strong: true });
      if (run.currentPhase) segments.push({ text: run.currentPhase });
    } else {
      const activeWorkers = counts.working + counts.finishing + counts.noUpdate;
      segments.push({ text: `${counts.done} done`, strong: true }, { text: `${activeWorkers} working` }, { text: "more may start" });
    }
  } else if (runStatus === "finished" || runStatus === "finished-with-failures") {
    if (run.kind === "turn" && run.agents[0]?.state === "unknown") {
      segments.push({ text: "Turn ended", strong: true }, { text: "outcome not reported" });
    } else {
      const unitLabels = run.research ? ["round", "rounds"] : ["phase", "phases"];
      const totalPhases = run.phases.length;
      const phaseSuffix = totalPhases === 1 ? unitLabels[0] : unitLabels[1];
      const entityLabel = run.kind === "turn" ? "activities finished" : "agents finished";
      segments.push(
        { text: `${counts.done} of ${counts.total} ${entityLabel}`, strong: true },
        { text: `${totalPhases} ${phaseSuffix}` },
      );
    }
  } else if (runStatus === "stopped") {
    segments.push({ text: "Stopped", strong: true }, { text: `${counts.done} of ${counts.total} had landed` });
  } else if (runStatus === "failed") {
    segments.push({ text: "Failed", strong: true }, { text: `${counts.done} of ${counts.total} had landed` });
  }

  const isRunActive = runLive(run);
  if (counts.scheduled > 0 && isRunActive) {
    segments.push({ text: `${counts.scheduled} queued` });
  }

  const totalNeeds = run.runNeeds.length + counts.waiting;
  if (totalNeeds > 0 && isRunActive) {
    const needsSuffix = totalNeeds === 1 ? "needs" : "need";
    segments.push({ text: `${totalNeeds} ${needsSuffix} you`, tone: "need" });
  }

  if (counts.failed > 0) {
    segments.push({ text: `${counts.failed} failed`, tone: "fail" });
  }

  if (counts.noUpdate > 0 && isRunActive) {
    segments.push({ text: `${counts.noUpdate} no update`, tone: "quiet" });
  }

  if (counts.skipped > 0) {
    segments.push({ text: `${counts.skipped} skipped` });
  }

  if (counts.unknown > 0 && !isRunActive) {
    segments.push({ text: `${counts.unknown} not reported` });
  }

  return segments;
}

export function summaryText(run: RunVM): string {
  return summaryParts(run).map((s) => s.text).join(" · ");
}

export function statusPill(run: Pick<RunVM, "status" | "stale"> & Partial<Pick<RunVM, "kind" | "agents">>): { text: string; tone: "run" | "ok" | "mute" | "fail" } {
  if (run.stale) return { text: "Last known", tone: "mute" };
  if (run.kind === "turn" && run.status !== "running" && run.agents?.[0]?.state === "unknown") {
    return { text: "Outcome not reported", tone: "mute" };
  }

  const st = run.status;
  if (st === "starting") return { text: "Starting", tone: "run" };
  if (st === "running") return { text: "Running", tone: "run" };
  if (st === "finished") return { text: "Finished", tone: "ok" };
  if (st === "finished-with-failures") return { text: "Finished", tone: "mute" };
  if (st === "stopped") return { text: "Stopped", tone: "mute" };
  return { text: "Failed", tone: "fail" };
}

export function workingNames(run: Pick<RunVM, "agents">): string[] {
  return run.agents
    .filter((a) => a.state === "working" || a.state === "finishing" || a.state === "no-update")
    .map((a) => a.name);
}

export function longestFinished(run: Pick<RunVM, "agents">): AgentVM | null {
  let leader: AgentVM | null = null;
  for (const candidate of run.agents) {
    if (candidate.state === "done" && candidate.durationMs !== null) {
      if (leader === null || candidate.durationMs > (leader.durationMs as number)) {
        leader = candidate;
      }
    }
  }
  return leader;
}

export function mostTokens(run: Pick<RunVM, "agents">): { agent: AgentVM; total: number } | null {
  let champion: { agent: AgentVM; total: number } | null = null;
  for (const candidate of run.agents) {
    const tokensSpent = candidate.tokens ? usageTotal(candidate.tokens) : 0;
    if (tokensSpent > 0 && (champion === null || tokensSpent > champion.total)) {
      champion = { agent: candidate, total: tokensSpent };
    }
  }
  return champion;
}
