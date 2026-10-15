import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelCatalog, parseModelList } from "../src/client.js";
import {
  CONTRIBUTOR_NOTE,
  EFFORT_TIERS,
  MODELS_TTL_MS,
  effectiveEffort,
  effortLevelsFor,
  findModel,
  isStale,
  mergeKnownModels,
  modelChoices,
  modelMatches,
  modelTrigger,
  modelsFor,
  modelsKey,
  modelsMenuState,
  modelsShown,
} from "../src/model/models.js";
import type { ModelOption, ModelsStatus, ReasoningEffort } from "../src/types.js";

/** A catalog row the way the picker sees it, without going through the parser. */
function model(modelId: string, extra: Partial<ModelOption> = {}): ModelOption {
  return {
    modelId,
    displayLabel: modelId,
    description: null,
    isDefault: false,
    isActive: false,
    contextLimit: null,
    outputLimit: null,
    cost: null,
    contributor: /contributor/i.test(modelId),
    ...extra,
  };
}

function status(extra: Partial<ModelsStatus> = {}): ModelsStatus {
  return { status: "ready", error: null, loadedAt: 1_000, catalog: null, ...extra };
}

const LEVELS = EFFORT_TIERS.map((value) => ({ value, label: value }));
const SPARK_12: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const SPARK_13: ReasoningEffort[] = [...SPARK_12, "max"];

describe("effort levels in the catalog", () => {
  it("reads both wire spellings, in the UI's order, and never invents a level", () => {
    const parsed = parseModelList({
      models: [
        { modelId: "a", variants: ["low", "high"] },
        { modelId: "b", variants: "unknown" },
        { modelId: "c" },
        { modelId: "d", reasoningEffortVariants: [{ tier: "minimal" }, { tier: "max" }, { tier: "ultra" }] },
        { modelId: "e", variants: ["max", "low", "minimal", "low"] },
        { modelId: "f", variants: [] },
        { modelId: "g", variants: ["ultra"] },
        { modelId: "h", variants: "unknown", reasoningEffortVariants: [{ tier: "medium" }, { description: "no tier" }] },
      ],
    });
    assert.deepEqual(parsed.map((m) => m.efforts), [["low", "high"], null, null, ["minimal", "max"], ["minimal", "low", "max"], null, null, ["medium"]]);
  });

  it("reads the cached catalog's rows: Spark 1.2 stops at Extra high, Spark 1.3 adds Max, neither lists Off", () => {
    // The cache stores `{ tier }` objects in alphabetical order, which is not the order to show.
    const tiers = (list: string[]) => list.map((tier) => ({ tier })).sort((a, b) => a.tier.localeCompare(b.tier));
    const [spark12, spark13, contributor13] = parseModelList({
      models: [
        { modelId: "muse-spark-1.2", reasoningEffortVariants: tiers(SPARK_12) },
        { modelId: "muse-spark-1.3", reasoningEffortVariants: tiers(SPARK_13) },
        { modelId: "muse-spark-1.3-contributor", reasoningEffortVariants: tiers(SPARK_13) },
      ],
    });
    assert.deepEqual(spark12?.efforts, SPARK_12);
    assert.deepEqual(spark13?.efforts, SPARK_13);
    assert.deepEqual(contributor13?.efforts, SPARK_13);
    for (const row of [spark12, spark13]) {
      assert.ok(!row?.efforts?.includes("none"));
    }
    assert.ok(!spark12?.efforts?.includes("max"));
  });

  it("filters the slider's stops to the model's levels, and keeps every stop when the model lists none", () => {
    const stops = (efforts?: ReasoningEffort[] | null) => effortLevelsFor({ efforts }, LEVELS).map((level) => level.value);
    assert.deepEqual(stops(SPARK_12), SPARK_12);
    assert.deepEqual(stops(SPARK_13), SPARK_13);
    assert.deepEqual(stops(null), [...EFFORT_TIERS]);
    assert.deepEqual(stops(undefined), [...EFFORT_TIERS]);
    assert.deepEqual(stops([]), [...EFFORT_TIERS]);
    assert.deepEqual(effortLevelsFor(null, LEVELS).length, 7);
    // Never an empty slider, even for a model whose levels the list does not know.
    assert.equal(effortLevelsFor({ efforts: ["ultra"] }, LEVELS).length, 7);
  });

  it("clamps a wish to the highest level the model lists at or below it, else its lowest, and leaves Auto and unlisted alone", () => {
    const spark12 = { efforts: SPARK_12 };
    const spark13 = { efforts: SPARK_13 };
    assert.equal(effectiveEffort("max", spark12), "xhigh");
    assert.equal(effectiveEffort("ultra", spark12), "xhigh");
    assert.equal(effectiveEffort("none", spark13), "minimal");
    assert.equal(effectiveEffort("max", spark13), "max");
    assert.equal(effectiveEffort("medium", spark13), "medium");
    assert.equal(effectiveEffort("medium", { efforts: ["max", "low"] }), "low", "an unsorted list is still read as a scale");
    assert.equal(effectiveEffort("high", { efforts: null }), "high");
    assert.equal(effectiveEffort("none", {}), "none");
    assert.equal(effectiveEffort("max", undefined), "max");
    assert.equal(effectiveEffort(null, spark12), null);
  });
});

