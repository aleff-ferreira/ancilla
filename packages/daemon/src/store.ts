import { DatabaseSync } from "node:sqlite";
import { parseSubscriptionUsage, type SubscriptionUsage } from "./sessions.js";
import { DEFAULT_RESEARCH_SETTINGS, resolveResearchConfig, type ResearchConfig, type ResearchSettings } from "./research/config.js";
import type { ResearchEvent, ResearchRunState, ResearchStatus, WorkerStatus } from "./research/types.js";

export interface Project {
  id: number;
  cwd: string;
  displayName: string;
  pinned: boolean;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  /** Latest activity across the project's visible sessions, or its creation time. */
  activityAt: string;
  /** The aonia profile new threads in this project default to; null for the default login. */
  defaultAccountId: string | null;
  /** Every folder the project groups: its own cwd first, then the folders added to it. */
  folders: ProjectFolder[];
}

export interface ProjectFolder {
  cwd: string;
  displayName: string;
}

/** A folder change the store refuses; the server turns it into a 400 with this message. */
export class ProjectFolderError extends Error {}

/** How a session title was chosen; a higher rank is never overwritten by a lower one. */
export type TitleSource = "placeholder" | "auto" | "user";

const TITLE_RANK: Record<TitleSource, number> = { placeholder: 0, auto: 1, user: 2 };

export interface SessionRecord {
  id: string;
  projectId: number;
  title: string;
  titleSource: TitleSource;
  status: string;
  turnCount: number;
  /** The model Muse last reported for the session. */
  modelId: string | null;
  /**
   * The model the user picked for this thread, here or in Muse; null when nobody has. Discovery and resume
   * never touch it, so a host that comes back reporting another model can be set right again.
   */
  chosenModelId: string | null;
  /**
   * Who made the session: `ancilla` for threads started here, `muse` for ones discovered on a host, and
   * `research-worker` for the archived sessions a DeepResearch run starts to do its searching.
   */
  origin: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  activityAt: string;
  /** `settled` shelves the thread; `active` keeps it out of auto-settle until its next activity. */
  settledOverride: SettledOverride | null;
  settledAt: string | null;
  unsettledAt: string | null;
  /** Sandbox posture at creation: null for sessions recorded before tracking. */
  sandboxDisabled: boolean | null;
  /** The aonia profile a session was created under; null for the default login. Set once, never changed. */
  accountId: string | null;
}

export type SettledOverride = "settled" | "active";

