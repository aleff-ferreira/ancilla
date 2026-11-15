import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Strip,
  stripCounts,
  stripLabel,
  type StripCell,
  type StripProps,
} from "../src/components/crew/Strip.js";

function mountStrip(props: StripProps): string {
  return renderToStaticMarkup(createElement(Strip, props));
}

function extractPhaseCells(html: string): string[][] {
  const phaseFragments = html.split('<span class="crew-phase">').slice(1);
  return phaseFragments.map((frag) => {
    const matchedCells = [...frag.matchAll(/class="crew-cell ([^"]*)"/g)];
    return matchedCells.map((match) => match[1]);
  });
}

function parseBinSegments(html: string): Array<{ segmentClass: string; percentage: number }> {
  const matches = [...html.matchAll(/<span class="([a-z]+)" style="width:([\d.]+)%"><\/span>/g)];
  return matches.map((m) => ({
    segmentClass: m[1],
    percentage: Number(m[2]),
  }));
}

function makeCellGroup(state: StripCell, count: number): StripCell[] {
  return Array.from({ length: count }, () => state);
}

function loadThemeStylesheet(): string {
  const relThemePath = join("apps", "web", "src", "theme.css");
  let currentDir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(currentDir, relThemePath)) && dirname(currentDir) !== currentDir) {
    currentDir = dirname(currentDir);
  }
  return readFileSync(join(currentDir, relThemePath), "utf-8");
}

describe("Strip Component - Cell Rendering & Phase Structure", () => {
  it("translates each agent state into its designated CSS visual cell class", () => {
    const lifecycleStates: StripCell[] = [
      "planned",
      "scheduled",
      "working",
      "finishing",
      "no-update",
      "waiting-on-you",
      "failed",
      "skipped",
      "done",
      "unknown",
    ];
    const html = mountStrip({ groups: [lifecycleStates] });
    const rendered = extractPhaseCells(html);

    assert.deepStrictEqual(rendered, [
      ["planned", "pending", "work", "finishing", "quiet", "need", "fail", "stop", "done", "unknown"],
    ]);
    const totalRenderedCells = (html.match(/crew-cell/g) ?? []).length;
    assert.strictEqual(totalRenderedCells, lifecycleStates.length);
  });

  it("organizes cells into separate phases and prunes empty phase containers", () => {
    const phasePayload: StripCell[][] = [["done", "done"], [], ["working"]];
    const html = mountStrip({ groups: phasePayload });
    const phased = extractPhaseCells(html);

    assert.deepStrictEqual(phased, [["done", "done"], ["work"]]);
    assert.match(html, /aria-label="3 agents in 2 phases: 2 done, 1 working"/);
  });

  it("appends trailing dashed indicator when additional agents may start", () => {
    const ongoingPayload: StripCell[][] = [["done", "working"]];
    const html = mountStrip({ groups: ongoingPayload, more: true });
    assert.deepStrictEqual(extractPhaseCells(html), [["done", "work"], ["more"]]);
    assert.match(html, /aria-label="2 agents: 1 done, 1 working, more may start"/);

    const completeHtml = mountStrip({ groups: [["done"]] });
    assert.doesNotMatch(completeHtml, /more/);
  });
});

describe("Strip Component - Accessibility & ARIA Telemetry", () => {
  const mockRunDistribution: StripCell[][] = [
    makeCellGroup("done", 4),
    [...makeCellGroup("done", 2), "failed"],
    ["working", "no-update"],
    ["planned"],
  ];

  it("synthesizes descriptive status summaries prioritizing attention over routine progress", () => {
    const html = mountStrip({ groups: mockRunDistribution });
    assert.match(
      html,
      /^<span role="img" aria-label="10 agents in 4 phases: 6 done, 1 failed, 1 no update, 1 working, 1 planned" class="crew-strip">/,
    );

    assert.strictEqual(stripLabel([["waiting-on-you", "done"]]), "2 agents: 1 done, 1 needs you");
    assert.strictEqual(
      stripLabel([["waiting-on-you", "waiting-on-you", "scheduled"]]),
      "3 agents: 2 need you, 1 queued",
    );
    assert.strictEqual(stripLabel([["working"]]), "1 agent: 1 working");
    assert.strictEqual(stripLabel([["finishing", "working"]]), "2 agents: 2 working");
    assert.strictEqual(
      stripLabel([["skipped", "unknown", "done"]]),
      "3 agents: 1 done, 1 skipped, 1 outcome not reported",
    );
    assert.strictEqual(stripLabel([["unknown", "unknown"]]), "2 agents: 2 outcomes not reported");
  });

  it("qualifies summary as last known when stale telemetry is detected", () => {
    const text = stripLabel(mockRunDistribution, { stale: true });
    assert.strictEqual(
      text,
      "10 agents in 4 phases, last known: 6 done, 1 failed, 1 no update, 1 working, 1 planned",
    );
  });

  it("emits appropriate fallback notice when no agents are currently scheduled", () => {
    const emptyMarkup = mountStrip({ groups: [] });
    assert.match(emptyMarkup, /aria-label="No agents scheduled yet"/);
    assert.doesNotMatch(emptyMarkup, /crew-cell|crew-phase/);

    const openEndedMarkup = mountStrip({ groups: [[]], more: true });
    assert.match(openEndedMarkup, /aria-label="No agents scheduled yet, more may start"/);
  });

  it("supports explicit label override and decorative hiding", () => {
    const labeled = mountStrip({ groups: mockRunDistribution, label: "Coordinator Run · Step 4" });
    assert.match(labeled, /role="img" aria-label="Coordinator Run · Step 4"/);

    const hidden = mountStrip({ groups: mockRunDistribution, decorative: true });
    assert.match(hidden, /^<span aria-hidden="true" class="crew-strip">/);
    assert.doesNotMatch(hidden, /role=|aria-label/);
  });
});

