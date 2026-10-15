import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slashMenuOver } from "../src/components/composer/Composer.js";
import { knownModels, tryTypedModel } from "../src/model/models.js";
import { slashCommands } from "../src/model/slash.js";
import type { ModelCatalogInfo, ModelOption, ModelsStatus } from "../src/types.js";
import { LIVE_1_4_0, LIVE_1_4_7 } from "./fixtures/picker-catalogs.js";

// The fixes of the merged-tree review's second round that are pure: what a typed id is handed over as, and what the
// composer completes `/model` against.

function catalog(source: string | null): ModelCatalogInfo {
  return { source, providerId: "meta", profileId: "tbh", hostVersion: "1.4.7" };
}

function ready(source: string): ModelsStatus {
  return { status: "ready", error: null, loadedAt: 1_000, catalog: catalog(source) };
}

const failed: ModelsStatus = { status: "error", error: "Muse could not start", loadedAt: null, catalog: null };

/** The lists filed under their scopes, with the union `models` built the way the controller builds it. */
function held(lists: Record<string, ModelOption[]>, statuses: Record<string, ModelsStatus>) {
  return { models: knownModels(lists, statuses), accountModels: lists, modelsStatus: statuses };
}

describe("a model id typed by hand", () => {
  it("is handed to the controller as typed text, which an empty list cannot vouch for", async () => {
    const calls: { id: string; options: unknown }[] = [];
    const target = {
      async setModel(id: string, options: { typed: true }) {
        calls.push({ id, options });
        return true;
      },
    };
    assert.equal(await tryTypedModel(target, "muse-wonder-2.0"), true);
    assert.deepEqual(calls, [{ id: "muse-wonder-2.0", options: { typed: true } }]);
  });

  it("says whether the choice took", async () => {
    assert.equal(await tryTypedModel({ setModel: async () => false }, "muse-wonder-2.0"), false);
  });
});

describe("the slash menu over a scope's model catalog", () => {
  const commands = slashCommands([], { inThread: true });
  const completed = (text: string, state: ReturnType<typeof held>, scope: Parameters<typeof slashMenuOver>[5]) => {
    const view = slashMenuOver(text, text.length, commands, undefined, state, scope);
    return view?.kind === "models" ? view.items.map((item) => item.id) : null;
  };
  const builtIn = held({ default: [...LIVE_1_4_7.models] }, { default: ready("bundledCatalog") });

  it("completes a name against the models Meta publishes while the list on show is Muse's built-in one", () => {
    assert.deepEqual(completed("/model wonder", builtIn, {}), ["muse-wonder-1.0"]);
    assert.deepEqual(completed("/model ", builtIn, {}), ["muse-spark-1.3", "muse-wonder-1.0", "muse-spark-1.2"]);
  });

  it("completes from the plan's own rows alone", () => {
    const plan = held({ default: [...LIVE_1_4_0.models] }, { default: ready("providerCatalog") });
    assert.equal(completed("/model wonder", plan, {}), null);
    assert.deepEqual(completed("/model spark 1.2", plan, {}), ["muse-spark-1.2"]);
  });

  it("judges the scope on show, not the default login's list", () => {
    const state = held(
      { default: [...LIVE_1_4_7.models], "thread:s1": [...LIVE_1_4_0.models] },
      { default: ready("bundledCatalog"), "thread:s1": ready("providerCatalog") },
    );
    assert.equal(completed("/model wonder", state, { sessionId: "s1" }), null, "the thread's own list is the plan's: it names what it names");
    assert.deepEqual(completed("/model wonder", state, {}), ["muse-wonder-1.0"], "the default login's is a built-in one");
  });

  it("takes a stand-in list's verdict from the default login's catalog", () => {
    const state = held({ default: [...LIVE_1_4_7.models], "acct:work": [] }, { default: ready("bundledCatalog"), "acct:work": failed });
    assert.deepEqual(completed("/model wonder", state, { accountId: "work" }), ["muse-wonder-1.0"]);
  });
});
