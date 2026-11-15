import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { EffortPicker, LEVELS, ModelPicker, slashMenuFor } from "../src/components/composer/Composer.js";
import { SettingsPage } from "../src/components/settings/SettingsPage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { emptyFold } from "../src/model/fold.js";
import { formatTokens } from "../src/model/format.js";
import {
  CONTRIBUTOR_NOTE,
  MODEL_COPY,
  MUSE_DEFAULT_VALUE,
  NO_CHOICE,
  activeModel,
  anyTurnRunning,
  choiceDetail,
  choiceName,
  choiceValue,
  effortNote,
  effortView,
  modelCompletions,
  modelIdError,
  modelMenu,
  modelChoices,
  restartAction,
  selectedValue,
  type ModelMenuOptions,
  type ModelMenuSource,
} from "../src/model/models.js";
import { publishedModelIds } from "../src/model/pricing.js";
import { slashCommands } from "../src/model/slash.js";
import { defaultPrefs, initialState, Store, type AppState, type Prefs } from "../src/model/store.js";
import type { ModelCatalogInfo, ModelOption, ModelsStatus } from "../src/types.js";
import { SESSION } from "./fixtures/lantern.js";

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
    efforts: null,
    ...extra,
  };
}

const SPARK_12 = model("muse-spark-1.2", { efforts: ["minimal", "low", "medium", "high", "xhigh"] });
const SPARK = model("muse-spark-1.3", { isDefault: true, contextLimit: 1_000_000, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] });
const WONDER = model("muse-wonder-1.0", { contextLimit: 1_048_576, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] });

function catalog(source: string | null, hostVersion: string | null = "1.4.7"): ModelCatalogInfo {
  return { source, providerId: "meta", profileId: "default", hostVersion };
}

function ready(info: ModelCatalogInfo | null): ModelsStatus {
  return { status: "ready", error: null, loadedAt: 1_000, catalog: info };
}

const LOADING: ModelsStatus = { status: "loading", error: null, loadedAt: null, catalog: null };

function failed(message: string): ModelsStatus {
  return { status: "error", error: message, loadedAt: null, catalog: null };
}

function source(lists: Record<string, ModelOption[]>, statuses: Record<string, ModelsStatus>, accounts: ModelMenuSource["accounts"] = null): ModelMenuSource {
  const first = lists["default"] ?? Object.values(lists)[0] ?? [];
  return { models: first, accountModels: lists, modelsStatus: statuses, accounts };
}

function options(extra: Partial<ModelMenuOptions> = {}): ModelMenuOptions {
  return { scope: {}, accountId: null, current: null, pref: null, plan: null, ...extra };
}

const PLAN = source({ default: [SPARK, WONDER] }, { default: ready(catalog("providerCatalog")) });

