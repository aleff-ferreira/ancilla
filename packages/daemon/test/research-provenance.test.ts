import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_ONLY_CITABLE,
  assignCodes,
  buildFinalRegistry,
  provenanceByUrl,
  type CuratedSource,
  type ObservedToolCall,
  type ResearchRunState,
  type SourceEntry,
} from "../src/research/index.js";
import { RunContext } from "../src/research/context.js";
import { runSupervisorLoop } from "../src/research/supervisor.js";
import {
  FakeClock,
  FakeModel,
  FakeWorker,
  INPUT,
  completedResult,
  decision,
  failedFetchCall,
  fetchCall,
  makeHarness,
  researchingState,
  saved,
  searchCall,
  testConfig,
  withOutcome,
} from "./research-fakes.js";

const hit = (url: string, title: string | null = null) => searchCall("q", [{ url, title }]);

/** The provenance and the citable flag assignCodes gave one URL, from the calls alone. */
function judge(url: string, observed: ObservedToolCall[], searchOnlyCitable?: boolean): { provenance: string | undefined; verified: boolean } {
  const [entry] = assignCodes(1, [saved(url)], observed, 1, searchOnlyCitable);
  return { provenance: entry?.provenance, verified: entry?.verified ?? false };
}

describe("citation provenance per URL", () => {
  it("lets a search hit alone be cited by default, as the policy constant says, until real Muse fixtures decide otherwise", () => {
    const observed = [hit("https://a.org/x")];
    // The shipped decision (D5) is read from the behaviour, not from the constant's own value.
    assert.deepEqual(judge("https://a.org/x", observed), { provenance: "search_only", verified: true });
    assert.deepEqual(judge("https://a.org/x", observed), judge("https://a.org/x", observed, SEARCH_ONLY_CITABLE), "the default is the constant");
    assert.deepEqual(provenanceByUrl(observed).get("https://a.org/x"), { provenance: "search_only", citable: true });
    assert.deepEqual(buildFinalRegistry(assignCodes(1, [saved("https://a.org/x")], observed, 1), []).map((e) => e.code), ["A1-S1"]);
  });

  it("calls a fetch that ended ok 'retrieved', whether the output size is known, unknown or not reported at all", () => {
    assert.deepEqual(judge("https://a.org/x", [withOutcome(fetchCall("https://a.org/x"), "ok", 2048)]), { provenance: "retrieved", verified: true });
    assert.deepEqual(judge("https://a.org/x", [withOutcome(fetchCall("https://a.org/x"), "ok", null)]), { provenance: "retrieved", verified: true });
    // A call from a host that reports no outcome (an older runner, a test double) reads as ok, as before.
    assert.deepEqual(judge("https://a.org/x", [fetchCall("https://a.org/x")]), { provenance: "retrieved", verified: true });
  });

  it("does not count a fetch that ended ok with a known empty output as retrieved", () => {
    assert.deepEqual(judge("https://a.org/x", [withOutcome(fetchCall("https://a.org/x"), "ok", 0)]), { provenance: "attempted", verified: false });
  });

  it("does not verify a failed fetch of a URL that never appeared in a search hit (the DNS failure repro)", () => {
    assert.deepEqual(judge("https://dead.example/p", [failedFetchCall("https://dead.example/p")]), { provenance: "attempted", verified: false });
    for (const outcome of ["cancelled", "unreported"] as const) {
      assert.deepEqual(judge("https://dead.example/p", [withOutcome(fetchCall("https://dead.example/p"), outcome)]), { provenance: "attempted", verified: false }, outcome);
    }
  });

  it("shows a failed fetch of a search-hit URL as attempted, so the failure stays visible, while the hit keeps it citable", () => {
    const observed = [hit("https://a.org/x"), failedFetchCall("https://a.org/x")];
    assert.deepEqual(judge("https://a.org/x", observed), { provenance: "attempted", verified: true });
    assert.deepEqual(judge("https://a.org/x", observed, false), { provenance: "attempted", verified: false });
  });

  it("lets a later successful fetch win over an earlier failed one, and the other way round", () => {
    assert.deepEqual(judge("https://a.org/x", [failedFetchCall("https://a.org/x"), fetchCall("https://a.org/x")]), { provenance: "retrieved", verified: true });
    assert.deepEqual(judge("https://a.org/x", [fetchCall("https://a.org/x"), failedFetchCall("https://a.org/x")]), { provenance: "retrieved", verified: true });
  });

  it("calls a URL seen only in a completed search result 'search_only', citable only while the constant allows it", () => {
    const observed = [hit("https://a.org/x", "X")];
    assert.deepEqual(judge("https://a.org/x", observed), { provenance: "search_only", verified: true });
    assert.deepEqual(judge("https://a.org/x", observed, false), { provenance: "search_only", verified: false });
  });

  it("takes nothing from a search that did not end ok, whatever its output held", () => {
    for (const outcome of ["failed", "cancelled", "unreported"] as const) {
      assert.deepEqual(judge("https://a.org/x", [withOutcome(hit("https://a.org/x"), outcome)]), { provenance: "unobserved", verified: false }, outcome);
    }
  });

  it("takes nothing from a call of the 'other' kind, even one that names or returns a URL", () => {
    const read: ObservedToolCall = { tool: "read_page", kind: "other", query: null, urls: ["https://a.org/x"], results: [{ url: "https://a.org/x", title: null }], at: new Date(0).toISOString() };
    assert.deepEqual(judge("https://a.org/x", [read]), { provenance: "unobserved", verified: false });
    assert.deepEqual(judge("https://a.org/x", [withOutcome(read, "ok", 100)]), { provenance: "unobserved", verified: false });
  });

  it("keeps matching URLs the way it did: fragments, a trailing slash and the host's case are ignored, the scheme is not", () => {
    assert.equal(judge("https://B.org/y#top", [fetchCall("https://b.org/y/")]).verified, true);
    assert.equal(judge("http://b.org/y", [fetchCall("https://b.org/y")]).verified, false, "http and https stay different pages");
    assert.equal(judge("https://b.org/y?a=1", [fetchCall("https://b.org/y")]).verified, false, "a query string is part of the page");
  });

  it("marks a worker's own unseen URL 'unobserved', and never stores page text", () => {
    const entries = assignCodes(2, [saved("https://seen.org/p"), saved("https://claimed.org/p")], [fetchCall("https://seen.org/p")], 3);
    assert.deepEqual(entries.map((e) => [e.code, e.provenance, e.verified]), [
      ["A2-S1", "retrieved", true],
      ["A2-S2", "unobserved", false],
    ]);
    assert.deepEqual(Object.keys(entries[0] as object).sort(), ["agentId", "code", "provenance", "round", "title", "url", "verified"]);
  });

  it("exposes the per-URL map keyed by the normalised URL", () => {
    const map = provenanceByUrl([hit("https://a.org/x/"), failedFetchCall("https://a.org/x")]);
    assert.equal(map.get("https://a.org/x")?.provenance, "attempted");
    assert.equal(map.get("https://a.org/x")?.citable, true);
    assert.equal(map.has("https://never.org"), false);
  });
});

