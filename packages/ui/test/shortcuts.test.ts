import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crewShortcut, windowTitle, type ShortcutKey } from "../src/app/crew-shortcuts.js";
import { windowTitleCount } from "../src/model/crew.js";
import { LIVE, appState, approvalEvents, fold, runEvents, session, thread } from "./crew-fixtures.js";

function buildKeyStroke(
  keyCharacter: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; targetNode?: EventTarget } = {},
): ShortcutKey {
  return {
    key: keyCharacter,
    ctrlKey: modifiers.ctrl ?? false,
    metaKey: modifiers.meta ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
    target: modifiers.targetNode,
  };
}

describe("crewShortcut - Global Keyboard Shortcuts", () => {
  it("routes platform chords: Ctrl+Shift on Windows/Linux and Cmd+Shift on macOS", () => {
    // Windows / Linux environments
    const pcActivityKey = buildKeyStroke("A", { ctrl: true, shift: true });
    assert.strictEqual(crewShortcut(pcActivityKey, false), "activity");

    const pcActivityLower = buildKeyStroke("a", { ctrl: true, shift: true });
    assert.strictEqual(crewShortcut(pcActivityLower, false), "activity");

    const pcCrewKey = buildKeyStroke("M", { ctrl: true, shift: true });
    assert.strictEqual(crewShortcut(pcCrewKey, false), "crew");

    const pcBrowserKey = buildKeyStroke("B", { ctrl: true, shift: true });
    assert.strictEqual(crewShortcut(pcBrowserKey, false), "browser");

    // macOS environments
    const macActivityKey = buildKeyStroke("A", { meta: true, shift: true });
    assert.strictEqual(crewShortcut(macActivityKey, true), "activity");

    const macCrewKey = buildKeyStroke("M", { meta: true, shift: true });
    assert.strictEqual(crewShortcut(macCrewKey, true), "crew");

    const macBrowserKey = buildKeyStroke("B", { meta: true, shift: true });
    assert.strictEqual(crewShortcut(macBrowserKey, true), "browser");

    // Cross-platform negative cases
    assert.strictEqual(crewShortcut(pcActivityKey, true), null, "Ctrl chord should not activate on macOS");
    assert.strictEqual(crewShortcut(macActivityKey, false), null, "Cmd chord should not activate on Windows");
  });

  it("enforces concurrent Shift modifier and ignores combinations with Alt or unmapped keys", () => {
    const missingShift = buildKeyStroke("a", { ctrl: true });
    assert.strictEqual(crewShortcut(missingShift, false), null);

    const missingPrimaryMod = buildKeyStroke("A", { shift: true });
    assert.strictEqual(crewShortcut(missingPrimaryMod, false), null);

    const altPolluted = buildKeyStroke("A", { ctrl: true, shift: true, alt: true });
    assert.strictEqual(crewShortcut(altPolluted, false), null);

    const unmappedKey = buildKeyStroke("Q", { ctrl: true, shift: true });
    assert.strictEqual(crewShortcut(unmappedKey, false), null);
  });

  it("disables shortcut execution when active focus resides within text inputs", () => {
    const editableTags = ["INPUT", "TEXTAREA"];
    for (const tag of editableTags) {
      const formInputTarget = { tagName: tag } as unknown as EventTarget;
      const stroke = buildKeyStroke("A", { ctrl: true, shift: true, targetNode: formInputTarget });
      assert.strictEqual(crewShortcut(stroke, false), null, `Should suppress shortcut inside <${tag}>`);
    }

    const richTextTarget = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
    const richTextStroke = buildKeyStroke("M", { ctrl: true, shift: true, targetNode: richTextTarget });
    assert.strictEqual(crewShortcut(richTextStroke, false), null);

    const staticDivTarget = { tagName: "DIV", isContentEditable: false } as unknown as EventTarget;
    const staticDivStroke = buildKeyStroke("M", { ctrl: true, shift: true, targetNode: staticDivTarget });
    assert.strictEqual(crewShortcut(staticDivStroke, false), "crew");
  });
});

describe("windowTitle - Document Title Generation", () => {
  it("prefixes pending attention request counters and attaches Ancilla application suffix", () => {
    const nominal = windowTitle(0, "Design the offline sync engine");
    assert.strictEqual(nominal, "Design the offline sync engine — Ancilla");

    const attentionBadge = windowTitle(2, "Design the offline sync engine");
    assert.strictEqual(attentionBadge, "(2) Design the offline sync engine — Ancilla");

    assert.strictEqual(windowTitle(0, null), "Ancilla");
    assert.strictEqual(windowTitle(1, null), "(1) Ancilla");
    assert.strictEqual(windowTitle(0, "   "), "Ancilla");
  });
});

describe("windowTitleCount - Multi-Session Pending Input Aggregation", () => {
  it("computes cumulative pending request metrics across session threads and folded trees", () => {
    const compositeState = appState({
      sessions: {
        s1: session("s1", "Design the offline sync engine"),
        s2: session("s2", "Migrate auth to passkeys", {
          live: { ...LIVE, activeTurnId: null, pendingInputs: 1, pendingApprovals: 1 },
        }),
      },
      threads: {
        s1: thread(fold([...runEvents(), ...approvalEvents()])),
      },
    });

    assert.strictEqual(windowTitleCount(compositeState), 3);
    assert.strictEqual(windowTitleCount(appState()), 0);
  });
});