describe("what a model menu says", () => {
  it("lists the rows, names the host and the plan, and points at the likeliest reason a model is missing", () => {
    const menu = modelMenu(PLAN, options({ plan: "Power Usage" }));
    assert.equal(menu.mode, "ready");
    assert.equal(menu.message, null);
    assert.deepEqual(menu.notes, []);
    assert.equal(menu.showRows, true);
    assert.deepEqual(menu.rows.map((row) => row.kind), ["default", "model", "model"]);
    assert.equal(menu.rows[0]?.selected, true, "Muse default is the first row, and selected for a null preference");
    assert.equal(menu.footer.line, "Muse 1.4.7 · Power Usage");
    assert.equal(menu.footer.hint, "Missing a model? Update Muse, restart it and refresh.");
    assert.equal(menu.footer.builtIn, null);
    assert.deepEqual(menu.published, []);
    assert.equal(menu.refreshing, false);
  });

  it("says only what is known in the footer: the version, the plan, either or neither", () => {
    assert.equal(modelMenu(PLAN, options()).footer.line, "Muse 1.4.7");
    const unversioned = source({ default: [SPARK] }, { default: ready(catalog("providerCatalog", null)) });
    assert.equal(modelMenu(unversioned, options({ plan: "Free" })).footer.line, "Free");
    assert.equal(modelMenu(unversioned, options()).footer.line, null);
  });

  it("shows a loading row, and no rows, while the first load runs or has not started", () => {
    for (const status of [LOADING, undefined]) {
      const menu = modelMenu(source({ default: [] }, status ? { default: status } : {}), options());
      assert.equal(menu.mode, "loading");
      assert.equal(menu.message, MODEL_COPY.loading);
      assert.equal(menu.showRows, false);
    }
    assert.equal(modelMenu(source({ default: [] }, { default: LOADING }), options()).refreshing, true);
  });

  it("keeps the rows of a list that is being read again, and says the read is running", () => {
    const menu = modelMenu(source({ default: [SPARK] }, { default: { ...ready(catalog("providerCatalog")), status: "loading" } }), options());
    assert.equal(menu.mode, "ready");
    assert.equal(menu.showRows, true);
    assert.equal(menu.refreshing, true);
  });

  it("says why a load failed, and keeps the older rows under the error when there are any", () => {
    const empty = modelMenu(source({ default: [] }, { default: failed("Could not start Muse") }), options());
    assert.equal(empty.mode, "error");
    assert.equal(empty.message, "Could not load models: Could not start Muse");
    assert.deepEqual(empty.notes, []);
    assert.equal(empty.showRows, true, "Muse default and Other model stay reachable");
    const kept = modelMenu(source({ default: [SPARK] }, { default: { ...failed("offline"), catalog: catalog("providerCatalog") } }), options());
    assert.equal(kept.mode, "error");
    assert.deepEqual(kept.notes, [MODEL_COPY.kept]);
    assert.deepEqual(kept.rows.map((row) => row.id), [null, "muse-spark-1.3"]);
    assert.equal(modelMenu(source({ default: [] }, { default: { ...failed(""), error: null } }), options()).message, "Could not load models");
  });

  it("says Muse listed nothing, and asks for another read", () => {
    const menu = modelMenu(source({ default: [] }, { default: ready(catalog("providerCatalog")) }), options());
    assert.equal(menu.mode, "empty");
    assert.equal(menu.message, MODEL_COPY.empty);
    assert.match(MODEL_COPY.empty, /Refresh/);
  });

  it("shows the default login's list for an account whose load failed, says so, and never judges a model by it", () => {
    const work = source({ default: [SPARK], "acct:work": [] }, { default: ready(catalog("providerCatalog")), "acct:work": failed("no host") });
    const menu = modelMenu(work, options({ scope: { accountId: "work" }, accountId: "work", pref: "muse-wonder-1.0" }));
    assert.equal(menu.mode, "error");
    assert.equal(menu.fallback, true);
    assert.deepEqual(menu.notes, [MODEL_COPY.fallback]);
    assert.deepEqual(menu.models, [SPARK]);
    assert.equal(menu.trigger.text, "muse-wonder-1.0", "the stand-in list proves nothing about the account's own");
    assert.equal(menu.rows.find((row) => row.kind === "pin")?.note, null);
    assert.equal(menu.footer.line, null, "the default login's host version is not this account's");
  });

  it("reads a thread's own list, and calls a model it lacks not offered, but only from a list that is the plan's", () => {
    const thread = (info: ModelCatalogInfo | null) => source({ default: [SPARK, WONDER], "thread:s1": [SPARK] }, { "thread:s1": ready(info) });
    const own = modelMenu(thread(catalog("providerCatalog")), options({ scope: { sessionId: "s1" }, current: "muse-wonder-1.0" }));
    assert.equal(own.trigger.text, "muse-wonder-1.0 (not offered)");
    assert.equal(own.trigger.note, "not offered");
    assert.deepEqual(own.models, [SPARK], "the thread's own list, not the default login's");
    assert.equal(own.rows.find((row) => row.kind === "pin")?.note, "not offered");
    for (const info of [catalog("bundledCatalog"), catalog(null), null]) {
      const unjudged = modelMenu(thread(info), options({ scope: { sessionId: "s1" }, current: "muse-wonder-1.0" }));
      assert.equal(unjudged.trigger.text, "muse-wonder-1.0");
      assert.equal(unjudged.rows.find((row) => row.kind === "pin")?.note, null);
    }
  });

  it("calls a saved default the plan's list lacks unavailable on the new-thread screen", () => {
    const menu = modelMenu(source({ default: [SPARK] }, { default: ready(catalog("providerCatalog")) }), options({ pref: "muse-wonder-1.0" }));
    assert.equal(menu.trigger.text, "muse-wonder-1.0 (unavailable)");
    assert.deepEqual(menu.rows.map((row) => [row.kind, row.selected]), [["default", false], ["pin", true], ["model", false]]);
  });

  it("notes Muse's built-in list, offers the models Meta publishes, and never judges, nor hints at a missing model", () => {
    const built = source({ default: [SPARK] }, { default: ready(catalog("bundledCatalog")) });
    const menu = modelMenu(built, options({ pref: "muse-wonder-1.0" }));
    assert.equal(menu.limited, true);
    assert.deepEqual(menu.notes, [MODEL_COPY.limited]);
    assert.match(MODEL_COPY.limited, /^Muse sent its built-in model list, not your plan's\. Other models may still work: pick one below or type a model id\.$/);
    assert.equal(menu.trigger.text, "muse-wonder-1.0");
    assert.equal(menu.rows.find((row) => row.kind === "pin")?.note, null);
    assert.equal(menu.footer.builtIn, "Built-in model list. Refresh, or update and restart Muse, to load your plan's.");
    assert.equal(menu.footer.hint, null);
    // The published ids the list lacks, newest first; the saved one is already a row, and listed ones are not offered twice.
    const expected = publishedModelIds().filter((id) => id !== "muse-wonder-1.0" && id !== "muse-spark-1.3");
    assert.deepEqual(menu.published.map((choice) => choice.id), expected);
    assert.ok(expected.length > 0);
    const plain = modelMenu(built, options());
    assert.equal(plain.published[0]?.id, "muse-wonder-1.0");
    assert.equal(plain.published[0]?.label, "muse-wonder-1.0");
  });

  it("offers no published models, and no built-in-list line, for the plan's own list or one that does not say where it is from", () => {
    for (const info of [catalog("providerCatalog"), catalog(null), null]) {
      const menu = modelMenu(source({ default: [SPARK] }, { default: ready(info) }), options());
      assert.equal(menu.limited, false);
      assert.deepEqual(menu.published, []);
      assert.equal(menu.footer.builtIn, null);
      assert.equal(menu.footer.hint, MODEL_COPY.missing);
    }
  });

  it("offers a sign-in, not a load, for an account that has no login yet", () => {
    const accounts = [{ id: "work", name: "Work", hasLogin: false }];
    const menu = modelMenu(source({ default: [SPARK] }, { default: ready(catalog("providerCatalog")) }, accounts), options({ scope: { accountId: "work" }, accountId: "work" }));
    assert.equal(menu.mode, "signin");
    assert.equal(menu.message, "Sign in to Work to see its models");
    assert.deepEqual(menu.signIn, { id: "work", name: "Work" });
    const signedIn = modelMenu(source({ "acct:work": [SPARK] }, { "acct:work": ready(catalog("providerCatalog")) }, [{ id: "work", name: "Work", hasLogin: true }]), options({ scope: { accountId: "work" }, accountId: "work" }));
    assert.equal(signedIn.mode, "ready");
    assert.equal(signedIn.signIn, null);
  });
});

describe("the rows' values and words", () => {
  it("gives Muse default the empty value and every model its id, and checks the selected row or none", () => {
    const rows = modelChoices([SPARK, WONDER], null, null);
    assert.deepEqual(rows.map(choiceValue), [MUSE_DEFAULT_VALUE, "muse-spark-1.3", "muse-wonder-1.0"]);
    assert.equal(selectedValue(rows), "");
    assert.equal(selectedValue(modelChoices([SPARK, WONDER], null, "muse-wonder-1.0")), "muse-wonder-1.0");
    assert.equal(selectedValue(modelChoices([SPARK, WONDER], "muse-spark-1.3", null)), "muse-spark-1.3");
    // A saved model an empty list cannot vouch for has no row, and no row may read as selected.
    assert.equal(selectedValue(modelChoices([], null, "muse-wonder-1.0")), NO_CHOICE);
    assert.notEqual(NO_CHOICE, MUSE_DEFAULT_VALUE);
  });

  it("describes a row by what it is: what Muse default follows, the Contributor note, the catalog's words and window, or why it is shown", () => {
    const rows = modelChoices(
      [
        model("muse-spark-1.3-contributor", { isDefault: true, description: "May be used for product improvement.", contextLimit: 1_000_000 }),
        model("muse-wonder-1.0", { description: "The largest model.", contextLimit: 1_048_576 }),
        model("muse-spark-1.2", { contextLimit: 262_144 }),
        model("plain"),
      ],
      null,
      "retired-x",
    );
    const by = (id: string | null) => rows.find((row) => row.id === id) as (typeof rows)[number];
    assert.equal(choiceDetail(by(null)), `Currently muse-spark-1.3, a Contributor model. ${CONTRIBUTOR_NOTE}`);
    assert.equal(choiceDetail(by("muse-spark-1.3-contributor")), CONTRIBUTOR_NOTE);
    assert.equal(choiceDetail(by("muse-wonder-1.0")), `The largest model. · ${formatTokens(1_048_576)} token context`);
    assert.equal(choiceDetail(by("muse-spark-1.2")), `${formatTokens(262_144)} token context`);
    assert.equal(choiceDetail(by("plain")), null);
    assert.equal(choiceDetail(by("retired-x")), MODEL_COPY.notListed);
    assert.equal(MODEL_COPY.notListed, "Not in Muse's list. Muse checks access when you send a prompt.");
  });

  it("names a row with the reason it cannot be chosen again, when it has one", () => {
    const rows = modelChoices([SPARK], null, "retired-x");
    assert.equal(choiceName(rows[1] as (typeof rows)[number]), "retired-x (unavailable)");
    assert.equal(choiceName(rows[2] as (typeof rows)[number]), "muse-spark-1.3");
    assert.equal(choiceName(rows[0] as (typeof rows)[number]), "Muse default");
  });
});

describe("the Restart action", () => {
  it("is off, with the reason, while work runs or a restart is under way", () => {
    assert.deepEqual(restartAction(false, false), { disabled: false, hint: null });
    assert.deepEqual(restartAction(true, false), { disabled: true, hint: "Work is still running" });
    assert.deepEqual(restartAction(false, true), { disabled: true, hint: "Restarting" });
    assert.deepEqual(restartAction(true, true), { disabled: true, hint: "Restarting" });
  });

  it("sees a turn in a thread's record or in the session list", () => {
    const idle = { sessions: { s1: { live: null }, s2: {} }, threads: { s1: { fold: emptyFold() } } };
    assert.equal(anyTurnRunning(idle), false);
    assert.equal(anyTurnRunning({ ...idle, sessions: { ...idle.sessions, s3: { live: { activeTurnId: "t1" } } } }), true);
    assert.equal(anyTurnRunning({ ...idle, threads: { s1: { fold: { ...emptyFold(), activeTurnId: "t2" } } } }), true);
    assert.equal(anyTurnRunning({ sessions: {}, threads: {} }), false);
  });
});

describe("a typed model id", () => {
  it("passes ids Muse could have, and says what is wrong with the rest", () => {
    for (const id of ["muse-wonder-full-1.0", "muse-spark-1.3", "vendor:model-4.1", "a", " muse-wonder-1.0 "]) {
      assert.equal(modelIdError(id), null, id);
    }
    assert.equal(modelIdError(""), "Type a model id.");
    assert.equal(modelIdError("   "), "Type a model id.");
    assert.match(modelIdError("muse wonder") ?? "", /letters, digits/);
    assert.match(modelIdError("-leading") ?? "", /starts with a letter or digit/);
    assert.equal(modelIdError("a".repeat(100)), null);
    assert.equal(modelIdError("a".repeat(101)), "A model id is at most 100 characters.");
  });
});

describe("the model a composer is on", () => {
  const state = {
    models: [SPARK, WONDER, SPARK_12],
    accountModels: { default: [SPARK, WONDER], "thread:s1": [SPARK_12] },
    modelsStatus: { default: ready(catalog("providerCatalog")), "thread:s1": ready(catalog("providerCatalog")) },
  };

  it("is the open thread's model, else the saved default, else the list's own default", () => {
    assert.equal(activeModel(state, { sessionId: "s1" }, "muse-spark-1.2", null)?.modelId, "muse-spark-1.2");
    assert.equal(activeModel(state, {}, null, "muse-wonder-1.0")?.modelId, "muse-wonder-1.0");
    assert.equal(activeModel(state, {}, null, null)?.modelId, "muse-spark-1.3");
    assert.equal(activeModel({ ...state, accountModels: {} }, {}, null, null)?.modelId, "muse-spark-1.3");
  });

  it("looks in every list known when the one on show lacks the model, and finds nothing for an id nobody lists", () => {
    assert.equal(activeModel(state, {}, null, "muse-spark-1.2")?.modelId, "muse-spark-1.2");
    assert.equal(activeModel(state, {}, null, "retired-x"), undefined);
    assert.equal(activeModel({ models: [], accountModels: {}, modelsStatus: {} }, {}, null, null), undefined);
  });
});

describe("/model completions", () => {
  const models = [WONDER, model("muse-wonder-full-1.0"), SPARK, model("muse-spark-1.3-contributor", { isDefault: true }), SPARK_12];

  it("lists every model in the host's order while nothing is typed yet", () => {
    assert.deepEqual(modelCompletions(models, "").map((row) => row.id), models.map((m) => m.modelId));
    assert.deepEqual(modelCompletions(models, "   ").map((row) => row.id), models.map((m) => m.modelId));
  });

  it("lists the models the text fits, best first, the regular row ahead of its Contributor twin", () => {
    assert.deepEqual(modelCompletions(models, "wonder").map((row) => row.id), ["muse-wonder-1.0", "muse-wonder-full-1.0"]);
    assert.deepEqual(modelCompletions(models, "muse spark 1.3").map((row) => row.id), ["muse-spark-1.3"]);
    assert.deepEqual(modelCompletions(models, "spark 1.3 contributor").map((row) => row.id), ["muse-spark-1.3-contributor"]);
    assert.deepEqual(modelCompletions(models, "nothing like it"), []);
  });

  it("carries what the row shows: the label without its tier, the window, and the Default and Contributor flags", () => {
    const [row] = modelCompletions(models, "spark 1.3 contributor");
    assert.deepEqual(row, { id: "muse-spark-1.3-contributor", label: "muse-spark-1.3", detail: null, isDefault: true, contributor: true, published: false });
    assert.equal(modelCompletions(models, "wonder 1.0")[0]?.detail, `${formatTokens(1_048_576)} token context`);
  });
});

describe("the slash menu for /model", () => {
  const commands = slashCommands([], { inThread: true });
  const models = [WONDER, SPARK];
  const menuFor = (text: string, caret = text.length, list = models) => slashMenuFor(text, caret, commands, undefined, list);

  it("completes the models the text after /model fits, and lists them all once a space is typed", () => {
    const some = menuFor("/model wond");
    assert.equal(some?.kind, "models");
    assert.equal(some?.prefix, "/model ");
    assert.deepEqual(some?.kind === "models" ? some.items.map((item) => item.id) : [], ["muse-wonder-1.0"]);
    const all = menuFor("/model ");
    assert.deepEqual(all?.kind === "models" ? all.items.map((item) => item.id) : [], ["muse-wonder-1.0", "muse-spark-1.3"]);
    assert.equal(menuFor("/models spark")?.kind, "models", "the alias completes too");
  });

  it("keeps listing commands while the caret is in the command word", () => {
    const first = menuFor("/model");
    assert.equal(first?.kind, "list");
    assert.equal(first?.kind === "list" ? first.items[0]?.name : null, "model");
  });

  it("says nothing when no model fits, the list is empty, or the caret is not at the end", () => {
    assert.equal(menuFor("/model zzzz"), null);
    assert.equal(menuFor("/model ", undefined, []), null);
    assert.equal(menuFor("/model wond", 8), null);
    assert.equal(menuFor("/effort wond"), null);
  });
});

describe("the effort slider for a model", () => {
  const stops = (view: { levels: { value: string }[] }) => view.levels.map((level) => level.value);

  it("offers only the levels the model lists, and shows a level it lacks as the nearest it has", () => {
    const view = effortView(SPARK_12, "max", LEVELS);
    assert.deepEqual(stops(view), ["minimal", "low", "medium", "high", "xhigh"]);
    assert.equal(view.shown, "xhigh");
    assert.equal(view.position, 4);
    assert.equal(view.clamped, true);
    assert.equal(view.auto, false);
    const off = effortView(SPARK, "none", LEVELS);
    assert.deepEqual(stops(off), ["minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(off.shown, "minimal", "no model lists Off, so it reads as the lowest level");
    assert.equal(off.position, 0);
  });

  it("offers every level when the model lists none, or when there is no model yet", () => {
    for (const none of [model("x"), undefined, null]) {
      const view = effortView(none, "high", LEVELS);
      assert.equal(view.levels.length, LEVELS.length);
      assert.equal(view.shown, "high");
      assert.equal(view.clamped, false);
      assert.equal(view.position, 4);
    }
  });

  it("rests Auto on Medium, or on the nearest level the model has", () => {
    const auto = effortView(SPARK_12, null, LEVELS);
    assert.equal(auto.auto, true);
    assert.equal(auto.shown, null);
    assert.equal(auto.clamped, false);
    assert.equal(auto.position, 2);
    assert.equal(effortView(model("x", { efforts: ["low", "high"] }), null, LEVELS).position, 0);
    assert.equal(effortView(SPARK, null, LEVELS, "max").position, 5);
  });

  it("reads an old saved Ultra as Max, as Muse runs it", () => {
    const view = effortView(SPARK, "ultra", LEVELS);
    assert.equal(view.shown, "max");
    assert.equal(view.clamped, false);
    assert.equal(effortView(SPARK_12, "ultra", LEVELS).shown, "xhigh");
    assert.equal(effortNote("ultra", "max"), null);
  });

  it("says, once the choice had to give way, which level runs and that the choice is kept", () => {
    assert.equal(
      effortNote("max", "xhigh"),
      "Max is not available on this model. It runs at Extra high, and your choice is kept for other models.",
    );
    assert.equal(effortNote("none", "minimal", "muse-spark-1.3"), "Off is not available on muse-spark-1.3. It runs at Minimal, and your choice is kept for other models.");
    assert.equal(effortNote("high", "high"), null);
    assert.equal(effortNote(null, null), null);
  });
});

// ---------------------------------------------------------------- rendered

function render<P extends object>(Component: ComponentType<P>, props: P, patch: Partial<AppState>, prefs: Partial<Prefs> = {}): string {
  const store = new Store<AppState>({ ...initialState({ ...defaultPrefs("2026-09-28T00:00:00.000Z"), ...prefs }), connection: "open", ...patch });
  const controller = { store, loadAccounts: async () => {} } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(Component, props) }) }));
}

