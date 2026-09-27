import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignCodes, buildFinalRegistry, extractCitedCodes, finalizeCitations, markdownLink, modernizeCitations, normalizeUrl } from "../src/research/citations.js";
import type { CuratedSource, SourceEntry } from "../src/research/types.js";
import { fetchCall, saved, searchCall } from "./research-fakes.js";

function entry(code: string, url: string, title: string | null = "T", verified = true): SourceEntry {
  return { code, url, title, agentId: 1, round: 1, verified };
}

describe("normalizeUrl", () => {
  it("drops fragments and trailing slashes and lower-cases the host", () => {
    assert.equal(normalizeUrl("https://Example.COM/Path/#section"), "https://example.com/Path");
    assert.equal(normalizeUrl("  https://example.com/  "), "https://example.com");
    assert.equal(normalizeUrl("https://example.com/a?b=1#x"), "https://example.com/a?b=1");
    assert.equal(normalizeUrl("not a url/"), "not a url");
  });
});

describe("assignCodes", () => {
  it("numbers a worker's sources A{agent}-S{n} and verifies them against searches and fetches", () => {
    const observed = [searchCall("q", [{ url: "https://a.org/x", title: "X" }]), fetchCall("https://b.org/y/")];
    const entries = assignCodes(4, [saved("https://a.org/x#top", "X"), saved("https://B.org/y", "Y"), saved("https://c.org/z", "Z")], observed, 2);
    assert.deepEqual(
      entries.map((e) => [e.code, e.verified, e.round]),
      [
        ["A4-S1", true, 2],
        ["A4-S2", true, 2],
        ["A4-S3", false, 2],
      ],
    );
  });

  it("collapses duplicate URLs and skips empty ones", () => {
    const entries = assignCodes(1, [saved("https://a.org/x"), saved("https://a.org/x/"), saved("   ")], []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.code, "A1-S1");
  });
});

describe("buildFinalRegistry", () => {
  it("keeps registry entries first, drops unverified ones and dedups by normalised URL", () => {
    const registry = [entry("A1-S1", "https://a.org/x"), entry("A2-S1", "https://A.org/x/"), entry("A2-S2", "https://b.org", "B", false)];
    const curated: CuratedSource[] = [
      { ...saved("https://a.org/x", "X", "why", "quote"), agentId: 1, round: 1, verified: true },
      { ...saved("https://c.org", "C", "fresh", null), agentId: 3, round: 2, verified: true },
      { ...saved("https://d.org", "D", "never seen", null), agentId: 3, round: 2, verified: false },
    ];
    const final = buildFinalRegistry(registry, curated);
    assert.deepEqual(
      final.map((e) => [e.code, e.url, e.reason, e.excerpt]),
      [
        ["A1-S1", "https://a.org/x", "why", "quote"],
        ["C1", "https://c.org", "fresh", null],
      ],
    );
  });
});

