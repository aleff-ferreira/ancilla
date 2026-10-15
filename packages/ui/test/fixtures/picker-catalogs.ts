import { parseModelCatalog } from "../../src/client.js";
import type { ModelCatalog } from "../../src/types.js";

/**
 * What real Muse hosts answered `model/list` with, rows as captured (only the wire fields are copied), run through the
 * client's own parser. Two hosts on one machine, a version apart, disagreeing about what the plan lists.
 */

const DESCRIPTION = "Your content, including inter-session messages, may be used for product improvement.";
const SPARK_13_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const SPARK_12_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

function row(modelId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    contextLimit: 1007997,
    cost: null,
    description: null,
    displayLabel: modelId,
    isActive: false,
    isDefault: false,
    modelId,
    outputLimit: 128000,
    profileId: "tbh",
    providerId: "meta",
    releaseDate: "2026-09-02",
    ...extra,
  };
}

/** Muse 1.4.7: the built-in catalog (`bundledCatalog`) with one row, no window and no Max level. */
export const LIVE_1_4_7: ModelCatalog = parseModelCatalog({
  models: {
    source: "bundledCatalog",
    providerId: "meta",
    profileId: "tbh",
    models: [
      {
        contextLimit: null,
        cost: null,
        defaultReasoningEffort: "high",
        description: null,
        displayLabel: "muse-spark-1.3",
        isActive: false,
        isDefault: false,
        modelId: "muse-spark-1.3",
        outputLimit: null,
        profileId: null,
        providerId: "meta",
        reasoningEffortVariants: [],
        releaseDate: null,
        variants: SPARK_12_LEVELS,
      },
    ],
  },
  hostVersion: "1.4.7",
});

/** Muse 1.4.0: the plan's own list (`providerCatalog`), four Spark rows, the Contributor 1.3 one the default, no Wonder. */
export const LIVE_1_4_0: ModelCatalog = parseModelCatalog({
  models: {
    source: "providerCatalog",
    providerId: "meta",
    profileId: "tbh",
    models: [
      row("muse-spark-1.3", { variants: SPARK_13_LEVELS }),
      row("muse-spark-1.3-contributor", { description: DESCRIPTION, isDefault: true, variants: SPARK_13_LEVELS }),
      row("muse-spark-1.2", { releaseDate: "2026-08-05", variants: SPARK_12_LEVELS }),
      row("muse-spark-1.2-contributor", { description: DESCRIPTION, releaseDate: "2026-08-05", variants: SPARK_12_LEVELS }),
    ],
  },
  hostVersion: "1.4.0",
});

/** The rows and source as the controller tests' fake client takes them. */
export function answer(catalog: ModelCatalog): { models: ModelCatalog["models"]; source: string | null } {
  return { models: catalog.models, source: catalog.source };
}