function lists(list: ModelOption[], info: ModelCatalogInfo | null, extra: Partial<AppState> = {}): Partial<AppState> {
  return { models: list, accountModels: { default: list }, modelsStatus: { default: ready(info) }, ...extra };
}

const PICKER = { sessionId: null, cwd: null, side: "top" as const };

describe("the model button", () => {
  it("names Muse's default model on the new-thread screen until another is saved", () => {
    const html = render(ModelPicker, PICKER, lists([WONDER, SPARK], catalog("providerCatalog")));
    assert.match(html, /aria-label="Model: muse-spark-1\.3"/);
    assert.doesNotMatch(html, /not offered|unavailable/);
  });

  it("names the saved default, and says a model the plan's list lacks is unavailable", () => {
    const html = render(ModelPicker, PICKER, lists([SPARK], catalog("providerCatalog")), { defaultModelId: "muse-wonder-1.0" });
    assert.match(html, /aria-label="Model: muse-wonder-1\.0 \(unavailable\)"/);
    assert.match(html, /muse-wonder-1\.0<\/span><span[^>]*>\(unavailable\)<\/span>/, "the button reads the same, and the reason never truncates away");
  });

  it("says a thread's model its own list lacks is not offered, and a built-in list never says either", () => {
    const thread = (info: ModelCatalogInfo | null): Partial<AppState> => ({
      sessions: { s1: { ...SESSION, modelId: "muse-wonder-1.0" } },
      models: [SPARK],
      accountModels: { default: [SPARK], "thread:s1": [SPARK] },
      modelsStatus: { default: ready(info), "thread:s1": ready(info) },
    });
    const own = render(ModelPicker, { ...PICKER, sessionId: "s1" }, thread(catalog("providerCatalog")));
    assert.match(own, /aria-label="Model: muse-wonder-1\.0 \(not offered\)"/);
    const built = render(ModelPicker, { ...PICKER, sessionId: "s1" }, thread(catalog("bundledCatalog")));
    assert.match(built, /aria-label="Model: muse-wonder-1\.0"/);
    assert.doesNotMatch(built, /not offered/);
  });

  it("shows a Contributor model's badge, and has no note while the list has not loaded", () => {
    const contributor = model("muse-spark-1.3-contributor", { isDefault: true });
    assert.match(render(ModelPicker, PICKER, lists([contributor], catalog("providerCatalog"))), /Contributor/);
    const html = render(ModelPicker, PICKER, { models: [], accountModels: {}, modelsStatus: {} }, { defaultModelId: "muse-wonder-1.0" });
    assert.match(html, /aria-label="Model: muse-wonder-1\.0"/);
  });

  it("names Muse's default for a thread whose model Muse has not said, whatever default is saved", () => {
    const state: Partial<AppState> = {
      sessions: { s1: { ...SESSION, modelId: null } },
      models: [SPARK],
      accountModels: { default: [SPARK], "thread:s1": [SPARK] },
      modelsStatus: { default: ready(catalog("providerCatalog")), "thread:s1": ready(catalog("providerCatalog")) },
    };
    const html = render(ModelPicker, { ...PICKER, sessionId: "s1" }, state, { defaultModelId: "muse-wonder-1.0" });
    assert.match(html, /aria-label="Model: muse-spark-1\.3"/, "the saved default is for new threads, not this one");
  });
});

