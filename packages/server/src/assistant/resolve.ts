import type { Basis, Candidate, MemoryItem, MemoryKind, Trust } from "./types.js";
import { containment, digest, jaccard, negations, tokenSet } from "./text.js";

/**
 * Decides what becomes of a proposed memory, given the memories already there that it could be about. It is a
 * pure function of its inputs: the store looks the neighbours up and applies the answer inside one transaction, so
 * two captures that race decide against the same rules and the database, not this module, serialises them.
 *
 * The rules that matter, in the order they are applied:
 *  - a statement already on file is corroborated (a source is added), never duplicated;
 *  - a correction replaces the memory it is about, found by its words or by what the assistant just used, and when
 *    it cannot tell which memory that is it asks instead of guessing;
 *  - a new value for the same slot, or a restatement of the same topic, replaces the old one only when it is at least
 *    as well established and no older: a guess never replaces what the user said, and a late job never replaces a
 *    newer statement (it is kept as history);
 *  - equals that disagree are both kept and marked contested for the user to settle.
 */

/** How well established a statement is: what it came from and how it was believed. */
export function standing(basis: Basis, trust: Trust): number {
  if (basis === "inferred") return 0;
  if (trust === "user") return 3;
  if (trust === "verified") return 2;
  return 1;
}

export function itemStanding(item: Pick<MemoryItem, "basis">, trust: Trust = "user"): number {
  return standing(item.basis, trust);
}

export type Resolution =
  | { kind: "suppress"; reason: "tombstone" | "paused" | "low-standing" | "duplicate-source" }
  | { kind: "corroborate"; target: string }
  | { kind: "create"; status: "active" | "pending" | "contested"; supersedes: string[]; contests: string[]; reason: string; inherit?: { kind: MemoryKind; slot: string | null; pinned: boolean } }
  /** An older statement arriving after a newer one: kept as history under the newer one, never as the head. */
  | { kind: "late"; newerHead: string; reason: string }
  | { kind: "forget"; targets: string[]; reason: string }
  | { kind: "ambiguous"; options: string[]; reason: string };

export interface ResolveContext {
  now: number;
  /** The fingerprint of this candidate is on the tombstone list for its scope. */
  tombstoned: boolean;
  paused: boolean;
  /** Memories the assistant used or created last turn: what "that" most likely refers to. */
  recent: ReadonlySet<string>;
}

/** Statements this similar, on the same topic, are one memory that changed. */
const SAME_TOPIC = 0.6;
/** What a correction or a forget needs to be sure which memory it means. */
const TARGET_MIN = 0.5;
const TARGET_LEAD = 0.15;
const REVISABLE: ReadonlySet<MemoryKind> = new Set(["fact", "preference", "constraint", "decision"]);

/**
 * How well `about` points at an item. Either the item is mostly inside what was said ("forget my timezone", or a
 * correction that restates the statement with a new value), or what was said is mostly inside the item ("forget
 * docs/NOTES.md"). An identifier in common is the strongest pointer there is: a correction that names the path
 * it replaces means that path.
 */
export function aboutScore(about: string, item: Pick<MemoryItem, "text" | "identifiers">): number {
  const q = tokenSet(about);
  if (q.size === 0) return 0;
  const t = tokenSet(item.text);
  const words = Math.max(containment(q, t), containment(t, q));
  const lower = about.toLowerCase();
  const ids = item.identifiers.filter((id) => lower.includes(id.toLowerCase()));
  const tiny = q.size === 1 && ids.length === 0 ? 0.6 : 1;
  const base = words * 0.75 * tiny + (words === 1 ? 0.2 : 0);
  return Math.min(1, ids.length > 0 ? Math.max(0.65, base) + 0.1 * (ids.length - 1) : base);
}

