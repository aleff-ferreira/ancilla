/**
 * The evaluation, cut down so it runs with the rest of the tests: the targets fixed in advance are checked against
 * what the code does, so a change that makes the assistant forget, leak, or double-run something fails here. The full
 * run, with its larger sets, is `scripts/assistant-eval.mjs`, and its numbers are in docs/assistant-evaluation.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTargets, runAll, targets, type Results } from "../src/assistant/eval/report.js";
import { read } from "../src/assistant/eval/reader.js";
import { holdsAll, judge } from "../src/assistant/eval/run.js";
import { buildSuite } from "../src/assistant/eval/suites.js";
import { embed, expansionWords } from "../src/assistant/eval/variants.js";

describe("the evaluation's own parts", () => {
  it("builds the same scenarios from the same seed, and different ones from a different round", () => {
    const a = JSON.stringify(buildSuite("dev", 6, 5));
    assert.equal(a, JSON.stringify(buildSuite("dev", 6, 5)));
    assert.notEqual(a, JSON.stringify(buildSuite("held", 6, 5)));
    assert.notEqual(JSON.stringify(buildSuite("held", 6, 5, 0)), JSON.stringify(buildSuite("held", 6, 5, 1)));
  });

  it("reads a context the way a careful model would: the best match, the newer of equals, nothing replaced, nothing invented", () => {
    const block = [
      "<assistant-memory>",
      "Relevant notes:",
      "- [m_old] the staging server is at app-1.example.com (earlier, replaced on 2026-03-01)",
      "- [m_new] the staging server is at app-2.example.com (told by the user 2026-03-02)",
      "- [m_other] the backup bucket is named vault-4 (told by the user 2026-02-01)",
      "</assistant-memory>",
    ].join("\n");
    const answer = read(block, "where is the staging server?");
    assert.deepEqual(answer.kind === "answer" && answer.id, "m_new");
    assert.equal(read(block, "what was the staging server before?").kind === "answer" && (read(block, "what was the staging server before?") as { id: string }).id !== undefined, true);
    assert.equal(read(block, "who is on call?").kind, "abstain");
    assert.equal(read("(No saved note matches this question.)", "who is on call?").kind, "abstain");
    assert.equal(read(null, "anything").kind, "abstain");
    assert.ok(holdsAll("The Staging server", [["staging"], ["server", "host"]]) && !holdsAll("nothing", [["staging"]]));
  });

  it("judges a probe by what the context holds and what a reader would say from it", () => {
    const need = [["app-2.example.com"]];
    const probe = { category: "change" as const, need, never: ["app-1.example.com"] };
    assert.deepEqual(judge(probe, "- [a] the staging server is at app-2.example.com (told by the user 2026-03-02)", "where is the staging server?"), { hit: true, answer: true, correct: true, unsupported: false, leaked: false });
    const both = judge(probe, "- [a] the staging server is at app-1.example.com (told by the user 2026-03-01)\n- [b] the staging server is at app-2.example.com (told by the user 2026-03-02)", "where is the staging server?");
    assert.equal(both.leaked, true);
    assert.equal(both.correct, false);
    assert.equal(judge({ category: "abstain", abstain: true }, "- [a] the staging server is at app-2.example.com (told by the user 2026-03-02)", "where is the staging server?").unsupported, true);
    assert.equal(judge({ category: "abstain", abstain: true }, null, "who is my dentist?").correct, true);
  });

  it("has a lexicon that bridges words and vectors that put near words near", () => {
    assert.ok(expansionWords("where is the ship date").includes("deploy"));
    assert.deepEqual(expansionWords("a b c"), []);
    const near = embed("deployment");
    const same = embed("deployments");
    const far = embed("violin");
    const dot = (a: Float32Array, b: Float32Array): number => a.reduce((s, x, i) => s + x * (b[i] as number), 0);
    assert.ok(dot(near, same) > 0.5 && dot(near, far) < 0.2);
  });
});

describe("the targets fixed in advance", () => {
  let results: Results;

  it("runs", async () => {
    results = await runAll({ quick: true });
    assert.ok(results.held.probes > 100);
  });

  it("are met on the cut-down run", () => {
    const missed = targets(results, true).filter((t) => !t.met);
    assert.deepEqual(missed, [], `\n${renderTargets(targets(results, true))}`);
  });

  it("show what the baselines cannot do, so that meeting them means something", () => {
    const t = results.held.table;
    const rate = (system: string, key: string, field: "hit" | "answer" | "leaked"): number => {
      const rows = Object.entries(t[system] ?? {}).filter(([k]) => k === key || k.startsWith(`${key}:`));
      const n = rows.reduce((s, [, v]) => s + v.n, 0);
      return n === 0 ? 0 : rows.reduce((s, [, v]) => s + v[field], 0) / n;
    };
    assert.ok(rate("assistant", "exact", "hit") > rate("window", "exact", "hit") + 0.3, "against the pasted-back window");
    assert.ok(rate("assistant", "exact", "hit") > rate("summary", "exact", "hit") + 0.2, "against a rolling summary");
    assert.equal(rate("none", "exact", "hit"), 0);
    assert.equal(rate("window", "contradiction", "hit"), 0, "a window cannot say a dispute is a dispute");
    assert.ok(rate("window", "deletion:after", "leaked") > 0, "a window cannot erase what is still in it");
  });
});
