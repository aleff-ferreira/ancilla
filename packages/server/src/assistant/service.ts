import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EMBEDDING_SETTINGS, embedderFor, EmbeddingRejected, keyIsSet, readEmbeddingSettings, writeEmbeddingSettings, type Embedder, type EmbeddingSettings } from "./embed.js";
import { Executive, type BrowseRunnerPort, type ConnectorRunnerPort, type ExecutiveHost, type FallbackReadRunner, type FallbackWriteRunner, type RecoverySummary } from "./executive.js";
import { withMeaningVectors, type MeaningOptions } from "./meaning.js";
import { looksSecret } from "./secrets.js";
import { digest, isPastQuestion, parseAsOf, tokens } from "./text.js";
import { MemoryStore, type Change, type CaptureResult } from "./store.js";
import { DEFAULT_PROFILE } from "./profile.js";
import { startAutonomous } from "./suggest.js";
import { parseTaskSpec, TaskStore } from "./tasks.js";
import { waitingTasks, type WaitingTask } from "./waiting.js";
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

/** A turn that has been read and is waiting for its notes; or one that needs none (the assistant is off, or it was a command). */
type Pending = { done?: undefined; profile: AssistantProfile; captured: Change[]; queryText: string; followUpText: string | null; meaningText: string; asOf: number | null };
type Begun = Pending | { done: PreparedTurn };

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
  /** What the task executive needs of the server: threads, turns, files. Without it there is no executive, only memory. */
  host?: ExecutiveHost;
  /** The assistant's own browser, which runs web tasks. Without it the executive makes none. */
  browse?: BrowseRunnerPort;
  /** The connected accounts, which run connector tasks. Without it the executive makes none. */
  connector?: ConnectorRunnerPort;
  /** Runs read-only project steps on the configured assistant model when Muse is not reachable. */
  fallbackRead?: FallbackReadRunner;
  /** Runs authorized project write steps on the configured assistant model when Muse is not reachable. */
  fallbackWrite?: FallbackWriteRunner;
  /** True when global user pre-authorization (such as YOLO mode) permits project writes. */
  isPreAuthorized?: () => boolean;
  /** How often the executive looks for work, in milliseconds. */
  tickMs?: number;
  /** The data folder, where the meaning-search settings are kept; without it they last only as long as the process. */
  dataDir?: string;
  /** Meaning search, already set up: what a server started with it or a test passes. Off when absent. */
  embedding?: { settings: EmbeddingSettings; embedder: Embedder } | null;
}

/** What the page shows of meaning search: the settings (never a key, only whether the variable that holds it is set) and how far the index has come. */
export interface EmbeddingStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  queryPrefix: string;
  apiKeyEnv: string | null;
  keyPresent: boolean;
  minCosine: number;
  standoutCosine: number | null;
  standoutLead: number;
  most: number;
  /** Notes that can be found by meaning now. */
  indexed: number;
  /** Notes still waiting for their vector. */
  pending: number;
  /** Notes the server refused to read (too long, say): left to the words. */
  skipped: number;
  /** The server did not answer, and meaning search waits before asking again. */
  paused: boolean;
  error: string | null;
}

/** What the page is shown while meaning search is off: the defaults it would start from. */
export const NO_EMBEDDING: EmbeddingStatus = {
  configured: false, baseUrl: "", model: "", queryPrefix: DEFAULT_EMBEDDING_SETTINGS.queryPrefix, apiKeyEnv: null, keyPresent: false,
  minCosine: DEFAULT_EMBEDDING_SETTINGS.minCosine, standoutCosine: DEFAULT_EMBEDDING_SETTINGS.standoutCosine, standoutLead: DEFAULT_EMBEDDING_SETTINGS.standoutLead,
  most: DEFAULT_EMBEDDING_SETTINGS.most, indexed: 0, pending: 0, skipped: 0, paused: false, error: null,
};

const CACHE_LIMIT = 64;
const CACHE_TTL_MS = 5 * 60_000;
const SHORT_QUESTION_WORDS = 5;
/** A message of this many words or fewer is looked up by meaning together with the question before it. */
const MEANING_FOLLOW_UP_WORDS = 2;
/** How long a turn waits for the question's vector before it goes on with words alone. */
export const MEANING_TIMEOUT_MS = 400;
const QUERY_VECTOR_LIMIT = 32;
const INDEX_BATCH = 16;
const INDEX_ROUNDS = 50;