function ranked(about: string, items: readonly MemoryItem[], recent: ReadonlySet<string>): { item: MemoryItem; score: number }[] {
  return items
    .map((item) => ({ item, score: aboutScore(about, item) + (recent.has(item.id) ? 0.2 : 0) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.observedAt - a.item.observedAt);
}

/** Two statements say the same thing about the same matter: very similar words, or the same words with the sense turned over. */
export function sameTopic(a: string, b: string): boolean {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const j = jaccard(ta, tb);
  if (j >= SAME_TOPIC) return true;
  // "never use emojis" against "always use emojis": the same words, opposite sense.
  const flipped = (negations(a) % 2) !== (negations(b) % 2);
  return flipped && j >= 0.45;
}

/** Items a statement could replace: same scope, same kind of thing, and the same slot or the same topic. */
function rivals(candidate: Candidate, neighbors: readonly MemoryItem[]): MemoryItem[] {
  const scope = `${candidate.scope.kind}:${candidate.scope.key}`;
  return neighbors.filter((n) => {
    if (n.status === "deleted" || n.status === "superseded" || n.kind === "working") return false;
    if (`${n.scope.kind}:${n.scope.key}` !== scope) return false;
    if (candidate.slot) return n.slot === candidate.slot;
    return REVISABLE.has(candidate.kind) && n.kind === candidate.kind && n.slot === null && sameTopic(candidate.text, n.text);
  });
}

export function resolve(candidate: Candidate, neighbors: readonly MemoryItem[], ctx: ResolveContext): Resolution {
  const live = neighbors.filter((n) => n.status !== "deleted");
  const mine = standing(candidate.basis, candidate.source.trust);

  if (candidate.intent === "forget") {
    const hits = ranked(candidate.about ?? candidate.text, live.filter((n) => n.status !== "superseded"), ctx.recent).filter((h) => h.score >= TARGET_MIN);
    if (hits.length === 0) return { kind: "forget", targets: [], reason: "nothing matches" };
    const [first, second] = hits;
    if (first && (!second || first.score - second.score >= TARGET_LEAD)) return { kind: "forget", targets: [first.item.id], reason: "one clear match" };
    // "forget everything about X" names a topic on purpose: every close match goes.
    if (/\beverything\b|\ball\b/i.test(candidate.source.excerpt)) return { kind: "forget", targets: hits.filter((h) => h.score >= (first?.score ?? 0) - 0.25).map((h) => h.item.id), reason: "everything about a topic" };
    return { kind: "ambiguous", options: hits.slice(0, 5).map((h) => h.item.id), reason: "several memories match; which one?" };
  }

  if (ctx.tombstoned && candidate.basis !== "explicit") return { kind: "suppress", reason: "tombstone" };
  if (ctx.paused) return { kind: "suppress", reason: "paused" };

  const same = live.find((n) => n.status !== "superseded" && digest(n.text) === digest(candidate.text) && `${n.scope.kind}:${n.scope.key}` === `${candidate.scope.kind}:${candidate.scope.key}`);
  if (same && candidate.intent !== "correct") return { kind: "corroborate", target: same.id };

  if (candidate.intent === "correct") {
    const pool = live.filter((n) => n.status !== "superseded" && n.kind !== "working");
    const hits = ranked(candidate.about ?? candidate.text, pool, ctx.recent).filter((h) => h.score >= TARGET_MIN);
    const [first, second] = hits;
    if (first && (!second || first.score - second.score >= TARGET_LEAD)) {
      const t = first.item;
      if (standing(t.basis, "user") > mine) return { kind: "suppress", reason: "low-standing" };
      if (t.observedAt > candidate.source.observedAt) return { kind: "late", newerHead: t.id, reason: "a newer statement already replaced it" };
      return { kind: "create", status: "active", supersedes: [t.id], contests: [], reason: "correction of the memory it is about", inherit: { kind: t.kind, slot: t.slot, pinned: t.pinned } };
    }
    if (hits.length > 1) return { kind: "ambiguous", options: hits.slice(0, 5).map((h) => h.item.id), reason: "the correction could be about several memories" };
    return { kind: "create", status: "active", supersedes: [], contests: [], reason: "a correction with nothing on file to correct" };
  }

  const others = rivals(candidate, live).filter((n) => digest(n.text) !== digest(candidate.text));
  if (others.length === 0) return { kind: "create", status: "active", supersedes: [], contests: [], reason: "new" };

  const newer = others.find((o) => o.observedAt > candidate.source.observedAt && standing(o.basis, "user") >= mine);
  if (newer) return { kind: "late", newerHead: newer.id, reason: "an equal or better established statement is newer" };

  const stronger = others.find((o) => standing(o.basis, "user") > mine);
  if (stronger) return { kind: "suppress", reason: "low-standing" };

  const equals = others.filter((o) => standing(o.basis, "user") === mine && o.observedAt === candidate.source.observedAt);
  if (equals.length > 0) {
    // The same moment and the same standing, saying different things: neither is believed over the other.
    return { kind: "create", status: "contested", supersedes: [], contests: equals.map((o) => o.id), reason: "equal statements disagree" };
  }
  return { kind: "create", status: "active", supersedes: others.map((o) => o.id), contests: [], reason: candidate.slot ? `new value for ${candidate.slot}` : "the same matter, restated" };
}
