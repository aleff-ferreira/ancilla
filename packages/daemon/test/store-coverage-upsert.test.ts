import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { AncillaStore } from "../src/store.js";

function open(): AncillaStore {
  const store = new AncillaStore();
  after(() => store.close());
  return store;
}

const T0 = "2026-10-13T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

describe("setUsageCoverage on a thread opened again", () => {
  it("writes nothing when the verdict is the same and was checked less than a minute ago", () => {
    const store = open();
    store.setUsageCoverage("s1", true, T0);
    store.setUsageCoverage("s1", true, at(1));
    store.setUsageCoverage("s1", true, at(59));
    assert.deepEqual(store.getUsageCoverage("s1"), { complete: true, checkedAt: T0 }, "the check date is still the first one");
  });

  it("writes the new check date once a minute has passed", () => {
    const store = open();
    store.setUsageCoverage("s1", false, T0);
    store.setUsageCoverage("s1", false, at(60));
    assert.deepEqual(store.getUsageCoverage("s1"), { complete: false, checkedAt: at(60) });
    store.setUsageCoverage("s1", false, at(61));
    assert.equal(store.getUsageCoverage("s1")?.checkedAt, at(60), "and the minute starts again from there");
  });

  it("writes a changed verdict at once, in either direction", () => {
    const store = open();
    store.setUsageCoverage("s1", false, T0);
    store.setUsageCoverage("s1", true, at(1));
    assert.deepEqual(store.getUsageCoverage("s1"), { complete: true, checkedAt: at(1) });
    store.setUsageCoverage("s1", false, at(2));
    assert.deepEqual(store.getUsageCoverage("s1"), { complete: false, checkedAt: at(2) });
  });

  it("keeps a verdict per thread", () => {
    const store = open();
    store.setUsageCoverage("a", true, T0);
    store.setUsageCoverage("b", true, at(30));
    store.setUsageCoverage("a", true, at(30));
    assert.equal(store.getUsageCoverage("a")?.checkedAt, T0);
    assert.equal(store.getUsageCoverage("b")?.checkedAt, at(30));
  });

  it("does not let a check dated before the stored one write an older date over it", () => {
    const store = open();
    store.setUsageCoverage("s1", true, at(30));
    store.setUsageCoverage("s1", true, T0);
    assert.equal(store.getUsageCoverage("s1")?.checkedAt, at(30));
  });
});
