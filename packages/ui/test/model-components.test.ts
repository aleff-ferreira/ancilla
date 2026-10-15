import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ModelPicker, slashMenuFor } from "../src/components/composer/Composer.js";
import { SlashMenu } from "../src/components/composer/SlashMenu.js";
import { SettingsPage } from "../src/components/settings/SettingsPage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { formatTokens } from "../src/model/format.js";
import {
  CONTRIBUTOR_NOTE,
  MODEL_COPY,
  knownModels,
  modelButtonLabel,
  modelCompletionNote,
  modelCompletions,
  modelMenu,
  modelPickLine,
  modelStub,
  modelTrigger,
  type ModelMenuOptions,
  type ModelMenuSource,
} from "../src/model/models.js";
import { slashCommands } from "../src/model/slash.js";
import { defaultPrefs, initialState, Store, type AppState, type Prefs } from "../src/model/store.js";
import type { ModelCatalogInfo, ModelOption, ModelsStatus } from "../src/types.js";
import { SESSION } from "./fixtures/lantern.js";
import { LIVE_1_4_0, LIVE_1_4_7 } from "./fixtures/picker-catalogs.js";

const model = (modelId: string, extra: Partial<ModelOption> = {}): ModelOption => modelStub(modelId, extra);

const SPARK = model("muse-spark-1.3", { isDefault: true, contextLimit: 1_000_000 });
const WONDER = model("muse-wonder-1.0", { contextLimit: 1_048_576 });
const PLAN = "providerCatalog";
const BUILT_IN = "bundledCatalog";

function catalog(source: string | null): ModelCatalogInfo {
  return { source, providerId: "meta", profileId: "tbh", hostVersion: "1.4.7" };
}

function ready(info: ModelCatalogInfo | null): ModelsStatus {
  return { status: "ready", error: null, loadedAt: 1_000, catalog: info };
}

type Held = Pick<AppState, "models" | "accountModels" | "modelsStatus">;

/** The lists filed under their scopes, with the union `models` built the way the controller builds it. */
function listed(lists: Record<string, ModelOption[]>, sources: Record<string, string>): Held {
  const modelsStatus = Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, ready(catalog(source))]));
  return { models: knownModels(lists, modelsStatus), accountModels: lists, modelsStatus };
}

function render<P extends object>(Component: ComponentType<P>, props: P, patch: Partial<AppState>, prefs: Partial<Prefs> = {}): string {
  const store = new Store<AppState>({ ...initialState({ ...defaultPrefs("2026-09-28T00:00:00.000Z"), ...prefs }), connection: "open", ...patch });
  const controller = { store, loadAccounts: async () => {} } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(Component, props) }) }));
}