describe("the final registry and the strongest curated row", () => {
  const entry = (code: string, url: string, verified: boolean, provenance?: SourceEntry["provenance"]): SourceEntry => ({ code, url, title: "T", agentId: 1, round: 1, verified, ...(provenance ? { provenance } : {}) });
  const curated = (url: string, agentId: number, verified: boolean, reason: string, excerpt: string | null, provenance?: CuratedSource["provenance"]): CuratedSource => ({
    url,
    title: null,
    reason,
    excerpt,
    agentId,
    round: 1,
    verified,
    ...(provenance ? { provenance } : {}),
  });

  it("takes the reason and excerpt from the worker that read the page, not from the first row", () => {
    const rows = [curated("https://a.org/x", 2, false, "invented by a worker that never saw it", "invented quote", "unobserved"), curated("https://a.org/x", 1, true, "read it", "real quote", "retrieved")];
    const [final] = buildFinalRegistry([entry("A2-S1", "https://a.org/x", true, "retrieved")], rows);
    assert.equal(final?.reason, "read it");
    assert.equal(final?.excerpt, "real quote");
  });

  it("keeps a registry entry that is not verified out, however strong its provenance claims to be", () => {
    assert.deepEqual(buildFinalRegistry([entry("A1-S1", "https://a.org/x", false, "retrieved")], []), []);
  });

  it("lets rows written before provenance existed through on the verified flag alone", () => {
    const final = buildFinalRegistry([entry("A1-S1", "https://a.org/x", true)], [curated("https://a.org/x", 1, true, "old reason", null)]);
    assert.deepEqual(final.map((e) => [e.code, e.reason, e.provenance]), [["A1-S1", "old reason", undefined]]);
  });
});

