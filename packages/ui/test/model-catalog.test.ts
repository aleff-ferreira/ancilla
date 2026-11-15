import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRIBUTOR_NOTE,
  activeModel,
  applyModelChoice,
  effectiveEffort,
  effortLabel,
  effortView,
  isLimitedCatalog,
  isModelId,
  isPlanCatalog,
  isStale,
  modelChoices,
  modelTrigger,
  modelsNeedSignIn,
  trustedModel,
} from "../src/model/models.js";
import type { ModelCatalogInfo, ModelOption, ModelsStatus, ReasoningEffort } from "../src/types.js";

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

function catalog(source: string | null): ModelCatalogInfo {
  return { source, providerId: "meta", profileId: "default", hostVersion: "1.4.7" };
}

function ready(info: ModelCatalogInfo | null, loadedAt = 1_000): ModelsStatus {
  return { status: "ready", error: null, loadedAt, catalog: info };
}

describe("which list is Muse's own", () => {
  it("calls only the provider catalog the plan's list", () => {
    assert.equal(isPlanCatalog(catalog("providerCatalog")), true);
    for (const source of ["bundledCatalog", "configCatalog", "fake", "unresolved", null]) {
      assert.equal(isPlanCatalog(catalog(source)), false, String(source));
    }
    assert.equal(isPlanCatalog(null), false);
    assert.equal(isPlanCatalog(undefined), false);
  });

  it("calls a list limited when its source is known and is anything else", () => {
    assert.equal(isLimitedCatalog(catalog("bundledCatalog")), true);
    assert.equal(isLimitedCatalog(catalog("configCatalog")), true);
    assert.equal(isLimitedCatalog(catalog("something new")), true);
    assert.equal(isLimitedCatalog(catalog("providerCatalog")), false);
    assert.equal(isLimitedCatalog(catalog(null)), false, "a list that does not say where it came from is not judged");
    assert.equal(isLimitedCatalog(null), false);
  });

  it("never leaves a limited list fresh, however young", () => {
    assert.equal(isStale(ready(catalog("providerCatalog")), 2_000, [model("a")]), false);
    assert.equal(isStale(ready(catalog("bundledCatalog")), 2_000, [model("a")]), true);
    assert.equal(isStale(ready(null), 2_000, [model("a")]), false, "an unknown source is judged by age alone");
  });
});

describe("accounts and ids", () => {
  it("asks for a sign-in only for a named account known to have none", () => {
    const accounts = [
      { id: "work", hasLogin: false },
      { id: "home", hasLogin: true },
    ];
    assert.equal(modelsNeedSignIn(accounts, "work"), true);
    assert.equal(modelsNeedSignIn(accounts, "home"), false);
    assert.equal(modelsNeedSignIn(accounts, "other"), false, "an account not listed is asked, not assumed signed out");
    assert.equal(modelsNeedSignIn(accounts, null), false, "the default login is always asked");
    assert.equal(modelsNeedSignIn(null, "work"), false, "accounts not read yet say nothing");
  });

  it("recognises what a typed model id looks like", () => {
    for (const id of ["muse-wonder-1.0", "muse-spark-1.3-contributor", "a", "provider:model_2", "X9"]) {
      assert.equal(isModelId(id), true, id);
    }
    for (const id of ["", "-leading", "has space", "bad!", "trailing ", ".dot", "a".repeat(101)]) {
      assert.equal(isModelId(id), false, id);
    }
    assert.equal(isModelId("a".repeat(100)), true);
  });

  it("reads each level as the slider does", () => {
    assert.deepEqual(
      (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const).map(effortLabel),
      ["Off", "Minimal", "Low", "Medium", "High", "Extra high", "Max", "Max"],
    );
  });
});

