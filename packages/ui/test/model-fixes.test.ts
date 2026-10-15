import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_COPY,
  MODELS_RETRY_MS,
  MODELS_TTL_MS,
  anyTurnRunning,
  anyWorkRunning,
  choiceDetail,
  choiceName,
  isStale,
  knownModels,
  literalModelId,
  mergeKnownModels,
  modelChoices,
  modelCompletions,
  modelMenu,
  modelStub,
  modelTrigger,
  modelsStanding,
  offeredByAnother,
  publishedStubs,
  type ModelMenuOptions,
  type ModelMenuSource,
} from "../src/model/models.js";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { listedPrice, publishedModelIds } from "../src/model/pricing.js";
import { defaultPrefs, revivePrefs } from "../src/model/store.js";
import type { ModelCatalogInfo, ModelOption, ModelsStatus, ViewEvent } from "../src/types.js";
import { fakeResearchRun, runningResearch } from "./fixtures/research.js";
import { LIVE_1_4_0, LIVE_1_4_7 } from "./fixtures/picker-catalogs.js";

/** A background shell task still working: no lead turn is running, and the thread is busy all the same. */
function taskEvents(status: "inProgress" | "completed" = "inProgress"): ViewEvent[] {
  return [
    {
      method: status === "inProgress" ? "item/started" : "item/completed",
      at: 1_000,
      params: {
        item: {
          itemId: "task-1", kind: "toolCall", status, revision: 1, turnId: "t1", tool: "shell", background: true,
          args: JSON.stringify({ command: "npm run docs:build" }), recordedAt: new Date(1_000).toISOString(), visibleOutput: "building",
        },
      },
    },
  ];
}

function foldOf(events: ViewEvent[]) {
  return applyEvents(emptyFold(), events);
}

function model(modelId: string, extra: Partial<ModelOption> = {}): ModelOption {
  return modelStub(modelId, extra);
}

function catalog(source: string | null): ModelCatalogInfo {
  return { source, providerId: "meta", profileId: "default", hostVersion: "1.4.7" };
}

function ready(info: ModelCatalogInfo | null, loadedAt = 1_000): ModelsStatus {
  return { status: "ready", error: null, loadedAt, catalog: info };
}

function source(lists: Record<string, ModelOption[]>, statuses: Record<string, ModelsStatus>): ModelMenuSource {
  return { models: knownModels(lists, statuses), accountModels: lists, modelsStatus: statuses, accounts: null };
}

function options(extra: Partial<ModelMenuOptions> = {}): ModelMenuOptions {
  return { scope: {}, accountId: null, current: null, pref: null, plan: null, ...extra };
}

const REAL_BUILT_IN = LIVE_1_4_7.models;
const REAL_PLAN = LIVE_1_4_0.models;

