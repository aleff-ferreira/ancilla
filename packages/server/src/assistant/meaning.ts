import { dot } from "./embed.js";
import type { Hit } from "./rank.js";
import type { MemoryStore } from "./store.js";
import { scopeKey } from "./rank.js";
import type { RetrievalQuery } from "./types.js";

/**
 * The candidates found by meaning: the notes nearest the question's vector, added to those that words found, to be
 * scored by the same ranking and held to the same budget. A question has an answer or two, and a dozen near neighbours is
 * noise, so a note is added only when it is wanted for a reason the evaluation measured (see `selectByMeaning`).
 */

/** When a note found by meaning is added. */
export interface Selection {
  /** A note at least this close is added whatever else is near, at most `most` of them (nearest first). */
  bar: number;
  /** The nearest note is also added when it is at least `floor` close and `gap` ahead of the next: the one that stands out. */
  floor: number;
  gap: number;
  /** At most this many are added in all. */
  most: number;
}

export interface MeaningOptions extends Selection {
  model: string;
  queryVector: Float32Array;
}

/** What a note found by meaning is worth to the ranking, from how near it is: the mapping the evaluation measured. */
export function meaningScore(cosine: number, base: number): number {
  return Math.min(0.7, 0.3 + (cosine - base) * 2);
}

/**
 * Which notes to add, from every note's cosine to the question (nearest first) and the ids that words already found.
 * Two reasons to add one. It is very near: at least `bar`, nearest first, up to `most`. Or it stands out: the nearest note
 * of all, at least `floor` close and `gap` clear of the second nearest. The second reason finds the answer to a question
 * that no note is very near to, as long as one is clearly nearer than the rest; a question that nothing answers has no
 * such note, because its nearest notes are all about as far as one another. Notes words found are never added twice.
 */
export function selectByMeaning<T extends { id: string; cosine: number }>(nearestFirst: readonly T[], found: ReadonlySet<string>, s: Selection): T[] {
  const top = nearestFirst[0];
  const next = nearestFirst[1];
  const standout = top !== undefined && !found.has(top.id) && top.cosine >= s.floor && top.cosine - (next?.cosine ?? 0) >= s.gap ? top : null;
  const chosen: T[] = standout ? [standout] : [];
  for (const c of nearestFirst) {
    if (chosen.length >= s.most || c.cosine < s.bar) break;
    if (found.has(c.id) || c === standout) continue;
    chosen.push(c);
  }
  return chosen;
}

export function withMeaningVectors(store: MemoryStore, options: MeaningOptions) {
  return (hits: Hit[], query: RetrievalQuery): Hit[] => {
    // Only notes that are believed now have vectors; whether one may be shown for this question (a question about the
    // past, say) is the ranking's decision, as for every other candidate.
    const have = new Set(hits.map((h) => h.item.id));
    const scored = store
      .vectorsFor(options.model, query.scopes.map(scopeKey), ["active", "contested"])
      // Something that was made by a different model, or a different size of it, does not share the question's space.
      .filter(({ vec }) => vec.length === options.queryVector.length)
      .map(({ item, vec }) => ({ id: item.id, item, cosine: dot(options.queryVector, vec) }))
      .sort((a, b) => b.cosine - a.cosine);
    const base = Math.min(options.bar, options.floor);
    const added = selectByMeaning(scored, have, options).map((n) => ({ item: n.item, lexical: meaningScore(n.cosine, base), by: "meaning" as const }));
    return added.length === 0 ? hits : [...hits, ...added];
  };
}
