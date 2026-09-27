import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sigil, type SigilProps } from "../src/components/crew/Sigil.js";
import { sigilGrid } from "../src/model/crew.js";

function render(props: SigilProps): string {
  return renderToStaticMarkup(createElement(Sigil, props));
}

function classes(markup: string): string[] {
  return (/^<span class="([^"]*)"/.exec(markup)?.[1] ?? "").split(" ");
}

function rects(markup: string): number {
  return markup.split("<rect ").length - 1;
}

describe("Sigil", () => {
  it("draws the name's grid, mirrored, with nine to fifteen pixels lit", () => {
    for (const name of ["judge:perf", "design:crdt-ledger", "research:field-notes", "Agent 3", ""]) {
      const grid = sigilGrid(name);
      const lit = grid.flat().filter(Boolean).length;
      assert.ok(lit >= 9 && lit <= 15, `${name}: ${lit} lit`);
      for (const row of grid) {
        assert.deepEqual(row, [...row].reverse(), `${name}: row not mirrored`);
      }
      assert.equal(rects(render({ name })), lit);
    }
  });

  it("is the same mark every time, and a different one for a different name", () => {
    assert.equal(render({ name: "judge:perf" }), render({ name: "judge:perf" }));
    assert.notEqual(render({ name: "judge:perf" }), render({ name: "judge:correctness" }));
  });

  it("scales the pixel grid with the tile", () => {
    assert.match(render({ name: "a" }), /^<span class="crew-sigil"[^>]*><svg width="11" height="11" viewBox="0 0 5 5"/);
    assert.match(render({ name: "a", size: 24 }), /class="crew-sigil s24"[^>]*><svg width="15"/);
    assert.match(render({ name: "a", size: 28 }), /class="crew-sigil s28"[^>]*><svg width="17"/);
    assert.match(render({ name: "a", size: 36 }), /class="crew-sigil s36"[^>]*><svg width="22"/);
  });

  it("puts the state on the tile and keeps the mark decorative", () => {
    const markup = render({ name: "a", state: "working" });
    assert.deepEqual(classes(markup), ["crew-sigil", "work"]);
    assert.match(markup, /aria-hidden="true"/);
    assert.deepEqual(classes(render({ name: "a", state: "no-update" })), ["crew-sigil", "quiet"]);
    assert.deepEqual(classes(render({ name: "a", state: "waiting-on-you" })), ["crew-sigil", "need"]);
    assert.deepEqual(classes(render({ name: "a", state: "planned" })), ["crew-sigil", "planned"]);
    assert.deepEqual(classes(render({ name: "a", state: "scheduled" })), ["crew-sigil", "pending"]);
    assert.deepEqual(classes(render({ name: "a", state: "done" })), ["crew-sigil"]);
    assert.deepEqual(classes(render({ name: "a", state: "working", stale: true })), ["crew-sigil", "work", "stale"]);
    assert.deepEqual(classes(render({ name: "a", state: "working", still: true })), ["crew-sigil", "work", "still"], "held still past the breathing budget");
  });

  it("badges a failure and a skip on its own, done and waiting only where asked", () => {
    assert.match(render({ name: "a", state: "failed" }), /class="crew-badge fail"/);
    assert.match(render({ name: "a", state: "skipped" }), /class="crew-badge stop"/);
    assert.doesNotMatch(render({ name: "a", state: "done" }), /crew-badge/);
    assert.match(render({ name: "a", state: "done", badge: true }), /class="crew-badge ok"/);
    assert.doesNotMatch(render({ name: "a", state: "waiting-on-you" }), /crew-badge/);
    assert.match(render({ name: "a", state: "waiting-on-you", badge: true }), /class="crew-badge need"/);
    assert.doesNotMatch(render({ name: "a", state: "working", badge: true }), /crew-badge/);
  });
});
