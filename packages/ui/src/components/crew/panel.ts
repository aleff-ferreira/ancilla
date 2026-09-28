import { formatClock, formatTokens } from "../../model/format.js";
import { phaseLine } from "../../model/research.js";
import { initiatorText, plural } from "./cardCopy.js";
import type { CrewFilter } from "../../model/store.js";
import { durationText, pendingKey, phasesOf, researchCounters, runLive, usageTotal, type AgentState, type AgentVM, type PendingAction, type PhaseVM, type RunNeedVM, type RunVM } from "../../model/crew.js";

/**
 * The words and orderings the Crew panel shares between its roster, Timeline and inspector. Everything here is a
 * pure function of the view-model, so the panel's tests can check the copy without rendering.
 */

export const FILTERS: readonly CrewFilter[] = ["all", "needs", "failed", "no-update", "working", "done"];

/** The states a row spells out on a second line; the rest fit one 32 px line. */
const TALL: ReadonlySet<AgentState> = new Set(["failed", "no-update", "waiting-on-you", "working", "finishing"]);
const LIVE: ReadonlySet<AgentState> = new Set(["scheduled", "working", "finishing", "no-update", "waiting-on-you"]);
const ENDED: ReadonlySet<AgentState> = new Set(["failed", "skipped", "done", "unknown"]);

export function isLive(agent: Pick<AgentVM, "state">): boolean {
  return LIVE.has(agent.state);
}

/**
 * The optimistic flags the store holds for attempts the model calls settled: a Retry or Skip on a failed agent is
 * sent against its terminal attempt, and the row should read as pending until Muse's revision shows the next attempt
 * or the outcome. The view-model keeps flags only for live attempts, so the panel lays these over its rows.
 */
export function withPending(run: RunVM, sessionId: string, pending: Readonly<Record<string, PendingAction>>): RunVM {
  if (Object.keys(pending).length === 0) return run;
  let changed = false;
  const patch = (agent: AgentVM): AgentVM => {
    if (agent.pending !== null || agent.state !== "failed") return agent;
    const flag = pending[pendingKey(sessionId, agent.id, agent.attempt)];
    if (flag === undefined) return agent;
    changed = true;
    return { ...agent, pending: flag };
  };
  const agents = run.agents.map(patch);
  if (!changed) return run;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const phases = run.phases.map((phase) => ({ ...phase, agents: phase.agents.map((agent) => byId.get(agent.id) ?? agent) }));
  return { ...run, agents, phases, attention: run.attention.map((agent) => byId.get(agent.id) ?? agent) };
}

export function isEnded(agent: Pick<AgentVM, "state">): boolean {
  return ENDED.has(agent.state);
}

/** Whether the row needs its second line; a research worker's counters take one once it has started. */
export function isTall(agent: Pick<AgentVM, "state" | "pending" | "research">): boolean {
  return agent.pending !== null || TALL.has(agent.state) || (agent.research !== undefined && agent.state !== "scheduled");
}

export function filterMatches(agent: Pick<AgentVM, "state">, filter: CrewFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "needs": return agent.state === "waiting-on-you";
    case "failed": return agent.state === "failed";
    case "no-update": return agent.state === "no-update";
    case "working": return agent.state === "working" || agent.state === "finishing";
    case "done": return agent.state === "done";
  }
}

/** A name substring, case-insensitively; `judge:` finds every agent with that prefix. */
export function queryMatches(agent: Pick<AgentVM, "name" | "display">, query: string): boolean {
  const words = query.trim().toLowerCase();
  if (!words) return true;
  return agent.name.toLowerCase().includes(words) || (agent.display.prefix?.toLowerCase().startsWith(words) ?? false);
}

export interface ChipCounts {
  all: number;
  /** Requests the run raised that no agent can be named for, plus the agents waiting on their own. */
  needs: number;
  failed: number;
  noUpdate: number;
  /** Working and finishing agents, the ones with a spinner; no update and waiting are counted apart. */
  working: number;
  done: number;
}

export function chipCounts(run: Pick<RunVM, "counts" | "runNeeds">): ChipCounts {
  const { counts } = run;
  return {
    all: counts.total,
    needs: run.runNeeds.length + counts.waiting,
    failed: counts.failed,
    noUpdate: counts.noUpdate,
    working: counts.working + counts.finishing,
    done: counts.done,
  };
}