describe("a union that keeps what each list knows (K4)", () => {
  it("fills the window, output limit, price and levels a row leaves empty from a later list, keeping the first's own facts", () => {
    const bare = model("a", { efforts: ["low", "high"], isDefault: true });
    const full = model("a", {
      contextLimit: 1000,
      outputLimit: 64,
      cost: { input: 1, output: 2, cached: 0.5, currency: "USD" },
      efforts: ["low", "medium", "high", "max"],
      isDefault: false,
      description: "later",
    });
    const [merged] = mergeKnownModels([[bare], [full]]);
    assert.equal(merged?.contextLimit, 1000);
    assert.equal(merged?.outputLimit, 64);
    assert.deepEqual(merged?.cost, { input: 1, output: 2, cached: 0.5, currency: "USD" });
    assert.deepEqual(merged?.efforts, ["low", "medium", "high", "max"], "the wider levels");
    assert.equal(merged?.isDefault, true, "what the first row says about itself stays");
    assert.equal(merged?.description, null);
    const [kept] = mergeKnownModels([[model("a", { contextLimit: 5, efforts: ["low", "max"] })], [full]]);
    assert.equal(kept?.contextLimit, 5, "a window the first row has is not replaced");
    assert.deepEqual(kept?.efforts, ["low", "medium", "high", "max"], "levels only the later list names are added");
    const [narrower] = mergeKnownModels([[model("a", { efforts: ["low", "medium", "high", "max"] })], [model("a", { efforts: ["low", "high"] })]]);
    assert.deepEqual(narrower?.efforts, ["low", "medium", "high", "max"], "a narrower later list adds nothing");
    const [nothing] = mergeKnownModels([[model("a")], [model("a")]]);
    assert.equal(nothing?.efforts, null);
  });

  it("puts the plan's lists ahead of the limited ones, and the default login first among equals", () => {
    const limited = ready(catalog("bundledCatalog"));
    const plan = ready(catalog("providerCatalog"));
    const lists = { default: REAL_BUILT_IN, "acct:work": REAL_PLAN, "thread:s1": [model("only-here")] };
    const ids = (statuses: Record<string, ModelsStatus>) => knownModels(lists, statuses).map((m) => m.modelId);
    assert.deepEqual(ids({ default: limited, "acct:work": plan, "thread:s1": limited }), [
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
      "only-here",
    ], "the account's plan list leads");
    const both = knownModels({ default: [model("d")], "acct:a": [model("a")], "acct:b": [model("b")] }, { default: plan, "acct:a": plan, "acct:b": plan });
    assert.deepEqual(both.map((m) => m.modelId), ["d", "a", "b"], "the default login first among equals");
    const asked = knownModels({ "acct:b": [model("b")], default: [model("d")], "acct:a": [model("a")] }, {});
    assert.deepEqual(asked.map((m) => m.modelId), ["d", "b", "a"], "without statuses: the default login, then the order asked in");
    const tied = knownModels(
      { default: [model("d", { description: "built-in row" })], "acct:w": [model("d", { description: "plan row" }), model("w")] },
      { default: limited, "acct:w": plan },
    );
    assert.deepEqual(tied.map((m) => m.modelId), ["d", "w"]);
    assert.equal(tied[0]?.description, "plan row", "the plan's row stands for a model both lists name");
    const lone = knownModels({ default: [model("d")], "acct:w": [model("w")] }, { default: limited, "acct:w": plan });
    assert.deepEqual(lone.map((m) => m.modelId), ["w", "d"], "the plan's list leads the built-in one");
  });

  it("keeps the plan's window for a model the built-in list also names (the real 1.4.7 and 1.4.0 rows)", () => {
    const lists = { default: REAL_BUILT_IN, "acct:work": REAL_PLAN };
    const statuses = { default: ready(catalog("bundledCatalog")), "acct:work": ready(catalog("providerCatalog")) };
    const spark = knownModels(lists, statuses).find((m) => m.modelId === "muse-spark-1.3");
    assert.equal(spark?.contextLimit, 1007997, "a built-in row with no window does not hide the plan's");
    assert.equal(spark?.outputLimit, 128000);
    assert.ok(spark?.efforts?.includes("max"), "nor does it narrow the levels");
    // Even with the built-in list first, the window is filled in from the plan's row.
    const first = mergeKnownModels([REAL_BUILT_IN, REAL_PLAN]).find((m) => m.modelId === "muse-spark-1.3");
    assert.equal(first?.contextLimit, 1007997);
  });
});

describe("Muse Code's published ids (K11)", () => {
  it("suggest Wonder, Spark 1.3 and Spark 1.2, and leave out the API-only Spark 1.1 that stays priced", () => {
    assert.deepEqual(publishedModelIds(), ["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"]);
    assert.notEqual(listedPrice("muse-spark-1.1"), null);
    const menu = modelMenu(source({ default: REAL_BUILT_IN }, { default: ready(catalog("bundledCatalog")) }), options());
    assert.deepEqual(menu.published.map((choice) => choice.id), ["muse-wonder-1.0", "muse-spark-1.2"], "on this machine's 1.4.7 list");
  });

  it("words the pin of a model a thread really uses neutrally on a limited list, and keeps the old caption where the plan's list says so", () => {
    const limited = modelChoices(REAL_BUILT_IN, "muse-spark-1.3-contributor", null, false);
    const pin = limited.find((row) => row.kind === "pin");
    assert.equal(pin?.unlisted, "limited");
    assert.equal(choiceDetail(pin as NonNullable<typeof pin>), MODEL_COPY.notNamed);
    assert.equal(MODEL_COPY.notNamed, "Muse's built-in list does not name it");
    const judged = modelChoices(REAL_PLAN, "retired-x", null, true).find((row) => row.kind === "pin");
    assert.equal(judged?.unlisted, "plan");
    assert.equal(choiceDetail(judged as NonNullable<typeof judged>), MODEL_COPY.notListed);
    assert.equal(judged?.note, "not offered");
    const menu = modelMenu(
      source({ default: REAL_BUILT_IN, "thread:s1": REAL_BUILT_IN }, { default: ready(catalog("bundledCatalog")), "thread:s1": ready(catalog("bundledCatalog")) }),
      options({ scope: { sessionId: "s1" }, current: "muse-spark-1.3-contributor" }),
    );
    assert.equal(menu.rows.find((row) => row.kind === "pin")?.unlisted, "limited");
    assert.equal(menu.trigger.text, "muse-spark-1.3", "and the button carries no note");
  });
});

