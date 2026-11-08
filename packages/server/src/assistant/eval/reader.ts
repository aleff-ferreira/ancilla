import { containment, identifiersOf, tokenSet } from "../text.js";
import { isPastQuestion } from "../text.js";

/**
 * The stand-in for a model. It reads a context the way a careful model would at its simplest: it answers from the note
 * that matches the question best, prefers the newer of two that match equally, skips what the context itself labels as
 * replaced (unless the question is about the past), and says it has nothing when no note matches or when the context
 * says no note does. It never invents anything. That is the point: what is measured is the context, not a model.
 */

export type Reading = { kind: "answer"; id: string | null; text: string; at: number } | { kind: "abstain" };

interface Candidate {
  id: string | null;
  text: string;
  at: number;
  replaced: boolean;
}

const NOTE = /^- \[([^\]]+)\] (.*?)(?: \(([^()]*)\))?$/;
const DATED = /^\[(\d{4}-\d{2}-\d{2})\] (.*)$/;
const ON = /(\d{4}-\d{2}-\d{2})/;

function parse(context: string): { candidates: Candidate[]; nothing: boolean } {
  const candidates: Candidate[] = [];
  let nothing = false;
  let order = 0;
  for (const raw of context.split("\n")) {
    const line = raw.trimEnd();
    if (line.includes("No saved note matches this question")) nothing = true;
    const note = NOTE.exec(line);
    if (note) {
      const label = note[3] ?? "";
      const date = ON.exec(label)?.[1];
      candidates.push({ id: note[1] as string, text: note[2] as string, at: date ? Date.parse(date) : order, replaced: /earlier, replaced/.test(label) });
      order += 1;
      continue;
    }
    const dated = DATED.exec(line);
    if (dated) {
      candidates.push({ id: null, text: dated[2] as string, at: Date.parse(dated[1] as string) + order, replaced: false });
      order += 1;
    }
  }
  return { candidates, nothing };
}

/** How well a note answers a question: the share of the question's words it has, and a point for an identifier it names. */
export function overlap(question: string, text: string): number {
  const q = tokenSet(question);
  const t = tokenSet(text);
  const lower = question.toLowerCase();
  const named = identifiersOf(text).some((id) => lower.includes(id.toLowerCase()));
  return containment(q, t) + (named ? 0.35 : 0);
}

export const READER_THRESHOLD = 0.34;

export function read(context: string | null, question: string): Reading {
  if (!context) return { kind: "abstain" };
  const { candidates, nothing } = parse(context);
  if (nothing && candidates.length === 0) return { kind: "abstain" };
  const past = isPastQuestion(question);
  let best: { c: Candidate; score: number } | null = null;
  for (const c of candidates) {
    if (c.replaced && !past) continue;
    const score = overlap(question, c.text);
    if (score < READER_THRESHOLD) continue;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && c.at >= best.c.at)) best = { c, score };
  }
  // The context said no note covers the question, and what matched is only a rule shown because rules always are.
  if (nothing && (!best || best.score < 0.6)) return { kind: "abstain" };
  return best ? { kind: "answer", id: best.c.id, text: best.c.text, at: best.c.at } : { kind: "abstain" };
}