/** The chips that show: every count above zero, and All always. */
export function visibleFilters(counts: ChipCounts): CrewFilter[] {
  const out: CrewFilter[] = ["all"];
  if (counts.needs > 0) out.push("needs");
  if (counts.failed > 0) out.push("failed");
  if (counts.noUpdate > 0) out.push("no-update");
  if (counts.working > 0) out.push("working");
  if (counts.done > 0) out.push("done");
  return out;
}

export function filterLabel(filter: CrewFilter): string {
  switch (filter) {
    case "all": return "All";
    case "needs": return "Needs you";
    case "failed": return "Failed";
    case "no-update": return "No update";
    case "working": return "Working";
    case "done": return "Done";
  }
}

export function filterCount(counts: ChipCounts, filter: CrewFilter): number {
  switch (filter) {
    case "all": return counts.all;
    case "needs": return counts.needs;
    case "failed": return counts.failed;
    case "no-update": return counts.noUpdate;
    case "working": return counts.working;
    case "done": return counts.done;
  }
}

export type RosterSort = "order" | "time" | "tokens";

/** What a row's time column measures: the duration once it stopped, the running time while it goes. */
export function measureOf(agent: Pick<AgentVM, "durationMs" | "runningMs">): number | null {
  return agent.durationMs ?? agent.runningMs;
}

/**
 * Rows within a phase, by the column chosen; `order` is the schedule order the model gives. By time, the agents
 * still going come first in the order they started (their clocks grow together, so nothing overtakes anything
 * while you look), then the finished ones by duration; planned agents stay last.
 */