describe("a model tried by its id stays tried (K2)", () => {
  it("is not called unavailable by the rows or the button, and its row says it is not in Muse's list", () => {
    const list = REAL_PLAN;
    const plain = modelChoices(list, null, "muse-wonder-1.0", true).find((row) => row.kind === "pin");
    assert.equal(plain?.note, "unavailable");
    const tried = modelChoices(list, null, "muse-wonder-1.0", true, { tried: true }).find((row) => row.kind === "pin");
    assert.equal(tried?.note, null);
    assert.equal(tried?.unlisted, "tried");
    assert.equal(tried?.selected, true);
    assert.equal(choiceDetail(tried as NonNullable<typeof tried>), MODEL_COPY.notListed);
    assert.equal(choiceName(tried as NonNullable<typeof tried>), "muse-wonder-1.0");
    assert.equal(modelTrigger(list, null, "muse-wonder-1.0", true).text, "muse-wonder-1.0 (unavailable)");
    assert.equal(modelTrigger(list, null, "muse-wonder-1.0", true, { tried: true }).text, "muse-wonder-1.0");
    const menu = modelMenu(source({ default: list }, { default: ready(catalog("providerCatalog")) }), options({ pref: "muse-wonder-1.0", tried: true }));
    assert.equal(menu.trigger.text, "muse-wonder-1.0");
    assert.equal(menu.trigger.note, null);
    assert.equal(menu.rows.find((row) => row.kind === "pin")?.unlisted, "tried");
  });

  it("only speaks for the saved default: a thread's own model off the plan's list is still not offered", () => {
    const onThread = modelChoices(REAL_PLAN, "muse-wonder-1.0", null, true, { tried: true }).find((row) => row.kind === "pin");
    assert.equal(onThread?.note, "not offered");
    assert.equal(modelTrigger(REAL_PLAN, "muse-wonder-1.0", null, true, { tried: true }).text, "muse-wonder-1.0 (not offered)");
  });

  it("is a saved setting: revived with a default of false, kept with its pin, and dropped when there is none", () => {
    const fallback = defaultPrefs("2026-10-01T00:00:00.000Z");
    assert.equal(fallback.defaultModelTried, false);
    assert.equal(revivePrefs({ defaultModelId: "muse-wonder-1.0" }, fallback).defaultModelTried, false, "an older save has none");
    assert.equal(revivePrefs({ defaultModelId: "muse-wonder-1.0", defaultModelTried: true }, fallback).defaultModelTried, true);
    assert.equal(revivePrefs({ defaultModelId: null, defaultModelTried: true }, fallback).defaultModelTried, false, "no pin, nothing tried");
    assert.equal(revivePrefs({ defaultModelId: "x", defaultModelTried: "yes" }, fallback).defaultModelTried, false, "garbage is dropped");
  });
});

describe("a saved model another account offers (K3)", () => {
  const work = [model("muse-wonder-1.0"), model("muse-spark-1.3")];
  const lists = { default: REAL_PLAN, "acct:work": work };
  const statuses = { default: ready(catalog("providerCatalog")), "acct:work": ready(catalog("providerCatalog")) };
  const both = source(lists, statuses);

  it("tells a model the shown list lacks from one a loaded list offers", () => {
    assert.equal(offeredByAnother(both, REAL_PLAN, "muse-wonder-1.0"), true);
    assert.equal(offeredByAnother(both, REAL_PLAN, "muse-spark-1.3"), false, "the shown list has it");
    assert.equal(offeredByAnother(both, REAL_PLAN, "nobody-lists-this"), false);
    assert.equal(offeredByAnother(both, REAL_PLAN, null), false);
    assert.equal(offeredByAnother({ models: REAL_PLAN }, REAL_PLAN, "muse-wonder-1.0"), false, "one list only: no other account");
  });

  it("is said in Settings' menu instead of unavailable, and only when asked for", () => {
    const settings = modelMenu(both, options({ pref: "muse-wonder-1.0", elsewhere: true }));
    assert.equal(settings.offeredElsewhere, true);
    assert.equal(settings.trigger.text, "muse-wonder-1.0");
    const pin = settings.rows.find((row) => row.kind === "pin");
    assert.equal(pin?.note, null);
    assert.equal(pin?.unlisted, "elsewhere");
    assert.equal(choiceDetail(pin as NonNullable<typeof pin>), "Offered by another account");
    assert.equal(MODEL_COPY.elsewhere, "Offered by another account");
    const composer = modelMenu(both, options({ pref: "muse-wonder-1.0" }));
    assert.equal(composer.offeredElsewhere, false);
    assert.equal(composer.trigger.text, "muse-wonder-1.0 (unavailable)", "the composer judges by the account it will run on");
    const nobody = modelMenu(both, options({ pref: "retired-x", elsewhere: true }));
    assert.equal(nobody.trigger.text, "retired-x (unavailable)", "a model no loaded list offers is still unavailable");
  });

  it("outranks a model tried by hand, which another account's list also offers", () => {
    const menu = modelMenu(both, options({ pref: "muse-wonder-1.0", elsewhere: true, tried: true }));
    assert.equal(menu.rows.find((row) => row.kind === "pin")?.unlisted, "elsewhere");
  });
});

