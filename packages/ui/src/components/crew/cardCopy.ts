import { durationText, researchCounters, type AgentState, type AgentVM, type RunNeedVM, type RunVM } from "../../model/crew.js";

/**
 * Standard terminology for agent operational states in the Crew interface.
 */
const AGENT_STATE_LABELS: readonly (readonly [AgentState, string])[] = [
  ["planned", "Planned"],
  ["scheduled", "Queued"],
  ["working", "Working"],
  ["finishing", "Finishing"],
  ["no-update", "No update"],
  ["waiting-on-you", "Waiting for you"],
  ["failed", "Failed"],
  ["skipped", "Skipped"],
  ["done", "Done"],
  ["unknown", "Outcome not reported"],
];

export const STATE_WORD: Record<AgentState, string> = Object.freeze(
  Object.fromEntries(AGENT_STATE_LABELS) as Record<AgentState, string>,
);

export const NO_REASON = "Muse has not reported a reason yet. The run's report may explain it when it finishes.";
export const RESEARCH_NO_REASON = "The run does not report why a worker failed. Its report may say.";
export const RESEARCH_OWN = "Research workers run on their own";
export const NOT_ATTRIBUTED = "Muse does not say which agent asked.";
export const NOTHING_TO_COMPARE = "No agent has finished yet, so there is nothing to compare with.";
export const NOT_CONFIRMED = "Muse has not confirmed yet.";

export function plural(count: number, singular: string, customPlural?: string): string {
  const pluralForm = customPlural ?? `${singular}s`;
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function runKindWord(run: Pick<RunVM, "kind">): string {
  if (run.kind === "research") return "Deep research";
  if (run.kind === "turn") return "Prompt execution";
  return "Workflow";
}

export function noReason(agent: Pick<AgentVM, "kind">): string {
  return agent.kind === "research" ? RESEARCH_NO_REASON : NO_REASON;
}

export function agoText(elapsedMs: number): string {
  const boundedMs = Math.max(0, elapsedMs);
  return `${durationText(boundedMs)} ago`;
}

export function agoShort(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.round(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s ago`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ago`;
  const totalHrs = Math.floor(totalMin / 60);
  const remainingMins = String(totalMin % 60).padStart(2, "0");
  return `${totalHrs}h ${remainingMins}m ago`;
}

export function skippedWord(agent: Pick<AgentVM, "skippedBy">): string {
  const initiator = agent.skippedBy;
  if (initiator === "you") return "Skipped by you";
  if (initiator === "run") return "Stopped with the run";
  return "Cancelled by Muse";
}

export type Tone = "fail" | "need" | "work" | null;

export interface StateCopy {
  readonly text: string;
  readonly dim: string | null;
  readonly tone: Tone;
}

export function compactState(agent: AgentVM, isStale = false): StateCopy {
  if (isStale) {
    const rawWord = agent.state === "skipped" ? skippedWord(agent) : STATE_WORD[agent.state];
    const initialLower = rawWord.charAt(0).toLowerCase() + rawWord.slice(1);
    return { text: `Last known · ${initialLower}`, dim: null, tone: null };
  }

  const pendingMode = agent.pending;
  if (pendingMode === "retry") {
    return { text: "Retrying", dim: `· attempt ${agent.attempt + 1} starting`, tone: "work" };
  }
  if (pendingMode === "stop") {
    return { text: "Stopping…", dim: null, tone: null };
  }

  if (agent.research) {
    const metricsLabel = `· ${researchCounters(agent.research)}`;
    const researchState = agent.state;
    if (researchState === "done") return { text: "Done", dim: metricsLabel, tone: null };
    if (researchState === "failed") {
      const isTimeout = agent.research.wireState === "timed_out";
      return { text: isTimeout ? "Timed out" : "Failed", dim: metricsLabel, tone: "fail" };
    }
    if (researchState === "working") return { text: "Working", dim: metricsLabel, tone: "work" };
  }

  const st = agent.state;
  if (st === "done") {
    const retryNote = agent.attempt > 1 ? `· attempt ${agent.attempt}` : null;
    return { text: "Done", dim: retryNote, tone: null };
  }
  if (st === "failed") {
    return { text: `Failed · ${plural(agent.attempt, "attempt")}`, dim: null, tone: "fail" };
  }
  if (st === "waiting-on-you") {
    return { text: "Waiting for you", dim: null, tone: "need" };
  }
  if (st === "no-update") {
    const silenceDesc = agent.silenceMs !== null ? `No update for ${durationText(agent.silenceMs)}` : "No update";
    return { text: silenceDesc, dim: null, tone: null };
  }
  if (st === "working") {
    const startNotice = agent.runningMs !== null ? `· started ${agoShort(agent.runningMs)}` : null;
    return { text: "Working", dim: startNotice, tone: "work" };
  }
  if (st === "finishing") {
    const finishNotice = agent.silenceMs !== null ? `· usage reported ${agoText(agent.silenceMs)}` : null;
    return { text: "Finishing", dim: finishNotice, tone: "work" };
  }
  if (st === "scheduled") {
    return { text: "Queued · waiting for a slot", dim: null, tone: null };
  }
  if (st === "planned") {
    return { text: "Planned · not scheduled yet", dim: null, tone: null };
  }
  if (st === "skipped") {
    return { text: skippedWord(agent), dim: null, tone: null };
  }
  return { text: "Outcome not reported", dim: null, tone: null };
}

export function stateSentence(agent: AgentVM, isStale = false): string {
  const info = compactState(agent, isStale);
  return info.dim !== null ? `${info.text} ${info.dim}` : info.text;
}

export function runNeedLine(need: RunNeedVM, currentClock: number): string {
  const timestamp = need.askedAt !== null ? `Asked ${agoText(currentClock - need.askedAt)}` : null;
  const phaseContext = need.phase;
  if (timestamp && phaseContext) {
    return `${timestamp}, during ${phaseContext}. ${NOT_ATTRIBUTED}`;
  }
  if (timestamp) {
    return `${timestamp}. ${NOT_ATTRIBUTED}`;
  }
  if (phaseContext) {
    return `Asked during ${phaseContext}. ${NOT_ATTRIBUTED}`;
  }
  return NOT_ATTRIBUTED;
}

export function initiatorText(source: "user" | "timeout" | null): string | null {
  if (source === "user") return "You sent it to the background";
  if (source === "timeout") return "Muse backgrounded it after a timeout";
  return null;
}