describe("Strip Component - Cell Aggregation & stripCounts", () => {
  it("coalesces active states and separates queued from planned agents", () => {
    const multiPhase: StripCell[][] = [
      ["working", "finishing"],
      ["scheduled", "planned", "planned"],
    ];
    const tally = stripCounts(multiPhase);
    assert.deepStrictEqual(tally, {
      total: 5,
      done: 0,
      working: 2,
      quiet: 0,
      need: 0,
      failed: 0,
      skipped: 0,
      unknown: 0,
      scheduled: 1,
      planned: 2,
    });
  });
});

describe("Strip Component - Adaptive Binning for Large Agent Fleets", () => {
  it("condenses phases exceeding 48 agents into a proportionate distribution bar", () => {
    const heavyPhase: StripCell[] = [
      ...makeCellGroup("done", 30),
      ...makeCellGroup("working", 10),
      ...makeCellGroup("failed", 5),
      ...makeCellGroup("scheduled", 3),
      "planned",
    ];
    const html = mountStrip({ groups: [heavyPhase, ["done", "working"]] });
    const binCount = (html.match(/crew-bin/g) ?? []).length;
    assert.strictEqual(binCount, 1);

    const bars = parseBinSegments(html);
    assert.deepStrictEqual(bars, [
      { segmentClass: "done", percentage: 61.2 },
      { segmentClass: "work", percentage: 20.4 },
      { segmentClass: "fail", percentage: 10.2 },
      { segmentClass: "pending", percentage: 8.2 },
    ]);
    assert.deepStrictEqual(extractPhaseCells(html), [["done", "work"]]);
    assert.match(
      html,
      /aria-label="51 agents in 2 phases: 31 done, 5 failed, 11 working, 3 queued, 1 planned"/,
    );
  });

  it("preserves discrete cell representation at exactly the 48-cell ceiling", () => {
    const boundaryCells = mountStrip({ groups: [makeCellGroup("done", 48)] });
    assert.doesNotMatch(boundaryCells, /crew-bin/);
    assert.strictEqual(extractPhaseCells(boundaryCells)[0].length, 48);
  });

  it("sequences bin segments by terminal, active, stalled, and pending categories", () => {
    const singleType = mountStrip({ groups: [makeCellGroup("done", 10)], binAt: 4 });
    assert.deepStrictEqual(parseBinSegments(singleType), [{ segmentClass: "done", percentage: 100 }]);

    const allTypes: StripCell[] = [
      "planned",
      "scheduled",
      "working",
      "finishing",
      "no-update",
      "waiting-on-you",
      "failed",
      "skipped",
      "done",
      "unknown",
    ];
    const mixed = mountStrip({ groups: [allTypes], binAt: 4 });
    const segments = parseBinSegments(mixed);
    assert.deepStrictEqual(
      segments.map((s) => s.segmentClass),
      ["done", "work", "quiet", "need", "fail", "stop", "unknown", "pending"],
    );
    assert.deepStrictEqual(
      segments.map((s) => s.percentage),
      [10, 20, 10, 10, 10, 10, 10, 20],
    );
  });

  it("collapses multi-phase runs exceeding sidebar threshold into unified mini-bar", () => {
    const fourPhases = [
      makeCellGroup("done", 7),
      makeCellGroup("done", 7),
      makeCellGroup("working", 7),
      makeCellGroup("planned", 7),
    ];
    const mini = mountStrip({
      groups: fourPhases,
      size: "xs",
      bin: "run",
      binAt: 24,
      binWidth: 72,
    });
    assert.match(mini, /class="crew-strip xs"/);
    assert.doesNotMatch(mini, /crew-phase/);
    assert.match(mini, /<span class="crew-bin" style="--bw:72px">/);
    assert.deepStrictEqual(parseBinSegments(mini), [
      { segmentClass: "done", percentage: 50 },
      { segmentClass: "work", percentage: 25 },
      { segmentClass: "pending", percentage: 25 },
    ]);
    assert.match(mini, /aria-label="28 agents in 4 phases: 14 done, 7 working, 7 planned"/);

    // Below threshold keeps cells
    const subThreshold = mountStrip({ groups: fourPhases.slice(0, 3), bin: "run", binAt: 24 });
    assert.strictEqual(extractPhaseCells(subThreshold).length, 3);
  });

  it("displays trailing dashed cell following an aggregated bar", () => {
    const binnedWithMore = mountStrip({ groups: [makeCellGroup("done", 3)], binAt: 2, more: true });
    assert.deepStrictEqual(extractPhaseCells(binnedWithMore), [["more"]]);
  });
});