export function sortAgents(agents: readonly AgentVM[], sort: RosterSort): AgentVM[] {
  if (sort === "order") return [...agents];
  const key = sort === "time"
    ? (agent: AgentVM) => (isLive(agent) ? (agent.startedAt !== null ? Number.MAX_SAFE_INTEGER - agent.startedAt : Number.MAX_SAFE_INTEGER) : measureOf(agent))
    : (agent: AgentVM) => (agent.tokens ? usageTotal(agent.tokens) : null);
  return agents
    .map((agent, index) => ({ agent, index, value: agent.state === "planned" ? null : key(agent) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return b.value - a.value || a.index - b.index;
    })
    .map((entry) => entry.agent);
}

/** Past this many finished agents a phase folds them behind "Show N finished". */
export const FOLD_FINISHED_AT = 12;

export type RosterEntry =
  | { kind: "phase"; id: string; phase: PhaseVM; open: boolean; current: boolean; pseudo: boolean }
  | { kind: "need"; id: string; need: RunNeedVM }
  | { kind: "agent"; id: string; agent: AgentVM; phase: string }
  | { kind: "fold"; id: string; phase: string; count: number };

export interface RosterOptions {
  filter: CrewFilter;
  query: string;
  /** Phases the user toggled; each one flips its default. */
  openPhases: readonly string[];
  sort: RosterSort;
  /** Phases whose finished rows the user unfolded. */
  unfolded: ReadonlySet<string>;
  tasks?: readonly AgentVM[];
  subagents?: readonly AgentVM[];
}

/**
 * A phase opens by default while it is live (the current one, or any that still has an agent going) or holds a
 * failure, and every one does once the run has no current phase left; a planned one stays closed. The user's
 * toggle flips that.
 */
export function phaseOpen(phase: PhaseVM, current: string | null, openPhases: readonly string[]): boolean {
  const byDefault = phase.state !== "planned" && (current === null || phase.name === current || phase.state === "live" || phase.counts.failed > 0);
  return openPhases.includes(phase.name) ? !byDefault : byDefault;
}

/**
 * The roster as a flat list of rows: every phase in run order with its agents, then the thread's background tasks
 * and subagents as phases of their own. A filter or query opens every phase that matches and drops the ones that
 * do not; a phase with many finished agents folds them behind one row. The run-level requests (which no agent can
 * be named for) live in the summary and on the Timeline; the Needs you filter lists them as rows.
 */
export function rosterEntries(run: RunVM | null, opts: RosterOptions): RosterEntry[] {
  const out: RosterEntry[] = [];
  const filtering = opts.filter !== "all" || opts.query.trim() !== "";
  if (run && opts.filter === "needs" && opts.query.trim() === "") {
    for (const need of run.runNeeds) out.push({ kind: "need", id: `need:${need.requestId}`, need });
  }
  const extra: PhaseVM[] = [
    ...(opts.tasks && opts.tasks.length > 0 ? phasesOf(opts.tasks) : []),
    ...(opts.subagents && opts.subagents.length > 0 ? phasesOf(opts.subagents) : []),
  ];
  const phases: { phase: PhaseVM; pseudo: boolean }[] = [
    ...(run ? run.phases.map((phase) => ({ phase, pseudo: false })) : []),
    ...extra.map((phase) => ({ phase, pseudo: true })),
  ];
  for (const { phase, pseudo } of phases) {
    const matching = phase.agents.filter((agent) => filterMatches(agent, opts.filter) && queryMatches(agent, opts.query));
    if (filtering && matching.length === 0) continue;
    const open = filtering ? true : pseudo ? phase.agents.some(isLive) || opts.openPhases.includes(phase.name) : phaseOpen(phase, run?.currentPhase ?? null, opts.openPhases);
    const current = !pseudo && phase.name === (run?.currentPhase ?? null);
    out.push({ kind: "phase", id: `phase:${phase.name}`, phase, open, current, pseudo });
    if (!open) continue;
    const rows = sortAgents(matching, opts.sort);
    const finished = rows.filter((agent) => agent.state === "done");
    const fold = !filtering && finished.length > FOLD_FINISHED_AT && !opts.unfolded.has(phase.name);
    for (const agent of rows) {
      if (fold && agent.state === "done") continue;
      out.push({ kind: "agent", id: agent.id, agent, phase: phase.name });
    }
    if (fold) out.push({ kind: "fold", id: `fold:${phase.name}`, phase: phase.name, count: finished.length });
  }
  return out;
}

/** The rows a key can land on, in order; `agentsOnly` for the inspector's j/k. */
export function focusOrder(entries: readonly RosterEntry[], agentsOnly = false): string[] {
  return entries.filter((entry) => (agentsOnly ? entry.kind === "agent" : entry.kind !== "fold")).map((entry) => entry.id);
}

/** Rows that need the user, in the order `n` visits them: the run's requests, then waiting, failed, no update. */
export function issueOrder(run: RunVM | null, entries: readonly RosterEntry[]): string[] {
  const ids = new Set(entries.filter((entry) => entry.kind === "agent").map((entry) => entry.id));
  const out: string[] = [];
  for (const entry of entries) if (entry.kind === "need") out.push(entry.id);
  for (const agent of run?.attention ?? []) if (ids.has(agent.id)) out.push(agent.id);
  for (const entry of entries) {
    if (entry.kind === "agent" && entry.agent.kind !== "workflow" && (entry.agent.state === "waiting-on-you" || entry.agent.state === "failed" || entry.agent.state === "no-update") && !out.includes(entry.id)) {
      out.push(entry.id);
    }
  }
  return out;
}

/** The row height the roster lays out with: 32 px for a one-line row, 44 for two, 34 for a phase head, 28 for a fold. */
export function entryHeight(entry: RosterEntry): number {
  switch (entry.kind) {
    case "phase": return 34;
    case "need": return 44;
    case "fold": return 28;
    case "agent": return isTall(entry.agent) ? 44 : 32;
  }
}

// ---------------------------------------------------------------- words

/** `14:14:12`, the local clock with seconds, for lifecycle times; mono in the UI. */
export function clockSeconds(ms: number): string {
  const date = new Date(ms);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

/** `2:14 PM` in the locale, the clock the rest of the app shows. */
export function clockMinutes(ms: number, now: number): string {
  return formatClock(ms, now);
}

/** The time a working agent was silent for: from its last revision to the run's clock. */
export function silenceText(agent: Pick<AgentVM, "silenceMs">): string {
  return durationText(agent.silenceMs ?? 0);
}

/** `Skipped by you` and its siblings. */
export function skippedWord(agent: Pick<AgentVM, "skippedBy">): string {
  switch (agent.skippedBy) {
    case "you": return "Skipped by you";
    case "run": return "Stopped with the run";
    default: return "Cancelled by Muse";
  }
}

/** The one-line state word for a compact row, the peek and the inspector's status. */
export function stateWord(agent: Pick<AgentVM, "state" | "pending" | "silenceMs" | "skippedBy" | "attempt" | "kind" | "taskInfo">): string {
  if (agent.pending === "retry") return `Retrying · attempt ${agent.attempt + 1} starting`;
  if (agent.pending === "stop") return "Stopping…";
  switch (agent.state) {
    case "planned": return "Planned · not scheduled yet";
    case "scheduled": return "Queued · waiting for a slot";
    case "working": return "Working";
    case "finishing": return "Finishing";
    case "no-update": return agent.kind === "task" ? `No output for ${silenceText(agent)}` : `No update for ${silenceText(agent)}`;
    case "waiting-on-you": return "Waiting for you";
    case "failed": return agent.attempt > 1 ? `Failed · ${agent.attempt} attempts` : "Failed";
    case "skipped": return skippedWord(agent);
    case "done": return agent.attempt > 1 ? `Done · attempt ${agent.attempt}` : "Done";
    case "unknown": return "Outcome not reported";
  }
}

/** The tone a state word takes. */
export function stateTone(agent: Pick<AgentVM, "state" | "pending">): "fail" | "need" | "work" | "ok" | "mute" {
  if (agent.pending !== null) return "work";
  switch (agent.state) {
    case "failed": return "fail";
    case "waiting-on-you": return "need";
    case "working": case "finishing": case "no-update": return "work";
    case "done": return "ok";
    default: return "mute";
  }
}

export interface Subline {
  /** The leading word, in the state's tone. */
  word: string;
  tone: "fail" | "need" | "work" | "mute";
  /** The rest of the line, after ` · `. */
  rest: string[];
  /** The rest is a command or an error, set in mono. */
  mono?: boolean;
  /** A tag drawn as a chip after the word (the no-update fact). */
  tag?: string;
}

function agoText(from: number | null, clock: number): string | null {
  return from === null ? null : `${durationText(Math.max(0, clock - from))} ago`;
}

/** The second line of a tall roster row (SPEC §14, roster sub-lines). */
export function subline(agent: AgentVM, run: Pick<RunVM, "clockAt" | "longestFinishedMs"> | null): Subline | null {
  const clock = run?.clockAt ?? agent.lastEventAt ?? 0;
  if (agent.pending === "retry") return { word: "Retrying", tone: "work", rest: [`attempt ${agent.attempt + 1} starting`, "Muse has not confirmed yet"] };
  if (agent.pending === "stop") return { word: "Stopping…", tone: "work", rest: ["Muse has not confirmed yet"] };
  if (agent.research) {
    // The daemon reports counters, not lifecycle steps, so a worker's second line is what it has done so far.
    const counters = researchCounters(agent.research);
    switch (agent.state) {
      case "working": return { word: "Working", tone: "work", rest: [counters] };
      case "failed": return { word: agent.research.wireState === "timed_out" ? "Timed out" : "Failed", tone: "fail", rest: [counters, agent.failure?.text ?? "the run does not say why"] };
      case "done": return { word: "Done", tone: "mute", rest: [counters] };
      case "skipped": return { word: skippedWord(agent), tone: "mute", rest: [counters] };
      default: return null;
    }
  }
  switch (agent.state) {
    case "failed": {
      const rest = [`attempt ${agent.attempt} of ${agent.attempt}`];
      if (agent.failure?.text) return { word: "Failed", tone: "fail", rest: [...rest, agent.failure.text], mono: true };
      return { word: "Failed", tone: "fail", rest: [...rest, "Muse has not reported a reason yet"] };
    }
    case "no-update":
      return agent.kind === "task"
        ? { word: "Running", tone: "work", rest: [], tag: `No output for ${silenceText(agent)}` }
        : { word: "Working", tone: "work", rest: [], tag: `No update for ${silenceText(agent)}` };
    case "waiting-on-you": {
      const asked = agoText(agent.needs?.askedAt ?? null, clock);
      const what = agent.needs?.kind === "input" ? "asks a question" : agent.needs?.command ? `run ${agent.needs.command}` : "wants to run a command";
      return { word: "Waiting for you", tone: "need", rest: [what, ...(asked ? [`asked ${asked}`] : [])], mono: Boolean(agent.needs?.command && agent.needs.kind !== "input") };
    }
    case "finishing": {
      const usageAt = agent.attempts[agent.attempts.length - 1]?.events.find((event) => event.kind === "usage")?.at ?? null;
      const ago = agoText(usageAt, clock);
      return { word: "Finishing", tone: "work", rest: [ago ? `usage reported ${ago}` : "usage reported · completion follows"] };
    }
    case "working": {
      if (agent.kind === "task") {
        const who = agent.taskInfo?.background === false ? null : initiatorText(agent.taskInfo?.initiator ?? null);
        return { word: "Running", tone: "work", rest: [...(who ? [who] : []), ...(agent.taskInfo?.tail ? [agent.taskInfo.tail] : [])], mono: Boolean(agent.taskInfo?.tail) };
      }
      const silentSinceStart = agent.lastEventAt !== null && agent.startedAt !== null && agent.lastEventAt <= agent.startedAt;
      if (silentSinceStart) return { word: "Working", tone: "work", rest: ["no update since it started"] };
      const started = agoText(agent.startedAt, clock);
      return { word: "Working", tone: "work", rest: [started ? `started ${started}` : "start time not recorded"] };
    }
    default:
      return null;
  }
}

/** The tokens column: `236k`, or the dash. */
export function tokensText(agent: Pick<AgentVM, "tokens">): string {
  return agent.tokens && usageTotal(agent.tokens) > 0 ? formatTokens(usageTotal(agent.tokens)) : "—";
}

/** The time column: the duration once it stopped, the running time (`so far` is implied by the state) while it goes. */
export function timeText(agent: Pick<AgentVM, "durationMs" | "runningMs" | "state">): string {
  const measure = measureOf(agent);
  return measure === null ? "—" : durationText(measure);
}

/** What a reader hears for a row: name, state, the reason, tokens and time. */
export function rowLabel(agent: AgentVM, run: Pick<RunVM, "clockAt" | "longestFinishedMs"> | null): string {
  const word = stateWord(agent);
  const parts = [agent.name, word];
  const sub = subline(agent, run);
  if (sub) parts.push(...sub.rest, ...(sub.tag && sub.tag !== word ? [sub.tag] : []));
  const tokens = tokensText(agent);
  if (tokens !== "—") parts.push(`${tokens} tokens`);
  const time = timeText(agent);
  if (time !== "—") parts.push(time);
  return parts.join(", ");
}

/** `Design 2/3 · 1 failed · 506.7k · 11m 04s`, the phase head's text equivalent. */
export function phaseLabel(phase: PhaseVM, run: Pick<RunVM, "clockAt"> | null): string {
  const parts = [phase.name];
  if (phase.state === "planned") parts.push(`${phase.counts.planned} planned`);
  else parts.push(`${phase.counts.done} of ${phase.counts.total} done`);
  if (phase.counts.failed > 0) parts.push(`${phase.counts.failed} failed`);
  if (phase.tokens !== null) parts.push(`${formatTokens(phase.tokens)} tokens`);
  const time = phaseTime(phase, run);
  if (time !== "—") parts.push(time);
  return parts.join(", ");
}

/** The phase head's time: its span once it ended, `so far` while it runs. */
export function phaseTime(phase: PhaseVM, run: Pick<RunVM, "clockAt"> | null): string {
  if (phase.durationMs !== null) return durationText(phase.durationMs);
  if (phase.startedAt !== null && run && phase.state === "live") return `${durationText(Math.max(0, run.clockAt - phase.startedAt))} so far`;
  return "—";
}

/** The summary sentence's parts, in order; `strong` is the first one. */
export interface SummaryPart {
  text: string;
  tone?: "need" | "fail" | "quiet";
  strong?: boolean;
}

export function summaryParts(run: RunVM): SummaryPart[] {
  const { counts } = run;
  const parts: SummaryPart[] = [];
  if (run.stale) parts.push({ text: "Last known" });
  switch (run.status) {
    case "starting":
      parts.push({ text: "Starting", strong: true }, { text: "no agents scheduled yet" });
      return parts;
    case "running":
      if (run.kind === "turn") {
        parts.push({ text: run.agents[0]?.state === "waiting-on-you" ? "Waiting for you" : run.agents[0]?.state === "working" ? "Muse working" : "Work continues", strong: true }, { text: `${plural(run.agents.filter((agent) => agent.kind === "task" && agent.state === "done").length, "tool")} completed` });
      } else if (run.research) {
        // A research run says which phase the daemon is in; its rounds are planned as it goes.
        parts.push({ text: phaseLine(run.research), strong: true }, { text: `${counts.done} done` }, { text: `${counts.working + counts.finishing + counts.noUpdate} working` });
      } else if (run.plannedKnown) {
        parts.push({ text: `${counts.done} of ${counts.total} done`, strong: true });
        if (run.currentPhase) parts.push({ text: run.currentPhase });
      } else {
        parts.push({ text: `${counts.done} done`, strong: true }, { text: `${counts.working + counts.finishing + counts.noUpdate} working` }, { text: "more may start" });
      }
      break;
    case "finished":
    case "finished-with-failures": {
      if (run.kind === "turn" && run.agents[0]?.state === "unknown") {
        parts.push({ text: "Turn ended", strong: true }, { text: "outcome not reported" });
        break;
      }
      const unit = run.research ? ["round", "rounds"] : ["phase", "phases"];
      parts.push({ text: run.kind === "turn" ? `${counts.done} of ${counts.total} activities finished` : `${counts.done} of ${counts.total} agents finished`, strong: true }, { text: `${run.phases.length} ${run.phases.length === 1 ? unit[0] : unit[1]}` });
      break;
    }
    case "stopped":
      parts.push({ text: "Stopped", strong: true }, { text: `${counts.done} of ${counts.total} had landed` });
      break;
    case "failed":
      parts.push({ text: "Failed", strong: true }, { text: `${counts.done} of ${counts.total} had landed` });
      break;
  }
  if (counts.scheduled > 0 && runLive(run)) parts.push({ text: `${counts.scheduled} queued` });
  const needs = run.runNeeds.length + counts.waiting;
  if (needs > 0 && runLive(run)) parts.push({ text: `${needs} ${needs === 1 ? "needs" : "need"} you`, tone: "need" });
  if (counts.failed > 0) parts.push({ text: `${counts.failed} failed`, tone: "fail" });
  if (counts.noUpdate > 0 && runLive(run)) parts.push({ text: `${counts.noUpdate} no update`, tone: "quiet" });
  if (counts.skipped > 0) parts.push({ text: `${counts.skipped} skipped` });
  if (counts.unknown > 0 && !runLive(run)) parts.push({ text: `${counts.unknown} not reported` });
  return parts;
}

/** The plain sentence, for the panel's label and tests. */
export function summaryText(run: RunVM): string {
  return summaryParts(run).map((part) => part.text).join(" · ");
}

/** The pill in the panel's head. */
export function statusPill(run: Pick<RunVM, "status" | "stale"> & Partial<Pick<RunVM, "kind" | "agents">>): { text: string; tone: "run" | "ok" | "mute" | "fail" } {
  if (run.stale) return { text: "Last known", tone: "mute" };
  if (run.kind === "turn" && run.status !== "running" && run.agents?.[0]?.state === "unknown") return { text: "Outcome not reported", tone: "mute" };
  switch (run.status) {
    case "starting": return { text: "Starting", tone: "run" };
    case "running": return { text: "Running", tone: "run" };
    case "finished": return { text: "Finished", tone: "ok" };
    case "finished-with-failures": return { text: "Finished", tone: "mute" };
    case "stopped": return { text: "Stopped", tone: "mute" };
    case "failed": return { text: "Failed", tone: "fail" };
  }
}

/** Working agents by name, for the Stop run confirm. */
export function workingNames(run: Pick<RunVM, "agents">): string[] {
  return run.agents.filter((agent) => agent.state === "working" || agent.state === "finishing" || agent.state === "no-update").map((agent) => agent.name);
}

/** The longest finished agent of a run, the one the no-update rule compares with. */
export function longestFinished(run: Pick<RunVM, "agents">): AgentVM | null {
  let best: AgentVM | null = null;
  for (const agent of run.agents) {
    if (agent.state === "done" && agent.durationMs !== null && (best === null || agent.durationMs > (best.durationMs as number))) best = agent;
  }
  return best;
}

/** The agent that reported the most tokens, for the tokens comparison bar. */
export function mostTokens(run: Pick<RunVM, "agents">): { agent: AgentVM; total: number } | null {
  let best: { agent: AgentVM; total: number } | null = null;
  for (const agent of run.agents) {
    const total = agent.tokens ? usageTotal(agent.tokens) : 0;
    if (total > 0 && (best === null || total > best.total)) best = { agent, total };
  }
  return best;
}
