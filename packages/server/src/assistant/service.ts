import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { digest, tokens } from "./text.js";
import { MemoryStore, type Change, type CaptureResult } from "./store.js";
import { DEFAULT_PROFILE } from "./profile.js";
import type { AssembledContext, AssistantProfile, Goal, MemoryKind, MemoryStatus } from "./types.js";

/**
 * What the rest of Ancilla talks to. It owns the memory store, decides what each turn gets, and turns a change of
 * memory into the one event the clients hear. It never throws into the turn path: a memory that cannot be read or
 * written costs the turn its notes, not its answer.
 */

export const ASSISTANT_DB_FILE = "assistant.db";

/** What the user is shown after something was written: only ever sent after the write has been committed. */
export interface SavedNotice {
  id: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  /** How many earlier memories this one replaced. */
  replaced: number;
}

export interface AssistantEvent {
  type: "assistant";
  reason: "memory" | "profile" | "goal" | "task";
  epoch: number;
  saved?: SavedNotice[];
  forgotten?: number;
  /** A request that named several memories, or a correction that could mean several: the user is asked. */
  question?: { about: string; options: { id: string; text: string }[]; pendingId?: string };
  /** The capture ran and chose not to keep something, with the reason the user can read. */
  declined?: { reason: string }[];
  /** A task changed. */
  taskId?: string;
}

export interface TurnInput {
  sessionId: string;
  /** The user's own words: what is read for memories and what the notes are looked up by. */
  text: string;
  project: string | null;
  account: string | null;
}

export interface PreparedTurn {
  /** The block to put in front of the prompt, or null when there is nothing to add. */
  prefix: string | null;
  captured: Change[];
  /** The memories the block drew on. */
  used: string[];
  tokens: number;
}

export interface UsedContext {
  at: number;
  memoryIds: string[];
  tokens: number;
  noEvidence: boolean;
  omitted: number;
}

export interface AssistantDeps {
  log: (line: string) => void;
  emit: (event: AssistantEvent) => void;
  now?: () => number;
  /** The local clock's distance east of UTC, for "tomorrow" and "5pm". */
  offsetMinutes?: () => number;
}

const CACHE_LIMIT = 64;
const CACHE_TTL_MS = 5 * 60_000;
const SHORT_QUESTION_WORDS = 5;

function words(text: string): number {
  return tokens(text).length;
}

export function hasIdentity(profile: AssistantProfile, goals: readonly Goal[]): boolean {
  const c = profile.communication;
  const d = DEFAULT_PROFILE.communication;
  return (
    profile.name !== DEFAULT_PROFILE.name ||
    profile.persona.trim() !== "" ||
    c.notes.trim() !== "" ||
    c.language.trim() !== "" ||
    c.tone !== d.tone ||
    c.verbosity !== d.verbosity ||
    goals.some((g) => g.status === "active")
  );
}

export class AssistantService {
  private readonly cache = new Map<string, { at: number; epoch: number; out: AssembledContext & { epoch: number } }>();
  private readonly lastUsed = new Map<string, UsedContext>();
  private readonly lastQuery = new Map<string, string>();

  constructor(
    readonly store: MemoryStore,
    private readonly deps: AssistantDeps,
  ) {}