function words(text: string): number {
  return tokens(text).length;
}

/** Whether any note is here because of the question (its words, an identifier, its meaning), and not only because it is always there (a rule, a pinned note, a due task). */
function foundByQuery(out: AssembledContext): boolean {
  return out.memories.some((m) => m.why.some((w) => w === "text match" || w === "words in common" || w === "close in meaning" || w.startsWith("identifier ")));
}

/** Every word, small ones too: "when does my salary arrive?" is five, though little of it is a word to look anything up by. */
function totalWords(text: string): number {
  return (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;
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
    // A character the user made theirs is told to the model even when no note applies; one left at its default is not.
    (profile.character.setupAt !== null && profile.character.presence !== "off") ||
    goals.some((g) => g.status === "active")
  );
}

export class AssistantService {
  private readonly cache = new Map<string, { at: number; epoch: number; out: AssembledContext & { epoch: number } }>();
  private readonly lastUsed = new Map<string, UsedContext>();
  private readonly lastQuery = new Map<string, string>();

  readonly tasks: TaskStore;
  /** Null when the server gave no host to run tasks on: the memory still works. */
  readonly executive: Executive | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Meaning search: off until the user names an embedding model. Everything below is idle while `embedding` is null.
  private embedding: { settings: EmbeddingSettings; embedder: Embedder } | null;
  /** Counts the times vectors were written, so that a cached block made before them is not reused after. */
  private vectorEpoch = 0;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private indexing = false;
  /** Set when a note arrived while a pass was running. */
  private indexAgain = false;
  private embedFailures = 0;
  private embedPausedUntil = 0;
  private lastEmbedError: string | null = null;
  /** Notes the server refused to read, by id and wording: not asked about again while they say the same. */
  private readonly unembeddable = new Set<string>();
  private readonly queryVectors = new Map<string, Float32Array>();
  private isClosed = false;

  constructor(
    readonly store: MemoryStore,
    private readonly deps: AssistantDeps,
  ) {
    this.embedding = deps.embedding ?? null;
    this.tasks = new TaskStore(store, () => this.now());
    this.executive = deps.host
      ? new Executive(this.tasks, deps.host, {
          profile: () => this.store.getProfile(),
          memory: (input) => this.taskContext(input),
          changed: (taskId) => this.announce({ reason: "task", ...(taskId ? { taskId } : {}) }),
          initiative: (now) => this.takeInitiative(now),
          ...(deps.browse ? { browse: deps.browse } : {}),
          ...(deps.connector ? { connector: deps.connector } : {}),
          ...(deps.fallbackRead ? { fallbackRead: deps.fallbackRead } : {}),
          ...(deps.fallbackWrite ? { fallbackWrite: deps.fallbackWrite } : {}),
          ...(deps.isPreAuthorized ? { isPreAuthorized: deps.isPreAuthorized } : {}),
        })
      : null;
  }