// ---------------------------------------------------------------- the merge, in both orders

interface Merged {
  state: ResearchRunState;
  notes: string[];
}

/** Round one delegates two topics (agents 1 and 2); `first` is the agent whose result merges first. */
async function mergeTwo(first: 1 | 2, results: Record<1 | 2, (url: string) => ReturnType<typeof completedResult>>): Promise<Merged> {
  const clock = new FakeClock();
  const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["One", "Two"]), decision("RESEARCH_COMPLETE", [])] });
  model.onCall = () => clock.advanceMinutes(4);
  const url = "https://shared.example/page";
  const state = researchingState(testConfig(), clock.now);
  const worker = new FakeWorker(async (task) => {
    const agent = task.agentId as 1 | 2;
    if (agent !== first) {
      // The other worker waits, on the event loop and not on a clock, until the first one has been merged.
      while (state.notes.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return results[agent](url);
  });
  const harness = makeHarness(model, worker, clock);
  const ctx = new RunContext(state, harness.deps, INPUT, new AbortController().signal);
  await runSupervisorLoop(ctx);
  return { state, notes: state.notes };
}

const READER = (url: string) => completedResult("A1 read it.", [saved(url, "Shared page", "real reason", "real quote")], [fetchCall(url)]);
const STRANGER = (url: string) => completedResult("A2 never saw it.", [saved(url, "Shared page", "reason of a worker that never saw it", "invented quote")], []);

describe("merging two workers that name the same URL", () => {
  for (const [label, first] of [["the stranger merges first", 2], ["the reader merges first", 1]] as const) {
    it(`stamps each worker's count and curated row from its own entry when ${label}`, async () => {
      const { state } = await mergeTwo(first, { 1: READER, 2: STRANGER });
      const summaries = state.rounds[0]?.results ?? [];
      assert.deepEqual(summaries.map((r) => [r.agentId, r.verifiedCount]), [[1, 1], [2, 0]], "a worker that never saw the page is not counted as citing it");
      const rows = state.curated;
      const own = (agent: number) => rows.find((row) => row.agentId === agent);
      assert.deepEqual([own(1)?.verified, own(1)?.provenance], [true, "retrieved"]);
      assert.deepEqual([own(2)?.verified, own(2)?.provenance], [false, "unobserved"]);
      assert.equal(state.registry.length, 1, "one page, one registry entry");
      assert.deepEqual([state.registry[0]?.verified, state.registry[0]?.provenance], [true, "retrieved"], "the shared entry holds the strongest evidence, verified and provenance together");
      const [final] = buildFinalRegistry(state.registry, state.curated);
      assert.equal(final?.reason, "real reason", "the writer gets the reason of the worker that read the page");
      assert.equal(final?.excerpt, "real quote");
    });
  }

  it("writes what each worker saw into its note, and no citation code for what it could not cite", async () => {
    const { notes } = await mergeTwo(1, { 1: READER, 2: STRANGER });
    const reader = notes.find((n) => n.startsWith("## Worker A1")) ?? "";
    const stranger = notes.find((n) => n.startsWith("## Worker A2")) ?? "";
    assert.match(reader, /\[A1-S1\] Shared page \(https:\/\/shared\.example\/page\) - opened - real reason/);
    assert.match(stranger, /\[not citable\] Shared page \(https:\/\/shared\.example\/page\) - never seen by this worker/);
    assert.doesNotMatch(stranger, /A2-S1/, "an uncitable source carries no code the writer could cite");
    assert.doesNotMatch(stranger, /UNVERIFIED/);
  });

  it("prints the code the registry holds for the page when the other worker merged first, never a code that is not in it", async () => {
    const { notes, state } = await mergeTwo(2, { 1: READER, 2: STRANGER });
    assert.equal(state.registry.length, 1);
    assert.equal(state.registry[0]?.code, "A2-S1", "the first worker to name a page owns its code");
    const reader = notes.find((n) => n.startsWith("## Worker A1")) ?? "";
    assert.match(reader, /\[A2-S1\] Shared page \(https:\/\/shared\.example\/page\) - opened - real reason/);
    assert.doesNotMatch(reader, /A1-S1/, "the writer could not cite a code the registry does not hold");
  });

  const HIT_ONLY = (url: string) => completedResult("A1 only saw a result.", [saved(url, "Shared page", "listed")], [hit(url)]);
  const HIT_THEN_FAILED = (url: string) => completedResult("A2 tried to open it.", [saved(url, "Shared page", "listed")], [hit(url), failedFetchCall(url)]);

  for (const [label, first] of [["the search-only worker merges first", 1], ["the failed fetch merges first", 2]] as const) {
    it(`shows a failed fetch on the shared entry, without making it any less citable, when ${label}`, async () => {
      const { state } = await mergeTwo(first, { 1: HIT_ONLY, 2: HIT_THEN_FAILED });
      assert.equal(state.registry.length, 1);
      assert.deepEqual([state.registry[0]?.verified, state.registry[0]?.provenance], [true, "attempted"], "a failed fetch by any worker stays visible");
      const own = (agent: number) => state.curated.find((row) => row.agentId === agent)?.provenance;
      assert.deepEqual([own(1), own(2)], ["search_only", "attempted"], "each worker's own row keeps its own evidence");
    });
  }
});

describe("what the notes call a source", () => {
  async function noteFor(observed: ObservedToolCall[]): Promise<string> {
    const clock = new FakeClock();
    const model = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["One"]), decision("RESEARCH_COMPLETE", [])] });
    model.onCall = () => clock.advanceMinutes(4);
    const state = researchingState(testConfig(), clock.now);
    const harness = makeHarness(model, new FakeWorker(() => completedResult("text", [saved("https://a.org/x", "X", "why")], observed)), clock);
    await runSupervisorLoop(new RunContext(state, harness.deps, INPUT, new AbortController().signal));
    return state.notes[0] ?? "";
  }

  it("says opened, search result only, fetch did not complete and never seen", async () => {
    assert.match(await noteFor([fetchCall("https://a.org/x")]), /\[A1-S1\] X \(https:\/\/a\.org\/x\) - opened - why/);
    assert.match(await noteFor([hit("https://a.org/x")]), /\[A1-S1\] X \(https:\/\/a\.org\/x\) - search result only - why/);
    assert.match(await noteFor([hit("https://a.org/x"), failedFetchCall("https://a.org/x")]), /\[A1-S1\] X \(https:\/\/a\.org\/x\) - fetch did not complete \(it was in a search result\) - why/);
    assert.match(await noteFor([failedFetchCall("https://a.org/x")]), /\[not citable\] X \(https:\/\/a\.org\/x\) - fetch did not complete - why/);
    assert.match(await noteFor([]), /\[not citable\] X \(https:\/\/a\.org\/x\) - never seen by this worker - why/);
  });
});