export interface TurnRecord {
  id: string;
  sessionId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordSessionInput {
  id: string;
  projectId: number;
  title?: string;
  titleSource?: TitleSource;
  modelId?: string | null;
  /** The model the thread was asked to start on; later touches never overwrite it. */
  chosenModelId?: string | null;
  origin?: string;
  turnCount?: number;
  createdAt?: string;
  activityAt?: string;
  /** Creation posture; later touches never overwrite it. */
  sandboxDisabled?: boolean | null;
  /** Creation account; later touches never overwrite it. */
  accountId?: string | null;
}

export interface SessionPatch {
  title?: string;
  titleSource?: TitleSource;
  archived?: boolean;
  modelId?: string | null;
  chosenModelId?: string | null;
  turnCount?: number;
  activityAt?: string;
  status?: string;
  settledOverride?: SettledOverride | null;
  settledAt?: string | null;
  unsettledAt?: string | null;
}

export const PLACEHOLDER_TITLE = "New thread";

/** Server-owned thread-title generation: the switch and the model, kept where the worker can read them. */
export interface TitleSettings {
  enabled: boolean;
  modelId: string | null;
}

export const DEFAULT_TITLE_SETTINGS: TitleSettings = { enabled: true, modelId: null };

/** Server-owned Muse sandbox posture: whether `muse serve` hosts spawn with `--disable-sandbox`. Off by default. */
export interface SandboxSettings {
  disabled: boolean;
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = { disabled: false };

/**
 * Server-owned YOLO mode: the `muse --yolo` posture for every host it spawns
 * (`--disable-sandbox --trust-workspace`) plus the wire-level approval bypass.
 * Off by default.
 */
export interface YoloSettings {
  enabled: boolean;
}

export const DEFAULT_YOLO_SETTINGS: YoloSettings = { enabled: false };

function nowIso(): string {
  return new Date().toISOString();
}

function displayNameFor(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function isTitleSource(value: unknown): value is TitleSource {
  return value === "placeholder" || value === "auto" || value === "user";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cwd TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL DEFAULT 'New session',
  status TEXT NOT NULL DEFAULT 'active',
  turn_count INTEGER NOT NULL DEFAULT 0,
  model_id TEXT,
  origin TEXT NOT NULL DEFAULT 'ancilla',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  ord INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  width INTEGER,
  height INTEGER,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  output TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  model_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_usage (
  scope TEXT PRIMARY KEY,
  observed_at_ms INTEGER NOT NULL,
  usage TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), command_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, question TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL,
  report TEXT, failure TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
CREATE TABLE IF NOT EXISTS research_events (
  run_id TEXT NOT NULL REFERENCES research_runs(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
  at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS research_workers (
  run_id TEXT NOT NULL REFERENCES research_runs(id), worker_session_id TEXT NOT NULL,
  round INTEGER NOT NULL, agent_id INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (run_id, worker_session_id));
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_shell_runs_session ON shell_runs(session_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_research_runs_session ON research_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_research_events_run ON research_events(run_id, seq);
`;

/** Columns added after the first release; applied in place so existing databases keep their data. */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "projects", column: "hidden", ddl: "ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0" },
  { table: "projects", column: "position", ddl: "ALTER TABLE projects ADD COLUMN position INTEGER" },
  {
    table: "sessions",
    column: "title_source",
    ddl: "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'placeholder'",
  },
  { table: "sessions", column: "activity_at", ddl: "ALTER TABLE sessions ADD COLUMN activity_at TEXT" },
  { table: "sessions", column: "archived", ddl: "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "settled_override", ddl: "ALTER TABLE sessions ADD COLUMN settled_override TEXT" },
  { table: "sessions", column: "settled_at", ddl: "ALTER TABLE sessions ADD COLUMN settled_at TEXT" },
  { table: "sessions", column: "unsettled_at", ddl: "ALTER TABLE sessions ADD COLUMN unsettled_at TEXT" },
  // NULL for sessions recorded before posture tracking; only new rows carry a value.
  { table: "sessions", column: "sandbox_disabled", ddl: "ALTER TABLE sessions ADD COLUMN sandbox_disabled INTEGER" },
  // NULL = the default Muse login, i.e. today's behaviour; only sessions started under a profile carry an id.
  { table: "sessions", column: "account_id", ddl: "ALTER TABLE sessions ADD COLUMN account_id TEXT" },
  { table: "projects", column: "default_account_id", ddl: "ALTER TABLE projects ADD COLUMN default_account_id TEXT" },
  // NULL until the user picks a model for the thread; model_id alone is whatever Muse last reported.
  { table: "sessions", column: "chosen_model_id", ddl: "ALTER TABLE sessions ADD COLUMN chosen_model_id TEXT" },
  // A row with a parent is a folder inside that project, never a project of its own. One level deep only.
  { table: "projects", column: "parent_id", ddl: "ALTER TABLE projects ADD COLUMN parent_id INTEGER REFERENCES projects(id)" },
  // Where a research report was written inside the workspace, relative to the project folder; NULL until it was.
  { table: "research_runs", column: "report_path", ddl: "ALTER TABLE research_runs ADD COLUMN report_path TEXT" },
];

type Row = Record<string, string | number | null>;

/** A file the user attached to a prompt. `kind` is "image" when Muse saw it, "file" when it went to the workspace. */
export interface AttachmentRecord {
  id: string;
  sessionId: string;
  turnId: string | null;
  ord: number;
  name: string;
  mediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface AddAttachmentInput {
  id: string;
  sessionId: string;
  turnId: string | null;
  ord: number;
  name: string;
  mediaType: string;
  kind: "image" | "file";
  width?: number | null;
  height?: number | null;
  bytes: Uint8Array;
}

/** A `!` command Ancilla ran itself, with what it printed. */
export interface ShellRunRecord {
  id: string;
  sessionId: string;
  command: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number | null;
  at: string;
}

/** One model call's tokens, as the store keeps them for the usage page. */
export interface UsageCall {
  key: string;
  sessionId: string;
  turnId: string | null;
  modelId: string | null;
  promptTokens: number;
  outputTokens: number;
  inputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number | null;
  at: string;
}

export interface UsageRow extends UsageCall {
  sessionTitle: string | null;
  projectCwd: string | null;
}

/** One DeepResearch run on a thread. `config` and `state` are kept as JSON text and parsed on the way out. */
export interface ResearchRunRecord {
  id: string;
  sessionId: string;
  /** The client's idempotency handle: a repeated start with the same one returns this run. */
  commandId: string;
  status: ResearchStatus;
  question: string;
  config: ResearchConfig;
  /** The engine's checkpoint; null before the first one. */
  state: ResearchRunState | null;
  report: string | null;
  failure: string | null;
  /** Where the report was written, relative to the project folder; null until it was. */
  reportPath: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface CreateResearchRunInput {
  id: string;
  sessionId: string;
  commandId: string;
  question: string;
  config: ResearchConfig;
  status?: ResearchStatus;
  createdAt?: string;
}

export interface ResearchRunPatch {
  status?: ResearchStatus;
  state?: ResearchRunState | null;
  report?: string | null;
  failure?: string | null;
  reportPath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

/**
 * A stored research state is trusted only when it has the shape the engine writes: version 1 with its four list
 * fields present. Anything else (an older or hand-edited row, a `{}`) comes back as null, which every reader
 * treats as "no checkpoint yet" instead of dereferencing a field that is not there; `researchStateProblem` says
 * why for a log line.
 */
export function researchStateProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value === null ? null : "state is not an object";
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) {
    return `state version ${JSON.stringify(record["version"] ?? null)} is not 1`;
  }
  for (const field of ["rounds", "registry", "curated", "notes"]) {
    if (!Array.isArray(record[field])) {
      return `state.${field} is not an array`;
    }
  }
  return null;
}

export function readResearchState(value: unknown): ResearchRunState | null {
  return value !== null && researchStateProblem(value) === null ? (value as ResearchRunState) : null;
}

/** A row in `research_workers`: which Muse session did which delegated task. */
export interface ResearchWorkerRecord {
  runId: string;
  workerSessionId: string;
  round: number;
  agentId: number;
  status: "working" | WorkerStatus;
}

function toAttachment(row: Row): AttachmentRecord {
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    turnId: row["turn_id"] === null ? null : String(row["turn_id"]),
    ord: Number(row["ord"] ?? 0),
    name: String(row["name"]),
    mediaType: String(row["media_type"]),
    kind: row["kind"] === "file" ? "file" : "image",
    width: row["width"] === null ? null : Number(row["width"]),
    height: row["height"] === null ? null : Number(row["height"]),
    createdAt: String(row["created_at"]),
  };
}

export class AncillaStore {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    for (const migration of MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${migration.table})`).all() as Row[];
      if (!columns.some((c) => c["name"] === migration.column)) {
        this.db.exec(migration.ddl);
      }
    }
  }

  /** Cached quota observations are keyed by the runtime and login fingerprint supplied by the server. */
  getSubscriptionUsage(scope: string): SubscriptionUsage | null {
    const row = this.db.prepare("SELECT usage FROM subscription_usage WHERE scope = ?").get(scope) as Row | undefined;
    if (!row) return null;
    try { return parseSubscriptionUsage(JSON.parse(String(row["usage"]))); } catch { return null; }
  }

  setSubscriptionUsage(scope: string, usage: SubscriptionUsage): void {
    this.db.prepare(`INSERT INTO subscription_usage (scope, observed_at_ms, usage) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET observed_at_ms = excluded.observed_at_ms, usage = excluded.usage
      WHERE excluded.observed_at_ms > subscription_usage.observed_at_ms`).run(scope, usage.observedAtMs, JSON.stringify(usage));
    // Login changes can leave older scopes behind; retain only a small recent observation cache.
    this.db.prepare(`DELETE FROM subscription_usage WHERE scope NOT IN
      (SELECT scope FROM subscription_usage ORDER BY observed_at_ms DESC LIMIT 64)`).run();
  }

  /** Malformed rows fall back to defaults rather than breaking the worker that reads them. */
  getTitleSettings(): TitleSettings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'title'`).get() as Row | undefined;
    if (!row) {
      return { ...DEFAULT_TITLE_SETTINGS };
    }
    try {
      const parsed = JSON.parse(String(row["value"])) as Partial<TitleSettings>;
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_TITLE_SETTINGS.enabled,
        modelId: typeof parsed.modelId === "string" && parsed.modelId.trim().length > 0 ? parsed.modelId : null,
      };
    } catch {
      return { ...DEFAULT_TITLE_SETTINGS };
    }
  }

  setTitleSettings(patch: Partial<TitleSettings>): TitleSettings {
    const current = this.getTitleSettings();
    const next: TitleSettings = {
      enabled: patch.enabled ?? current.enabled,
      modelId: patch.modelId !== undefined ? patch.modelId : current.modelId,
    };
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('title', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }

  /** Malformed rows fall back to sandbox-on rather than breaking host startup. */
  getSandboxSettings(): SandboxSettings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'sandbox'`).get() as Row | undefined;
    if (!row) {
      return { ...DEFAULT_SANDBOX_SETTINGS };
    }
    try {
      const parsed = JSON.parse(String(row["value"])) as Partial<SandboxSettings>;
      return {
        disabled: typeof parsed.disabled === "boolean" ? parsed.disabled : DEFAULT_SANDBOX_SETTINGS.disabled,
      };
    } catch {
      return { ...DEFAULT_SANDBOX_SETTINGS };
    }
  }

