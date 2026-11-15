import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ZERO_CITABLE_STATUS, runResearch, type ResearchRunState } from "../src/research/index.js";
import {
  FakeClock,
  FakeModel,
  FakeWorker,
  INPUT,
  briefText,
  completedResult,
  decision,
  failedFetchCall,
  fetchCall,
  makeHarness,
  saved,
  searchCall,
  testConfig,
} from "./research-fakes.js";

/** A model that scopes, delegates once, concludes and writes `report`; two minutes pass per call. */
function oneRound(clock: FakeClock, report: string, language = "English"): FakeModel {
  const model = new FakeModel({
    brief: [briefText("Research brief for the question.", language)],
    supervisor: [decision("CONTINUE_RESEARCH", ["Topic 1"]), decision("RESEARCH_COMPLETE", [], "Final denoise. VERDICT: READY_TO_CONCLUDE")],
    writer: [report],
  });
  model.onCall = () => clock.advanceMinutes(2);
  return model;
}

const URL_A = "https://dead.example/page";

describe("a fetch that failed (the DNS failure repro)", () => {
  async function run(report: string, language = "English") {
    const clock = new FakeClock();
    const model = oneRound(clock, report, language);
    const worker = new FakeWorker(() => completedResult("The page would not load.", [saved(URL_A, "Dead page", "supposedly the primary source", "an excerpt it never read")], [failedFetchCall(URL_A)]));
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    return { model, outcome, harness };
  }

  it("is not cited: no footnote, no Sources section, no stray code, and the models are told it is not citable", async () => {
    const { model, outcome } = await run("# Report\n\nNothing could be established.");
    assert.doesNotMatch(outcome.report ?? "", /\[\^\d+\]|## Sources|A1-S1|dead\.example/);
    assert.deepEqual(
      outcome.state.registry.map((e) => [e.code, e.verified, e.provenance]),
      [["A1-S1", false, "attempted"]],
    );
    const writer = model.calls.find((c) => c.role === "writer")?.prompt ?? "";
    assert.doesNotMatch(writer, /A1-S1/, "the writer never sees a code it must not cite");
    assert.match(writer, /\[not citable\] Dead page \(https:\/\/dead\.example\/page\) - fetch did not complete/);
    const supervisors = model.calls.filter((c) => c.role === "supervisor");
    const second = supervisors[supervisors.length - 1]?.prompt ?? "";
    assert.match(second, /completed, 1 saved source\(s\), 0 citable/);
    assert.doesNotMatch(second, /\d+ verified/);
  });

  it("leaves a code the writer wrote anyway as plain text", async () => {
    const { outcome } = await run("# Report\n\nA claim [A1-S1].");
    assert.equal(outcome.report, "# Report\n\nA claim A1-S1.");
  });

  it("ends partial with the condition recorded on the run, and tells the writer once, in the report's language", async () => {
    const { model, outcome } = await run("# Relatório\n\nNada pôde ser citado.", "Portuguese");
    assert.equal(ZERO_CITABLE_STATUS, "partial");
    assert.equal(outcome.status, ZERO_CITABLE_STATUS);
    assert.ok(outcome.report, "the report is still written and kept");
    assert.equal(outcome.state.noCitableSources, true);
    assert.deepEqual(JSON.parse(JSON.stringify(outcome.state)).noCitableSources, true, "the flag survives a checkpoint");
    const writer = model.calls.find((c) => c.role === "writer")?.prompt ?? "";
    const lines = writer.split("\n").filter((line) => /NO SOURCE COULD BE CITED/.test(line));
    assert.equal(lines.length, 1, "one line, not a block");
    assert.match(lines[0] ?? "", /in Portuguese/);
    assert.doesNotMatch(outcome.report ?? "", /No source could be cited/i, "no English notice is appended to the report");
  });
});

describe("a run with citable sources", () => {
  it("is unchanged: completed, cited, no flag, no extra prompt line", async () => {
    const clock = new FakeClock();
    const model = oneRound(clock, "# R\n\nSeen [A1-S1].");
    const worker = new FakeWorker(() => completedResult("text", [saved("https://seen.org/p", "Seen")], [fetchCall("https://seen.org/p/")]));
    const outcome = await runResearch(INPUT, testConfig(), makeHarness(model, worker, clock).deps, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.report, "# R\n\nSeen [^1].\n\n## Sources\n\n[^1]: [Seen](https://seen.org/p)");
    assert.equal("noCitableSources" in outcome.state, false, "the field is absent, not false");
    assert.doesNotMatch(model.calls.find((c) => c.role === "writer")?.prompt ?? "", /NO SOURCE COULD BE CITED/);
  });

  it("still cites a search hit whose fetch failed, and its note says the fetch did not complete", async () => {
    const clock = new FakeClock();
    const model = oneRound(clock, "# R\n\nHit [A1-S1].");
    const worker = new FakeWorker(() =>
      completedResult("text", [saved("https://hit.org/p", "Hit")], [searchCall("q", [{ url: "https://hit.org/p", title: "Hit" }]), failedFetchCall("https://hit.org/p")]),
    );
    const outcome = await runResearch(INPUT, testConfig(), makeHarness(model, worker, clock).deps, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    assert.match(outcome.report ?? "", /\[\^1\]: \[Hit\]\(https:\/\/hit\.org\/p\)/);
    assert.match(model.calls.find((c) => c.role === "writer")?.prompt ?? "", /\[A1-S1\] Hit \(https:\/\/hit\.org\/p\) - fetch did not complete \(it was in a search result\)/);
    assert.equal(outcome.state.registry[0]?.provenance, "attempted");
  });
});

describe("a checkpoint written before provenance existed", () => {
  function legacyState(clock: FakeClock, registry: ResearchRunState["registry"]): ResearchRunState {
    return {
      version: 1,
      runId: "run-1",
      question: INPUT.question,
      config: testConfig(),
      phase: "writing",
      brief: "Research brief for the question.",
      inputLanguage: "English",
      targetLanguage: "English",
      draft: null,
      rounds: [],
      registry,
      curated: registry.map((e) => ({ url: e.url, title: e.title, reason: "from an old run", excerpt: null, agentId: e.agentId, round: e.round, verified: e.verified })),
      notes: ["## Worker A1 (round 1, research): old\n\nFindings."],
      consecutiveFailures: 0,
      aborted: false,
      abortReason: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      startedAt: new Date(clock.now).toISOString(),
      researchDeadlineAt: new Date(clock.now + 600_000).toISOString(),
      nextAgentId: 2,
      eventSeq: 5,
      loopExit: { salvage: false, reason: "research complete" },
    };
  }

  it("round-trips through a resumed run without gaining a provenance it never had, and its verified rows stay citable", async () => {
    const clock = new FakeClock();
    const rows = [
      { code: "A1-S1", url: "https://old.example/a", title: "Old A", agentId: 1, round: 1, verified: true },
      { code: "A1-S2", url: "https://old.example/b", title: "Old B", agentId: 1, round: 1, verified: false },
    ];
    const saved1 = legacyState(clock, rows);
    const model = new FakeModel({ writer: ["# R\n\nOld claim [A1-S1]."] });
    const outcome = await runResearch(INPUT, testConfig(), makeHarness(model, new FakeWorker(), clock).deps, new AbortController().signal, saved1);
    assert.equal(outcome.status, "completed");
    assert.match(outcome.report ?? "", /\[\^1\]: \[Old A\]\(https:\/\/old\.example\/a\)/);
    assert.deepEqual(outcome.state.registry, rows, "rows are neither rewritten nor given a provenance");
    assert.equal("noCitableSources" in outcome.state, false);
  });

  it("drops a no-citable-sources flag an earlier writing left behind once the resumed report cites a source", async () => {
    const clock = new FakeClock();
    const rows = [{ code: "A1-S1", url: "https://old.example/a", title: "Old A", agentId: 1, round: 1, verified: true }];
    const flagged: ResearchRunState = { ...legacyState(clock, rows), noCitableSources: true };
    const model = new FakeModel({ writer: ["# R\n\nOld claim [A1-S1]."] });
    const outcome = await runResearch(INPUT, testConfig(), makeHarness(model, new FakeWorker(), clock).deps, new AbortController().signal, flagged);
    assert.equal(outcome.status, "completed");
    assert.match(outcome.report ?? "", /\[\^1\]/);
    assert.equal("noCitableSources" in outcome.state, false, "the run view would otherwise say no source could be cited on a report that cites one");
  });

  it("keeps the flag when the resumed report still has nothing to cite", async () => {
    const clock = new FakeClock();
    const rows = [{ code: "A1-S1", url: "https://old.example/a", title: "Old A", agentId: 1, round: 1, verified: false }];
    const flagged: ResearchRunState = { ...legacyState(clock, rows), noCitableSources: true };
    const model = new FakeModel({ writer: ["# R\n\nNothing cited."] });
    const outcome = await runResearch(INPUT, testConfig(), makeHarness(model, new FakeWorker(), clock).deps, new AbortController().signal, flagged);
    assert.equal(outcome.status, "partial");
    assert.equal(outcome.state.noCitableSources, true);
  });

  it("ends partial when its only rows are unverified", async () => {
    const clock = new FakeClock();
    const rows = [{ code: "A1-S1", url: "https://old.example/a", title: "Old A", agentId: 1, round: 1, verified: false }];
    const model = new FakeModel({ writer: ["# R\n\nNothing cited."] });
    const outcome = await runResearch(INPUT, testConfig(), makeHarness(model, new FakeWorker(), clock).deps, new AbortController().signal, legacyState(clock, rows));
    assert.equal(outcome.status, "partial");
    assert.equal(outcome.state.noCitableSources, true);
  });
});
