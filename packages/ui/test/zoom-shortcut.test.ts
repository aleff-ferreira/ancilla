import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zoomStepFromKey, type KeyModifierSnapshot } from "../src/model/zoom-shortcut.js";

function makeKeyStroke(modifiers: {
  key?: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}): KeyModifierSnapshot {
  return {
    key: modifiers.key ?? "",
    code: modifiers.code ?? "",
    metaKey: modifiers.meta === true,
    ctrlKey: modifiers.ctrl === true,
    altKey: modifiers.alt === true,
    shiftKey: modifiers.shift === true,
  };
}

describe("zoomStepFromKey shortcut dispatcher", () => {
  describe("zoom-in trigger mappings", () => {
    it("recognizes macOS Meta modifier combinations for zoom in", () => {
      const primaryEqual = makeKeyStroke({ meta: true, key: "=", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(primaryEqual, true), "in");

      const shiftedPlus = makeKeyStroke({ meta: true, shift: true, key: "+", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(shiftedPlus, true), "in");

      const keypadPlus = makeKeyStroke({ meta: true, key: "+", code: "NumpadAdd" });
      assert.strictEqual(zoomStepFromKey(keypadPlus, true), "in");
    });

    it("recognizes non-macOS Ctrl modifier combinations for zoom in", () => {
      const winEqual = makeKeyStroke({ ctrl: true, key: "=", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(winEqual, false), "in");

      const winKeypadPlus = makeKeyStroke({ ctrl: true, key: "+", code: "NumpadAdd" });
      assert.strictEqual(zoomStepFromKey(winKeypadPlus, false), "in");
    });
  });

  describe("zoom-out and reset trigger mappings", () => {
    it("recognizes minus key as zoom-out across platforms", () => {
      const macMinus = makeKeyStroke({ meta: true, key: "-", code: "Minus" });
      assert.strictEqual(zoomStepFromKey(macMinus, true), "out");

      const winMinus = makeKeyStroke({ ctrl: true, key: "-", code: "Minus" });
      assert.strictEqual(zoomStepFromKey(winMinus, false), "out");

      const winNumpadMinus = makeKeyStroke({ ctrl: true, key: "-", code: "NumpadSubtract" });
      assert.strictEqual(zoomStepFromKey(winNumpadMinus, false), "out");
    });

    it("recognizes unshifted digit zero as zoom reset", () => {
      const macZero = makeKeyStroke({ meta: true, key: "0", code: "Digit0" });
      assert.strictEqual(zoomStepFromKey(macZero, true), "reset");

      const winZero = makeKeyStroke({ ctrl: true, key: "0", code: "Digit0" });
      assert.strictEqual(zoomStepFromKey(winZero, false), "reset");

      const winNumpadZero = makeKeyStroke({ ctrl: true, key: "0", code: "Numpad0" });
      assert.strictEqual(zoomStepFromKey(winNumpadZero, false), "reset");
    });

    it("rejects shifted digit zero (closing parenthesis)", () => {
      const shiftedParen = makeKeyStroke({ meta: true, shift: true, key: ")", code: "Digit0" });
      assert.strictEqual(zoomStepFromKey(shiftedParen, true), null);
    });
  });

  describe("modifier enforcement and rejection", () => {
    it("rejects shortcuts without the appropriate platform modifier", () => {
      const unadorned = makeKeyStroke({ key: "=", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(unadorned, true), null);
      assert.strictEqual(zoomStepFromKey(unadorned, false), null);
    });

    it("rejects cross-platform modifier inversion", () => {
      const metaOnLinux = makeKeyStroke({ meta: true, key: "=", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(metaOnLinux, false), null, "Meta must not trigger on Linux/Windows");

      const ctrlOnMac = makeKeyStroke({ ctrl: true, key: "=", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(ctrlOnMac, true), null, "Ctrl must not trigger on macOS");
    });

    it("suppresses shortcuts when Alt modifier is depressed", () => {
      const altPolluted = makeKeyStroke({ alt: true, ctrl: true, key: "=", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(altPolluted, false), null);

      const altMacPolluted = makeKeyStroke({ alt: true, meta: true, key: "=", code: "Equal" });
      assert.strictEqual(zoomStepFromKey(altMacPolluted, true), null);
    });
  });
});