  /**
   * What the assistant does when the server starts, and then every few seconds: settle what a restart left in the air,
   * and look for work. Safe to call once; never throws.
   */
  async start(): Promise<RecoverySummary | null> {
    // Notes written while the server was off, or before meaning search was set up, get their vectors now.
    this.kickIndex(1000);
    const executive = this.executive;
    if (!executive) return null;
    let summary: RecoverySummary | null = null;
    try {
      summary = await executive.recover();
    } catch (error) {
      this.deps.log(`assistant: recovering tasks after a restart failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.maybeConsolidate();
        void executive.tick().catch((error) => this.deps.log(`assistant: a tick failed: ${error instanceof Error ? error.message : String(error)}`));
      }, this.deps.tickMs ?? 15_000);
      this.timer.unref?.();
    }
    return summary;
  }

  /** Once a day while Ancilla is open: merge copies, drop expired working notes, roll up old history. */
  private maybeConsolidate(): void {
    try {
      const last = Number(this.store.getMeta("consolidated_at") ?? 0);
      if (this.now() - last < 24 * 3_600_000 || !this.store.getProfile().enabled) return;
      const done = this.store.consolidate(this.now());
      if (done.merged + done.expired + done.rolledUp > 0) this.announce({ reason: "memory" });
    } catch (error) {
      this.deps.log(`assistant: tidying the memory failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The key a folder is known by in memory scopes and on tasks. */
  projectKey(cwd: string): string {
    return this.deps.host ? this.deps.host.projectKey(cwd) : cwd;
  }

  /** Whether a Muse thread is currently waiting on an approval or a question from the user. */
  sessionNeedsUser(sessionId: string | null): boolean {
    return Boolean(sessionId && this.deps.host?.needsUser(sessionId));
  }

  /**
   * What the page shows at a glance about the work: how much is open and how much waits on the user, and which tasks have
   * stopped for the person (`waiting`, at most a few: what a notification names, told apart from a task they paused themselves).
   */
  taskSummary(): { open: number; needsYou: number; running: number; waiting: WaitingTask[] } {
    const runningTasks = this.tasks.byStatus(["running"]);
    const runningNeedsYou = runningTasks.filter((t) => this.sessionNeedsUser(t.sessionId)).length;
    return {
      open: this.tasks.count(["queued", "running", "waiting", "paused", "blocked"]),
      needsYou: this.tasks.count(["blocked", "unverified", "paused"]) + runningNeedsYou,
      running: runningTasks.length,
      waiting: waitingTasks(
        [...runningTasks, ...this.tasks.byStatus(["paused", "blocked"])],
        (id) => this.executive?.browseQuestion(id) ?? null,
        (sid: string) => this.sessionNeedsUser(sid),
      ),
    };
  }

  /** The notes for a task step: the same retrieval as a message, and never read for memories. */
  private taskContext(input: { text: string; sessionId: string | null; project: string; account: string | null }): string | null {
    const profile = this.store.getProfile();
    if (!profile.enabled) return null;
    try {
      const out = this.store.retrieve({ text: input.text, ...(input.sessionId ? { thread: input.sessionId } : {}), project: input.project, ...(input.account ? { account: input.account } : {}), budgetTokens: profile.contextBudgetTokens, now: this.now() });
      return out.memories.length > 0 || hasIdentity(profile, this.store.activeGoals()) ? out.text : null;
    } catch (error) {
      this.deps.log(`assistant: choosing notes for a task failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Under "act", the assistant starts the read-only work its notes point at, a couple of tasks a day at most. */
  private takeInitiative(now: number): void {
    const executive = this.executive;
    const host = this.deps.host;
    if (!executive || !host) return;
    const profile = this.store.getProfile();
    startAutonomous({
      memory: this.store, tasks: this.tasks, profile, now,
      start: (suggestion) => {
        if (suggestion.action.type !== "task" || !suggestion.action.project) throw new Error("not a task with a place to run");
        const spec = parseTaskSpec({ goal: suggestion.action.goal, cwd: suggestion.action.project, title: suggestion.title.slice(0, 100) }, profile, host.projectKey);
        return executive.create({ ...spec, origin: "suggestion" });
      },
    });
  }

  /** Opens the assistant's database in the data folder (in memory when the server has none). A failure is the caller's to log: the feature is optional. */
  static open(dataDir: string, deps: AssistantDeps): AssistantService {
    let path = ":memory:";
    if (dataDir !== ":memory:") {
      mkdirSync(dataDir, { recursive: true });
      path = join(dataDir, ASSISTANT_DB_FILE);
    }
    const store = MemoryStore.open(path, deps.now ? { now: deps.now } : {});
    // Meaning search is on when the user saved a model for it; a server given one directly (a test) keeps that one.
    const saved = deps.embedding === undefined ? readEmbeddingSettings(dataDir, (message) => deps.log(`assistant: ${message}`)) : null;
    const embedding = deps.embedding !== undefined ? deps.embedding : saved ? { settings: saved, embedder: embedderFor(saved) } : null;
    return new AssistantService(store, { ...deps, dataDir, embedding });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : this.store.now();
  }

  close(): void {
    this.isClosed = true;
    this.cache.clear();
    this.queryVectors.clear();
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.executive?.close();
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
    // A note that was just written or changed has no vector yet: it gets one in a moment.
    if (event.reason === "memory") this.kickIndex();
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
    const begun = this.beginTurn(input);
    if (begun.done) return begun.done;
    return this.finishTurn(input, begun, null);
  }

  /**
   * `prepareTurn`, with meaning search when it is set up: the notes nearest the question in meaning are found as well,
   * for a question that shares no words with its answer. It waits for the question's vector no longer than `timeoutMs`;
   * a server that is down, slow or not set up costs the turn that wait at most, and the words decide as before.
   */
  async prepareTurnAsync(input: TurnInput, options: { timeoutMs?: number } = {}): Promise<PreparedTurn> {
    const begun = this.beginTurn(input);
    if (begun.done) return begun.done;
    const meaning = await this.meaningFor(begun.meaningText, options.timeoutMs ?? MEANING_TIMEOUT_MS);
    return this.finishTurn(input, begun, meaning);
  }

  /** The first half of a turn: read what the user said, and work out what the notes are to be looked up by. */
  private beginTurn(input: TurnInput): Begun {
    const nothing: PreparedTurn = { prefix: null, captured: [], used: [], tokens: 0 };
    let profile: AssistantProfile;
    try {
      profile = this.store.getProfile();
    } catch (error) {
      this.deps.log(`assistant: the memory could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return { done: nothing };
    }
    if (!profile.enabled || /^\s*\//.test(input.text)) return { done: nothing };
    const captured = this.noteMessage(input);
    try {
      const previous = this.lastQuery.get(input.sessionId) ?? "";
      const withPrevious = `${input.text} ${previous}`;
      // A message is looked up as it is. Mixed with the question before it, a short question loses its own note: its words
      // are a smaller part of the whole ("when does my salary arrive?" after "where is the staging server?" no longer covers
      // enough of the query to match the salary), and by meaning its vector is pulled toward the earlier topic. But "yes, do
      // that" has no words to look anything up by, so a short message that finds nothing of its own is tried again with the
      // question before it (`followUpText`), and by meaning a message of two words or fewer is looked up that way at once.
      const followUpText = words(input.text) < SHORT_QUESTION_WORDS && previous ? withPrevious : null;
      const meaningText = totalWords(input.text) <= MEANING_FOLLOW_UP_WORDS && previous ? withPrevious : input.text;
      this.lastQuery.set(input.sessionId, input.text.slice(0, 400));
      if (this.lastQuery.size > 200) this.lastQuery.delete(this.lastQuery.keys().next().value as string);
      // A question about a past moment ("what was my timezone in September?") is answered as of then.
      const asOf = isPastQuestion(input.text) ? parseAsOf(input.text, this.now(), this.deps.offsetMinutes ? this.deps.offsetMinutes() : 0) : null;
      return { profile, captured, queryText: input.text, followUpText, meaningText, asOf };
    } catch (error) {
      this.deps.log(`assistant: choosing notes for a turn failed: ${error instanceof Error ? error.message : String(error)}`);
      return { done: { ...nothing, captured } };
    }
  }

  /** The second half: the notes for the question (by meaning too when `meaning` is given), and the block they make. */
  private finishTurn(input: TurnInput, begun: Pending, meaning: MeaningOptions | null): PreparedTurn {
    const { profile, captured, queryText, followUpText, asOf } = begun;
    try {
      let out = this.context(input, queryText, profile, asOf, meaning);
      // A short message that found nothing of its own may be a follow-up ("yes, do that"): it is looked up again with the question before it.
      if (followUpText !== null && !foundByQuery(out)) out = this.context(input, followUpText, profile, asOf, meaning);
      const goals = this.store.activeGoals();
      const inject = out.memories.length > 0 || out.noEvidence || hasIdentity(profile, goals);
      const used = out.memories.map((m) => m.item.id);
      if (used.length > 0) this.store.noteUsed(input.sessionId, used);
      this.lastUsed.set(input.sessionId, { at: this.now(), memoryIds: used, tokens: inject ? out.tokens : 0, noEvidence: out.noEvidence, omitted: out.omitted.length });
      if (this.lastUsed.size > 100) this.lastUsed.delete(this.lastUsed.keys().next().value as string);
      return { prefix: inject ? out.text : null, captured, used, tokens: inject ? out.tokens : 0 };
    } catch (error) {
      this.deps.log(`assistant: choosing notes for a turn failed: ${error instanceof Error ? error.message : String(error)}`);
      return { prefix: null, captured, used: [], tokens: 0 };
    }
  }

  private lastContextCacheHit = false;

  get wasLastContextCacheHit(): boolean {
    return this.lastContextCacheHit;
  }

  private context(input: TurnInput, queryText: string, profile: AssistantProfile, asOf: number | null, meaning: MeaningOptions | null): AssembledContext & { epoch: number } {
    const epoch = this.store.epoch();
    // A block made with meaning depends on which vectors existed then, so it is keyed by that too.
    const by = meaning ? `${meaning.model}:${meaning.bar}:${meaning.floor}:${meaning.gap}:${meaning.most}:${this.vectorEpoch}` : "";
    const key = [epoch, input.sessionId, input.project ?? "", input.account ?? "", profile.contextBudgetTokens, asOf ?? "", digest(queryText), by].join("|");
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.epoch === epoch && now - hit.at < CACHE_TTL_MS) {
      this.lastContextCacheHit = true;
      return hit.out;
    }
    this.lastContextCacheHit = false;
    const query = {
      text: queryText,
      thread: input.sessionId,
      ...(input.project ? { project: input.project } : {}),
      ...(input.account ? { account: input.account } : {}),
      budgetTokens: profile.contextBudgetTokens,
      now,
      ...(asOf !== null ? { asOf } : {}),
    };
    const out = meaning ? this.store.retrieveWith(query, withMeaningVectors(this.store, meaning)) : this.store.retrieve(query);
    this.cache.set(key, { at: now, epoch, out });
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    return out;
  }

  /** What the model would be told for this question, without sending anything: so the user can see it. Words only; see `previewAsync`. */
  preview(input: TurnInput): AssembledContext & { epoch: number; wouldAdd: boolean; prefix: string | null; cacheHit: boolean } {
    const previous = this.lastQuery.get(input.sessionId) ?? "";
    const withPrevious = `${input.text} ${previous}`;
    const followUpText = words(input.text) < SHORT_QUESTION_WORDS && previous ? withPrevious : null;
    return this.previewWith(input, null, followUpText);
  }

  /** `preview`, with meaning search when it is set up: what a turn would really be told, without mutating SQLite or `lastQuery`. */
  async previewAsync(
    input: TurnInput,
    options: { timeoutMs?: number } = {},
  ): Promise<AssembledContext & { epoch: number; wouldAdd: boolean; prefix: string | null; cacheHit: boolean }> {
    const previous = this.lastQuery.get(input.sessionId) ?? "";
    const withPrevious = `${input.text} ${previous}`;
    const followUpText = words(input.text) < SHORT_QUESTION_WORDS && previous ? withPrevious : null;
    const meaningText = totalWords(input.text) <= MEANING_FOLLOW_UP_WORDS && previous ? withPrevious : input.text;
    return this.previewWith(input, await this.meaningFor(meaningText, options.timeoutMs ?? MEANING_TIMEOUT_MS), followUpText);
  }

  private previewWith(
    input: TurnInput,
    meaning: MeaningOptions | null,
    followUpText: string | null = null,
  ): AssembledContext & { epoch: number; wouldAdd: boolean; prefix: string | null; cacheHit: boolean } {
    const profile = this.store.getProfile();
    const asOf = isPastQuestion(input.text) ? parseAsOf(input.text, this.now(), this.deps.offsetMinutes ? this.deps.offsetMinutes() : 0) : null;
    let out = this.context(input, input.text, profile, asOf, meaning);
    let cacheHit = this.lastContextCacheHit;
    if (followUpText !== null && !foundByQuery(out)) {
      out = this.context(input, followUpText, profile, asOf, meaning);
      cacheHit = cacheHit && this.lastContextCacheHit;
    }
    const inject = profile.enabled && (out.memories.length > 0 || out.noEvidence || hasIdentity(profile, this.store.activeGoals()));
    return { ...out, wouldAdd: inject, prefix: inject ? out.text : null, cacheHit };
  }

  // ------------------------------------------------------------------------------------------------ meaning search

  /**
   * The question's vector, when meaning search is on and can answer in time; null when it is off, down, slow, or has
   * nothing indexed yet (the words alone then decide). What is said goes to the address the user named for this and to
   * nowhere else, and a message that looks like a secret is not sent at all.
   */
  private async meaningFor(text: string, timeoutMs: number): Promise<MeaningOptions | null> {
    const emb = this.embedding;
    if (!emb || this.isClosed || this.now() < this.embedPausedUntil || looksSecret(text) !== null) return null;
    const model = emb.embedder.id;
    try {
      // Nothing to compare with yet: the question is not worth a request.
      if (!this.store.hasVectors(model)) return null;
    } catch {
      return null;
    }
    const options = (queryVector: Float32Array): MeaningOptions => ({
      model,
      queryVector,
      bar: emb.settings.minCosine,
      floor: emb.settings.standoutCosine ?? Infinity,
      gap: emb.settings.standoutLead,
      most: emb.settings.most,
    });
    const key = `${model}|${digest(text)}`;
    const known = this.queryVectors.get(key);
    if (known) return options(known);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const vector = await emb.embedder.query(text, controller.signal);
      // Meaning search was changed or switched off while this was in flight: that answer is about something else.
      if (this.embedding !== emb) return null;
      this.queryVectors.set(key, vector);
      if (this.queryVectors.size > QUERY_VECTOR_LIMIT) this.queryVectors.delete(this.queryVectors.keys().next().value as string);
      this.embedFailures = 0;
      this.lastEmbedError = null;
      return options(vector);
    } catch (error) {
      this.embeddingFailed(controller.signal.aborted ? new Error("the embedding server did not answer in time") : error, emb);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A server that does not answer is left alone for a while, longer each time, so no turn waits on it again and again. */
  private embeddingFailed(error: unknown, emb: { settings: EmbeddingSettings; embedder: Embedder }): void {
    if (this.embedding !== emb) return;
    const reason = error instanceof Error ? error.message : String(error);
    this.lastEmbedError = reason;
    // A request the server refused is about that text, not about the server being there.
    if (error instanceof EmbeddingRejected) return;
    this.embedFailures += 1;
    const wait = Math.min(5 * 60_000, 15_000 * 2 ** (this.embedFailures - 1));
    this.embedPausedUntil = this.now() + wait;
    if (this.embedFailures === 1) this.deps.log(`assistant: meaning search is paused for ${Math.round(wait / 1000)} s, and turns go on with words alone: ${reason}`);
  }

  /** Looks soon for notes that have no vector, unless that is already planned; a server that failed is not asked before its pause is over. */
  private kickIndex(delayMs = 300): void {
    if (!this.embedding || this.isClosed || this.indexTimer) return;
    const wait = Math.max(delayMs, this.embedPausedUntil - this.now());
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.indexSome();
    }, wait);
    this.indexTimer.unref?.();
  }

  /**
   * Gives every note that has no vector one, a few at a time: a note said a moment ago can be found by meaning a moment
   * later. It stops at once if meaning search is changed or switched off, and never throws.
   */
  async indexSome(): Promise<void> {
    const emb = this.embedding;
    if (!emb || this.isClosed) return;
    if (this.indexing) {
      // A note arrived while a pass was running: that pass may have looked already, so another follows it.
      this.indexAgain = true;
      return;
    }
    if (this.now() < this.embedPausedUntil) {
      this.kickIndex();
      return;
    }
    this.indexing = true;
    /** The pass ended with work left (it was long), or failed: it is looked at again. */
    let again = false;
    let failed = false;
    try {
      const model = emb.embedder.id;
      // A note that was replaced keeps no vector: nothing asks for it, and it is derived data.
      if (this.store.pruneVectors() > 0) this.vectorEpoch += 1;
      for (let round = 0; round < INDEX_ROUNDS; round += 1) {
        if (this.embedding !== emb || this.isClosed) return;
        const wanted = this.store
          .itemsNeedingVectors(model, INDEX_BATCH + this.unembeddable.size)
          .filter((note) => !this.unembeddable.has(`${note.id}|${digest(note.text)}`))
          .slice(0, INDEX_BATCH);
        if (wanted.length === 0) return;
        const vectors = await this.embedNotes(emb, wanted);
        if (this.embedding !== emb || this.isClosed) return;
        let wrote = false;
        wanted.forEach((note, i) => {
          const vector = vectors[i];
          // A note that was edited or forgotten while its vector was being made gets none: the vector would be of other words.
          if (vector && this.store.putVector(note.id, model, vector, note.text)) wrote = true;
        });
        if (wrote) this.vectorEpoch += 1;
        this.embedFailures = 0;
        this.lastEmbedError = null;
        again = round === INDEX_ROUNDS - 1;
      }
    } catch (error) {
      this.embeddingFailed(error, emb);
      failed = true;
    } finally {
      this.indexing = false;
      const arrived = this.indexAgain;
      this.indexAgain = false;
      if (failed || again || arrived) this.kickIndex(failed ? 1000 : 100);
    }
  }

  /** The vectors of some notes. When the server refuses a batch it is because of one of them: find it, leave it to the words, and read the rest. */
  private async embedNotes(emb: { embedder: Embedder }, notes: readonly { id: string; text: string }[]): Promise<(Float32Array | null)[]> {
    const skip = (note: { id: string; text: string }): null => {
      this.unembeddable.add(`${note.id}|${digest(note.text)}`);
      return null;
    };
    try {
      return await emb.embedder.embed(notes.map((n) => n.text));
    } catch (error) {
      if (!(error instanceof EmbeddingRejected)) throw error;
      if (notes.length === 1) return [skip(notes[0] as { id: string; text: string })];
      const out: (Float32Array | null)[] = [];
      for (const note of notes) {
        try {
          out.push((await emb.embedder.embed([note.text]))[0] ?? null);
        } catch (inner) {
          if (!(inner instanceof EmbeddingRejected)) throw inner;
          out.push(skip(note));
        }
      }
      return out;
    }
  }

  /** What meaning search is set to now, or null when it is off. */
  embeddingSettings(): EmbeddingSettings | null {
    return this.embedding ? { ...this.embedding.settings } : null;
  }

  /** How meaning search stands, for the page: what is set, how many notes can be found by meaning, whether the server is answering. */
  embeddingStatus(): EmbeddingStatus {
    const emb = this.embedding;
    if (!emb) return { ...NO_EMBEDDING };
    const s = emb.settings;
    const stats = this.store.vectorStats(emb.embedder.id);
    return {
      configured: true,
      baseUrl: s.baseUrl,
      model: s.model,
      queryPrefix: s.queryPrefix,
      apiKeyEnv: s.apiKeyEnv,
      keyPresent: keyIsSet(s),
      minCosine: s.minCosine,
      standoutCosine: s.standoutCosine,
      standoutLead: s.standoutLead,
      most: s.most,
      indexed: stats.indexed,
      pending: Math.max(0, stats.pending - this.unembeddable.size),
      skipped: this.unembeddable.size,
      paused: this.now() < this.embedPausedUntil,
      error: this.lastEmbedError,
    };
  }

  /**
   * Switches meaning search on, changes it, or (with null) off. Vectors made by another model are erased now, and all of
   * them when it is switched off: a vector can be turned back into much of the words it came from. The settings are kept
   * in the data folder so that they outlast a restart.
   */
  configureEmbeddings(settings: EmbeddingSettings | null, embedder?: Embedder): void {
    const next = settings ? { settings, embedder: embedder ?? embedderFor(settings) } : null;
    this.embedding = next;
    if (next) this.store.dropVectors(next.embedder.id);
    else this.store.dropVectors();
    this.vectorEpoch += 1;
    this.embedFailures = 0;
    this.embedPausedUntil = 0;
    this.lastEmbedError = null;
    this.unembeddable.clear();
    this.queryVectors.clear();
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    if (this.deps.dataDir) writeEmbeddingSettings(this.deps.dataDir, settings);
    this.invalidate();
    if (next) this.kickIndex(0);
  }

  /** The notes the last turn of a thread drew on, for the "used N notes" line under it. */
  lastContext(sessionId: string): UsedContext | null {
    return this.lastUsed.get(sessionId) ?? null;
  }
}