const PICKER = { sessionId: null, cwd: null, side: "top" as const };
const pressed = (html: string, label: string) => new RegExp(`aria-pressed="true"[^>]*>${label.replace(/[()]/g, "\\$&")}<`).test(html);
/** A sentence as the markup spells it: apostrophes are escaped. */
const escaped = (text: string) => text.replace(/'/g, "&#x27;");
/** A sentence set as the text of a paragraph, which is what puts it on screen: a `title` alone does not. */
const visible = (html: string, text: string) => html.includes(`>${escaped(text)}</p>`);

const source = (lists: Record<string, ModelOption[]>, sources: Record<string, string>): ModelMenuSource => ({ ...listed(lists, sources), accounts: null });
const options = (extra: Partial<ModelMenuOptions> = {}): ModelMenuOptions => ({ scope: {}, accountId: null, current: null, pref: null, plan: null, ...extra });

// ---------------------------------------------------------------- the model button (K12)

describe("the model button's accessible name", () => {
  it("names the tier after the model, since the badge beside the name is not read with it", () => {
    const contributor = modelTrigger([SPARK, model("muse-spark-1.3-contributor", { isDefault: false })], "muse-spark-1.3-contributor", null);
    assert.equal(modelButtonLabel(contributor), "Model: muse-spark-1.3, Contributor model");
    assert.equal(modelButtonLabel(modelTrigger([SPARK], null, null)), "Model: muse-spark-1.3");
    const unlisted = modelTrigger([SPARK], null, "retired-contributor");
    assert.equal(modelButtonLabel(unlisted), "Model: retired (unavailable), Contributor model", "the note and the tier both stay");
  });

  it("is what the rendered button carries, for Muse's own Contributor default, a saved one and an open thread's", () => {
    const plan = listed({ default: [...LIVE_1_4_0.models] }, { default: PLAN });
    const own = render(ModelPicker, PICKER, plan);
    assert.match(own, /aria-label="Model: muse-spark-1\.3, Contributor model"/, "the real 1.4.0 list defaults to the Contributor row");
    const saved = render(ModelPicker, PICKER, plan, { defaultModelId: "muse-spark-1.2-contributor" });
    assert.match(saved, /aria-label="Model: muse-spark-1\.2, Contributor model"/);
    const regular = render(ModelPicker, PICKER, plan, { defaultModelId: "muse-spark-1.2" });
    assert.match(regular, /aria-label="Model: muse-spark-1\.2"/);
    const thread: Partial<AppState> = { ...plan, sessions: { s1: { ...SESSION, modelId: "muse-spark-1.3-contributor" } } };
    assert.match(render(ModelPicker, { ...PICKER, sessionId: "s1" }, thread), /aria-label="Model: muse-spark-1\.3, Contributor model"/);
  });
});

describe("a model tried by its id in the composer", () => {
  const plan = listed({ default: [SPARK] }, { default: PLAN });

  it("reads as the model it is, not as unavailable, once it is remembered as tried", () => {
    const untried = render(ModelPicker, PICKER, plan, { defaultModelId: "muse-wonder-1.0" });
    assert.match(untried, /aria-label="Model: muse-wonder-1\.0 \(unavailable\)"/);
    const tried = render(ModelPicker, PICKER, plan, { defaultModelId: "muse-wonder-1.0", defaultModelTried: true });
    assert.match(tried, /aria-label="Model: muse-wonder-1\.0"/);
    assert.doesNotMatch(tried, /unavailable/);
  });
});

// ---------------------------------------------------------------- Settings (K3, K12)

describe("the model setting in Settings agrees with the other lists", () => {
  const SPARK_ONLY = [SPARK];
  const work = { default: SPARK_ONLY, "acct:work": [WONDER, SPARK] };

  it("never calls a saved model unavailable when another account's list offers it, and says whose it is", () => {
    const state = listed(work, { default: PLAN, "acct:work": PLAN });
    const html = render(SettingsPage, {}, state, { defaultModelId: "muse-wonder-1.0" });
    assert.ok(pressed(html, "muse-wonder-1.0"), "the saved model is selected, with no note on its name");
    assert.doesNotMatch(html, /unavailable|not offered/i);
    assert.ok(visible(html, MODEL_COPY.elsewhere), "the caption is a line on the page, not only a hover");
    assert.equal(MODEL_COPY.elsewhere, "Offered by another account");
  });

  it("still calls it unavailable when no loaded list has it, with the reason in view", () => {
    const html = render(SettingsPage, {}, listed({ default: SPARK_ONLY }, { default: PLAN }), { defaultModelId: "muse-wonder-1.0" });
    assert.ok(pressed(html, "muse-wonder-1.0 (unavailable)"));
    assert.ok(visible(html, MODEL_COPY.notListed));
    assert.doesNotMatch(html, new RegExp(MODEL_COPY.elsewhere));
  });

  it("keeps a model tried by its id, and says it was tried rather than that it is unavailable", () => {
    const html = render(SettingsPage, {}, listed({ default: SPARK_ONLY }, { default: PLAN }), { defaultModelId: "muse-wonder-1.0", defaultModelTried: true });
    assert.ok(pressed(html, "muse-wonder-1.0"));
    assert.doesNotMatch(html, /unavailable/);
    assert.ok(visible(html, MODEL_COPY.notListed));
  });

  it("does not judge a model against a built-in list, and says the list does not name it", () => {
    const html = render(SettingsPage, {}, listed({ default: [...LIVE_1_4_7.models] }, { default: BUILT_IN }), { defaultModelId: "muse-wonder-1.0" });
    assert.ok(pressed(html, "muse-wonder-1.0"));
    assert.doesNotMatch(html, /unavailable/);
    assert.ok(visible(html, MODEL_COPY.notNamed));
  });

  it("says nothing under a model the list offers", () => {
    const html = render(SettingsPage, {}, listed(work, { default: PLAN, "acct:work": PLAN }), { defaultModelId: "muse-spark-1.3" });
    assert.ok(pressed(html, "muse-spark-1.3"));
    assert.doesNotMatch(html, /Offered by another account|Not in Muse|built-in list does not name/);
    assert.doesNotMatch(html, /Muse default is/);
  });
});

describe("what Muse default is, said on the Settings page", () => {
  it("names a Contributor model with the note about what happens to prompts, in a line anyone can read", () => {
    const html = render(SettingsPage, {}, listed({ default: [...LIVE_1_4_0.models] }, { default: PLAN }));
    assert.ok(pressed(html, "Muse default"));
    assert.ok(visible(html, `Muse default is muse-spark-1.3, a Contributor model. ${CONTRIBUTOR_NOTE}`));
  });

  it("names a regular default plainly, and says nothing when the list names none", () => {
    assert.ok(visible(render(SettingsPage, {}, listed({ default: [SPARK, WONDER] }, { default: PLAN })), "Muse default is muse-spark-1.3"));
    const none = render(SettingsPage, {}, listed({ default: [WONDER] }, { default: PLAN }));
    assert.doesNotMatch(none, /Muse default is/);
  });

  it("is gone once a model is chosen by name", () => {
    const html = render(SettingsPage, {}, listed({ default: [...LIVE_1_4_0.models] }, { default: PLAN }), { defaultModelId: "muse-spark-1.2" });
    assert.doesNotMatch(html, /Muse default is/);
  });
});

describe("the line under a model control", () => {
  const withRows = (menu: ReturnType<typeof modelMenu>) => ({ rows: menu.rows, models: menu.models });

  it("is what Muse default follows, only where the control asks for it", () => {
    const menu = modelMenu(source({ default: [model("muse-spark-1.3-contributor", { isDefault: true })] }, { default: PLAN }), options());
    assert.equal(modelPickLine(withRows(menu), { museDefault: true }), `Muse default is muse-spark-1.3, a Contributor model. ${CONTRIBUTOR_NOTE}`);
    assert.equal(modelPickLine(withRows(menu)), null);
    assert.equal(modelPickLine(withRows(menu), { museDefault: false }), null);
    const plain = modelMenu(source({ default: [SPARK] }, { default: PLAN }), options());
    assert.equal(modelPickLine(withRows(plain), { museDefault: true }), "Muse default is muse-spark-1.3");
    const unnamed = modelMenu(source({ default: [WONDER] }, { default: PLAN }), options());
    assert.equal(modelPickLine(withRows(unnamed), { museDefault: true }), null);
  });

  it("is why a saved model is not among the rows, for each reason, and null for a listed one", () => {
    const line = (lists: Record<string, ModelOption[]>, sources: Record<string, string>, extra: Partial<ModelMenuOptions>) =>
      modelPickLine(withRows(modelMenu(source(lists, sources), options({ pref: "muse-wonder-1.0", ...extra }))));
    const plan = { default: [SPARK] };
    assert.equal(line(plan, { default: PLAN }, {}), MODEL_COPY.notListed);
    assert.equal(line(plan, { default: PLAN }, { tried: true }), MODEL_COPY.notListed);
    assert.equal(line(plan, { default: BUILT_IN }, {}), MODEL_COPY.notNamed);
    assert.equal(line({ ...plan, "acct:work": [WONDER] }, { default: PLAN, "acct:work": PLAN }, { elsewhere: true }), MODEL_COPY.elsewhere);
    assert.equal(line({ ...plan, "acct:work": [WONDER] }, { default: PLAN, "acct:work": PLAN }, {}), MODEL_COPY.notListed, "only a menu that asks for it looks at the other lists");
    assert.equal(line({ default: [SPARK, WONDER] }, { default: PLAN }, {}), null);
  });
});

// ---------------------------------------------------------------- /model completions (K1, K12)

describe("the /model completions on a built-in list", () => {
  const commands = slashCommands([], { inThread: true });
  const built = [...LIVE_1_4_7.models];
  const menuFor = (text: string, limited: boolean) => slashMenuFor(text, text.length, commands, undefined, built, limited);
  const ids = (view: ReturnType<typeof menuFor>) => (view?.kind === "models" ? view.items.map((item) => item.id) : null);

  it("offers the models Meta publishes after the list's own, and finds Wonder by its name", () => {
    assert.deepEqual(ids(menuFor("/model ", true)), ["muse-spark-1.3", "muse-wonder-1.0", "muse-spark-1.2"]);
    assert.deepEqual(ids(menuFor("/model wonder", true)), ["muse-wonder-1.0"]);
    assert.deepEqual(ids(menuFor("/model spark", true)), ["muse-spark-1.3", "muse-spark-1.2"]);
  });

  it("offers only the list's own while the list is the plan's", () => {
    assert.deepEqual(ids(menuFor("/model ", false)), ["muse-spark-1.3"]);
    assert.equal(menuFor("/model wonder", false), null);
  });

  it("marks a published model as a try, and never a listed one", () => {
    const view = menuFor("/model ", true);
    const items = view?.kind === "models" ? view.items : [];
    assert.deepEqual(items.map((item) => item.published), [false, true, true]);
    assert.equal(modelCompletionNote(items[0] as (typeof items)[number]), null);
    assert.equal(modelCompletionNote(items[1] as (typeof items)[number]), MODEL_COPY.notListed);
  });
});

describe("the /model completion rows", () => {
  const noop = () => {};
  const rows = (items: ReturnType<typeof modelCompletions>) =>
    renderToStaticMarkup(
      createElement(SlashMenu, { id: "m", state: { kind: "models", items, query: "" }, placement: "above", active: 0, onActive: noop, onPick: noop, onPickModel: noop, onSendRaw: noop }),
    );
  const twins = [
    model("muse-spark-1.3", { contextLimit: 1_007_997 }),
    model("muse-spark-1.3-contributor", { isDefault: true, contextLimit: 1_007_997 }),
  ];

  const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

  it("keeps the id's room and gives the context window up first on a narrow menu, with both badges kept", () => {
    const html = rows(modelCompletions(twins, ""));
    assert.match(html, /^<div id="m" role="listbox"[^>]*class="@container /, "the menu measures itself, so a narrow composer is a narrow menu whatever the window is");
    assert.equal(count(html, /<span class="min-w-0 truncate font-medium">muse-spark-1\.3<\/span>/g), 2, "the id is what is being chosen: it is the one that truncates, and last");
    const detail = `${formatTokens(1_007_997)} token context`;
    assert.equal(count(html, new RegExp(`class="shrink-0 text-xs text-muted @max-\\[440px\\]:hidden">${detail}</span>`, "g")), 2, "the window hides below a narrow menu");
    assert.equal(count(html, />Default<\/span>/g), 1, "the Default badge stays");
    assert.equal(count(html, />Contributor<\/span>/g), 1, "the Contributor badge stays");
  });

  it("says under a published model that it is only a try, and says nothing under a listed one", () => {
    const html = rows(modelCompletions([model("muse-spark-1.3", { isDefault: true })], "", undefined, true));
    const note = escaped(MODEL_COPY.notListed);
    assert.equal(html.split(note).length - 1, 2, "once under Wonder, once under Spark 1.2, none under the listed row");
    assert.ok(html.indexOf(note) > html.indexOf("muse-wonder-1.0"), "the first note belongs to the first published row, after the listed one");
    assert.equal(html.split(note).length - 1, count(html, /Not in Muse/g));
  });
});
