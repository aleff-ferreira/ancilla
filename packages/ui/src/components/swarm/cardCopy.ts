import { durationText, researchCounters, type AgentState, type AgentVM, type RunNeedVM, type RunVM } from "../../model/swarm.js";

/**
 * The words the Swarm card says for an agent's state (SPEC §14). Facts say when Muse reports them; an absence is a
 * sentence, never a blank; and the words stalled, hung and stuck never appear.
 */

export const STATE_WORD: Record<AgentState, string> = {
  planned: "Planned",
  scheduled: "Queued",
  working: "Working",
  finishing: "Finishing",
  "no-update": "No update",
  "waiting-on-you": "Waiting for you",
  failed: "Failed",
  skipped: "Skipped",
  done: "Done",
  unknown: "Outcome not reported",
};

export const NO_REASON = "Muse has not reported a reason yet. The run's report may explain it when it finishes.";
export const RESEARCH_NO_REASON = "The run does not report why a worker failed. Its report may say.";
/** Why a research worker's row offers no Retry, Skip or Stop. */
export const RESEARCH_OWN = "Research workers run on their own";
export const NOT_ATTRIBUTED = "Muse does not say which agent asked.";
export const NOTHING_TO_COMPARE = "No agent has finished yet, so there is nothing to compare with.";
export const NOT_CONFIRMED = "Muse has not confirmed yet.";

export function plural(n: number, word: string, words = `${word}s`): string {
  return `${n} ${n === 1 ? word : words}`;
}

/** What the run is, for the head's sub line: `Workflow` or `Deep research`. */
export function runKindWord(run: Pick<RunVM, "kind">): string {
  return run.kind === "research" ? "Deep research" : "Workflow";
}

/** What a failed agent's row says when no reason came: the words differ by who runs the agent. */
export function noReason(agent: Pick<AgentVM, "kind">): string {
  return agent.kind === "research" ? RESEARCH_NO_REASON : NO_REASON;
}

/** `1m 40s ago`, `53s ago`: an age with the seconds, for when something was asked or reported. */
export function agoText(ms: number): string {
  return `${durationText(Math.max(0, ms))} ago`;
}

/** `4m ago`, `1h 05m ago`: an age in whole minutes, for when an agent started. */
export function agoShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ago`;
}

/** Why a skipped agent stopped: this client asked, the run was stopped, or Muse cancelled it. */
export function skippedWord(agent: Pick<AgentVM, "skippedBy">): string {
  return agent.skippedBy === "you" ? "Skipped by you" : agent.skippedBy === "run" ? "Stopped with the run" : "Cancelled by Muse";
}

export type Tone = "fail" | "need" | "work" | null;

export interface StateCopy {
  /** The word, in the row's colour for its tone. */
  text: string;
  /** What follows it in the subtle colour, when there is something to add. */
  dim: string | null;
  tone: Tone;
}

/** One agent's state as a compact row says it: `Working · started 4m ago`, `Failed · 2 attempts`, `Queued · waiting for a slot`. */
export function compactState(agent: AgentVM, stale = false): StateCopy {
  if (stale) {
    const word = agent.state === "skipped" ? skippedWord(agent) : STATE_WORD[agent.state];
    return { text: `Last known · ${word.charAt(0).toLowerCase()}${word.slice(1)}`, dim: null, tone: null };
  }
  if (agent.pending === "retry") return { text: "Retrying", dim: `· attempt ${agent.attempt + 1} starting`, tone: "work" };
  if (agent.pending === "stop") return { text: "Stopping…", dim: null, tone: null };
  if (agent.research) {
    // A research worker's row carries its counters in place of attempts, which it never has more than one of.
    const counters = `· ${researchCounters(agent.research)}`;
    switch (agent.state) {
      case "done": return { text: "Done", dim: counters, tone: null };
      case "failed": return { text: agent.research.wireState === "timed_out" ? "Timed out" : "Failed", dim: counters, tone: "fail" };
      case "working": return { text: "Working", dim: counters, tone: "work" };
      default: break;
    }
  }
  switch (agent.state) {
    case "done":
      return { text: "Done", dim: agent.attempt > 1 ? `· attempt ${agent.attempt}` : null, tone: null };
    case "failed":
      return { text: `Failed · ${plural(agent.attempt, "attempt")}`, dim: null, tone: "fail" };
    case "waiting-on-you":
      return { text: "Waiting for you", dim: null, tone: "need" };
    case "no-update":
      return { text: agent.silenceMs !== null ? `No update for ${durationText(agent.silenceMs)}` : "No update", dim: null, tone: null };
    case "working":
      return { text: "Working", dim: agent.runningMs !== null ? `· started ${agoShort(agent.runningMs)}` : null, tone: "work" };
    case "finishing":
      return { text: "Finishing", dim: agent.silenceMs !== null ? `· usage reported ${agoText(agent.silenceMs)}` : null, tone: "work" };
    case "scheduled":
      return { text: "Queued · waiting for a slot", dim: null, tone: null };
    case "planned":
      return { text: "Planned · not scheduled yet", dim: null, tone: null };
    case "skipped":
      return { text: skippedWord(agent), dim: null, tone: null };
    case "unknown":
      return { text: "Outcome not reported", dim: null, tone: null };
  }
}

/** The state as one sentence, for a row's accessible name and the peek: `No update for 4m 12s · running 16m 02s`. */
export function stateSentence(agent: AgentVM, stale = false): string {
  const copy = compactState(agent, stale);
  return copy.dim ? `${copy.text} ${copy.dim}` : copy.text;
}

/** The second line under a run-level request: when it was asked, during which phase, and that no agent can be named. */
export function runNeedLine(need: RunNeedVM, clockAt: number): string {
  const asked = need.askedAt !== null ? `Asked ${agoText(clockAt - need.askedAt)}` : null;
  if (asked && need.phase) return `${asked}, during ${need.phase}. ${NOT_ATTRIBUTED}`;
  if (asked) return `${asked}. ${NOT_ATTRIBUTED}`;
  if (need.phase) return `Asked during ${need.phase}. ${NOT_ATTRIBUTED}`;
  return NOT_ATTRIBUTED;
}

/** Who put a task in the background. */
export function initiatorText(initiator: "user" | "timeout" | null): string | null {
  return initiator === "user" ? "You sent it to the background" : initiator === "timeout" ? "Muse backgrounded it after a timeout" : null;
}
