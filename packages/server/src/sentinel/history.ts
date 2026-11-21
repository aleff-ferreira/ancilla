import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Finding, FindingKind, PowerEvent, Severity, SignalEvent, WlanEvent } from "./types.js";

/**
 * The Sentinel's own history, in a SQLite file of its own. The OS keeps the WLAN log at about 1 MB (roughly six weeks here), so
 * what the Sentinel read from it is copied here before it rolls over, with the findings drawn from it and a thinned series of
 * adapter readings. Nothing in it is a secret: network names and numbers, kept on this machine only.
 */

const DAY = 86_400_000;
export const EVENT_KEEP_MS = 90 * DAY;
export const SIGNAL_KEEP_MS = 14 * DAY;
export const FINDING_KEEP_MS = 180 * DAY;
/** One adapter reading a minute is kept, however often it is taken. */
const SIGNAL_EVERY_MS = 55_000;
const SCHEMA = 1;

export interface DayStats {
  /** The calendar day, as YYYY-MM-DD in the offset the caller gave. */
  day: string;
  drops: number;
  blips: number;
  stuck: number;
  cannotConnect: number;
  /** The lowest signal quality read that day, or null when no reading was kept. */
  weakest: number | null;
}

interface FindingRow {
  id: string;
  key: string;
  kind: string;
  severity: string;
  title: string;
  detail: string;
  at: number;
  updated_at: number;
  resolved_at: number | null;
  count: number;
}

function toFinding(row: FindingRow): Finding {
  return { id: row.id, key: row.key, kind: row.kind as FindingKind, severity: row.severity as Severity, title: row.title, detail: row.detail, at: row.at, updatedAt: row.updated_at, resolvedAt: row.resolved_at, count: row.count };
}

export class History {
  private lastSignalAt = 0;

  private constructor(private readonly db: DatabaseSync) {}

