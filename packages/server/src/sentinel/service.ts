import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictError, ValidationError } from "../assistant/store.js";
import { SentinelAudit, type AuditRecord, type ChainCheck } from "./audit.js";
import type { Collector } from "./collector.js";
import { History, type DayStats } from "./history.js";
import { DEFAULT_SETTINGS, type CollectorStatus, type Finding, type PowerEvent, type SentinelEvent, type Settings, type WlanEvent } from "./types.js";
import { replay, WifiIntent, type WifiStats, type WifiView } from "./wifi.js";

/**
 * The Sentinel: watches the machine with no model in the loop. It starts the collector when the person has switched Watch on,
 * keeps what the OS log said in its own history, judges it with the intent rules, and writes what it concluded to the history
 * and to the hash-chained audit. It tells the screens when something changed and acts on nothing by itself: orders come later.
 */

export interface SentinelDeps {
  /** The Sentinel's folder (history, audit, settings, the collector script), or null to keep everything in memory. */
  dir: string | null;
  collector: Collector;
  now?: () => number;
  /** Runs `fn` after `ms` and returns a function that cancels it. A test supplies its own so that time is its to move. */
  schedule?: (ms: number, fn: () => void) => () => void;
  /** Tells the screens that something changed. */
  emit?: (event: { type: "desktop"; reason: "finding" | "settings" | "status"; id?: string }) => void;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
}

export interface StatusView {
  supported: boolean;
  settings: Settings;
  watching: boolean;
  collector: CollectorStatus;
  wifi: WifiView;
  stats: WifiStats;
  open: Finding[];
  /** The newest audit record's number: the whole chain is checked on request. */
  auditHead: number;
}

export interface Digest {
  since: number;
  total: number;
  blips: number;
  drops: number;
  stuck: number;
  flapping: number;
  weakSignal: number;
  down: number;
  cannotConnect: number;
}

/** The longest a timer waits: the engine is looked at least this often, and old history is forgotten at the same pace. */
const HOUSEKEEPING_MS = 30 * 60_000;
const PRUNE_EVERY_MS = 6 * 3_600_000;
/** A timer that runs this much later than planned means the machine was suspended. */
const SUSPEND_GAP_MS = 15_000;
/** After a suspension the OS log's late events are given this long to arrive before any timer is run. */
const RESUME_GRACE_MS = 20_000;
/** An event stamped further ahead than this is not from this machine's clock. */
const FUTURE_MS = 5 * 60_000;
const BATCH_MAX = 50_000;

/** Whether the saved settings ask for Watch: read at server start, before anything is opened, so that an idle Sentinel leaves no file behind. */
export function watchWanted(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Partial<Settings>).watch === true;
  } catch {
    return false;
  }
}

export function parseSettingsPatch(body: Record<string, unknown>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of Object.keys(body)) {
    if (key !== "watch" && key !== "act") throw new ValidationError(key, `${key} is not a setting`);
    const value = body[key];
    if (typeof value !== "boolean") throw new ValidationError(key, `${key} must be true or false`);
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) throw new ValidationError("watch", "say which setting to change: watch or act");
  return patch;
}

export class SentinelService {
  private readonly history: History;
  private readonly audit: SentinelAudit;
  private readonly engine: WifiIntent;
  private readonly now: () => number;
  private readonly schedule: (ms: number, fn: () => void) => () => void;
  private readonly platform: NodeJS.Platform;
  private current: Settings;
  private watching = false;
  private cancel: (() => void) | null = null;
  private plannedAt = 0;
  private inGrace = false;
  private lastPrune = 0;
  private futureNoted = false;
  private lastState: CollectorStatus["state"] = "off";
  /** The events of the history the collector sent first, kept until it says it is done. */
  private batch: Array<WlanEvent | PowerEvent> = [];

