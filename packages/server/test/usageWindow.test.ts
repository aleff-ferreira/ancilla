import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addDays, dayBucketer, localDay, resolveZone, startOfLocalDay, usageWindow } from "../src/usageWindow.js";

const iso = (ms: number) => new Date(ms).toISOString();

describe("resolveZone", () => {
  it("knows IANA names and says no to the rest", () => {
    assert.equal(resolveZone("America/Sao_Paulo"), "America/Sao_Paulo");
    // The canonical spelling, as the runtime's ICU gives it: Kolkata may read back as Calcutta.
    const kolkata = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone;
    assert.equal(resolveZone("Asia/Kolkata"), kolkata);
    assert.equal(resolveZone("asia/KOLKATA"), kolkata, "whatever the case the caller wrote it in");
    assert.equal(resolveZone("  America/Sao_Paulo "), "America/Sao_Paulo");
    assert.equal(resolveZone("america/sao_paulo"), "America/Sao_Paulo");
    assert.equal(resolveZone("UTC"), "UTC");
    assert.equal(resolveZone("Mars/Olympus"), null);
    assert.equal(resolveZone(""), null);
    assert.equal(resolveZone("   "), null);
    assert.equal(resolveZone(undefined), null);
    assert.equal(resolveZone(42), null);
    assert.equal(resolveZone("America/".padEnd(80, "x")), null);
  });
});

