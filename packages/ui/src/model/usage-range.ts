import type { UsageReport } from "../types.js";

export const USAGE_RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
] as const;

/** The longest window the server serves; a runaway `days` never makes a runaway chart. */
const MAX_DAYS = 366;

/** A `YYYY-MM-DD` day key, the only shape the day arithmetic below can step from. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function rangeLabel(days: number): string {
  return days === 1 ? "Today" : `${days} days`;
}

/** The headline of a window with no calls in it. */
export function emptyRangeTitle(days: number): string {
  return days === 1 ? "No model calls today" : `No model calls in the last ${days} days`;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** A formatter for the zone, or null when the runtime does not know it. */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const known = formatters.get(zone);
  if (known !== undefined) {
    return known;
  }
  let made: Intl.DateTimeFormat | null;
  try {
    made = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    made = null;
  }
  formatters.set(zone, made);
  return made;
}

/**
 * The `YYYY-MM-DD` date of an instant in an IANA zone. A missing, `UTC` or unknown zone reads the UTC date, which
 * is what a report from an older server or the demo carries.
 */
export function localDay(at: string | number | Date, tz?: string | null): string {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (Number.isNaN(ms)) {
    return typeof at === "string" ? at.slice(0, 10) : "";
  }
  const formatter = tz && tz !== "UTC" ? formatterFor(tz) : null;
  if (formatter) {
    try {
      const read: Record<string, string> = {};
      for (const part of formatter.formatToParts(new Date(ms))) {
        read[part.type] = part.value;
      }
      if (read["year"] && read["month"] && read["day"]) {
        return `${read["year"]}-${read["month"]}-${read["day"]}`;
      }
    } catch {
      // Fall through to the UTC date.
    }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/** The calendar day `delta` days from `day` (`YYYY-MM-DD`); plain date arithmetic, so a clock change never matters. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

/**
 * The days a report covers, oldest first. A report that names its zone is the server's window of exactly `days`
 * local days from the local midnight in `since`, so those days are listed whatever the clock here says. A report
 * without one (an older server, the demo) is UTC days from the one holding `since` through today. A report whose
 * `since` is missing or is no date (a proxy mangled it) is read as its `days` ending today, so the page still draws.
 */
export function calendarDays(report: Pick<UsageReport, "since" | "days" | "tz">, until: Date = new Date()): string[] {
  const count = Number.isInteger(report.days) && report.days >= 1 ? Math.min(report.days, MAX_DAYS) : null;
  const today = localDay(until, report.tz);
  let first = localDay(report.since, report.tz);
  if (!DAY_KEY.test(first)) {
    if (count === null || !DAY_KEY.test(today)) {
      return [];
    }
    first = addDays(today, 1 - count);
  }
  const aligned = report.tz !== undefined && count !== null;
  const last = aligned ? addDays(first, count - 1) : today;
  const days: string[] = [];
  for (let cursor = first; cursor <= last && days.length < MAX_DAYS; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

export function fillUsageDays<T extends { day: string }>(
  rows: T[],
  report: Pick<UsageReport, "since" | "days" | "tz">,
  blank: (day: string) => T,
  until = new Date(),
): T[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return calendarDays(report, until).map((day) => byDay.get(day) ?? blank(day));
}

/** What the chart's days are: the viewer's own days when the report names a zone, plain UTC dates when it does not. */
export function dayBasis(report: Pick<UsageReport, "tz">): { label: string; detail: string } {
  return report.tz && report.tz !== "UTC"
    ? { label: "local time", detail: `Days are in your local time (${report.tz}).` }
    : { label: "UTC", detail: "Days are UTC dates." };
}
