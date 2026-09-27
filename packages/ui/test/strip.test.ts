import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Strip, stripCounts, stripLabel, type StripCell, type StripProps } from "../src/components/crew/Strip.js";

const STATES: StripCell[] = ["planned", "scheduled", "working", "finishing", "no-update", "waiting-on-you", "failed", "skipped", "done", "unknown"];

/** The reference run: 10 agents in 4 phases, 41m in (SPEC §1). */
const RUN: StripCell[][] = [
  ["done", "done", "done", "done"],
  ["done", "done", "failed"],
  ["working", "no-update"],
  ["planned"],
];

function render(props: StripProps): string {
  return renderToStaticMarkup(createElement(Strip, props));
}

/** The cell classes in drawing order, phase by phase. */
function cells(markup: string): string[][] {
  return markup.split('<span class="crew-phase">').slice(1).map((phase) => {
    const inner = /^((?:<span class="crew-cell [^"]*"><\/span>)*)<\/span>/.exec(phase)?.[1] ?? "";
    return [...inner.matchAll(/class="crew-cell ([^"]*)"/g)].map((cell) => cell[1]);
  });
}

function segments(markup: string): { kind: string; width: number }[] {
  return [...markup.matchAll(/<span class="([a-z]+)" style="width:([\d.]+)%"><\/span>/g)].map((m) => ({ kind: m[1], width: Number(m[2]) }));
}

function fill(state: StripCell, count: number): StripCell[] {
  return Array.from({ length: count }, () => state);
}

/** The theme is in apps/web; the suite runs from dist as well as from source, so the repo root is found by walking up. */
function theme(): string {
  const source = join("apps", "web", "src", "theme.css");
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, source)) && dirname(dir) !== dir) dir = dirname(dir);
  return readFileSync(join(dir, source), "utf8");
}

