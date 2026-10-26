/**
 * The owner lock of a data folder: `ancilla.owner`, one JSON line that names the server holding the folder (its
 * instance id, pid, address, start time, and the moment its close began). A second server over the same folder would
 * migrate the database under the first and mark its live runs interrupted, so the store is never opened before the
 * lock is held, taken over, or found unusable.
 *
 * The claim is synchronous (`open` with `wx`, the one exclusive primitive every file system Node runs on offers) and
 * happens in the server's constructor. When a record is already there the claim is contended, and `resolve()` settles
 * it in `listen()`, before the bind: the recorded port is probed for an Ancilla, and the record's pid is only a hint,
 * since pids are recycled and containers share none. A live owner is refused at once (`DataDirOwnedError`, exit code
 * `EXIT_DATA_DIR_OWNED`); one that is closing, booting, or whose port is down with its pid alive is waited for, at most
 * `OWNER_LOCK_WAIT_MS`, then taken over; a dead one is taken over at once. A file system that will not take the file
 * leaves the server running without the lock, with one line in the log: the lock protects the data, it must never keep
 * the data from opening. Servers in one process over one folder share one lock (tests, embedders).
 */
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join, resolve } from "node:path";
import { EXIT_DATA_DIR_OWNED } from "./exitCodes.js";
import { waitUnlessAborted } from "./hostBounds.js";

export const OWNER_LOCK_FILE = "ancilla.owner";

/**
 * The longest a server waits on a folder whose owner is closing, booting, or not answering while its pid is alive,
 * before it takes the folder over. It sits inside `BOOT_BUDGET_MS` with the store's own boot wait
 * (`BOOT_BUSY_TIMEOUT_MS`, the previous owner still closing its database) after it; shutdownBounds.test.ts holds the
 * sum. Longer would overlap a slow owner less often but hold the desktop's splash longer; a graceful close ends in a
 * second or two, so the wait is rarely spent.
 */
export const OWNER_LOCK_WAIT_MS = 10_000;

/**
 * How long a start may take from the constructor to the ready line when everything waits: the lock, the store's boot
 * busy timeout, and the sweeps at boot over a database another process holds locked. The sweeps' waits are cut when
 * the budget ends (what they left is marked at the next start), so the ready line comes within the budget plus the
 * store's own wait. The desktop shell gives up on a sidecar that prints no ready line within its handshake (45 s, in
 * apps/desktop/src-tauri/src/main.rs); shutdownBounds.test.ts holds this budget under it.
 */
export const BOOT_BUDGET_MS = 20_000;

/** How often a contended lock re-reads the record and probes the owner, and how often a contended bind is retried. */
export const OWNER_POLL_MS = 250;

/** How long one probe of the recorded port waits for an answer. */
export const OWNER_PROBE_TIMEOUT_MS = 1_000;

/** The record in `ancilla.owner`. Older builds ignore the file; the format number is for the ones after this. */
export interface OwnerRecord {
  format: 1;
  instanceId: string;
  pid: number;
  host: string;
  /** Null between the claim and the bind. */
  port: number | null;
  startedAt: string;
  /** Set when the owner's `close()` begins. */
  closingAt: string | null;
  ancillaVersion: string;
  platform: string;
}

/** What one server is, for its record; the port and the closing time are filled in as it runs. */
export type OwnerIdentity = Omit<OwnerRecord, "format" | "port" | "closingAt">;

/**
 * What answered on the recorded port: an Ancilla (its instance id when its health could be read, null for an older
 * build that answers 401 without one), something else, or nothing.
 */
export type OwnerProbe = { kind: "ancilla"; instanceId: string | null; closing: boolean } | { kind: "other" } | { kind: "down" };

export interface OwnerLockDeps {
  probe(host: string, port: number): Promise<OwnerProbe>;
  pidAlive(pid: number): boolean;
  now(): number;
  /** Resolves true when the time ran out and false when the signal cut it short; see `waitUnlessAborted`. */
  wait(ms: number, signal?: AbortSignal): Promise<boolean>;
  /** `OWNER_LOCK_WAIT_MS`, or a test's shorter one. */
  waitMs: number;
  log(line: string): void;
}

