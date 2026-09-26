import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, parseBrief, parseDecision, parseFindings } from "../src/research/parse.js";

describe("extractJsonObject", () => {
  it("finds a fenced block with prose around it", () => {
    const text = 'Here is my answer.\n\n```json\n{"a": 1}\n```\n\nHope that helps.';
    assert.deepEqual(extractJsonObject(text), { ok: true, value: { a: 1 } });
  });

  it("takes the last fenced block when there are several", () => {
    const text = '```json\n{"a": 1}\n```\nActually:\n```json\n{"a": 2}\n```';
    assert.deepEqual(extractJsonObject(text), { ok: true, value: { a: 2 } });
  });

  it("accepts a bare top-level object without fences", () => {
    assert.deepEqual(extractJsonObject('  {"a": [1, 2]}  '), { ok: true, value: { a: [1, 2] } });
    assert.deepEqual(extractJsonObject('Sure: {"a": 3} done'), { ok: true, value: { a: 3 } });
  });

  it("accepts a fence without a language tag", () => {
    assert.deepEqual(extractJsonObject('```\n{"a": 1}\n```'), { ok: true, value: { a: 1 } });
  });

  it("rejects malformed JSON, arrays and empty output", () => {
    const malformed = extractJsonObject('```json\n{"a": 1,}\n```');
    assert.equal(malformed.ok, false);
    assert.match(!malformed.ok ? malformed.reason : "", /malformed/);
    assert.equal(extractJsonObject("```json\n[1, 2]\n```").ok, false);
    assert.equal(extractJsonObject("   ").ok, false);
    assert.equal(extractJsonObject("no json at all").ok, false);
  });
});

describe("parseBrief", () => {
  it("requires research_brief and derives target_language from input_language", () => {
    const out = parseBrief('```json\n{"research_brief": " Brief. ", "input_language": "French", "target_language": "English"}\n```');
    assert.deepEqual(out, { ok: true, value: { researchBrief: "Brief.", inputLanguage: "French", targetLanguage: "French" } });
    assert.equal(parseBrief('```json\n{"input_language": "English"}\n```').ok, false);
    assert.equal(parseBrief('```json\n{"research_brief": ""}\n```').ok, false);
  });

  it("tolerates missing languages", () => {
    const out = parseBrief('{"research_brief": "B"}');
    assert.deepEqual(out, { ok: true, value: { researchBrief: "B", inputLanguage: null, targetLanguage: null } });
  });
});

describe("parseDecision", () => {
  it("validates the verdict and tolerates the VERDICT wording", () => {
    assert.equal(parseDecision('{"verdict": "MAYBE", "delegations": []}', 6).ok, false);
    const out = parseDecision('{"reflection": "r", "verdict": "VERDICT: research_complete", "delegations": []}', 6);
    assert.deepEqual(out, { ok: true, value: { reflection: "r", verdict: "RESEARCH_COMPLETE", delegations: [] } });
  });

  it("defaults a missing delegations list and rejects a non-array one", () => {
    const out = parseDecision('{"verdict": "CONTINUE_RESEARCH"}', 6);
    assert.ok(out.ok && out.value.delegations.length === 0 && out.value.reflection === "");
    assert.equal(parseDecision('{"verdict": "CONTINUE_RESEARCH", "delegations": "x"}', 6).ok, false);
  });

  it("caps delegations at the given maximum", () => {
    const delegations = Array.from({ length: 10 }, (_, i) => ({ topic: `Topic ${i}` }));
    const out = parseDecision(JSON.stringify({ verdict: "CONTINUE_RESEARCH", delegations }), 6);
    assert.ok(out.ok);
    assert.equal(out.value.delegations.length, 6);
    assert.equal(out.value.delegations[5]?.topic, "Topic 5");
  });

  it("trims and deduplicates topics case-insensitively and drops blank ones", () => {
    const delegations = [{ topic: "  Alpha " }, { topic: "alpha" }, { topic: "" }, { topic: 5 }, "junk", { topic: "Beta", discovery: true }];
    const out = parseDecision(JSON.stringify({ verdict: "CONTINUE_RESEARCH", delegations }), 6);
    assert.ok(out.ok);
    assert.deepEqual(out.value.delegations, [
      { topic: "Alpha", discovery: false, maxReads: null },
      { topic: "Beta", discovery: true, maxReads: null },
    ]);
  });

  it("reads max_reads as a positive whole number or null", () => {
    const delegations = [{ topic: "A", max_reads: 12.4 }, { topic: "B", max_reads: 0 }, { topic: "C", max_reads: "9" }];
    const out = parseDecision(JSON.stringify({ verdict: "CONTINUE_RESEARCH", delegations }), 6);
    assert.ok(out.ok);
    assert.deepEqual(
      out.value.delegations.map((d) => d.maxReads),
      [12, null, null],
    );
  });
});

describe("parseFindings", () => {
  it("returns findings and saved sources, defaulting missing fields", () => {
    const text = 'Done.\n```json\n{"findings": "# F", "saved": [{"url": "https://a.org"}, {"title": "no url"}, {"url": "https://b.org", "title": "B", "reason": "r", "excerpt": "e"}]}\n```';
    const out = parseFindings(text);
    assert.deepEqual(out, {
      ok: true,
      value: {
        findings: "# F",
        saved: [
          { url: "https://a.org", title: null, reason: "", excerpt: null },
          { url: "https://b.org", title: "B", reason: "r", excerpt: "e" },
        ],
      },
    });
  });

  it("accepts findings without a saved list and rejects an empty block", () => {
    assert.deepEqual(parseFindings('{"findings": "text"}'), { ok: true, value: { findings: "text", saved: [] } });
    assert.equal(parseFindings('{"findings": "", "saved": []}').ok, false);
    assert.equal(parseFindings('{"findings": "x", "saved": {}}').ok, false);
  });
});
