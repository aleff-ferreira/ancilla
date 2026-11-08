/**
 * The shape of an evaluation: a scripted history over simulated days, and probes that ask the assistant (or a
 * baseline) something and say what a right context holds and what it must not hold. Nothing here calls a model.
 */

/** A small seeded generator: the same seed gives the same scenarios on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

export function shuffled<T>(next: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export type Category = "exact" | "paraphrase" | "change" | "contradiction" | "temporal" | "distractor" | "abstain" | "deletion" | "injection";
export type Role = "user" | "assistant" | "tool";

export interface Said {
  op: "say";
  /** Days since the start of the simulation. */
  day: number;
  /** An exact moment, for two statements that must be at the same instant. */
  atMs?: number;
  text: string;
  thread?: string;
  project?: string;
  role?: Role;
  /** The fact this statement is about, so a memory can be said to be relevant to a question. */
  tag?: string;
  /** Where the words came from, when not a message of the user's. */
  source?: "web" | "file";
}

export interface Probe {
  category: Category;
  /** Groups of alternatives: a right context holds at least one of each group, in any case. */
  need?: string[][];
  /** What a right context must not hold: a replaced value, erased words, an injected instruction. */
  never?: string[];
  /** Facts (tags) that are relevant to the question, for the precision of what was chosen. */
  relevant?: string[];
  /** Nothing covers this question: a right context says so and holds nothing that would answer it. */
  abstain?: boolean;
  /** A label for a breakdown inside a category. */
  bucket?: string;
}

export interface Asked {
  op: "ask";
  day: number;
  text: string;
  thread?: string;
  project?: string;
  probe: Probe;
}

export interface Restarted {
  op: "restart";
  day: number;
}

/** A message read again later: the step at `of` (an index into the case's steps), with its original time. */
export interface Replayed {
  op: "replay";
  day: number;
  of: number;
}

export type Step = Said | Asked | Restarted | Replayed;

export interface Case {
  id: string;
  steps: Step[];
}

export const DAY_MS = 86_400_000;
/** Simulations start here. */
export const START = Date.UTC(2026, 0, 5, 9, 0, 0);

export function at(step: { day: number; atMs?: number }, index: number): number {
  return step.atMs ?? START + Math.round(step.day * DAY_MS) + index * 1000;
}