describe("finalizeCitations", () => {
  const registry = [entry("A1-S1", "https://a.org/1", "One"), entry("A1-S2", "https://a.org/2", "Two"), entry("A3-S1", "https://c.org/1", "Three")];

  it("renumbers cited codes in first-appearance order and appends Sources", () => {
    const out = finalizeCitations("Claim [A3-S1]. Other [A1-S1]. Again [A3-S1].", registry);
    assert.equal(out.report, "Claim [^1]. Other [^2]. Again [^1].\n\n## Sources\n\n[^1]: [Three](https://c.org/1)\n[^2]: [One](https://a.org/1)");
    assert.deepEqual(
      out.cited.map((e) => e.code),
      ["A3-S1", "A1-S1"],
    );
    assert.deepEqual(out.unknownCodes, []);
  });

  it("handles comma-separated groups", () => {
    const out = finalizeCitations("Claim [A1-S2, A3-S1].", registry);
    assert.ok(out.report.startsWith("Claim [^1][^2]."));
    assert.equal(out.cited.length, 2);
  });

  it("handles adjacent groups", () => {
    const out = finalizeCitations("Claim [A1-S2][A3-S1] and [A1-S2].", registry);
    assert.ok(out.report.startsWith("Claim [^1][^2] and [^1]."));
  });

  it("leaves unknown codes as plain text without brackets and reports them", () => {
    const out = finalizeCitations("Claim [A9-S9]. Real [A1-S1]. Mixed [A1-S1, C7].", registry);
    assert.ok(out.report.startsWith("Claim A9-S9. Real [^1]. Mixed [^1] C7."));
    assert.deepEqual(out.unknownCodes, ["A9-S9", "C7"]);
    assert.equal(out.cited.length, 1);
  });

  it("appends no Sources section when nothing valid was cited", () => {
    const out = finalizeCitations("No citations here [A9-S9] and a plain [1].", registry);
    assert.equal(out.report, "No citations here A9-S9 and a plain [1].");
    assert.equal(out.cited.length, 0);
  });

  it("strips a writer-produced Sources section and any CitationPlanList block", () => {
    const text = "<CitationPlanList>[A1-S1] One</CitationPlanList>\nBody [A1-S1].\n\n## Sources\n\n[A1-S1] One (https://a.org/1)\n[A1-S2] Two";
    const out = finalizeCitations(text, registry);
    assert.equal(out.report, "Body [^1].\n\n## Sources\n\n[^1]: [One](https://a.org/1)");
  });

  it("also strips a References heading and keeps numeric brackets the writer wrote", () => {
    const out = finalizeCitations("Body [A1-S1] see [3].\n### References\n[1] junk", registry);
    assert.equal(out.report, "Body [^1] see [3].\n\n## Sources\n\n[^1]: [One](https://a.org/1)");
  });

  it("formats an untitled source with the Untitled placeholder", () => {
    const out = finalizeCitations("Body [A1-S1].", [entry("A1-S1", "https://a.org/1", null)]);
    assert.ok(out.report.endsWith("[^1]: [Untitled](https://a.org/1)"));
  });

  it("never cites an unverified registry entry once the final registry is built", () => {
    const final = buildFinalRegistry([entry("A1-S1", "https://a.org/1", "One", false), entry("A1-S2", "https://a.org/2", "Two", true)], []);
    const out = finalizeCitations("Claim [A1-S1]. Claim [A1-S2].", final);
    assert.equal(out.report, "Claim A1-S1. Claim [^1].\n\n## Sources\n\n[^1]: [Two](https://a.org/2)");
  });
});

describe("extractCitedCodes", () => {
  it("returns codes in body order without duplicates", () => {
    assert.deepEqual(extractCitedCodes("[A1-S2] x [C1; A1-S2] y [S3] [A1-S2][A2-S1]"), ["A1-S2", "C1", "S3", "A2-S1"]);
  });
});

describe("markdownLink", () => {
  it("escapes brackets in the title and wraps a URL with spaces or parentheses", () => {
    assert.equal(markdownLink("A [draft] note", "https://a.org/x"), "[A \\[draft\\] note](https://a.org/x)");
    assert.equal(markdownLink("Wiki", "https://en.wikipedia.org/wiki/Foo_(bar)"), "[Wiki](<https://en.wikipedia.org/wiki/Foo_(bar)>)");
    assert.equal(markdownLink("Spaced", "https://a.org/a b"), "[Spaced](<https://a.org/a b>)");
  });
});

describe("finalizeCitations and code fences", () => {
  const registry = [entry("A1-S1", "https://a.org/1", "One")];

  it("closes a fence the writer left open before appending Sources", () => {
    const out = finalizeCitations("Body [A1-S1].\n\n```js\nconst x = 1;\n", registry);
    assert.equal(out.report, "Body [^1].\n\n```js\nconst x = 1;\n```\n\n## Sources\n\n[^1]: [One](https://a.org/1)");
  });

  it("leaves a balanced fence alone", () => {
    const out = finalizeCitations("Body [A1-S1].\n\n```\nx\n```", registry);
    assert.equal(out.report, "Body [^1].\n\n```\nx\n```\n\n## Sources\n\n[^1]: [One](https://a.org/1)");
  });
});

describe("modernizeCitations", () => {
  it("rewrites a legacy report into footnotes with links", () => {
    const legacy = "Claim [1]. Other [2][1]. Not a source [7].\n\n## Sources\n\n[1] One (https://a.org/1)\n[2] Two | Site (https://b.org/2)";
    assert.equal(
      modernizeCitations(legacy),
      "Claim [^1]. Other [^2][^1]. Not a source [7].\n\n## Sources\n\n[^1]: [One](https://a.org/1)\n[^2]: [Two | Site](https://b.org/2)",
    );
  });

  it("leaves a footnote report, a report without Sources, and an unrecognised Sources section alone", () => {
    const modern = "Claim [^1].\n\n## Sources\n\n[^1]: [One](https://a.org/1)";
    assert.equal(modernizeCitations(modern), modern);
    assert.equal(modernizeCitations("Just text [1]."), "Just text [1].");
    const odd = "Body.\n\n## Sources\n\nSee the bibliography.";
    assert.equal(modernizeCitations(odd), odd);
  });
});