  constructor(private readonly deps: SentinelDeps) {
    this.now = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
    this.schedule =
      deps.schedule ??
      ((ms, fn) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.history = History.open(deps.dir ? join(deps.dir, "history.sqlite") : null);
    this.audit = new SentinelAudit(
      deps.dir ? join(deps.dir, "audit.jsonl") : null,
      this.now,
      {
        get: () => {
          const text = this.history.meta("auditHead");
          if (!text) return null;
          try {
            const head = JSON.parse(text) as { seq?: unknown; hash?: unknown };
            return typeof head.seq === "number" && typeof head.hash === "string" ? { seq: head.seq, hash: head.hash } : null;
          } catch {
            return null;
          }
        },
        set: (head) => this.history.setMeta("auditHead", JSON.stringify(head)),
      },
      deps.log,
    );
    this.engine = new WifiIntent((finding) => this.onFinding(finding));
    this.current = this.loadSettings();
  }

  // ---------------------------------------------------------------------------------------------------------------- settings

  settings(): Settings {
    return { ...this.current };
  }

  private settingsPath(): string | null {
    return this.deps.dir ? join(this.deps.dir, "settings.json") : null;
  }

  private loadSettings(): Settings {
    const path = this.settingsPath();
    if (!path) return { ...DEFAULT_SETTINGS };
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
      return { watch: saved.watch === true, act: saved.act === true };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** Changes Watch or Act. Both start off. Switching Watch on or off starts or stops the collector at once. */
  setSettings(patch: Partial<Settings>): Settings {
    if (patch.watch === true && this.platform !== "win32") throw new ConflictError("The Sentinel watches Windows machines only, so Watch cannot be switched on here.");
    const before = this.current;
    this.current = { ...before, ...patch };
    const path = this.settingsPath();
    if (path) {
      mkdirSync(this.deps.dir as string, { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, JSON.stringify(this.current), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    }
    if (before.watch !== this.current.watch || before.act !== this.current.act) {
      this.audit.append("settings", { watch: this.current.watch, act: this.current.act, was: { watch: before.watch, act: before.act } });
    }
    if (this.current.watch) this.watch();
    else this.unwatch();
    this.deps.emit?.({ type: "desktop", reason: "settings" });
    return this.settings();
  }

  // ---------------------------------------------------------------------------------------------------------------- lifecycle

  /** Called once when the server is up: watches when the person has asked it to. */
  start(): void {
    this.audit.append("start", { watch: this.current.watch, act: this.current.act });
    if (this.current.watch) this.watch();
  }

  close(): void {
    this.unwatch();
    this.audit.append("stop");
    this.history.close();
  }

  private watch(): void {
    if (this.watching) return;
    this.watching = true;
    const now = this.now();
    // What a previous run left open cannot be said to still hold: the Sentinel was not looking.
    this.history.closeStale(now);
    this.history.prune(now);
    this.lastPrune = now;
    for (const at of this.history.powerSince(now - 10 * 60_000)) this.engine.seedPower(at);
    this.batch = [];
    this.deps.collector.start(
      {
        event: (event) => this.guard("an event", () => this.onEvent(event)),
        ready: () => this.guard("the history read", () => this.onReady()),
        status: (status) =>
          this.guard("a status", () => {
            if (status.state === "failed" && this.lastState !== "failed") this.audit.append("collector", { state: status.state, error: status.lastError });
            this.lastState = status.state;
            this.deps.emit?.({ type: "desktop", reason: "status" });
          }),
      },
      this.history.lastEventAt(),
    );
    this.reschedule();
  }

  /** What the Sentinel does must never take the server down: a failure is logged and the next event is handled as usual. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.deps.log?.(`sentinel: handling ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private unwatch(): void {
    if (!this.watching) return;
    this.watching = false;
    this.inGrace = false;
    this.deps.collector.stop();
    this.cancel?.();
    this.cancel = null;
  }

  // ------------------------------------------------------------------------------------------------------------------ events

  private onEvent(event: SentinelEvent): void {
    if (event.at > this.now() + FUTURE_MS) {
      if (!this.futureNoted) this.deps.log?.("sentinel: an event stamped in the future was ignored");
      this.futureNoted = true;
      return;
    }
    if (event.kind === "signal") {
      this.history.addSignal(event);
      this.engine.ingest(event);
    } else if (event.backfill) {
      // From a time the Sentinel was not running: history, not news. A recent sleep still explains a disconnect that follows it.
      this.history.addEvent(event);
      if (this.batch.length < BATCH_MAX) this.batch.push(event);
      if (event.kind === "power" && event.at > this.now() - 10 * 60_000) this.engine.seedPower(event.at);
    } else if (this.history.addEvent(event)) {
      // A record the backfill already kept is not judged twice.
      this.engine.ingest(event);
    }
    this.reschedule();
  }

  /**
   * The log's history has all arrived. It is judged with the same rules, so that the history shows what happened while the
   * Sentinel was not watching, and every finding drawn from it is closed: nothing in it is news and none of it can be acted on.
   */
  private onReady(): void {
    const events = this.batch;
    this.batch = [];
    if (events.length === 0) return;
    const { findings } = replay(events);
    for (const finding of findings) {
      this.history.upsertFinding({ ...finding, resolvedAt: finding.resolvedAt ?? finding.updatedAt });
    }
    this.audit.append("backfill", { events: events.length, findings: findings.length, from: events[0]?.at ?? null });
    this.deps.emit?.({ type: "desktop", reason: "status" });
  }

  private onFinding(finding: Finding): void {
    this.history.upsertFinding(finding);
    if (finding.resolvedAt !== null) this.audit.append("resolved", { id: finding.id, kind: finding.kind });
    else if (finding.count === 1) this.audit.append("finding", { id: finding.id, kind: finding.kind, severity: finding.severity, title: finding.title });
    this.deps.emit?.({ type: "desktop", reason: "finding", id: finding.id });
  }

  // ------------------------------------------------------------------------------------------------------------------ timers

  private reschedule(): void {
    // While the late events of a suspension are awaited, the pause is not cut short by events that arrive in it.
    if (this.inGrace) return;
    this.cancel?.();
    this.cancel = null;
    if (!this.watching) return;
    const due = this.engine.nextDue();
    const wait = due === null ? HOUSEKEEPING_MS : Math.min(HOUSEKEEPING_MS, Math.max(250, due - this.now()));
    this.plannedAt = this.now() + wait;
    this.cancel = this.schedule(wait, () => this.onTimer());
  }

  private onTimer(): void {
    this.cancel = null;
    if (!this.watching) return;
    const now = this.now();
    // A timer that runs far later than planned means the machine was suspended. Its sleep and resume events reach the
    // collector a moment after it wakes, and a drop judged before they are in would look real. Wait for them first.
    if (!this.inGrace && now - this.plannedAt > SUSPEND_GAP_MS) {
      this.inGrace = true;
      this.plannedAt = now + RESUME_GRACE_MS;
      this.cancel = this.schedule(RESUME_GRACE_MS, () => this.onTimer());
      return;
    }
    this.inGrace = false;
    this.guard("a timer", () => {
      this.tick();
      if (now - this.lastPrune > PRUNE_EVERY_MS) {
        this.lastPrune = now;
        this.history.prune(now);
      }
    });
    this.reschedule();
  }

  /** Runs what is due at the current time. The timer calls this; a test may call it itself. */
  tick(): void {
    this.engine.tick(this.now());
  }

  // ------------------------------------------------------------------------------------------------------------------ views

  status(): StatusView {
    return {
      supported: this.platform === "win32",
      settings: this.settings(),
      watching: this.watching,
      collector: this.deps.collector.status(),
      wifi: this.engine.view(),
      stats: this.engine.stats,
      open: this.engine.openFindings(),
      auditHead: this.audit.recent(1)[0]?.seq ?? 0,
    };
  }

  findings(options: { open?: boolean; since?: number; limit?: number } = {}): Finding[] {
    return this.history.findings(options);
  }

  /** What the last day held, in counts: the minor findings are reported here, not one by one. */
  digest(): Digest {
    const since = this.now() - 86_400_000;
    const digest: Digest = { since, total: 0, blips: 0, drops: 0, stuck: 0, flapping: 0, weakSignal: 0, down: 0, cannotConnect: 0 };
    for (const finding of this.history.findings({ since, limit: 500 })) {
      digest.total++;
      if (finding.kind === "wifi-blip") digest.blips++;
      else if (finding.kind === "wifi-drop") digest.drops++;
      else if (finding.kind === "wifi-stuck") digest.stuck++;
      else if (finding.kind === "wifi-flapping") digest.flapping++;
      else if (finding.kind === "wifi-weak-signal") digest.weakSignal++;
      else if (finding.kind === "wifi-down") digest.down++;
      else digest.cannotConnect++;
    }
    return digest;
  }

  /** Findings per day, oldest first, in the time zone `offsetMinutes` east of UTC. */
  daily(days: number, offsetMinutes: number): DayStats[] {
    return this.history.daily(this.now(), days, offsetMinutes);
  }

  recentAudit(limit: number): AuditRecord[] {
    return this.audit.recent(limit);
  }

  verifyAudit(): ChainCheck {
    return this.audit.verify();
  }
}