describe("what a navigation asks of Muse (K10)", () => {
  const limited = ready(catalog("bundledCatalog"), 1_000);
  const plan = ready(catalog("providerCatalog"), 1_000);
  const failed: ModelsStatus = { status: "error", error: "down", loadedAt: null, catalog: null };

  it("leaves a built-in list be until the ten minutes are up, where the picker never does", () => {
    assert.equal(isStale(limited, 2_000, REAL_BUILT_IN), true);
    assert.equal(isStale(limited, 2_000, REAL_BUILT_IN, { navigation: false }), true);
    assert.equal(isStale(limited, 2_000, REAL_BUILT_IN, { navigation: true }), false);
    assert.equal(isStale(limited, 1_000 + MODELS_TTL_MS, REAL_BUILT_IN, { navigation: true }), false);
    assert.equal(isStale(limited, 1_001 + MODELS_TTL_MS, REAL_BUILT_IN, { navigation: true }), true);
    assert.equal(isStale(plan, 2_000, REAL_PLAN, { navigation: true }), false);
  });

  it("leaves a failure be for a minute, but only for a navigation", () => {
    assert.equal(isStale(failed, 50_000, [], { navigation: true, failedAt: 40_000 }), false);
    assert.equal(isStale(failed, 40_000 + MODELS_RETRY_MS - 1, [], { navigation: true, failedAt: 40_000 }), false);
    assert.equal(isStale(failed, 40_000 + MODELS_RETRY_MS, [], { navigation: true, failedAt: 40_000 }), true);
    assert.equal(isStale(failed, 50_000, [], { failedAt: 40_000 }), true, "the picker, Retry and a force always go through");
    assert.equal(isStale(failed, 50_000, [], { navigation: true }), true, "a failure of unknown age is asked about");
    assert.equal(MODELS_RETRY_MS, 60_000);
  });

  it("leaves an answer with no models be for a minute as well, and a list marked old is always asked about", () => {
    assert.equal(isStale(plan, 2_000, [], { navigation: true }), false);
    assert.equal(isStale(plan, 1_000 + MODELS_RETRY_MS, [], { navigation: true }), true);
    assert.equal(isStale(plan, 2_000, []), true);
    assert.equal(isStale({ ...plan, status: "idle" }, 2_000, REAL_PLAN, { navigation: true }), true);
    assert.equal(isStale(undefined, 2_000, undefined, { navigation: true }), true);
  });
});

describe("restarting Muse waits for background work (K9)", () => {
  const idle = { sessions: { s1: { live: null } }, threads: { s1: { fold: emptyFold(), researchRuns: [] } } };

  it("is quiet for an idle thread, and busy for a background task or a research run with no turn at all", () => {
    assert.equal(anyWorkRunning(idle), false);
    const task = foldOf(taskEvents());
    assert.equal(task.activeTurnId, null, "no lead turn is running: only the task is");
    assert.equal(anyWorkRunning({ ...idle, threads: { s1: { fold: task, researchRuns: [] } } }), true);
    assert.equal(anyWorkRunning({ ...idle, threads: { s1: { fold: foldOf(taskEvents("completed")), researchRuns: [] } } }), false, "a finished task is not work");
    assert.equal(anyWorkRunning({ ...idle, threads: { s1: { fold: emptyFold(), researchRuns: [runningResearch()] } } }), true);
    assert.equal(anyWorkRunning({ ...idle, threads: { s1: { fold: emptyFold(), researchRuns: [fakeResearchRun({ status: "completed" })] } } }), false);
  });

  it("still sees a turn, in the session list or a thread's record, and keeps its first name", () => {
    assert.equal(anyWorkRunning({ ...idle, sessions: { s1: { live: { activeTurnId: "t1" } } } }), true);
    assert.equal(anyWorkRunning({ ...idle, threads: { s1: { fold: { ...emptyFold(), activeTurnId: "t2" }, researchRuns: [] } } }), true);
    assert.equal(anyTurnRunning, anyWorkRunning);
  });

  it("says why in the words the picker and the toast share", () => {
    assert.equal(MODEL_COPY.restartRunning, "Work is still running");
  });
});

