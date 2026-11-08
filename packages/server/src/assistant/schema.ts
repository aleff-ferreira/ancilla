import type { DatabaseSync } from "node:sqlite";

/**
 * The assistant's database: its own file (`assistant.db` in the data folder), so that the feature can be taken out
 * by deleting one file, exported on its own, and never contends with the conversation store for a lock. The schema is
 * versioned with `PRAGMA user_version` and every step has an `up` and a `down`, so a release that adds a column can be
 * followed by one that removes it. A step runs in one transaction with its version bump: a crash leaves the old version.
 */

export interface Migration {
  version: number;
  name: string;
  up: string;
  /** Undoes `up`. Destructive by nature: the rollback guide says to export first. */
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "memory and profile",
    up: `
CREATE TABLE assistant_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE assistant_profile (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE assistant_goals (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL,
  slot TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  basis TEXT NOT NULL,
  confidence REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  due_at INTEGER,
  commitment TEXT,
  revalidate_after_ms INTEGER,
  last_confirmed_at INTEGER NOT NULL,
  superseded_by TEXT,
  rev INTEGER NOT NULL,
  identifiers TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memory_items_scope ON memory_items (assistant_id, status, scope_kind, scope_key);
CREATE INDEX memory_items_slot ON memory_items (assistant_id, slot) WHERE slot IS NOT NULL;
CREATE INDEX memory_items_digest ON memory_items (assistant_id, digest);
CREATE INDEX memory_items_due ON memory_items (status, commitment, due_at);

CREATE TABLE memory_revisions (
  item_id TEXT NOT NULL REFERENCES memory_items (id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  text TEXT NOT NULL,
  basis TEXT NOT NULL,
  confidence REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  valid_from INTEGER,
  valid_to INTEGER,
  due_at INTEGER,
  revalidate_after_ms INTEGER,
  source_ids TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, rev)
);

CREATE TABLE memory_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT,
  item_ref TEXT,
  turn_id TEXT,
  excerpt TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  trust TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE memory_evidence (
  item_id TEXT NOT NULL REFERENCES memory_items (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES memory_sources (id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  PRIMARY KEY (item_id, source_id)
);
CREATE INDEX memory_evidence_source ON memory_evidence (source_id);

CREATE TABLE memory_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX memory_links_to ON memory_links (to_id);

CREATE TABLE memory_tombstones (fingerprint TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE capture_log (source_key TEXT PRIMARY KEY, processed_at INTEGER NOT NULL, outcome TEXT NOT NULL);

CREATE TABLE memory_summaries (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  period TEXT NOT NULL,
  text TEXT NOT NULL,
  derived_from TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  item_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX memory_audit_item ON memory_audit (item_id);
`,
    down: `
DROP TABLE IF EXISTS memory_audit;
DROP TABLE IF EXISTS memory_summaries;
DROP TABLE IF EXISTS capture_log;
DROP TABLE IF EXISTS memory_tombstones;
DROP TABLE IF EXISTS memory_links;
DROP TABLE IF EXISTS memory_evidence;
DROP TABLE IF EXISTS memory_sources;
DROP TABLE IF EXISTS memory_revisions;
DROP TABLE IF EXISTS memory_items;
DROP TABLE IF EXISTS assistant_goals;
DROP TABLE IF EXISTS assistant_profile;
DROP TABLE IF EXISTS assistant_meta;
`,
  },
  {
    version: 2,
    name: "tasks and schedules",
    up: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  goal_id TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  schedule_id TEXT,
  cwd TEXT NOT NULL,
  project TEXT NOT NULL,
  account TEXT,
  session_id TEXT,
  allow_writes INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL,
  max_minutes INTEGER NOT NULL,
  turns_used INTEGER NOT NULL DEFAULT 0,
  fence INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_status ON tasks (status, created_at);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT,
  effect TEXT NOT NULL,
  verifier TEXT,
  status TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX task_steps_task ON task_steps (task_id, ord);

CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES task_steps (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  turn_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX task_attempts_task ON task_attempts (task_id, number);
CREATE INDEX task_attempts_turn ON task_attempts (session_id, turn_id);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attempt_id TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX task_events_task ON task_events (task_id, id);

CREATE TABLE task_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE INDEX task_checkpoints_task ON task_checkpoints (task_id, id);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project TEXT NOT NULL,
  account TEXT,
  kind TEXT NOT NULL,
  every_minutes INTEGER,
  at_minute INTEGER,
  tz TEXT NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  max_runs INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  catch_up TEXT NOT NULL,
  allow_writes INTEGER NOT NULL DEFAULT 0,
  steps TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX schedules_due ON schedules (enabled, next_run_at);
`,
    down: `
DROP TABLE IF EXISTS schedules;
DROP TABLE IF EXISTS task_checkpoints;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS task_attempts;
DROP TABLE IF EXISTS task_steps;
DROP TABLE IF EXISTS tasks;
`,
  },
  {
    version: 3,
    name: "conversations",
    // What was said in a call or typed to the assistant, so that the next call, and the text box, go on from it. Only words
    // are kept: no audio is ever stored.
    up: `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  project TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX conversations_updated ON conversations (updated_at DESC);

CREATE TABLE utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  turn INTEGER NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  heard TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX utterances_conversation ON utterances (conversation_id, id);
`,
    down: `
DROP TABLE IF EXISTS utterances;
DROP TABLE IF EXISTS conversations;
`,
  },
  {
    version: 4,
    name: "the Muse thread of a conversation",
    // When Muse is the call's model, the conversation goes on in one Muse thread, so that its history lives where Muse keeps it.
    up: `ALTER TABLE conversations ADD COLUMN muse_session TEXT;`,
    down: `ALTER TABLE conversations DROP COLUMN muse_session;`,
  },
  {
    version: 5,
    name: "notes by meaning",
    // The meaning of each note as a vector, from an embedding model the user named. Derived from the note and erased with it
    // (a vector can be turned back into much of the words that made it, so it is kept and removed exactly as the note is).
    up: `
CREATE TABLE memory_vectors (
  item_id TEXT PRIMARY KEY REFERENCES memory_items (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX memory_vectors_model ON memory_vectors (model);
`,
    down: `DROP TABLE IF EXISTS memory_vectors;`,
  },
];

/** The full text index. Kept apart from the migrations because it is built by hand, and rebuilt when it cannot be trusted. */
export const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(ref UNINDEXED, text, tokenize = 'porter unicode61 remove_diacritics 2')`;

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** Runs `fn` in a write transaction. */
function atomically<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* SQLite already ended it */
    }
    throw error;
  }
}

/** Brings the database to `target` (the latest by default), one step at a time. A database newer than this program is refused, never altered. */
export function migrate(db: DatabaseSync, target: number = LATEST_VERSION): number {
  const current = schemaVersion(db);
  if (current > LATEST_VERSION) throw new Error(`The assistant database is version ${current}, newer than this Ancilla understands (${LATEST_VERSION}). Update Ancilla, or restore an older assistant.db.`);
  for (const step of MIGRATIONS) {
    if (step.version <= current || step.version > target) continue;
    atomically(db, () => {
      db.exec(step.up);
      db.exec(`PRAGMA user_version = ${step.version}`);
    });
  }
  return schemaVersion(db);
}

/** Undoes steps down to `target`, newest first. The data in the dropped tables is gone: export first. */
export function rollbackTo(db: DatabaseSync, target: number): number {
  for (const step of [...MIGRATIONS].reverse()) {
    if (step.version > schemaVersion(db) || step.version <= target) continue;
    atomically(db, () => {
      if (step.version === 1) db.exec("DROP TABLE IF EXISTS memory_fts");
      db.exec(step.down);
      db.exec(`PRAGMA user_version = ${step.version - 1}`);
    });
  }
  return schemaVersion(db);
}
