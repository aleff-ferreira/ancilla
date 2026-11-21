/**
 * What the Sentinel's parts pass to each other. The Sentinel is deterministic code with no model in it: it reads what Windows
 * records about the machine, judges it by fixed rules, and keeps a history and a hash-chained audit of what it concluded.
 */

export type Severity = "minor" | "warn" | "critical";

/** Why Windows says a Wi-Fi connection ended, reduced to what matters for intent. */
export type DisconnectClass = "driver" | "user" | "policy" | "state" | "unknown";

/** Why a Wi-Fi connection attempt failed, reduced to what matters for intent. */
export type FailureClass = "no-access-point" | "driver" | "unavailable" | "cancelled" | "no-credentials" | "other";

/**
 * A line of the WLAN-AutoConfig operational log. 8000 an attempt started, 8001 it connected, 8002 it failed, 8003 the connection
 * ended. `backfill` marks events read from the OS log for a time when the Sentinel was not running: history, not news.
 */
export interface WlanEvent {
  kind: "wlan";
  id: 8000 | 8001 | 8002 | 8003;
  at: number;
  rid: number | null;
  backfill: boolean;
  connectionId: string;
  profile: string;
  ssid: string;
  /** `ReasonCode` of an 8002 or an 8003: a number that does not depend on the display language. */
  code: number | null;
  /** The OS's own words for the reason (localized): shown, never used for a decision when `code` is there. */
  reason: string;
}

/** A sleep or a resume (Kernel-Power 42, 107, 506, 507 and Power-Troubleshooter 1). */
export interface PowerEvent {
  kind: "power";
  change: "sleep" | "resume";
  at: number;
  rid: number | null;
  backfill: boolean;
  source: string;
}

/** One reading of the adapter. Numbers only: nothing in it is text a stranger could have written. */
export interface SignalEvent {
  kind: "signal";
  at: number;
  connected: boolean;
  /** 0 to 100, as Windows reports signal quality. */
  signal: number | null;
  /** The received signal strength in dBm, when this Windows reports it. */
  rssi: number | null;
  channel: number | null;
  rxMbps: number | null;
  txMbps: number | null;
  radio: string | null;
  band: string | null;
}

export type SentinelEvent = WlanEvent | PowerEvent | SignalEvent;

export type FindingKind = "wifi-blip" | "wifi-drop" | "wifi-stuck" | "wifi-flapping" | "wifi-weak-signal" | "wifi-down" | "wifi-cannot-connect";

/** Something the Sentinel concluded, in plain words. `key` identifies the condition: a condition that is still true updates its finding. */
export interface Finding {
  id: string;
  key: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  at: number;
  updatedAt: number;
  resolvedAt: number | null;
  count: number;
}

/** What the collector says about itself and its sources. */
export type CollectorState = "off" | "starting" | "running" | "failed" | "unsupported";

export interface CollectorStatus {
  state: CollectorState;
  since: number | null;
  restarts: number;
  lastError: string | null;
  /** Which sources the collector could open: the Wi-Fi log, the power events, the adapter readings. */
  sources: Record<string, { ok: boolean; detail: string | null }>;
}

export interface Settings {
  /** The Sentinel watches the machine. Off until the person turns it on. */
  watch: boolean;
  /** Approved standing orders may run by themselves. Off until the person turns it on. */
  act: boolean;
}

export const DEFAULT_SETTINGS: Settings = { watch: false, act: false };