  /** A null path keeps the history in memory (tests, and a data folder that is not on disk). */
  static open(path: string | null): History {
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path ?? ":memory:");
    db.exec("PRAGMA busy_timeout = 5000");
    if (path) db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    const history = new History(db);
    try {
      history.migrate();
    } catch (error) {
      // A file that cannot be used is not left open: on Windows an open file cannot be removed or replaced.
      db.close();
      throw error;
    }
    return history;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > SCHEMA) throw new Error(`the Sentinel history was written by a newer version (schema ${version})`);
    if (version === SCHEMA) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        rid INTEGER,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        -- The time is part of the key: if the OS log is cleared its record numbers start again, and an event must not be taken for an old one.
        UNIQUE (source, rid, at)
      );
      CREATE INDEX IF NOT EXISTS events_at ON events (at);
      CREATE TABLE IF NOT EXISTS signals (
        at INTEGER PRIMARY KEY,
        connected INTEGER NOT NULL,
        signal INTEGER,
        channel INTEGER
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS findings_at ON findings (at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = ${SCHEMA};
    `);
  }

  // ------------------------------------------------------------------------------------------------------------------ meta

  meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---------------------------------------------------------------------------------------------------------------- events

  /** Keeps a Wi-Fi or power event. False when the OS log record was already kept (a backfill overlaps what was seen live). */
  addEvent(event: WlanEvent | PowerEvent): boolean {
    const source = event.kind === "wlan" ? "wlan" : "power";
    const { changes } = this.db.prepare("INSERT OR IGNORE INTO events (source, rid, at, payload) VALUES (?, ?, ?, ?)").run(source, event.rid, event.at, JSON.stringify(event));
    return Number(changes) > 0;
  }

  /** The newest OS log event kept, or null: a restart reads the log back from here. */
  lastEventAt(): number | null {
    const row = this.db.prepare("SELECT MAX(at) AS at FROM events").get() as { at: number | null };
    return row.at;
  }

  /** The sleeps and resumes since `since`, oldest first. */
  powerSince(since: number): number[] {
    return (this.db.prepare("SELECT at FROM events WHERE source = 'power' AND at >= ? ORDER BY at").all(since) as Array<{ at: number }>).map((row) => row.at);
  }

  events(since: number, until: number = Number.MAX_SAFE_INTEGER): Array<WlanEvent | PowerEvent> {
    return (this.db.prepare("SELECT payload FROM events WHERE at >= ? AND at <= ? ORDER BY at, id").all(since, until) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as WlanEvent | PowerEvent);
  }

  /** Keeps an adapter reading, at most one a minute. */
  addSignal(event: SignalEvent): void {
    if (event.at - this.lastSignalAt < SIGNAL_EVERY_MS && event.at >= this.lastSignalAt) return;
    this.lastSignalAt = event.at;
    this.db.prepare("INSERT OR REPLACE INTO signals (at, connected, signal, channel) VALUES (?, ?, ?, ?)").run(event.at, event.connected ? 1 : 0, event.signal, event.channel);
  }

  signals(since: number): Array<{ at: number; connected: boolean; signal: number | null }> {
    return (this.db.prepare("SELECT at, connected, signal FROM signals WHERE at >= ? ORDER BY at").all(since) as Array<{ at: number; connected: number; signal: number | null }>).map((row) => ({ at: row.at, connected: row.connected === 1, signal: row.signal }));
  }

  // -------------------------------------------------------------------------------------------------------------- findings

  upsertFinding(finding: Finding): void {
    this.db
      .prepare(
        `INSERT INTO findings (id, key, kind, severity, title, detail, at, updated_at, resolved_at, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET severity = excluded.severity, title = excluded.title, detail = excluded.detail, updated_at = excluded.updated_at, resolved_at = excluded.resolved_at, count = excluded.count`,
      )
      .run(finding.id, finding.key, finding.kind, finding.severity, finding.title, finding.detail, finding.at, finding.updatedAt, finding.resolvedAt, finding.count);
  }

  /** Newest first. */
  findings(options: { open?: boolean; since?: number; limit?: number } = {}): Finding[] {
    const where: string[] = [];
    const args: number[] = [];
    if (options.open) where.push("resolved_at IS NULL");
    if (options.since !== undefined) {
      where.push("updated_at >= ?");
      args.push(options.since);
    }
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
    const sql = `SELECT * FROM findings ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as unknown as FindingRow[]).map(toFinding);
  }

  /** What a previous run left open is over: the Sentinel was not watching, so it cannot say that the condition still holds. */
  closeStale(at: number): number {
    const { changes } = this.db.prepare("UPDATE findings SET resolved_at = ?, updated_at = ?, detail = detail || ' (The Sentinel stopped watching before this was over.)' WHERE resolved_at IS NULL").run(at, at);
    return Number(changes);
  }

  /** Findings per calendar day in the offset `offsetMinutes` east of UTC, oldest day first, for the last `days` days ending with the day of `now`. */
  daily(now: number, days: number, offsetMinutes: number): DayStats[] {
    const shift = offsetMinutes * 60_000;
    const today = Math.floor((now + shift) / DAY);
    const first = today - Math.max(1, Math.min(120, Math.floor(days))) + 1;
    const out = new Map<number, DayStats>();
    for (let day = first; day <= today; day++) out.set(day, { day: new Date(day * DAY).toISOString().slice(0, 10), drops: 0, blips: 0, stuck: 0, cannotConnect: 0, weakest: null });
    const rows = this.db.prepare("SELECT kind, at FROM findings WHERE at >= ?").all(first * DAY - shift) as Array<{ kind: string; at: number }>;
    for (const row of rows) {
      const stats = out.get(Math.floor((row.at + shift) / DAY));
      if (!stats) continue;
      if (row.kind === "wifi-drop") stats.drops++;
      else if (row.kind === "wifi-blip") stats.blips++;
      else if (row.kind === "wifi-stuck") stats.stuck++;
      else if (row.kind === "wifi-cannot-connect") stats.cannotConnect++;
    }
    const readings = this.db.prepare("SELECT at, signal FROM signals WHERE at >= ? AND signal IS NOT NULL").all(first * DAY - shift) as Array<{ at: number; signal: number }>;
    for (const reading of readings) {
      const stats = out.get(Math.floor((reading.at + shift) / DAY));
      if (stats && (stats.weakest === null || reading.signal < stats.weakest)) stats.weakest = reading.signal;
    }
    return [...out.values()];
  }

  /** Forgets what is past its keeping time. */
  prune(now: number): void {
    this.db.prepare("DELETE FROM events WHERE at < ?").run(now - EVENT_KEEP_MS);
    this.db.prepare("DELETE FROM signals WHERE at < ?").run(now - SIGNAL_KEEP_MS);
    this.db.prepare("DELETE FROM findings WHERE resolved_at IS NOT NULL AND updated_at < ?").run(now - FINDING_KEEP_MS);
  }
}
