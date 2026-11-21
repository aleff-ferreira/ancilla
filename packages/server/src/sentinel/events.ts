import type { PowerEvent, SentinelEvent, SignalEvent, WlanEvent } from "./types.js";

/**
 * The line protocol between the collector script and the server: one JSON object per line on the script's stdout. Everything in
 * a line is untrusted data. SSIDs and profile names are chosen by whoever runs an access point, so they are kept as plain text
 * of bounded length, compared for equality and displayed, and never interpreted.
 */

export type CollectorLine =
  | { kind: "hello"; version: number }
  | { kind: "source"; name: string; ok: boolean; detail: string | null }
  /** The history asked for has been sent: what follows is live. */
  | { kind: "ready" }
  | { kind: "bye" }
  | { kind: "event"; event: SentinelEvent };

/** A line longer than this is dropped whole: a collector never writes one. */
export const LINE_MAX = 16_000;
const TEXT_MAX = 256;
const DETAIL_MAX = 200;

// C0 and C1 control characters: no profile name, SSID or reason holds one, and one that does is not shown as it is.
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

/** Plain text of bounded length with control characters removed. Anything that is not text is empty. */
export function plainText(value: unknown, max: number = TEXT_MAX): string {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, "").slice(0, max);
}

function number(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.trunc(value) : null;
}

/** Milliseconds since 1970, between 2014 and 2096. */
function instant(value: unknown): number | null {
  return number(value, 1.4e12, 4e12);
}

function wlan(o: Record<string, unknown>): WlanEvent | null {
  const id = o["id"];
  const at = instant(o["at"]);
  if ((id !== 8000 && id !== 8001 && id !== 8002 && id !== 8003) || at === null) return null;
  return {
    kind: "wlan",
    id,
    at,
    rid: number(o["rid"], 0, Number.MAX_SAFE_INTEGER),
    backfill: o["b"] === 1 || o["b"] === true,
    connectionId: plainText(o["cid"], 64),
    profile: plainText(o["profile"]),
    ssid: plainText(o["ssid"]),
    code: number(o["rc"], 0, 0xffffffff),
    reason: plainText(o["reason"], DETAIL_MAX),
  };
}

function power(o: Record<string, unknown>): PowerEvent | null {
  const at = instant(o["at"]);
  const change = o["change"];
  if (at === null || (change !== "sleep" && change !== "resume")) return null;
  return { kind: "power", change, at, rid: number(o["rid"], 0, Number.MAX_SAFE_INTEGER), backfill: o["b"] === 1 || o["b"] === true, source: plainText(o["src"], 80) };
}

function signal(o: Record<string, unknown>): SignalEvent | null {
  const at = instant(o["at"]);
  if (at === null) return null;
  const connected = o["connected"] === true;
  return {
    kind: "signal",
    at,
    connected,
    signal: connected ? number(o["signal"], 0, 100) : null,
    rssi: connected ? number(o["rssi"], -150, 0) : null,
    channel: number(o["channel"], 1, 1000),
    rxMbps: number(o["rx"], 0, 100_000),
    txMbps: number(o["tx"], 0, 100_000),
    radio: plainText(o["radio"], 20) || null,
    band: plainText(o["band"], 20) || null,
  };
}

/** One line of the collector, or null when it is not a line this server understands (the collector is never trusted to be right). */
export function parseLine(line: string): CollectorLine | null {
  if (line.length === 0 || line.length > LINE_MAX) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  switch (o["t"]) {
    case "hello":
      return { kind: "hello", version: number(o["v"], 0, 1000) ?? 0 };
    case "ready":
      return { kind: "ready" };
    case "bye":
      return { kind: "bye" };
    case "source": {
      const name = plainText(o["name"], 20);
      return name === "" ? null : { kind: "source", name, ok: o["ok"] === true, detail: plainText(o["err"], DETAIL_MAX) || null };
    }
    case "wlan": {
      const event = wlan(o);
      return event ? { kind: "event", event } : null;
    }
    case "power": {
      const event = power(o);
      return event ? { kind: "event", event } : null;
    }
    case "signal": {
      const event = signal(o);
      return event ? { kind: "event", event } : null;
    }
    default:
      return null;
  }
}
