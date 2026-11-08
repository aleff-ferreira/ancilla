import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantService } from "../service.js";
import { MemoryStore } from "../store.js";
import { isPastQuestion, parseAsOf } from "../text.js";
import { GLOBAL, estimateTokens, type Candidate } from "../types.js";
import { identifiersOf } from "../text.js";
import { summaryContext, windowContext, type Message } from "./baselines.js";
import { read } from "./reader.js";
import { at, DAY_MS, START, type Case, type Category, type Probe, type Said } from "./scenario.js";
import type { Variant } from "./variants.js";

/**
 * Runs scenarios against the assistant and its baselines, one probe at a time, and counts. The same scripted reader
 * reads every system's context, so the numbers compare what each system put in front of a prompt.
 */

export interface Stat {
  n: number;
  /** The context held everything a right one holds (for probes that name something to hold). */
  hit: number;
  /** The reader's answer was right, or it rightly said it had nothing, whatever else the context held. */
  answer: number;
  /** The answer was right and the context held nothing it must not: the standard for the assistant's own block. */
  correct: number;
  /** The reader asserted something it should not have. */
  unsupported: number;
  /** The context held something it must not. */
  leaked: number;
  tokens: number[];
  precisionHits: number;
  precisionSeen: number;
}

export type Table = Record<string, Record<string, Stat>>;

const blank = (): Stat => ({ n: 0, hit: 0, answer: 0, correct: 0, unsupported: 0, leaked: 0, tokens: [], precisionHits: 0, precisionSeen: 0 });

export const BUDGET = 900;
export const BASELINES = ["none", "window", "summary"] as const;

const has = (text: string, needle: string): boolean => text.toLowerCase().includes(needle.toLowerCase());

export function holdsAll(context: string, need: readonly (readonly string[])[]): boolean {
  return need.every((group) => group.some((option) => has(context, option)));
}

export interface Judged {
  hit: boolean | null;
  answer: boolean;
  correct: boolean;
  unsupported: boolean;
  leaked: boolean;
}

export function judge(probe: Probe, context: string | null, question: string): Judged {
  const text = context ?? "";
  const reading = read(context, question);
  const leaked = (probe.never ?? []).some((n) => has(text, n));
  if (probe.category === "contradiction") {
    // A dispute is surfaced when the context says so and holds both sides; which one a reader then reports is not the test.
    const shown = holdsAll(text, probe.need ?? []);
    return { hit: shown, answer: shown, correct: shown, unsupported: false, leaked };
  }
  if (probe.abstain) {
    const answered = reading.kind === "answer";
    return { hit: null, answer: !answered, correct: !answered && !leaked, unsupported: answered, leaked };
  }
  const hit = probe.need ? holdsAll(text, probe.need) : null;
  let right = false;
  let unsupported = false;
  if (reading.kind === "answer") {
    const satisfies = probe.need ? holdsAll(reading.text, probe.need) : true;
    const forbidden = (probe.never ?? []).some((n) => has(reading.text, n));
    right = satisfies && !forbidden;
    unsupported = !right;
  } else {
    // Nothing asserted: for a probe that expects only that something is absent, that is right.
    right = probe.need === undefined;
  }
  return { hit, answer: right, correct: right && !leaked, unsupported, leaked };
}

function add(table: Table, system: string, key: string, j: Judged, tokens: number, prec?: { hits: number; seen: number }): void {
  const row = (table[system] ??= {});
  const s = (row[key] ??= blank());
  s.n += 1;
  if (j.hit) s.hit += 1;
  if (j.answer) s.answer += 1;
  if (j.correct) s.correct += 1;
  if (j.unsupported) s.unsupported += 1;
  if (j.leaked) s.leaked += 1;
  s.tokens.push(tokens);
  if (prec) {
    s.precisionHits += prec.hits;
    s.precisionSeen += prec.seen;
  }
}