describe("Strip Component - Visual Modifiers & Styling", () => {
  const sampleGroups: StripCell[][] = [["done", "working"], ["planned"]];

  it("applies specific modifier classes for non-default sizes", () => {
    assert.match(mountStrip({ groups: sampleGroups }), /class="crew-strip"/);
    assert.match(mountStrip({ groups: sampleGroups, size: "sm" }), /class="crew-strip"/);
    const sizeKeys = ["xs", "md", "rail"] as const;
    for (const key of sizeKeys) {
      assert.match(mountStrip({ groups: sampleGroups, size: key }), new RegExp(`class="crew-strip ${key}"`));
    }
  });

  it("controls celebratory finale highlight and requires finale for sheen animation", () => {
    assert.match(mountStrip({ groups: sampleGroups, finale: true }), /class="crew-strip finale"/);
    assert.match(
      mountStrip({ groups: sampleGroups, finale: true, sheen: true }),
      /class="crew-strip finale crew-sheen"/,
    );
    assert.doesNotMatch(mountStrip({ groups: sampleGroups, sheen: true }), /sheen|finale/);
  });

  it("propagates stale modifier to outer wrapper, contained cells, and bin segments", () => {
    const staleHtml = mountStrip({ groups: [["working", "done"]], stale: true, more: true });
    assert.match(staleHtml, /class="crew-strip stale"/);
    assert.deepStrictEqual(extractPhaseCells(staleHtml), [["work stale", "done stale"], ["more stale"]]);

    const staleBinned = mountStrip({ groups: [makeCellGroup("working", 3)], stale: true, binAt: 2 });
    assert.match(staleBinned, /class="crew-bin stale"/);
  });

  it("concatenates custom className to root element", () => {
    const custom = mountStrip({ groups: sampleGroups, className: "custom-utility-class" });
    assert.match(custom, /class="crew-strip custom-utility-class"/);
  });
});

describe("Strip Component - Theme Contract Verification", () => {
  const themeCss = loadThemeStylesheet();

  it("declares CSS rules for every cell state and bin segment variant", () => {
    const stateTokenList = [
      "done",
      "work",
      "finishing",
      "quiet",
      "need",
      "fail",
      "stop",
      "planned",
      "pending",
      "unknown",
      "more",
    ];
    for (const token of stateTokenList) {
      const cellPattern = new RegExp(`\\.crew-cell\\.${token}\\b`);
      assert.match(themeCss, cellPattern, `CSS selector for cell .${token} missing in theme.css`);
    }

    const binTokens = ["done", "work", "quiet", "need", "fail", "stop", "unknown", "pending"];
    for (const token of binTokens) {
      const binPattern = new RegExp(`\\.crew-bin > \\.${token}\\b`);
      assert.match(themeCss, binPattern, `CSS selector for bin segment .${token} missing in theme.css`);
    }

    const structureSelectors = [
      ".crew-strip",
      ".crew-strip.xs",
      ".crew-strip.md",
      ".crew-strip.rail",
      ".crew-strip.finale",
      ".crew-cell.stale",
      ".crew-bin.stale",
      ".crew-strip > .crew-phase",
      ".crew-strip.finale.crew-sheen",
    ];
    for (const selector of structureSelectors) {
      assert.ok(themeCss.includes(selector), `Theme stylesheet should include selector ${selector}`);
    }
  });

  it("defines animation keyframes, timing tokens, and reduced-motion safeguards", () => {
    const colorAndTimingVars = [
      "--ok-soft",
      "--cell-done",
      "--cell-done-ok",
      "--bar-fill",
      "--lane-done",
      "--hatch",
      "--hatch-fail",
      "--sigil-ink",
      "--dur-micro",
      "--dur-fill",
      "--dur-collapse",
      "--dur-digits",
      "--dur-breathe",
      "--dur-sheen",
    ];
    for (const varName of colorAndTimingVars) {
      const varPattern = new RegExp(`^\\s*${varName}:`, "m");
      assert.match(themeCss, varPattern, `CSS variable ${varName} missing from theme.css`);
    }

    const animationNames = ["crew-breathe", "crew-sheen", "crew-settle"];
    for (const anim of animationNames) {
      assert.ok(themeCss.includes(`@keyframes ${anim} {`), `Keyframe definition for ${anim} missing`);
    }

    const mediaIndex = themeCss.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    assert.ok(mediaIndex !== -1, "Reduced motion media query block must be present in theme.css");
    const reducedBlock = themeCss.slice(mediaIndex);

    const motionOverrides = [
      ".crew-sigil.work > svg",
      ".crew-breathe",
      ".crew-settle",
      ".crew-strip.finale.crew-sheen .crew-cell.done",
      ".crew-cell",
    ];
    for (const target of motionOverrides) {
      assert.ok(
        reducedBlock.includes(target),
        `Reduced motion override for ${target} missing in theme.css`,
      );
    }
  });
});
