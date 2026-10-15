/**
 * Calendar days in the viewer's time zone, for the usage page's buckets and its window. Rows are stored as UTC
 * instants; a day here is the local date of an instant in an IANA zone (`America/Sao_Paulo`), so an evening call
 * lands on the evening it was made. Every path falls back to UTC for a missing or unknown zone or any `Intl`
 * failure (a runtime built without full ICU), which is also what a client that sends no zone gets.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
const resolved = new Map<string, string | null>();

/** The most zone names either cache holds; they come off the wire, so what is remembered of them stays small. */
const CACHE_LIMIT = 256;

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    if (formatters.size >= CACHE_LIMIT) {
      formatters.clear();
    }
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** How many names each cache holds right now; the tests that pin their bound read it. */
export function cachedZones(): { formatters: number; names: number } {
  return { formatters: formatters.size, names: resolved.size };
}

interface Wall {
  day: string;
  /** The wall-clock reading as if it were UTC, so subtracting the real instant gives the zone's offset. */
  asUtc: number;
}

function wallClock(ms: number, zone: string): Wall {
  const read: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    read[part.type] = part.value;
  }
  const [year, month, day] = [Number(read["year"]), Number(read["month"]), Number(read["day"])];
  return {
    day: `${read["year"]}-${read["month"]}-${read["day"]}`,
    // Some ICU versions print midnight as 24 even with a 23-hour cycle.
    asUtc: Date.UTC(year, month - 1, day, Number(read["hour"]) % 24, Number(read["minute"]), Number(read["second"])),
  };
}

/**
 * The zone `Intl` knows the caller's name (trimmed) as, otherwise null (read: UTC). It is canonical, the spelling
 * `Intl` itself gives back: `Intl` takes a name in any case, so `america/sao_paulo` and `America/Sao_Paulo` are one
 * zone and one cache entry, and `Asia/Kolkata` may read back as the `Asia/Calcutta` the runtime's ICU settles on.
 */
export function resolveZone(tz: unknown): string | null {
  if (typeof tz !== "string") {
    return null;
  }
  const name = tz.trim();
  if (name.length === 0 || name.length > 64) {
    return null;
  }
  const known = resolved.get(name);
  if (known !== undefined) {
    return known;
  }
  let accepted: string | null;
  try {
    accepted = new Intl.DateTimeFormat("en-CA", { timeZone: name }).resolvedOptions().timeZone ?? name;
  } catch {
    accepted = null;
  }
  if (resolved.size >= CACHE_LIMIT) {
    resolved.clear();
  }
  resolved.set(name, accepted);
  return accepted;
}

function isUtc(zone: string | null): zone is null | "UTC" {
  return zone === null || zone === "UTC";
}

function dayIn(ms: number, zone: string | null): string {
  if (!isUtc(zone)) {
    try {
      return wallClock(ms, zone).day;
    } catch {
      // Fall through to the UTC day.
    }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/** The `YYYY-MM-DD` date of an instant in the zone. */
export function localDay(at: string | number, tz?: unknown): string {
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isNaN(ms) ? String(at).slice(0, 10) : dayIn(ms, resolveZone(tz));
}

/** The day `delta` calendar days from `day` (`YYYY-MM-DD`); plain calendar arithmetic, no zone involved. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

/**
 * The first instant of a local day, as Unix milliseconds. Midnight is looked for twice, the second time at the
 * offset the first guess landed on, which is right on either side of a clock change; a zone that skips midnight
 * (the clocks jump from 23:59 to 01:00) starts its day at the jump.
 */
export function startOfLocalDay(day: string, tz?: unknown): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(year, month - 1, date);
  const zone = resolveZone(tz);
  if (isUtc(zone)) {
    return utcMidnight;
  }
  try {
    const first = utcMidnight - (wallClock(utcMidnight, zone).asUtc - utcMidnight);
    const second = utcMidnight - (wallClock(first, zone).asUtc - first);
    const onTheDay = [first, second].filter((ms) => wallClock(ms, zone).day === day);
    return onTheDay.length > 0 ? Math.min(...onTheDay) : first;
  } catch {
    return utcMidnight;
  }
}

export interface UsageWindow {
  /** ISO UTC start of the first local day in the window; rows are `at >= since`. */
  since: string;
  /** The zone the days are in; `UTC` when none was given or it was not known. */
  tz: string;
  /** The first and last local day of the window. */
  firstDay: string;
  today: string;
}

/** The last `days` local days, today included: `1` is today alone and `7` is today and the six before. */
export function usageWindow(days: number, tz?: unknown, now: number = Date.now()): UsageWindow {
  const zone = resolveZone(tz) ?? "UTC";
  const today = dayIn(now, zone);
  const firstDay = addDays(today, -(Math.max(1, days) - 1));
  return { since: new Date(startOfLocalDay(firstDay, zone)).toISOString(), tz: zone, firstDay, today };
}

/**
 * A bucketing function for many rows in one zone. The day of a UTC instant only changes at a whole minute, so
 * the answer is kept per minute: a report over a year of calls formats a few thousand distinct minutes, not every call.
 */
export function dayBucketer(tz?: unknown): (iso: string) => string {
  const zone = resolveZone(tz);
  if (isUtc(zone)) {
    return (iso) => iso.slice(0, 10);
  }
  const seen = new Map<string, string>();
  return (iso) => {
    const minute = iso.slice(0, 16);
    let day = seen.get(minute);
    if (day === undefined) {
      const ms = Date.parse(iso);
      day = Number.isNaN(ms) ? iso.slice(0, 10) : dayIn(ms, zone);
      seen.set(minute, day);
    }
    return day;
  };
}
