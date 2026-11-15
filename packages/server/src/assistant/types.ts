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

export type AvatarForm = "halo" | "optic" | "hologram" | "critter" | "cipher";
export type AvatarMoodId = "idle" | "working" | "attention" | "delight" | "concern" | "asleep";

/**
 * A figure built from parts. The ids come from the catalogue the interface keeps (`companion/figure/parts.ts`); the server
 * checks their shape, not their membership, so a pack made by a newer Ancilla is kept and an older one draws the plain part.
 */
export interface FigureSpec {
  body: string;
  top: string;
  eyes: string;
  mouth: string;
  mark: string;
  gear: string;
  aura: string;
  finish: string;
  /** The accent colour's hue, 0 to 359, or null for the one that suits the main hue. */
  accent: number | null;
  /** From light (0) to deep (4). */
  shade: number;
}

/** What the assistant wears: one of the forms of light, a built-in studio companion, a figure built from parts, or a saved avatar by its id. */
export type AvatarLook = { kind: "sigil" } | { kind: "companion"; id: string } | { kind: "figure"; figure: FigureSpec } | { kind: "pack"; id: string; rev: number };

/** Pixel art: `w` by `h` cells (8 to 64 each) with frames per mood. A cell is 0 (clear) or n, which is `palette[n - 1]`. */
export interface PixelData {
  w: number;
  h: number;
  /** "#rrggbb" colours, at most 32. */
  palette: string[];
  /** Every frame is `w * h` bytes in base64. Idle is required. */
  moods: Partial<Record<AvatarMoodId, { ms: number; frames: string[] }>>;
}

/** A picture or a sprite sheet, as a `data:image/png|webp|jpeg;base64,` URL. */
export interface ImagePackData {
  src: string;
  w: number;
  h: number;
  sheet?: { cols: number; rows: number; moods: Partial<Record<AvatarMoodId, { row: number; frames: number; ms: number }>> };
  crisp: boolean;
}

export interface FigurePackData {
  figure: FigureSpec;
  hue: number;
  glow: number;
}

/** An avatar the user made or brought, as stored: the library on the Persona page lists these. */
export type AvatarPack = {
  id: string;
  name: string;
  bytes: number;
  createdAt: number;
  updatedAt: number;
} & ({ kind: "figure"; data: FigurePackData } | { kind: "pixel"; data: PixelData } | { kind: "image"; data: ImagePackData });

export type AvatarPackMeta = Omit<AvatarPack, "data">;

export type VoiceArchetype = "steady" | "warm" | "dry" | "sharp" | "playful" | "formal" | "curious" | "custom";
/** How much of the character reaches a prompt: nothing (it only speaks in Ancilla's own words), a line of tone, or the whole character. */
export type CharacterPresence = "off" | "tone" | "full";

/**
 * The assistant as a character: a face, a voice and a few habits the user chose. It changes how the assistant looks and
 * sounds and nothing it is allowed to do: permissions come from the settings and from Muse, never from here.
 */
export interface AssistantCharacter {
  avatar: {
    form: AvatarForm;
    /** Hue in degrees, 0 to 359. */
    hue: number;
    /** How much light it gives off, 0 to 100. */
    glow: number;
    /** Which variant of the form: ears, blades, rings, a visor, sides. 0 to 3. */
    detail: number;
    /** What the small random touches of the form (blink timing, particle positions, proportions) are drawn from. */
    seed: number;
    /** What it wears: a sigil (the form above), a figure built from parts, or a saved avatar. Always present once read through `normalizeCharacter`. */
    look: AvatarLook;
  };
  /** The voice: a starting archetype, and dials from 0 to 4 that bend it. */
  voice: { archetype: VoiceArchetype; warmth: number; humor: number; directness: number; curiosity: number; formality: number };
  /** What it calls the user; empty means it does not use a name. */
  callsUser: string;
  /** Up to four habits in the user's own words ("Signs off with 'Standing by.'"). */
  quirks: string[];
  presence: CharacterPresence;
  /** Whether the page shows the shared history (days together, what it remembers, what it finished). */
  showBond: boolean;
  /** When the user finished making it theirs; null while it still has the default look and voice, which is when it asks to be set up. */
  setupAt: number | null;
}

export interface AssistantModelPreference {
  /** Provider to run assistant tasks on (`"muse"`, `"codex"`, `"claude"`, etc.), or `null` to follow each project's provider. */
  providerId: string | null;
  /** Named account or API profile id for `providerId`, or `null` for that provider's default login. */
  accountId: string | null;
  /** Model id for assistant tasks, or `null` for the provider's default model. */
  modelId: string | null;
}

export interface AssistantProfile {
  /** One assistant per data folder; the id is fixed. */
  id: string;
  enabled: boolean;
  /** What the assistant calls itself and how it is described to the model every turn. */
  name: string;
  persona: string;
  character: AssistantCharacter;
  /** How it talks to the user. */
  communication: { verbosity: "concise" | "balanced" | "detailed"; tone: "plain" | "warm" | "formal"; language: string; notes: string };
  /** Separate provider and model selection for assistant tasks, independent of chat thread defaults. */
  model: AssistantModelPreference;
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
