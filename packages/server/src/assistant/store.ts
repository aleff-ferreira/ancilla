import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { assembleContext } from "./context.js";
import { extractCandidates, type ExtractContext } from "./extract.js";
import { ASSISTANT_ID, DEFAULT_PROFILE, applyProfilePatch, normalizeProfile, parseGoalInput, parseProfilePatch, ValidationError, type ProfilePatch } from "./profile.js";
import { asksAboutMemory, asksForEverything, rankMemories, scopeKey, visibleScopes, type Hit } from "./rank.js";
import { resolve, type Resolution } from "./resolve.js";
import { FTS_DDL, LATEST_VERSION, migrate, schemaVersion } from "./schema.js";
import { looksSecret } from "./secrets.js";
import { STOPWORDS, containment, digest, identifiersOf, squash, tokenSet } from "./text.js";
import {
  GLOBAL,
  type AssembledContext,
  type AssistantProfile,
  type Basis,
  type Candidate,
  type Goal,
  type MemoryDetail,
  type MemoryItem,
  type MemoryKind,
  type MemoryRevision,
  type MemoryStatus,
  type RetrievalQuery,
  type Scope,
  type SourceInput,
  type SourceRecord,
  type Trust,
} from "./types.js";

/**
 * The assistant's durable memory: one SQLite file, written only inside transactions, read through a full text
 * index plus a few always-on sets. This module owns every rule about what may change and when:
 *
 *  - a write is confirmed to the caller only after COMMIT, and a statement that was read twice (same source key)
 *    changes nothing the second time;
 *  - what the user said never loses to a guess, an older statement never replaces a newer one, and every change
 *    keeps the old belief as history instead of overwriting it;
 *  - erasing removes the words from every table that held them (revisions, sources, the index, summaries, the
 *    free pages of the file) and leaves a salted fingerprint, so the same old words cannot come back through
 *    re-ingestion while a fresh statement by the user still can;
 *  - an edit made on a stale view is refused, and two connections to one file serialise on the write lock.
 */

export type Row = Record<string, unknown>;
export type Param = string | number | null;

export class ConflictError extends Error {
  readonly code = "conflict";
  constructor(message: string, readonly detail: { current?: number; duplicateOf?: string } = {}) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  readonly code = "not_found";
  constructor(what: string) {
    super(`${what} was not found`);
    this.name = "NotFoundError";
  }
}

export { ValidationError };

export type Change =
  | { type: "created"; id: string; kind: MemoryKind; text: string; status: MemoryStatus; supersedes: string[]; rule: string }
  | { type: "corroborated"; id: string }
  | { type: "history"; id: string; newerHead: string }
  | { type: "forgotten"; ids: string[] }
  | { type: "nothing-to-forget"; about: string }
  | { type: "ambiguous"; reason: string; about: string; options: { id: string; text: string }[]; pendingId?: string }
  | { type: "suppressed"; reason: string; text: string };

export interface CaptureInput {
  message: string;
  ctx: Omit<ExtractContext, "now" | "lastCapturedText"> & { now?: number };
  /** One message, one key: a message read twice changes nothing the second time. */
  sourceKey?: string;
}

export interface CaptureResult {
  /** True only when something was written and committed. Nothing may be confirmed to the user unless this is true. */
  durable: boolean;
  skipped?: "disabled" | "not-user" | "duplicate-source" | "before-floor";
  changes: Change[];
  epoch: number;
}

export interface RememberInput {
  text: string;
  kind?: MemoryKind;
  scope?: Scope;
  pinned?: boolean;
  dueAt?: number;
  validTo?: number;
}

export interface EditPatch {
  text?: string;
  kind?: MemoryKind;
  pinned?: boolean;
  dueAt?: number | null;
  validTo?: number | null;
}

