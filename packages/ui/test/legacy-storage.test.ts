import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { browserPlatform, loadDraft, saveDraft } from "../src/model/controller.js";
import { newEntries } from "../src/model/changelog.js";
import { defaultPrefs, revivePrefs } from "../src/model/store.js";

/** The slice of `localStorage` the UI touches, kept in memory. */
class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const scope = globalThis as { window?: unknown };
let storage: MemoryStorage;
let previous: unknown;

beforeEach(() => {
  previous = scope.window;
  storage = new MemoryStorage();
  scope.window = { localStorage: storage };
});

afterEach(() => {
  if (previous === undefined) {
    delete scope.window;
  } else {
    scope.window = previous;
  }
});

describe("settings a browser kept for Helicon", () => {
  it("start Ancilla's until it saves its own, and are never written", () => {
    const legacy = JSON.stringify({ theme: "dark", zoom: 1.1 });
    storage.setItem("helicon.prefs.v1", legacy);
    const platform = browserPlatform();
    assert.deepEqual(platform.loadPrefs(), { theme: "dark", zoom: 1.1 });
    platform.savePrefs({ ...defaultPrefs(), theme: "light" });
    assert.equal((JSON.parse(storage.getItem("ancilla.prefs.v1") ?? "{}") as { theme?: string }).theme, "light");
    assert.equal(storage.getItem("helicon.prefs.v1"), legacy, "Helicon's copy stays as it was");
    assert.equal((platform.loadPrefs() as { theme?: string }).theme, "light", "Ancilla's own now wins");
  });

  it("give way to Ancilla's own", () => {
    storage.setItem("helicon.prefs.v1", JSON.stringify({ theme: "dark" }));
    storage.setItem("ancilla.prefs.v1", JSON.stringify({ theme: "light" }));
    assert.deepEqual(browserPlatform().loadPrefs(), { theme: "light" });
  });

  it("do not treat Helicon's last seen release as an Ancilla upgrade on first launch", () => {
    const legacy = JSON.stringify({ theme: "dark", zoom: 1.1, lastSeenVersion: "0.17.1" });
    storage.setItem("helicon.prefs.v1", legacy);
    const platform = browserPlatform();
    const prefs = revivePrefs(platform.loadPrefs(), defaultPrefs());
    assert.equal(prefs.theme, "dark");
    assert.equal(prefs.zoom, 1.1);
    assert.equal(prefs.lastSeenVersion, null);
    assert.deepEqual(newEntries(prefs.lastSeenVersion, "0.20.0"), []);
    assert.equal(storage.getItem("helicon.prefs.v1"), legacy);

    // WhatsNew records the first Ancilla version silently. A restart keeps that baseline even
    // while the older Helicon settings are still present at this origin.
    platform.savePrefs({ ...prefs, lastSeenVersion: "0.20.0" });
    const restarted = revivePrefs(platform.loadPrefs(), defaultPrefs());
    assert.equal(restarted.lastSeenVersion, "0.20.0");
    assert.deepEqual(newEntries(restarted.lastSeenVersion, "0.20.0"), []);
    assert.deepEqual(newEntries(restarted.lastSeenVersion, "0.20.1", [
      { version: "0.20.1", body: "An Ancilla update." },
      { version: "0.20.0", body: "The first version opened." },
    ]), [{ version: "0.20.1", body: "An Ancilla update." }]);
    assert.equal(storage.getItem("helicon.prefs.v1"), legacy);
  });

  it("keep Ancilla's release history for a genuine later upgrade", () => {
    storage.setItem("helicon.prefs.v1", JSON.stringify({ lastSeenVersion: "0.17.1" }));
    storage.setItem("ancilla.prefs.v1", JSON.stringify({ lastSeenVersion: "0.19.2" }));
    const prefs = revivePrefs(browserPlatform().loadPrefs(), defaultPrefs());
    assert.equal(prefs.lastSeenVersion, "0.19.2");
    assert.deepEqual(newEntries(prefs.lastSeenVersion, "0.20.0").map((entry) => entry.version), ["0.20.0"]);
  });

  it("read as nothing when storage is unavailable", () => {
    scope.window = {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
      },
    };
    assert.equal(browserPlatform().loadPrefs(), null);
    assert.equal(loadDraft("s1"), "");
    assert.doesNotThrow(() => saveDraft("s1", "hello"));
  });
});

describe("composer drafts a browser kept for Helicon", () => {
  it("open in Ancilla's composer, and edits land under Ancilla's key", () => {
    storage.setItem("helicon.draft.s1", "half-written prompt");
    assert.equal(loadDraft("s1"), "half-written prompt");
    saveDraft("s1", "half-written prompt, finished");
    assert.equal(storage.getItem("ancilla.draft.s1"), "half-written prompt, finished");
    assert.equal(storage.getItem("helicon.draft.s1"), "half-written prompt");
    assert.equal(loadDraft("s1"), "half-written prompt, finished");
  });

  it("stay gone once cleared, rather than coming back from Helicon's copy", () => {
    storage.setItem("helicon.draft.s1", "sent already");
    saveDraft("s1", "");
    assert.equal(loadDraft("s1"), "");
    assert.equal(storage.getItem("helicon.draft.s1"), "sent already");
  });

  it("leave no entry behind when there was never a Helicon draft", () => {
    saveDraft("s2", "draft");
    saveDraft("s2", "");
    assert.equal(storage.items.has("ancilla.draft.s2"), false);
    assert.equal(loadDraft("s2"), "");
  });
});