describe("the catalog answer", () => {
  it("carries the source, provider, profile and host version beside the rows", () => {
    const catalog = parseModelCatalog({
      models: { source: "bundledCatalog", providerId: "meta", profileId: "tbh", models: [{ modelId: "muse-spark-1.3", variants: SPARK_13 }] },
      hostVersion: "1.4.0",
    });
    assert.deepEqual(catalog.models.map((m) => m.modelId), ["muse-spark-1.3"]);
    assert.deepEqual(catalog.models[0]?.efforts, SPARK_13);
    assert.equal(catalog.source, "bundledCatalog");
    assert.equal(catalog.providerId, "meta");
    assert.equal(catalog.profileId, "tbh");
    assert.equal(catalog.hostVersion, "1.4.0");
  });

  it("copes with a bare list, a missing host version and garbage", () => {
    assert.deepEqual(parseModelCatalog({ models: [{ modelId: "a" }] }), {
      models: parseModelList([{ modelId: "a" }]),
      source: null,
      providerId: null,
      profileId: null,
      hostVersion: null,
    });
    for (const value of [null, undefined, "x", {}, { models: 4 }]) {
      assert.deepEqual(parseModelCatalog(value), { models: [], source: null, providerId: null, profileId: null, hostVersion: null });
    }
    assert.equal(parseModelCatalog({ models: { models: [], profileId: null, providerId: "meta" }, hostVersion: " " }).hostVersion, null);
  });
});

describe("catalog scopes", () => {
  const spark = model("muse-spark-1.3");
  const wonder = model("muse-wonder-1.0");
  const state = (extra: object = {}) => ({ models: [spark, wonder], accountModels: {} as Record<string, ModelOption[]>, modelsStatus: {} as Record<string, ModelsStatus>, ...extra });

  it("keys a list by the host that answered it: a thread beats its account, which beats the default login", () => {
    assert.equal(modelsKey(), "default");
    assert.equal(modelsKey({}), "default");
    assert.equal(modelsKey({ accountId: null }), "default");
    assert.equal(modelsKey({ accountId: "work" }), "acct:work");
    assert.equal(modelsKey({ sessionId: "s1" }), "thread:s1");
    assert.equal(modelsKey({ accountId: "work", sessionId: "s1" }), "thread:s1");
  });

  it("gives a scope its own list; only the default scope falls back to the union", () => {
    const own = state({ accountModels: { default: [spark], "acct:work": [spark, wonder] } });
    assert.deepEqual(modelsFor(own, "default"), [spark]);
    assert.deepEqual(modelsFor(own, { accountId: "work" }), [spark, wonder]);
    assert.deepEqual(modelsFor(own, { accountId: "other" }), []);
    assert.deepEqual(modelsFor(own, "thread:s1"), []);
    assert.deepEqual(modelsFor(state(), "default"), [spark, wonder], "a state with only `models` still has its default list");
    assert.deepEqual(modelsFor(state(), "acct:work"), []);
  });

  it("shows the default login's list for a failed scope, and says so, but never for one still loading", () => {
    const base = { accountModels: { default: [spark] } };
    const failed = state({ ...base, modelsStatus: { "acct:work": status({ status: "error", error: "no host" }) } });
    assert.deepEqual(modelsShown(failed, "acct:work"), { models: [spark], fallback: true });
    const loading = state({ ...base, modelsStatus: { "acct:work": status({ status: "loading" }) } });
    assert.deepEqual(modelsShown(loading, "acct:work"), { models: [], fallback: false });
    const loaded = state({ accountModels: { default: [spark], "acct:work": [wonder] }, modelsStatus: { "acct:work": status({ status: "error" }) } });
    assert.deepEqual(modelsShown(loaded, "acct:work"), { models: [wonder], fallback: false }, "a refresh that failed keeps the list it had");
    assert.deepEqual(modelsShown(failed, "default"), { models: [spark], fallback: false });
    const nothing = state({ accountModels: { default: [] }, modelsStatus: { "acct:work": status({ status: "error" }) } });
    assert.deepEqual(modelsShown(nothing, "acct:work"), { models: [], fallback: false });
  });

  it("merges every list once, the first winning, so a model only a named account offers is known", () => {
    const newer = model("muse-spark-1.3", { contextLimit: 9 });
    const merged = mergeKnownModels([[spark], [newer, wonder], undefined, null, []]);
    assert.deepEqual(merged.map((m) => m.modelId), ["muse-spark-1.3", "muse-wonder-1.0"]);
    assert.deepEqual(merged[0], { ...spark, contextLimit: 9 }, "the first row wins, and borrows the window it left empty");
    assert.equal(mergeKnownModels([[spark], [model("muse-spark-1.3")]])[0], spark, "the very row when the other adds nothing");
    assert.deepEqual(mergeKnownModels([]), []);
  });
});

