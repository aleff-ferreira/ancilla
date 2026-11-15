import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { replayUsageAt, turnStartTimes, uuidv7Ms } from "../src/usageTime.js";
import { uuidv7 } from "../src/research/index.js";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
// A real turn id from the probe sessions: minted 2026-09-26 around 20:18:16 UTC.
const TURN = "01a0df5e-561c-7000-9fca-17df0bba9568";
const TURN_MS = Date.parse("2026-09-26T20:18:16Z");

describe("uuidv7Ms", () => {
  it("decodes the milliseconds in a UUIDv7", () => {
    const ms = uuidv7Ms(TURN, NOW);
    assert.ok(ms !== null && Math.abs(ms - TURN_MS) < 1000, `decoded ${ms}`);
    assert.equal(uuidv7Ms(uuidv7(TURN_MS), NOW), TURN_MS);
    assert.equal(uuidv7Ms(TURN.toUpperCase(), NOW), uuidv7Ms(TURN, NOW));
  });

  it("gives null for anything that is not a UUIDv7 with a believable time", () => {
    assert.equal(uuidv7Ms(randomUUID(), NOW), null, "a UUIDv4");
    assert.equal(uuidv7Ms("t1", NOW), null);
    assert.equal(uuidv7Ms("", NOW), null);
    assert.equal(uuidv7Ms(null, NOW), null);
    assert.equal(uuidv7Ms(42, NOW), null);
    assert.equal(uuidv7Ms(uuidv7(1_000_000), NOW), null, "1970");
    assert.equal(uuidv7Ms(uuidv7(Date.UTC(2100, 0, 1)), NOW), null, "the far future");
    assert.equal(uuidv7Ms("01a0df5e-561c-7000-9fca-17df0bba956", NOW), null, "one digit short");
  });

  it("believes a time a little ahead of this clock, for the caller to clamp", () => {
    assert.equal(uuidv7Ms(uuidv7(NOW + 60_000), NOW), NOW + 60_000);
  });
});

describe("turnStartTimes", () => {
  const item = (turnId: unknown, recordedAt: unknown) => ({ method: "item/completed", params: { item: { itemId: "i", turnId, recordedAt } } });

  it("keeps the earliest recorded time of each turn's items", () => {
    const starts = turnStartTimes(
      [
        item("a", "2026-09-26T20:18:30.000000Z"),
        item("a", "2026-09-26T20:18:16.730000Z"),
        item("a", "2026-09-26T20:19:00Z"),
        item("b", "2026-09-26T21:00:00Z"),
        { method: "item/started", params: { item: { itemId: "j", turnId: "b", recordedAt: "2026-09-26T20:59:59Z" } } },
      ],
      NOW,
    );
    assert.equal(starts.get("a"), Date.parse("2026-09-26T20:18:16.730Z"));
    assert.equal(starts.get("b"), Date.parse("2026-09-26T20:59:59Z"));
    assert.equal(starts.size, 2);
  });

  it("skips items with no turn, no time, a time that is not one, or one that cannot be right", () => {
    const starts = turnStartTimes(
      [
        item(undefined, "2026-09-26T20:18:16Z"),
        item("a", undefined),
        item("a", "yesterday"),
        item("a", "1970-01-01T00:00:00Z"),
        item("a", "2100-01-01T00:00:00Z"),
        { method: "turn/started", params: { turnId: "a", item: { turnId: "a", recordedAt: "2026-09-26T20:18:16Z" } } },
        { method: "item/completed", params: {} },
      ],
      NOW,
    );
    assert.equal(starts.size, 0);
  });
});

describe("replayUsageAt", () => {
  it("prefers an item's recorded time over the turn id's", () => {
    const itemAt = "2026-09-26T20:18:15.500Z";
    assert.deepEqual(replayUsageAt({ turnId: TURN, itemAt }, NOW), { at: itemAt, source: "item", verified: true });
    assert.deepEqual(replayUsageAt({ turnId: TURN, itemAt: Date.parse(itemAt) }, NOW), { at: itemAt, source: "item", verified: true });
  });

  it("falls back to the turn id's time", () => {
    const result = replayUsageAt({ turnId: uuidv7(TURN_MS), itemAt: null }, NOW);
    assert.deepEqual(result, { at: new Date(TURN_MS).toISOString(), source: "turn", verified: true });
  });

  it("falls back to the thread's activity, then its creation, and calls neither verified", () => {
    const activityAt = "2026-09-27T01:00:45.000Z";
    const createdAt = "2026-09-20T08:00:00.000Z";
    assert.deepEqual(replayUsageAt({ turnId: "t1", activityAt, createdAt }, NOW), { at: activityAt, source: "session", verified: false });
    assert.deepEqual(replayUsageAt({ turnId: "t1", createdAt }, NOW), { at: createdAt, source: "session", verified: false });
    assert.deepEqual(replayUsageAt({ turnId: null, activityAt: "not a date", createdAt }, NOW), { at: createdAt, source: "session", verified: false });
  });

  it("returns now only when nothing else is known", () => {
    assert.deepEqual(replayUsageAt({}, NOW), { at: new Date(NOW).toISOString(), source: "now", verified: false });
    assert.deepEqual(replayUsageAt({ turnId: "t1", itemAt: "garbage", activityAt: "", createdAt: null }, NOW).source, "now");
  });

  it("clamps a time in the future to now and does not trust it", () => {
    const ahead = new Date(NOW + 5 * 60_000).toISOString();
    assert.deepEqual(replayUsageAt({ itemAt: ahead }, NOW), { at: new Date(NOW).toISOString(), source: "item", verified: false });
    assert.deepEqual(replayUsageAt({ turnId: uuidv7(NOW + 60_000) }, NOW), { at: new Date(NOW).toISOString(), source: "turn", verified: false });
    assert.deepEqual(replayUsageAt({ activityAt: ahead }, NOW).at, new Date(NOW).toISOString());
  });

  it("passes over a time that cannot be right", () => {
    assert.equal(replayUsageAt({ itemAt: "1970-01-01T00:00:00Z", turnId: uuidv7(TURN_MS) }, NOW).source, "turn");
  });
});
