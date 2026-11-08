import type { MemoryItem, MemoryKind, RetrievedMemory, RetrievalQuery, Scope } from "./types.js";
import { containment, tokenSet } from "./text.js";

/**
 * Chooses which memories matter to a question. The store produces the text hits (FTS5, BM25) and the always-on
 * sets (pinned, standing rules, commitments that are due); this module decides who is eligible at all, scores
 * the rest, and drops what repeats. Identity, project, thread, time and standing are filters before they are
 * scores: a memory from another account or another project is never merely ranked low, it is not a candidate.
 */

const DAY = 86_400_000;

/** How long a kind of memory stays as fresh as a new one: after this it is worth half as much. Rules and procedures do not age. */
const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  working: 2,
  event: 45,
  fact: 400,
  preference: 400,
  decision: 180,
  commitment: Infinity,
  constraint: Infinity,
  procedure: Infinity,
};

// Phrases that are about what the user said before. Plain "what is the X" is not one of them: that asks for a fact
// about the world as often as one about the user, and a note saying "nothing is saved" on every such question
// would cost tokens and mean nothing.
const ASKS = [
  /\bdo you (?:still )?(?:remember|recall)\b/i,
  /\bwhat(?:'s| is| was| were| are) (?:my|our)\b/i,
  /\bdid i (?:tell|say|mention|ask|decide)\b/i,
  /\blast time (?:we|i)\b|\bearlier (?:we|i|you)\b|\bpreviously (?:we|i|you)\b|\bwe (?:discussed|agreed|decided)\b/i,
  /\bwhat do you know about me\b|\bwho am i\b/i,
  /\bas i (?:told|said|mentioned)\b|\bremind me what\b/i,
];

/** The question is about what the assistant remembers, so an empty answer must be said, not filled in. */
export function asksAboutMemory(text: string): boolean {
  return ASKS.some((pattern) => pattern.test(text));
}

const BROAD = [
  /\bwhat do you know about me\b/i,
  /\bwho am i\b/i,
  /\bwhat (?:are|were) my (?:rules|preferences|constraints|standing rules|goals)\b/i,
  /\bwhat have i (?:told|said to) you\b/i,
  /\btell me (?:everything|all) you (?:remember|know)\b/i,
  /\bwhat (?:do|did) you (?:remember|have saved)\b/i,
];

/** The question asks for everything remembered, so whatever is shown answers it, and only an empty block is "nothing". */
export function asksForEverything(text: string): boolean {
  return BROAD.some((pattern) => pattern.test(text));
}

export function scopeKey(scope: Scope): string {
  return `${scope.kind}:${scope.key}`;
}

/** The scopes a turn can see: everywhere, its account, its project and its own thread. Nothing else. */
export function visibleScopes(parts: { account?: string; project?: string; thread?: string }): Scope[] {
  const out: Scope[] = [{ kind: "global", key: "" }];
  if (parts.account) out.push({ kind: "account", key: parts.account });
  if (parts.project) out.push({ kind: "project", key: parts.project });
  if (parts.thread) out.push({ kind: "thread", key: parts.thread });
  return out;
}

/** Whether an item may be considered for this question at all. */
export function eligible(item: MemoryItem, query: RetrievalQuery): boolean {
  if (item.status === "deleted" || item.status === "pending") return false;
  if (item.status === "superseded" && !query.history) return false;
  if (item.status !== "superseded" && item.commitment && item.commitment !== "open") return false;
  const visible = new Set(query.scopes.map(scopeKey));
  if (!visible.has(scopeKey(item.scope))) return false;
  if (!query.history) {
    if (item.validFrom !== null && item.validFrom > query.now) return false;
    if (item.validTo !== null && item.validTo <= query.now) return false;
  }
  return true;
}

/** An item about something that changes, now old enough that it must be checked before it is relied on. */
export function isStale(item: MemoryItem, now: number): boolean {
  return item.revalidateAfterMs !== null && now - item.lastConfirmedAt > item.revalidateAfterMs;
}

/** A commitment that is overdue or falls due within three days. */
export function isDueSoon(item: MemoryItem, now: number): boolean {
  return item.kind === "commitment" && item.commitment === "open" && item.dueAt !== null && item.dueAt - now <= 3 * DAY;
}

const SCOPE_BOOST: Record<Scope["kind"], number> = { thread: 0.15, project: 0.1, account: 0.05, global: 0 };
const KIND_BOOST: Record<MemoryKind, number> = { constraint: 0.2, preference: 0.1, commitment: 0.05, procedure: 0.05, decision: 0.04, fact: 0.02, event: 0, working: 0.08 };

export interface Hit {
  item: MemoryItem;
  /** 0 to 1, normalised over this query's text hits; 0 for an item that is here for another reason. */
  lexical: number;
}

export function rankMemories(query: RetrievalQuery, hits: readonly Hit[]): RetrievedMemory[] {
  const q = tokenSet(query.text);
  const out: RetrievedMemory[] = [];
  for (const hit of hits) {
    const { item } = hit;
    if (!eligible(item, query)) continue;
    const why: string[] = [];
    let score = 0;
    if (hit.lexical > 0) {
      score += 0.55 * hit.lexical;
      why.push("text match");
    }
    const overlap = containment(q, tokenSet(item.text));
    if (overlap > 0) {
      score += 0.2 * overlap;
      if (hit.lexical === 0) why.push("words in common");
    }
    const lower = query.text.toLowerCase();
    const exactIds = item.identifiers.filter((id) => lower.includes(id.toLowerCase()));
    if (exactIds.length > 0) {
      score += 0.35;
      why.push(`identifier ${exactIds[0]}`);
    }
    if (item.pinned) {
      score += 0.4;
      why.push("pinned");
    }
    if (isDueSoon(item, query.now)) {
      score += 0.35;
      why.push("due soon");
    }
    if (item.kind === "constraint") why.push("standing rule");
    score += SCOPE_BOOST[item.scope.kind] + KIND_BOOST[item.kind];
    const half = HALF_LIFE_DAYS[item.kind];
    const age = Math.max(0, (query.now - item.observedAt) / DAY);
    const decay = half === Infinity ? 1 : Math.max(0.3, Math.pow(0.5, age / half));
    score *= decay * (0.6 + 0.4 * item.confidence);
    if (item.basis === "inferred") {
      score *= 0.6;
      why.push("tentative");
    }
    const stale = isStale(item, query.now);
    if (stale) {
      score *= 0.85;
      why.push("may be out of date");
    }
    if (item.status === "contested") why.push("disputed");
    if (item.status === "superseded") why.push("history");
    if (score > 0) out.push({ item, score, why, stale });
  }
  out.sort((a, b) => b.score - a.score || b.item.observedAt - a.item.observedAt);
  return diversify(out);
}

/** Drops a memory that says what a better one already says, so a block is not spent twice on one thing. */
function diversify(sorted: RetrievedMemory[]): RetrievedMemory[] {
  const kept: RetrievedMemory[] = [];
  const sets: Set<string>[] = [];
  for (const m of sorted) {
    const t = tokenSet(m.item.text);
    let repeats = false;
    for (let i = 0; i < kept.length; i += 1) {
      const k = kept[i] as RetrievedMemory;
      if (k.item.kind !== m.item.kind || k.item.status !== m.item.status) continue;
      const other = sets[i] as Set<string>;
      let both = 0;
      for (const w of t) if (other.has(w)) both += 1;
      if (t.size > 0 && both / Math.max(t.size, other.size) >= 0.85) {
        repeats = true;
        break;
      }
    }
    if (!repeats) {
      kept.push(m);
      sets.push(t);
    }
  }
  return kept;
}