describe("Strip", () => {
  it("draws one cell per agent, in schedule order, with the shape of its state", () => {
    const markup = render({ groups: [STATES] });
    assert.deepEqual(cells(markup), [["planned", "pending", "work", "finishing", "quiet", "need", "fail", "stop", "done", "unknown"]]);
    assert.equal((markup.match(/crew-cell/g) ?? []).length, STATES.length);
  });

  it("groups cells by phase, with a gap per phase and nothing for an empty one", () => {
    const markup = render({ groups: [["done", "done"], [], ["working"]] });
    assert.deepEqual(cells(markup), [["done", "done"], ["work"]]);
    assert.match(markup, /aria-label="3 agents in 2 phases: 2 done, 1 working"/);
  });

  it("carries the counts as text, attention before momentum, never a bare number", () => {
    const markup = render({ groups: RUN });
    assert.match(markup, /^<span role="img" aria-label="10 agents in 4 phases: 6 done, 1 failed, 1 no update, 1 working, 1 planned" class="crew-strip">/);
    assert.equal(stripLabel([["waiting-on-you", "done"]]), "2 agents: 1 done, 1 needs you");
    assert.equal(stripLabel([["waiting-on-you", "waiting-on-you", "scheduled"]]), "3 agents: 2 need you, 1 queued");
    assert.equal(stripLabel([["working"]]), "1 agent: 1 working");
    assert.equal(stripLabel([["finishing", "working"]]), "2 agents: 2 working");
    assert.equal(stripLabel([["skipped", "unknown", "done"]]), "3 agents: 1 done, 1 skipped, 1 outcome not reported");
    assert.equal(stripLabel([["unknown", "unknown"]]), "2 agents: 2 outcomes not reported");
    assert.equal(stripLabel(RUN, { stale: true }), "10 agents in 4 phases, last known: 6 done, 1 failed, 1 no update, 1 working, 1 planned");
  });

  it("says when nothing is scheduled yet", () => {
    assert.match(render({ groups: [] }), /aria-label="No agents scheduled yet"/);
    assert.match(render({ groups: [[]], more: true }), /aria-label="No agents scheduled yet, more may start"/);
    assert.doesNotMatch(render({ groups: [] }), /crew-cell|crew-phase/);
  });

  it("ends with a dashed cell while the plan is unknown", () => {
    const markup = render({ groups: [["done", "working"]], more: true });
    assert.deepEqual(cells(markup), [["done", "work"], ["more"]]);
    assert.match(markup, /aria-label="2 agents: 1 done, 1 working, more may start"/);
    assert.doesNotMatch(render({ groups: [["done"]] }), /more/);
  });

  it("takes a label of its own, or stays decorative when the text is beside it", () => {
    assert.match(render({ groups: RUN, label: "Judge · 6 of 10" }), /role="img" aria-label="Judge · 6 of 10"/);
    const decorative = render({ groups: RUN, decorative: true });
    assert.match(decorative, /^<span aria-hidden="true" class="crew-strip">/);
    assert.doesNotMatch(decorative, /role=|aria-label/);
  });

  it("counts working and finishing together and the two pending kinds apart", () => {
    assert.deepEqual(stripCounts([["working", "finishing"], ["scheduled", "planned", "planned"]]), {
      total: 5, done: 0, working: 2, quiet: 0, need: 0, failed: 0, skipped: 0, unknown: 0, scheduled: 1, planned: 2,
    });
  });

  describe("binning", () => {
    it("turns a phase past 48 agents into a proportional bar and keeps the others as cells", () => {
      const big: StripCell[] = [...fill("done", 30), ...fill("working", 10), ...fill("failed", 5), ...fill("scheduled", 3), "planned"];
      const markup = render({ groups: [big, ["done", "working"]] });
      assert.equal((markup.match(/crew-bin/g) ?? []).length, 1);
      assert.deepEqual(segments(markup), [
        { kind: "done", width: 61.2 },
        { kind: "work", width: 20.4 },
        { kind: "fail", width: 10.2 },
        { kind: "pending", width: 8.2 },
      ]);
      assert.deepEqual(cells(markup), [["done", "work"]]);
      assert.match(markup, /aria-label="51 agents in 2 phases: 31 done, 5 failed, 11 working, 3 queued, 1 planned"/);
    });

    it("keeps exactly 48 cells as cells", () => {
      const markup = render({ groups: [fill("done", 48)] });
      assert.doesNotMatch(markup, /crew-bin/);
      assert.equal(cells(markup)[0].length, 48);
    });

    it("orders the bar done, working, no update, needs you, failed, skipped, not reported, pending, and leaves out what is zero", () => {
      const markup = render({ groups: [fill("done", 10)], binAt: 4 });
      assert.deepEqual(segments(markup), [{ kind: "done", width: 100 }]);
      const every = render({ groups: [STATES], binAt: 4 });
      assert.deepEqual(segments(every).map((segment) => segment.kind), ["done", "work", "quiet", "need", "fail", "stop", "unknown", "pending"]);
      assert.deepEqual(segments(every).map((segment) => segment.width), [10, 20, 10, 10, 10, 10, 10, 20]);
    });

    it("bins the whole strip past the sidebar's 24, at the width it is given", () => {
      const phases = [fill("done", 7), fill("done", 7), fill("working", 7), fill("planned", 7)];
      const markup = render({ groups: phases, size: "xs", bin: "run", binAt: 24, binWidth: 72 });
      assert.match(markup, /class="crew-strip xs"/);
      assert.doesNotMatch(markup, /crew-phase/);
      assert.match(markup, /<span class="crew-bin" style="--bw:72px">/);
      assert.deepEqual(segments(markup), [{ kind: "done", width: 50 }, { kind: "work", width: 25 }, { kind: "pending", width: 25 }]);
      assert.match(markup, /aria-label="28 agents in 4 phases: 14 done, 7 working, 7 planned"/);
      // At the threshold the cells stay, and a run bar never sets a width it was not given.
      assert.equal(cells(render({ groups: phases.slice(0, 3), bin: "run", binAt: 24 })).length, 3);
      assert.doesNotMatch(render({ groups: phases, bin: "run", binAt: 24 }), /--bw/);
    });

    it("keeps the trailing dashed cell after a bar", () => {
      assert.deepEqual(cells(render({ groups: [fill("done", 3)], binAt: 2, more: true })), [["more"]]);
    });
  });

  describe("sizes and modifiers", () => {
    it("sets the size class for every size but the default", () => {
      assert.match(render({ groups: RUN }), /class="crew-strip"/);
      assert.match(render({ groups: RUN, size: "sm" }), /class="crew-strip"/);
      for (const size of ["xs", "md", "rail"] as const) assert.match(render({ groups: RUN, size }), new RegExp(`class="crew-strip ${size}"`));
    });

    it("marks the finale, and the sheen only with it", () => {
      assert.match(render({ groups: RUN, finale: true }), /class="crew-strip finale"/);
      assert.match(render({ groups: RUN, finale: true, sheen: true }), /class="crew-strip finale crew-sheen"/);
      assert.doesNotMatch(render({ groups: RUN, sheen: true }), /sheen|finale/);
    });

    it("marks a stale strip and every cell in it as last known", () => {
      const markup = render({ groups: [["working", "done"]], stale: true, more: true });
      assert.match(markup, /class="crew-strip stale"/);
      assert.deepEqual(cells(markup), [["work stale", "done stale"], ["more stale"]]);
      assert.match(render({ groups: [fill("working", 3)], stale: true, binAt: 2 }), /class="crew-bin stale"/);
      assert.doesNotMatch(render({ groups: RUN }), /stale/);
    });

    it("passes a class through", () => {
      assert.match(render({ groups: RUN, className: "shrink-0" }), /class="crew-strip shrink-0"/);
    });
  });

  describe("theme", () => {
    const css = theme();

    it("draws every class the strip emits", () => {
      for (const kind of ["done", "work", "finishing", "quiet", "need", "fail", "stop", "planned", "pending", "unknown", "more"]) {
        assert.match(css, new RegExp(`\\.crew-cell\\.${kind}\\b`), kind);
      }
      for (const kind of ["done", "work", "quiet", "need", "fail", "stop", "unknown", "pending"]) {
        assert.match(css, new RegExp(`\\.crew-bin > \\.${kind}\\b`), kind);
      }
      for (const selector of [".crew-strip", ".crew-strip.xs", ".crew-strip.md", ".crew-strip.rail", ".crew-strip.finale", ".crew-cell.stale", ".crew-bin.stale", ".crew-strip > .crew-phase", ".crew-strip.finale.crew-sheen"]) {
        assert.ok(css.includes(selector), selector);
      }
    });

    it("carries the tokens, the keyframes and their reduced-motion opt-out", () => {
      for (const token of ["--ok-soft", "--cell-done", "--cell-done-ok", "--bar-fill", "--lane-done", "--hatch", "--hatch-fail", "--sigil-ink", "--dur-micro", "--dur-fill", "--dur-collapse", "--dur-digits", "--dur-breathe", "--dur-sheen"]) {
        assert.match(css, new RegExp(`^\\s*${token}:`, "m"), token);
      }
      for (const name of ["crew-breathe", "crew-sheen", "crew-settle"]) assert.ok(css.includes(`@keyframes ${name} {`), name);
      const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
      for (const selector of [".crew-sigil.work > svg", ".crew-breathe", ".crew-settle", ".crew-strip.finale.crew-sheen .crew-cell.done", ".crew-cell"]) {
        assert.ok(reduced.includes(selector), selector);
      }
    });
  });
});
