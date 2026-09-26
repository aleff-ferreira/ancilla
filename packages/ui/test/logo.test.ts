import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Logo } from "../src/components/ui/primitives.js";

const SOURCE = join("assets", "brand", "ancilla-mark.svg");

/** The mark's vector source. The suite runs from dist as well as from source, so the repo root is found by walking up. */
function markSource(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, SOURCE)) && dirname(dir) !== dir) dir = dirname(dir);
  return readFileSync(join(dir, SOURCE), "utf8");
}

function attr(svg: string, tag: string, name: string): string {
  const element = new RegExp(`<${tag}\\s[^>]*>`).exec(svg)?.[0] ?? "";
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(element)?.[1];
  assert.ok(value !== undefined, `<${tag} ${name}> missing`);
  return value;
}

describe("Logo", () => {
  const markup = renderToStaticMarkup(createElement(Logo, { size: 32 }));

  it("draws the same geometry as assets/brand/ancilla-mark.svg", () => {
    const source = markSource();
    for (const name of ["d", "stroke-width", "stroke-linecap", "stroke-linejoin"]) {
      assert.equal(attr(markup, "path", name), attr(source, "path", name), `stroke ${name} drifted`);
    }
    for (const name of ["cx", "cy", "r"]) {
      assert.equal(attr(markup, "circle", name), attr(source, "circle", name), `node ${name} drifted`);
    }
  });

  it("no longer carries the Helicon mark it replaced", () => {
    assert.doesNotMatch(markup, /619\.9 322/, "Helicon arch path present");
    assert.doesNotMatch(markup, /M9\.5 9v14/, "Helicon H strokes present");
  });

  it("keeps its size prop and stays decorative", () => {
    const small = renderToStaticMarkup(createElement(Logo, { size: 20, className: "x" }));
    assert.match(small, /width="20" height="20"/);
    assert.match(small, /class="x"/);
    assert.match(small, /aria-hidden="true"/);
  });
});