describe("a model menu's loading state", () => {
  const rows = [model("muse-spark-1.3")];

  it("reads loading, error, empty and ready from the status and the scope's own list", () => {
    assert.equal(modelsMenuState(undefined, []), "loading");
    assert.equal(modelsMenuState(status({ status: "idle", loadedAt: null }), []), "loading");
    assert.equal(modelsMenuState(status({ status: "loading", loadedAt: null }), []), "loading");
    assert.equal(modelsMenuState(status({ status: "error", error: "down", loadedAt: null }), []), "error");
    assert.equal(modelsMenuState(status(), []), "empty");
    assert.equal(modelsMenuState(status(), rows), "ready");
    assert.equal(modelsMenuState(undefined, rows), "ready", "a list with no status is still a list");
    assert.equal(modelsMenuState(status({ status: "loading" }), rows), "ready", "a refresh in progress keeps the rows");
    assert.equal(modelsMenuState(status({ status: "error", error: "down" }), rows), "error", "a failed refresh says so above the rows it kept");
  });

  it("asks again when a list was never loaded, failed, came back empty or is over ten minutes old", () => {
    const now = 10_000_000;
    assert.equal(isStale(undefined, now), true);
    assert.equal(isStale(status({ status: "idle", loadedAt: null }), now), true);
    assert.equal(isStale(status({ status: "error", loadedAt: now }), now), true);
    assert.equal(isStale(status({ status: "ready", loadedAt: null }), now), true);
    assert.equal(isStale(status({ loadedAt: now - 60_000 }), now, rows), false);
    assert.equal(isStale(status({ loadedAt: now - MODELS_TTL_MS }), now, rows), false);
    assert.equal(isStale(status({ loadedAt: now - MODELS_TTL_MS - 1 }), now, rows), true);
    assert.equal(isStale(status({ loadedAt: now - 60_000 }), now, []), true);
    assert.equal(isStale(status({ loadedAt: now - 60_000 }), now), false, "without the list, the clock decides");
  });
});

