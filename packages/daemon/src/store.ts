import { DatabaseSync } from "node:sqlite";
import { parseSubscriptionUsage, type SubscriptionUsage } from "./sessions.js";
import {
  normalizeProviderId,
  type ProviderId,
  type SessionJournal,
  type StoredJournalEvent,
} from "./providers/types.js";
import { DEFAULT_RESEARCH_SETTINGS, resolveResearchConfig, type ResearchConfig, type ResearchSettings } from "./research/config.js";
import type { ResearchEvent, ResearchRunState, ResearchStatus, WorkerStatus } from "./research/types.js";

export type ApiProviderKind = "openai" | "anthropic" | "google";

export interface ProviderAccountRecord {
  id: string;
  providerId: ProviderId;
  name: string;
  runtimeOverride: string | null;
  binaryPath: string | null;
  customArgs: string[];
  apiKind: ApiProviderKind | null;
  apiBaseUrl: string | null;
  secretKeyId: string | null;
  stripAmbientKeys: boolean;
  defaultModelId: string | null;
  customModels: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface UpsertProviderAccountInput {
  id: string;
  providerId: ProviderId;
  name: string;
  runtimeOverride?: string | null;
  binaryPath?: string | null;
  customArgs?: string[];
  apiKind?: ApiProviderKind | null;
  apiBaseUrl?: string | null;
  secretKeyId?: string | null;
  stripAmbientKeys?: boolean;
  defaultModelId?: string | null;
  customModels?: string[];
  createdAt?: string;
  lastUsedAt?: string | null;
}

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
  /** Which agent provider new threads in this project default to (`muse` when unset). */
  defaultProviderId: ProviderId;
  /** The profile new threads in this project default to; null for the default login. */
  defaultAccountId: string | null;
  /** Every folder the project groups: its own cwd first, then the folders added to it. */
  folders: ProjectFolder[];
}

export interface ProjectFolder {
  cwd: string;
  displayName: string;
}

/** Error thrown when an invalid project folder hierarchy or grouping is requested. */
export class ProjectFolderError extends Error {}

/** Provenance level for session titles; higher precedence sources protect against lower-ranked overrides. */
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
  /** Which agent provider owns this session (`muse`, `codex`, `claude`, `gemini`, `copilot`, `api`, ...). */
  providerId: ProviderId;
  /** The profile a session was created under; null for the provider's default login. Set once, never changed. */
  accountId: string | null;
  /** Managed host posture (`coding` or `voice`) when pinned to a dedicated host; null for standard coding sessions. */
  hostPosture: HostPosture | null;
}

export type HostPosture = "coding" | "voice";
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
  chosenModelId?: string | null;
  origin?: string;
  turnCount?: number;
  createdAt?: string;
  activityAt?: string;
  sandboxDisabled?: boolean | null;
  providerId?: ProviderId;
  accountId?: string | null;
  hostPosture?: HostPosture | null;
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
  hostPosture?: HostPosture | null;
}

export const PLACEHOLDER_TITLE = "New thread" as const;

export interface TitleSettings {
  enabled: boolean;
  modelId: string | null;
}

export const DEFAULT_TITLE_SETTINGS: TitleSettings = { enabled: true, modelId: null };

export interface SandboxSettings {
  disabled: boolean;
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = { disabled: false };

export interface YoloSettings {
  enabled: boolean;
}

export const DEFAULT_YOLO_SETTINGS: YoloSettings = { enabled: false };

function nowIso(): string {
  const currentIsoTimestamp = new Date().toISOString();
  return currentIsoTimestamp;
}

function displayNameFor(targetDirectory: string): string {
  const normalized = targetDirectory.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}

function isTitleSource(val: unknown): val is TitleSource {
  return val === "placeholder" || val === "auto" || val === "user";
}

const SCHEMA: string = `
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
CREATE TABLE IF NOT EXISTS usage_coverage (
  session_id TEXT PRIMARY KEY,
  complete INTEGER NOT NULL,
  checked_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime_override TEXT,
  binary_path TEXT,
  custom_args_json TEXT,
  api_kind TEXT,
  api_base_url TEXT,
  secret_key_id TEXT,
  strip_ambient_keys INTEGER NOT NULL DEFAULT 1,
  default_model_id TEXT,
  custom_models_json TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  method TEXT NOT NULL,
  params TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_shell_runs_session ON shell_runs(session_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_at ON usage(at);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_twin ON usage(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_research_runs_session ON research_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_research_events_run ON research_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider ON provider_accounts(provider_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);
`;

const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "projects", column: "hidden", ddl: "ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0" },
  { table: "projects", column: "position", ddl: "ALTER TABLE projects ADD COLUMN position INTEGER" },
  { table: "sessions", column: "title_source", ddl: "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'placeholder'" },
  { table: "sessions", column: "activity_at", ddl: "ALTER TABLE sessions ADD COLUMN activity_at TEXT" },
  { table: "sessions", column: "archived", ddl: "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "settled_override", ddl: "ALTER TABLE sessions ADD COLUMN settled_override TEXT" },
  { table: "sessions", column: "settled_at", ddl: "ALTER TABLE sessions ADD COLUMN settled_at TEXT" },
  { table: "sessions", column: "unsettled_at", ddl: "ALTER TABLE sessions ADD COLUMN unsettled_at TEXT" },
  { table: "sessions", column: "sandbox_disabled", ddl: "ALTER TABLE sessions ADD COLUMN sandbox_disabled INTEGER" },
  { table: "sessions", column: "account_id", ddl: "ALTER TABLE sessions ADD COLUMN account_id TEXT" },
  { table: "projects", column: "default_account_id", ddl: "ALTER TABLE projects ADD COLUMN default_account_id TEXT" },
  { table: "sessions", column: "chosen_model_id", ddl: "ALTER TABLE sessions ADD COLUMN chosen_model_id TEXT" },
  { table: "projects", column: "parent_id", ddl: "ALTER TABLE projects ADD COLUMN parent_id INTEGER REFERENCES projects(id)" },
  { table: "research_runs", column: "report_path", ddl: "ALTER TABLE research_runs ADD COLUMN report_path TEXT" },
  { table: "usage", column: "at_source", ddl: "ALTER TABLE usage ADD COLUMN at_source TEXT" },
  { table: "sessions", column: "provider_id", ddl: "ALTER TABLE sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'muse'" },
  { table: "projects", column: "default_provider_id", ddl: "ALTER TABLE projects ADD COLUMN default_provider_id TEXT NOT NULL DEFAULT 'muse'" },
  { table: "usage", column: "provider_id", ddl: "ALTER TABLE usage ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'muse'" },
  { table: "sessions", column: "host_posture", ddl: "ALTER TABLE sessions ADD COLUMN host_posture TEXT" },
];

type Row = Record<string, string | number | null>;

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

