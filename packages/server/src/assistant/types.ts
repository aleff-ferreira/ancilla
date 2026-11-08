/**
 * The vocabulary of the personal assistant's memory and task executive. Everything here is plain data so the
 * pure parts (extraction, resolution, retrieval, scoring, the executive's state machine) can be tested without a
 * database, a clock or a Muse host, and so the same shapes cross the HTTP boundary to the UI unchanged.
 */

/** What a memory is. `working` is the only kind that is allowed to expire on its own. */
export const MEMORY_KINDS = ["fact", "preference", "constraint", "event", "decision", "procedure", "commitment", "working"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * How a statement came to be believed. Only `explicit` (the user said it) and `observed` (a verified observation)
 * can stand as authoritative. An `inferred` memory is a hint: it is labelled as tentative wherever it is shown,
 * it never supersedes an authoritative memory, and repeating it does not promote it.
 */
export type Basis = "explicit" | "observed" | "inferred";

/** How far the place a statement came from can be believed. Text from `untrusted` places is data, never an instruction. */
export type Trust = "user" | "verified" | "unverified" | "untrusted";

/**
 * `active` is believed now. `superseded` was believed once and a newer statement replaced it (kept as history).
 * `contested` has a rival of equal standing and waits for the user. `pending` came from a source that cannot
 * establish it alone and waits for the user. `deleted` has had its content erased and keeps only a fingerprint.
 */
export type MemoryStatus = "active" | "superseded" | "contested" | "pending" | "deleted";

/** Where a memory applies. Narrower scopes win when a question is asked from inside them. */
export interface Scope {
  kind: "global" | "account" | "project" | "thread";
  /** The account id, the project's folder key or the thread's session id; empty for `global`. */
  key: string;
}

export const GLOBAL: Scope = { kind: "global", key: "" };

export function scopeId(scope: Scope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.key}`;
}

/** A place a statement was read: the exact words, kept so that a memory can always be traced and, if need be, erased. */
export interface SourceInput {
  kind: "user_message" | "assistant_message" | "tool_output" | "file" | "web" | "ui" | "import" | "task";
  sessionId?: string;
  /** The MSP item the words came from. */
  itemId?: string;
  turnId?: string;
  /** The exact words, bounded. */
  excerpt: string;
  /** When the words were said or observed, never when they were processed: a late job must not outrank a newer correction. */
  observedAt: number;
  trust: Trust;
}

export interface SourceRecord extends SourceInput {
  id: string;
  /** A digest of the excerpt, so the same words are never taken in twice and an erased source can be recognised again. */
  digest: string;
}

/** What an extractor proposes. It is a proposal: the resolver decides what becomes of it. */
export interface Candidate {
  intent: "remember" | "forget" | "correct";
  kind: MemoryKind;
  /** The statement in the user's own words, whitespace normalised and nothing else. Exact constraints stay exact. */
  text: string;
  /** A single-valued slot the statement fills, such as `user.name`: a new value in a slot supersedes the old one. */
  slot?: string;
  basis: Basis;
  /** 0 to 1: how sure the extractor is that it read the statement right, not how true the statement is. */
  confidence: number;
  source: SourceInput;
  scope: Scope;
  validFrom?: number;
  validTo?: number;
  /** For a commitment: when it falls due. */
  dueAt?: number;
  /** The statement is about something that changes, so it must be checked again after this long. */
  revalidateAfterMs?: number;
  /** Exact identifiers inside the text (paths, versions, ids, numbers with units) that no rewrite may lose. */
  identifiers: string[];
  /** For a correction or a forget: the words that should find the memory it is about. */
  about?: string;
  /** Why the extractor made this candidate, for the audit trail. */
  rule: string;
}

export interface MemoryRevision {
  rev: number;
  text: string;
  basis: Basis;
  confidence: number;
  observedAt: number;
  validFrom: number | null;
  validTo: number | null;
  dueAt: number | null;
  revalidateAfterMs: number | null;
  sourceIds: string[];
  /** Who or what wrote this revision. */
  actor: "capture" | "user" | "consolidation" | "task";
  /** Why: a rule name, `user edit`, `superseded by …`. */
  reason: string;
  createdAt: number;
}

export interface MemoryItem {
  id: string;
  assistantId: string;
  kind: MemoryKind;
  scope: Scope;
  status: MemoryStatus;
  slot: string | null;
  pinned: boolean;
  /** The head revision, flattened for the lists. */
  text: string;
  basis: Basis;
  confidence: number;
  observedAt: number;
  validFrom: number | null;
  validTo: number | null;
  dueAt: number | null;
  /** A commitment's state; null for every other kind. */
  commitment: "open" | "done" | "dropped" | null;
  revalidateAfterMs: number | null;
  lastConfirmedAt: number;
  supersededBy: string | null;
  /** Every change moves this, so an edit made on a stale view is refused instead of overwriting a newer one. */
  rev: number;
  identifiers: string[];
  /** A digest of the words, ignoring case and spacing, kept so that finding a statement already on file is a lookup. */
  digest?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryDetail {
  item: MemoryItem;
  revisions: MemoryRevision[];
  sources: SourceRecord[];
  /** Items this one replaced or was replaced by, newest first. */
  lineage: { id: string; text: string; status: MemoryStatus; observedAt: number }[];
  /** For a correction that is waiting for the user: the memories it could replace. */
  mayCorrect: { id: string; text: string }[];
}

// ------------------------------------------------------------------------------------------------ the assistant

export type Autonomy = "ask" | "suggest" | "act";

export interface AssistantProfile {
  /** One assistant per data folder; the id is fixed. */
  id: string;
  enabled: boolean;
  /** What the assistant calls itself and how it is described to the model every turn. */
  name: string;
  persona: string;
  /** How it talks to the user. */
  communication: { verbosity: "concise" | "balanced" | "detailed"; tone: "plain" | "warm" | "formal"; language: string; notes: string };
  autonomy: Autonomy;
  /** What an autonomous task may do without asking, and how much it may spend. */
  policy: { allowReadOnly: boolean; allowProjectWrites: boolean; maxConcurrent: number; maxTurnsPerTask: number; maxMinutesPerTask: number; maxTasksPerDay: number };
  /** Capture is the only thing pausing stops: what is already remembered is still used. */
  capturePaused: boolean;
  /** How much context memory may add to a turn, in estimated tokens. */
  contextBudgetTokens: number;
  updatedAt: number;
}

export interface Goal {
  id: string;
  text: string;
  priority: number;
  status: "active" | "paused" | "done";
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------------------------------------ retrieval

export interface RetrievalQuery {
  text: string;
  scopes: Scope[];
  now: number;
  /** How many estimated tokens the assembled block may use. */
  budgetTokens: number;
  /** Include superseded memories, for a question about the past. */
  history?: boolean;
  /** The moment a question about the past is about: what existed then is eligible, what came later is not. */
  asOf?: number;
  limit?: number;
}

export interface RetrievedMemory {
  item: MemoryItem;
  score: number;
  /** Why it was chosen, for the audit trail and for tests. */
  why: string[];
  /** The memory is old enough, for something that changes, that it must be checked before it is relied on. */
  stale: boolean;
}

export interface AssembledContext {
  /** The block that is added to the turn; empty when nothing qualifies and the assistant is disabled. */
  text: string;
  memories: RetrievedMemory[];
  tokens: number;
  /** Retrieval found nothing for a question that asks what the assistant remembers. */
  noEvidence: boolean;
  /** Ids of memories left out for want of budget. */
  omitted: string[];
}

/** An estimate good enough to bound a block: about four characters a token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