/**
 * `held`: this lock wrote the record. `reentrant`: another server in this process holds it, and this one shares it.
 * `contended`: a record was there at the claim; `resolve()` decides. `unavailable`: the file could not be written or
 * read, the server runs without the lock. `off`: no lock was asked for (`:memory:`, `dataDirLock: false`).
 * `released`: given back.
 */
export type OwnerLockState = "held" | "reentrant" | "contended" | "unavailable" | "off" | "released";

/** What `/api/health` says about the lock. */
export type OwnerLockHealth = "held" | "off" | "unavailable" | "reentrant";

/** The data folder is owned by a live Ancilla; the message is the one line the command line writes before exit 75. */
export class DataDirOwnedError extends Error {
  readonly exitCode = EXIT_DATA_DIR_OWNED;

  constructor(
    readonly owner: OwnerRecord,
    readonly dataDir: string,
    readonly file: string,
    /** The record was written on another system (a Windows desktop and a WSL command line over one folder). */
    readonly crossPlatform: boolean,
  ) {
    super(ownedMessage(owner, dataDir, file, crossPlatform));
    this.name = "DataDirOwnedError";
  }
}

function ownedMessage(owner: OwnerRecord, dataDir: string, file: string, crossPlatform: boolean): string {
  if (crossPlatform) {
    return (
      `another Ancilla (pid ${owner.pid} on ${owner.platform}, started ${owner.startedAt}) owns the data folder ${dataDir} from another system, ` +
      `where this one cannot see whether it still runs; close it first, or start this one with --data-dir <other folder>. ` +
      `(${file} holds the record: delete it when no other Ancilla runs)`
    );
  }
  const address = `http://${owner.host}:${owner.port ?? "?"}`;
  return (
    `another Ancilla (pid ${owner.pid}, started ${owner.startedAt}, ${address}) owns the data folder ${dataDir}; ` +
    `close it first, or start this one with --data-dir <other folder>. (${file} holds the record)`
  );
}

/** The record a file's text holds, or null when it is not one (empty, cut short, or something else). */
export function parseOwnerRecord(text: string): OwnerRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string | null => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  const instanceId = str("instanceId");
  const host = str("host");
  const startedAt = str("startedAt");
  const platform = str("platform");
  const port = raw["port"];
  const closingAt = raw["closingAt"];
  if (
    raw["format"] !== 1 ||
    instanceId === null ||
    typeof raw["pid"] !== "number" ||
    host === null ||
    !(port === null || (typeof port === "number" && Number.isInteger(port))) ||
    startedAt === null ||
    !(closingAt === null || typeof closingAt === "string") ||
    platform === null
  ) {
    return null;
  }
  return {
    format: 1,
    instanceId,
    pid: raw["pid"] as number,
    host,
    port: port as number | null,
    startedAt,
    closingAt: closingAt as string | null,
    ancillaVersion: str("ancillaVersion") ?? "",
    platform,
  };
}

type ReadResult = { kind: "gone" } | { kind: "torn" } | { kind: "record"; record: OwnerRecord } | { kind: "unreadable"; code: string };

function readRecord(file: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "EIO";
    return code === "ENOENT" ? { kind: "gone" } : { kind: "unreadable", code };
  }
  const record = parseOwnerRecord(text);
  return record ? { kind: "record", record } : { kind: "torn" };
}

function recordText(record: OwnerRecord): string {
  return JSON.stringify(record) + "\n";
}

