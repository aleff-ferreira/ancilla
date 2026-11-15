/**
 * Pricing rates and cost calculation across AI models and providers.
 * Translates token usage metrics into currency representations.
 */

export interface TokenPrice {
  input: number;
  output: number;
  cached: number;
  currency: string;
}

const DEFAULT_CURRENCY = "USD";

export const NO_PRICE_REASON = "Meta publishes no price for this model";

const SPARK_PREFIX = "muse-spark-";

/** Base catalog rates per million tokens. */
const BASE_RATES: Record<string, TokenPrice> = {
  "muse-spark-1.1": { input: 1.25, output: 4.25, cached: 0.15, currency: DEFAULT_CURRENCY },
  "muse-spark-1.2": { input: 1.25, output: 4.25, cached: 0.15, currency: DEFAULT_CURRENCY },
  "muse-spark-1.3": { input: 1.25, output: 4.25, cached: 0.15, currency: DEFAULT_CURRENCY },
  "muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cached: 0.002, currency: DEFAULT_CURRENCY },
  "muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cached: 0.002, currency: DEFAULT_CURRENCY },
  "muse-wonder-1.0": { input: 4.0, output: 20.0, cached: 0.2, currency: DEFAULT_CURRENCY },
};

/** Published API rates for third-party models (USD per million tokens). */
const EXTERNAL_PROVIDER_RATES: Record<string, TokenPrice> = {
  "gpt-5.4": { input: 2.5, output: 15.0, cached: 0.25, currency: DEFAULT_CURRENCY },
  "gpt-5.3-codex": { input: 1.75, output: 14.0, cached: 0.175, currency: DEFAULT_CURRENCY },
  "gpt-5-mini": { input: 0.25, output: 2.0, cached: 0.025, currency: DEFAULT_CURRENCY },
  "o3": { input: 2.0, output: 8.0, cached: 0.5, currency: DEFAULT_CURRENCY },
  "claude-opus-5-5": { input: 5.0, output: 25.0, cached: 0.5, currency: DEFAULT_CURRENCY },
  "claude-sonnet-5-5": { input: 3.0, output: 15.0, cached: 0.3, currency: DEFAULT_CURRENCY },
  "claude-haiku-5-5": { input: 1.0, output: 5.0, cached: 0.1, currency: DEFAULT_CURRENCY },
  "claude-opus-4-6": { input: 5.0, output: 25.0, cached: 0.5, currency: DEFAULT_CURRENCY },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cached: 0.3, currency: DEFAULT_CURRENCY },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cached: 0.1, currency: DEFAULT_CURRENCY },
  "gemini-2.5-pro": { input: 1.25, output: 10.0, cached: 0.125, currency: DEFAULT_CURRENCY },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.03, currency: DEFAULT_CURRENCY },
  "kimi-k2.5": { input: 0.6, output: 2.5, cached: 0.15, currency: DEFAULT_CURRENCY },
  "qwen3-coder-plus": { input: 1.0, output: 5.0, cached: 0.2, currency: DEFAULT_CURRENCY },
};

/** Published catalog order for Muse Code models. */
const PUBLISHED_MUSE_MODELS = [
  "muse-wonder-1.0",
  "muse-wonder-full-1.0",
  "muse-ember-1.0",
  "muse-spark-1.3",
  "muse-spark-1.2",
] as const;

export function publishedModelIds(): string[] {
  return Array.from(PUBLISHED_MUSE_MODELS);
}

/** Looks up rate card from model identifier, handling family fallbacks and provider mappings. */
export function listedPrice(modelId: string | null): TokenPrice | null {
  if (!modelId) {
    return null;
  }

  if (Object.hasOwn(BASE_RATES, modelId)) {
    return BASE_RATES[modelId];
  }

  if (Object.hasOwn(EXTERNAL_PROVIDER_RATES, modelId)) {
    return EXTERNAL_PROVIDER_RATES[modelId];
  }

  const strippedName = modelId.includes("/") ? modelId.substring(modelId.lastIndexOf("/") + 1) : modelId;
  if (Object.hasOwn(EXTERNAL_PROVIDER_RATES, strippedName)) {
    return EXTERNAL_PROVIDER_RATES[strippedName];
  }

  const normalizedDashes = strippedName.replace(/\./g, "-");
  if (Object.hasOwn(EXTERNAL_PROVIDER_RATES, normalizedDashes)) {
    return EXTERNAL_PROVIDER_RATES[normalizedDashes];
  }

  if (!modelId.startsWith(SPARK_PREFIX)) {
    return null;
  }

  const isContributorTier = /contributor/i.test(modelId);
  const fallbackKey = Object.keys(BASE_RATES).find(
    (key) => key.startsWith(SPARK_PREFIX) && /contributor/i.test(key) === isContributorTier,
  );

  return fallbackKey ? BASE_RATES[fallbackKey] : null;
}

/** Resolves model pricing by checking catalog definitions first, falling back to published rate tables. */
export function priceOf(
  modelId: string | null | undefined,
  models: readonly { modelId: string; cost: { input: number; output: number; cached: number; currency: string | null } | null }[],
): TokenPrice | null {
  if (!modelId || modelId === "unknown") {
    return null;
  }

  const matched = models.find((entry) => entry.modelId === modelId);
  if (matched?.cost) {
    const { input, output, cached, currency } = matched.cost;
    return { input, output, cached, currency: currency || DEFAULT_CURRENCY };
  }

  return listedPrice(modelId);
}

/** Computes dollar cost for token usage according to rate card per million tokens. */
export function costOf(
  rateCard: TokenPrice,
  usageCounts: { promptTokens: number; outputTokens: number; cachedTokens?: number },
): number {
  const totalPrompts = Math.max(0, usageCounts.promptTokens || 0);
  const cachedAmount = Math.max(0, Math.min(usageCounts.cachedTokens || 0, totalPrompts));
  const freshAmount = Math.max(0, totalPrompts - cachedAmount);
  const generatedTokens = Math.max(0, usageCounts.outputTokens || 0);

  const promptExpense = freshAmount * rateCard.input + cachedAmount * rateCard.cached;
  const outputExpense = generatedTokens * rateCard.output;

  return (promptExpense + outputExpense) / 1_000_000;
}

/** Formats numeric expense into currency string with adaptive precision. */
export function formatCost(amount: number, currency: string = DEFAULT_CURRENCY): string {
  const prefix = currency === DEFAULT_CURRENCY ? "$" : `${currency} `;
  if (!amount || Math.abs(amount) < 1e-9) {
    return `${prefix}0`;
  }

  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);

  const rounded4 = Number(abs.toFixed(4));
  if (rounded4 < 0.01) {
    return `${sign}${prefix}${abs.toFixed(4)}`;
  }

  const rounded3 = Number(abs.toFixed(3));
  if (rounded3 < 1.0) {
    return `${sign}${prefix}${abs.toFixed(3)}`;
  }

  return `${sign}${prefix}${abs.toFixed(2)}`;
}