describe("the rows of a model menu", () => {
  const catalog = [
    model("muse-wonder-1.0", { displayLabel: "Muse Wonder", description: "The largest model.", contextLimit: 1_048_576 }),
    model("muse-spark-1.3-contributor", {
      isDefault: true,
      description: "Your content may be used for product improvement.",
      contextLimit: 1_000_000,
    }),
    model("muse-spark-1.3", { contextLimit: 1_000_000 }),
  ];
  const selected = (rows: ReturnType<typeof modelChoices>) => rows.filter((row) => row.selected).map((row) => row.id ?? "default");

  it("keeps the host's order, with Muse default first, and tags what the catalog marks", () => {
    const rows = modelChoices(catalog, null, null);
    assert.deepEqual(rows.map((row) => row.id), [null, "muse-wonder-1.0", "muse-spark-1.3-contributor", "muse-spark-1.3"]);
    assert.deepEqual(rows.map((row) => row.kind), ["default", "model", "model", "model"]);
    assert.deepEqual(rows.filter((row) => row.isDefault).map((row) => row.id), ["muse-spark-1.3-contributor"]);
    assert.deepEqual(rows.filter((row) => row.contributor).map((row) => row.id), [null, "muse-spark-1.3-contributor"]);
  });

  it("labels a Contributor row like its regular twin, and shows the catalog's own name and note only when they add something", () => {
    const rows = modelChoices(catalog, null, null);
    const [, wonder, contributor, regular] = rows;
    assert.equal(contributor?.label, "muse-spark-1.3");
    assert.equal(regular?.label, "muse-spark-1.3");
    assert.notEqual(contributor?.contributor, regular?.contributor);
    assert.equal(wonder?.label, "muse-wonder-1.0");
    assert.equal(wonder?.displayLabel, "Muse Wonder");
    assert.equal(wonder?.description, "The largest model.");
    assert.equal(regular?.displayLabel, null, "a catalog name equal to the id says nothing more");
    assert.equal(contributor?.description, null, "the Contributor note is the badge's, not a row description");
    assert.equal(wonder?.contextLimit, 1_048_576);
  });

  it("describes Muse default by the row it follows, and says when that is a Contributor model", () => {
    const [muse] = modelChoices(catalog, null, null);
    assert.equal(muse?.label, "Muse default");
    assert.equal(muse?.description, `Currently muse-spark-1.3, a Contributor model. ${CONTRIBUTOR_NOTE}`);
    const plain = modelChoices([model("muse-spark-1.3", { isDefault: true })], null, null)[0];
    assert.equal(plain?.description, "Currently muse-spark-1.3");
    assert.equal(plain?.contributor, false);
    assert.equal(modelChoices([model("a")], null, null)[0]?.description, "Muse chooses the model");
    assert.equal(modelChoices([], null, null)[0]?.description, "Muse chooses the model");
  });

  it("selects Muse default for a null preference and the preferred row otherwise, never two", () => {
    assert.deepEqual(selected(modelChoices(catalog, null, null)), ["default"]);
    assert.deepEqual(selected(modelChoices(catalog, null, "muse-wonder-1.0")), ["muse-wonder-1.0"]);
    assert.deepEqual(selected(modelChoices(catalog, null, "muse-spark-1.3")), ["muse-spark-1.3"]);
    assert.deepEqual(selected(modelChoices([...catalog, model("muse-wonder-1.0")], null, "muse-wonder-1.0")), ["muse-wonder-1.0"]);
  });

  it("selects an open thread's own model, and not Muse default, whatever the preference is", () => {
    assert.deepEqual(selected(modelChoices(catalog, "muse-spark-1.3", null)), ["muse-spark-1.3"]);
    assert.deepEqual(selected(modelChoices(catalog, "muse-wonder-1.0", "muse-spark-1.3")), ["muse-wonder-1.0"]);
  });

  it("shows a saved default the list does not offer as unavailable, and a thread's model it does not offer as not offered", () => {
    const pinned = modelChoices(catalog, null, "retired-x");
    assert.deepEqual(pinned.map((row) => row.id), [null, "retired-x", "muse-wonder-1.0", "muse-spark-1.3-contributor", "muse-spark-1.3"]);
    assert.deepEqual(selected(pinned), ["retired-x"]);
    assert.equal(pinned[1]?.kind, "pin");
    assert.equal(pinned[1]?.note, "unavailable");
    const onThread = modelChoices(catalog, "retired-x", null);
    assert.equal(onThread[1]?.note, "not offered");
    assert.deepEqual(selected(onThread), ["retired-x"]);
    // An empty list says nothing about a model; it may only not have loaded yet.
    assert.deepEqual(modelChoices([], null, "retired-x").map((row) => row.id), [null]);
    assert.deepEqual(modelChoices([], "retired-x", null).map((row) => row.id), [null]);
    assert.ok(modelChoices(catalog, null, null).every((row) => row.note === null));
  });
});

