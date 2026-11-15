import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  panelKeyAction,
  usePanelKeys,
  type PanelKeyAction,
  type PanelKeyInput,
  type PanelMode,
} from "../src/components/crew/usePanelKeys.js";

interface KeyTriggerOptions {
  key: string;
  typing?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function evaluateAction(mode: PanelMode, opts: KeyTriggerOptions): PanelKeyAction | null {
  const payload: PanelKeyInput = {
    key: opts.key,
    typing: opts.typing,
    shiftKey: opts.shift,
    ctrlKey: opts.ctrl,
    altKey: opts.alt,
    metaKey: opts.meta,
  };
  return panelKeyAction(payload, mode);
}

describe("panelKeyAction - Roster Navigation Mapping", () => {
  it("resolves vertical cursor navigation across vim keys and arrow keys", () => {
    const movements: Array<[string, PanelKeyAction]> = [
      ["j", "next"],
      ["ArrowDown", "next"],
      ["k", "previous"],
      ["ArrowUp", "previous"],
    ];
    for (const [keystroke, expected] of movements) {
      const outcome = evaluateAction("roster", { key: keystroke });
      assert.strictEqual(outcome, expected, `Key ${keystroke} should map to ${expected}`);
    }
  });

  it("handles agent selection and peeking modal triggers in roster view", () => {
    assert.strictEqual(evaluateAction("roster", { key: "Enter" }), "inspect");
    assert.strictEqual(evaluateAction("roster", { key: " " }), "peek");
    assert.strictEqual(evaluateAction("roster", { key: "Spacebar" }), "peek");
  });

  it("navigates forward and backward through detected issues", () => {
    assert.strictEqual(evaluateAction("roster", { key: "n" }), "next-issue");
    assert.strictEqual(evaluateAction("roster", { key: "N", shift: true }), "previous-issue");
  });

  it("triggers mode changes, filters, and timeline switches", () => {
    const toggles: Array<[string, PanelKeyAction]> = [
      ["/", "find"],
      ["f", "cycle-filter"],
      ["t", "timeline"],
      ["[", "collapse-phase"],
      ["]", "expand-phase"],
    ];
    for (const [ch, act] of toggles) {
      assert.strictEqual(evaluateAction("roster", { key: ch }), act);
    }
  });

  it("routes execution lifecycle overrides to retry, skip, stop, and back", () => {
    assert.strictEqual(evaluateAction("roster", { key: "r" }), "retry");
    assert.strictEqual(evaluateAction("roster", { key: "s" }), "skip");
    assert.strictEqual(evaluateAction("roster", { key: "x" }), "stop");
    assert.strictEqual(evaluateAction("roster", { key: "Escape" }), "back");
    assert.strictEqual(evaluateAction("roster", { key: "Esc" }), "back");
  });
});

describe("panelKeyAction - Inspector Mode Scoping & Tab Switching", () => {
  it("maps numeric keys 1-3 to inspector tabs while suppressing them in roster mode", () => {
    const tabBindings: Array<[string, PanelKeyAction]> = [
      ["1", "tab-overview"],
      ["2", "tab-lifecycle"],
      ["3", "tab-result"],
    ];
    for (const [digit, expectedTab] of tabBindings) {
      assert.strictEqual(evaluateAction("inspector", { key: digit }), expectedTab);
      assert.strictEqual(evaluateAction("roster", { key: digit }), null);
    }
  });

  it("preserves cursor steps and lifecycle actions in inspector mode", () => {
    assert.strictEqual(evaluateAction("inspector", { key: "j" }), "next");
    assert.strictEqual(evaluateAction("inspector", { key: "k" }), "previous");
    assert.strictEqual(evaluateAction("inspector", { key: "Escape" }), "back");
    assert.strictEqual(evaluateAction("inspector", { key: "r" }), "retry");
    assert.strictEqual(evaluateAction("inspector", { key: "s" }), "skip");
  });

  it("leaves Enter and Space keys unhandled in inspector view for page interactions", () => {
    assert.strictEqual(evaluateAction("inspector", { key: "Enter" }), null);
    assert.strictEqual(evaluateAction("inspector", { key: " " }), null);
    assert.strictEqual(evaluateAction("inspector", { key: "Spacebar" }), null);
  });
});

describe("panelKeyAction - Focus Isolation & Modifier Guards", () => {
  it("suppresses all shortcut actions when input typing flag is active", () => {
    const candidateKeys = ["j", "k", "n", "N", "r", "s", "x", "1", "2", "3", "Enter", " "];
    for (const key of candidateKeys) {
      assert.strictEqual(evaluateAction("roster", { key, typing: true }), null);
      assert.strictEqual(evaluateAction("inspector", { key, typing: true }), null);
    }
    assert.strictEqual(evaluateAction("inspector", { key: "Escape", typing: true }), null);
  });

  it("bypasses panel handling when Ctrl, Meta, or Alt modifiers are pressed", () => {
    const activeKeys = ["j", "k", "f", "t", "r", "s", "x", "[", "]"];
    for (const key of activeKeys) {
      assert.strictEqual(evaluateAction("roster", { key, ctrl: true }), null);
      assert.strictEqual(evaluateAction("roster", { key, meta: true }), null);
      assert.strictEqual(evaluateAction("roster", { key, alt: true }), null);
    }
  });

  it("ignores arbitrary unmapped keyboard characters", () => {
    const unrecognized = ["a", "b", "c", "q", "z", "Tab", "Home", "End", "PageUp", "PageDown", "F1", "Backspace"];
    for (const key of unrecognized) {
      assert.strictEqual(evaluateAction("roster", { key }), null);
      assert.strictEqual(evaluateAction("inspector", { key }), null);
    }
  });
});

describe("usePanelKeys - React Hook Event Interception", () => {
  it("coordinates action dispatching, event stoppage, and DOM target filtering", () => {
    const recordedActions: PanelKeyAction[] = [];
    interface EventAudit {
      readonly stroke: string;
      readonly elementTag: string;
      readonly wasPrevented: boolean;
      readonly wasStopped: boolean;
      readonly actionAccepted: boolean;
    }
    const auditLog: EventAudit[] = [];

    function TestHarness(props: { acceptAction: boolean }) {
      const handleKey = usePanelKeys("roster", (action) => {
        recordedActions.push(action);
        return props.acceptAction;
      });

      const testInputs = [
        { key: "j", targetNode: { tagName: "DIV", isContentEditable: false } },
        { key: "j", targetNode: { tagName: "INPUT", isContentEditable: false } },
        { key: "q", targetNode: { tagName: "DIV", isContentEditable: false } },
      ];

      for (const input of testInputs) {
        let prevented = false;
        let stopped = false;
        const fakeSyntheticEvent = {
          key: input.key,
          shiftKey: false,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          target: input.targetNode,
          preventDefault: () => {
            prevented = true;
          },
          stopPropagation: () => {
            stopped = true;
          },
        };

        handleKey(fakeSyntheticEvent as unknown as Parameters<typeof handleKey>[0]);
        auditLog.push({
          stroke: input.key,
          elementTag: input.targetNode.tagName,
          wasPrevented: prevented,
          wasStopped: stopped,
          actionAccepted: props.acceptAction,
        });
      }

      return null;
    }

    renderToStaticMarkup(createElement(TestHarness, { acceptAction: true }));
    renderToStaticMarkup(createElement(TestHarness, { acceptAction: false }));

    assert.deepStrictEqual(recordedActions, ["next", "next"]);
    assert.deepStrictEqual(
      auditLog.map((log) => ({
        key: log.stroke,
        tag: log.elementTag,
        prevented: log.wasPrevented,
        stopped: log.wasStopped,
        accepted: log.actionAccepted,
      })),
      [
        { key: "j", tag: "DIV", prevented: true, stopped: true, accepted: true },
        { key: "j", tag: "INPUT", prevented: false, stopped: false, accepted: true },
        { key: "q", tag: "DIV", prevented: false, stopped: false, accepted: true },
        { key: "j", tag: "DIV", prevented: false, stopped: false, accepted: false },
        { key: "j", tag: "INPUT", prevented: false, stopped: false, accepted: false },
        { key: "q", tag: "DIV", prevented: false, stopped: false, accepted: false },
      ],
    );
  });
});