  setSandboxSettings(patch: Partial<SandboxSettings>): SandboxSettings {
    const current = this.getSandboxSettings();
    const next: SandboxSettings = {
      disabled: patch.disabled ?? current.disabled,
    };
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('sandbox', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }

  /** Malformed rows fall back to YOLO-off rather than breaking host startup. */
  getYoloSettings(): YoloSettings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'yolo'`).get() as Row | undefined;
    if (!row) {
      return { ...DEFAULT_YOLO_SETTINGS };
    }
    try {
      const parsed = JSON.parse(String(row["value"])) as Partial<YoloSettings>;
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_YOLO_SETTINGS.enabled,
      };
    } catch {
      return { ...DEFAULT_YOLO_SETTINGS };
    }
  }

  setYoloSettings(patch: Partial<YoloSettings>): YoloSettings {
    const current = this.getYoloSettings();
    const next: YoloSettings = {
      enabled: patch.enabled ?? current.enabled,
    };
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('yolo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }

  /** Malformed rows fall back to the defaults rather than refusing every research start. */
  getResearchSettings(): ResearchSettings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'research'`).get() as Row | undefined;
    if (!row) {
      return { enabled: DEFAULT_RESEARCH_SETTINGS.enabled, config: resolveResearchConfig(null) };
    }
    try {
      const parsed = JSON.parse(String(row["value"])) as Partial<ResearchSettings>;
      return {
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_RESEARCH_SETTINGS.enabled,
        config: resolveResearchConfig(parsed.config ?? null),
      };
    } catch {
      return { enabled: DEFAULT_RESEARCH_SETTINGS.enabled, config: resolveResearchConfig(null) };
    }
  }