describe("the effort button", () => {
  it("shows the level a turn runs at: the wish, or the nearest level the model has", () => {
    const state = lists([SPARK_12, SPARK], catalog("providerCatalog"));
    const props = { sessionId: null, cwd: null, side: "top" as const };
    assert.match(render(EffortPicker, props, state, { defaultModelId: "muse-spark-1.3", effort: "max" }), /aria-label="Reasoning effort: Max"/);
    assert.match(render(EffortPicker, props, state, { defaultModelId: "muse-spark-1.2", effort: "max" }), /aria-label="Reasoning effort: Extra high"/);
    assert.match(render(EffortPicker, props, state, { defaultModelId: "muse-spark-1.2", effort: null }), /aria-label="Reasoning effort: Auto"/);
    assert.match(render(EffortPicker, props, state, { defaultModelId: "muse-spark-1.3", effort: "none" }), /aria-label="Reasoning effort: Minimal"/);
  });

  it("follows the open thread's model, not the saved default", () => {
    const state: Partial<AppState> = { ...lists([SPARK_12, SPARK], catalog("providerCatalog")), sessions: { s1: { ...SESSION, modelId: "muse-spark-1.2" } } };
    const html = render(EffortPicker, { sessionId: "s1", cwd: "/work/lantern", side: "top" }, state, { defaultModelId: "muse-spark-1.3", effort: "max" });
    assert.match(html, /aria-label="Reasoning effort: Extra high"/);
  });

  it("does not lower the level for a model only Muse's built-in list names, which can list fewer levels than the plan's", () => {
    const row = model("muse-spark-1.3", { isDefault: true, efforts: ["minimal", "low", "medium", "high", "xhigh"] });
    const props = { sessionId: null, cwd: null, side: "top" as const };
    const built = lists([row], catalog("bundledCatalog"));
    assert.match(render(EffortPicker, props, built, { effort: "max" }), /aria-label="Reasoning effort: Max"/);
    assert.match(render(EffortPicker, props, built, { effort: "none" }), /aria-label="Reasoning effort: Off"/);
    const onThread: Partial<AppState> = {
      sessions: { s1: { ...SESSION, modelId: "muse-spark-1.3" } },
      models: [row],
      accountModels: { default: [row], "thread:s1": [row] },
      modelsStatus: { default: ready(catalog("bundledCatalog")), "thread:s1": ready(catalog("bundledCatalog")) },
    };
    assert.match(render(EffortPicker, { ...props, sessionId: "s1" }, onThread, { effort: "max" }), /aria-label="Reasoning effort: Max"/);
    // The same row from the plan's own list is believed.
    assert.match(render(EffortPicker, props, lists([row], catalog("providerCatalog")), { effort: "max" }), /aria-label="Reasoning effort: Extra high"/);
  });
});

