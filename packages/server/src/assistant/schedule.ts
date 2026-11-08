/**
 * When a recurring task runs next. A schedule names its time zone (a clock on the wall means nothing without one),
 * and the arithmetic is done on that zone's own calendar, so "09:00 every day" stays 09:00 across a clock change.
 * Everything here is a pure function of its arguments: the executive passes the time in.
 */

export type ScheduleKind = "interval" | "daily" | "once";

export interface ScheduleRule {
  kind: ScheduleKind;
  /** interval: minutes between runs. */
  everyMinutes: number | null;
  /** daily: minutes after the zone's midnight. */
  atMinute: number | null;
  tz: string;
  /** The first moment a run may happen (once: the run time). */
  startAt: number | null;
  endAt: number | null;
  /** The last run's time, for an interval. */
  lastRunAt: number | null;
}

const MIN = 60_000;
const DAY = 86_400_000;

export function validZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim() === "" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(at: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(at))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { year: out["year"] as number, month: out["month"] as number, day: out["day"] as number, hour: (out["hour"] as number) % 24, minute: out["minute"] as number, second: out["second"] as number };
}

/** The zone's distance east of UTC at a moment, in milliseconds. */
export function zoneOffsetMs(at: number, tz: string): number {
  const p = partsOf(at, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/**
 * The moment at which the zone's clock reads the given date and time. A time that happens twice (the clocks go back)
 * is its first occurrence; a time the clock skips (they go forward) lands just after the gap, not an hour early.
 */
export function zonedToUtc(year: number, month: number, day: number, minuteOfDay: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const offsetBefore = zoneOffsetMs(wall - DAY, tz);
  const offsetAfter = zoneOffsetMs(wall + DAY, tz);
  const a = wall - offsetBefore;
  const b = wall - offsetAfter;
  const okA = zoneOffsetMs(a, tz) === offsetBefore;
  const okB = zoneOffsetMs(b, tz) === offsetAfter;
  if (okA && okB) return Math.min(a, b);
  if (okA) return a;
  if (okB) return b;
  return Math.max(a, b);
}

/** The next run strictly after `after`, or null when the schedule has no more. */
export function nextRun(rule: ScheduleRule, after: number): number | null {
  let next: number | null = null;
  if (rule.kind === "once") {
    next = rule.startAt !== null && rule.startAt > after && rule.lastRunAt === null ? rule.startAt : null;
  } else if (rule.kind === "interval") {
    const every = Math.max(1, rule.everyMinutes ?? 0) * MIN;
    const base = rule.lastRunAt ?? rule.startAt;
    if (base === null) {
      next = after + every;
    } else if (base > after) {
      next = base;
    } else {
      next = base + (Math.floor((after - base) / every) + 1) * every;
    }
    if (rule.startAt !== null && next < rule.startAt) next = rule.startAt;
  } else {
    const at = rule.atMinute ?? 0;
    const from = Math.max(after, rule.startAt !== null ? rule.startAt - 1 : after);
    const p = partsOf(from, rule.tz);
    let candidate = zonedToUtc(p.year, p.month, p.day, at, rule.tz);
    // A day at a time, on the zone's calendar: a month's end or a clock change does not move the hour.
    for (let i = 0; candidate <= from && i < 3; i += 1) {
      const day = new Date(Date.UTC(p.year, p.month - 1, p.day + 1 + i));
      candidate = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), at, rule.tz);
    }
    next = candidate;
  }
  if (next !== null && rule.endAt !== null && next > rule.endAt) return null;
  return next;
}

export const SCHEDULE_LIMITS = { minIntervalMinutes: 15, maxIntervalMinutes: 7 * 24 * 60, maxRuns: 365, maxHorizonDays: 366 };

/** A moment as text in a zone, for a reason shown to the user. */
export function describeMoment(at: number, tz: string): string {
  const p = partsOf(at, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${tz})`;
}

export { DAY };
