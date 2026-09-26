import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { swarmShortcut, windowTitle, type ShortcutKey } from "../src/app/swarm-shortcuts.js";
import { windowTitleCount } from "../src/model/swarm.js";
import { LIVE, appState, approvalEvents, fold, runEvents, session, thread } from "./swarm-fixtures.js";

function key(k: string, extra: Partial<ShortcutKey> = {}): ShortcutKey {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra };
}

describe("swarm shortcuts", () => {
  it("opens the Activity drawer on Ctrl+Shift+A and the Swarm panel on Ctrl+Shift+M, Cmd on a Mac", () => {
    assert.equal(swarmShortcut(key("A", { ctrlKey: true, shiftKey: true }), false), "activity");
    assert.equal(swarmShortcut(key("a", { ctrlKey: true, shiftKey: true }), false), "activity");
    assert.equal(swarmShortcut(key("M", { ctrlKey: true, shiftKey: true }), false), "swarm");
    assert.equal(swarmShortcut(key("A", { metaKey: true, shiftKey: true }), true), "activity");
    assert.equal(swarmShortcut(key("M", { metaKey: true, shiftKey: true }), true), "swarm");
    assert.equal(swarmShortcut(key("A", { ctrlKey: true, shiftKey: true }), true), null, "Ctrl is not the Mac's modifier");
    assert.equal(swarmShortcut(key("A", { metaKey: true, shiftKey: true }), false), null);
  });

  it("needs both the modifier and Shift, and never Alt", () => {
    assert.equal(swarmShortcut(key("a", { ctrlKey: true }), false), null);
    assert.equal(swarmShortcut(key("A", { shiftKey: true }), false), null);
    assert.equal(swarmShortcut(key("A", { ctrlKey: true, shiftKey: true, altKey: true }), false), null);
    assert.equal(swarmShortcut(key("B", { ctrlKey: true, shiftKey: true }), false), null);
  });

  it("stays out of text fields", () => {
    for (const tagName of ["INPUT", "TEXTAREA"]) {
      assert.equal(swarmShortcut(key("A", { ctrlKey: true, shiftKey: true, target: { tagName } as unknown as EventTarget }), false), null, tagName);
    }
    assert.equal(swarmShortcut(key("M", { ctrlKey: true, shiftKey: true, target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget }), false), null);
    assert.equal(swarmShortcut(key("M", { ctrlKey: true, shiftKey: true, target: { tagName: "DIV", isContentEditable: false } as unknown as EventTarget }), false), "swarm");
  });
});

describe("window title", () => {
  it("names the open thread, with the requests waiting anywhere in front, and the app alone elsewhere", () => {
    assert.equal(windowTitle(0, "Design the offline sync engine"), "Design the offline sync engine — Ancilla");
    assert.equal(windowTitle(2, "Design the offline sync engine"), "(2) Design the offline sync engine — Ancilla");
    assert.equal(windowTitle(0, null), "Ancilla");
    assert.equal(windowTitle(1, null), "(1) Ancilla");
    assert.equal(windowTitle(0, "  "), "Ancilla");
  });

  it("counts a folded thread's requests from its fold and the others from the server", () => {
    const state = appState({
      sessions: {
        s1: session("s1", "Design the offline sync engine"),
        s2: session("s2", "Migrate auth to passkeys", { live: { ...LIVE, activeTurnId: null, pendingInputs: 1, pendingApprovals: 1 } }),
      },
      threads: { s1: thread(fold([...runEvents(), ...approvalEvents()])) },
    });
    assert.equal(windowTitleCount(state), 3);
    assert.equal(windowTitleCount(appState()), 0);
  });
});
