import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cachedZones, dayBucketer, localDay, resolveZone, usageWindow } from "../src/usageWindow.js";

/** Every spelling of one zone that differs only in case: `Intl` takes them all, and they are one zone. */
function caseVariants(name: string, count: number): string[] {
  const letters = [...name].flatMap((char, index) => (char.toLowerCase() !== char.toUpperCase() ? [index] : []));
  const variants = new Set<string>();
  for (let n = 0; variants.size < count && n < 2 ** letters.length; n += 1) {
    const chars = [...name.toLowerCase()];
    letters.forEach((index, bit) => {
      if ((n >> bit) & 1) {
        chars[index] = (chars[index] as string).toUpperCase();
      }
    });
    variants.add(chars.join(""));
  }
  return [...variants];
}

const NOW = Date.parse("2026-03-02T02:30:00Z");

describe("the zone caches stay small whatever a client sends", () => {
  it("makes every case spelling of a zone one zone", () => {
    const variants = caseVariants("America/Sao_Paulo", 2000);
    assert.ok(variants.length > 1000, "enough different spellings to mean something");
    for (const variant of variants) {
      assert.equal(resolveZone(variant), "America/Sao_Paulo");
      assert.equal(localDay("2026-03-02T02:30:00Z", variant), "2026-03-01");
    }
    assert.equal(cachedZones().formatters, 1, "one formatter for all of them");
    assert.ok(cachedZones().names <= 256, "and the names that were asked stay bounded");
  });

  it("echoes the canonical spelling, so a report names the zone once", () => {
    assert.equal(usageWindow(7, "america/sao_paulo", NOW).tz, "America/Sao_Paulo");
    assert.equal(usageWindow(7, "AMERICA/SAO_PAULO", NOW).tz, "America/Sao_Paulo");
    assert.equal(dayBucketer("america/sao_paulo")("2026-03-02T02:30:00.000Z"), "2026-03-01");
  });

  it("holds at most 256 formatters and 256 names, and keeps answering right past that", (t) => {
    if (typeof Intl.supportedValuesOf !== "function") {
      t.skip("this runtime cannot list its zones");
      return;
    }
    const zones = [...Intl.supportedValuesOf("timeZone"), ...Array.from({ length: 300 }, (_, minutes) => `+${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`)];
    assert.ok(zones.length > 600, "more distinct zones than either cache holds");
    for (const zone of zones) {
      const day = localDay("2026-03-02T02:30:00Z", zone);
      assert.match(day, /^2026-03-0[12]$/, zone);
      assert.ok(cachedZones().formatters <= 256, `${zone}: formatters ${cachedZones().formatters}`);
      assert.ok(cachedZones().names <= 256, `${zone}: names ${cachedZones().names}`);
    }
    // After the caches were cleared more than once, a zone read again still gives its own day.
    assert.equal(localDay("2026-03-02T02:30:00Z", "America/Sao_Paulo"), "2026-03-01");
    assert.equal(localDay("2026-03-01T23:30:00Z", "Asia/Kolkata"), "2026-03-02");
  });
});
