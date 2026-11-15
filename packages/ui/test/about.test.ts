import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { About, LEGAL_LINKS } from "../src/components/settings/About.js";

function extractAnchorRecords(markup: string): Array<{ uri: string; content: string; blank: boolean; noRef: boolean }> {
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const results: Array<{ uri: string; content: string; blank: boolean; noRef: boolean }> = [];
  let matched: RegExpExecArray | null;

  while ((matched = anchorRegex.exec(markup)) !== null) {
    const rawAttrs = matched[1] ?? "";
    const innerHtml = matched[2] ?? "";
    const uriMatch = /href="([^"]*)"/i.exec(rawAttrs);
    const targetMatch = /target="([^"]*)"/i.exec(rawAttrs);
    const relMatch = /rel="([^"]*)"/i.exec(rawAttrs);

    results.push({
      uri: uriMatch ? uriMatch[1] : "",
      content: innerHtml.replace(/<[^>]+>/g, "").trim(),
      blank: targetMatch ? targetMatch[1] === "_blank" : false,
      noRef: relMatch ? relMatch[1].includes("noreferrer") : false,
    });
  }

  return results;
}

describe("About dialog metadata and branding", () => {
  it("displays Ancilla semver version and AGPL v3 license header", () => {
    const rendered = renderToStaticMarkup(createElement(About, { version: "0.29.0" }));
    assert.match(rendered, /Ancilla 0\.29\.0 · GNU AGPL v3/);
    assert.match(rendered, /An AMAZONIA WORKS product/);
  });

  it("handles null and empty version gracefully without whitespace anomalies", () => {
    const nullMarkup = renderToStaticMarkup(createElement(About, { version: null }));
    assert.match(nullMarkup, /<p[^>]*>\s*Ancilla · GNU AGPL v3\s*<\/p>/);

    const emptyMarkup = renderToStaticMarkup(createElement(About, { version: "" }));
    assert.match(emptyMarkup, /<p[^>]*>\s*Ancilla · GNU AGPL v3\s*<\/p>/);
  });
});

describe("About legal links registry and external references", () => {
  it("registers canonical project legal notice links", () => {
    const registry = new Map(LEGAL_LINKS.map((entry) => [entry.label, entry.href]));
    assert.equal(registry.size, 3, "must register exactly 3 canonical legal links");

    assert.equal(
      registry.get("License"),
      "https://github.com/aleff-ferreira/ancilla/blob/main/LICENSE",
    );

    assert.equal(
      registry.get("Notice"),
      "https://github.com/aleff-ferreira/ancilla/blob/main/NOTICE.md",
    );

    assert.equal(
      registry.get("Third-party notices"),
      "https://github.com/aleff-ferreira/ancilla/blob/main/THIRD_PARTY_NOTICES.md",
    );
  });

  it("renders external browser navigation attributes on all legal anchors", () => {
    const markup = renderToStaticMarkup(createElement(About, { version: "0.29.0" }));
    const anchors = extractAnchorRecords(markup);

    for (const item of LEGAL_LINKS) {
      const match = anchors.find((record) => record.uri === item.href);
      assert.ok(match, `missing anchor for legal entry: ${item.label}`);
      assert.equal(match.blank, true, "must open in new browser tab");
      assert.equal(match.noRef, true, "must set rel noreferrer");
      assert.ok(match.content.includes(item.label), `anchor content must include ${item.label}`);
    }
  });
});

describe("About AGPLv3 §13 Network Deployment Source Code Offer", () => {
  it("renders network deployment source offer banner when remoteDeployment is enabled", () => {
    const markup = renderToStaticMarkup(
      createElement(About, {
        version: "0.29.0",
        remoteDeployment: true,
        sourceOfferUrl: "https://git.ancilla.org/ancilla-source",
      }),
    );

    assert.match(markup, /Remote network deployment active \(GNU AGPLv3 §13\)/);
    const anchors = extractAnchorRecords(markup);
    const offerLink = anchors.find((a) => a.uri === "https://git.ancilla.org/ancilla-source");
    assert.ok(offerLink, "source offer anchor should exist with configured URL");
    assert.equal(offerLink.blank, true);
    assert.equal(offerLink.noRef, true);
    assert.match(offerLink.content, /Complete Corresponding Source Code/);
  });

  it("defaults source offer URL to main repository when sourceOfferUrl is omitted", () => {
    const markup = renderToStaticMarkup(
      createElement(About, {
        version: "0.29.0",
        remoteDeployment: true,
      }),
    );

    const anchors = extractAnchorRecords(markup);
    const fallbackLink = anchors.find((a) => a.uri === "https://github.com/aleff-ferreira/ancilla");
    assert.ok(fallbackLink, "fallback link should point to canonical Ancilla repository");
  });

  it("omits source offer section during standard local execution", () => {
    const markup = renderToStaticMarkup(
      createElement(About, { version: "0.29.0", remoteDeployment: false }),
    );
    assert.doesNotMatch(markup, /GNU AGPLv3 §13/);
  });
});
