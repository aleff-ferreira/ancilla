import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { About, LEGAL_LINKS } from "../src/components/settings/About.js";

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

describe("About", () => {
  it("credits Helicon and names the license next to the version", () => {
    const markup = renderToStaticMarkup(createElement(About, { version: "0.18.0" }));
    assert.match(text(markup), /Ancilla 0\.18\.0 · based on Helicon by Harjot Singh Rana and contributors \(MIT\) · GNU AGPL v3/);
    assert.match(markup, /href="https:\/\/github\.com\/HarjjotSinghh\/helicon"/);
  });

  it("links the license, Helicon's license text, the notice and the third-party notices out to the browser", () => {
    const markup = renderToStaticMarkup(createElement(About, { version: "0.18.0" }));
    assert.deepEqual(
      LEGAL_LINKS.map((link) => link.href),
      [
        "https://github.com/aleff-ferreira/ancilla/blob/main/LICENSE",
        "https://github.com/aleff-ferreira/ancilla/blob/main/LICENSE-HELICON",
        "https://github.com/aleff-ferreira/ancilla/blob/main/NOTICE.md",
        "https://github.com/aleff-ferreira/ancilla/blob/main/THIRD_PARTY_NOTICES.md",
      ],
    );
    for (const link of LEGAL_LINKS) {
      assert.ok(markup.includes(`href="${link.href}" target="_blank" rel="noreferrer"`), `${link.label} is not an outside link`);
      assert.match(text(markup), new RegExp(link.label));
    }
  });

  it("leaves the version out rather than showing a gap before it loads", () => {
    assert.match(text(renderToStaticMarkup(createElement(About, { version: null }))), /^Ancilla · based on Helicon/);
  });
});
