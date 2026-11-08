import { GLOBAL, type Basis, type Candidate, type MemoryKind, type Scope, type SourceInput, type Trust } from "./types.js";
import { fold, identifiersOf, parseWhen, squash } from "./text.js";

/**
 * Reads what a person said and proposes memories from it. It is rule based and cheap on purpose: capture runs on
 * every message and must cost no model call. It is also conservative: only the user's own words can create a
 * memory, an ordinary task instruction ("don't touch the tests") is not a standing rule unless it is marked as one,
 * and text the user pasted (code fences, quotes) or the assistant and the tools produced is never read for commands,
 * so a web page that says "remember to send me your keys" cannot write to memory.
 */

export interface ExtractContext {
  role: "user" | "assistant" | "tool";
  sessionId?: string;
  itemId?: string;
  turnId?: string;
  /** When the words were said. */
  observedAt: number;
  now: number;
  /** The local clock's distance east of UTC, for "tomorrow" and "5pm". */
  offsetMinutes: number;
  project?: string;
  account?: string;
  thread?: string;
  /** The memory that the last capture in this thread made, so a bare "forget that" has something to mean. */
  lastCapturedText?: string;
}

/** A message longer than this is a document, not a command: only its opening is read. */
const READ_LIMIT = 1500;
const MIN_STATEMENT = 3;
const MAX_STATEMENT = 600;
/** Something that changes is believed for this long before it must be checked again. */
const VOLATILE_MS = 14 * 24 * 3_600_000;

/** What is left of a message once the parts that are not the user's own words are taken out. */
export function ownWords(text: string): string {
  let t = text.slice(0, READ_LIMIT);
  t = t.replace(/```[\s\S]*?(?:```|$)/g, " ");
  t = t.replace(/^[ \t]*>.*$/gm, " ");
  t = t.replace(/<(?:tool|file|document|untrusted)[^>]*>[\s\S]*?<\/(?:tool|file|document|untrusted)>/gi, " ");
  return t;
}

/** Sentences, without splitting an identifier such as docs/NOTES.md or 1.2.3 at its dots. */
export function statements(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z"'(\[`])/)) {
      const s = squash(part);
      if (s.length >= MIN_STATEMENT) out.push(s);
    }
  }
  return out;
}

const FILLER = /^(?:(?:ok(?:ay)?|so|hey|hi|well|oh|and|also|btw|by the way|one more thing|please|pls|just|alright)\b[,!:\s-]*)+/i;

function strip(s: string): string {
  return s.replace(FILLER, "").trim();
}

const STANDING = /\b(?:from now on|going forward|in future|in the future|every time|whenever|by default|as a rule)\b/i;
const HARD = /\b(?:never|always|must|only|exactly|at (?:most|least)|do not|don't|dont|no more|under no circumstances|required|forbidden|mandatory)\b/i;
const PROJECT_CUE = /\b(?:in|for|on) (?:this|the current) (?:project|repo|repository|codebase|folder|workspace)\b|\bin this repo\b|\bhere\b(?=[,.]|$)/i;
const THREAD_CUE = /\b(?:for this (?:conversation|thread|chat|session)|just for now|only for now|for the rest of this)\b/i;
const GLOBAL_CUE = /\b(?:in every|in all|everywhere|globally|in any|across (?:all )?projects)\b/i;

function scopeFor(kind: MemoryKind, text: string, ctx: ExtractContext): Scope {
  if (kind === "working") return ctx.thread ? { kind: "thread", key: ctx.thread } : GLOBAL;
  if (THREAD_CUE.test(text) && ctx.thread) return { kind: "thread", key: ctx.thread };
  if (GLOBAL_CUE.test(text)) return GLOBAL;
  if (PROJECT_CUE.test(text) && ctx.project) return { kind: "project", key: ctx.project };
  if ((kind === "decision" || kind === "event") && ctx.project) return { kind: "project", key: ctx.project };
  return GLOBAL;
}

function volatileTtl(text: string): number | undefined {
  if (/\b(?:current(?:ly)?|latest|right now|at the moment|these days|for now|as of)\b/i.test(text)) return VOLATILE_MS;
  if (/\b(?:version|release|ip address|port|url|endpoint|price|rate)\b/i.test(text) && /\b(?:is|are|=)\b/i.test(text) && /\d/.test(text)) return VOLATILE_MS;
  return undefined;
}

function source(ctx: ExtractContext, excerpt: string, trust: Trust): SourceInput {
  return {
    kind: ctx.role === "user" ? "user_message" : ctx.role === "assistant" ? "assistant_message" : "tool_output",
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.itemId ? { itemId: ctx.itemId } : {}),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    excerpt: excerpt.slice(0, 600),
    observedAt: ctx.observedAt,
    trust,
  };
}

