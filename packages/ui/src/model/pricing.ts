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

/** Published API rates (USD per million tokens) for non-Muse models so token ledgers show API-equivalent value. */
const OTHER_PROVIDER_PRICES: Record<string, TokenPrice> = {
  "gpt-5.4": { input: 2.5, output: 15, cached: 0.25, currency: USD },
  "gpt-5.3-codex": { input: 1.75, output: 14, cached: 0.175, currency: USD },
  "gpt-5-mini": { input: 0.25, output: 2, cached: 0.025, currency: USD },
  "o3": { input: 2, output: 8, cached: 0.5, currency: USD },
  "claude-opus-5-5": { input: 5, output: 25, cached: 0.5, currency: USD },
  "claude-sonnet-5-5": { input: 3, output: 15, cached: 0.3, currency: USD },
  "claude-haiku-5-5": { input: 1, output: 5, cached: 0.1, currency: USD },
  "claude-opus-4-6": { input: 5, output: 25, cached: 0.5, currency: USD },
  "claude-sonnet-4-6": { input: 3, output: 15, cached: 0.3, currency: USD },
  "claude-haiku-4-5": { input: 1, output: 5, cached: 0.1, currency: USD },
  "gemini-2.5-pro": { input: 1.25, output: 10, cached: 0.125, currency: USD },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.03, currency: USD },
  "kimi-k2.5": { input: 0.6, output: 2.5, cached: 0.15, currency: USD },
  "qwen3-coder-plus": { input: 1, output: 5, cached: 0.2, currency: USD },
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
  if (Object.prototype.hasOwnProperty.call(OTHER_PROVIDER_PRICES, modelId)) {
    return OTHER_PROVIDER_PRICES[modelId] as TokenPrice;
  }
  const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  if (Object.prototype.hasOwnProperty.call(OTHER_PROVIDER_PRICES, bare)) {
    return OTHER_PROVIDER_PRICES[bare] as TokenPrice;
  }
  const hyphenated = bare.replace(/\./g, "-");
  if (Object.prototype.hasOwnProperty.call(OTHER_PROVIDER_PRICES, hyphenated)) {
    return OTHER_PROVIDER_PRICES[hyphenated] as TokenPrice;
  }
  if (!modelId.startsWith(SPARK_PREFIX)) {
    return null;
  }
  const contributor = /contributor/i.test(modelId);
  const family = Object.keys(PRICES).find((id) => id.startsWith(SPARK_PREFIX) && /contributor/i.test(id) === contributor);
  return family ? (PRICES[family] as TokenPrice) : null;
}

/** All models served in Muse Code's catalog, newest first and without contributor tiers. */
const PUBLISHED_MUSE_MODELS = [
  "muse-wonder-1.0",
  "muse-wonder-full-1.0",
  "muse-ember-1.0",
  "muse-spark-1.3",
  "muse-spark-1.2",
] as const;

/**
 * The model ids Meta serves in Muse Code, newest first and without contributor tiers. The picker offers these when
 * Muse sends only a limited built-in list of its own, so any Muse Code model (including subscription-only tiers like
 * Wonder Full and Ember) can still be selected in one click.
 */
export function publishedModelIds(): string[] {
  return [...PUBLISHED_MUSE_MODELS];
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
