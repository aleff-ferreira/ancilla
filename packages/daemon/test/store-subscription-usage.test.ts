import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { AncillaStore } from "../src/store.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function reading(observedAtMs: number, percent = 40) {
  return {
    tier: "high",
    observedAtMs,
    window: { usedPercent: percent, resetsAtMs: observedAtMs + 3_600_000, windowDurationMins: 300 },
    weekly: { usedPercent: 10, resetsAtMs: observedAtMs + DAY, windowDurationMins: null },
  };
}

function open(): AncillaStore {
  const store = new AncillaStore();
  after(() => store.close());
  return store;
}

describe("saved subscription readings", () => {
  it("lets a normal stamp replace a row that holds a stamp 30 days ahead", () => {
    const store = open();
    store.setSubscriptionUsage("work", reading(NOW + 30 * DAY, 10), NOW);
    assert.equal(store.getSubscriptionUsage("work")?.window.usedPercent, 10);
    store.setSubscriptionUsage("work", reading(NOW, 20), NOW);
    assert.deepEqual(store.getSubscriptionUsage("work"), reading(NOW, 20), "a poisoned row heals on the next honest write");
  });

  it("heals a future row with the real clock when no time is passed", () => {
    const store = open();
    const stamp = Date.now();
    store.setSubscriptionUsage("work", reading(stamp + 30 * DAY, 10));
    store.setSubscriptionUsage("work", reading(stamp, 25));
    assert.equal(store.getSubscriptionUsage("work")?.window.usedPercent, 25);
    assert.equal(store.getSubscriptionUsage("work")?.observedAtMs, stamp);
  });

  it("still refuses an older stamp when the saved one is within believable clock skew", () => {
    const store = open();
    store.setSubscriptionUsage("work", reading(NOW + 60_000, 30), NOW);
    store.setSubscriptionUsage("work", reading(NOW, 5), NOW);
    assert.deepEqual(store.getSubscriptionUsage("work"), reading(NOW + 60_000, 30), "a minute ahead is ordinary skew");
  });

  it("draws the line at five minutes ahead", () => {
    const store = open();
    store.setSubscriptionUsage("edge", reading(NOW + 300_000, 30), NOW);
    store.setSubscriptionUsage("edge", reading(NOW, 5), NOW);
    assert.equal(store.getSubscriptionUsage("edge")?.window.usedPercent, 30, "exactly five minutes ahead is kept");
    store.setSubscriptionUsage("over", reading(NOW + 300_001, 30), NOW);
    store.setSubscriptionUsage("over", reading(NOW, 5), NOW);
    assert.equal(store.getSubscriptionUsage("over")?.window.usedPercent, 5, "one millisecond past five minutes is replaceable");
  });

  it("keeps the newest past stamp per scope as before", () => {
    const store = open();
    store.setSubscriptionUsage("work", reading(NOW - 1000, 50), NOW);
    store.setSubscriptionUsage("work", reading(NOW - 2000, 5), NOW);
    assert.equal(store.getSubscriptionUsage("work")?.window.usedPercent, 50);
    assert.equal(store.getSubscriptionUsage("personal"), null);
  });
});