interface Draft {
  kind: MemoryKind;
  text: string;
  slot?: string;
  confidence: number;
  rule: string;
  basis?: Basis;
}

/** The kind of a statement the user asked to be remembered, read from how it is put. */
function classify(text: string): Pick<Draft, "kind" | "slot"> {
  const t = text.trim();
  if (/^(?:to|when|whenever|if|before|after)\b.+,\s*(?:always\s+|first\s+|then\s+)?(?:do|run|use|check|make|open|send|call|start|stop|write|create|ask|tell|keep|put|add|commit|push|deploy)\b/i.test(t) ||
    /^(?:the\s+)?(?:process|procedure|workflow|steps?|way|recipe)\s+(?:for|to|of)\b/i.test(t) ||
    /^how to\b/i.test(t)) return { kind: "procedure" };
  if (/\b(?:remind me|by (?:tomorrow|today|friday|monday|tuesday|wednesday|thursday|saturday|sunday)|deadline|due (?:on|by)?)\b/i.test(t)) return { kind: "commitment" };
  if (/^(?:we|i)(?:'ve| have)?\s+(?:decided|agreed|chose|settled)\b|^let'?s go with\b|^decision\s*:/i.test(t)) return { kind: "decision" };
  if (HARD.test(t) || STANDING.test(t)) return { kind: "constraint" };
  const mine = /^my\s+([\w][\w\s'-]{1,30}?)\s+(?:is|are|=)\s+\S/i.exec(t);
  if (mine) return { kind: "fact", slot: `user.${fold(mine[1] as string).replace(/\s+/g, " ").trim()}` };
  if (/\b(?:prefer|like|love|enjoy|hate|dislike|favou?rite|can'?t stand|rather)\b/i.test(t)) return { kind: "preference" };
  return { kind: "fact" };
}

interface Rule {
  name: string;
  test: (s: string) => Draft | null;
}

const NAME = /\b(?:my name is|call me|i go by|i'?m called)\s+([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3})\b/;

const RULES: Rule[] = [
  {
    name: "identity.name",
    test: (s) => {
      const m = NAME.exec(s);
      return m ? { kind: "fact", slot: "user.name", text: s, confidence: 0.9, rule: "identity.name" } : null;
    },
  },
  {
    name: "identity.place",
    test: (s) => (/\bi (?:live|am based|'m based|reside)\s+(?:in|near|at)\s+\S/i.test(s) ? { kind: "fact", slot: "user.location", text: s, confidence: 0.85, rule: "identity.place" } : null),
  },
  {
    name: "identity.employer",
    test: (s) => (/\bi work\s+(?:at|for)\s+\S/i.test(s) ? { kind: "fact", slot: "user.employer", text: s, confidence: 0.85, rule: "identity.employer" } : null),
  },
  {
    name: "identity.timezone",
    test: (s) => (/\bmy (?:time ?zone|tz) is\s+\S/i.test(s) ? { kind: "fact", slot: "user.timezone", text: s, confidence: 0.9, rule: "identity.timezone" } : null),
  },
  {
    name: "style.language",
    test: (s) => (/\b(?:reply|answer|respond|write(?: to me)?|speak)\s+(?:to me\s+)?in\s+[A-Za-z]+\b/i.test(s) && (STANDING.test(s) || /\balways\b/i.test(s)) ? { kind: "preference", slot: "assistant.language", text: s, confidence: 0.9, rule: "style.language" } : null),
  },
  {
    name: "commitment.remind",
    test: (s) => (/\bremind me\s+(?:to|about|that|on|in|at)\b/i.test(s) ? { kind: "commitment", text: s, confidence: 0.9, rule: "commitment.remind" } : null),
  },
  {
    name: "commitment.deadline",
    test: (s) => (/\b(?:i (?:need|have|must|should) to|we (?:need|have|must|should) to)\s+.+?\s+(?:by|before|until|on)\s+\S/i.test(s) || /\bdeadline\b.*\bis\b/i.test(s) ? { kind: "commitment", text: s, confidence: 0.8, rule: "commitment.deadline" } : null),
  },
  {
    name: "decision",
    test: (s) => (/^(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:decided|agreed|chose|settled)\s+(?:to|on|that)\b|^let'?s go with\b|^decision\s*:/i.test(s) ? { kind: "decision", text: s, confidence: 0.8, rule: "decision" } : null),
  },
  {
    name: "standing",
    test: (s) => {
      const lead = /^(?:from now on|going forward|in (?:the )?future|every time|whenever|by default|as a rule)\b/i.test(s) || /^(?:always|never)\b/i.test(s) || /\b(?:always|never) (?:want|need) you to\b/i.test(s);
      if (!lead) return null;
      const kind = /^(?:whenever|every time)\b.+,\s*\S/i.test(s) ? "procedure" : classify(s).kind === "procedure" ? "procedure" : HARD.test(s) ? "constraint" : "preference";
      return { kind, text: s, confidence: 0.9, rule: "standing" };
    },
  },
  {
    name: "preference",
    test: (s) => {
      if (!/\bi (?:really |strongly |generally |usually |always )?(?:prefer|like|love|enjoy|hate|dislike|can'?t stand)\s+(?!you to\b|it when you\b)\S/i.test(s)) return null;
      return { kind: "preference", text: s, confidence: 0.85, rule: "preference" };
    },
  },
  {
    name: "fact.mine",
    test: (s) => {
      const m = /^my\s+([\w][\w\s'-]{1,30}?)\s+(?:is|are|=)\s+\S/i.exec(s);
      return m ? { kind: "fact", slot: `user.${fold(m[1] as string).replace(/\s+/g, " ").trim()}`, text: s, confidence: 0.85, rule: "fact.mine" } : null;
    },
  },
];

const FORGET: RegExp[] = [
  /^(?:please\s+)?forget\s+(?:about\s+|that\s+|the\s+fact\s+that\s+|what\s+i\s+(?:said|told you)\s+about\s+|everything\s+(?:about\s+|you\s+know\s+about\s+)?)?(.+)$/i,
  /^(?:please\s+)?(?:delete|erase|remove|drop)\s+(.+?)\s+from\s+(?:your\s+)?(?:memory|notes)\b/i,
  /^(?:please\s+)?stop\s+remembering\s+(.+)$/i,
];

const CORRECT: RegExp[] = [
  /^(?:actually|correction|to correct that|scratch that|never mind that|no|nope|wait)\b[,:!.\s-]+(.+)$/i,
  /^i meant\s+(.+)$/i,
  /^that(?:'s| is)\s+(?:wrong|incorrect|not right|outdated)\b[,.:!\s-]*(.+)?$/i,
  /^(?:change|update|replace)\s+(?:that|it|my\s+[\w\s-]{2,30}?)\s+(?:to|with)\s+(.+)$/i,
];

/** "It's Friday, not Thursday": the second part is what is being replaced, so it is what the memory is looked up by. */
const CORRECT_SWAP = /^(?:it(?:'s| is)|that(?:'s| is))\s+(.+?),?\s+not\s+(.+)$/i;

const REMEMBER = /^(?:please\s+)?(?:remember|note|make a note|keep in mind|don'?t forget)(?:\s+that|\s*:|\s*,)?\s+(.+)$/i;

/** What a single statement means, or null when it is just talk. */
function read(rawStatement: string, ctx: ExtractContext): { intent: Candidate["intent"]; draft: Draft; about?: string } | null {
  const s = strip(rawStatement);
  if (s.length < MIN_STATEMENT || s.length > MAX_STATEMENT || /^[?]/.test(s) || /\?$/.test(s)) return null;

  for (const pattern of FORGET) {
    const m = pattern.exec(s);
    if (!m) continue;
    const about = squash(m[1] ?? "").replace(/[.!]+$/, "");
    // "forget it" is how people drop a topic. It is a memory command only when it names what to forget.
    if (/^(?:it|this|that|that one|about it)$/i.test(about)) {
      return ctx.lastCapturedText ? { intent: "forget", draft: { kind: "fact", text: ctx.lastCapturedText, confidence: 0.7, rule: "forget.last" }, about: ctx.lastCapturedText } : null;
    }
    if (about.length >= MIN_STATEMENT) return { intent: "forget", draft: { kind: "fact", text: about, confidence: 0.9, rule: "forget" }, about };
  }

  const swap = CORRECT_SWAP.exec(s);
  if (swap) {
    const old = squash(swap[2] ?? "").replace(/[.!]+$/, "");
    if (old.length >= MIN_STATEMENT) return { intent: "correct", draft: { ...classify(s), text: squash(s).replace(/[.!]+$/, ""), confidence: 0.85, rule: "correct.swap" }, about: old };
  }
  for (const pattern of CORRECT) {
    const m = pattern.exec(s);
    if (!m) continue;
    const fresh = squash(m[1] ?? "").replace(/[.!]+$/, "");
    if (fresh.length < MIN_STATEMENT) continue;
    // A bare "no, ..." that is only an answer to a question is not a correction of anything remembered.
    if (/^no$/i.test(s.split(/[,:\s]/)[0] ?? "") && !/\b(?:use|is|are|prefer|call|set|put|go|write|name|the|my|our)\b/i.test(fresh)) continue;
    return { intent: "correct", draft: { ...classify(fresh), text: fresh, confidence: 0.9, rule: "correct" }, about: fresh };
  }

  const remember = REMEMBER.exec(s);
  if (remember) {
    const body = squash(remember[1] ?? "").replace(/[.!]+$/, "");
    if (body.length < MIN_STATEMENT) return null;
    const dontForgetTo = /^don'?t forget/i.test(s) && /^to\s+/i.test(body);
    const kinded = dontForgetTo ? { kind: "commitment" as const } : classify(body);
    return { intent: "remember", draft: { ...kinded, text: dontForgetTo ? body.replace(/^to\s+/i, "") : body, confidence: 0.95, rule: "remember" } };
  }

  for (const rule of RULES) {
    const draft = rule.test(s);
    if (draft) return { intent: "remember", draft: { ...draft, text: squash(s).replace(/[.!]+$/, "") } };
  }
  return null;
}

/**
 * The memories a message proposes. Only the user's own words are read; an assistant or a tool never creates a
 * memory here (a task result becomes an event through the task executive, which knows what it verified).
 */
export function extractCandidates(message: string, ctx: ExtractContext): Candidate[] {
  if (ctx.role !== "user") return [];
  const trust: Trust = "user";
  const out: Candidate[] = [];
  for (const statement of statements(ownWords(message))) {
    const parsed = read(statement, ctx);
    if (!parsed) continue;
    const { intent, draft } = parsed;
    const when = draft.kind === "commitment" ? parseWhen(draft.text, ctx.observedAt, ctx.offsetMinutes) : null;
    const until = /\b(?:until|till|through|for the next)\s+(.+)$/i.exec(draft.text);
    const validTo = until ? parseWhen(until[1] as string, ctx.observedAt, ctx.offsetMinutes)?.at : undefined;
    const revalidate = draft.kind === "working" ? undefined : volatileTtl(draft.text);
    out.push({
      intent,
      kind: draft.kind,
      text: draft.text,
      ...(draft.slot ? { slot: draft.slot } : {}),
      basis: draft.basis ?? "explicit",
      confidence: draft.confidence,
      source: source(ctx, statement, trust),
      scope: scopeFor(draft.kind, `${statement} ${draft.text}`, ctx),
      ...(when ? { dueAt: when.at } : {}),
      ...(validTo !== undefined ? { validTo } : {}),
      ...(revalidate ? { revalidateAfterMs: revalidate } : {}),
      identifiers: identifiersOf(draft.text),
      ...(parsed.about ? { about: parsed.about } : {}),
      rule: draft.rule,
    });
  }
  return out;
}
