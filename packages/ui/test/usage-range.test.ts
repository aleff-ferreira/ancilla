import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  calendarDays,
  dayBasis,
  emptyRangeTitle,
  fillUsageDays,
  localDay,
  rangeLabel,
  USAGE_RANGES,
} from "../src/model/usage-range.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The report a server gives for `days` local days ending on the day `now` falls in, derived here from the zone's
 * fixed offset (hours from UTC, no clock change) the way the server does: `since` is the local midnight that opens
 * the first day, `days - 1` calendar days before today.
 */
function reportFor(days: number, tz: string, offsetHours: number, now: Date): { since: string; days: number; tz: string } {
  const today = new Date(now.getTime() + offsetHours * HOUR).toISOString().slice(0, 10);
  const first = addDays(today, -(days - 1));
  return { since: new Date(Date.parse(`${first}T00:00:00.000Z`) - offsetHours * HOUR).toISOString(), days, tz };
}

describe("usage range", () => {
  it("names a one-day window Today", () => {
    assert.equal(rangeLabel(1), "Today");
    assert.equal(rangeLabel(7), "7 days");
    assert.equal(USAGE_RANGES[0].label, "Today");
    assert.deepEqual(
      USAGE_RANGES.map((range) => range.days),
      [1, 7, 30, 90],
    );
    assert.equal(emptyRangeTitle(1), "No model calls today");
    assert.equal(emptyRangeTitle(7), "No model calls in the last 7 days");
  });

  it("lists exactly as many days as the range, so 7d and 90d are different lengths", () => {
    const now = new Date("2026-09-15T18:00:00.000Z");
    for (const days of [1, 7, 30, 90]) {
      const listed = calendarDays(reportFor(days, "UTC", 0, now), now);
      assert.equal(listed.length, days, `${days} days`);
      assert.equal(listed.at(-1), "2026-09-15");
    }
    const week = calendarDays(reportFor(7, "UTC", 0, now), now);
    assert.equal(week[0], "2026-09-09");
    assert.equal(calendarDays(reportFor(1, "UTC", 0, now), now)[0], "2026-09-15");
  });

  it("keeps days with no calls so the chart still spans the selected range", () => {
    const until = new Date("2026-09-15T12:00:00.000Z");
    const filled = fillUsageDays(
      [{ day: "2026-09-14", cost: 3.68 }],
      reportFor(7, "UTC", 0, until),
      (day) => ({ day, cost: 0 }),
      until,
    );
    assert.equal(filled.length, 7);
    assert.equal(filled.find((row) => row.day === "2026-09-14")?.cost, 3.68);
    assert.equal(filled.filter((row) => row.cost === 0).length, 6);
  });

  it("lists the viewer's local days when the report names a zone", () => {
    // 01:00 UTC on the 13th is 22:00 on the 12th in Sao Paulo (UTC-3): the chart ends on the 12th.
    const now = new Date("2026-10-13T01:00:00.000Z");
    const report = reportFor(7, "America/Sao_Paulo", -3, now);
    assert.equal(report.since, "2026-10-06T03:00:00.000Z");
    const listed = calendarDays(report, now);
    assert.deepEqual(listed, ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
    const today = calendarDays(reportFor(1, "America/Sao_Paulo", -3, now), now);
    assert.deepEqual(today, ["2026-10-12"]);
    // East of UTC the local day is ahead: 22:00 UTC on the 12th is already the 13th in Kolkata (UTC+5:30).
    const late = new Date("2026-10-12T22:00:00.000Z");
    const kolkata = calendarDays(reportFor(3, "Asia/Kolkata", 5.5, late), late);
    assert.deepEqual(kolkata, ["2026-10-11", "2026-10-12", "2026-10-13"]);
  });

  it("lists the window the report says, whatever this clock reads", () => {
    // The page can sit open past local midnight until its next read: the bars stay the report's own days.
    const server = new Date("2026-10-12T23:59:00.000Z");
    const report = reportFor(7, "UTC", 0, server);
    const later = new Date("2026-10-13T00:03:00.000Z");
    const listed = calendarDays(report, later);
    assert.equal(listed.length, 7);
    assert.equal(listed.at(-1), "2026-10-12");
  });

  it("counts calendar days across a clock change, not 24-hour steps", () => {
    // New York springs forward on 2026-03-08, a 23-hour day; midnight there is 05:00 UTC before it and 04:00 after.
    const report = { since: "2026-03-05T05:00:00.000Z", days: 7, tz: "America/New_York" };
    const now = new Date("2026-03-11T17:00:00.000Z");
    assert.deepEqual(calendarDays(report, now), [
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
    ]);
    const after = { since: "2026-03-09T04:00:00.000Z", days: 3, tz: "America/New_York" };
    assert.deepEqual(calendarDays(after, now), ["2026-03-09", "2026-03-10", "2026-03-11"]);
  });

  it("still draws a report that names no zone, as UTC days through today", () => {
    // The demo (and an older server) send no zone and a `since` that is not a midnight.
    const now = new Date("2026-09-15T18:00:00.000Z");
    const demo = { since: new Date(now.getTime() - 6 * DAY).toISOString(), days: 7 };
    const listed = calendarDays(demo, now);
    assert.equal(listed.length, 7);
    assert.equal(listed[0], "2026-09-09");
    assert.equal(listed.at(-1), "2026-09-15");
    // An older server's rolling window starts mid-day, so its first day is a partial one and is still listed.
    assert.equal(calendarDays({ since: new Date(now.getTime() - 7 * DAY).toISOString(), days: 7 }, now).length, 8);
  });

  it("still draws a report whose start is missing or is no date, as its days ending today", () => {
    // A proxy or an odd server can mangle `since`: the page must not throw while rendering.
    const now = new Date("2026-09-15T18:00:00.000Z");
    const week = ["2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"];
    for (const since of ["garbage", "", undefined]) {
      for (const tz of ["UTC", "America/Sao_Paulo", undefined]) {
        const report = { since: since as unknown as string, days: 7, tz };
        assert.deepEqual(calendarDays(report, now), week, `since ${JSON.stringify(since)} in ${tz}`);
      }
    }
    // Without a usable length there is nothing to list, and nothing throws.
    assert.deepEqual(calendarDays({ since: "garbage", days: Number.NaN, tz: "UTC" }, now), []);
    assert.deepEqual(calendarDays({ since: "garbage", days: 7, tz: "UTC" }, new Date(Number.NaN)), []);
    const blank = fillUsageDays([{ day: "2026-09-15", cost: 1 }], { since: "garbage", days: 7, tz: "UTC" }, (day) => ({ day, cost: 0 }), now);
    assert.equal(blank.length, 7);
    assert.equal(blank.at(-1)?.cost, 1);
  });

  it("reads the date of an instant in a zone, falling back to UTC", () => {
    assert.equal(localDay("2026-03-02T02:30:00.000Z", "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("2026-03-01T23:30:00.000Z", "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("2026-03-01T23:30:00.000Z", "Asia/Kolkata"), "2026-03-02");
    assert.equal(localDay("2026-03-02T02:30:00.000Z", "UTC"), "2026-03-02");
    assert.equal(localDay("2026-03-02T02:30:00.000Z"), "2026-03-02");
    assert.equal(localDay("2026-03-02T02:30:00.000Z", "Not/A_Zone"), "2026-03-02");
    assert.equal(localDay(Date.parse("2026-03-02T02:30:00.000Z"), "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay(new Date("2026-03-02T02:30:00.000Z"), "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("not a date"), "not a date".slice(0, 10));
    // An unknown zone also draws a report: it is read as UTC.
    const now = new Date("2026-09-15T18:00:00.000Z");
    assert.equal(calendarDays({ since: "2026-09-09T00:00:00.000Z", days: 7, tz: "Not/A_Zone" }, now).length, 7);
  });

  it("does calendar arithmetic on dates", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2028-03-01", -1), "2028-02-29");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-10-12", 0), "2026-10-12");
  });

  it("says whether the days are the viewer's or UTC", () => {
    assert.equal(dayBasis({ tz: "America/Sao_Paulo" }).label, "local time");
    assert.match(dayBasis({ tz: "America/Sao_Paulo" }).detail, /America\/Sao_Paulo/);
    assert.equal(dayBasis({ tz: "UTC" }).label, "UTC");
    assert.equal(dayBasis({}).label, "UTC");
  });
});