describe("the model button", () => {
  const catalog = [model("muse-wonder-1.0"), model("muse-spark-1.3-contributor", { isDefault: true }), model("muse-spark-1.3")];

  it("names the thread's model, the saved default, or Muse's default, in that order of say", () => {
    assert.equal(modelTrigger(catalog, "muse-wonder-1.0", null).text, "muse-wonder-1.0");
    assert.equal(modelTrigger(catalog, "muse-wonder-1.0", "muse-spark-1.3").text, "muse-wonder-1.0");
    assert.equal(modelTrigger(catalog, null, "muse-wonder-1.0").text, "muse-wonder-1.0");
    const followed = modelTrigger(catalog, null, null);
    assert.equal(followed.text, "muse-spark-1.3");
    assert.equal(followed.contributor, true, "Muse's default here is the Contributor row");
    assert.equal(modelTrigger(catalog, "muse-spark-1.3", null).contributor, false);
    assert.equal(modelTrigger([], null, null).text, "Default model");
    assert.equal(modelTrigger([model("a")], null, null).text, "Default model", "no default row names none");
  });

  it("flags a model the list lacks, but only against a list that has loaded", () => {
    const lacking = modelTrigger(catalog, null, "retired-x");
    assert.equal(lacking.text, "retired-x (unavailable)");
    assert.equal(lacking.name, "retired-x");
    assert.equal(lacking.note, "unavailable");
    assert.equal(modelTrigger(catalog, "retired-x", null).text, "retired-x (not offered)");
    assert.equal(modelTrigger([], "retired-x", null).text, "retired-x");
    assert.equal(modelTrigger([], null, "retired-x").text, "retired-x");
    assert.equal(modelTrigger(catalog, "muse-spark-1.3", null).note, null);
  });
});

describe("finding a model by name", () => {
  // The Contributor row first, as a reordered catalog could send it.
  const catalog = [model("muse-spark-1.3-contributor"), model("muse-spark-1.3"), model("muse-spark-1.2"), model("muse-wonder-1.0", { displayLabel: "Muse Wonder" })];
  const ids = (query: string) => modelMatches(catalog, query).map((m) => m.modelId);

  it("ranks the exact id, then the exact name, then a prefix, then any part of it", () => {
    assert.deepEqual(ids("muse-spark-1.3"), ["muse-spark-1.3"], "the regular row answers for its own id, not the Contributor twin");
    assert.deepEqual(ids("MUSE-SPARK-1.3-CONTRIBUTOR"), ["muse-spark-1.3-contributor"]);
    assert.deepEqual(ids("muse wonder"), ["muse-wonder-1.0"], "the catalog's own name, spaces for hyphens");
    assert.deepEqual(ids("muse wonder 1.0"), ["muse-wonder-1.0"]);
    assert.deepEqual(ids("muse-spark"), ["muse-spark-1.3", "muse-spark-1.2"], "a prefix lists the family, newest first, without the Contributor twin");
    assert.deepEqual(ids("1.2"), ["muse-spark-1.2"]);
    assert.deepEqual(ids("wonder"), ["muse-wonder-1.0"]);
    assert.deepEqual(ids("nothing-like-it"), []);
    assert.deepEqual(ids("  "), []);
  });

  it("brings the Contributor row in only when asked, or when it has no regular twin", () => {
    assert.deepEqual(ids("contributor"), ["muse-spark-1.3-contributor"]);
    assert.deepEqual(ids("spark 1.3 contributor"), ["muse-spark-1.3-contributor"]);
    const alone = [model("muse-wonder-1.0-contributor")];
    assert.deepEqual(modelMatches(alone, "wonder").map((m) => m.modelId), ["muse-wonder-1.0-contributor"]);
  });

  it("puts a better rank ahead of host order", () => {
    const rows = [model("muse-spark-1.3"), model("spark"), model("my-spark-model")];
    assert.deepEqual(modelMatches(rows, "spark").map((m) => m.modelId), ["spark", "muse-spark-1.3", "my-spark-model"]);
  });

  it("resolves one model, or none when the best matches are different families", () => {
    assert.equal(findModel(catalog, "muse-spark-1.3")?.modelId, "muse-spark-1.3");
    assert.equal(findModel(catalog, "spark")?.modelId, "muse-spark-1.3");
    assert.equal(findModel(catalog, "wonder")?.modelId, "muse-wonder-1.0");
    assert.equal(findModel(catalog, "nothing-like-it"), undefined);
    const withFull = [...catalog, model("muse-wonder-full-x")];
    assert.equal(findModel(withFull, "wonder"), undefined);
    assert.equal(findModel(withFull, "muse-wonder-1.0")?.modelId, "muse-wonder-1.0");
    assert.equal(findModel(withFull, "muse-wonder-full-x")?.modelId, "muse-wonder-full-x");
    assert.equal(findModel(withFull, "muse"), undefined, "everything starts with muse: that is not a choice");
  });
});