export interface ListFilter {
  status?: MemoryStatus | "attention" | "history" | "all";
  kind?: MemoryKind;
  /** `scopeKey` form: `global:`, `project:/work/atlas`. */
  scope?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface RetrieveInput {
  text: string;
  account?: string;
  project?: string;
  thread?: string;
  now?: number;
  budgetTokens?: number;
  history?: boolean;
  /** A question about a past moment: what existed then is what is eligible. */
  asOf?: number;
  limit?: number;
}

export interface StoreStats {
  schemaVersion: number;
  ftsEnabled: boolean;
  epoch: number;
  items: Record<MemoryStatus, number>;
  kinds: Record<string, number>;
  revisions: number;
  sources: number;
  tombstones: number;
  bytes: number;
}

/** The history the user and the assistant share, read off what is stored. It carries no word of any note. */
export interface Bond {
  /** When the assistant was first switched on, or failing that the oldest thing it holds; null when there is no history yet. */
  since: number | null;
  daysTogether: number;
  /** Notes it holds now (current and disputed). */
  remembered: number;
  /** Beliefs that were changed, each kept as history. */
  replaced: number;
  /** Tasks that ended with a check that passed. */
  finished: number;
  /** Tasks that ended without a check. */
  unchecked: number;
  /** Round numbers and anniversaries, oldest first: `first-note`, `notes-10`, `first-change`, `first-task`, `week`... */
  milestones: { id: string; at: number }[];
}

export const EMPTY_BOND: Bond = { since: null, daysTogether: 0, remembered: 0, replaced: 0, finished: 0, unchecked: 0, milestones: [] };

export interface StoreOptions {
  /** The clock for created and updated times; tests and the simulated months of the evaluation set it. */
  now?: () => number;
  /** Turn the full text index off (a build of SQLite without FTS5, or a test of the fallback). */
  fts?: boolean;
  /** How long to wait for another connection's write, in milliseconds. */
  busyTimeoutMs?: number;
}

const MAX_TEXT = 2000;
const MIN_TEXT = 3;
const RECENT_MS = 6 * 3_600_000;
const ERASED = "‹erased›";

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toItem(r: Row): MemoryItem {
  return {
    id: String(r.id),
    assistantId: String(r.assistant_id),
    kind: r.kind as MemoryKind,
    scope: { kind: r.scope_kind as Scope["kind"], key: String(r.scope_key) },
    status: r.status as MemoryStatus,
    slot: r.slot === null || r.slot === undefined ? null : String(r.slot),
    pinned: Number(r.pinned) === 1,
    text: String(r.text),
    basis: r.basis as Basis,
    confidence: Number(r.confidence),
    observedAt: Number(r.observed_at),
    validFrom: numOrNull(r.valid_from),
    validTo: numOrNull(r.valid_to),
    dueAt: numOrNull(r.due_at),
    commitment: (r.commitment ?? null) as MemoryItem["commitment"],
    revalidateAfterMs: numOrNull(r.revalidate_after_ms),
    lastConfirmedAt: Number(r.last_confirmed_at),
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : String(r.superseded_by),
    rev: Number(r.rev),
    identifiers: JSON.parse(String(r.identifiers)) as string[],
    digest: String(r.digest ?? ""),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toSource(r: Row): SourceRecord {
  return {
    id: String(r.id),
    kind: r.kind as SourceRecord["kind"],
    ...(r.session_id ? { sessionId: String(r.session_id) } : {}),
    ...(r.item_ref ? { itemId: String(r.item_ref) } : {}),
    ...(r.turn_id ? { turnId: String(r.turn_id) } : {}),
    excerpt: String(r.excerpt),
    observedAt: Number(r.observed_at),
    trust: r.trust as Trust,
    digest: String(r.digest),
  };
}

function toRevision(r: Row): MemoryRevision {
  return {
    rev: Number(r.rev),
    text: String(r.text),
    basis: r.basis as Basis,
    confidence: Number(r.confidence),
    observedAt: Number(r.observed_at),
    validFrom: numOrNull(r.valid_from),
    validTo: numOrNull(r.valid_to),
    dueAt: numOrNull(r.due_at),
    revalidateAfterMs: numOrNull(r.revalidate_after_ms),
    sourceIds: JSON.parse(String(r.source_ids)) as string[],
    actor: r.actor as MemoryRevision["actor"],
    reason: String(r.reason),
    createdAt: Number(r.created_at),
  };
}

function toGoal(r: Row): Goal {
  return { id: String(r.id), text: String(r.text), priority: Number(r.priority), status: r.status as Goal["status"], createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

/** The words a question is searched by: letters and digits, no filler, no duplicates. */
function queryWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 2 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 24) break;
  }
  return out;
}

const WHY = /\bwhy do you (?:think|believe|know|say)\b|\bhow do you know\b|\bwhere did you (?:get|learn|read)\b|\bwhat(?:'s| is) your (?:source|evidence)\b|\bsource for\b|\bprove it\b/i;

export class MemoryStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private fts: boolean;
  private depth = 0;
  private readonly statements = new Map<string, StatementSync>();
  private salt = "";

  private constructor(path: string, db: DatabaseSync, options: StoreOptions) {
    this.path = path;
    this.db = db;
    this.clock = options.now ?? Date.now;
    this.fts = options.fts !== false;
  }

  // ------------------------------------------------------------------------------------------------ open and close

  static open(path = ":memory:", options: StoreOptions = {}): MemoryStore {
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5000)}`);
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    // FULL: a memory the user was told is saved has reached the disk. Writes are rare, so the cost does not matter.
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    // Erased pages are overwritten, not just unlinked, so a deleted sentence is not sitting in the file.
    db.exec("PRAGMA secure_delete = ON");
    const store = new MemoryStore(path, db, options);
    try {
      migrate(db);
      store.setUpIndex();
      store.setUpMeta();
    } catch (error) {
      try {
        db.close();
      } catch {
        /* nothing more to do */
      }
      throw error;
    }
    return store;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  get ftsEnabled(): boolean {
    return this.fts;
  }

  now(): number {
    return this.clock();
  }

  private setUpIndex(): void {
    if (!this.fts) return;
    try {
      this.db.exec(FTS_DDL);
    } catch {
      this.fts = false;
      return;
    }
    const items = Number(this.get("SELECT COUNT(*) AS n FROM memory_items WHERE status != 'deleted'")?.n ?? 0);
    const rows = Number(this.get("SELECT COUNT(*) AS n FROM memory_fts")?.n ?? 0);
    if (items !== rows) this.rebuildIndex();
  }

  private setUpMeta(): void {
    this.write(() => {
      this.run("INSERT OR IGNORE INTO assistant_meta (key, value) VALUES ('salt', ?)", [randomBytes(16).toString("hex")]);
      this.run("INSERT OR IGNORE INTO assistant_meta (key, value) VALUES ('epoch', '0')");
      this.run("INSERT OR IGNORE INTO assistant_profile (id, json, updated_at) VALUES (?, ?, 0)", [ASSISTANT_ID, JSON.stringify(DEFAULT_PROFILE)]);
    });
    this.salt = String(this.getMeta("salt"));
  }

  // ------------------------------------------------------------------------------------------------ plumbing

  private prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  // run, get, all and write are the store's SQL surface; the task store, which lives in the same file, shares them so
  // that one transaction can cover a memory and a task, and one busy timeout and one lock serve both.
  run(sql: string, params: Param[] = []): void {
    this.prepared(sql).run(...params);
  }

  get(sql: string, params: Param[] = []): Row | undefined {
    return this.prepared(sql).get(...params) as Row | undefined;
  }

  all(sql: string, params: Param[] = []): Row[] {
    return this.prepared(sql).all(...params) as Row[];
  }

  /** Runs `fn` in one write transaction (nested calls join the outer one). COMMIT is the only way a change becomes real. */
  write<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* SQLite already ended the transaction */
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  getMeta(key: string): string | null {
    const row = this.get("SELECT value FROM assistant_meta WHERE key = ?", [key]);
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.run("INSERT INTO assistant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  /** Moves every time something a cache could hold has changed. */
  private bump(): void {
    this.run("UPDATE assistant_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'epoch'");
  }

  epoch(): number {
    return Number(this.getMeta("epoch") ?? 0);
  }

  private audit(action: string, itemId: string | null, actor: string, detail = ""): void {
    this.run("INSERT INTO memory_audit (at, item_id, action, actor, detail) VALUES (?, ?, ?, ?, ?)", [this.now(), itemId, action, actor, detail.slice(0, 200)]);
  }

  /** What a tombstone stores in place of erased words: salted, and bound to the scope the words were said in. */
  private fp(text: string, scope: Scope): string {
    return createHmac("sha256", this.salt).update(`${scopeKey(scope)}\u0000${digest(text)}`).digest("hex").slice(0, 32);
  }

  // ------------------------------------------------------------------------------------------------ the index

  private indexText(text: string, slot: string | null): string {
    return slot ? `${text} ${slot.replace(/[._]+/g, " ")}` : text;
  }

  private indexItem(itemId: string, text: string, slot: string | null): void {
    if (!this.fts) return;
    this.run("DELETE FROM memory_fts WHERE ref = ?", [itemId]);
    this.run("INSERT INTO memory_fts (ref, text) VALUES (?, ?)", [itemId, this.indexText(text, slot)]);
  }

  private unindexItem(itemId: string): void {
    if (this.fts) this.run("DELETE FROM memory_fts WHERE ref = ?", [itemId]);
  }

  /** Drops the text index and builds it again from the items: the index is derived, and the items are the truth. */
  rebuildIndex(): void {
    if (!this.fts) return;
    this.write(() => {
      this.run("DELETE FROM memory_fts");
      for (const row of this.all("SELECT id, text, slot FROM memory_items WHERE status != 'deleted'")) {
        this.run("INSERT INTO memory_fts (ref, text) VALUES (?, ?)", [String(row.id), this.indexText(String(row.text), row.slot === null ? null : String(row.slot))]);
      }
    });
  }

  // ------------------------------------------------------------------------------------------------ profile and goals

  getProfile(): AssistantProfile {
    const row = this.get("SELECT json, updated_at FROM assistant_profile WHERE id = ?", [ASSISTANT_ID]);
    let raw: unknown = {};
    try {
      raw = JSON.parse(String(row?.json ?? "{}"));
    } catch {
      raw = {};
    }
    return normalizeProfile({ ...(raw as object), updatedAt: Number(row?.updated_at ?? 0) });
  }

  /** `expectedUpdatedAt` is the `updatedAt` of the profile the caller was looking at: a change made on a stale view is refused. */
  saveProfile(rawPatch: unknown, expectedUpdatedAt?: number): AssistantProfile {
    const patch: ProfilePatch = parseProfilePatch(rawPatch);
    return this.write(() => {
      const current = this.getProfile();
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== current.updatedAt) throw new ConflictError("The settings changed since you opened them.", { current: current.updatedAt });
      const now = this.now();
      const next = applyProfilePatch(current, patch, Math.max(now, current.updatedAt + 1));
      this.run("UPDATE assistant_profile SET json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(next), next.updatedAt, ASSISTANT_ID]);
      // Words said while capture was off, or before the assistant was switched on, are not read when it comes back.
      if ((current.capturePaused && !next.capturePaused) || (!current.enabled && next.enabled)) this.setMeta("capture_floor", String(now));
      // The day it was first switched on is where the shared history starts, and it stays when it is switched off and on.
      if (!current.enabled && next.enabled && this.getMeta("enabled_first_at") === null) this.setMeta("enabled_first_at", String(now));
      this.audit("profile", null, "user", Object.keys(patch).join(","));
      this.bump();
      return next;
    });
  }

  listGoals(): Goal[] {
    return this.all("SELECT * FROM assistant_goals ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, priority DESC, created_at").map(toGoal);
  }

  activeGoals(): Goal[] {
    return this.listGoals().filter((g) => g.status === "active");
  }

  addGoal(raw: unknown): Goal {
    const input = parseGoalInput(raw);
    return this.write(() => {
      const now = this.now();
      const goal: Goal = { id: id("g"), text: input.text as string, priority: input.priority ?? 50, status: input.status ?? "active", createdAt: now, updatedAt: now };
      this.run("INSERT INTO assistant_goals (id, text, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [goal.id, goal.text, goal.priority, goal.status, now, now]);
      this.audit("goal.add", goal.id, "user");
      this.bump();
      return goal;
    });
  }

  updateGoal(goalId: string, raw: unknown): Goal {
    const patch = parseGoalInput(raw, true);
    return this.write(() => {
      const row = this.get("SELECT * FROM assistant_goals WHERE id = ?", [goalId]);
      if (!row) throw new NotFoundError("The goal");
      const cur = toGoal(row);
      const next: Goal = { ...cur, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.priority !== undefined ? { priority: patch.priority } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}), updatedAt: this.now() };
      this.run("UPDATE assistant_goals SET text = ?, priority = ?, status = ?, updated_at = ? WHERE id = ?", [next.text, next.priority, next.status, next.updatedAt, goalId]);
      this.audit("goal.update", goalId, "user");
      this.bump();
      return next;
    });
  }

  removeGoal(goalId: string): void {
    this.write(() => {
      const row = this.get("SELECT id FROM assistant_goals WHERE id = ?", [goalId]);
      if (!row) throw new NotFoundError("The goal");
      this.run("DELETE FROM assistant_goals WHERE id = ?", [goalId]);
      this.audit("goal.remove", goalId, "user");
      this.bump();
    });
  }

  // ------------------------------------------------------------------------------------------------ reading items

  private itemRow(itemId: string): Row | undefined {
    return this.get("SELECT * FROM memory_items WHERE id = ? AND assistant_id = ?", [itemId, ASSISTANT_ID]);
  }

  getItem(itemId: string): MemoryItem | null {
    const row = this.itemRow(itemId);
    return row ? toItem(row) : null;
  }

  private itemsIn(scopes: readonly Scope[], statuses: readonly MemoryStatus[], limit = 3000): MemoryItem[] {
    const keys = scopes.map(scopeKey);
    if (keys.length === 0 || statuses.length === 0) return [];
    const sql = `SELECT * FROM memory_items WHERE assistant_id = ? AND status IN (${statuses.map(() => "?").join(",")}) AND (scope_kind || ':' || scope_key) IN (${keys.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT ${Math.max(1, limit)}`;
    return this.all(sql, [ASSISTANT_ID, ...statuses, ...keys]).map(toItem);
  }

  detail(itemId: string): MemoryDetail {
    const row = this.itemRow(itemId);
    if (!row || row.status === "deleted") throw new NotFoundError("The memory");
    const item = toItem(row);
    const revisions = this.all("SELECT * FROM memory_revisions WHERE item_id = ? ORDER BY rev DESC", [itemId]).map(toRevision);
    const sources = this.all("SELECT s.* FROM memory_sources s JOIN memory_evidence e ON e.source_id = s.id WHERE e.item_id = ? ORDER BY s.observed_at DESC", [itemId]).map(toSource);
    const lineage = this.all(
      `SELECT i.id, i.text, i.status, i.observed_at FROM memory_items i
       WHERE i.status != 'deleted' AND i.id IN (SELECT to_id FROM memory_links WHERE from_id = ? AND kind = 'supersedes' UNION SELECT from_id FROM memory_links WHERE to_id = ? AND kind = 'supersedes')
       ORDER BY i.observed_at DESC`,
      [itemId, itemId],
    ).map((r) => ({ id: String(r.id), text: String(r.text), status: r.status as MemoryStatus, observedAt: Number(r.observed_at) }));
    const mayCorrect = this.all("SELECT i.id, i.text FROM memory_links l JOIN memory_items i ON i.id = l.to_id WHERE l.from_id = ? AND l.kind = 'may-correct' AND i.status NOT IN ('deleted','superseded')", [itemId]).map((r) => ({ id: String(r.id), text: String(r.text) }));
    return { item, revisions, sources, lineage, mayCorrect };
  }

  list(filter: ListFilter = {}): { items: MemoryItem[]; total: number } {
    const where = ["i.assistant_id = ?", "i.status != 'deleted'"];
    const params: Param[] = [ASSISTANT_ID];
    const status = filter.status;
    if (status === "attention") where.push("i.status IN ('contested','pending')");
    else if (status === "history") where.push("i.status = 'superseded'");
    else if (status === "all") where.push("1 = 1");
    else if (status) {
      where.push("i.status = ?");
      params.push(status);
    } else where.push("i.status IN ('active','contested','pending')");
    if (filter.kind) {
      where.push("i.kind = ?");
      params.push(filter.kind);
    }
    if (filter.scope) {
      where.push("(i.scope_kind || ':' || i.scope_key) = ?");
      params.push(filter.scope);
    }
    const words = filter.q ? queryWords(filter.q) : [];
    if (words.length > 0) {
      const ids = this.textSearch(words, null, true, 200).map((h) => h.id);
      if (ids.length === 0) return { items: [], total: 0 };
      where.push(`i.id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
    const whereSql = where.join(" AND ");
    const total = Number(this.get(`SELECT COUNT(*) AS n FROM memory_items i WHERE ${whereSql}`, params)?.n ?? 0);
    const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 50)));
    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    const rows = this.all(`SELECT i.* FROM memory_items i WHERE ${whereSql} ORDER BY i.pinned DESC, i.updated_at DESC, i.id LIMIT ${limit} OFFSET ${offset}`, params);
    return { items: rows.map(toItem), total };
  }

  /** What changed lately and who changed it, newest first. It holds ids and rule names, never the words of a memory. */
  activity(limit = 50): { id: number; at: number; itemId: string | null; action: string; actor: string; detail: string }[] {
    return this.all("SELECT id, at, item_id, action, actor, detail FROM memory_audit ORDER BY id DESC LIMIT ?", [Math.min(500, Math.max(1, Math.floor(limit)))]).map((r) => ({
      id: Number(r.id), at: Number(r.at), itemId: r.item_id === null ? null : String(r.item_id), action: String(r.action), actor: String(r.actor), detail: String(r.detail),
    }));
  }

  /**
   * The history the user and the assistant share, as facts read off what is stored: since when, how much it remembers,
   * how many beliefs were changed, how many tasks it finished, and the dates of a few round numbers. It holds no words
   * of any note, so it can be shown anywhere. Nothing here is a score, and nothing counts days missed.
   */
  bond(now = this.now()): Bond {
    const DAY = 86_400_000;
    const value = (sql: string, params: Param[] = []): number | null => {
      const row = this.get(sql, params);
      return row && row.v !== null && row.v !== undefined ? Number(row.v) : null;
    };
    const first = Number(this.getMeta("enabled_first_at") ?? 0) || null;
    const others = [value("SELECT MIN(created_at) AS v FROM memory_items WHERE assistant_id = ? AND status != 'deleted'", [ASSISTANT_ID]), value("SELECT MIN(created_at) AS v FROM tasks")].filter((v): v is number => v !== null);
    const since = first ?? (others.length > 0 ? Math.min(...others) : null);
    const milestones: { id: string; at: number }[] = [];
    const nthNote = (n: number): number | null => value("SELECT created_at AS v FROM memory_items WHERE assistant_id = ? AND status != 'deleted' ORDER BY created_at, rowid LIMIT 1 OFFSET ?", [ASSISTANT_ID, n - 1]);
    const nthDone = (n: number): number | null => value("SELECT finished_at AS v FROM tasks WHERE status = 'completed' AND finished_at IS NOT NULL ORDER BY finished_at, rowid LIMIT 1 OFFSET ?", [n - 1]);
    const note = nthNote(1);
    if (note !== null) milestones.push({ id: "first-note", at: note });
    for (const n of [10, 50, 100]) {
      const at = nthNote(n);
      if (at !== null) milestones.push({ id: `notes-${n}`, at });
    }
    const changed = value("SELECT MIN(updated_at) AS v FROM memory_items WHERE assistant_id = ? AND status = 'superseded'", [ASSISTANT_ID]);
    if (changed !== null) milestones.push({ id: "first-change", at: changed });
    const task = nthDone(1);
    if (task !== null) milestones.push({ id: "first-task", at: task });
    const tenth = nthDone(10);
    if (tenth !== null) milestones.push({ id: "tasks-10", at: tenth });
    if (since !== null) {
      for (const [id, days] of [["week", 7], ["month", 30], ["quarter", 90]] as const) {
        if (now - since >= days * DAY) milestones.push({ id, at: since + days * DAY });
      }
    }
    milestones.sort((a, b) => a.at - b.at);
    const count = (sql: string): number => value(sql) ?? 0;
    return {
      since,
      daysTogether: since === null ? 0 : Math.max(0, Math.floor((now - since) / DAY)),
      remembered: count(`SELECT COUNT(*) AS v FROM memory_items WHERE assistant_id = '${ASSISTANT_ID}' AND status IN ('active','contested')`),
      replaced: count(`SELECT COUNT(*) AS v FROM memory_items WHERE assistant_id = '${ASSISTANT_ID}' AND status = 'superseded'`),
      finished: count("SELECT COUNT(*) AS v FROM tasks WHERE status = 'completed'"),
      unchecked: count("SELECT COUNT(*) AS v FROM tasks WHERE status = 'unverified'"),
      milestones,
    };
  }

  stats(): StoreStats {
    const items: Record<MemoryStatus, number> = { active: 0, superseded: 0, contested: 0, pending: 0, deleted: 0 };
    for (const r of this.all("SELECT status, COUNT(*) AS n FROM memory_items WHERE assistant_id = ? GROUP BY status", [ASSISTANT_ID])) items[r.status as MemoryStatus] = Number(r.n);
    const kinds: Record<string, number> = {};
    for (const r of this.all("SELECT kind, COUNT(*) AS n FROM memory_items WHERE assistant_id = ? AND status IN ('active','contested','pending') GROUP BY kind", [ASSISTANT_ID])) kinds[String(r.kind)] = Number(r.n);
    const pages = Number(this.get("PRAGMA page_count")?.page_count ?? 0);
    const size = Number(this.get("PRAGMA page_size")?.page_size ?? 0);
    return {
      schemaVersion: schemaVersion(this.db),
      ftsEnabled: this.fts,
      epoch: this.epoch(),
      items,
      kinds,
      revisions: Number(this.get("SELECT COUNT(*) AS n FROM memory_revisions")?.n ?? 0),
      sources: Number(this.get("SELECT COUNT(*) AS n FROM memory_sources")?.n ?? 0),
      tombstones: Number(this.get("SELECT COUNT(*) AS n FROM memory_tombstones")?.n ?? 0),
      bytes: pages * size,
    };
  }

  // ------------------------------------------------------------------------------------------------ writing items

  private insertItem(item: MemoryItem, itemDigest: string): void {
    const values: Param[] = [
      item.id, item.assistantId, item.kind, item.scope.kind, item.scope.key, item.status, item.slot, item.pinned ? 1 : 0, item.text, item.basis, item.confidence,
      item.observedAt, item.validFrom, item.validTo, item.dueAt, item.commitment, item.revalidateAfterMs, item.lastConfirmedAt, item.supersededBy, item.rev,
      JSON.stringify(item.identifiers), itemDigest, item.createdAt, item.updatedAt,
    ];
    this.run(
      `INSERT INTO memory_items (id, assistant_id, kind, scope_kind, scope_key, status, slot, pinned, text, basis, confidence, observed_at, valid_from, valid_to, due_at, commitment, revalidate_after_ms, last_confirmed_at, superseded_by, rev, identifiers, digest, created_at, updated_at) VALUES (${values.map(() => "?").join(",")})`,
      values,
    );
    this.indexItem(item.id, item.text, item.slot);
  }

  private insertRevision(item: MemoryItem, sourceIds: string[], actor: MemoryRevision["actor"], reason: string): void {
    this.run(
      "INSERT INTO memory_revisions (item_id, rev, text, basis, confidence, observed_at, valid_from, valid_to, due_at, revalidate_after_ms, source_ids, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [item.id, item.rev, item.text, item.basis, item.confidence, item.observedAt, item.validFrom, item.validTo, item.dueAt, item.revalidateAfterMs, JSON.stringify(sourceIds), actor, reason.slice(0, 200), this.now()],
    );
  }

  /** The words a statement was read from, kept exactly. The same words from the same message are one source, however many memories they feed. */
  private source(input: SourceInput): string {
    const excerpt = input.excerpt.slice(0, 600);
    const dg = digest(excerpt);
    const existing = this.get("SELECT id FROM memory_sources WHERE digest = ? AND observed_at = ? AND kind = ? AND COALESCE(session_id, '') = ? AND COALESCE(item_ref, '') = ?", [dg, input.observedAt, input.kind, input.sessionId ?? "", input.itemId ?? ""]);
    if (existing) return String(existing.id);
    const sourceId = id("s");
    this.run("INSERT INTO memory_sources (id, kind, session_id, item_ref, turn_id, excerpt, observed_at, trust, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      sourceId, input.kind, input.sessionId ?? null, input.itemId ?? null, input.turnId ?? null, excerpt, input.observedAt, input.trust, dg, this.now(),
    ]);
    return sourceId;
  }

  private link(from: string, to: string, kind: "supersedes" | "contests" | "may-correct"): void {
    this.run("INSERT OR IGNORE INTO memory_links (from_id, to_id, kind) VALUES (?, ?, ?)", [from, to, kind]);
  }

  private evidence(itemId: string, sourceId: string, rev: number): void {
    this.run("INSERT OR IGNORE INTO memory_evidence (item_id, source_id, rev) VALUES (?, ?, ?)", [itemId, sourceId, rev]);
  }

  private supersede(oldId: string, byId: string, at: number): void {
    this.run("UPDATE memory_items SET status = 'superseded', superseded_by = ?, valid_to = COALESCE(valid_to, ?), pinned = 0, rev = rev + 1, updated_at = ? WHERE id = ? AND status != 'deleted'", [byId, at, this.now(), oldId]);
    this.link(byId, oldId, "supersedes");
    this.audit("supersede", oldId, "capture", `by ${byId}`);
  }

  private newItem(c: Candidate, status: MemoryStatus, extra: { kind?: MemoryKind; slot?: string | null; pinned?: boolean; supersededBy?: string; validTo?: number | null } = {}): MemoryItem {
    const now = this.now();
    const kind = extra.kind ?? c.kind;
    const at = c.source.observedAt;
    return {
      id: id("m"),
      assistantId: ASSISTANT_ID,
      kind,
      scope: c.scope,
      status,
      slot: extra.slot === undefined ? (c.slot ?? null) : extra.slot,
      pinned: extra.pinned ?? false,
      text: squash(c.text).slice(0, MAX_TEXT),
      basis: c.basis,
      confidence: Math.max(0, Math.min(1, c.confidence)),
      observedAt: at,
      validFrom: c.validFrom ?? null,
      validTo: extra.validTo === undefined ? (c.validTo ?? null) : extra.validTo,
      dueAt: c.dueAt ?? null,
      commitment: kind === "commitment" ? "open" : null,
      revalidateAfterMs: c.revalidateAfterMs ?? null,
      lastConfirmedAt: at,
      supersededBy: extra.supersededBy ?? null,
      rev: 1,
      identifiers: c.identifiers.length > 0 ? c.identifiers : identifiersOf(c.text),
      createdAt: now,
      updatedAt: now,
    };
  }

  // ------------------------------------------------------------------------------------------------ capture

  private recentIds(thread: string | undefined, now: number): Set<string> {
    if (!thread) return new Set();
    const raw = this.getMeta(`recent:${thread}`);
    if (!raw) return new Set();
    try {
      const v = JSON.parse(raw) as { ids: string[]; at: number };
      return now - v.at <= RECENT_MS ? new Set(v.ids) : new Set();
    } catch {
      return new Set();
    }
  }

  /** The memories the assistant used or made for this thread lately: what "that" most likely means in "forget that". */
  noteUsed(thread: string, ids: readonly string[], now = this.now()): void {
    if (ids.length === 0) return;
    this.write(() => {
      const merged = [...new Set([...ids, ...this.recentIds(thread, now)])].slice(0, 12);
      this.setMeta(`recent:${thread}`, JSON.stringify({ ids: merged, at: now }));
    });
  }

  private lastCaptured(thread: string | undefined): string | undefined {
    if (!thread) return undefined;
    const last = this.getMeta(`last:${thread}`);
    if (!last) return undefined;
    const row = this.itemRow(last);
    return row && (row.status === "active" || row.status === "contested") ? String(row.text) : undefined;
  }

  private tombstoneFor(c: Candidate, erasedHere: ReadonlySet<string>): boolean {
    const fingerprint = this.fp(c.text, c.scope);
    const row = this.get("SELECT created_at FROM memory_tombstones WHERE fingerprint = ?", [fingerprint]);
    if (!row) return false;
    // The user saying it again after erasing it is the user's choice; the same words read again from before the erasure are not.
    if (c.basis === "explicit" && c.source.trust === "user" && (erasedHere.has(fingerprint) || c.source.observedAt > Number(row.created_at))) return false;
    return true;
  }

  /**
   * Reads a user message and applies what it says, in one transaction. Idempotent per source key. The result's
   * `durable` flag is the only thing that may be used to tell the user "saved": it is true after COMMIT.
   */
  capture(input: CaptureInput): CaptureResult {
    const profile = this.getProfile();
    const empty = (skipped?: CaptureResult["skipped"]): CaptureResult => ({ durable: false, ...(skipped ? { skipped } : {}), changes: [], epoch: this.epoch() });
    if (!profile.enabled) return empty("disabled");
    if (input.ctx.role !== "user") return empty("not-user");
    const now = input.ctx.now ?? this.now();
    const candidates = extractCandidates(input.message, { ...input.ctx, now, lastCapturedText: this.lastCaptured(input.ctx.thread) });
    if (candidates.length === 0) return empty();
    const key = input.sourceKey ?? `${input.ctx.sessionId ?? "-"}:${input.ctx.itemId ?? digest(input.message)}:${input.ctx.observedAt}`;
    return this.ingest(candidates, input.ctx, now, key, input.ctx.observedAt);
  }

  /**
   * Applies what a trusted component observed (a verified task result), under the same rules as a message. A
   * candidate from an untrusted place is never believed: at most it waits for the user to approve it.
   */
  propose(candidate: Candidate, opts: { sourceKey: string; project?: string; account?: string; thread?: string }): CaptureResult {
    if (!this.getProfile().enabled) return { durable: false, skipped: "disabled", changes: [], epoch: this.epoch() };
    const ctx = { role: "tool" as const, observedAt: candidate.source.observedAt, offsetMinutes: 0, ...(opts.project ? { project: opts.project } : {}), ...(opts.account ? { account: opts.account } : {}), ...(opts.thread ? { thread: opts.thread } : {}) };
    return this.ingest([candidate], ctx, this.now(), opts.sourceKey, candidate.source.observedAt);
  }

  private ingest(candidates: readonly Candidate[], ctx: CaptureInput["ctx"], now: number, key: string, observedAt: number): CaptureResult {
    const empty = (skipped: CaptureResult["skipped"]): CaptureResult => ({ durable: false, skipped, changes: [], epoch: this.epoch() });
    return this.write(() => {
      if (this.get("SELECT 1 AS x FROM capture_log WHERE source_key = ?", [key])) return empty("duplicate-source");
      const wipedAt = Number(this.getMeta("wipe_before") ?? 0);
      const floor = Math.max(Number(this.getMeta("capture_floor") ?? 0), wipedAt);
      if (observedAt < floor || (wipedAt > 0 && observedAt <= wipedAt)) {
        this.run("INSERT INTO capture_log (source_key, processed_at, outcome) VALUES (?, ?, ?)", [key, this.now(), "before-floor"]);
        return empty("before-floor");
      }
      const live = this.getProfile();
      const changes: Change[] = [];
      const erasedHere = new Set<string>();
      const touched: string[] = [];
      let wrote = false;
      for (const candidate of candidates) {
        const done = this.apply(candidate, ctx, now, live.capturePaused, erasedHere, touched);
        if (done.wrote) wrote = true;
        changes.push(...done.changes);
      }
      this.run("INSERT INTO capture_log (source_key, processed_at, outcome) VALUES (?, ?, ?)", [key, this.now(), wrote ? "applied" : "nothing"]);
      if (touched.length > 0 && ctx.thread) {
        this.setMeta(`recent:${ctx.thread}`, JSON.stringify({ ids: touched.slice(-12), at: now }));
        this.setMeta(`last:${ctx.thread}`, touched[touched.length - 1] as string);
      }
      if (wrote) this.bump();
      return { durable: wrote, changes, epoch: this.epoch() };
    });
  }

  /**
   * The memories a statement could be about: the ones that share its words (or the words of what it corrects or forgets),
   * the ones in its slot, and what was just used. Not the whole store: a capture costs about the same at ten thousand
   * memories as at a hundred. Without the text index, every visible memory.
   */
  private neighborsFor(c: Candidate, scopes: readonly Scope[], recent: ReadonlySet<string>): MemoryItem[] {
    const statuses: MemoryStatus[] = ["active", "contested", "pending"];
    if (!this.fts) return this.itemsIn(scopes, statuses);
    const keys = scopes.map(scopeKey);
    const ids = new Set<string>(recent);
    const words = queryWords(`${c.text} ${c.about ?? ""}`);
    for (const hit of this.textSearch(words, keys, false, 200)) ids.add(hit.id);
    if (c.slot) for (const r of this.all("SELECT id FROM memory_items WHERE assistant_id = ? AND slot = ? AND status IN ('active','contested','pending')", [ASSISTANT_ID, c.slot])) ids.add(String(r.id));
    if (ids.size === 0) return [];
    const marks = [...ids].map(() => "?").join(",");
    const rows = this.all(`SELECT * FROM memory_items WHERE assistant_id = ? AND id IN (${marks}) AND status IN ('active','contested','pending') AND (scope_kind || ':' || scope_key) IN (${keys.map(() => "?").join(",")})`, [ASSISTANT_ID, ...ids, ...keys]);
    return rows.map(toItem);
  }

  private apply(c: Candidate, ctx: CaptureInput["ctx"], now: number, paused: boolean, erasedHere: Set<string>, touched: string[]): { changes: Change[]; wrote: boolean } {
    const scopes = visibleScopes({ ...(ctx.account ? { account: ctx.account } : {}), ...(ctx.project ? { project: ctx.project } : {}), ...(ctx.thread ? { thread: ctx.thread } : {}) });
    if (!scopes.some((s) => scopeKey(s) === scopeKey(c.scope))) scopes.push(c.scope);
    const neighbors = this.neighborsFor(c, scopes, this.recentIds(ctx.thread, now));

    if (c.intent !== "forget") {
      // A credential or a personal identifier is never kept, and its words are not echoed back anywhere.
      const secret = looksSecret(c.text) ?? looksSecret(c.source.excerpt);
      if (secret) {
        this.audit("suppress", null, "capture", `${c.rule}: secret (${secret})`);
        return { changes: [{ type: "suppressed", reason: `secret: ${secret}`, text: "" }], wrote: false };
      }
      if (this.tombstoneFor(c, erasedHere)) return { changes: [{ type: "suppressed", reason: "tombstone", text: c.text }], wrote: false };
    }
    if (c.source.trust === "untrusted" || c.source.trust === "unverified") {
      // Words from a page, a tool or a file are data. At most they wait, unconfirmed, for the user; they never change what is believed.
      if (c.intent !== "remember") return { changes: [{ type: "suppressed", reason: "untrusted source", text: "" }], wrote: false };
      const twin = neighbors.find((n) => digest(n.text) === digest(c.text) && scopeKey(n.scope) === scopeKey(c.scope));
      if (twin) return { changes: [{ type: "suppressed", reason: "already known", text: c.text }], wrote: false };
      const sourceId = this.source(c.source);
      const item = this.newItem({ ...c, basis: "inferred", confidence: Math.min(c.confidence, 0.5) }, "pending");
      this.insertItem(item, digest(item.text));
      this.insertRevision(item, [sourceId], "capture", `${c.rule}: from an untrusted source`);
      this.evidence(item.id, sourceId, 1);
      this.audit("pending", item.id, "capture", `${c.rule}: untrusted source`);
      return { changes: [{ type: "created", id: item.id, kind: item.kind, text: item.text, status: "pending", supersedes: [], rule: c.rule }], wrote: true };
    }
    const resolution: Resolution = resolve(c, neighbors, { now, tombstoned: false, paused, recent: this.recentIds(ctx.thread, now) });

    switch (resolution.kind) {
      case "suppress":
        this.audit("suppress", null, "capture", `${c.rule}: ${resolution.reason}`);
        return { changes: [{ type: "suppressed", reason: resolution.reason, text: c.text }], wrote: false };

      case "corroborate": {
        const sourceId = this.source(c.source);
        this.corroborate(resolution.target, c, sourceId);
        touched.push(resolution.target);
        return { changes: [{ type: "corroborated", id: resolution.target }], wrote: true };
      }

      case "late": {
        const head = this.getItem(resolution.newerHead);
        const sourceId = this.source(c.source);
        const item = this.newItem(c, "superseded", { supersededBy: resolution.newerHead, validTo: head?.observedAt ?? c.source.observedAt, pinned: false });
        this.insertItem(item, digest(item.text));
        this.insertRevision(item, [sourceId], "capture", `${c.rule}: ${resolution.reason}`);
        this.evidence(item.id, sourceId, 1);
        this.link(resolution.newerHead, item.id, "supersedes");
        this.audit("late", item.id, "capture", `behind ${resolution.newerHead}`);
        return { changes: [{ type: "history", id: item.id, newerHead: resolution.newerHead }], wrote: true };
      }

      case "create": {
        const sourceId = this.source(c.source);
        const inherit = resolution.inherit;
        const item = this.newItem(c, resolution.status, { ...(inherit ? { kind: inherit.kind, slot: inherit.slot, pinned: inherit.pinned } : {}) });
        this.insertItem(item, digest(item.text));
        this.insertRevision(item, [sourceId], "capture", `${c.rule}: ${resolution.reason}`);
        this.evidence(item.id, sourceId, 1);
        for (const old of resolution.supersedes) this.supersede(old, item.id, c.source.observedAt);
        for (const rival of resolution.contests) {
          this.run("UPDATE memory_items SET status = 'contested', rev = rev + 1, updated_at = ? WHERE id = ? AND status = 'active'", [this.now(), rival]);
          this.link(item.id, rival, "contests");
          this.audit("contest", rival, "capture", `with ${item.id}`);
        }
        this.audit("create", item.id, "capture", `${c.rule}: ${resolution.reason}`);
        touched.push(item.id);
        return { changes: [{ type: "created", id: item.id, kind: item.kind, text: item.text, status: item.status, supersedes: resolution.supersedes, rule: c.rule }], wrote: true };
      }

      case "forget": {
        if (resolution.targets.length === 0) return { changes: [{ type: "nothing-to-forget", about: c.about ?? c.text }], wrote: false };
        const gone = this.erase(resolution.targets, { actor: "capture", reason: "user asked to forget", at: c.source.observedAt, lineage: true, tombstone: true }, erasedHere);
        return { changes: [{ type: "forgotten", ids: gone }], wrote: gone.length > 0 };
      }

      case "ambiguous": {
        const options = resolution.options.map((optionId) => ({ id: optionId, text: this.getItem(optionId)?.text ?? "" })).filter((o) => o.text);
        if (c.intent !== "correct") return { changes: [{ type: "ambiguous", reason: resolution.reason, about: c.about ?? c.text, options }], wrote: false };
        // A correction that could mean several memories is kept, waiting, so the choice survives a restart.
        const sourceId = this.source(c.source);
        const item = this.newItem(c, "pending");
        this.insertItem(item, digest(item.text));
        this.insertRevision(item, [sourceId], "capture", `${c.rule}: ${resolution.reason}`);
        this.evidence(item.id, sourceId, 1);
        for (const option of options) this.link(item.id, option.id, "may-correct");
        this.audit("pending", item.id, "capture", resolution.reason);
        return { changes: [{ type: "ambiguous", reason: resolution.reason, about: c.about ?? c.text, options, pendingId: item.id }], wrote: true };
      }
    }
  }

  private corroborate(targetId: string, c: Candidate, sourceId: string): void {
    const row = this.itemRow(targetId);
    if (!row) return;
    const item = toItem(row);
    this.evidence(targetId, sourceId, item.rev);
    const userSaidIt = c.basis === "explicit" && c.source.trust === "user";
    // The user saying it themselves settles a guess or a waiting note. Repeating a guess never does.
    if (userSaidIt && (item.basis === "inferred" || item.status === "pending")) {
      const next: MemoryItem = { ...item, basis: "explicit", status: item.status === "pending" ? "active" : item.status, confidence: Math.max(item.confidence, c.confidence), rev: item.rev + 1, lastConfirmedAt: Math.max(item.lastConfirmedAt, c.source.observedAt), updatedAt: this.now() };
      this.run("UPDATE memory_items SET basis = ?, status = ?, confidence = ?, rev = ?, last_confirmed_at = ?, updated_at = ? WHERE id = ?", [next.basis, next.status, next.confidence, next.rev, next.lastConfirmedAt, next.updatedAt, targetId]);
      this.insertRevision(next, [sourceId], "capture", "stated by the user");
      this.audit("promote", targetId, "capture", "inferred to explicit");
      return;
    }
    this.run("UPDATE memory_items SET last_confirmed_at = MAX(last_confirmed_at, ?), updated_at = ? WHERE id = ?", [c.source.observedAt, this.now(), targetId]);
    this.audit("corroborate", targetId, "capture", c.rule);
  }

  // ------------------------------------------------------------------------------------------------ what the user does

  /** "Remember this", from the memory page: an explicit statement through the same rules as one read from a message. */
  remember(input: RememberInput): { id: string; change: Change } {
    const text = squash(input.text);
    if (text.length < MIN_TEXT) throw new ValidationError("text", "a memory needs some words");
    if (text.length > MAX_TEXT) throw new ValidationError("text", `a memory is at most ${MAX_TEXT} characters`);
    const secret = looksSecret(text);
    if (secret) throw new ValidationError("text", `That looks like a ${secret}. Ancilla does not keep credentials or personal identifiers.`);
    const at = this.now();
    const read = extractCandidates(`Remember that ${text}`, { role: "user", observedAt: at, now: at, offsetMinutes: 0 }).find((c) => c.intent === "remember");
    const base: Candidate = read ?? { intent: "remember", kind: "fact", text, basis: "explicit", confidence: 0.95, source: { kind: "ui", excerpt: text, observedAt: at, trust: "user" }, scope: GLOBAL, identifiers: identifiersOf(text), rule: "ui.remember" };
    const candidate: Candidate = {
      ...base,
      text,
      kind: input.kind ?? base.kind,
      basis: "explicit",
      confidence: 1,
      scope: input.scope ?? GLOBAL,
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      identifiers: identifiersOf(text),
      source: { kind: "ui", excerpt: text, observedAt: at, trust: "user" },
      rule: "ui.remember",
    };
    return this.write(() => {
      const scopes = [GLOBAL, candidate.scope];
      const neighbors = this.itemsIn(scopes, ["active", "contested", "pending"]);
      const erasedHere = new Set<string>();
      const touched: string[] = [];
      const done = this.apply(candidate, { role: "user", observedAt: at, offsetMinutes: 0 }, at, false, erasedHere, touched);
      void neighbors;
      const change = done.changes[0] as Change;
      if (change.type === "suppressed") throw new ConflictError(`Not saved: ${change.reason}`);
      const created = change.type === "created" ? change.id : change.type === "corroborated" ? change.id : change.type === "history" ? change.id : "";
      if (input.pinned && created) this.run("UPDATE memory_items SET pinned = 1, rev = rev + 1 WHERE id = ? AND status = 'active'", [created]);
      this.bump();
      return { id: created, change };
    });
  }

  /** An edit by the user, on the version they were looking at. A stale view is refused rather than overwriting a newer change. */
  edit(itemId: string, patch: EditPatch, expectedRev: number): MemoryItem {
    return this.write(() => {
      const row = this.itemRow(itemId);
      if (!row || row.status === "deleted") throw new NotFoundError("The memory");
      const cur = toItem(row);
      if (cur.rev !== expectedRev) throw new ConflictError("This memory changed since you opened it.", { current: cur.rev });
      if (cur.status === "superseded") throw new ConflictError("This is an earlier version. Edit the current one.");
      const now = this.now();
      const next: MemoryItem = { ...cur, rev: cur.rev + 1, updatedAt: now };
      let textChanged = false;
      if (patch.text !== undefined) {
        const text = squash(patch.text);
        if (text.length < MIN_TEXT) throw new ValidationError("text", "a memory needs some words");
        if (text.length > MAX_TEXT) throw new ValidationError("text", `a memory is at most ${MAX_TEXT} characters`);
        const secret = looksSecret(text);
        if (secret) throw new ValidationError("text", `That looks like a ${secret}. Ancilla does not keep credentials or personal identifiers.`);
        if (text !== cur.text) {
          const dg = digest(text);
          const twin = this.get("SELECT id FROM memory_items WHERE assistant_id = ? AND digest = ? AND scope_kind = ? AND scope_key = ? AND status IN ('active','contested','pending') AND id != ?", [ASSISTANT_ID, dg, cur.scope.kind, cur.scope.key, itemId]);
          if (twin) throw new ConflictError("Another memory already says this.", { duplicateOf: String(twin.id) });
          next.text = text;
          next.identifiers = identifiersOf(text);
          next.basis = "explicit";
          next.confidence = 1;
          next.observedAt = now;
          next.lastConfirmedAt = now;
          textChanged = true;
        }
      }
      if (patch.kind !== undefined && patch.kind !== cur.kind) {
        next.kind = patch.kind;
        next.commitment = patch.kind === "commitment" ? (cur.commitment ?? "open") : null;
      }
      if (patch.pinned !== undefined) next.pinned = patch.pinned;
      if (patch.dueAt !== undefined) next.dueAt = patch.dueAt;
      if (patch.validTo !== undefined) next.validTo = patch.validTo;
      if (next.status === "pending" && textChanged) next.status = "active";
      this.run(
        "UPDATE memory_items SET kind = ?, pinned = ?, text = ?, basis = ?, confidence = ?, observed_at = ?, valid_to = ?, due_at = ?, commitment = ?, last_confirmed_at = ?, status = ?, rev = ?, identifiers = ?, digest = ?, updated_at = ? WHERE id = ?",
        [next.kind, next.pinned ? 1 : 0, next.text, next.basis, next.confidence, next.observedAt, next.validTo, next.dueAt, next.commitment, next.lastConfirmedAt, next.status, next.rev, JSON.stringify(next.identifiers), digest(next.text), now, itemId],
      );
      if (textChanged) {
        const sourceId = this.source({ kind: "ui", excerpt: next.text, observedAt: now, trust: "user" });
        this.evidence(itemId, sourceId, next.rev);
        this.insertRevision(next, [sourceId], "user", "edited by the user");
        this.indexItem(itemId, next.text, next.slot);
      } else {
        this.insertRevision(next, [], "user", "settings changed by the user");
      }
      this.audit("edit", itemId, "user", Object.keys(patch).join(","));
      this.bump();
      return next;
    });
  }

  pin(itemId: string, pinned: boolean): MemoryItem {
    return this.touch(itemId, "pin", (item) => {
      if (item.status === "superseded") throw new ConflictError("An earlier version cannot be pinned.");
      this.run("UPDATE memory_items SET pinned = ? WHERE id = ?", [pinned ? 1 : 0, itemId]);
    });
  }

  /** "Still true": the user checked a note that may have gone out of date. */
  confirm(itemId: string): MemoryItem {
    return this.touch(itemId, "confirm", () => this.run("UPDATE memory_items SET last_confirmed_at = ? WHERE id = ?", [this.now(), itemId]));
  }

  setCommitment(itemId: string, state: "open" | "done" | "dropped"): MemoryItem {
    return this.touch(itemId, "commitment", (item) => {
      if (item.kind !== "commitment") throw new ValidationError("kind", "only a commitment can be marked done or dropped");
      this.run("UPDATE memory_items SET commitment = ? WHERE id = ?", [state, itemId]);
    });
  }

  private touch(itemId: string, action: string, change: (item: MemoryItem) => void): MemoryItem {
    return this.write(() => {
      const row = this.itemRow(itemId);
      if (!row || row.status === "deleted") throw new NotFoundError("The memory");
      change(toItem(row));
      this.run("UPDATE memory_items SET rev = rev + 1, updated_at = ? WHERE id = ?", [this.now(), itemId]);
      this.audit(action, itemId, "user");
      this.bump();
      return toItem(this.itemRow(itemId) as Row);
    });
  }

  /** Settles a dispute: this statement stands and the rivals it was contested with become history. */
  settle(itemId: string): MemoryItem {
    return this.write(() => {
      const row = this.itemRow(itemId);
      if (!row || row.status !== "contested") throw new ConflictError("This memory is not in dispute.");
      const rivals = this.all("SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS other FROM memory_links WHERE kind = 'contests' AND (from_id = ? OR to_id = ?)", [itemId, itemId, itemId]).map((r) => String(r.other));
      const now = this.now();
      this.run("UPDATE memory_items SET status = 'active', rev = rev + 1, updated_at = ? WHERE id = ?", [now, itemId]);
      for (const rival of rivals) {
        const other = this.itemRow(rival);
        if (other && other.status === "contested") this.supersede(rival, itemId, now);
      }
      this.run("DELETE FROM memory_links WHERE kind = 'contests' AND (from_id = ? OR to_id = ?)", [itemId, itemId]);
      this.audit("settle", itemId, "user");
      this.bump();
      return toItem(this.itemRow(itemId) as Row);
    });
  }

  /** A waiting memory is accepted, optionally replacing the memory it was meant to correct. */
  approve(itemId: string, replaces?: string): MemoryItem {
    return this.write(() => {
      const row = this.itemRow(itemId);
      if (!row || row.status !== "pending") throw new ConflictError("This memory is not waiting for approval.");
      const item = toItem(row);
      const options = this.all("SELECT to_id FROM memory_links WHERE from_id = ? AND kind = 'may-correct'", [itemId]).map((r) => String(r.to_id));
      const now = this.now();
      if (replaces !== undefined) {
        if (!options.includes(replaces)) throw new ValidationError("replaces", "that memory is not one this correction could replace");
        const target = this.getItem(replaces);
        if (!target || target.status === "deleted") throw new NotFoundError("The memory to replace");
        this.run("UPDATE memory_items SET kind = ?, slot = ?, pinned = ? WHERE id = ?", [target.kind, target.slot, target.pinned ? 1 : 0, itemId]);
        this.supersede(replaces, itemId, item.observedAt);
      }
      this.run("UPDATE memory_items SET status = 'active', basis = 'explicit', rev = rev + 1, updated_at = ? WHERE id = ?", [now, itemId]);
      this.run("DELETE FROM memory_links WHERE from_id = ? AND kind = 'may-correct'", [itemId]);
      this.audit("approve", itemId, "user", replaces ? `replaces ${replaces}` : "");
      this.bump();
      return toItem(this.itemRow(itemId) as Row);
    });
  }

  // ------------------------------------------------------------------------------------------------ erasing

  /** Erases memories the user chose, with their earlier versions, and refuses the same words from before now. Returns the ids that went. */
  forget(ids: readonly string[], actor = "user"): string[] {
    return this.write(() => {
      const gone = this.erase(ids, { actor, reason: "forgotten by the user", at: this.now(), lineage: true, tombstone: true }, new Set());
      if (gone.length > 0) this.bump();
      return gone;
    });
  }

  private erase(ids: readonly string[], opts: { actor: string; reason: string; at: number; lineage: boolean; tombstone: boolean; keepSharedSources?: boolean }, erasedHere: Set<string>): string[] {
    const all = new Set<string>();
    const queue = [...ids];
    while (queue.length > 0) {
      const next = queue.pop() as string;
      if (all.has(next)) continue;
      const row = this.itemRow(next);
      if (!row || row.status === "deleted") continue;
      all.add(next);
      if (opts.lineage) for (const r of this.all("SELECT to_id FROM memory_links WHERE from_id = ? AND kind = 'supersedes'", [next])) queue.push(String(r.to_id));
    }
    if (all.size === 0) return [];
    const list = [...all];
    const marks = list.map(() => "?").join(",");

    // What each erased memory said, in every revision, so that its fingerprints cover every phrasing it ever had.
    const said = new Map<string, { text: string; scope: Scope }[]>();
    for (const itemId of list) {
      const row = toItem(this.itemRow(itemId) as Row);
      const texts = new Set<string>([row.text]);
      for (const r of this.all("SELECT text FROM memory_revisions WHERE item_id = ?", [itemId])) texts.add(String(r.text));
      said.set(itemId, [...texts].map((text) => ({ text, scope: row.scope })));
    }
    const partners = this.all(`SELECT DISTINCT CASE WHEN from_id IN (${marks}) THEN to_id ELSE from_id END AS other FROM memory_links WHERE kind = 'contests' AND (from_id IN (${marks}) OR to_id IN (${marks}))`, [...list, ...list, ...list]).map((r) => String(r.other));

    if (opts.tombstone) {
      for (const entries of said.values()) {
        for (const { text, scope } of entries) {
          const fingerprint = this.fp(text, scope);
          this.run("INSERT INTO memory_tombstones (fingerprint, scope, created_at, reason) VALUES (?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET created_at = excluded.created_at, reason = excluded.reason", [fingerprint, scopeKey(scope), opts.at, opts.reason.slice(0, 80)]);
          erasedHere.add(fingerprint);
        }
      }
    }

    const sourceIds = this.all(`SELECT DISTINCT source_id FROM memory_evidence WHERE item_id IN (${marks})`, list).map((r) => String(r.source_id));
    const erasedTexts = [...said.values()].flat().map((e) => e.text);
    this.run(`DELETE FROM memory_evidence WHERE item_id IN (${marks})`, list);
    this.run(`DELETE FROM memory_revisions WHERE item_id IN (${marks})`, list);
    this.run(`DELETE FROM memory_links WHERE from_id IN (${marks}) OR to_id IN (${marks})`, [...list, ...list]);
    for (const itemId of list) this.unindexItem(itemId);
    for (const sourceId of sourceIds) {
      const left = Number(this.get("SELECT COUNT(*) AS n FROM memory_evidence WHERE source_id = ?", [sourceId])?.n ?? 0);
      if (left === 0) {
        this.run("DELETE FROM memory_sources WHERE id = ?", [sourceId]);
        continue;
      }
      // Merging two copies of one memory leaves the words where they are: nothing is being erased, only joined.
      if (opts.keepSharedSources) continue;
      // Another memory still rests on these words, so the source stays, minus whatever was erased from it.
      const row = this.get("SELECT excerpt FROM memory_sources WHERE id = ?", [sourceId]);
      let excerpt = String(row?.excerpt ?? "");
      let redacted = false;
      for (const text of erasedTexts) {
        const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
        if (pattern.test(excerpt)) {
          excerpt = excerpt.replace(pattern, ERASED);
          redacted = true;
        }
      }
      this.run("UPDATE memory_sources SET excerpt = ?, digest = ? WHERE id = ?", [redacted ? excerpt : `${ERASED} (shared with another memory)`, digest(redacted ? excerpt : ERASED), sourceId]);
    }
    for (const itemId of list) {
      this.run("DELETE FROM memory_summaries WHERE derived_from LIKE ?", [`%"${itemId}"%`]);
      this.run("DELETE FROM assistant_meta WHERE (key LIKE 'recent:%' OR key LIKE 'last:%') AND value LIKE ?", [`%${itemId}%`]);
      this.run("UPDATE memory_items SET status = 'deleted', text = '', identifiers = '[]', digest = '', slot = NULL, pinned = 0, valid_from = NULL, valid_to = NULL, due_at = NULL, commitment = NULL, superseded_by = NULL, revalidate_after_ms = NULL, rev = rev + 1, updated_at = ? WHERE id = ?", [this.now(), itemId]);
      this.audit("forget", itemId, opts.actor, opts.reason);
    }
    // A memory left disputing a rival that is gone is no longer in dispute.
    for (const other of partners) {
      if (all.has(other)) continue;
      const open = Number(this.get("SELECT COUNT(*) AS n FROM memory_links l JOIN memory_items i ON i.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END WHERE l.kind = 'contests' AND (l.from_id = ? OR l.to_id = ?) AND i.status = 'contested'", [other, other, other])?.n ?? 0);
      if (open === 0) this.run("UPDATE memory_items SET status = 'active', rev = rev + 1 WHERE id = ? AND status = 'contested'", [other]);
    }
    // Pending corrections that pointed at an erased memory lose that option; one left with none is just a statement.
    if (this.fts) this.run("INSERT INTO memory_fts (memory_fts) VALUES ('optimize')");
    return list;
  }

  /** Forgets everything the assistant remembers, and refuses anything said before now when it is read again. The profile and goals stay. */
  wipe(): number {
    const count = this.write(() => {
      const n = Number(this.get("SELECT COUNT(*) AS n FROM memory_items WHERE status != 'deleted'")?.n ?? 0);
      for (const table of ["memory_evidence", "memory_revisions", "memory_links", "memory_sources", "memory_summaries", "memory_tombstones", "memory_items"]) this.run(`DELETE FROM ${table}`);
      this.run("DELETE FROM assistant_meta WHERE key LIKE 'recent:%' OR key LIKE 'last:%'");
      if (this.fts) {
        this.run("DELETE FROM memory_fts");
        this.run("INSERT INTO memory_fts (memory_fts) VALUES ('optimize')");
      }
      this.setMeta("wipe_before", String(this.now()));
      this.audit("wipe", null, "user", `${n} memories`);
      this.bump();
      return n;
    });
    this.scrub(true);
    return count;
  }

  /** Brings the file itself up to date with what was erased: the log is folded in and, after a wipe, the free pages are given back. */
  scrub(vacuum = false): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (vacuum) this.db.exec("VACUUM");
    } catch {
      /* another connection is reading; the pages are overwritten already (secure_delete) */
    }
  }

  // ------------------------------------------------------------------------------------------------ retrieval

  private textSearch(words: readonly string[], keys: readonly string[] | null, history: boolean, limit: number): { id: string; rank: number }[] {
    if (words.length === 0) return [];
    const scopeSql = keys ? ` AND (i.scope_kind || ':' || i.scope_key) IN (${keys.map(() => "?").join(",")})` : "";
    const scopeParams = keys ?? [];
    const statusSql = history ? "i.status != 'deleted'" : "i.status NOT IN ('deleted','superseded')";
    if (this.fts) {
      const match = words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
      const rows = this.all(`SELECT i.id AS id, bm25(memory_fts) AS rank FROM memory_fts JOIN memory_items i ON i.id = memory_fts.ref WHERE memory_fts MATCH ? AND i.assistant_id = ? AND ${statusSql}${scopeSql} ORDER BY rank LIMIT ${limit}`, [match, ASSISTANT_ID, ...scopeParams]);
      return rows.map((r) => ({ id: String(r.id), rank: Number(r.rank) }));
    }
    // No full text index: every visible note is scored by the words it shares with the question.
    const rows = this.all(`SELECT i.id AS id, i.text AS text FROM memory_items i WHERE i.assistant_id = ? AND ${statusSql}${scopeSql} LIMIT 5000`, [ASSISTANT_ID, ...scopeParams]);
    const q = new Set(words);
    const scored: { id: string; rank: number }[] = [];
    for (const r of rows) {
      const t = tokenSet(String(r.text));
      let both = 0;
      for (const w of q) if (t.has(w) || [...t].some((x) => x.startsWith(w) || w.startsWith(x))) both += 1;
      if (both > 0) scored.push({ id: String(r.id), rank: -both });
    }
    return scored.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }

  private hitsFor(query: RetrievalQuery): Hit[] {
    const keys = query.scopes.map(scopeKey);
    const q = tokenSet(query.text);
    const lowerQuery = query.text.toLowerCase();
    const byId = new Map<string, Hit>();
    const add = (item: MemoryItem, lexical: number): void => {
      const cur = byId.get(item.id);
      if (!cur || lexical > cur.lexical) byId.set(item.id, { item, lexical });
    };

    const found = this.textSearch(queryWords(query.text), keys, query.history === true || query.asOf !== undefined, 60);
    const maxAbs = found.reduce((m, f) => Math.max(m, Math.abs(f.rank)), 0);
    for (const f of found) {
      const item = this.getItem(f.id);
      if (!item) continue;
      const cover = containment(q, tokenSet(item.text));
      const shared = [...q].filter((w) => tokenSet(item.text).has(w)).length;
      const namesIt = item.identifiers.some((idn) => lowerQuery.includes(idn.toLowerCase()));
      // A single common word is not a match: a note needs a third of the question's words, two words, or an identifier.
      if (!(cover >= 0.34 || shared >= 2 || namesIt)) continue;
      const rel = maxAbs > 0 ? Math.abs(f.rank) / maxAbs : 1;
      add(item, Math.min(1, rel * (0.4 + 0.6 * cover)));
    }

    // Always on: what the user pinned, their standing rules, what they owe, and the working notes of this thread.
    const keySql = keys.map(() => "?").join(",");
    // A question about a past moment also sees the rules that were replaced since: it is what held then.
    const statuses = query.asOf !== undefined ? "'active','contested','superseded'" : "'active','contested'";
    const always = this.all(
      `SELECT * FROM memory_items WHERE assistant_id = ? AND status IN (${statuses}) AND (scope_kind || ':' || scope_key) IN (${keySql}) AND (pinned = 1 OR kind = 'constraint' OR kind = 'working' OR (kind = 'commitment' AND commitment = 'open')) LIMIT 400`,
      [ASSISTANT_ID, ...keys],
    );
    for (const row of always) add(toItem(row), 0);
    return [...byId.values()];
  }

  /** What the assistant knows that bears on this question, as the block that is added to the turn. */
  retrieve(input: RetrieveInput): AssembledContext & { epoch: number } {
    return this.retrieveWith(input);
  }

  /**
   * `retrieve`, with a hook that may add to or change the candidates before they are scored. The shipped path passes
   * none; the evaluation passes the techniques it is deciding whether to adopt (query expansion, vectors, a graph), so
   * that each is compared on exactly the same ranking, filtering and budget.
   */
  retrieveWith(input: RetrieveInput, tweak?: (hits: Hit[], query: RetrievalQuery) => Hit[]): AssembledContext & { epoch: number } {
    const profile = this.getProfile();
    const now = input.now ?? this.now();
    const query: RetrievalQuery = {
      text: input.text,
      scopes: visibleScopes({ ...(input.account ? { account: input.account } : {}), ...(input.project ? { project: input.project } : {}), ...(input.thread ? { thread: input.thread } : {}) }),
      now,
      budgetTokens: input.budgetTokens ?? profile.contextBudgetTokens,
      ...(input.history ? { history: true } : {}),
      ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    };
    const base = this.hitsFor(query);
    const ranked = rankMemories(query, tweak ? tweak(base, query) : base).slice(0, input.limit ?? 40);
    const evidence = WHY.test(input.text) ? this.evidenceFor(ranked.slice(0, 6).map((r) => r.item.id)) : undefined;
    const summaries = query.history || query.asOf !== undefined ? this.summariesFor(query) : [];
    const out = assembleContext({ profile, goals: this.activeGoals(), ranked, query, asksMemory: asksAboutMemory(input.text) || asksForEverything(input.text), broad: asksForEverything(input.text), ...(evidence ? { evidence } : {}), ...(summaries.length > 0 ? { summaries } : {}) });
    return { ...out, epoch: this.epoch() };
  }

  /** Roll-ups that bear on a question about the past, for the one place they are used: older history, labelled as derived. */
  private summariesFor(query: RetrievalQuery): { period: string; count: number; text: string }[] {
    const keys = query.scopes.map(scopeKey);
    if (keys.length === 0) return [];
    const rows = this.all(`SELECT period, text, derived_from FROM memory_summaries WHERE (scope_kind || ':' || scope_key) IN (${keys.map(() => "?").join(",")}) ORDER BY period DESC LIMIT 24`, keys);
    const words = new Set(queryWords(query.text));
    const asOf = query.asOf !== undefined ? new Date(query.asOf).toISOString().slice(0, 7) : null;
    return rows
      .filter((r) => (asOf !== null && String(r.period) === asOf) || [...words].some((w) => String(r.text).toLowerCase().includes(w)) || words.has(String(r.period).toLowerCase()))
      .slice(0, 2)
      .map((r) => ({ period: String(r.period), count: (JSON.parse(String(r.derived_from)) as string[]).length, text: String(r.text) }));
  }

  // ------------------------------------------------------------------------------------------------ consolidation

  /**
   * Tidies what accumulates: identical memories become one (their sources kept), working notes long past their time go,
   * and old events and decisions are rolled up month by month into a derived summary. A summary is a convenience for
   * a question about the distant past, labelled as derived wherever it is shown, never a source of belief, and erased
   * with any memory it was made from. Safe to run at any time and as often as wanted.
   */
  consolidate(now = this.now()): { merged: number; expired: number; rolledUp: number } {
    return this.write(() => {
      let merged = 0;
      const groups = this.all(
        "SELECT scope_kind, scope_key, kind, digest FROM memory_items WHERE assistant_id = ? AND status IN ('active','contested','pending') AND digest != '' GROUP BY scope_kind, scope_key, kind, digest HAVING COUNT(*) > 1",
        [ASSISTANT_ID],
      );
      for (const g of groups) {
        const items = this.all("SELECT * FROM memory_items WHERE assistant_id = ? AND status IN ('active','contested','pending') AND scope_kind = ? AND scope_key = ? AND kind = ? AND digest = ? ORDER BY created_at, rowid", [ASSISTANT_ID, String(g.scope_kind), String(g.scope_key), String(g.kind), String(g.digest)]).map(toItem);
        const keeper = items[0];
        if (!keeper) continue;
        const others = items.slice(1);
        for (const other of others) this.run("INSERT OR IGNORE INTO memory_evidence (item_id, source_id, rev) SELECT ?, source_id, ? FROM memory_evidence WHERE item_id = ?", [keeper.id, keeper.rev, other.id]);
        const explicit = items.some((i) => i.basis === "explicit");
        this.run("UPDATE memory_items SET last_confirmed_at = ?, basis = ?, pinned = ?, status = CASE WHEN status = 'pending' AND ? = 1 THEN 'active' ELSE status END, rev = rev + 1, updated_at = ? WHERE id = ?", [
          Math.max(...items.map((i) => i.lastConfirmedAt)), explicit ? "explicit" : keeper.basis, items.some((i) => i.pinned) ? 1 : 0, explicit ? 1 : 0, this.now(), keeper.id,
        ]);
        this.erase(others.map((o) => o.id), { actor: "consolidation", reason: "the same memory twice", at: now, lineage: false, tombstone: false, keepSharedSources: true }, new Set());
        merged += others.length;
        this.audit("merge", keeper.id, "consolidation", `${others.length} copy(ies)`);
      }
      const old = this.all("SELECT id FROM memory_items WHERE assistant_id = ? AND kind = 'working' AND status != 'deleted' AND valid_to IS NOT NULL AND valid_to <= ?", [ASSISTANT_ID, now - 14 * 86_400_000]).map((r) => String(r.id));
      if (old.length > 0) this.erase(old, { actor: "consolidation", reason: "a working note past its time", at: now, lineage: false, tombstone: false }, new Set());
      const rolledUp = this.rollUp(now);
      if (merged + old.length + rolledUp > 0) this.bump();
      this.setMeta("consolidated_at", String(now));
      return { merged, expired: old.length, rolledUp };
    });
  }

  /** One derived line per scope and month for events and decisions older than a month, once there are enough to be worth it. */
  private rollUp(now: number): number {
    const rows = this.all("SELECT id, text, scope_kind, scope_key, observed_at FROM memory_items WHERE assistant_id = ? AND kind IN ('event','decision') AND status IN ('active','superseded') AND observed_at < ? ORDER BY observed_at, rowid", [ASSISTANT_ID, now - 30 * 86_400_000]);
    const groups = new Map<string, { scope: Scope; period: string; ids: string[]; texts: string[] }>();
    for (const r of rows) {
      const period = new Date(Number(r.observed_at)).toISOString().slice(0, 7);
      const scope: Scope = { kind: r.scope_kind as Scope["kind"], key: String(r.scope_key) };
      const key = `${scopeKey(scope)}|${period}`;
      const g = groups.get(key) ?? { scope, period, ids: [], texts: [] };
      g.ids.push(String(r.id));
      g.texts.push(String(r.text));
      groups.set(key, g);
    }
    let made = 0;
    // Rebuilt from what exists now: a roll-up of a memory that has since been erased is gone, and a new one says only what is left.
    this.run("DELETE FROM memory_summaries");
    for (const g of groups.values()) {
      if (g.ids.length < 5) continue;
      const heads = g.texts.slice(0, 3).map((t) => (t.length > 80 ? `${t.slice(0, 77)}...` : t)).join("; ");
      this.run("INSERT INTO memory_summaries (id, scope_kind, scope_key, period, text, derived_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id("sum"), g.scope.kind, g.scope.key, g.period, `${g.period}: ${g.ids.length} notes, among them: ${heads}`, JSON.stringify(g.ids), this.now()]);
      made += 1;
    }
    return made;
  }

  /** The exact words behind some memories, for a question about where a belief came from. */
  evidenceFor(ids: readonly string[]): Map<string, SourceRecord[]> {
    const out = new Map<string, SourceRecord[]>();
    for (const itemId of ids) {
      const rows = this.all("SELECT s.* FROM memory_sources s JOIN memory_evidence e ON e.source_id = s.id WHERE e.item_id = ? ORDER BY s.observed_at DESC LIMIT 3", [itemId]).map(toSource);
      if (rows.length > 0) out.set(itemId, rows);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ export

  /** Everything the assistant holds about the user, as one document they can keep. Erased memories are not in it, and neither are their fingerprints. */
  exportAll(): Record<string, unknown> {
    const rows = this.all("SELECT id FROM memory_items WHERE assistant_id = ? AND status != 'deleted' ORDER BY created_at, id", [ASSISTANT_ID]);
    const items = rows.map((r) => {
      const d = this.detail(String(r.id));
      return { ...d.item, revisions: d.revisions, sources: d.sources, lineage: d.lineage };
    });
    return {
      format: "ancilla.assistant.export",
      version: 1,
      exportedAt: new Date(this.now()).toISOString(),
      schemaVersion: schemaVersion(this.db),
      profile: this.getProfile(),
      goals: this.listGoals(),
      items,
      notes: ["Memories that were forgotten are not included, and the fingerprints kept to stop them coming back are not exported."],
    };
  }

  schema(): { version: number; latest: number } {
    return { version: schemaVersion(this.db), latest: LATEST_VERSION };
  }
}