  /** A partial config is merged over the stored one and every number clamped, so the row never holds a bad value. */
  setResearchSettings(patch: { enabled?: boolean; config?: Partial<ResearchConfig> | null }): ResearchSettings {
    const current = this.getResearchSettings();
    const next: ResearchSettings = {
      enabled: patch.enabled ?? current.enabled,
      config: resolveResearchConfig(patch.config ?? null, current.config),
    };
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('research', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }

  // ---------------------------------------------------------------- deep research

  createResearchRun(input: CreateResearchRunInput): ResearchRunRecord {
    this.db
      .prepare(
        `INSERT INTO research_runs (id, session_id, command_id, status, question, config, state, report, failure, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'null', NULL, NULL, ?)`,
      )
      .run(input.id, input.sessionId, input.commandId, input.status ?? "queued", input.question, JSON.stringify(input.config), input.createdAt ?? nowIso());
    return this.getResearchRun(input.id) as ResearchRunRecord;
  }

  updateResearchRun(id: string, patch: ResearchRunPatch): ResearchRunRecord | null {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.state !== undefined) {
      sets.push("state = ?");
      values.push(JSON.stringify(patch.state));
    }
    if (patch.report !== undefined) {
      sets.push("report = ?");
      values.push(patch.report);
    }
    if (patch.failure !== undefined) {
      sets.push("failure = ?");
      values.push(patch.failure);
    }
    if (patch.reportPath !== undefined) {
      sets.push("report_path = ?");
      values.push(patch.reportPath);
    }
    if (patch.startedAt !== undefined) {
      sets.push("started_at = ?");
      values.push(patch.startedAt);
    }
    if (patch.endedAt !== undefined) {
      sets.push("ended_at = ?");
      values.push(patch.endedAt);
    }
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE research_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getResearchRun(id);
  }

