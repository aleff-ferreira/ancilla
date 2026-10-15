import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { costOf, formatCost, listedPrice, priceOf, publishedModelIds } from "../src/model/pricing.js";

describe("pricing", () => {
  it("prices the contributor tier apart from the model it mirrors", () => {
    assert.deepEqual(listedPrice("muse-spark-1.3"), { input: 1.25, output: 4.25, cached: 0.15, currency: "USD" });
    assert.deepEqual(listedPrice("muse-spark-1.3-contributor"), { input: 0.1, output: 0.2, cached: 0.002, currency: "USD" });
    assert.equal(listedPrice("muse-spark-9.9")?.input, 1.25, "an unlisted version falls back to its family");
    assert.equal(listedPrice("muse-spark-9.9-contributor")?.output, 0.2);
    assert.equal(listedPrice("some-other-model"), null);
    assert.equal(listedPrice(null), null);
  });

  it("counts cached prompt tokens at the cached rate", () => {
    const price = listedPrice("muse-spark-1.3");
    assert.ok(price);
    assert.equal(costOf(price, { promptTokens: 1_000_000, outputTokens: 0 }), 1.25);
    assert.equal(costOf(price, { promptTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 }), 0.15);
    assert.equal(costOf(price, { promptTokens: 0, outputTokens: 1_000_000 }), 4.25);
    assert.equal(costOf(price, { promptTokens: 100, outputTokens: 0, cachedTokens: 500 }), 0.15 * 100 / 1_000_000, "cached never exceeds the prompt");
  });

  it("shows a cheap turn without rounding it away", () => {
    assert.equal(formatCost(0), "$0");
    assert.equal(formatCost(0.00123), "$0.0012");
    assert.equal(formatCost(0.4321), "$0.432");
    assert.equal(formatCost(12.3456), "$12.35");
  });

  it("picks the number of decimals from the rounded amount", () => {
    assert.equal(formatCost(0.9996), "$1.00");
    assert.equal(formatCost(0.9994), "$0.999");
    assert.equal(formatCost(0.00999), "$0.010");
    assert.equal(formatCost(0.0099996), "$0.010");
    assert.equal(formatCost(0.0099), "$0.0099");
  });

  it("prices Muse Wonder 1.0 at Meta's published rates", () => {
    const wonder = listedPrice("muse-wonder-1.0");
    assert.deepEqual(wonder, { input: 4, output: 20, cached: 0.2, currency: "USD" });
    assert.ok(wonder);
    assert.equal(costOf(wonder, { promptTokens: 1_000_000, outputTokens: 1_000_000 }), 24);
    assert.ok(Math.abs(costOf(wonder, { promptTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 }) - 0.2) < 1e-9);
    assert.ok(Math.abs(costOf(wonder, { promptTokens: 1_000_000, outputTokens: 0, cachedTokens: 500_000 }) - 2.1) < 1e-9);
  });

  it("leaves every id without its own row unpriced, Wonder Full included", () => {
    const unpriced = [
      "muse-wonder",
      "muse-wonder-1.1",
      "muse-wonder-1.0-contributor",
      "muse-wonder-full",
      "muse-wonder-full-1.0",
      "muse-sparkle-1",
      "unknown",
      "constructor",
      "",
    ];
    for (const id of unpriced) {
      assert.equal(listedPrice(id), null, id);
    }
  });
});

describe("publishedModelIds", () => {
  it("lists the ids Meta prices and serves in Muse Code, newest first, without contributor tiers", () => {
    assert.deepEqual(publishedModelIds(), ["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"]);
  });

  it("leaves out Spark 1.1, which is API only, though its price stays for the calls that used it", () => {
    assert.ok(!publishedModelIds().includes("muse-spark-1.1"));
    assert.deepEqual(listedPrice("muse-spark-1.1"), { input: 1.25, output: 4.25, cached: 0.15, currency: "USD" });
  });
});

describe("priceOf", () => {
  const table = { input: 1.25, output: 4.25, cached: 0.15, currency: "USD" };

  it("falls back to the published table when the catalog is empty or lists no price", () => {
    assert.deepEqual(priceOf("muse-spark-1.3", []), table);
    assert.deepEqual(priceOf("muse-spark-1.3", [{ modelId: "muse-spark-1.3", cost: null }]), table);
    assert.deepEqual(priceOf("muse-wonder-1.0", []), { input: 4, output: 20, cached: 0.2, currency: "USD" });
  });

  it("lets a catalog price win and reads a missing currency as dollars", () => {
    const models = [{ modelId: "muse-spark-1.3", cost: { input: 3, output: 15, cached: 0.3, currency: null } }];
    assert.deepEqual(priceOf("muse-spark-1.3", models), { input: 3, output: 15, cached: 0.3, currency: "USD" });
    const euros = [{ modelId: "muse-spark-1.3", cost: { input: 1, output: 2, cached: 0.1, currency: "EUR" } }];
    assert.equal(priceOf("muse-spark-1.3", euros)?.currency, "EUR");
  });

  it("keeps Wonder Full and a call with no model id unpriced", () => {
    assert.equal(priceOf("muse-wonder-full-1.0", [{ modelId: "muse-wonder-full-1.0", cost: null }]), null);
    assert.equal(priceOf(null, []), null);
    assert.equal(priceOf(undefined, []), null);
    assert.equal(priceOf("unknown", []), null);
  });
});
