import type { PowerEvent, SignalEvent, WlanEvent } from "../src/sentinel/types.js";

/**
 * Events shaped like the WLAN-AutoConfig log measured on a real PC over 40 days: 82 disconnects (45 by the driver, 27 by the
 * person, 8 by policy, 2 by a state change), 35 of them within 90 s of a sleep or a resume, 20 real drops in the middle of a
 * session (regained in under 10 s 7 times, in 10 to 60 s 7 times, later 6 times, the worst after 5391 s), and 122 connection
 * attempts, 4 of them over 15 s. The reason codes and their texts are the ones that log carries. Time is fixed and the jitter
 * comes from a seeded generator, so the same log is built every time.
 */

export const SEC = 1000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const T0 = Date.UTC(2026, 9, 13, 22, 0, 0);

const DISCONNECT_TEXT: Record<number, string> = {
  0: "The network is disconnected by the driver.",
  2: "The network is disconnected by the user.",
  3: "The network is disconnected because the user wants to establish a new connection.",
  5: "The network is disconnected due to a policy disabling auto connect on this interface.",
  7: "The network is disconnected due to a policy disabling manual connect on this interface.",
  11: "The network is disconnected due to an Operation state change request on this interface",
};

const FAILURE_TEXT: Record<number, string> = {
  229396: "Failed to connect because no connectable Access Point was visible",
  229378: "The driver disconnected while associating.",
  163851: "The specific network is not available.",
  327681: "Unable to identify a user for 802.1X authentication",
  229392: "An internal failure prevented the operation from completing.",
  229377: "The operation was cancelled.",
};

export class LogBuilder {
  readonly events: Array<WlanEvent | PowerEvent> = [];
  private wlanRid = 1;
  private powerRid = 1;
  private connections = 0;

  private readonly byProfile = new Map<string, string>();

  /** A new connection id in the shape Windows writes. */
  connection(): string {
    this.connections++;
    return `{00000000-0000-0000-0000-${String(this.connections).padStart(12, "0")}}`;
  }

  /** The real log reuses one ConnectionId for every attempt, connection and disconnect of a profile, so the fixture does too. */
  private connectionOf(profile: string): string {
    let id = this.byProfile.get(profile);
    if (id === undefined) {
      id = this.connection();
      this.byProfile.set(profile, id);
    }
    return id;
  }

  wlan(id: WlanEvent["id"], at: number, fields: Partial<WlanEvent> = {}): void {
    const profile = fields.profile ?? "HomeWiFi";
    this.events.push({ kind: "wlan", id, at, rid: this.wlanRid++, backfill: false, connectionId: this.connectionOf(profile), profile, ssid: "HomeWiFi-5G", code: null, reason: "", ...fields });
  }

  power(change: "sleep" | "resume", at: number, source = "Microsoft-Windows-Kernel-Power"): void {
    this.events.push({ kind: "power", change, at, rid: this.powerRid++, backfill: false, source });
  }

  disconnect(at: number, code: number, fields: Partial<WlanEvent> = {}): void {
    this.wlan(8003, at, { code, reason: DISCONNECT_TEXT[code] ?? "", ...fields });
  }

  /** One attempt: 8000 at `at`, then 8001 (`"ok"`) or 8002 with that reason code `ms` later. Returns when it ended. */
  attempt(at: number, ms: number, outcome: "ok" | number, fields: Partial<WlanEvent> = {}): number {
    this.wlan(8000, at, fields);
    if (outcome === "ok") this.wlan(8001, at + ms, fields);
    else this.wlan(8002, at + ms, { code: outcome, reason: FAILURE_TEXT[outcome] ?? "", ...fields });
    return at + ms;
  }
}

/** The numbers the log above was built to have: what a correct engine must find in it. */
export const MEASURED = {
  disconnects: { driver: 45, user: 27, policy: 8, state: 2, unknown: 0 },
  nearPower: 35,
  nearPowerDriver: 25,
  realDrops: 20,
  blips: 7,
  attempts: 122,
  slowAttempts: 4,
  stuck: 3,
  failures: { "no-access-point": 10, driver: 4, unavailable: 4, cancelled: 1, "no-credentials": 3, other: 1 },
  /** Findings by kind: 13 real drops that lasted, 7 blips, 3 stuck attempts (over 20 s), the three drops in 8 minutes, two outages over 5 minutes. */
  findings: { "wifi-blip": 7, "wifi-drop": 13, "wifi-stuck": 3, "wifi-flapping": 1, "wifi-down": 2 },
};

/** How long each of the 20 real drops took to recover, in seconds, ascending. */
const GAPS = [1, 2, 3, 4, 6, 8, 9, 12, 18, 28, 32, 36, 45, 55, 75, 95, 187, 250, 340, 5391];