describe("a typed name or id (K1)", () => {
  const limited = REAL_BUILT_IN;
  const plan = REAL_PLAN;

  it("takes only plain ids as ids: a listed or published one in its own spelling, or text with a separator or a digit", () => {
    assert.equal(literalModelId("muse-wonder-2.0", plan), "muse-wonder-2.0");
    assert.equal(literalModelId("  muse-wonder-2.0 ", plan), "muse-wonder-2.0");
    assert.equal(literalModelId("MUSE-WONDER-1.0", plan), "muse-wonder-1.0", "a published id, normalised to its own spelling");
    assert.equal(literalModelId("Muse-Spark-1.3-Contributor", plan), "muse-spark-1.3-contributor", "a listed id");
    assert.equal(literalModelId("vendor:model", plan), "vendor:model");
    assert.equal(literalModelId("snake_case", plan), "snake_case");
    assert.equal(literalModelId("v2", plan), "v2", "a digit makes it an id");
  });

  it("calls a bare word a name, so it never becomes an id", () => {
    for (const word of ["wonder", "spark", "wond", "Wonder", "muse", "contributor"]) {
      assert.equal(literalModelId(word, plan), null, word);
      assert.equal(literalModelId(word, limited), null, word);
    }
    assert.equal(literalModelId("not a model", plan), null, "not shaped like an id at all");
    assert.equal(literalModelId("", plan), null);
    assert.equal(literalModelId("a".repeat(101) + "-1", plan), null);
  });

  it("completes a limited list with the published models it lacks, after its own, and marks them", () => {
    const rows = modelCompletions(limited, "", undefined, true);
    assert.deepEqual(rows.map((row) => row.id), ["muse-spark-1.3", "muse-wonder-1.0", "muse-spark-1.2"]);
    assert.deepEqual(rows.map((row) => row.published), [false, true, true]);
    assert.deepEqual(modelCompletions(limited, "wonder", undefined, true).map((row) => row.id), ["muse-wonder-1.0"]);
    assert.deepEqual(modelCompletions(limited, "WOND", undefined, true).map((row) => row.id), ["muse-wonder-1.0"], "case does not matter");
    assert.deepEqual(modelCompletions(limited, "1.2", undefined, true).map((row) => row.id), ["muse-spark-1.2"]);
    assert.deepEqual(modelCompletions(limited, "spark", undefined, true).map((row) => row.id), ["muse-spark-1.3", "muse-spark-1.2"], "the list's own row first");
    assert.deepEqual(modelCompletions(limited, "wonder"), [], "a list that is not limited completes from its own rows");
    assert.deepEqual(modelCompletions(plan, "wonder", undefined, false), []);
  });

  it("builds the stand-ins from what Meta publishes, without repeating a model the list names", () => {
    assert.deepEqual(publishedStubs(limited).map((m) => m.modelId), ["muse-wonder-1.0", "muse-spark-1.2"]);
    assert.deepEqual(publishedStubs([]).map((m) => m.modelId), ["muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"]);
    assert.ok(publishedStubs(limited).every((m) => !m.contributor && !m.isDefault && m.contextLimit === null));
  });

  it("knows what a list stands for: the plan's own, a built-in one, and a stand-in for a failed account", () => {
    const state = {
      models: REAL_PLAN,
      accountModels: { default: REAL_BUILT_IN, "acct:work": [] as ModelOption[], "acct:home": REAL_PLAN },
      modelsStatus: {
        default: ready(catalog("bundledCatalog")),
        "acct:work": { status: "error", error: "no host", loadedAt: null, catalog: null } as ModelsStatus,
        "acct:home": ready(catalog("providerCatalog")),
      },
    };
    assert.deepEqual(modelsStanding(state, "default"), { models: REAL_BUILT_IN, fallback: false, limited: true, judged: false });
    assert.deepEqual(modelsStanding(state, "acct:home"), { models: REAL_PLAN, fallback: false, limited: false, judged: true });
    const stand = modelsStanding(state, "acct:work");
    assert.equal(stand.fallback, true);
    assert.equal(stand.limited, true, "a stand-in list is what the default login's catalog says it is");
    assert.equal(stand.judged, false, "and is never a verdict on the account");
  });
});
