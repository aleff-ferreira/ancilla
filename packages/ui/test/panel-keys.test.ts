import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { panelKeyAction, usePanelKeys, type PanelKeyAction, type PanelKeyInput } from "../src/components/crew/usePanelKeys.js";

const ROSTER: [string, PanelKeyAction][] = [
  ["j", "next"], ["ArrowDown", "next"], ["k", "previous"], ["ArrowUp", "previous"],
  ["Enter", "inspect"], [" ", "peek"],
  ["n", "next-issue"], ["N", "previous-issue"],
  ["/", "find"], ["f", "cycle-filter"], ["t", "timeline"],
  ["[", "collapse-phase"], ["]", "expand-phase"],
  ["r", "retry"], ["s", "skip"], ["x", "stop"],
  ["Escape", "back"],
];

describe("the panel's key map (SPEC §11)", () => {
  it("maps every roster key exactly as the spec lists them", () => {
    for (const [key, action] of ROSTER) assert.equal(panelKeyAction({ key }, "roster"), action, key);
    assert.equal(panelKeyAction({ key: "N", shiftKey: true }, "roster"), "previous-issue", "Shift+n");
  });

  it("gives the inspector j/k, the tab digits and Esc, and leaves Enter and Space to the page", () => {
    assert.equal(panelKeyAction({ key: "j" }, "inspector"), "next");
    assert.equal(panelKeyAction({ key: "k" }, "inspector"), "previous");
    assert.equal(panelKeyAction({ key: "1" }, "inspector"), "tab-overview");
    assert.equal(panelKeyAction({ key: "2" }, "inspector"), "tab-lifecycle");
    assert.equal(panelKeyAction({ key: "3" }, "inspector"), "tab-result");
    assert.equal(panelKeyAction({ key: "Escape" }, "inspector"), "back");
    assert.equal(panelKeyAction({ key: "r" }, "inspector"), "retry");
    assert.equal(panelKeyAction({ key: "s" }, "inspector"), "skip");
    assert.equal(panelKeyAction({ key: "Enter" }, "inspector"), null);
    assert.equal(panelKeyAction({ key: " " }, "inspector"), null);
    for (const digit of ["1", "2", "3"]) assert.equal(panelKeyAction({ key: digit }, "roster"), null, `${digit} in the roster`);
  });

  it("never fires while a text field has focus, and leaves modified keys to the app", () => {
    for (const [key] of ROSTER) {
      assert.equal(panelKeyAction({ key, typing: true }, "roster"), null, `${key} while typing`);
      assert.equal(panelKeyAction({ key, ctrlKey: true }, "roster"), null, `Ctrl+${key}`);
      assert.equal(panelKeyAction({ key, metaKey: true }, "roster"), null, `Cmd+${key}`);
      assert.equal(panelKeyAction({ key, altKey: true }, "roster"), null, `Alt+${key}`);
    }
    assert.equal(panelKeyAction({ key: "Escape", typing: true }, "inspector"), null, "the search box keeps its own Escape");
  });

  it("ignores keys the panel does not use", () => {
    for (const key of ["a", "q", "Tab", "Home", "PageDown", "F1", "ArrowLeft", "ArrowRight", "Backspace"]) {
      assert.equal(panelKeyAction({ key }, "roster"), null, key);
      assert.equal(panelKeyAction({ key }, "inspector"), null, key);
    }
  });

  it("binds the map to a key handler that stops a taken key and lets the rest through", () => {
    const seen: PanelKeyAction[] = [];
    const events: { key: string; target?: { tagName: string; isContentEditable: boolean }; prevented: boolean; stopped: boolean; taken: boolean | undefined }[] = [];
    function Probe(props: { take: boolean }) {
      const onKeyDown = usePanelKeys("roster", (action) => {
        seen.push(action);
        return props.take;
      });
      for (const input of [{ key: "j" }, { key: "j", target: { tagName: "INPUT", isContentEditable: false } }, { key: "q" }] as (PanelKeyInput & { target?: { tagName: string; isContentEditable: boolean } })[]) {
        const event = {
          key: input.key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
          target: input.target ?? { tagName: "DIV", isContentEditable: false },
          prevented: false, stopped: false,
          preventDefault() { this.prevented = true; },
          stopPropagation() { this.stopped = true; },
        };
        onKeyDown(event as unknown as Parameters<typeof onKeyDown>[0]);
        events.push({ key: input.key, target: input.target, prevented: event.prevented, stopped: event.stopped, taken: props.take });
      }
      return null;
    }
    renderToStaticMarkup(createElement(Probe, { take: true }));
    renderToStaticMarkup(createElement(Probe, { take: false }));
    assert.deepEqual(seen, ["next", "next"], "j fires once per render; the input and the unknown key never reach the handler");
    assert.deepEqual(events.map((event) => [event.key, event.target?.tagName ?? "DIV", event.prevented, event.stopped]), [
      ["j", "DIV", true, true],
      ["j", "INPUT", false, false],
      ["q", "DIV", false, false],
      ["j", "DIV", false, false],
      ["j", "INPUT", false, false],
      ["q", "DIV", false, false],
    ]);
  });
});
