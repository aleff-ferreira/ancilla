/**
 * What a thread would have cost at API rates. Muse's own catalog carries a `cost` block, but today every
 * row comes back without one, so these published prices stand in. A catalog price always wins over this
 * table, which only fills the gap.
 *
 * Meta's rates, dollars per million tokens: dev.meta.ai/docs/pricing-rate-limits
 */
export interface TokenPrice {
  input: number;
  output: number;
  cached: number;
  currency: string;
}

const USD = "USD";

/** Why a model shows no dollar figure, for the tooltip or note beside it. */
export const NO_PRICE_REASON = "Meta publishes no price for this model";

const SPARK_PREFIX = "muse-spark-";

const PRICES: Record<string, TokenPrice> = {
  "muse-spark-1.1": { input: 1.25, output: 4.25, cached: 0.15, currency: USD },
  "muse-spark-1.2": { input: 1.25, output: 4.25, cached: 0.15, currency: USD },
  "muse-spark-1.3": { input: 1.25, output: 4.25, cached: 0.15, currency: USD },
  "muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cached: 0.002, currency: USD },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cached: 0.002, currency: USD },
  // Meta lists Wonder as a preview. It has no contributor price, and Wonder Full is subscription-only with no price at all.
  "muse-wonder-1.0": { input: 4, output: 20, cached: 0.2, currency: USD },
};

/**
 * The published price for a model id, or null when none is known. Only Muse Spark falls back by family, so a
 * new Spark minor version is priced like its siblings. Every other id needs its own row: a family match would
 * hand Wonder's price to models Meta has not priced, such as Wonder Full.
 */
export function listedPrice(modelId: string | null): TokenPrice | null {
  if (!modelId) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(PRICES, modelId)) {
    return PRICES[modelId] as TokenPrice;
  }
  if (!modelId.startsWith(SPARK_PREFIX)) {
    return null;
  }
  const contributor = /contributor/i.test(modelId);
  const family = Object.keys(PRICES).find((id) => id.startsWith(SPARK_PREFIX) && /contributor/i.test(id) === contributor);
  return family ? (PRICES[family] as TokenPrice) : null;
}

/** Priced models Meta lists as API only: they stay in the table for old calls but are not served in Muse Code. */
const NOT_IN_MUSE_CODE: ReadonlySet<string> = new Set(["muse-spark-1.1"]);

/**
 * The model ids Meta publishes a price for and serves in Muse Code, newest first and without contributor tiers. The
 * picker offers these when Muse sends only a limited list of its own, so a model the list lacks can still be tried.
 */
export function publishedModelIds(): string[] {
  return Object.keys(PRICES)
    .filter((id) => !/contributor/i.test(id) && !NOT_IN_MUSE_CODE.has(id))
    .reverse();
}

/**
 * What every surface prices a call with: the model's own catalog price when its row carries one, then the
 * published table, else null. A call with no model id has no price either.
 */
export function priceOf(
  modelId: string | null | undefined,
  models: readonly { modelId: string; cost: { input: number; output: number; cached: number; currency: string | null } | null }[],
): TokenPrice | null {
  if (!modelId || modelId === "unknown") {
    return null;
  }
  const catalog = models.find((m) => m.modelId === modelId)?.cost;
  if (catalog) {
    return { input: catalog.input, output: catalog.output, cached: catalog.cached, currency: catalog.currency ?? USD };
  }
  return listedPrice(modelId);
}

/** Dollars for one call's tokens, at a given price. */
export function costOf(
  price: TokenPrice,
  tokens: { promptTokens: number; outputTokens: number; cachedTokens?: number },
): number {
  const cached = Math.max(0, Math.min(tokens.cachedTokens ?? 0, tokens.promptTokens));
  const fresh = Math.max(0, tokens.promptTokens - cached);
  return (fresh * price.input + cached * price.cached + tokens.outputTokens * price.output) / 1_000_000;
}

/**
 * Money as the transcript shows it: enough decimals to see a cheap turn, never more than four. The number of
 * decimals follows the rounded value, so $0.9996 reads $1.00 and not $1.000.
 */
export function formatCost(amount: number, currency = USD): string {
  const symbol = currency === USD ? "$" : `${currency} `;
  if (amount === 0) {
    return `${symbol}0`;
  }
  const fourPlaces = Number(amount.toFixed(4));
  if (fourPlaces < 0.01) {
    return `${symbol}${fourPlaces.toFixed(4)}`;
  }
  const threePlaces = Number(amount.toFixed(3));
  if (threePlaces < 1) {
    return `${symbol}${threePlaces.toFixed(3)}`;
  }
  return `${symbol}${amount.toFixed(2)}`;
}