describe("the model setting in Settings", () => {
  const effortRow = (html: string) => html.slice(html.indexOf("Reasoning effort"), html.indexOf("Accounts"));
  const pressed = (html: string, label: string) => new RegExp(`aria-pressed="true"[^>]*>${label.replace(/[()]/g, "\\$&")}<`).test(html);

  it("puts Muse default first, selected for no saved default, then the list in the host's order", () => {
    const html = render(SettingsPage, {}, lists([WONDER, SPARK], catalog("providerCatalog")));
    const at = (label: string) => html.indexOf(`>${label}</button>`);
    assert.ok(at("Muse default") > 0 && at("Muse default") < at("muse-wonder-1.0"));
    assert.ok(at("muse-wonder-1.0") < at("muse-spark-1.3"));
    assert.ok(pressed(html, "Muse default"));
    assert.ok(!pressed(html, "muse-spark-1.3"));
  });

  it("selects the saved default, and shows one the plan's list lacks as unavailable", () => {
    const state = lists([SPARK], catalog("providerCatalog"));
    assert.ok(pressed(render(SettingsPage, {}, state, { defaultModelId: "muse-spark-1.3" }), "muse-spark-1.3"));
    const html = render(SettingsPage, {}, state, { defaultModelId: "muse-wonder-1.0" });
    assert.ok(pressed(html, "muse-wonder-1.0 (unavailable)"));
    assert.ok(!pressed(html, "Muse default"));
  });

  it("tags a Contributor model in its label, since its twin shares the name", () => {
    const html = render(SettingsPage, {}, lists([model("muse-spark-1.3"), model("muse-spark-1.3-contributor")], catalog("providerCatalog")));
    assert.match(html, /muse-spark-1\.3<\/button>/);
    assert.match(html, /muse-spark-1\.3 · Contributor<\/button>/);
  });

  it("says the list is loading, or why it failed, with a Retry, and still offers Muse default", () => {
    const loading = render(SettingsPage, {}, { models: [], accountModels: { default: [] }, modelsStatus: { default: LOADING } });
    assert.match(loading, /Loading models/);
    assert.doesNotMatch(loading, />Muse default<\/button>/, "nothing to pick between while the first load runs");
    const broken = render(SettingsPage, {}, { models: [], accountModels: { default: [] }, modelsStatus: { default: failed("Could not start Muse") } });
    assert.match(broken, /Could not load models: Could not start Muse/);
    assert.match(broken, /Retry/);
    assert.ok(pressed(broken, "Muse default"));
    const none = render(SettingsPage, {}, lists([], catalog("providerCatalog")));
    assert.match(none, /Muse listed no models\. Refresh to ask again\./);
    assert.match(none, /Refresh models/);
  });

  it("names the host and points at the likeliest reason a model is missing, and takes a model id Muse did not list", () => {
    const html = render(SettingsPage, {}, lists([SPARK], catalog("providerCatalog")));
    assert.match(html, /Muse 1\.4\.7\. Missing a model\? Update Muse, restart it and refresh\./);
    assert.match(html, /Other model id/);
    assert.match(html, /Use model/);
    assert.match(html, /Refresh models/);
  });

  it("says a built-in list is not the plan's, offers the published models, and does not judge the saved one", () => {
    const html = render(SettingsPage, {}, lists([SPARK], catalog("bundledCatalog")), { defaultModelId: "muse-wonder-1.0" });
    assert.match(html, /Muse sent its built-in model list, not your plan&#x27;s\. Other models may still work: pick one below or type a model id\./);
    assert.match(html, /Built-in model list\. Refresh, or update and restart Muse, to load your plan&#x27;s\./);
    assert.doesNotMatch(html, /Offline/);
    assert.doesNotMatch(html, /Missing a model\?/);
    assert.ok(pressed(html, "muse-wonder-1.0"), "the saved model is shown as it is, never as unavailable");
    assert.doesNotMatch(html, /\(unavailable\)/);
    assert.match(html, /muse-spark-1\.2<\/button>/, "a published model the list lacks is a button");
  });

  it("filters the default reasoning effort by the model new threads start on, and says when the choice gives way", () => {
    const state = lists([SPARK_12, SPARK], catalog("providerCatalog"));
    const old = effortRow(render(SettingsPage, {}, state, { defaultModelId: "muse-spark-1.2", effort: "max" }));
    assert.doesNotMatch(old, />Max<\/button>/);
    assert.doesNotMatch(old, />Off<\/button>/);
    assert.match(old, />Extra high<\/button>/);
    assert.ok(pressed(old, "Extra high"));
    assert.match(old, /Max is not available on muse-spark-1\.2\. It runs at Extra high, and your choice is kept for other models\./);
    const current = effortRow(render(SettingsPage, {}, state, { defaultModelId: "muse-spark-1.3", effort: "max" }));
    assert.match(current, />Max<\/button>/);
    assert.ok(pressed(current, "Max"));
    assert.doesNotMatch(current, /is not available/);
    const unknown = effortRow(render(SettingsPage, {}, lists([model("x", { isDefault: true })], catalog("providerCatalog")), { effort: "none" }));
    assert.match(unknown, />Off<\/button>/, "a model that lists no levels keeps them all");
  });

  it("keeps every reasoning level when the list is only Muse's built-in one, since it can list fewer than the plan's", () => {
    const row = model("muse-spark-1.3", { isDefault: true, efforts: ["minimal", "low", "medium", "high", "xhigh"] });
    const built = effortRow(render(SettingsPage, {}, lists([row], catalog("bundledCatalog")), { defaultModelId: "muse-spark-1.3", effort: "max" }));
    assert.match(built, />Max<\/button>/);
    assert.match(built, />Off<\/button>/);
    assert.ok(pressed(built, "Max"));
    assert.doesNotMatch(built, /is not available/);
    const plan = effortRow(render(SettingsPage, {}, lists([row], catalog("providerCatalog")), { defaultModelId: "muse-spark-1.3", effort: "max" }));
    assert.doesNotMatch(plan, />Max<\/button>/, "the same row from the plan's own list is believed");
  });
});