  getResearchRun(id: string): ResearchRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM research_runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? this.toResearchRun(row) : null;
  }

  getResearchRunByCommand(commandId: string): ResearchRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM research_runs WHERE command_id = ?`).get(commandId) as Row | undefined;
    return row ? this.toResearchRun(row) : null;
  }

  /** A thread's runs, oldest first, so a transcript can merge them by time. */
  listResearchRuns(sessionId: string): ResearchRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM research_runs WHERE session_id = ? ORDER BY created_at, id`)
      .all(sessionId) as Row[];
    return rows.map((row) => this.toResearchRun(row));
  }

  /** Runs that were in flight, queued or running, which a starting server must mark interrupted. */
  listRunningResearchRuns(): ResearchRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM research_runs WHERE status IN ('queued', 'running') ORDER BY created_at, id`)
      .all() as Row[];
    return rows.map((row) => this.toResearchRun(row));
  }

  /** Idempotent on (run, seq): an event replayed after a resume is kept once. Returns whether it was new. */
  appendResearchEvent(event: ResearchEvent): boolean {
    const payload = JSON.stringify({
      phase: event.phase,
      round: event.round,
      agentId: event.agentId,
      payload: event.payload,
    });
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO research_events (run_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(event.runId, event.seq, event.type, event.at, payload);
    return Number(result.changes) > 0;
  }

  listResearchEvents(runId: string, afterSeq = 0, limit = 500): ResearchEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM research_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(runId, afterSeq, Math.max(1, limit)) as Row[];
    return rows.map((row) => {
      let extra: Record<string, unknown> = {};
      try {
        extra = (JSON.parse(String(row["payload"])) as Record<string, unknown>) ?? {};
      } catch {
        /* a payload nobody can read is still an event */
      }
      return {
        type: String(row["type"]) as ResearchEvent["type"],
        runId: String(row["run_id"]),
        seq: Number(row["seq"]),
        at: String(row["at"]),
        phase: (extra["phase"] as ResearchEvent["phase"]) ?? null,
        round: typeof extra["round"] === "number" ? extra["round"] : null,
        agentId: typeof extra["agentId"] === "number" ? extra["agentId"] : null,
        payload: typeof extra["payload"] === "object" && extra["payload"] !== null ? (extra["payload"] as Record<string, unknown>) : {},
      };
    });
  }

  /** The highest event number a run has, so a host-made event can follow the engine's. */
  lastResearchEventSeq(runId: string): number {
    const row = this.db.prepare(`SELECT MAX(seq) AS seq FROM research_events WHERE run_id = ?`).get(runId) as Row | undefined;
    return row && row["seq"] !== null && row["seq"] !== undefined ? Number(row["seq"]) : 0;
  }

  addResearchWorker(worker: ResearchWorkerRecord): ResearchWorkerRecord {
    this.db
      .prepare(
        `INSERT INTO research_workers (run_id, worker_session_id, round, agent_id, status) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, worker_session_id) DO UPDATE SET status = excluded.status`,
      )
      .run(worker.runId, worker.workerSessionId, worker.round, worker.agentId, worker.status);
    return worker;
  }

  updateResearchWorker(runId: string, workerSessionId: string, status: ResearchWorkerRecord["status"]): void {
    this.db.prepare(`UPDATE research_workers SET status = ? WHERE run_id = ? AND worker_session_id = ?`).run(status, runId, workerSessionId);
  }

  listResearchWorkers(runId: string): ResearchWorkerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM research_workers WHERE run_id = ? ORDER BY round, agent_id`)
      .all(runId) as Row[];
    return rows.map((row) => ({
      runId: String(row["run_id"]),
      workerSessionId: String(row["worker_session_id"]),
      round: Number(row["round"]),
      agentId: Number(row["agent_id"]),
      status: String(row["status"]) as ResearchWorkerRecord["status"],
    }));
  }

  upsertProject(cwd: string): Project {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (cwd, display_name, pinned, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(cwd, displayNameFor(cwd), now, now);
    return this.getProject(cwd) as Project;
  }

  /** The row for a cwd, whether it is a project of its own or a folder inside one. */
  getProject(cwd: string): Project | null {
    const row = this.db
      .prepare(`SELECT p.*, ${this.projectActivitySql()} AS activity_at FROM projects p WHERE p.cwd = ?`)
      .get(cwd) as Row | undefined;
    return row ? this.toProject(row) : null;
  }

  /** The project that owns a cwd: the row itself when it is top-level, else the project it is a folder of. */
  projectForFolder(cwd: string): Project | null {
    const row = this.db.prepare(`SELECT id, parent_id FROM projects WHERE cwd = ?`).get(cwd) as Row | undefined;
    if (!row) {
      return null;
    }
    const id = row["parent_id"] === null || row["parent_id"] === undefined ? Number(row["id"]) : Number(row["parent_id"]);
    const owner = this.db
      .prepare(`SELECT p.*, ${this.projectActivitySql()} AS activity_at FROM projects p WHERE p.id = ?`)
      .get(id) as Row | undefined;
    return owner ? this.toProject(owner) : null;
  }

  /** Top-level projects only; a folder inside a project is listed under it, never on its own. */
  listProjects(options: { includeHidden?: boolean } = {}): Project[] {
    const where = options.includeHidden ? "" : "AND p.hidden = 0";
    const rows = this.db
      .prepare(
        `SELECT p.*, ${this.projectActivitySql()} AS activity_at
         FROM projects p WHERE p.parent_id IS NULL ${where}
         ORDER BY p.pinned DESC, p.position IS NULL, p.position, activity_at DESC, p.id DESC`,
      )
      .all() as Row[];
    return rows.map((row) => this.toProject(row));
  }

  /** Every folder row, top-level or inside a project, for callers that need each workspace root. */
  listFolders(options: { includeHidden?: boolean } = {}): Project[] {
    const where = options.includeHidden ? "" : "WHERE p.hidden = 0";
    const rows = this.db
      .prepare(`SELECT p.*, ${this.projectActivitySql()} AS activity_at FROM projects p ${where} ORDER BY p.id`)
      .all() as Row[];
    return rows.map((row) => this.toProject(row));
  }

  /**
   * Makes `folderCwd` a folder of the project at `projectCwd`. A folder that was a project of its own keeps its
   * row, so its sessions come along; it just stops being listed on its own. Refused when the two are the same
   * folder, when the project is itself a folder inside another, or when the folder has folders of its own.
   */
  addProjectFolder(projectCwd: string, folderCwd: string): Project {
    if (folderCwd === projectCwd) {
      throw new ProjectFolderError("A project cannot be a folder of itself.");
    }
    const parent = this.db.prepare(`SELECT id, parent_id, display_name FROM projects WHERE cwd = ?`).get(projectCwd) as Row | undefined;
    if (!parent) {
      throw new ProjectFolderError("Unknown project.");
    }
    if (parent["parent_id"] !== null && parent["parent_id"] !== undefined) {
      throw new ProjectFolderError(`${parent["display_name"]} is itself a folder of another project. Add the folder to that project instead.`);
    }
    this.upsertProject(folderCwd);
    const folder = this.db.prepare(`SELECT id, display_name, parent_id FROM projects WHERE cwd = ?`).get(folderCwd) as Row;
    if (folder["parent_id"] === parent["id"]) {
      return this.getProject(projectCwd) as Project;
    }
    if (folder["parent_id"] !== null && folder["parent_id"] !== undefined) {
      // Never moved out from under another project on the quiet: its threads would leave that project with it.
      const other = this.db.prepare(`SELECT display_name FROM projects WHERE id = ?`).get(folder["parent_id"]) as Row | undefined;
      throw new ProjectFolderError(`${folder["display_name"]} is already a folder of ${other?.["display_name"] ?? "another project"}. Remove it there first.`);
    }
    const nested = this.db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE parent_id = ?`).get(folder["id"]) as Row;
    if (Number(nested["n"]) > 0) {
      throw new ProjectFolderError(`${folder["display_name"]} is a project with folders of its own. Remove its folders first.`);
    }
    // A folder has no place of its own in the sidebar order, so its pin goes with its independence; its position
    // is now its place among the project's folders, after the ones already there.
    const last = this.db.prepare(`SELECT COALESCE(MAX(position), 0) AS n FROM projects WHERE parent_id = ?`).get(parent["id"]) as Row;
    this.db
      .prepare(`UPDATE projects SET parent_id = ?, hidden = 0, pinned = 0, position = ?, updated_at = ? WHERE id = ?`)
      .run(parent["id"], Number(last["n"]) + 1, nowIso(), folder["id"]);
    // A folder added to a project the user had removed from the sidebar brings the project back with it.
    this.setHidden(projectCwd, false);
    return this.getProject(projectCwd) as Project;
  }

  /** Brings back the project a folder belongs to, every folder with it: the one place an unhide by folder goes. */
  revealProject(cwd: string): void {
    this.setHidden(this.projectForFolder(cwd)?.cwd ?? cwd, false);
  }

  /** Takes a folder out of its project. It becomes a project of its own again, visible, so no thread disappears. */
  removeProjectFolder(projectCwd: string, folderCwd: string): Project {
    const parent = this.db.prepare(`SELECT id FROM projects WHERE cwd = ?`).get(projectCwd) as Row | undefined;
    if (!parent) {
      throw new ProjectFolderError("Unknown project.");
    }
    const folder = this.db.prepare(`SELECT id, parent_id FROM projects WHERE cwd = ?`).get(folderCwd) as Row | undefined;
    if (!folder || folder["parent_id"] !== parent["id"]) {
      throw new ProjectFolderError("That folder is not part of this project.");
    }
    this.db.prepare(`UPDATE projects SET parent_id = NULL, hidden = 0, position = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), folder["id"]);
    return this.getProject(projectCwd) as Project;
  }

  /** A `!` command Ancilla ran itself in the workspace, kept so a reopened thread still shows it. */
  addShellRun(input: ShellRunRecord): ShellRunRecord {
    this.db
      .prepare(
        `INSERT INTO shell_runs (id, session_id, command, exit_code, output, truncated, duration_ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.command,
        input.exitCode ?? null,
        input.output,
        input.truncated ? 1 : 0,
        input.durationMs ?? null,
        input.at,
      );
    return input;
  }

  listShellRuns(sessionId: string): ShellRunRecord[] {
    const rows = this.db.prepare(`SELECT * FROM shell_runs WHERE session_id = ? ORDER BY at`).all(sessionId) as Row[];
    return rows.map((row) => ({
      id: String(row["id"]),
      sessionId: String(row["session_id"]),
      command: String(row["command"]),
      exitCode: row["exit_code"] === null ? null : Number(row["exit_code"]),
      output: String(row["output"] ?? ""),
      truncated: Number(row["truncated"] ?? 0) === 1,
      durationMs: row["duration_ms"] === null ? null : Number(row["duration_ms"]),
      at: String(row["at"]),
    }));
  }

  /**
   * One model call's tokens. Keyed by the view cursor that carried it, so replaying a thread's history
   * never counts a call twice.
   */
  recordUsage(call: UsageCall): void {
    this.db
      .prepare(
        `INSERT INTO usage (key, session_id, turn_id, model_id, prompt_tokens, output_tokens, input_tokens,
           cached_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, duration_ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(
        call.key,
        call.sessionId,
        call.turnId ?? null,
        call.modelId ?? null,
        call.promptTokens,
        call.outputTokens,
        call.inputTokens,
        call.cachedTokens,
        call.cacheReadTokens,
        call.cacheWriteTokens,
        call.reasoningTokens,
        call.durationMs ?? null,
        call.at,
      );
  }

  /** Every recorded call since `since`, newest last, with the thread and the project (not the folder) it belongs to. */
  listUsage(since?: string): UsageRow[] {
    const rows = this.db
      .prepare(
        `SELECT u.*, s.title AS session_title, COALESCE(owner.cwd, p.cwd) AS project_cwd
         FROM usage u
         LEFT JOIN sessions s ON s.id = u.session_id
         LEFT JOIN projects p ON p.id = s.project_id
         LEFT JOIN projects owner ON owner.id = p.parent_id
         ${since ? "WHERE u.at >= ?" : ""}
         ORDER BY u.at`,
      )
      .all(...(since ? [since] : [])) as Row[];
    return rows.map((row) => ({
      key: String(row["key"]),
      sessionId: String(row["session_id"]),
      turnId: row["turn_id"] === null ? null : String(row["turn_id"]),
      modelId: row["model_id"] === null ? null : String(row["model_id"]),
      promptTokens: Number(row["prompt_tokens"] ?? 0),
      outputTokens: Number(row["output_tokens"] ?? 0),
      inputTokens: Number(row["input_tokens"] ?? 0),
      cachedTokens: Number(row["cached_tokens"] ?? 0),
      cacheReadTokens: Number(row["cache_read_tokens"] ?? 0),
      cacheWriteTokens: Number(row["cache_write_tokens"] ?? 0),
      reasoningTokens: Number(row["reasoning_tokens"] ?? 0),
      durationMs: row["duration_ms"] === null ? null : Number(row["duration_ms"]),
      at: String(row["at"]),
      sessionTitle: row["session_title"] === null || row["session_title"] === undefined ? null : String(row["session_title"]),
      projectCwd: row["project_cwd"] === null || row["project_cwd"] === undefined ? null : String(row["project_cwd"]),
    }));
  }

  /** The order the user dragged projects into; anything not listed keeps falling back to recent activity. */
  setProjectOrder(cwds: string[]): void {
    const now = nowIso();
    const update = this.db.prepare(`UPDATE projects SET position = ?, updated_at = ? WHERE cwd = ? AND parent_id IS NULL`);
    cwds.forEach((cwd, index) => update.run(index, now, cwd));
  }

  /** Pins are a top-level affair: a folder inside a project has no row of its own in the sidebar. */
  setPinned(cwd: string, pinned: boolean): void {
    this.db
      .prepare(`UPDATE projects SET pinned = ?, updated_at = ? WHERE cwd = ? AND parent_id IS NULL`)
      .run(pinned ? 1 : 0, nowIso(), cwd);
  }

  /** Hiding removes a project from the sidebar without touching Muse's own session data. Its folders go with it. */
  setHidden(cwd: string, hidden: boolean): void {
    this.db
      .prepare(
        `UPDATE projects SET hidden = ?, updated_at = ?
         WHERE cwd = ? OR parent_id = (SELECT id FROM projects WHERE cwd = ?)`,
      )
      .run(hidden ? 1 : 0, nowIso(), cwd, cwd);
  }

  /** Which account new threads here default to; null clears it back to the default login. */
  setDefaultAccount(cwd: string, accountId: string | null): void {
    this.db
      .prepare(`UPDATE projects SET default_account_id = ?, updated_at = ? WHERE cwd = ?`)
      .run(accountId, nowIso(), cwd);
  }

  /**
   * Files the user attached to a prompt. Muse keeps only their metadata on the view, so the bytes live here
   * and a reopened thread can still show what was sent.
   */
  addAttachment(input: AddAttachmentInput): AttachmentRecord {
    this.db
      .prepare(
        `INSERT INTO attachments (id, session_id, turn_id, ord, name, media_type, kind, width, height, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.turnId ?? null,
        input.ord,
        input.name,
        input.mediaType,
        input.kind,
        input.width ?? null,
        input.height ?? null,
        input.bytes,
        nowIso(),
      );
    return this.getAttachment(input.id) as AttachmentRecord;
  }

  listAttachments(sessionId: string): AttachmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, turn_id, ord, name, media_type, kind, width, height, created_at
         FROM attachments WHERE session_id = ? ORDER BY created_at, ord`,
      )
      .all(sessionId) as Row[];
    return rows.map((row) => toAttachment(row));
  }

  getAttachment(id: string): AttachmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, session_id, turn_id, ord, name, media_type, kind, width, height, created_at
         FROM attachments WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? toAttachment(row) : null;
  }

  /** The stored bytes, for serving one attachment back to the UI. */
  readAttachment(id: string): { record: AttachmentRecord; bytes: Uint8Array } | null {
    const row = this.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as (Row & { bytes?: unknown }) | undefined;
    if (!row || !(row.bytes instanceof Uint8Array)) {
      return null;
    }
    return { record: toAttachment(row), bytes: row.bytes };
  }

  recordSession(input: RecordSessionInput): SessionRecord {
    const now = nowIso();
    const existing = this.getSession(input.id);
    if (!existing) {
      const titleSource = input.titleSource ?? (input.title ? "auto" : "placeholder");
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_id, title, title_source, status, turn_count, model_id, chosen_model_id, origin,
             archived, sandbox_disabled, account_id, created_at, updated_at, activity_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.title ?? PLACEHOLDER_TITLE,
          titleSource,
          input.turnCount ?? 0,
          input.modelId ?? null,
          input.chosenModelId ?? null,
          input.origin ?? "ancilla",
          input.sandboxDisabled === undefined || input.sandboxDisabled === null ? null : input.sandboxDisabled ? 1 : 0,
          input.accountId ?? null,
          input.createdAt ?? now,
          now,
          input.activityAt ?? input.createdAt ?? now,
        );
      return this.getSession(input.id) as SessionRecord;
    }
    const patch: SessionPatch = {};
    if (input.title !== undefined) {
      const incoming = input.titleSource ?? "auto";
      if (TITLE_RANK[incoming] >= TITLE_RANK[existing.titleSource]) {
        patch.title = input.title;
        patch.titleSource = incoming;
      }
    }
    if (input.modelId !== undefined && input.modelId !== null) {
      patch.modelId = input.modelId;
    }
    if (input.turnCount !== undefined && input.turnCount > existing.turnCount) {
      patch.turnCount = input.turnCount;
    }
    if (input.activityAt !== undefined && input.activityAt > existing.activityAt) {
      patch.activityAt = input.activityAt;
    }
    if (existing.projectId !== input.projectId) {
      this.db.prepare(`UPDATE sessions SET project_id = ? WHERE id = ?`).run(input.projectId, input.id);
    }
    return this.updateSession(input.id, patch) ?? existing;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    return row ? this.toSession(row) : null;
  }

  /** The session plus the project directory it belongs to, in one lookup. */
  findSession(id: string): { session: SessionRecord; cwd: string } | null {
    const row = this.db
      .prepare(`SELECT s.*, p.cwd AS project_cwd FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`)
      .get(id) as Row | undefined;
    return row ? { session: this.toSession(row), cwd: String(row["project_cwd"]) } : null;
  }

  listSessionsByProject(projectId: number, options: { includeArchived?: boolean } = {}): SessionRecord[] {
    const archived = options.includeArchived ? "" : "AND archived = 0";
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE project_id = ? ${archived}
         ORDER BY COALESCE(activity_at, updated_at) DESC`,
      )
      .all(projectId) as Row[];
    return rows.map((row) => this.toSession(row));
  }

  updateSession(id: string, patch: SessionPatch): SessionRecord | null {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.titleSource !== undefined) {
      sets.push("title_source = ?");
      values.push(patch.titleSource);
    }
    if (patch.archived !== undefined) {
      sets.push("archived = ?");
      values.push(patch.archived ? 1 : 0);
    }
    if (patch.modelId !== undefined) {
      sets.push("model_id = ?");
      values.push(patch.modelId);
    }
    if (patch.chosenModelId !== undefined) {
      sets.push("chosen_model_id = ?");
      values.push(patch.chosenModelId);
    }
    if (patch.turnCount !== undefined) {
      sets.push("turn_count = ?");
      values.push(patch.turnCount);
    }
    if (patch.activityAt !== undefined) {
      sets.push("activity_at = ?");
      values.push(patch.activityAt);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.settledOverride !== undefined) {
      sets.push("settled_override = ?");
      values.push(patch.settledOverride);
    }
    if (patch.settledAt !== undefined) {
      sets.push("settled_at = ?");
      values.push(patch.settledAt);
    }
    if (patch.unsettledAt !== undefined) {
      sets.push("unsettled_at = ?");
      values.push(patch.unsettledAt);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      values.push(nowIso());
      this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.getSession(id);
  }

  /** Visible threads with no settle choice whose last activity is older than `before`. */
  listSettleCandidates(before: string): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE settled_override IS NULL AND archived = 0 AND COALESCE(activity_at, updated_at) < ?`,
      )
      .all(before) as Row[];
    return rows.map((row) => this.toSession(row));
  }

  recordTurn(id: string, sessionId: string): TurnRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, status, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(id, sessionId, now, now);
    this.db
      .prepare(
        `UPDATE sessions SET turn_count = turn_count + 1, updated_at = ?, activity_at = ? WHERE id = ?`,
      )
      .run(now, now, sessionId);
    return this.getTurn(id);
  }

  updateTurnStatus(id: string, status: string): void {
    this.db
      .prepare(`UPDATE turns SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
  }

  close(): void {
    this.db.close();
  }

  /** A project's latest activity counts the sessions in its folders too, so it sorts by all of its threads. */
  private projectActivitySql(): string {
    return `COALESCE((SELECT MAX(COALESCE(s.activity_at, s.updated_at)) FROM sessions s
      JOIN projects f ON f.id = s.project_id
      WHERE (f.id = p.id OR f.parent_id = p.id) AND s.archived = 0), p.created_at)`;
  }

  /** The project's own folder first, then the ones added to it, in the order they were added. */
  private foldersOf(row: Row): ProjectFolder[] {
    const self = { cwd: String(row["cwd"]), displayName: String(row["display_name"]) };
    // A folder inside a project has none of its own, so it is spared the query.
    if (row["parent_id"] !== null && row["parent_id"] !== undefined) {
      return [self];
    }
    const children = this.db
      .prepare(
        `SELECT cwd, display_name FROM projects WHERE parent_id = ?
         ORDER BY position IS NULL, position, created_at, id`,
      )
      .all(row["id"]) as Row[];
    return [self, ...children.map((child) => ({ cwd: String(child["cwd"]), displayName: String(child["display_name"]) }))];
  }

  private getTurn(id: string): TurnRecord {
    const row = this.db.prepare(`SELECT * FROM turns WHERE id = ?`).get(id) as Row | undefined;
    if (!row) {
      throw new Error(`AncillaStore: unknown turn ${id}.`);
    }
    return {
      id: String(row["id"]),
      sessionId: String(row["session_id"]),
      status: String(row["status"]),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  }

  private toProject(row: Row): Project {
    return {
      id: Number(row["id"]),
      cwd: String(row["cwd"]),
      displayName: String(row["display_name"]),
      pinned: Number(row["pinned"]) === 1,
      hidden: Number(row["hidden"] ?? 0) === 1,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      activityAt: String(row["activity_at"] ?? row["created_at"]),
      defaultAccountId: row["default_account_id"] === null || row["default_account_id"] === undefined ? null : String(row["default_account_id"]),
      folders: this.foldersOf(row),
    };
  }

  private toResearchRun(row: Row): ResearchRunRecord {
    let config: ResearchConfig;
    try {
      config = resolveResearchConfig(JSON.parse(String(row["config"])) as Partial<ResearchConfig>);
    } catch {
      config = resolveResearchConfig(null);
    }
    let state: ResearchRunState | null = null;
    try {
      state = readResearchState(JSON.parse(String(row["state"] ?? "null")));
    } catch {
      state = null;
    }
    return {
      id: String(row["id"]),
      sessionId: String(row["session_id"]),
      commandId: String(row["command_id"]),
      status: String(row["status"]) as ResearchStatus,
      question: String(row["question"]),
      config,
      state,
      report: row["report"] === null || row["report"] === undefined ? null : String(row["report"]),
      failure: row["failure"] === null || row["failure"] === undefined ? null : String(row["failure"]),
      reportPath: row["report_path"] === null || row["report_path"] === undefined ? null : String(row["report_path"]),
      createdAt: String(row["created_at"]),
      startedAt: row["started_at"] === null || row["started_at"] === undefined ? null : String(row["started_at"]),
      endedAt: row["ended_at"] === null || row["ended_at"] === undefined ? null : String(row["ended_at"]),
    };
  }

  private toSession(row: Row): SessionRecord {
    const titleSource = row["title_source"];
    return {
      id: String(row["id"]),
      projectId: Number(row["project_id"]),
      title: String(row["title"]),
      titleSource: isTitleSource(titleSource) ? titleSource : "placeholder",
      status: String(row["status"]),
      turnCount: Number(row["turn_count"]),
      modelId: row["model_id"] === null ? null : String(row["model_id"]),
      chosenModelId: row["chosen_model_id"] === null || row["chosen_model_id"] === undefined ? null : String(row["chosen_model_id"]),
      origin: String(row["origin"]),
      archived: Number(row["archived"] ?? 0) === 1,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      activityAt: String(row["activity_at"] ?? row["updated_at"]),
      settledOverride: row["settled_override"] === "settled" || row["settled_override"] === "active" ? row["settled_override"] : null,
      settledAt: row["settled_at"] === null || row["settled_at"] === undefined ? null : String(row["settled_at"]),
      unsettledAt: row["unsettled_at"] === null || row["unsettled_at"] === undefined ? null : String(row["unsettled_at"]),
      sandboxDisabled: row["sandbox_disabled"] === null || row["sandbox_disabled"] === undefined ? null : Number(row["sandbox_disabled"]) === 1,
      accountId: row["account_id"] === null || row["account_id"] === undefined ? null : String(row["account_id"]),
    };
  }
}