describe("localDay", () => {
  it("puts an evening call in Brazil on the evening it was made", () => {
    assert.equal(localDay("2026-03-02T02:30:00Z", "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("2026-03-01T23:30:00Z", "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("2026-03-02T02:59:59.999Z", "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("2026-03-02T03:00:00.000Z", "America/Sao_Paulo"), "2026-03-02");
  });

  it("puts a morning call east of UTC on the day after its UTC date", () => {
    assert.equal(localDay("2026-03-01T23:30:00Z", "Asia/Kolkata"), "2026-03-02");
    assert.equal(localDay("2026-03-01T18:29:59.999Z", "Asia/Kolkata"), "2026-03-01");
    assert.equal(localDay("2026-03-01T18:30:00.000Z", "Asia/Kolkata"), "2026-03-02");
  });

  it("reads a day that is 23 hours long and one that is 25", () => {
    assert.equal(localDay("2026-03-08T04:59:59Z", "America/New_York"), "2026-03-07");
    assert.equal(localDay("2026-03-08T05:00:00Z", "America/New_York"), "2026-03-08");
    assert.equal(localDay("2026-03-09T03:59:59Z", "America/New_York"), "2026-03-08", "still the 8th at 23:59 EDT");
    assert.equal(localDay("2026-03-09T04:00:00Z", "America/New_York"), "2026-03-09");
    assert.equal(localDay("2026-11-02T04:59:59Z", "America/New_York"), "2026-11-01", "the 1st lasts until 05:00Z");
    assert.equal(localDay("2026-11-02T05:00:00Z", "America/New_York"), "2026-11-02");
  });

  it("is the UTC day with no zone, with an unknown one, or for a number", () => {
    for (const tz of [undefined, null, "", "Mars/Olympus", 7, "UTC"]) {
      assert.equal(localDay("2026-03-02T02:30:00Z", tz), "2026-03-02", `tz ${String(tz)}`);
    }
    assert.equal(localDay(Date.parse("2026-03-02T02:30:00Z"), "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("not a date", "America/Sao_Paulo"), "not a date");
  });
});

describe("startOfLocalDay", () => {
  it("is local midnight, as a UTC instant", () => {
    assert.equal(iso(startOfLocalDay("2026-03-02", "America/Sao_Paulo")), "2026-03-02T03:00:00.000Z");
    assert.equal(iso(startOfLocalDay("2026-03-02", "Asia/Kolkata")), "2026-03-01T18:30:00.000Z");
    assert.equal(iso(startOfLocalDay("2026-03-02", "Asia/Kathmandu")), "2026-03-01T18:15:00.000Z");
    assert.equal(iso(startOfLocalDay("2026-03-02", "Pacific/Auckland")), "2026-03-01T11:00:00.000Z");
  });

  it("is right either side of a clock change", () => {
    const march = ["2026-03-07", "2026-03-08", "2026-03-09"].map((day) => iso(startOfLocalDay(day, "America/New_York")));
    assert.deepEqual(march, ["2026-03-07T05:00:00.000Z", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
    assert.equal((startOfLocalDay("2026-03-09", "America/New_York") - startOfLocalDay("2026-03-08", "America/New_York")) / 3_600_000, 23);
    const november = ["2026-10-31", "2026-11-01", "2026-11-02"].map((day) => iso(startOfLocalDay(day, "America/New_York")));
    assert.deepEqual(november, ["2026-10-31T04:00:00.000Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
    assert.equal((startOfLocalDay("2026-11-02", "America/New_York") - startOfLocalDay("2026-11-01", "America/New_York")) / 3_600_000, 25);
  });

  it("starts a day at the clock jump when the zone skips midnight", () => {
    // Brazil began summer time at midnight on 2018-11-04: the clocks went from 23:59 to 01:00.
    assert.equal(iso(startOfLocalDay("2018-11-04", "America/Sao_Paulo")), "2018-11-04T03:00:00.000Z");
    assert.equal(localDay("2018-11-04T02:59:59Z", "America/Sao_Paulo"), "2018-11-03");
  });

  it("is UTC midnight with no zone or an unknown one", () => {
    for (const tz of [undefined, null, "Mars/Olympus", "UTC"]) {
      assert.equal(iso(startOfLocalDay("2026-03-02", tz)), "2026-03-02T00:00:00.000Z");
    }
  });

  it("begins every day of two years exactly where the previous day ends, in zones with odd clocks", () => {
    const zones = [
      "America/Sao_Paulo", "America/New_York", "America/St_Johns", "Europe/Berlin", "Europe/London", "Asia/Kolkata",
      "Asia/Kathmandu", "Asia/Beirut", "America/Havana", "America/Santiago", "Africa/Cairo", "Australia/Lord_Howe",
      "Pacific/Auckland", "Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC",
    ];
    for (const tz of zones) {
      for (const year of [2018, 2026]) {
        let day = `${year}-01-01`;
        while (day < `${year + 1}-01-01`) {
          const start = startOfLocalDay(day, tz);
          assert.equal(localDay(start, tz), day, `${tz} ${day} starts on itself`);
          assert.equal(localDay(start - 1, tz), addDays(day, -1), `${tz} ${day} follows the day before`);
          day = addDays(day, 1);
        }
      }
    }
  });
});

describe("addDays", () => {
  it("is calendar arithmetic", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-03-01", 0), "2026-03-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2024-03-01", -1), "2024-02-29");
    assert.equal(addDays("2026-10-13", -89), "2026-07-16");
  });
});

describe("usageWindow", () => {
  // 23:30 on Sunday 1 March in Sao Paulo, already Monday the 2nd in UTC.
  const NOW = Date.parse("2026-03-02T02:30:00Z");

  it("makes 7 days today and the six calendar days before it, from a local midnight", () => {
    const week = usageWindow(7, "America/Sao_Paulo", NOW);
    assert.deepEqual(week, { since: "2026-02-23T03:00:00.000Z", tz: "America/Sao_Paulo", firstDay: "2026-02-23", today: "2026-03-01" });
    assert.equal(localDay(week.since, "America/Sao_Paulo"), "2026-02-23");
    assert.equal(localDay(Date.parse(week.since) - 1, "America/Sao_Paulo"), "2026-02-22");
  });

  it("makes 1 day today alone", () => {
    assert.deepEqual(usageWindow(1, "America/Sao_Paulo", NOW), {
      since: "2026-03-01T03:00:00.000Z",
      tz: "America/Sao_Paulo",
      firstDay: "2026-03-01",
      today: "2026-03-01",
    });
  });

  it("counts a short day as a day when the window crosses a clock change", () => {
    const now = Date.parse("2026-03-10T15:00:00Z");
    assert.equal(usageWindow(3, "America/New_York", now).since, "2026-03-08T05:00:00.000Z", "the 23 hour day is the first of three");
    assert.equal(usageWindow(2, "America/New_York", now).since, "2026-03-09T04:00:00.000Z");
    assert.equal(usageWindow(7, "America/New_York", now).since, "2026-03-04T05:00:00.000Z");
  });

  it("uses UTC days without a zone, with an unknown one, and says so", () => {
    for (const tz of [undefined, null, "Mars/Olympus", ""]) {
      assert.deepEqual(usageWindow(7, tz, NOW), { since: "2026-02-24T00:00:00.000Z", tz: "UTC", firstDay: "2026-02-24", today: "2026-03-02" });
    }
  });

  it("covers 90 and 365 days", () => {
    assert.equal(usageWindow(90, "UTC", NOW).firstDay, "2025-12-03");
    assert.equal(usageWindow(365, "UTC", NOW).firstDay, "2025-03-03");
  });
});

describe("dayBucketer", () => {
  it("buckets like localDay, including on the minute a day turns over", () => {
    for (const tz of ["Asia/Kolkata", "America/Sao_Paulo", "America/New_York", "Pacific/Auckland"]) {
      const bucket = dayBucketer(tz);
      for (const at of [
        "2026-03-01T18:29:59.999Z", "2026-03-01T18:30:00.000Z", "2026-03-02T02:59:59.999Z", "2026-03-02T03:00:00.000Z",
        "2026-03-08T04:59:59.999Z", "2026-03-08T05:00:00.000Z", "2026-03-01T11:00:00.000Z", "2026-03-01T10:59:59.999Z",
      ]) {
        assert.equal(bucket(at), localDay(at, tz), `${tz} ${at}`);
        assert.equal(bucket(at), localDay(at, tz), "and again from the memo");
      }
    }
  });

  it("is the UTC date with no zone or an unknown one", () => {
    assert.equal(dayBucketer()("2026-03-02T02:30:00.000Z"), "2026-03-02");
    assert.equal(dayBucketer("Mars/Olympus")("2026-03-02T02:30:00.000Z"), "2026-03-02");
    assert.equal(dayBucketer("UTC")("2026-03-02T23:59:59.999Z"), "2026-03-02");
  });
});
