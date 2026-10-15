import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { AncillaStore } from "../src/store.js";

function defaults(store: AncillaStore): Record<string, string | null> {
  return Object.fromEntries(store.listProjects().map((project) => [project.cwd, project.defaultAccountId]));
}

describe("a removed account", () => {
  it("stops being the default of every project that named it, and of no other", () => {
    const store = new AncillaStore();
    after(() => store.close());
    for (const cwd of ["/work/a", "/work/b", "/work/c", "/work/d"]) store.upsertProject(cwd);
    store.setDefaultAccount("/work/a", "work");
    store.setDefaultAccount("/work/b", "work");
    store.setDefaultAccount("/work/c", "other");
    store.clearDefaultAccount("work");
    assert.deepEqual(defaults(store), { "/work/a": null, "/work/b": null, "/work/c": "other", "/work/d": null });
  });

  it("is a no-op when no project names the account", () => {
    const store = new AncillaStore();
    after(() => store.close());
    store.upsertProject("/work/a");
    store.setDefaultAccount("/work/a", "other");
    store.clearDefaultAccount("nobody");
    assert.deepEqual(defaults(store), { "/work/a": "other" });
  });
});