export type UsageAtSource = "live" | "replay" | "estimate";

export interface UsageCall {
  key: string;
  sessionId: string;
  turnId: string | null;
  modelId: string | null;
  providerId?: ProviderId;
  promptTokens: number;
  outputTokens: number;
  inputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number | null;
  at: string;
  atSource?: UsageAtSource;
}

export interface UsageRow extends Omit<UsageCall, "atSource" | "providerId"> {
  providerId: ProviderId;
  atSource: "live" | "replay" | null;
  sessionTitle: string | null;
  projectCwd: string | null;
  origin: string | null;
  archived: boolean;
  accountId: string | null;
}

export interface UsageCoverage {
  countedThreads: number;
  partialThreads: number;
  uncountedThreads: number;
}

const LEGACY_REPAIR_DAYS = 6 / 24;
const USAGE_COVERAGE_RECHECK_MS = 60_000;

export interface ResearchRunRecord {
  id: string;
  sessionId: string;
  commandId: string;
  status: ResearchStatus;
  question: string;
  config: ResearchConfig;
  state: ResearchRunState | null;
  report: string | null;
  failure: string | null;
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

export interface ResearchWorkerRecord {
  runId: string;
  workerSessionId: string;
  round: number;
  agentId: number;
  status: "working" | WorkerStatus;
}

function toAttachment(row: Row): AttachmentRecord {
  const attRecord: AttachmentRecord = {
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
  return attRecord;
}

export const BOOT_BUSY_TIMEOUT_MS = 5000;
export const STEADY_BUSY_TIMEOUT_MS = 100;

export interface AncillaStoreOptions {
  bootBusyTimeoutMs?: number;
  busyTimeoutMs?: number;
}

export function isStoreBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code === "number") {
    const primary = code & 0xff;
    return primary === 5 || primary === 6;
  }
  return /database (table )?is locked/i.test(error instanceof Error ? error.message : "");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

export class AncillaStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path = ":memory:", options: AncillaStoreOptions = {}) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.bootBusyTimeoutMs ?? BOOT_BUSY_TIMEOUT_MS))}`);
      this.assertForeignKeys();
      this.transaction(() => {
        this.db.exec(SCHEMA);
        this.migrate();
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? STEADY_BUSY_TIMEOUT_MS))}`);
  }

  connectionInfo(): { foreignKeys: boolean; busyTimeoutMs: number } {
    const fk = this.db.prepare("PRAGMA foreign_keys").get() as Row | undefined;
    const wait = this.db.prepare("PRAGMA busy_timeout").get() as Row | undefined;
    return { foreignKeys: Number(fk?.["foreign_keys"] ?? 0) === 1, busyTimeoutMs: Number(wait?.["timeout"] ?? 0) };
  }

  private assertForeignKeys(): void {
    if (!this.connectionInfo().foreignKeys) {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    if (!this.connectionInfo().foreignKeys) {
      throw new Error("AncillaStore: SQLite would not turn foreign key checks on.");
    }
  }

  transaction<T>(fn: () => T): T {
    const outermost = this.transactionDepth === 0;
    const savepoint = `ancilla_tx_${this.transactionDepth}`;
    this.db.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    let result: T;
    try {
      result = fn();
      if (isThenable(result)) {
        Promise.resolve(result).catch(() => undefined);
        throw new TypeError("AncillaStore.transaction needs a synchronous function: a transaction ends before an awaited step, so this one was rolled back.");
      }
    } catch (error) {
      this.transactionDepth -= 1;
      this.rollback(outermost, savepoint);
      throw error;
    }
    this.transactionDepth -= 1;
    try {
      this.db.exec(outermost ? "COMMIT" : `RELEASE ${savepoint}`);
    } catch (error) {
      this.rollback(outermost, savepoint);
      throw error;
    }
    return result;
  }

  private rollback(outermost: boolean, savepoint: string): void {
    try {
      if (outermost) {
        this.db.exec("ROLLBACK");
      } else {
        this.db.exec(`ROLLBACK TO ${savepoint}`);
        this.db.exec(`RELEASE ${savepoint}`);
      }
    } catch {
      // Transaction already terminated
    }
  }

  private migrate(): void {
    for (const item of MIGRATIONS) {
      const existingColumns = this.db.prepare(`PRAGMA table_info(${item.table})`).all() as Row[];
      const alreadyPresent = existingColumns.some((col) => col["name"] === item.column);
      if (!alreadyPresent) {
        this.db.exec(item.ddl);
      }
    }
    this.db.exec("UPDATE sessions SET activity_at = created_at WHERE activity_at IS NULL");
  }

  getSubscriptionUsage(scope: string): SubscriptionUsage | null {
    const row = this.db.prepare("SELECT usage FROM subscription_usage WHERE scope = ?").get(scope) as Row | undefined;
    if (!row) return null;
    try { return parseSubscriptionUsage(JSON.parse(String(row["usage"]))); } catch { return null; }
  }

  setSubscriptionUsage(scope: string, usage: SubscriptionUsage, now: number = Date.now()): void {
    this.db.prepare(`INSERT INTO subscription_usage (scope, observed_at_ms, usage) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET observed_at_ms = excluded.observed_at_ms, usage = excluded.usage
      WHERE excluded.observed_at_ms >= subscription_usage.observed_at_ms
        OR subscription_usage.observed_at_ms > ? + 300000`).run(scope, usage.observedAtMs, JSON.stringify(usage), now);
    this.db.prepare(`DELETE FROM subscription_usage WHERE scope NOT IN
      (SELECT scope FROM subscription_usage ORDER BY observed_at_ms DESC LIMIT 64)`).run();
  }

  getTitleSettings(): TitleSettings {
    const found = this.db.prepare(`SELECT value FROM settings WHERE key = 'title'`).get() as Row | undefined;
    if (!found) {
      return { enabled: DEFAULT_TITLE_SETTINGS.enabled, modelId: DEFAULT_TITLE_SETTINGS.modelId };
    }
    try {
      const decoded = JSON.parse(String(found["value"])) as Partial<TitleSettings>;
      const resolved: TitleSettings = {
        enabled: typeof decoded.enabled === "boolean" ? decoded.enabled : DEFAULT_TITLE_SETTINGS.enabled,
        modelId: typeof decoded.modelId === "string" && decoded.modelId.trim().length > 0 ? decoded.modelId : null,
      };
      return resolved;
    } catch {
      return { enabled: DEFAULT_TITLE_SETTINGS.enabled, modelId: DEFAULT_TITLE_SETTINGS.modelId };
    }
  }

  setTitleSettings(patch: Partial<TitleSettings>): TitleSettings {
    const active = this.getTitleSettings();
    const updated: TitleSettings = {
      enabled: patch.enabled ?? active.enabled,
      modelId: patch.modelId !== undefined ? patch.modelId : active.modelId,
    };
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('title', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(updated));
    return updated;
  }

  getSandboxSettings(): SandboxSettings {
    const found = this.db.prepare(`SELECT value FROM settings WHERE key = 'sandbox'`).get() as Row | undefined;
    if (!found) {
      return { disabled: DEFAULT_SANDBOX_SETTINGS.disabled };
    }
    try {
      const decoded = JSON.parse(String(found["value"])) as Partial<SandboxSettings>;
      const resolved: SandboxSettings = {
        disabled: typeof decoded.disabled === "boolean" ? decoded.disabled : DEFAULT_SANDBOX_SETTINGS.disabled,
      };
      return resolved;
    } catch {
      return { disabled: DEFAULT_SANDBOX_SETTINGS.disabled };
    }
  }

  setSandboxSettings(patch: Partial<SandboxSettings>): SandboxSettings {
    const active = this.getSandboxSettings();
    const updated: SandboxSettings = {
      disabled: patch.disabled ?? active.disabled,
    };
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('sandbox', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(updated));
    return updated;
  }

  getYoloSettings(): YoloSettings {
    const found = this.db.prepare(`SELECT value FROM settings WHERE key = 'yolo'`).get() as Row | undefined;
    if (!found) {
      return { enabled: DEFAULT_YOLO_SETTINGS.enabled };
    }
    try {
      const decoded = JSON.parse(String(found["value"])) as Partial<YoloSettings>;
      const resolved: YoloSettings = {
        enabled: typeof decoded.enabled === "boolean" ? decoded.enabled : DEFAULT_YOLO_SETTINGS.enabled,
      };
      return resolved;
    } catch {
      return { enabled: DEFAULT_YOLO_SETTINGS.enabled };
    }
  }

  setYoloSettings(patch: Partial<YoloSettings>): YoloSettings {
    const active = this.getYoloSettings();
    const updated: YoloSettings = {
      enabled: patch.enabled ?? active.enabled,
    };
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('yolo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(updated));
    return updated;
  }

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
    const { sets, values } = this.researchRunSets(patch);
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE research_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getResearchRun(id);
  }

  private researchRunSets(patch: ResearchRunPatch): { sets: string[]; values: (string | number | null)[] } {
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
    return { sets, values };
  }

  updateResearchRunIf(id: string, from: ResearchStatus[], patch: ResearchRunPatch): ResearchRunRecord | null {
    const { sets, values } = this.researchRunSets(patch);
    if (from.length === 0 || sets.length === 0) {
      return null;
    }
    const marks = from.map(() => "?").join(", ");
    const result = this.db.prepare(`UPDATE research_runs SET ${sets.join(", ")} WHERE id = ? AND status IN (${marks})`).run(...values, id, ...from);
    return Number(result.changes) > 0 ? this.getResearchRun(id) : null;
  }

  closeResearchWorkers(runId: string): number {
    const result = this.db.prepare(`UPDATE research_workers SET status = 'cancelled' WHERE run_id = ? AND status = 'working'`).run(runId);
    return Number(result.changes);
  }

  lastResearchEventAt(runId: string, excluded: string[]): string | null {
    const marks = excluded.map(() => "?").join(", ");
    const sql = `SELECT at FROM research_events WHERE run_id = ?${excluded.length > 0 ? ` AND type NOT IN (${marks})` : ""} ORDER BY seq DESC LIMIT 1`;
    const row = this.db.prepare(sql).get(runId, ...excluded) as Row | undefined;
    return row ? String(row["at"]) : null;
  }

  getResearchRun(id: string): ResearchRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM research_runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? this.toResearchRun(row) : null;
  }

  getResearchRunByCommand(commandId: string): ResearchRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM research_runs WHERE command_id = ?`).get(commandId) as Row | undefined;
    return row ? this.toResearchRun(row) : null;
  }

  listResearchRuns(sessionId: string): ResearchRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM research_runs WHERE session_id = ? ORDER BY created_at, id`)
      .all(sessionId) as Row[];
    return rows.map((row) => this.toResearchRun(row));
  }

  listRunningResearchRuns(): ResearchRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM research_runs WHERE status IN ('queued', 'running') ORDER BY created_at, id`)
      .all() as Row[];
    return rows.map((row) => this.toResearchRun(row));
  }

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
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (cwd, display_name, pinned, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(cwd, displayNameFor(cwd), timestamp, timestamp);
    return this.getProject(cwd)!;
  }

  getProject(cwd: string): Project | null {
    const statement = `SELECT p.*, ${this.projectActivitySql()} AS activity_at FROM projects p WHERE p.cwd = ?`;
    const record = this.db.prepare(statement).get(cwd) as Row | undefined;
    return record ? this.toProject(record) : null;
  }

  projectForFolder(cwd: string): Project | null {
    const folderRecord = this.db
      .prepare(`SELECT id, parent_id FROM projects WHERE cwd = ?`)
      .get(cwd) as Row | undefined;

    if (!folderRecord) return null;

    const rootProjectId =
      folderRecord["parent_id"] !== null && folderRecord["parent_id"] !== undefined
        ? Number(folderRecord["parent_id"])
        : Number(folderRecord["id"]);

    const rootProjectRow = this.db
      .prepare(`SELECT p.*, ${this.projectActivitySql()} AS activity_at FROM projects AS p WHERE p.id = ?`)
      .get(rootProjectId) as Row | undefined;

    return rootProjectRow ? this.toProject(rootProjectRow) : null;
  }

  listProjects(options: { includeHidden?: boolean } = {}): Project[] {
    const filterClause = options.includeHidden ? "" : "AND p.hidden = 0";
    const sql = `SELECT p.*, ${this.projectActivitySql()} AS activity_at
         FROM projects p WHERE p.parent_id IS NULL ${filterClause}
         ORDER BY p.pinned DESC, p.position IS NULL, p.position, activity_at DESC, p.id DESC`;
    const rows = this.db.prepare(sql).all() as Row[];
    return rows.map((r) => this.toProject(r));
  }

  listFolders(options: { includeHidden?: boolean } = {}): Project[] {
    const filterClause = options.includeHidden ? "" : "WHERE p.hidden = 0";
    const sql = `SELECT p.*, ${this.projectActivitySql()} AS activity_at FROM projects p ${filterClause} ORDER BY p.id`;
    const rows = this.db.prepare(sql).all() as Row[];
    return rows.map((r) => this.toProject(r));
  }

  addProjectFolder(projectCwd: string, folderCwd: string): Project {
    if (folderCwd.trim() === projectCwd.trim()) {
      const selfFolderMessage = "A project cannot be a folder of itself.";
      throw new ProjectFolderError(selfFolderMessage);
    }

    const targetProjectRow = this.db
      .prepare(`SELECT id, parent_id, display_name FROM projects WHERE cwd = ?`)
      .get(projectCwd) as Row | undefined;

    if (typeof targetProjectRow === "undefined") {
      const missingProjMsg = "Unknown project.";
      throw new ProjectFolderError(missingProjMsg);
    }

    if (targetProjectRow["parent_id"] !== null && targetProjectRow["parent_id"] !== undefined) {
      const parentLabel = String(targetProjectRow["display_name"]);
      throw new ProjectFolderError(`${parentLabel} is itself a folder of another project. Add the folder to that project instead.`);
    }

    void this.upsertProject(folderCwd);
    const subFolderRow = this.db
      .prepare(`SELECT id, display_name, parent_id FROM projects WHERE cwd = ?`)
      .get(folderCwd) as Row;

    if (subFolderRow["parent_id"] === targetProjectRow["id"]) {
      return this.getProject(projectCwd)!;
    }

    if (subFolderRow["parent_id"] !== null && subFolderRow["parent_id"] !== undefined) {
      const currentParent = this.db
        .prepare(`SELECT display_name FROM projects WHERE id = ?`)
        .get(subFolderRow["parent_id"]) as Row | undefined;
      const ownerLabel = currentParent?.["display_name"] ? String(currentParent["display_name"]) : "another project";
      throw new ProjectFolderError(`${String(subFolderRow["display_name"])} is already a folder of ${ownerLabel}. Remove it there first.`);
    }

    const nestedCheck = this.db
      .prepare(`SELECT COUNT(*) AS totalSub FROM projects WHERE parent_id = ?`)
      .get(subFolderRow["id"]) as Row;

    if (Number(nestedCheck["totalSub"]) > 0) {
      throw new ProjectFolderError(`${String(subFolderRow["display_name"])} is a project with folders of its own. Remove its folders first.`);
    }

    const orderQuery = this.db
      .prepare(`SELECT COALESCE(MAX(position), 0) AS maxOrder FROM projects WHERE parent_id = ?`)
      .get(targetProjectRow["id"]) as Row;
    const allocatedPosition = Number(orderQuery["maxOrder"]) + 1;

    this.db
      .prepare(`UPDATE projects SET parent_id = ?, hidden = 0, pinned = 0, position = ?, updated_at = ? WHERE id = ?`)
      .run(targetProjectRow["id"], allocatedPosition, nowIso(), subFolderRow["id"]);

    void this.setHidden(projectCwd, false);
    return this.getProject(projectCwd)!;
  }

  revealProject(cwd: string): void {
    const rootCwd = this.projectForFolder(cwd)?.cwd ?? cwd;
    this.setHidden(rootCwd, false);
  }

  removeProjectFolder(projectCwd: string, folderCwd: string): Project {
    const parentRecord = this.db
      .prepare(`SELECT id FROM projects WHERE cwd = ?`)
      .get(projectCwd) as Row | undefined;

    if (parentRecord === undefined) {
      const errDetail = "Unknown project.";
      throw new ProjectFolderError(errDetail);
    }

    const subFolderRecord = this.db
      .prepare(`SELECT id, parent_id FROM projects WHERE cwd = ?`)
      .get(folderCwd) as Row | undefined;

    if (!subFolderRecord || String(subFolderRecord["parent_id"]) !== String(parentRecord["id"])) {
      const notSubFolderMsg = "That folder is not part of this project.";
      throw new ProjectFolderError(notSubFolderMsg);
    }

    this.db
      .prepare(`UPDATE projects SET parent_id = NULL, hidden = 0, position = NULL, updated_at = ? WHERE id = ?`)
      .run(nowIso(), subFolderRecord["id"]);

    return this.getProject(projectCwd)!;
  }

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
    const savedShellRun = input;
    return savedShellRun;
  }

  listShellRuns(sessionId: string): ShellRunRecord[] {
    const records = this.db.prepare(`SELECT * FROM shell_runs WHERE session_id = ? ORDER BY at`).all(sessionId) as Row[];
    return records.map((entry) => ({
      id: String(entry["id"]),
      sessionId: String(entry["session_id"]),
      command: String(entry["command"]),
      exitCode: entry["exit_code"] === null ? null : Number(entry["exit_code"]),
      output: String(entry["output"] ?? ""),
      truncated: Number(entry["truncated"] ?? 0) === 1,
      durationMs: entry["duration_ms"] === null ? null : Number(entry["duration_ms"]),
      at: String(entry["at"]),
    }));
  }

  recordUsage(call: UsageCall): void {
    const stored = this.db.prepare(`SELECT key FROM usage WHERE key = ?`).get(call.key) as Row | undefined;
    const twin = stored
      ? undefined
      : (this.db
          .prepare(
            `SELECT key FROM usage
             WHERE session_id = ? AND turn_id IS ? AND prompt_tokens = ? AND output_tokens = ? AND duration_ms IS ?
             LIMIT 1`,
          )
          .get(call.sessionId, call.turnId ?? null, call.promptTokens, call.outputTokens, call.durationMs ?? null) as Row | undefined);
    const existing = stored ?? twin;
    if (existing) {
      if (call.atSource === "replay") {
        this.db
          .prepare(
            `UPDATE usage SET at = ?, at_source = 'replay'
             WHERE key = ? AND at_source IS NOT 'live' AND at > ?
               AND (at_source = 'replay' OR julianday(at) - julianday(?) > ?)`,
          )
          .run(call.at, String(existing["key"]), call.at, call.at, LEGACY_REPAIR_DAYS);
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO usage (key, session_id, turn_id, model_id, provider_id, prompt_tokens, output_tokens, input_tokens,
           cached_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, duration_ms, at, at_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(
        call.key,
        call.sessionId,
        call.turnId ?? null,
        call.modelId ?? null,
        normalizeProviderId(call.providerId ?? this.getSession(call.sessionId)?.providerId),
        call.promptTokens,
        call.outputTokens,
        call.inputTokens,
        call.cachedTokens,
        call.cacheReadTokens,
        call.cacheWriteTokens,
        call.reasoningTokens,
        call.durationMs ?? null,
        call.at,
        call.atSource === undefined ? null : call.atSource === "estimate" ? "replay" : call.atSource,
      );
  }

  setUsageCoverage(sessionId: string, complete: boolean, checkedAt: string = nowIso()): void {
    const stored = this.getUsageCoverage(sessionId);
    if (stored && stored.complete === complete && Date.parse(checkedAt) - Date.parse(stored.checkedAt) < USAGE_COVERAGE_RECHECK_MS) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO usage_coverage (session_id, complete, checked_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET complete = excluded.complete, checked_at = excluded.checked_at`,
      )
      .run(sessionId, complete ? 1 : 0, checkedAt);
  }

  getUsageCoverage(sessionId: string): { complete: boolean; checkedAt: string } | null {
    const row = this.db.prepare(`SELECT complete, checked_at FROM usage_coverage WHERE session_id = ?`).get(sessionId) as Row | undefined;
    return row ? { complete: Number(row["complete"]) === 1, checkedAt: String(row["checked_at"]) } : null;
  }

  sumUsagePrompt(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(u.prompt_tokens), 0) AS total FROM usage u
         WHERE u.session_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM usage v
             WHERE v.session_id = u.session_id AND v.turn_id IS u.turn_id AND v.prompt_tokens = u.prompt_tokens
               AND v.output_tokens = u.output_tokens AND v.duration_ms IS u.duration_ms AND v.rowid < u.rowid)`,
      )
      .get(sessionId) as Row;
    return Number(row["total"] ?? 0);
  }

  usageCoverage(since: string): UsageCoverage {
    const count = (sql: string): number => Number((this.db.prepare(sql).get(since) as Row)["n"] ?? 0);
    const counted = `FROM usage u LEFT JOIN sessions s ON s.id = u.session_id
      WHERE u.at >= ? AND COALESCE(s.origin, 'ancilla') <> 'research-worker'`;
    return {
      countedThreads: count(`SELECT COUNT(DISTINCT u.session_id) AS n ${counted}`),
      partialThreads: count(
        `SELECT COUNT(DISTINCT u.session_id) AS n ${counted}
           AND EXISTS (SELECT 1 FROM usage_coverage c WHERE c.session_id = u.session_id AND c.complete = 0)`,
      ),
      uncountedThreads: count(
        `SELECT COUNT(*) AS n FROM sessions s
         WHERE s.archived = 0 AND s.turn_count > 0 AND s.origin <> 'research-worker'
           AND COALESCE(s.activity_at, s.created_at) >= ?
           AND NOT EXISTS (SELECT 1 FROM usage u WHERE u.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM usage_coverage c WHERE c.session_id = s.id AND c.complete = 1)`,
      ),
    };
  }

  listUsage(since?: string): UsageRow[] {
    const sql = `SELECT u.*, s.title AS session_title, s.origin AS session_origin, s.archived AS session_archived,
           s.provider_id AS session_provider_id, s.account_id AS session_account_id, COALESCE(owner.cwd, p.cwd) AS project_cwd
         FROM usage u
         LEFT JOIN sessions s ON s.id = u.session_id
         LEFT JOIN projects p ON p.id = s.project_id
         LEFT JOIN projects owner ON owner.id = p.parent_id
         ${since ? "WHERE u.at >= ?" : ""}
         ORDER BY u.at`;
    const rows = this.db.prepare(sql).all(...(since ? [since] : [])) as Row[];
    return rows.map((r) => ({
      key: String(r["key"]),
      sessionId: String(r["session_id"]),
      turnId: r["turn_id"] === null ? null : String(r["turn_id"]),
      modelId: r["model_id"] === null ? null : String(r["model_id"]),
      providerId: normalizeProviderId(r["session_provider_id"] ?? r["provider_id"]),
      promptTokens: Number(r["prompt_tokens"] ?? 0),
      outputTokens: Number(r["output_tokens"] ?? 0),
      inputTokens: Number(r["input_tokens"] ?? 0),
      cachedTokens: Number(r["cached_tokens"] ?? 0),
      cacheReadTokens: Number(r["cache_read_tokens"] ?? 0),
      cacheWriteTokens: Number(r["cache_write_tokens"] ?? 0),
      reasoningTokens: Number(r["reasoning_tokens"] ?? 0),
      durationMs: r["duration_ms"] === null ? null : Number(r["duration_ms"]),
      at: String(r["at"]),
      atSource: r["at_source"] === "live" || r["at_source"] === "replay" ? r["at_source"] : null,
      sessionTitle: r["session_title"] === null || r["session_title"] === undefined ? null : String(r["session_title"]),
      projectCwd: r["project_cwd"] === null || r["project_cwd"] === undefined ? null : String(r["project_cwd"]),
      origin: r["session_origin"] === null || r["session_origin"] === undefined ? null : String(r["session_origin"]),
      archived: Number(r["session_archived"] ?? 0) === 1,
      accountId: r["session_account_id"] === null || r["session_account_id"] === undefined ? null : String(r["session_account_id"]),
    }));
  }

  setProjectOrder(cwds: string[]): void {
    const timestamp = nowIso();
    const updateStmt = this.db.prepare(`UPDATE projects SET position = ?, updated_at = ? WHERE cwd = ? AND parent_id IS NULL`);
    for (let i = 0; i < cwds.length; i++) {
      updateStmt.run(i, timestamp, cwds[i]);
    }
  }

  setPinned(cwd: string, pinned: boolean): void {
    this.db
      .prepare(`UPDATE projects SET pinned = ?, updated_at = ? WHERE cwd = ? AND parent_id IS NULL`)
      .run(pinned ? 1 : 0, nowIso(), cwd);
  }

  setHidden(cwd: string, hidden: boolean): void {
    this.db
      .prepare(
        `UPDATE projects SET hidden = ?, updated_at = ?
         WHERE cwd = ? OR parent_id = (SELECT id FROM projects WHERE cwd = ?)`,
      )
      .run(hidden ? 1 : 0, nowIso(), cwd, cwd);
  }

  setDefaultAccount(cwd: string, accountId: string | null): void {
    this.db
      .prepare(`UPDATE projects SET default_account_id = ?, updated_at = ? WHERE cwd = ?`)
      .run(accountId, nowIso(), cwd);
  }

  setDefaultProvider(cwd: string, providerId: ProviderId, accountId?: string | null): void {
    const normalized = normalizeProviderId(providerId);
    if (accountId !== undefined) {
      this.db
        .prepare(`UPDATE projects SET default_provider_id = ?, default_account_id = ?, updated_at = ? WHERE cwd = ?`)
        .run(normalized, accountId, nowIso(), cwd);
      return;
    }
    this.db
      .prepare(`UPDATE projects SET default_provider_id = ?, updated_at = ? WHERE cwd = ?`)
      .run(normalized, nowIso(), cwd);
  }

  clearDefaultAccount(accountId: string): void {
    this.db.prepare(`UPDATE projects SET default_account_id = NULL WHERE default_account_id = ?`).run(accountId);
  }

  // ---------------------------------------------------------------- provider accounts & session journal

  listProviderAccounts(providerId?: ProviderId): ProviderAccountRecord[] {
    const rows = (providerId
      ? this.db
          .prepare(`SELECT * FROM provider_accounts WHERE provider_id = ? ORDER BY created_at, id`)
          .all(providerId)
      : this.db.prepare(`SELECT * FROM provider_accounts ORDER BY provider_id, created_at, id`).all()) as Row[];
    return rows.map((row) => this.toProviderAccount(row));
  }

  getProviderAccount(id: string): ProviderAccountRecord | null {
    const row = this.db.prepare(`SELECT * FROM provider_accounts WHERE id = ?`).get(id) as Row | undefined;
    return row ? this.toProviderAccount(row) : null;
  }

  upsertProviderAccount(input: UpsertProviderAccountInput): ProviderAccountRecord {
    const existing = this.getProviderAccount(input.id);
    const createdAt = existing?.createdAt ?? input.createdAt ?? nowIso();
    const lastUsedAt = input.lastUsedAt !== undefined ? input.lastUsedAt : (existing?.lastUsedAt ?? null);
    const customArgs = input.customArgs ?? existing?.customArgs ?? [];
    const customModels = input.customModels ?? existing?.customModels ?? [];
    const stripAmbientKeys =
      input.stripAmbientKeys !== undefined ? input.stripAmbientKeys : (existing?.stripAmbientKeys ?? true);
    this.db
      .prepare(
        `INSERT INTO provider_accounts (
           id, provider_id, name, runtime_override, binary_path, custom_args_json,
           api_kind, api_base_url, secret_key_id, strip_ambient_keys, default_model_id,
           custom_models_json, created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_id = excluded.provider_id,
           name = excluded.name,
           runtime_override = excluded.runtime_override,
           binary_path = excluded.binary_path,
           custom_args_json = excluded.custom_args_json,
           api_kind = excluded.api_kind,
           api_base_url = excluded.api_base_url,
           secret_key_id = excluded.secret_key_id,
           strip_ambient_keys = excluded.strip_ambient_keys,
           default_model_id = excluded.default_model_id,
           custom_models_json = excluded.custom_models_json,
           last_used_at = excluded.last_used_at`,
      )
      .run(
        input.id,
        normalizeProviderId(input.providerId),
        input.name,
        input.runtimeOverride !== undefined ? input.runtimeOverride : (existing?.runtimeOverride ?? null),
        input.binaryPath !== undefined ? input.binaryPath : (existing?.binaryPath ?? null),
        JSON.stringify(customArgs),
        input.apiKind !== undefined ? input.apiKind : (existing?.apiKind ?? null),
        input.apiBaseUrl !== undefined ? input.apiBaseUrl : (existing?.apiBaseUrl ?? null),
        input.secretKeyId !== undefined ? input.secretKeyId : (existing?.secretKeyId ?? null),
        stripAmbientKeys ? 1 : 0,
        input.defaultModelId !== undefined ? input.defaultModelId : (existing?.defaultModelId ?? null),
        JSON.stringify(customModels),
        createdAt,
        lastUsedAt,
      );
    return this.getProviderAccount(input.id) as ProviderAccountRecord;
  }

  touchProviderAccount(id: string, at: string = nowIso()): void {
    this.db.prepare(`UPDATE provider_accounts SET last_used_at = ? WHERE id = ?`).run(at, id);
  }

  deleteProviderAccount(id: string): boolean {
    const existing = this.getProviderAccount(id);
    const result = this.db.prepare(`DELETE FROM provider_accounts WHERE id = ?`).run(id);
    if (Number(result.changes) > 0) {
      if (
        existing &&
        (existing.providerId === "api" || existing.providerId === "acp-custom" || existing.providerId.startsWith("acp:")) &&
        this.listProviderAccounts(existing.providerId).length === 0
      ) {
        this.db
          .prepare(`UPDATE projects SET default_provider_id = 'muse', default_account_id = NULL WHERE default_account_id = ?`)
          .run(id);
      } else {
        this.clearDefaultAccount(id);
      }
      return true;
    }
    return false;
  }

  appendSessionEvent(sessionId: string, method: string, params: Record<string, unknown>, at: string = nowIso()): number {
    return this.transaction(() => {
      const last = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM session_events WHERE session_id = ?`)
        .get(sessionId) as Row;
      const seq = Number(last["seq"] ?? 0) + 1;
      const enriched = { ...params };
      if (typeof enriched["viewCursor"] !== "string") {
        enriched["viewCursor"] = `v:${sessionId}:${seq}`;
      }
      if (typeof enriched["sourceRange"] !== "object" || enriched["sourceRange"] === null) {
        enriched["sourceRange"] = { startSeq: seq, endSeq: seq };
      }
      this.db
        .prepare(`INSERT INTO session_events (session_id, seq, method, params, at) VALUES (?, ?, ?, ?, ?)`)
        .run(sessionId, seq, method, JSON.stringify(enriched), at);
      return seq;
    });
  }

  listSessionEvents(sessionId: string): StoredJournalEvent[] {
    const rows = this.db
      .prepare(`SELECT seq, method, params, at FROM session_events WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as Row[];
    return rows.map((row) => {
      let params: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row["params"]));
        if (typeof parsed === "object" && parsed !== null) {
          params = parsed as Record<string, unknown>;
        }
      } catch {
        /* malformed event payload falls back to empty object */
      }
      return {
        seq: Number(row["seq"]),
        method: String(row["method"]),
        params,
        at: String(row["at"]),
      };
    });
  }

  sessionJournal(): SessionJournal {
    return {
      append: (sessionId, method, params, at) => this.appendSessionEvent(sessionId, method, params, at),
      list: (sessionId) => this.listSessionEvents(sessionId),
    };
  }

  addAttachment(input: AddAttachmentInput): AttachmentRecord {
    const insertTimestamp = nowIso();
    const insertStmt = this.db.prepare(
      `INSERT INTO attachments (
        id, session_id, turn_id, ord, name, media_type, kind, width, height, bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insertStmt.run(
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
      insertTimestamp,
    );

    const inserted = this.getAttachment(input.id);
    if (!inserted) {
      throw new Error(`AncillaStore: failed to retrieve newly inserted attachment ${input.id}`);
    }
    return inserted;
  }

  listAttachments(sessionId: string): AttachmentRecord[] {
    const sql = `SELECT id, session_id, turn_id, ord, name, media_type, kind, width, height, created_at
         FROM attachments WHERE session_id = ? ORDER BY created_at, ord`;
    const rows = this.db.prepare(sql).all(sessionId) as Row[];
    return rows.map((r) => toAttachment(r));
  }

  getAttachment(id: string): AttachmentRecord | null {
    const sql = `SELECT id, session_id, turn_id, ord, name, media_type, kind, width, height, created_at
         FROM attachments WHERE id = ?`;
    const row = this.db.prepare(sql).get(id) as Row | undefined;
    if (!row) return null;
    return toAttachment(row);
  }

  readAttachment(id: string): { record: AttachmentRecord; bytes: Uint8Array } | null {
    const attachRow = this.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as (Row & { bytes?: unknown }) | undefined;
    if (!attachRow || !(attachRow.bytes instanceof Uint8Array)) {
      return (null as null);
    }
    const record = toAttachment(attachRow);
    return { record, bytes: attachRow.bytes };
  }

  recordSession(input: RecordSessionInput): SessionRecord {
    const timestamp = nowIso();
    const prior = this.getSession(input.id);
    if (!prior) {
      const source = input.titleSource ?? (input.title ? "auto" : "placeholder");
      this.db
        .prepare(
          `INSERT INTO sessions (id, project_id, title, title_source, status, turn_count, model_id, chosen_model_id, origin,
             archived, sandbox_disabled, provider_id, account_id, host_posture, created_at, updated_at, activity_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.title ?? PLACEHOLDER_TITLE,
          source,
          input.turnCount ?? 0,
          input.modelId ?? null,
          input.chosenModelId ?? null,
          input.origin ?? "ancilla",
          input.sandboxDisabled === undefined || input.sandboxDisabled === null ? null : input.sandboxDisabled ? 1 : 0,
          normalizeProviderId(input.providerId),
          input.accountId ?? null,
          input.hostPosture === "coding" || input.hostPosture === "voice" ? input.hostPosture : null,
          input.createdAt ?? timestamp,
          timestamp,
          input.activityAt ?? input.createdAt ?? timestamp,
        );
      const createdSession = this.getSession(input.id);
      return createdSession!;
    }

    const updates: SessionPatch = {};
    if (prior.hostPosture === null && (input.hostPosture === "coding" || input.hostPosture === "voice")) {
      updates.hostPosture = input.hostPosture;
    }
    if (typeof input.title !== "undefined") {
      const candidateSource = input.titleSource ?? "auto";
      if (TITLE_RANK[candidateSource] >= TITLE_RANK[prior.titleSource]) {
        updates.title = input.title;
        updates.titleSource = candidateSource;
      }
    }
    if (typeof input.modelId !== "undefined" && input.modelId !== null) {
      updates.modelId = input.modelId;
    }
    if (typeof input.turnCount !== "undefined" && input.turnCount > prior.turnCount) {
      updates.turnCount = input.turnCount;
    }

    const recordedActivity = (this.db.prepare(`SELECT activity_at FROM sessions WHERE id = ?`).get(input.id) as Row | undefined)?.["activity_at"];
    if (recordedActivity === null || recordedActivity === undefined) {
      updates.activityAt = input.activityAt ?? prior.createdAt;
    } else if (input.activityAt !== undefined && input.activityAt > prior.activityAt) {
      updates.activityAt = input.activityAt;
    }

    if (prior.projectId !== input.projectId) {
      this.db.prepare(`UPDATE sessions SET project_id = ? WHERE id = ?`).run(input.projectId, input.id);
    }
    const updatedSession = this.updateSession(input.id, updates);
    return updatedSession ?? prior;
  }

  getSession(id: string): SessionRecord | null {
    const sessionRow = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    if (!sessionRow) return null;
    return this.toSession(sessionRow);
  }

  findSession(id: string): { session: SessionRecord; cwd: string } | null {
    const sql = `SELECT s.*, p.cwd AS project_cwd FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`;
    const record = this.db.prepare(sql).get(id) as Row | undefined;
    return record ? { session: this.toSession(record), cwd: String(record["project_cwd"]) } : null;
  }

  listSessionsByProject(projectId: number, options: { includeArchived?: boolean } = {}): SessionRecord[] {
    const archiveConstraint = options.includeArchived ? "" : "AND archived = 0";
    const sql = `SELECT * FROM sessions WHERE project_id = ? ${archiveConstraint}
         ORDER BY COALESCE(activity_at, updated_at) DESC`;
    const rows = this.db.prepare(sql).all(projectId) as Row[];
    return rows.map((r) => this.toSession(r));
  }

  updateSession(id: string, patch: SessionPatch): SessionRecord | null {
    const columns: string[] = [];
    const parameters: (string | number | null)[] = [];

    if (typeof patch.title !== "undefined") {
      columns.push("title = ?");
      parameters.push(patch.title);
    }
    if (typeof patch.titleSource !== "undefined") {
      columns.push("title_source = ?");
      parameters.push(patch.titleSource);
    }
    if (typeof patch.archived !== "undefined") {
      columns.push("archived = ?");
      parameters.push(patch.archived ? 1 : 0);
    }
    if (typeof patch.modelId !== "undefined") {
      columns.push("model_id = ?");
      parameters.push(patch.modelId);
    }
    if (typeof patch.chosenModelId !== "undefined") {
      columns.push("chosen_model_id = ?");
      parameters.push(patch.chosenModelId);
    }
    if (typeof patch.turnCount !== "undefined") {
      columns.push("turn_count = ?");
      parameters.push(patch.turnCount);
    }
    if (typeof patch.activityAt !== "undefined") {
      columns.push("activity_at = ?");
      parameters.push(patch.activityAt);
    }
    if (typeof patch.status !== "undefined") {
      columns.push("status = ?");
      parameters.push(patch.status);
    }
    if (typeof patch.settledOverride !== "undefined") {
      columns.push("settled_override = ?");
      parameters.push(patch.settledOverride);
    }
    if (typeof patch.settledAt !== "undefined") {
      columns.push("settled_at = ?");
      parameters.push(patch.settledAt);
    }
    if (typeof patch.unsettledAt !== "undefined") {
      columns.push("unsettled_at = ?");
      parameters.push(patch.unsettledAt);
    }
    if (typeof patch.hostPosture !== "undefined") {
      columns.push("host_posture = ?");
      parameters.push(patch.hostPosture);
    }

    if (columns.length > 0) {
      columns.push("updated_at = ?");
      parameters.push(nowIso());
      this.db.prepare(`UPDATE sessions SET ${columns.join(", ")} WHERE id = ?`).run(...parameters, id);
    }
    const retrieved = this.getSession(id);
    return retrieved;
  }

  listSettleCandidates(before: string): SessionRecord[] {
    const sql = `SELECT * FROM sessions
         WHERE settled_override IS NULL AND archived = 0 AND COALESCE(activity_at, updated_at) < ?`;
    const rows = this.db.prepare(sql).all(before) as Row[];
    return rows.map((r) => this.toSession(r));
  }

  registerTurn(id: string, sessionId: string): TurnRecord {
    const registerTimestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO turns (id, session_id, status, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, sessionId, registerTimestamp, registerTimestamp);
    const registeredTurn = this.getTurn(id);
    return registeredTurn;
  }

  finishTurn(id: string, sessionId: string, status: string): TurnRecord {
    return this.transaction(() => {
      const now = nowIso();
      const previous = this.db.prepare(`SELECT session_id, status FROM turns WHERE id = ?`).get(id) as Row | undefined;
      if (previous && String(previous["session_id"]) !== sessionId) {
        return this.getTurn(id);
      }
      const before = previous ? String(previous["status"]) : null;
      const counts = (before === null || before === "running" || before === "unknown") && status !== "running" && status !== "unknown";
      this.db
        .prepare(
          `INSERT INTO turns (id, session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        )
        .run(id, sessionId, status, now, now);
      if (counts) {
        this.db.prepare(`UPDATE sessions SET turn_count = turn_count + 1, updated_at = ?, activity_at = ? WHERE id = ?`).run(now, now, sessionId);
      }
      return this.getTurn(id);
    });
  }

  recordTurn(id: string, sessionId: string): TurnRecord {
    return this.finishTurn(id, sessionId, "completed");
  }

  updateTurnStatus(id: string, status: string): void {
    this.db
      .prepare(`UPDATE turns SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
  }

  markRunningTurnsUnknown(): number {
    const result = this.db.prepare(`UPDATE turns SET status = 'unknown', updated_at = ? WHERE status = 'running'`).run(nowIso());
    return Number(result.changes);
  }

  turnStatus(id: string, sessionId: string): string | null {
    const row = this.db.prepare(`SELECT status FROM turns WHERE id = ? AND session_id = ?`).get(id, sessionId) as Row | undefined;
    return row ? String(row["status"]) : null;
  }

  listTurns(sessionId: string): TurnRecord[] {
    const rows = this.db.prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY id`).all(sessionId) as Row[];
    return rows.map((row) => ({
      id: String(row["id"]),
      sessionId: String(row["session_id"]),
      status: String(row["status"]),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    }));
  }

  close(): void {
    this.db.close();
  }

  private projectActivitySql(): string {
    return `COALESCE(
      (
        SELECT MAX(COALESCE(sess.activity_at, sess.updated_at))
        FROM sessions AS sess
        INNER JOIN projects AS proj ON proj.id = sess.project_id
        WHERE sess.archived = 0 AND (proj.id = p.id OR proj.parent_id = p.id)
      ),
      p.created_at
    )`;
  }

  private foldersOf(projectRow: Row): ProjectFolder[] {
    const primaryFolder: ProjectFolder = {
      cwd: String(projectRow["cwd"]),
      displayName: String(projectRow["display_name"]),
    };
    const hasParentLink = projectRow["parent_id"] !== null && projectRow["parent_id"] !== undefined;
    if (hasParentLink) {
      return [primaryFolder];
    }

    const subRows = this.db
      .prepare(
        `SELECT cwd, display_name
         FROM projects
         WHERE parent_id = ?
         ORDER BY (position IS NULL), position ASC, created_at ASC, id ASC`,
      )
      .all(projectRow["id"]) as Row[];

    const subFolders = subRows.map((child): ProjectFolder => ({
      cwd: String(child["cwd"]),
      displayName: String(child["display_name"]),
    }));

    return [primaryFolder, ...subFolders];
  }

  private getTurn(turnIdentifier: string): TurnRecord {
    const turnRow = this.db
      .prepare(`SELECT id, session_id, status, created_at, updated_at FROM turns WHERE id = ?`)
      .get(turnIdentifier) as Row | undefined;

    if (!turnRow) {
      throw new Error(`AncillaStore: unknown turn ${turnIdentifier}.`);
    }

    const turnObj: TurnRecord = {
      id: String(turnRow["id"]),
      sessionId: String(turnRow["session_id"]),
      status: String(turnRow["status"]),
      createdAt: String(turnRow["created_at"]),
      updatedAt: String(turnRow["updated_at"]),
    };
    return turnObj;
  }

  private toProject(rawRow: Row): Project {
    const rawAccount = rawRow["default_account_id"];
    const resolvedAccount = rawAccount !== null && rawAccount !== undefined ? String(rawAccount) : null;
    const createdTimestamp = String(rawRow["created_at"]);
    const activeTimestamp = String(rawRow["activity_at"] ?? createdTimestamp);

    const projectObj: Project = {
      id: Number(rawRow["id"]),
      cwd: String(rawRow["cwd"]),
      displayName: String(rawRow["display_name"]),
      pinned: Number(rawRow["pinned"]) === 1,
      hidden: Number(rawRow["hidden"] ?? 0) === 1,
      createdAt: createdTimestamp,
      updatedAt: String(rawRow["updated_at"]),
      activityAt: activeTimestamp,
      defaultProviderId: normalizeProviderId(rawRow["default_provider_id"]),
      defaultAccountId: resolvedAccount,
      folders: this.foldersOf(rawRow),
    };
    return projectObj;
  }

  private toProviderAccount(row: Row): ProviderAccountRecord {
    const parseStringArray = (raw: unknown): string[] => {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return [];
      }
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
      } catch {
        return [];
      }
    };
    const apiKindRaw = row["api_kind"];
    const apiKind: ApiProviderKind | null =
      apiKindRaw === "openai" || apiKindRaw === "anthropic" || apiKindRaw === "google" ? apiKindRaw : null;
    return {
      id: String(row["id"]),
      providerId: normalizeProviderId(row["provider_id"]),
      name: String(row["name"]),
      runtimeOverride:
        row["runtime_override"] === null || row["runtime_override"] === undefined
          ? null
          : String(row["runtime_override"]),
      binaryPath:
        row["binary_path"] === null || row["binary_path"] === undefined ? null : String(row["binary_path"]),
      customArgs: parseStringArray(row["custom_args_json"]),
      apiKind,
      apiBaseUrl:
        row["api_base_url"] === null || row["api_base_url"] === undefined ? null : String(row["api_base_url"]),
      secretKeyId:
        row["secret_key_id"] === null || row["secret_key_id"] === undefined ? null : String(row["secret_key_id"]),
      stripAmbientKeys: Number(row["strip_ambient_keys"] ?? 1) === 1,
      defaultModelId:
        row["default_model_id"] === null || row["default_model_id"] === undefined
          ? null
          : String(row["default_model_id"]),
      customModels: parseStringArray(row["custom_models_json"]),
      createdAt: String(row["created_at"]),
      lastUsedAt:
        row["last_used_at"] === null || row["last_used_at"] === undefined ? null : String(row["last_used_at"]),
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
    const rawTitleSource = row["title_source"];
    const sessionObj: SessionRecord = {
      id: String(row["id"]),
      projectId: Number(row["project_id"]),
      title: String(row["title"]),
      titleSource: isTitleSource(rawTitleSource) ? rawTitleSource : "placeholder",
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
      providerId: normalizeProviderId(row["provider_id"]),
      accountId: row["account_id"] === null || row["account_id"] === undefined ? null : String(row["account_id"]),
      hostPosture: row["host_posture"] === "coding" || row["host_posture"] === "voice" ? row["host_posture"] : null,
    };
    return sessionObj;
  }
}
