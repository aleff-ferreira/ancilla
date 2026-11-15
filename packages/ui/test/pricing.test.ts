import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { costOf, formatCost, listedPrice, priceOf, publishedModelIds } from "../src/model/pricing.js";

describe("Model Pricing Tier Resolution (listedPrice)", () => {
  it("differentiates standard and contributor discount tiers across model families", () => {
    const sparkStandard = listedPrice("muse-spark-1.3");
    assert.deepStrictEqual(sparkStandard, { input: 1.25, output: 4.25, cached: 0.15, currency: "USD" });

    const sparkContributor = listedPrice("muse-spark-1.3-contributor");
    assert.deepStrictEqual(sparkContributor, { input: 0.1, output: 0.2, cached: 0.002, currency: "USD" });

    // Family inheritance for unlisted version numbers
    assert.strictEqual(listedPrice("muse-spark-9.9")?.input, 1.25);
    assert.strictEqual(listedPrice("muse-spark-9.9-contributor")?.output, 0.2);

    assert.strictEqual(listedPrice("nonexistent-vendor-model"), null);
    assert.strictEqual(listedPrice(null), null);
  });

  it("calculates Muse Wonder 1.0 token rates accurately", () => {
    const wonderRate = listedPrice("muse-wonder-1.0");
    assert.deepStrictEqual(wonderRate, { input: 4, output: 20, cached: 0.2, currency: "USD" });
    assert.ok(wonderRate !== null);

    const fullTurnCost = costOf(wonderRate, { promptTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.strictEqual(fullTurnCost, 24);

    const fullCachedCost = costOf(wonderRate, { promptTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 });
    assert.ok(Math.abs(fullCachedCost - 0.2) < 1e-9);

    const partialCachedCost = costOf(wonderRate, { promptTokens: 1_000_000, outputTokens: 0, cachedTokens: 500_000 });
    assert.ok(Math.abs(partialCachedCost - 2.1) < 1e-9);
  });

  it("returns null for unpriced model variants and invalid identifiers", () => {
    const unpricedIdentifiers = [
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
    for (const modelId of unpricedIdentifiers) {
      assert.strictEqual(listedPrice(modelId), null, `Model ${modelId} should not have a listed price`);
    }
  });
});

describe("Token Cost Calculation Engine (costOf)", () => {
  it("evaluates prompt, completion, and discounted cached tokens per million", () => {
    const standardRate = listedPrice("muse-spark-1.3");
    assert.ok(standardRate !== null);

    const freshInputCost = costOf(standardRate, { promptTokens: 1_000_000, outputTokens: 0 });
    assert.strictEqual(freshInputCost, 1.25);

    const cachedInputCost = costOf(standardRate, { promptTokens: 1_000_000, outputTokens: 0, cachedTokens: 1_000_000 });
    assert.strictEqual(cachedInputCost, 0.15);

    const outputCost = costOf(standardRate, { promptTokens: 0, outputTokens: 1_000_000 });
    assert.strictEqual(outputCost, 4.25);

    const clampedCost = costOf(standardRate, { promptTokens: 100, outputTokens: 0, cachedTokens: 500 });
    const expectedClamped = (0.15 * 100) / 1_000_000;
    assert.strictEqual(clampedCost, expectedClamped);
  });
});

describe("Currency Formatting & Precision Rules (formatCost)", () => {
  it("formats micro-costs and larger values with appropriate significant figures", () => {
    assert.strictEqual(formatCost(0), "$0");
    assert.strictEqual(formatCost(0.00123), "$0.0012");
    assert.strictEqual(formatCost(0.4321), "$0.432");
    assert.strictEqual(formatCost(12.3456), "$12.35");
  });

  it("adjusts decimal places based on rounding boundary conditions", () => {
    assert.strictEqual(formatCost(0.9996), "$1.00");
    assert.strictEqual(formatCost(0.9994), "$0.999");
    assert.strictEqual(formatCost(0.00999), "$0.010");
    assert.strictEqual(formatCost(0.0099996), "$0.010");
    assert.strictEqual(formatCost(0.0099), "$0.0099");
  });
});

describe("Published Model Catalog Enumeration (publishedModelIds)", () => {
  it("orders publicly served models in descending generation sequence without contributor tiers", () => {
    const expectedFleet = [
      "muse-wonder-1.0",
      "muse-wonder-full-1.0",
      "muse-ember-1.0",
      "muse-spark-1.3",
      "muse-spark-1.2",
    ];
    assert.deepStrictEqual(publishedModelIds(), expectedFleet);
  });

  it("excludes API-only legacy versions from display while retaining their historical rate card", () => {
    assert.strictEqual(publishedModelIds().includes("muse-spark-1.1"), false);
    assert.deepStrictEqual(listedPrice("muse-spark-1.1"), {
      input: 1.25,
      output: 4.25,
      cached: 0.15,
      currency: "USD",
    });
  });
});

describe("Catalog Price Resolution & Fallbacks (priceOf)", () => {
  const defaultSparkTable = { input: 1.25, output: 4.25, cached: 0.15, currency: "USD" };

  it("defaults to standard published table when dynamic catalog has no entry", () => {
    assert.deepStrictEqual(priceOf("muse-spark-1.3", []), defaultSparkTable);
    assert.deepStrictEqual(
      priceOf("muse-spark-1.3", [{ modelId: "muse-spark-1.3", cost: null }]),
      defaultSparkTable,
    );
    assert.deepStrictEqual(priceOf("muse-wonder-1.0", []), {
      input: 4,
      output: 20,
      cached: 0.2,
      currency: "USD",
    });
  });

  it("allows dynamic catalog prices to override default rates and assumes USD when currency is absent", () => {
    const catalogWithNullCurrency = [
      { modelId: "muse-spark-1.3", cost: { input: 3, output: 15, cached: 0.3, currency: null } },
    ];
    assert.deepStrictEqual(priceOf("muse-spark-1.3", catalogWithNullCurrency), {
      input: 3,
      output: 15,
      cached: 0.3,
      currency: "USD",
    });

    const euroCatalog = [
      { modelId: "muse-spark-1.3", cost: { input: 1, output: 2, cached: 0.1, currency: "EUR" } },
    ];
    assert.strictEqual(priceOf("muse-spark-1.3", euroCatalog)?.currency, "EUR");
  });

  it("leaves unpriced models, null references, and unmapped identifiers without a price", () => {
    const unpricedModelCatalog = [{ modelId: "muse-wonder-full-1.0", cost: null }];
    assert.strictEqual(priceOf("muse-wonder-full-1.0", unpricedModelCatalog), null);
    assert.strictEqual(priceOf(null, []), null);
    assert.strictEqual(priceOf(undefined, []), null);
    assert.strictEqual(priceOf("unknown", []), null);
  });
});
