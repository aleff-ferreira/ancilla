import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sigil, type SigilProps } from "../src/components/crew/Sigil.js";
import { sigilGrid } from "../src/model/crew.js";

interface SigilAnalysis {
  markup: string;
  classes: string[];
  rectangles: number;
  width: number;
  height: number;
  viewBox: string;
  decorative: boolean;
  badges: string[];
}

function analyzeSigil(props: SigilProps): SigilAnalysis {
  const markup = renderToStaticMarkup(createElement(Sigil, props));
  const classMatch = markup.match(/^<span\b[^>]*\bclass="([^"]*)"/);
  const classes = classMatch ? classMatch[1].trim().split(/\s+/) : [];
  const rectMatches = markup.match(/<rect\b/g);
  const rectangles = rectMatches ? rectMatches.length : 0;
  const svgMatch = markup.match(/<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"[^>]*\bviewBox="([^"]+)"/);
  const width = svgMatch ? parseInt(svgMatch[1], 10) : 0;
  const height = svgMatch ? parseInt(svgMatch[2], 10) : 0;
  const viewBox = svgMatch ? svgMatch[3] : "";
  const decorative = /aria-hidden="true"/.test(markup);
  const badgeMatches = Array.from(markup.matchAll(/class="crew-badge\s+([^"]+)"/g)).map((m) => m[1]);

  return {
    markup,
    classes,
    rectangles,
    width,
    height,
    viewBox,
    decorative,
    badges: badgeMatches,
  };
}

describe("Sigil component rendering and determinism", () => {
  it("generates deterministic 5x5 mirrored pixel matrices with 9 to 15 active nodes", () => {
    const candidateIdentifiers = [
      "judge:perf",
      "design:crdt-ledger",
      "research:field-notes",
      "Agent 3",
      "",
    ];

    for (const identifier of candidateIdentifiers) {
      const grid = sigilGrid(identifier);
      assert.strictEqual(grid.length, 5, `Grid should have 5 rows for ${identifier}`);

      let litPixelCount = 0;
      for (const row of grid) {
        assert.strictEqual(row.length, 5, "Each row must contain 5 cells");
        assert.strictEqual(row[0], row[4], "Column 0 and 4 must mirror");
        assert.strictEqual(row[1], row[3], "Column 1 and 3 must mirror");
        litPixelCount += row.filter(Boolean).length;
      }

      assert.ok(
        litPixelCount >= 9 && litPixelCount <= 15,
        `Expected 9..15 illuminated cells, found ${litPixelCount} for ${identifier}`,
      );

      const inspection = analyzeSigil({ name: identifier });
      assert.strictEqual(inspection.rectangles, litPixelCount);
    }
  });

  it("yields identical SVG output for identical names and distinct SVG for differing names", () => {
    const primaryA = analyzeSigil({ name: "judge:perf" });
    const primaryB = analyzeSigil({ name: "judge:perf" });
    const secondary = analyzeSigil({ name: "judge:correctness" });

    assert.strictEqual(primaryA.markup, primaryB.markup);
    assert.notStrictEqual(primaryA.markup, secondary.markup);
  });

  it("dynamically calibrates dimensions and viewBox for predefined size presets", () => {
    const defaultTile = analyzeSigil({ name: "unit-sample" });
    assert.strictEqual(defaultTile.width, 11);
    assert.strictEqual(defaultTile.height, 11);
    assert.strictEqual(defaultTile.viewBox, "0 0 5 5");
    assert.ok(defaultTile.classes.includes("crew-sigil"));

    const presets: readonly { size: SigilProps["size"]; expectedWidth: number; classToken: string }[] = [
      { size: 24, expectedWidth: 15, classToken: "s24" },
      { size: 28, expectedWidth: 17, classToken: "s28" },
      { size: 36, expectedWidth: 22, classToken: "s36" },
    ];

    for (const preset of presets) {
      const rendered = analyzeSigil({ name: "unit-sample", size: preset.size });
      assert.strictEqual(rendered.width, preset.expectedWidth);
      assert.ok(rendered.classes.includes("crew-sigil"));
      assert.ok(rendered.classes.includes(preset.classToken));
    }
  });

  it("applies corresponding semantic state classes while preserving decorative accessibility", () => {
    const stateMappingMatrix: readonly {
      targetState: SigilProps["state"];
      expectedClassList: string[];
    }[] = [
      { targetState: "working", expectedClassList: ["crew-sigil", "work"] },
      { targetState: "no-update", expectedClassList: ["crew-sigil", "quiet"] },
      { targetState: "waiting-on-you", expectedClassList: ["crew-sigil", "need"] },
      { targetState: "planned", expectedClassList: ["crew-sigil", "planned"] },
      { targetState: "scheduled", expectedClassList: ["crew-sigil", "pending"] },
      { targetState: "done", expectedClassList: ["crew-sigil"] },
    ];

    for (const testCase of stateMappingMatrix) {
      const result = analyzeSigil({ name: "unit-agent", state: testCase.targetState });
      assert.deepStrictEqual(result.classes, testCase.expectedClassList);
      assert.strictEqual(result.decorative, true);
    }

    const staleInspection = analyzeSigil({ name: "unit-agent", state: "working", stale: true });
    assert.deepStrictEqual(staleInspection.classes, ["crew-sigil", "work", "stale"]);

    const stillInspection = analyzeSigil({ name: "unit-agent", state: "working", still: true });
    assert.deepStrictEqual(stillInspection.classes, ["crew-sigil", "work", "still"]);
  });

  it("attaches autonomous badges for terminal failures/skips and explicit badges on demand", () => {
    const failedInspection = analyzeSigil({ name: "agent-x", state: "failed" });
    assert.deepStrictEqual(failedInspection.badges, ["fail"]);

    const skippedInspection = analyzeSigil({ name: "agent-x", state: "skipped" });
    assert.deepStrictEqual(skippedInspection.badges, ["stop"]);

    const unbadgedDone = analyzeSigil({ name: "agent-x", state: "done" });
    assert.strictEqual(unbadgedDone.badges.length, 0);

    const badgedDone = analyzeSigil({ name: "agent-x", state: "done", badge: true });
    assert.deepStrictEqual(badgedDone.badges, ["ok"]);

    const unbadgedWaiting = analyzeSigil({ name: "agent-x", state: "waiting-on-you" });
    assert.strictEqual(unbadgedWaiting.badges.length, 0);

    const badgedWaiting = analyzeSigil({ name: "agent-x", state: "waiting-on-you", badge: true });
    assert.deepStrictEqual(badgedWaiting.badges, ["need"]);

    const badgedWorking = analyzeSigil({ name: "agent-x", state: "working", badge: true });
    assert.strictEqual(badgedWorking.badges.length, 0);
  });
});
