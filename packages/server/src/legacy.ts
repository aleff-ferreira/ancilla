import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Ancilla is a fork of Helicon, and a Helicon user's projects, pins, thread titles and runtime choice live in
 * Helicon's data folder. The first time an Ancilla data dir starts, it starts from a copy of them. Helicon's
 * files are only ever read, so both apps keep working side by side.
 */

/** The database Ancilla keeps in its data dir. */
export const DB_FILE = "ancilla.db";
/** Helicon's database, in whichever folder Helicon used. */
export const LEGACY_DB_FILE = "helicon.db";
const RUNTIME_FILE = "runtime.json";
/** Tauri's per-app data folders, named by bundle identifier, sit side by side in the same parent folder. */
const DESKTOP_DIR = "app.ancilla.desktop";
const LEGACY_DESKTOP_DIR = "app.helicon.desktop";
/** How long the snapshot waits on a write Helicon has in flight before giving up and starting fresh. */
const BUSY_TIMEOUT_MS = 3000;
/** The snapshot is built under this name beside `ancilla.db`, with the importing process's pid in the middle. */
const COPY_PREFIX = `.${DB_FILE}.import-`;
const COPY_SUFFIX = ".tmp";
/** A snapshot nobody has written to for this long belongs to an import that was killed partway. */
const STALE_COPY_MS = 60_000;
/**
 * Windows can refuse a rename for a moment while an antivirus scanner or the search indexer holds the new file. A few
 * tries, 100 ms apart, stay far inside the desktop app's wait for the server.
 */
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 100;
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

export type LegacyLog = (message: string) => void;

/**
 * A setting from the environment: `ANCILLA_<name>`, else the `HELICON_<name>` a Helicon user may still export.
 * Build-time variables do not need it.
 */
export function envSetting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`ANCILLA_${name}`] ?? env[`HELICON_${name}`];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The Helicon folder this data dir starts from: the first with a `helicon.db`, looking in the data dir itself,
 * then (for the desktop app) Helicon's desktop folder beside it, then (for the default `~/.ancilla`) `~/.helicon`.
 */
export function legacyDataDir(dataDir: string, home: string): string | null {
  if (dataDir === ":memory:") {
    return null;
  }
  const candidates = [dataDir];
  if (basename(dataDir) === DESKTOP_DIR) {
    candidates.push(join(dirname(dataDir), LEGACY_DESKTOP_DIR));
  }
  if (resolve(dataDir) === resolve(home, ".ancilla")) {
    candidates.push(join(home, ".helicon"));
  }
  return candidates.find((dir) => isFile(join(dir, LEGACY_DB_FILE))) ?? null;
}

/** Whether this data dir has never started: no database yet, so Helicon's data may seed it. */
function unstarted(dataDir: string): boolean {
  return dataDir !== ":memory:" && !existsSync(join(dataDir, DB_FILE));
}

/**
 * Copies Helicon's `runtime.json` (runtime, distro, Muse path, WSL environment) into a data dir that has not started
 * yet and has none of its own. It has to run before the server reads that file, and so before the database import,
 * which is what marks the data dir as started. Only a JSON object is copied: the server will not start on a broken one.
 */
export function importLegacyRuntime(dataDir: string, home: string, log: LegacyLog): boolean {
  const target = join(dataDir, RUNTIME_FILE);
  if (!unstarted(dataDir) || existsSync(target)) {
    return false;
  }
  const legacy = legacyDataDir(dataDir, home);
  const source = legacy ? join(legacy, RUNTIME_FILE) : null;
  if (!source || !isFile(source)) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(source, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("it is not a JSON object");
    }
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    log(`imported Helicon's runtime settings from ${source}`);
    return true;
  } catch (error) {
    log(`did not import Helicon's runtime settings from ${source}: ${String(error)}`);
    return false;
  }
}

/**
 * Removes the snapshots of imports that were killed partway (the desktop app stopped waiting, the user quit). It runs
 * on every start, not only a first one, since a copy killed less than a minute before the next start is still there
 * after that start's own import. A copy written to within the last minute may be another Ancilla's import in progress,
 * so it is left alone.
 */
function removeStaleSnapshots(dataDir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(COPY_PREFIX) || !name.endsWith(COPY_SUFFIX)) {
      continue;
    }
    try {
      const path = join(dataDir, name);
      if (now - statSync(path).mtimeMs > STALE_COPY_MS) {
        rmSync(path, { force: true });
      }
    } catch {
      /* gone already, or still held; a later start tries again */
    }
  }
}

/** Blocks the thread for `ms`. The import runs before the server does anything else, so there is nothing to yield to. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Moves a finished snapshot into place as `ancilla.db`, unless one appeared while it was being made: another Ancilla
 * starting at the same moment may already have that one open, and replacing it would lose its writes. On Windows a
 * rename refused by a scanner holding the new file is tried again a few times.
 */
export function publishSnapshot(
  temp: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 1; ; attempt += 1) {
    if (existsSync(target)) {
      throw new Error(`${target} was created while importing`);
    }
    try {
      rename(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_ERRORS.has(code)) {
        throw error;
      }
      pause(RENAME_RETRY_MS);
    }
  }
}

/**
 * Seeds a data dir that has no `ancilla.db` from Helicon's database. A read-only connection runs VACUUM INTO, which
 * copies one read transaction: a consistent snapshot even while Helicon is running, including anything committed to a
 * WAL, and Helicon's file is never opened for writing. (Helicon keeps SQLite's default rollback journal, which a
 * reader leaves no trace in; a WAL-mode database that nothing has open would get empty `-wal` and `-shm` files beside
 * it, which SQLite reads as no pending writes.) The copy is built beside the target, flushed, and renamed into place,
 * so `ancilla.db` is either the whole snapshot or absent. Any failure removes the partial copy and returns false, and
 * the store starts empty as on a fresh install.
 */
export function importLegacyDatabase(dataDir: string, home: string, log: LegacyLog): boolean {
  if (dataDir !== ":memory:") {
    removeStaleSnapshots(dataDir);
  }
  if (!unstarted(dataDir)) {
    return false;
  }
  const legacy = legacyDataDir(dataDir, home);
  if (!legacy) {
    return false;
  }
  const source = join(legacy, LEGACY_DB_FILE);
  const target = join(dataDir, DB_FILE);
  const temp = join(dataDir, `${COPY_PREFIX}${process.pid}${COPY_SUFFIX}`);
  let db: DatabaseSync | null = null;
  try {
    mkdirSync(dataDir, { recursive: true });
    rmSync(temp, { force: true });
    db = new DatabaseSync(source, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.prepare("VACUUM INTO ?").run(temp);
    db.close();
    db = null;
    const fd = openSync(temp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    publishSnapshot(temp, target);
    log(`imported Helicon's data from ${source}`);
    return true;
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(temp, { force: true });
    } catch {
      /* nothing more to do; the store still starts */
    }
    const next = existsSync(target) ? `keeping the ${DB_FILE} another Ancilla created meanwhile` : "starting fresh";
    log(`could not import Helicon's data from ${source}, ${next}: ${String(error)}`);
    return false;
  }
}
