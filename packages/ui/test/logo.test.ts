import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Logo } from "../src/components/ui/primitives.js";

const ANCILLA_BRAND_MARK_PATH = join("assets", "brand", "ancilla-mark.svg");

function loadBrandSvgSource(): string {
  let searchDirectory = dirname(fileURLToPath(import.meta.url));
  while (
    !existsSync(join(searchDirectory, ANCILLA_BRAND_MARK_PATH)) &&
    dirname(searchDirectory) !== searchDirectory
  ) {
    searchDirectory = dirname(searchDirectory);
  }
  return readFileSync(join(searchDirectory, ANCILLA_BRAND_MARK_PATH), "utf8");
}

function extractTagAttribute(svgContent: string, tagName: string, attributeName: string): string {
  const tagMatch = new RegExp(`<${tagName}\\s[^>]*>`).exec(svgContent)?.[0] ?? "";
  const attrMatch = new RegExp(`\\s${attributeName}="([^"]*)"`).exec(tagMatch)?.[1];
  assert.ok(attrMatch !== undefined, `Attribute ${attributeName} missing from <${tagName}> element`);
  return attrMatch;
}

describe("Logo SVG primitive geometry and branding compliance", () => {
  const renderedComponentMarkup = renderToStaticMarkup(createElement(Logo, { size: 32 }));

  it("renders SVG vector attributes matching the official brand mark", () => {
    const rawBrandSvg = loadBrandSvgSource();

    for (const strokeAttr of ["d", "stroke-width", "stroke-linecap", "stroke-linejoin"]) {
      assert.equal(
        extractTagAttribute(renderedComponentMarkup, "path", strokeAttr),
        extractTagAttribute(rawBrandSvg, "path", strokeAttr),
        `Vector path attribute ${strokeAttr} drifted from brand source`,
      );
    }

    for (const circleAttr of ["cx", "cy", "r"]) {
      assert.equal(
        extractTagAttribute(renderedComponentMarkup, "circle", circleAttr),
        extractTagAttribute(rawBrandSvg, "circle", circleAttr),
        `Circle geometry attribute ${circleAttr} drifted from brand source`,
      );
    }
  });

  it("renders a single path and single circle on a 32x32 viewBox", () => {
    assert.match(renderedComponentMarkup, /\bviewBox="0 0 32 32"/);
    assert.equal((renderedComponentMarkup.match(/<path\b/g) ?? []).length, 1);
    assert.equal((renderedComponentMarkup.match(/<circle\b/g) ?? []).length, 1);
  });

  it("keeps its size prop and stays decorative", () => {
    const renderedSmallIcon = renderToStaticMarkup(
      createElement(Logo, { size: 20, className: "custom-logo-class" }),
    );
    assert.match(renderedSmallIcon, /width="20" height="20"/);
    assert.match(renderedSmallIcon, /class="custom-logo-class"/);
    assert.match(renderedSmallIcon, /aria-hidden="true"/);
  });
});