export function measuredLog(): LogBuilder {
  const log = new LogBuilder();
  let seed = 7;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const episodes: Array<(at: number) => void> = [];

  // The person's own disconnects (19 cancels, 8 new connections), almost always followed by their own reconnect.
  for (let i = 0; i < 27; i++) {
    episodes.push((at) => {
      log.disconnect(at, i < 19 ? 2 : 3);
      log.attempt(at + (i >= 25 ? 30 * SEC : 300), 200, "ok");
    });
  }
  // Real drops. The 4, 6 and 8 second ones are the three in 8 minutes; the failures are spread over the longer ones.
  const failures: number[] = [...Array<number>(10).fill(229396), ...Array<number>(4).fill(229378), ...Array<number>(4).fill(163851), 229392];
  let longer = 0;
  const flap = [4, 6, 8];
  const drop = (at: number, gap: number, fails: number[]): void => {
    log.disconnect(at, 0);
    fails.forEach((code, n) => log.attempt(at + (1 + n * 4) * SEC, 3 * SEC, code));
    log.attempt(at + gap * SEC - 200, 200, "ok");
  };
  for (const gap of GAPS.filter((g) => !flap.includes(g))) {
    const fails = gap >= 12 ? failures.splice(0, longer++ < 6 ? 2 : 1) : [];
    episodes.push((at) => drop(at, gap, fails));
  }
  episodes.push((at) => flap.forEach((gap, n) => drop(at + n * 4 * MIN, gap, [])));
  // Drops that the system caused around a sleep (25 by the driver, 10 by policy or a state change). Six resume through the troubleshooter's event.
  for (let i = 0; i < 25; i++) {
    const resumeSource = i % 4 === 3 ? "Microsoft-Windows-Power-Troubleshooter" : "Microsoft-Windows-Kernel-Power";
    episodes.push((at) => {
      if (i % 2 === 0) {
        log.disconnect(at, 0);
        log.power("sleep", at + 2 * SEC);
        log.power("resume", at + 40 * MIN, resumeSource);
        log.attempt(at + 40 * MIN + 5 * SEC, 200, "ok");
      } else {
        log.power("sleep", at - 50 * MIN);
        log.power("resume", at - (3 + Math.floor(random() * 57)) * SEC, resumeSource);
        log.disconnect(at, 0);
        log.attempt(at + 6 * SEC, 200, "ok");
      }
    });
  }
  for (const code of [5, 5, 5, 5, 5, 5, 5, 7, 11, 11]) {
    episodes.push((at) => {
      log.power("sleep", at - 50 * MIN);
      log.power("resume", at - (5 + Math.floor(random() * 40)) * SEC);
      log.disconnect(at, code);
      log.attempt(at + 8 * SEC, 200, "ok");
    });
  }
  // Connections with no disconnect before them (a boot, a wake): four of them were slow, the worst 237 s.
  for (const ms of [200, 200, 200, 200, 200, 200, 200, 200, 200, 3100, 5000, 7400, 1200, 16_500, 21_000, 64_000, 237_000]) {
    episodes.push((at) => void log.attempt(at, ms, "ok"));
  }
  // A campus network seen from a bench (no credentials), and one attempt the person cancelled.
  for (let i = 0; i < 3; i++) episodes.push((at) => void log.attempt(at, 2 * SEC, 327681, { profile: "eduroam", ssid: "eduroam" }));
  episodes.push((at) => void log.attempt(at, 3 * SEC, 229377));

  // The kinds are mixed, then each takes a turn about nine hours apart, starting six hours in.
  for (let i = episodes.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [episodes[i], episodes[j]] = [episodes[j] as (at: number) => void, episodes[i] as (at: number) => void];
  }
  let slot = T0 + 6 * HOUR;
  for (const episode of episodes) {
    episode(slot);
    slot += 9 * HOUR + Math.floor(random() * HOUR);
  }
  return log;
}

/** Readings of the adapter, one every `step` ms from `at`; `rssi` is what the same Windows would report in dBm, when it reports one. */
export function signals(at: number, percents: Array<number | null>, step = 30 * SEC, rssi: number | null = null): SignalEvent[] {
  return percents.map((percent, i) => ({
    kind: "signal" as const,
    at: at + i * step,
    connected: percent !== null,
    signal: percent,
    rssi: percent !== null ? rssi : null,
    channel: percent !== null ? 44 : null,
    rxMbps: percent !== null ? 130 : null,
    txMbps: percent !== null ? 130 : null,
    radio: percent !== null ? "802.11ac" : null,
    band: percent !== null ? "5 GHz" : null,
  }));
}