  /** Opens the assistant's database in the data folder (in memory when the server has none). A failure is the caller's to log: the feature is optional. */
  static open(dataDir: string, deps: AssistantDeps): AssistantService {
    let path = ":memory:";
    if (dataDir !== ":memory:") {
      mkdirSync(dataDir, { recursive: true });
      path = join(dataDir, ASSISTANT_DB_FILE);
    }
    const store = MemoryStore.open(path, deps.now ? { now: deps.now } : {});
    return new AssistantService(store, deps);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  close(): void {
    this.cache.clear();
    try {
      this.store.close();
    } catch (error) {
      this.deps.log(`assistant: closing the memory failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Cached blocks are only reused while nothing was written and not for long: time moves what is due and what is stale. */
  invalidate(): void {
    this.cache.clear();
  }

  announce(event: Omit<AssistantEvent, "type" | "epoch"> & { epoch?: number }): void {
    this.invalidate();
    try {
      this.deps.emit({ type: "assistant", epoch: this.store.epoch(), ...event });
    } catch (error) {
      this.deps.log(`assistant: could not announce a change: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private announceCapture(result: CaptureResult): void {
    const saved: SavedNotice[] = [];
    let forgotten = 0;
    let question: AssistantEvent["question"];
    const declined: { reason: string }[] = [];
    for (const change of result.changes) {
      if (change.type === "created") saved.push({ id: change.id, kind: change.kind, text: change.text, status: change.status, replaced: change.supersedes.length });
      else if (change.type === "forgotten") forgotten += change.ids.length;
      else if (change.type === "ambiguous") question = { about: change.about, options: change.options, ...(change.pendingId ? { pendingId: change.pendingId } : {}) };
      else if (change.type === "suppressed" && /^(secret|paused|tombstone)/.test(change.reason)) declined.push({ reason: change.reason });
    }
    if (result.durable || question || declined.length > 0) {
      this.announce({ reason: "memory", ...(saved.length > 0 ? { saved } : {}), ...(forgotten > 0 ? { forgotten } : {}), ...(question ? { question } : {}), ...(declined.length > 0 ? { declined } : {}) });
    }
  }

  /** Reads what the user said, with the same rules as a message, without building a block: for a steer sent into a running turn. */
  noteMessage(input: TurnInput): Change[] {
    const profile = this.store.getProfile();
    if (!profile.enabled || /^\s*\//.test(input.text)) return [];
    try {
      const result = this.store.capture({
        message: input.text,
        ctx: { role: "user", sessionId: input.sessionId, thread: input.sessionId, observedAt: this.now(), offsetMinutes: this.deps.offsetMinutes ? this.deps.offsetMinutes() : 0, ...(input.project ? { project: input.project } : {}), ...(input.account ? { account: input.account } : {}) },
      });
      this.announceCapture(result);
      return result.changes;
    } catch (error) {
      this.deps.log(`assistant: reading a message for memories failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * The assistant's part of a turn: read what the user said (a correction in this very message applies before the notes
   * are chosen), then pick the notes for it. Never throws.
   */
  prepareTurn(input: TurnInput): PreparedTurn {
    const nothing: PreparedTurn = { prefix: null, captured: [], used: [], tokens: 0 };
    let profile: AssistantProfile;
    try {
      profile = this.store.getProfile();
    } catch (error) {
      this.deps.log(`assistant: the memory could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return nothing;
    }
    if (!profile.enabled || /^\s*\//.test(input.text)) return nothing;
    const captured = this.noteMessage(input);
    try {
      const previous = this.lastQuery.get(input.sessionId) ?? "";
      // "Yes, do that" has no words to look anything up by, so it is looked up with the question before it.
      const queryText = words(input.text) < SHORT_QUESTION_WORDS && previous ? `${input.text} ${previous}` : input.text;
      this.lastQuery.set(input.sessionId, input.text.slice(0, 400));
      if (this.lastQuery.size > 200) this.lastQuery.delete(this.lastQuery.keys().next().value as string);
      const out = this.context(input, queryText, profile);
      const goals = this.store.activeGoals();
      const inject = out.memories.length > 0 || out.noEvidence || hasIdentity(profile, goals);
      const used = out.memories.map((m) => m.item.id);
      if (used.length > 0) this.store.noteUsed(input.sessionId, used);
      this.lastUsed.set(input.sessionId, { at: this.now(), memoryIds: used, tokens: inject ? out.tokens : 0, noEvidence: out.noEvidence, omitted: out.omitted.length });
      if (this.lastUsed.size > 100) this.lastUsed.delete(this.lastUsed.keys().next().value as string);
      return { prefix: inject ? out.text : null, captured, used, tokens: inject ? out.tokens : 0 };
    } catch (error) {
      this.deps.log(`assistant: choosing notes for a turn failed: ${error instanceof Error ? error.message : String(error)}`);
      return { ...nothing, captured };
    }
  }

  private context(input: TurnInput, queryText: string, profile: AssistantProfile): AssembledContext & { epoch: number } {
    const epoch = this.store.epoch();
    const key = [epoch, input.sessionId, input.project ?? "", input.account ?? "", profile.contextBudgetTokens, digest(queryText)].join("|");
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.epoch === epoch && now - hit.at < CACHE_TTL_MS) return hit.out;
    const out = this.store.retrieve({
      text: queryText,
      thread: input.sessionId,
      ...(input.project ? { project: input.project } : {}),
      ...(input.account ? { account: input.account } : {}),
      budgetTokens: profile.contextBudgetTokens,
      now,
    });
    this.cache.set(key, { at: now, epoch, out });
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    return out;
  }

  /** What the model would be told for this question, without sending anything: so the user can see it. */
  preview(input: TurnInput): AssembledContext & { epoch: number; wouldAdd: boolean } {
    const profile = this.store.getProfile();
    const out = this.store.retrieve({
      text: input.text,
      thread: input.sessionId,
      ...(input.project ? { project: input.project } : {}),
      ...(input.account ? { account: input.account } : {}),
      budgetTokens: profile.contextBudgetTokens,
      now: this.now(),
    });
    const inject = profile.enabled && (out.memories.length > 0 || out.noEvidence || hasIdentity(profile, this.store.activeGoals()));
    return { ...out, wouldAdd: inject };
  }

  /** The notes the last turn of a thread drew on, for the "used N notes" line under it. */
  lastContext(sessionId: string): UsedContext | null {
    return this.lastUsed.get(sessionId) ?? null;
  }
}
