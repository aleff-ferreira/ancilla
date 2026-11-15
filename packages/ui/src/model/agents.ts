import type { MspItem } from "../types.js";
import type { ThreadState } from "./store.js";

/** Map associating unique agent identities with persistent sequential display indices. */
export type AgentNumbers = Map<string, number>;

/** Bounded LRU store holding agent index maps across thread sessions. */
const MAX_CACHED_THREADS = 64;
const threadAgentMap = new Map<string, AgentNumbers>();

/**
 * Retrieves or initializes the persistent agent index map for a given session.
 * Evicts the least recently accessed session when store capacity exceeds 64.
 */
export function agentNumbers(sessionId: string): AgentNumbers {
  const existing = threadAgentMap.get(sessionId) ?? new Map<string, number>();
  // Re-insert to refresh LRU recency
  threadAgentMap.delete(sessionId);
  threadAgentMap.set(sessionId, existing);

  // Evict oldest entries exceeding capacity
  if (threadAgentMap.size > MAX_CACHED_THREADS) {
    for (const key of threadAgentMap.keys()) {
      if (threadAgentMap.size <= MAX_CACHED_THREADS) break;
      threadAgentMap.delete(key);
    }
  }
  return existing;
}

/** Snapshot capturing thread item state at the onset of a feed disconnect. */
export interface AgentFeedMark {
  sessionId: string;
  items: Record<string, MspItem> | null;
  reading: boolean;
}

/**
 * Updates or creates a feed disconnect marker to establish a recovery baseline.
 * Returns null when the feed is healthy (unavailable === false).
 */
export function markAgentFeed(
  mark: AgentFeedMark | null,
  sessionId: string,
  unavailable: boolean,
  load: ThreadState["load"],
  items: Record<string, MspItem> | null,
): AgentFeedMark | null {
  if (!unavailable) {
    return null;
  }
  const isReading = load === "idle" || load === "loading";
  if (!mark || mark.sessionId !== sessionId) {
    return {
      sessionId,
      items: isReading ? null : items,
      reading: isReading,
    };
  }
  if (mark.reading === isReading) {
    return mark;
  }
  return isReading
    ? { ...mark, reading: true }
    : {
        sessionId,
        items: load === "ready" ? items : mark.items,
        reading: false,
      };
}

/**
 * Evaluates whether newly received items confirm live agent activity while lead is idle.
 */
export function agentFeedRecovered(
  mark: AgentFeedMark | null,
  sessionId: string,
  items: Record<string, MspItem> | null,
  idle: boolean,
): boolean {
  if (!idle || !items || !mark || mark.sessionId !== sessionId || !mark.items || mark.reading || mark.items === items) {
    return false;
  }
  for (const [id, currentItem] of Object.entries(items)) {
    if (currentItem.kind !== "workflow" && currentItem.kind !== "subagent") {
      continue;
    }
    const baselineItem = mark.items[id];
    if (!baselineItem || currentItem.revision > baselineItem.revision) {
      return true;
    }
  }
  return false;
}