describe("the row that vouches for a model's reasoning levels", () => {
  const FULL: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const NO_MAX: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
  const plan = model("muse-spark-1.3", { efforts: FULL });
  const built = model("muse-spark-1.3", { efforts: NO_MAX });

  it("believes the plan's own list, and a list that does not say where it came from", () => {
    for (const info of [catalog("providerCatalog"), catalog(null), null]) {
      const state = { models: [plan], accountModels: { default: [plan] }, modelsStatus: { default: ready(info) } };
      assert.equal(trustedModel(state, "default", "muse-spark-1.3"), plan);
    }
  });

  it("passes over a list Muse built in, so it never narrows the levels, and offers every one for a model only it names", () => {
    const state = { models: [built], accountModels: { default: [built] }, modelsStatus: { default: ready(catalog("bundledCatalog")) } };
    assert.equal(trustedModel(state, "default", "muse-spark-1.3"), undefined);
    assert.equal(effectiveEffort("max", trustedModel(state, "default", "muse-spark-1.3")), "max", "a turn on it keeps the level asked for");
    assert.equal(effortView(trustedModel(state, "default", "muse-spark-1.3"), "max", [{ value: "none" as const }, { value: "max" as const }]).levels.length, 2);
    for (const limited of ["configCatalog", "fake", "unresolved", "something new"]) {
      const other = { ...state, modelsStatus: { default: ready(catalog(limited)) } };
      assert.equal(trustedModel(other, "default", "muse-spark-1.3"), undefined, limited);
    }
  });

  it("looks in the scope asked for first, then in every other list that is the plan's", () => {
    const state = {
      models: [built, plan],
      accountModels: { default: [built], "acct:work": [plan], "thread:s1": [built] },
      modelsStatus: {
        default: ready(catalog("bundledCatalog")),
        "acct:work": ready(catalog("providerCatalog")),
        "thread:s1": ready(catalog("bundledCatalog")),
      },
    };
    // The thread's own list is built in, so the account's plan list that also names the model answers for it.
    assert.equal(trustedModel(state, "thread:s1", "muse-spark-1.3"), plan);
    assert.equal(trustedModel(state, { sessionId: "s1" }, "muse-spark-1.3"), plan);
    const both = { ...state, accountModels: { ...state.accountModels, default: [model("muse-spark-1.3", { efforts: ["low"] })] }, modelsStatus: { ...state.modelsStatus, default: ready(catalog("providerCatalog")) } };
    assert.deepEqual(trustedModel(both, "default", "muse-spark-1.3")?.efforts, ["low"], "the scope asked for wins");
    assert.equal(trustedModel(both, "acct:work", "muse-spark-1.3"), plan);
    assert.equal(trustedModel(state, "default", "unknown-model"), undefined);
    assert.equal(trustedModel(state, "default", null), undefined);
  });

  it("falls back to the union of lists for a state that has no list filed under the default scope", () => {
    const state = { models: [plan], accountModels: {}, modelsStatus: {} };
    assert.equal(trustedModel(state, "default", "muse-spark-1.3"), plan);
  });

  it("is what a composer reads its levels from", () => {
    const named = model("muse-spark-1.3", { efforts: NO_MAX, isDefault: true });
    const state = { models: [named], accountModels: { default: [named] }, modelsStatus: { default: ready(catalog("bundledCatalog")) } };
    assert.equal(activeModel(state, {}, null, "muse-spark-1.3"), undefined);
    assert.equal(activeModel(state, {}, null, null), undefined, "the list's own default is named from the list, but its levels are not believed");
    const planState = { models: [plan], accountModels: { default: [plan] }, modelsStatus: { default: ready(catalog("providerCatalog")) } };
    assert.equal(activeModel(planState, {}, "muse-spark-1.3", null), plan);
  });
});

describe("choosing a row", () => {
  function target() {
    const calls: string[] = [];
    return {
      calls,
      clearModelPref: () => void calls.push("clear"),
      setModel: (modelId: string) => void calls.push(`set:${modelId}`),
    };
  }

  it("clears the saved model for Muse default, whether the control says it as an empty value or as null", () => {
    for (const value of ["", null]) {
      const fake = target();
      applyModelChoice(fake, value);
      assert.deepEqual(fake.calls, ["clear"], String(value));
    }
  });

  it("switches to any other value as the model it names, and never asks for a model with no id", () => {
    const fake = target();
    applyModelChoice(fake, "muse-wonder-1.0");
    applyModelChoice(fake, "muse-spark-1.3-contributor");
    assert.deepEqual(fake.calls, ["set:muse-wonder-1.0", "set:muse-spark-1.3-contributor"]);
  });
});

describe("the Muse default row on a thread", () => {
  const list = [model("muse-spark-1.3-contributor", { isDefault: true, description: "Used for product improvement." }), model("muse-wonder-1.0")];

  it("says it sets what new threads follow, since it switches nothing on the thread", () => {
    assert.equal(modelChoices(list, "muse-wonder-1.0", null)[0]?.description, `New threads follow Muse's default, currently muse-spark-1.3, a Contributor model. ${CONTRIBUTOR_NOTE}`);
    assert.equal(modelChoices([model("muse-spark-1.3", { isDefault: true })], "muse-spark-1.3", null)[0]?.description, "New threads follow Muse's default, currently muse-spark-1.3");
    assert.equal(modelChoices([model("a")], "a", null)[0]?.description, "New threads follow Muse's default");
  });

  it("still describes it by what it follows on the new-thread screen and in Settings", () => {
    assert.equal(modelChoices(list, null, null)[0]?.description, `Currently muse-spark-1.3, a Contributor model. ${CONTRIBUTOR_NOTE}`);
    assert.equal(modelChoices([model("muse-spark-1.3", { isDefault: true })], null, "muse-spark-1.3")[0]?.description, "Currently muse-spark-1.3");
  });
});

describe("a pinned model against a list that is not judged", () => {
  const list = [model("muse-spark-1.3", { isDefault: true })];

  it("shows the pin without a note when the list is only built in", () => {
    const rows = modelChoices(list, null, "muse-wonder-1.0", false);
    const pin = rows.find((row) => row.kind === "pin");
    assert.equal(pin?.id, "muse-wonder-1.0");
    assert.equal(pin?.selected, true, "the saved choice is still the one shown as chosen");
    assert.equal(pin?.note, null);
    assert.equal(modelChoices(list, "muse-wonder-1.0", null, false).find((row) => row.kind === "pin")?.note, null);
    assert.equal(modelChoices(list, null, "muse-wonder-1.0").find((row) => row.kind === "pin")?.note, "unavailable", "judged by default");
    assert.equal(modelChoices(list, "muse-wonder-1.0", null).find((row) => row.kind === "pin")?.note, "not offered");
  });

  it("reads the trigger without a note, then with one when the list is the plan's", () => {
    assert.equal(modelTrigger(list, null, "muse-wonder-1.0", false).text, "muse-wonder-1.0");
    assert.equal(modelTrigger(list, "muse-wonder-1.0", null, false).text, "muse-wonder-1.0");
    assert.equal(modelTrigger(list, null, "muse-wonder-1.0", true).text, "muse-wonder-1.0 (unavailable)");
    assert.equal(modelTrigger(list, "muse-wonder-1.0", null).text, "muse-wonder-1.0 (not offered)");
  });
});