/** Creates the file with the record, and only if it did not exist: `wx` is `O_EXCL`, which every file system here honours. */
function writeRecordExclusive(file: string, record: OwnerRecord): void {
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, recordText(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Removes the file only while it still names `instanceId`: a successor's record is never deleted. Never throws. */
function deleteIfOwn(file: string, instanceId: string): void {
  try {
    const read = readRecord(file);
    if (read.kind === "record" && read.record.instanceId === instanceId) {
      unlinkSync(file);
    }
  } catch {
    /* the file is gone, or cannot be read or removed: an exit does not wait on it */
  }
}

/** The key the servers of one process share a lock under: one folder, however it was spelled. */
function lockKey(dataDir: string): string {
  let path: string;
  try {
    path = realpathSync.native(dataDir);
  } catch {
    path = resolve(dataDir);
  }
  return process.platform === "win32" ? path.toLowerCase() : path;
}

interface RegistryEntry {
  file: string;
  /** The first holder is the one the file names. */
  holders: OwnerLock[];
}

/** The locks this process holds, by folder; the 'exit' hook releases them all. */
const registry = new Map<string, RegistryEntry>();
let exitHookInstalled = false;

/**
 * What the process 'exit' hook does: removes every record this process wrote and still owns. Synchronous, since an
 * exit waits for nothing, and it never throws: a file that is gone, foreign, or that cannot be removed is left.
 */
export function releaseAllOwnerLocksSync(): void {
  for (const entry of registry.values()) {
    const first = entry.holders[0];
    if (first) {
      deleteIfOwn(entry.file, first.record.instanceId);
    }
  }
  registry.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once("exit", releaseAllOwnerLocksSync);
}

/** The probe of `OwnerLockDeps`, over a real request to `/api/health` of the recorded address. */
export function probeOwner(host: string, port: number): Promise<OwnerProbe> {
  const target = host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const hostHeader = target.includes(":") ? `[${target}]:${port}` : `${target}:${port}`;
  return new Promise((done) => {
    // Its own connection, closed with the answer: nothing is kept open on the owner.
    const request = httpGet(
      { host: target, port, path: "/api/health", headers: { host: hostHeader, connection: "close" }, timeout: OWNER_PROBE_TIMEOUT_MS, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", () => done({ kind: "down" }));
        response.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            done({ kind: "other" });
            return;
          }
          const object = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
          if (object === null) {
            done({ kind: "other" });
          } else if (response.statusCode === 401 && "error" in object) {
            // An Ancilla with a token and no public health yet: it is there, but which one cannot be read.
            done({ kind: "ancilla", instanceId: null, closing: false });
          } else if (response.statusCode === 200 && typeof object["ok"] === "boolean" && typeof object["version"] === "string") {
            done({ kind: "ancilla", instanceId: typeof object["instanceId"] === "string" ? object["instanceId"] : null, closing: object["closing"] === true });
          } else {
            done({ kind: "other" });
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => done({ kind: "down" }));
  });
}

/** The pid check of `OwnerLockDeps`: a process that exists, whoever owns it (a permission error is still an answer). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function defaultOwnerLockDeps(log: (line: string) => void): OwnerLockDeps {
  return { probe: probeOwner, pidAlive, now: () => Date.now(), wait: waitUnlessAborted, waitMs: OWNER_LOCK_WAIT_MS, log };
}

export class OwnerLock {
  state: OwnerLockState;
  /** The record this server writes; its port and closing time are filled in as it runs. */
  readonly record: OwnerRecord;
  /** The record found at the claim, when there was one; what `DataDirOwnedError` names. */
  existing: OwnerRecord | null = null;
  /** A record was there at the claim, whatever became of it: the port may still be held by the tail of its close. */
  wasContended = false;
  /** The owner was closing and did not finish within the wait, so the folder was taken from it. */
  tookOverFromClosing = false;
  readonly file: string | null;
  private readonly key: string | null;

  private constructor(
    readonly dataDir: string,
    identity: OwnerIdentity,
    private readonly deps: OwnerLockDeps,
    enabled: boolean,
  ) {
    this.record = { format: 1, ...identity, port: null, closingAt: null };
    const on = enabled && dataDir !== ":memory:";
    this.file = on ? join(dataDir, OWNER_LOCK_FILE) : null;
    this.key = on ? lockKey(dataDir) : null;
    this.state = on ? "contended" : "off";
  }

  /**
   * Claims the folder, synchronously: held, reentrant, contended (a record is there; `resolve()` decides before the
   * bind), or unavailable. Never throws.
   */
  static claim(dataDir: string, identity: OwnerIdentity, deps: OwnerLockDeps, options: { enabled?: boolean } = {}): OwnerLock {
    const lock = new OwnerLock(dataDir, identity, deps, options.enabled !== false);
    if (lock.state === "off") {
      return lock;
    }
    const entry = registry.get(lock.key as string);
    if (entry) {
      entry.holders.push(lock);
      lock.state = "reentrant";
      return lock;
    }
    // A record removed between the claim and the read is a vanished owner: claim again, a few times at most.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (lock.tryClaim()) {
        return lock;
      }
      lock.wasContended = true;
      const read = readRecord(lock.file as string);
      if (read.kind === "unreadable") {
        lock.unavailable(read.code, "read");
        return lock;
      }
      if (read.kind !== "gone") {
        lock.existing = read.kind === "record" ? read.record : null;
        return lock;
      }
    }
    return lock;
  }

  /** The lock as `/api/health` reports it. */
  healthLock(): OwnerLockHealth {
    switch (this.state) {
      case "reentrant":
        return "reentrant";
      case "unavailable":
        return "unavailable";
      case "held":
      case "contended":
        return "held";
      default:
        return "off";
    }
  }

  /**
   * Writes the record exclusively and reads it back: held when the file names this instance, else contended with what
   * it names (on a file system where `wx` were not exclusive the last writer wins, and the loser sees a foreign id).
   * False when the file exists; a failure other than that makes the lock unavailable.
   */
  private tryClaim(): boolean {
    const file = this.file as string;
    try {
      writeRecordExclusive(file, this.record);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "EIO";
      if (code === "EEXIST") {
        return false;
      }
      this.unavailable(code, "written");
      return true;
    }
    const back = readRecord(file);
    if (back.kind === "record" && back.record.instanceId === this.record.instanceId) {
      this.state = "held";
      registry.set(this.key as string, { file, holders: [this] });
      installExitHook();
      return true;
    }
    this.wasContended = true;
    this.existing = back.kind === "record" ? back.record : null;
    this.state = "contended";
    return true;
  }

  private unavailable(code: string, what: "written" | "read" | "replaced"): void {
    this.state = "unavailable";
    this.deps.log(`the data folder lock could not be ${what} (${code}): running without it. Another Ancilla over ${this.dataDir} would not be noticed.`);
  }

  /**
   * Settles a contended claim: refuses a live owner (`DataDirOwnedError`), waits for one that is closing, booting or
   * silent with its pid alive, and takes over a dead one. Bounded by `budgetMs` (`deps.waitMs` by default); a `signal`
   * that fires ends the wait with nothing taken, the lock still contended. Nothing to do in any other state.
   */
  async resolve(options: { signal?: AbortSignal; budgetMs?: number } = {}): Promise<void> {
    if (this.state !== "contended") {
      return;
    }
    const file = this.file as string;
    const budgetMs = options.budgetMs ?? this.deps.waitMs;
    const started = this.deps.now();
    const spent = () => this.deps.now() - started >= budgetMs;
    for (;;) {
      if (options.signal?.aborted) {
        return;
      }
      // Another server in this process took the folder meanwhile: share its lock.
      const entry = registry.get(this.key as string);
      if (entry) {
        entry.holders.push(this);
        this.state = "reentrant";
        return;
      }
      const read = readRecord(file);
      if (read.kind === "unreadable") {
        this.unavailable(read.code, "read");
        return;
      }
      if (read.kind === "gone") {
        // The owner has gone; a second EEXIST means another launcher won this instant, and it is now booting.
        if (this.tryClaim()) {
          return;
        }
      } else if (read.kind === "torn") {
        // An owner rewriting its record in place (its port, its closing time), or one that was stopped mid-write:
        // re-read until the budget ends, and only then take the folder.
        if (spent()) {
          this.takeOver("its record could not be read");
          if (this.state !== "contended") return;
        }
      } else {
        const record = read.record;
        this.existing = record;
        const verdict = await this.judge(record);
        if (verdict === "live") {
          throw new DataDirOwnedError(record, this.dataDir, file, false);
        }
        if (verdict === "foreign") {
          throw new DataDirOwnedError(record, this.dataDir, file, true);
        }
        if (verdict === "stale") {
          this.takeOver(`the Ancilla it named (pid ${record.pid}) is gone`);
          if (this.state !== "contended") return;
        } else if (spent()) {
          this.tookOverFromClosing = verdict === "closing";
          this.takeOver(
            verdict === "closing"
              ? `the Ancilla closing there (pid ${record.pid}) did not finish within ${Math.round(budgetMs / 1000)} s`
              : `the Ancilla it named (pid ${record.pid}) did not answer within ${Math.round(budgetMs / 1000)} s`,
          );
          if (this.state !== "contended") return;
        }
      }
      if (!(await this.deps.wait(OWNER_POLL_MS, options.signal))) {
        return;
      }
    }
  }

  /**
   * What the record's owner is: `live` (an Ancilla answers on the port as that instance, or as an older build with the
   * pid alive, and is not closing), `closing`, `waiting` (no answer, or no port yet, with the pid alive: booting,
   * blocked, or a recycled pid), `stale` (something else on the port, another Ancilla there, or no answer and no
   * process), or `foreign` (written on another system, whose processes and loopback this one cannot see).
   */
  private async judge(record: OwnerRecord): Promise<"live" | "closing" | "waiting" | "stale" | "foreign"> {
    if (record.platform !== this.record.platform) {
      return "foreign";
    }
    if (record.port !== null) {
      const probe = await this.deps.probe(record.host, record.port);
      if (probe.kind === "other") {
        return "stale";
      }
      if (probe.kind === "ancilla") {
        if (probe.instanceId !== null && probe.instanceId !== record.instanceId) {
          return "stale";
        }
        if (probe.instanceId === null && !this.deps.pidAlive(record.pid)) {
          return "stale";
        }
        return probe.closing || record.closingAt !== null ? "closing" : "live";
      }
    }
    if (!this.deps.pidAlive(record.pid)) {
      return "stale";
    }
    return record.closingAt !== null ? "closing" : "waiting";
  }

  /** Removes the record and claims the folder; a record that reappears in between belongs to a launcher that won. */
  private takeOver(why: string): void {
    this.deps.log(`taking over the data folder ${this.dataDir}: ${why}.`);
    try {
      unlinkSync(this.file as string);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "EIO";
      if (code !== "ENOENT") {
        this.unavailable(code, "replaced");
        return;
      }
    }
    this.tryClaim();
  }

  /** Whether this lock's record is the one in the file. */
  private namesTheFile(): boolean {
    return (this.state === "held" || this.state === "reentrant") && registry.get(this.key as string)?.holders[0] === this;
  }

  /** Rewrites the record in place; a reader that catches it half written re-reads. Best effort: the lock is not the data. */
  private rewrite(): void {
    try {
      writeFileSync(this.file as string, recordText(this.record));
    } catch (error) {
      this.deps.log(`the data folder lock could not be updated (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
    }
  }

  /** Records the bound port, for the probe of a later launcher. */
  setPort(port: number): void {
    this.record.port = port;
    if (this.namesTheFile()) {
      this.rewrite();
    }
  }

  /** Records that the close has begun: a launcher waiting on this folder keeps waiting instead of refusing. */
  markClosing(): void {
    if (this.record.closingAt !== null) {
      return;
    }
    this.record.closingAt = new Date(this.deps.now()).toISOString();
    if (this.namesTheFile()) {
      this.rewrite();
    }
  }

  /**
   * Gives the folder back, after the store is closed: the next server in this process over the folder takes the file
   * (its record is written there), and the last one removes it, only while it still names this instance.
   */
  release(): void {
    if (this.state !== "held" && this.state !== "reentrant") {
      this.state = this.state === "contended" ? "released" : this.state;
      return;
    }
    const entry = registry.get(this.key as string);
    const named = entry?.holders[0] === this;
    if (entry) {
      entry.holders = entry.holders.filter((holder) => holder !== this);
      const next = entry.holders[0];
      if (named && next) {
        next.state = "held";
        next.rewrite();
      } else if (named) {
        deleteIfOwn(entry.file, this.record.instanceId);
        registry.delete(this.key as string);
      }
    }
    this.state = "released";
  }
}

/** The claim as the server makes it; see `OwnerLock.claim`. */
export function claimOwnerLock(dataDir: string, identity: OwnerIdentity, deps: OwnerLockDeps, options: { enabled?: boolean } = {}): OwnerLock {
  return OwnerLock.claim(dataDir, identity, deps, options);
}
