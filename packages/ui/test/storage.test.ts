import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { browserPlatform, loadDraft, saveDraft } from "../src/model/controller.js";
import { newEntries } from "../src/model/changelog.js";
import { defaultPrefs, revivePrefs } from "../src/model/store.js";

function setupInMemoryStorage(): {
  storeMap: Map<string, string>;
  mockStorageApi: Storage;
} {
  const storeMap = new Map<string, string>();
  const mockStorageApi = {
    length: 0,
    clear() {
      storeMap.clear();
    },
    getItem(key: string): string | null {
      return storeMap.get(key) ?? null;
    },
    key(index: number): string | null {
      return Array.from(storeMap.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      storeMap.delete(key);
    },
    setItem(key: string, val: string): void {
      storeMap.set(key, String(val));
    },
  };
  return { storeMap, mockStorageApi };
}

const globalScope = globalThis as { window?: unknown };
let memoryStoreMap: Map<string, string>;
let originalWindowGlobal: unknown;

beforeEach(() => {
  originalWindowGlobal = globalScope.window;
  const { storeMap, mockStorageApi } = setupInMemoryStorage();
  memoryStoreMap = storeMap;
  globalScope.window = { localStorage: mockStorageApi };
});

afterEach(() => {
  if (originalWindowGlobal === undefined) {
    delete globalScope.window;
  } else {
    globalScope.window = originalWindowGlobal;
  }
});

describe("Browser Preferences Persistence Contract", () => {
  it("serializes preferences to localStorage under key ancilla.prefs.v1", () => {
    const platformAdapter = browserPlatform();
    const customUserPrefs = {
      ...defaultPrefs(),
      theme: "dark" as const,
      zoom: 1.1,
    };

    platformAdapter.savePrefs(customUserPrefs);
    const restoredPrefs = platformAdapter.loadPrefs();
    assert.deepStrictEqual(restoredPrefs, customUserPrefs);

    const serializedJson = memoryStoreMap.get("ancilla.prefs.v1");
    assert.ok(serializedJson !== undefined);
    const parsedPayload = JSON.parse(serializedJson) as { theme?: string; zoom?: number };
    assert.strictEqual(parsedPayload.theme, "dark");
    assert.strictEqual(parsedPayload.zoom, 1.1);
  });

  it("restores previously recorded version and calculates new release notes", () => {
    memoryStoreMap.set("ancilla.prefs.v1", JSON.stringify({ lastSeenVersion: "0.20.0" }));
    const loadedRaw = browserPlatform().loadPrefs();
    const revivedSettings = revivePrefs(loadedRaw, defaultPrefs());

    assert.strictEqual(revivedSettings.lastSeenVersion, "0.20.0");
    const changelogList = [
      { version: "0.20.1", body: "An Ancilla update." },
      { version: "0.20.0", body: "The baseline version." },
    ];
    const unreadEntries = newEntries(revivedSettings.lastSeenVersion, "0.20.1", changelogList);
    assert.deepStrictEqual(unreadEntries, [{ version: "0.20.1", body: "An Ancilla update." }]);
  });

  it("fails safely and returns fallback null when storage access throws security error", () => {
    globalScope.window = {
      localStorage: {
        getItem: () => {
          throw new Error("QuotaExceededError or security policy denial");
        },
        setItem: () => {
          throw new Error("SecurityError: access denied");
        },
        removeItem: () => {
          throw new Error("SecurityError: access denied");
        },
      },
    };

    const deniedPlatform = browserPlatform();
    assert.strictEqual(deniedPlatform.loadPrefs(), null);
    assert.strictEqual(loadDraft("session-err"), "");
    assert.doesNotThrow(() => saveDraft("session-err", "pending input"));
  });
});

describe("Composer Draft Message Persistence Contract", () => {
  it("persists active draft messages in localStorage partitioned by session identifier", () => {
    saveDraft("session-alpha", "work in progress");
    const storedText = memoryStoreMap.get("ancilla.draft.session-alpha");
    assert.strictEqual(storedText, "work in progress");

    const reloadedDraft = loadDraft("session-alpha");
    assert.strictEqual(reloadedDraft, "work in progress");
  });

  it("purges draft storage entry when message content is cleared with empty string", () => {
    saveDraft("session-beta", "temporary thoughts");
    assert.strictEqual(memoryStoreMap.get("ancilla.draft.session-beta"), "temporary thoughts");

    saveDraft("session-beta", "");
    assert.strictEqual(memoryStoreMap.has("ancilla.draft.session-beta"), false);
    assert.strictEqual(loadDraft("session-beta"), "");
  });
});
