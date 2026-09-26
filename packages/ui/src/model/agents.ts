import type { MspItem } from "../types.js";
import type { ThreadState } from "./store.js";

/**
 * Numbers for agents that report no name, by durable identity. A number is handed out once, in order of
 * first appearance, and never moves to another agent: not when an earlier run gains a child, and not when
 * a capped reload drops older runs.
 */
export type AgentNumbers = Map<string, number>;

const numbered = new Map<string, AgentNumbers>();
const NUMBERED_THREADS = 64;

/** A thread's agent numbers for as long as the app runs, so reopening the thread keeps them too. */
export function agentNumbers(sessionId: string): AgentNumbers {
  const numbers = numbered.get(sessionId) ?? new Map<string, number>();
  // Least recently shown threads are forgotten first; only anonymous agents take an entry.
  numbered.delete(sessionId);
  numbered.set(sessionId, numbers);
  for (const stale of numbered.keys()) {
    if (numbered.size <= NUMBERED_THREADS) break;
    numbered.delete(stale);
  }
  return numbers;
}

/** The thread's agent items as its last completed history read left them, kept while the live view is unavailable. */
export interface AgentFeedMark {
  sessionId: string;
  /** Null until a read has landed, so nothing that arrived before the thread loaded counts as live. */
  items: Record<string, MspItem> | null;
  /** A history read is in flight. What it brings back is history, not agents reporting in live. */
  reading: boolean;
}

/**
 * Keeps the agent items as they stood after the latest completed read for as long as the live view stays
 * unavailable, and forgets them once it recovers. A read that lands while the view is unavailable can bring
 * runs a capped load never had, or revisions the feed missed before the outage; only what arrives after it
 * proves the feed is alive again. A read that fails changes nothing, so the earlier baseline stands.
 */
export function markAgentFeed(mark: AgentFeedMark | null, sessionId: string, unavailable: boolean, load: ThreadState["load"], items: Record<string, MspItem> | null): AgentFeedMark | null {
  if (!unavailable) return null;
  const reading = load === "idle" || load === "loading";
  if (mark?.sessionId !== sessionId) return { sessionId, items: reading ? null : items, reading };
  if (reading === mark.reading) return mark;
  return reading ? { ...mark, reading: true } : { sessionId, items: load === "ready" ? items : mark.items, reading: false };
}

/**
 * Agent revisions arrived after the live view reported itself unavailable, while the lead was idle. With
 * no turn running, nothing else can be confused with the background agents' own progress, so what the
 * panel shows is current rather than last known. While a turn runs, the lead's own recovery decides.
 */
export function agentFeedRecovered(mark: AgentFeedMark | null, sessionId: string, items: Record<string, MspItem> | null, idle: boolean): boolean {
  if (!idle || !items || mark?.sessionId !== sessionId || !mark.items || mark.reading || mark.items === items) return false;
  for (const [id, item] of Object.entries(items)) {
    if (item.kind !== "workflow" && item.kind !== "subagent") continue;
    const before = mark.items[id];
    if (!before || item.revision > before.revision) return true;
  }
  return false;
}
