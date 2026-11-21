import { createHash } from "node:crypto";
import type { DisconnectClass, FailureClass, Finding, FindingKind, PowerEvent, SentinelEvent, Severity, SignalEvent, WlanEvent } from "./types.js";

/** A short, stable stand-in for a name inside a key or an id: names are data, and data does not become part of an identifier. */
function tag(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * The rules that turn what Windows records about Wi-Fi into findings. The same rules judge a live stream and a replayed log, and
 * the engine never reads a clock or a random number: time is the timestamp of the events it is given and the `now` it is
 * advanced to, so a test can drive it second by second.
 *
 * Intent, measured on a real machine (82 disconnects in 40 days: 45 by the driver, 27 by the person, 10 by policy or a state
 * change; 35 within 90 s of a sleep or a resume; 20 real drops in the middle of a session): reconnecting on every disconnect
 * would act 82 times for about 13 cases that needed it. So a disconnect the person asked for, one the system caused around a
 * sleep or a resume, and one that comes back by itself are not acted on. A failed attempt at a network that wants a login
 * nobody has given, or that the person cancelled, is not a failure.
 */

export interface Rules {
  /** A disconnect this close to a sleep or a resume (before or after) is the system's own doing. */
  nearPowerMs: number;
  /** How long a disconnect waits before it is judged, so that a sleep that follows it is seen. */
  holdMs: number;
  /** A drop that ends within this is a blip: counted, not reported. */
  blipMs: number;
  /** An attempt that has been connecting this long is stuck. */
  stuckMs: number;
  /** This many real drops within `flapWindowMs` is a connection that keeps dropping. */
  flapCount: number;
  flapWindowMs: number;
  /** A real drop that has not recovered after this long is serious. */
  downMs: number;
  /** Signal quality at or under this, for `weakSamples` readings in a row, is weak; at or over `okPercent` for `okSamples` readings it is not. */
  weakPercent: number;
  weakSamples: number;
  okPercent: number;
  okSamples: number;
  /** This many failed attempts within `failureWindowMs` on one profile is a network that cannot be joined. */
  failureCount: number;
  failureWindowMs: number;
  /** An attempt that takes longer than this is slow (counted, not reported). */
  slowAttemptMs: number;
  /** An attempt still open after this long is forgotten. */
  attemptMaxMs: number;
}

export const RULES: Rules = {
  nearPowerMs: 90_000,
  holdMs: 15_000,
  blipMs: 10_000,
  stuckMs: 20_000,
  flapCount: 3,
  flapWindowMs: 10 * 60_000,
  downMs: 5 * 60_000,
  weakPercent: 40,
  weakSamples: 3,
  okPercent: 50,
  okSamples: 3,
  failureCount: 3,
  failureWindowMs: 10 * 60_000,
  slowAttemptMs: 15_000,
  attemptMaxMs: 10 * 60_000,
};

/** `ReasonCode` of an 8003: 0 the driver, 2 the person, 3 the person asking for a new connection, 5 and 7 policy, 11 a state change (radio off, for one). */
export function disconnectClass(code: number | null, reason: string): DisconnectClass {
  switch (code) {
    case 0:
      return "driver";
    case 2:
    case 3:
      return "user";
    case 5:
    case 7:
      return "policy";
    case 11:
      return "state";
  }
  // A code this table does not know: only English words are understood, and anything else is left alone.
  const words = reason.toLowerCase();
  if (/\bby the driver\b/.test(words)) return "driver";
  if (/\bby the user\b|\buser wants\b/.test(words)) return "user";
  return "unknown";
}

/** `ReasonCode` of an 8002. */
export function failureClass(code: number | null, reason: string): FailureClass {
  switch (code) {
    case 229396:
      return "no-access-point";
    case 229378:
      return "driver";
    case 163851:
      return "unavailable";
    case 229377:
      return "cancelled";
    case 327681:
      return "no-credentials";
  }
  return /\bcancel/i.test(reason) ? "cancelled" : "other";
}

export interface WifiStats {
  /** Every 8003, by why it happened. */
  disconnects: Record<DisconnectClass, number>;
  /** Disconnects of any class that were within `nearPowerMs` of a sleep or a resume, and the driver ones among them. */
  nearPower: number;
  nearPowerDriver: number;
  /** Driver disconnects away from any sleep or resume. */
  realDrops: number;
  /** Real drops that came back within `blipMs`. */
  blips: number;
  attempts: number;
  slowAttempts: number;
  stuck: number;
  failures: Record<FailureClass, number>;
}

const emptyStats = (): WifiStats => ({
  disconnects: { driver: 0, user: 0, policy: 0, state: 0, unknown: 0 },
  nearPower: 0,
  nearPowerDriver: 0,
  realDrops: 0,
  blips: 0,
  attempts: 0,
  slowAttempts: 0,
  stuck: 0,
  failures: { "no-access-point": 0, driver: 0, unavailable: 0, cancelled: 0, "no-credentials": 0, other: 0 },
});

export interface WifiView {
  state: "unknown" | "connected" | "connecting" | "disconnected";
  profile: string;
  ssid: string;
  since: number | null;
  signal: SignalEvent | null;
}

/** A connection attempt that has started and not ended. The log reuses one ConnectionId for many attempts, so an attempt is known by its profile. */
interface Attempt {
  profile: string;
  startAt: number;
  raised: boolean;
}

interface Pending {
  at: number;
  profile: string;
  cls: DisconnectClass;
  regainedAt: number | null;
}

interface Down {
  at: number;
  profile: string;
}

const RANK: Record<Severity, number> = { minor: 0, warn: 1, critical: 2 };

/** Seconds as a person says them: "4 s", "2 min 10 s". */
export function spoken(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/** A signal quality in percent as the dBm Windows maps it to (quality / 2 - 100). */
export function dbm(percent: number): number {
  return Math.round(percent / 2 - 100);
}

export class WifiIntent {
  readonly stats: WifiStats = emptyStats();
  private readonly rules: Rules;
  private clock = 0;
  private connection: { state: WifiView["state"]; profile: string; ssid: string; since: number | null } = { state: "unknown", profile: "", ssid: "", since: null };
  private last: SignalEvent | null = null;
  private readonly attempts = new Map<string, Attempt>();
  private pending: Pending[] = [];
  private down: Down | null = null;
  private power: number[] = [];
  private drops: number[] = [];
  private readonly failed = new Map<string, number[]>();
  private readonly open = new Map<string, Finding>();
  private weakRun = 0;
  private okRun = 0;

  constructor(
    private readonly emit: (finding: Finding) => void,
    rules: Partial<Rules> = {},
  ) {
    this.rules = { ...RULES, ...rules };
  }

  // ------------------------------------------------------------------------------------------------------------------ input

  /** Gives the engine one event. Timers that fall due before it are run first, so that every rule sees the world as it was. */
  ingest(event: SentinelEvent): void {
    this.advance(event.at, false);
    if (event.kind === "power") this.onPower(event);
    else if (event.kind === "signal") this.onSignal(event);
    else if (event.id === 8000) this.onStart(event);
    else if (event.id === 8001) this.onConnected(event);
    else if (event.id === 8002) this.onFailed(event);
    else this.onDisconnected(event);
  }

  /** A sleep or a resume that happened before the engine started listening (read back from the history). */
  seedPower(at: number): void {
    this.power.push(at);
  }

  /** Runs every timer that is due at `now`. */
  tick(now: number): void {
    this.advance(now, true);
  }

  /** When the next timer falls due, or null when nothing waits: the caller sleeps until then. */
  nextDue(): number | null {
    return this.due(Number.POSITIVE_INFINITY, true)?.at ?? null;
  }

  view(): WifiView {
    return { ...this.connection, signal: this.last };
  }

  openFindings(): Finding[] {
    return [...this.open.values()].map((finding) => ({ ...finding }));
  }

  // ----------------------------------------------------------------------------------------------------------------- timers

  private advance(to: number, inclusive: boolean): void {
    for (;;) {
      const next = this.due(to, inclusive);
      if (!next) break;
      this.clock = Math.max(this.clock, next.at);
      next.run();
    }
    this.clock = Math.max(this.clock, to);
    // Old power events are only kept while a disconnect they could explain may still be judged.
    const keep = this.clock - this.rules.nearPowerMs - this.rules.holdMs - 60_000;
    if (this.power.length > 2 && this.power[0] !== undefined && this.power[0] < keep) this.power = this.power.filter((at, i) => at >= keep || i >= this.power.length - 2);
    const windowStart = this.clock - this.rules.flapWindowMs;
    if (this.drops.length > 0 && this.drops.some((at) => at <= windowStart)) this.drops = this.drops.filter((at) => at > windowStart);
  }

  /** The earliest timer at or before `to` (before it, unless `inclusive`), with what to do when it falls due. */
  private due(to: number, inclusive: boolean): { at: number; run: () => void } | null {
    let best: { at: number; run: () => void } | null = null;
    const offer = (at: number, run: () => void): void => {
      if (at > to || (at === to && !inclusive)) return;
      if (best === null || at < best.at) best = { at, run };
    };
    for (const pending of this.pending) offer(pending.at + this.rules.holdMs, () => this.judge(pending));
    for (const attempt of this.attempts.values()) {
      if (!attempt.raised) offer(attempt.startAt + this.rules.stuckMs, () => this.stuck(attempt));
      offer(attempt.startAt + this.rules.attemptMaxMs, () => this.endAttempt(attempt, attempt.startAt + this.rules.attemptMaxMs, "It was given up on"));
    }
    if (this.down && !this.open.has("wifi-down")) {
      const down = this.down;
      offer(down.at + this.rules.downMs, () => this.serious(down));
    }
    if (this.open.has("wifi-flapping") && this.drops.length >= this.rules.flapCount) {
      // The moment the count in the window falls under the limit: when the (count - limit + 1)th oldest drop leaves it.
      const leaving = this.drops[this.drops.length - this.rules.flapCount];
      if (leaving !== undefined) offer(leaving + this.rules.flapWindowMs, () => this.calm(leaving + this.rules.flapWindowMs));
    } else if (this.open.has("wifi-flapping")) {
      offer(this.clock, () => this.calm(this.clock));
    }
    return best;
  }

  private judge(pending: Pending): void {
    this.pending = this.pending.filter((p) => p !== pending);
    const at = pending.at + this.rules.holdMs;
    if (this.power.some((moment) => Math.abs(moment - pending.at) <= this.rules.nearPowerMs)) {
      this.stats.nearPower++;
      if (pending.cls === "driver") this.stats.nearPowerDriver++;
      return;
    }
    // Only the driver letting go in the middle of a session is a drop. The person's own choice, a policy, a radio switched off
    // and what this table does not know are the system or the person acting, and nothing here answers them.
    if (pending.cls !== "driver") return;
    this.stats.realDrops++;
    this.drops.push(pending.at);
    const back = pending.regainedAt === null ? null : pending.regainedAt - pending.at;
    if (back !== null && back <= this.rules.blipMs) {
      this.stats.blips++;
      const blip = this.raise(`wifi-blip:${pending.at}`, "wifi-blip", "minor", `Wi-Fi dropped for ${spoken(back)}`, "The connection came back by itself. Brief drops like this are counted in the digest.", pending.at);
      this.resolve(blip.key, pending.regainedAt ?? at);
    } else {
      const key = `wifi-drop:${pending.at}`;
      if (back === null) {
        this.raise(key, "wifi-drop", "warn", "Wi-Fi dropped", `The adapter lost the connection and has not recovered after ${spoken(this.rules.holdMs)}.`, pending.at);
        this.down = { at: pending.at, profile: pending.profile };
      } else {
        this.raise(key, "wifi-drop", "warn", "Wi-Fi dropped", `The connection came back after ${spoken(back)}.`, pending.at);
        this.resolve(key, pending.regainedAt ?? at);
      }
    }
    const recent = this.drops.filter((moment) => moment > at - this.rules.flapWindowMs).length;
    if (recent >= this.rules.flapCount) {
      const minutes = Math.round(this.rules.flapWindowMs / 60_000);
      this.raise(
        "wifi-flapping",
        "wifi-flapping",
        recent >= this.rules.flapCount * 2 ? "critical" : "warn",
        "Wi-Fi keeps dropping",
        `${recent} drops in the last ${minutes} minutes. A weak signal is the usual cause; moving the PC or the router closer helps more than any automation.`,
        at,
      );
    }
  }

  private stuck(attempt: Attempt): void {
    attempt.raised = true;
    this.stats.stuck++;
    this.raise(`wifi-stuck:${tag(attempt.profile)}`, "wifi-stuck", "warn", "Wi-Fi is stuck connecting", `A connection attempt has not finished after ${spoken(this.rules.stuckMs)}.`, attempt.startAt + this.rules.stuckMs);
  }

  private serious(down: Down): void {
    if (this.power.some((moment) => moment > down.at)) {
      // The machine slept since: the drop is not what is keeping it offline.
      this.down = null;
      return;
    }
    this.raise("wifi-down", "wifi-down", "critical", `Wi-Fi has been down for ${spoken(this.rules.downMs)}`, "The adapter has not reconnected since a real drop.", down.at + this.rules.downMs);
  }

  private calm(at: number): void {
    this.resolve("wifi-flapping", at, "The drops stopped.");
  }

  // ---------------------------------------------------------------------------------------------------------------- events

  private onStart(e: WlanEvent): void {
    this.stats.attempts++;
    // A new attempt on a profile ends the one before it: the person cancelled and tried again, or Windows gave up on it silently.
    const older = this.attempts.get(e.profile);
    if (older) this.endAttempt(older, e.at, "It was replaced by a new attempt");
    this.attempts.set(e.profile, { profile: e.profile, startAt: e.at, raised: false });
    this.connection = { state: "connecting", profile: e.profile, ssid: e.ssid, since: e.at };
  }

  private onConnected(e: WlanEvent): void {
    const attempt = this.attempts.get(e.profile);
    if (attempt && attempt.startAt <= e.at) this.endAttempt(attempt, e.at, "It connected");
    this.connected(e.at, e.profile, e.ssid);
  }

  /** Whatever told the engine so, the machine is connected now. */
  private connected(at: number, profile: string, ssid: string): void {
    for (const pending of this.pending) if (pending.regainedAt === null && pending.at <= at) pending.regainedAt = at;
    for (const finding of [...this.open.values()]) {
      // A "down" finding is raised minutes after the drop it is about.
      const since = finding.kind === "wifi-down" && this.down ? this.down.at : finding.at;
      if (finding.kind === "wifi-drop" || finding.kind === "wifi-down") this.resolve(finding.key, at, `Back after ${spoken(at - since)}.`);
    }
    this.resolve(`wifi-cannot-connect:${tag(profile)}`, at, "It connected.");
    this.failed.delete(profile);
    this.down = null;
    this.connection = { state: "connected", profile, ssid, since: at };
  }

  private onFailed(e: WlanEvent): void {
    const attempt = this.attempts.get(e.profile);
    if (attempt && attempt.startAt <= e.at) this.endAttempt(attempt, e.at, "It failed");
    const cls = failureClass(e.code, e.reason);
    this.stats.failures[cls]++;
    if (this.connection.state === "connecting") this.connection = { ...this.connection, state: "disconnected", since: e.at };
    // The person cancelling, and a network that asks for a login nobody has given it (a campus network seen from a bench), are not failures.
    if (cls === "cancelled" || cls === "no-credentials") return;
    const times = (this.failed.get(e.profile) ?? []).filter((at) => at > e.at - this.rules.failureWindowMs);
    times.push(e.at);
    this.failed.set(e.profile, times);
    if (times.length >= this.rules.failureCount) {
      const why = cls === "no-access-point" ? "no access point was visible" : cls === "driver" ? "the driver disconnected while joining" : cls === "unavailable" ? "the network was not available" : "the attempts failed";
      this.raise(`wifi-cannot-connect:${tag(e.profile)}`, "wifi-cannot-connect", "warn", "Wi-Fi cannot connect", `${times.length} attempts failed in the last ${Math.round(this.rules.failureWindowMs / 60_000)} minutes: ${why}.`, e.at);
    }
  }

  private onDisconnected(e: WlanEvent): void {
    const cls = disconnectClass(e.code, e.reason);
    this.stats.disconnects[cls]++;
    // The person (or the driver) ending an attempt that was in progress ends it. A disconnect "because the person wants a new
    // connection" is the old connection making way for the attempt that has begun, not the end of that attempt.
    const attempt = this.attempts.get(e.profile);
    if (attempt && attempt.startAt < e.at && e.code !== 3) this.endAttempt(attempt, e.at, "It ended with the connection");
    this.connection = { state: "disconnected", profile: e.profile, ssid: e.ssid, since: e.at };
    this.pending.push({ at: e.at, profile: e.profile, cls, regainedAt: null });
    if (this.pending.length > 200) this.pending.shift();
  }

  private onPower(e: PowerEvent): void {
    this.power.push(e.at);
    if (this.power.length > 400) this.power.shift();
    // Whatever was being joined before a sleep is not being joined after it.
    if (e.change === "sleep") for (const attempt of [...this.attempts.values()]) this.endAttempt(attempt, e.at, "It was cut off by a sleep");
  }

  private onSignal(e: SignalEvent): void {
    this.last = e;
    // A reading older than the last change of state says nothing about the present.
    if (e.connected && this.connection.state !== "connected" && e.at >= (this.connection.since ?? 0)) this.connected(e.at, this.connection.profile, this.connection.ssid);
    if (!e.connected || e.signal === null) {
      this.weakRun = 0;
      this.okRun = 0;
      return;
    }
    if (e.signal <= this.rules.weakPercent) {
      this.weakRun++;
      this.okRun = 0;
      if (this.weakRun >= this.rules.weakSamples && !this.open.has("wifi-weak-signal")) {
        const where = [e.band, e.channel !== null ? `channel ${e.channel}` : null].filter((part): part is string => part !== null && part !== "").join(", ");
        this.raise(
          "wifi-weak-signal",
          "wifi-weak-signal",
          "warn",
          "Wi-Fi signal is weak",
          `${e.signal}% (${e.rssi !== null ? `${e.rssi} dBm` : `about ${dbm(e.signal)} dBm`})${where ? ` on ${where}` : ""}. Drops are likely. Moving the PC or the router closer fixes more than automation can.`,
          e.at,
        );
      }
    } else {
      this.weakRun = 0;
      if (e.signal >= this.rules.okPercent) {
        this.okRun++;
        if (this.okRun >= this.rules.okSamples) this.resolve("wifi-weak-signal", e.at, `The signal recovered to ${e.signal}%.`);
      } else this.okRun = 0;
    }
  }

  // --------------------------------------------------------------------------------------------------------------- findings

  private endAttempt(attempt: Attempt, at: number, how: string): void {
    if (this.attempts.get(attempt.profile) !== attempt) return;
    this.attempts.delete(attempt.profile);
    if (at - attempt.startAt > this.rules.slowAttemptMs) this.stats.slowAttempts++;
    if (attempt.raised) this.resolve(`wifi-stuck:${tag(attempt.profile)}`, at, `${how} after ${spoken(at - attempt.startAt)}.`);
  }

  private raise(key: string, kind: FindingKind, severity: Severity, title: string, detail: string, at: number): Finding {
    const existing = this.open.get(key);
    if (existing) {
      existing.updatedAt = Math.max(existing.updatedAt, at);
      existing.count++;
      existing.detail = detail;
      if (RANK[severity] > RANK[existing.severity]) existing.severity = severity;
      this.emit({ ...existing });
      return existing;
    }
    const finding: Finding = { id: `${key}@${at}`, key, kind, severity, title, detail, at, updatedAt: at, resolvedAt: null, count: 1 };
    this.open.set(key, finding);
    this.emit({ ...finding });
    return finding;
  }

  private resolve(key: string, at: number, detail?: string): void {
    const finding = this.open.get(key);
    if (!finding) return;
    this.open.delete(key);
    finding.resolvedAt = at;
    finding.updatedAt = Math.max(finding.updatedAt, at);
    if (detail !== undefined) finding.detail = detail;
    this.emit({ ...finding });
  }
}

/**
 * A whole log judged at once: every event in time order, then enough time for what still waits to be judged. Used by the tests
 * and by the check against a real log. With `holdMs` set to `nearPowerMs` every disconnect sees the sleeps both before and
 * after it, which is how the measured counts were made.
 */
export function replay(events: readonly SentinelEvent[], rules: Partial<Rules> = {}): { stats: WifiStats; findings: Finding[] } {
  const findings = new Map<string, Finding>();
  const engine = new WifiIntent((finding) => findings.set(finding.id, finding), rules);
  const ordered = events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index);
  for (const { event } of ordered) engine.ingest(event);
  const last = ordered[ordered.length - 1]?.event.at ?? 0;
  engine.tick(last + 24 * 3_600_000);
  return { stats: engine.stats, findings: [...findings.values()] };
}