export interface RunOptions {
  budget?: number;
  /** Extra retrieval variants to run on every probe, by name. */
  variants?: Record<string, Variant>;
  /** Which systems to run; all by default. */
  systems?: readonly ("none" | "window" | "summary" | "assistant")[];
  /** Only these categories are scored. */
  only?: readonly Category[];
  /** Called for every probe of every system, for looking at what went wrong. */
  trace?: (event: { system: string; key: string; question: string; context: string | null; judged: Judged }) => void;
}

export interface CaseRun {
  /** Active memories at the end that contain something a probe said must never be there. */
  accepted: string[];
  /** Waiting memories, from places that are not the user. */
  pending: number;
}

const PROJECT = "/work/atlas";

/** One scenario, start to finish. Scores go into `table`. */
export function runCase(c: Case, table: Table, options: RunOptions = {}): CaseRun {
  const budget = options.budget ?? BUDGET;
  const systems = options.systems ?? ["none", "window", "summary", "assistant"];
  const clock = { t: START };
  const restarts = c.steps.some((s) => s.op === "restart");
  const dir = restarts ? mkdtempSync(join(tmpdir(), "assistant-eval-")) : null;
  const path = dir ? join(dir, "assistant.db") : ":memory:";
  let store = MemoryStore.open(path, { now: () => clock.t });
  store.saveProfile({ enabled: true });
  let service = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, offsetMinutes: () => 0 });
  const history: Message[] = [];
  const tagOf = new Map<string, string>();

  try {
    c.steps.forEach((step, index) => {
      if (step.op === "restart") {
        clock.t = Math.max(clock.t, at(step, index));
        store.close();
        store = MemoryStore.open(path, { now: () => clock.t });
        service = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, offsetMinutes: () => 0 });
        return;
      }
      if (step.op === "say" || step.op === "replay") {
        const original = step.op === "replay" ? (c.steps[step.of] as Said) : step;
        const when = at(original, step.op === "replay" ? step.of : index);
        clock.t = Math.max(clock.t, step.op === "replay" ? START + Math.round(step.day * DAY_MS) + index * 1000 : when);
        const thread = original.thread ?? "t1";
        const role = original.role ?? "user";
        if (step.op === "say") history.push({ at: when, thread, role, text: original.text });
        if (original.source) {
          const body = original.text.replace(/^remember that\s+/i, "");
          const candidate: Candidate = { intent: "remember", kind: "fact", text: body, basis: "explicit", confidence: 0.9, scope: GLOBAL, identifiers: identifiersOf(body), rule: "eval", source: { kind: original.source, excerpt: original.text, observedAt: when, trust: "untrusted" } };
          store.propose(candidate, { sourceKey: `p${index}`, thread });
          return;
        }
        const out = store.capture({
          message: original.text,
          ctx: { role, sessionId: thread, itemId: step.op === "replay" ? `replay${index}` : `i${index}`, observedAt: when, offsetMinutes: 0, project: original.project ?? PROJECT, thread },
        });
        for (const change of out.changes) if (change.type === "created" && original.tag) tagOf.set(change.id, original.tag);
        return;
      }
      clock.t = Math.max(clock.t, at(step, index));
      const thread = step.thread ?? "t1";
      const project = step.project ?? PROJECT;
      const probe = step.probe;
      if (options.only && !options.only.includes(probe.category)) return;
      const key = probe.bucket ? `${probe.category}:${probe.bucket}` : probe.category;
      for (const system of systems) {
        let context: string | null = null;
        let prec: { hits: number; seen: number } | undefined;
        if (system === "window") context = windowContext(history, thread, budget) || null;
        else if (system === "summary") context = summaryContext(history, thread, budget) || null;
        else if (system === "assistant") {
          const out = service.preview({ sessionId: thread, text: step.text, project, account: null });
          context = out.wouldAdd ? out.text : null;
          prec = precision(out.memories, tagOf, probe);
        }
        const judged = judge(probe, context, step.text);
        options.trace?.({ system, key, question: step.text, context, judged });
        add(table, system, key, judged, estimateTokens(context ?? ""), prec);
      }
      for (const [name, variant] of Object.entries(options.variants ?? {})) {
        const past = isPastQuestion(step.text) ? parseAsOf(step.text, clock.t, 0) : null;
        const out = variant(store, { text: step.text, thread, project, now: clock.t, budgetTokens: budget, ...(past !== null ? { asOf: past } : {}) });
        add(table, name, key, judge(probe, out.memories.length > 0 || out.noEvidence ? out.text : null, step.text), estimateTokens(out.text), precision(out.memories, tagOf, probe));
      }
    });

    const nevers = c.steps.flatMap((s) => (s.op === "ask" && s.probe.category === "injection" ? (s.probe.never ?? []) : []));
    const items = store.list({ status: "all", limit: 200 }).items;
    const accepted = nevers.filter((n) => items.some((i) => (i.status === "active" || i.status === "contested") && has(i.text, n)));
    return { accepted, pending: items.filter((i) => i.status === "pending").length };
  } finally {
    store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function precision(memories: readonly { item: { id: string; kind: string; pinned: boolean } }[], tagOf: ReadonlyMap<string, string>, probe: Probe): { hits: number; seen: number } | undefined {
  if (!probe.relevant && !probe.abstain) return undefined;
  const relevant = new Set(probe.relevant ?? []);
  let hits = 0;
  let seen = 0;
  for (const m of memories) {
    // A standing rule is shown every time by design; it is not counted for or against the choice of notes.
    if (m.item.kind === "constraint" || m.item.pinned) continue;
    seen += 1;
    if (relevant.has(tagOf.get(m.item.id) ?? "")) hits += 1;
  }
  return { hits, seen };
}

export function runSuite(cases: readonly Case[], options: RunOptions = {}): { table: Table; accepted: number; pending: number } {
  const table: Table = {};
  let accepted = 0;
  let pending = 0;
  for (const c of cases) {
    const r = runCase(c, table, options);
    accepted += r.accepted.length;
    pending += r.pending;
  }
  return { table, accepted, pending };
}

// ---------------------------------------------------------------------------------------------- reading the table

export function rate(stat: Stat | undefined, field: "hit" | "answer" | "correct" | "unsupported" | "leaked"): number | null {
  return stat && stat.n > 0 ? stat[field] / stat.n : null;
}

/** All the rows of a category (any bucket), added together. */
export function sum(rows: Record<string, Stat> | undefined, category: Category, bucket?: string): Stat | undefined {
  if (!rows) return undefined;
  const out = blank();
  let any = false;
  for (const [key, s] of Object.entries(rows)) {
    const [cat, b] = key.split(":");
    if (cat !== category || (bucket !== undefined && b !== bucket)) continue;
    any = true;
    out.n += s.n;
    out.hit += s.hit;
    out.answer += s.answer;
    out.correct += s.correct;
    out.unsupported += s.unsupported;
    out.leaked += s.leaked;
    out.tokens.push(...s.tokens);
    out.precisionHits += s.precisionHits;
    out.precisionSeen += s.precisionSeen;
  }
  return any ? out : undefined;
}

export function precisionOf(rows: Record<string, Stat> | undefined): number | null {
  if (!rows) return null;
  let hits = 0;
  let seen = 0;
  for (const s of Object.values(rows)) {
    hits += s.precisionHits;
    seen += s.precisionSeen;
  }
  return seen > 0 ? hits / seen : null;
}

export function unsupportedOf(rows: Record<string, Stat> | undefined): number | null {
  if (!rows) return null;
  let n = 0;
  let u = 0;
  for (const s of Object.values(rows)) {
    n += s.n;
    u += s.unsupported;
  }
  return n > 0 ? u / n : null;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

export function tokensOf(rows: Record<string, Stat> | undefined): { mean: number; p95: number } {
  const all = Object.values(rows ?? {}).flatMap((s) => s.tokens);
  return { mean: all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : 0, p95: percentile(all, 0.95) };
}
