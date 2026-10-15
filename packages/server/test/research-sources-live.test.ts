/**
 * The source counts a run broadcasts while it goes. A source found in a search result and opened a round later moves
 * from one provenance count to another, so the counts of search-only and failed sources can fall while a run goes;
 * `evidence`, the sum of every registry entry's `evidenceRank`, is the one number a client can compare snapshots by.
 * Everything here runs the real engine and the real job manager over a scripted model and worker.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESEARCH_CONFIG, evidenceRank, runResearch, type ModelClient, type ModelRequest, type ResearchRunState, type ResearchRunView, type SourceEntry, type WorkerRunner } from "@ancilla/daemon";
import { ResearchJobManager, sourceCounts, type WorkerUpdate } from "../src/research/index.js";
import { deferred, fenced, newRun, seededStore, thread } from "./lifecycle-rig.js";
import { waitFor } from "./harness.js";

const X = "https://example.org/x";
const Y = "https://example.org/y";

const rankSum = (registry: readonly SourceEntry[]): number => registry.reduce((sum, entry) => sum + evidenceRank(entry), 0);

const entry = (n: number, verified: boolean, provenance?: SourceEntry["provenance"]): SourceEntry => ({ code: `A1-S${n}`, url: `https://e.example/${n}`, title: null, agentId: 1, round: 1, verified, ...(provenance ? { provenance } : {}) });

function stateOf(registry: SourceEntry[]): ResearchRunState {
  return {
    version: 1,
    runId: "run-1",
    eventSeq: 0,
    question: "q",
    config: DEFAULT_RESEARCH_CONFIG,
    phase: "researching",
    brief: null,
    inputLanguage: null,
    targetLanguage: null,
    draft: null,
    rounds: [],
    registry,
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    startedAt: "2026-10-13T10:00:00.000Z",
    researchDeadlineAt: "2026-10-13T10:10:00.000Z",
    nextAgentId: 1,
  };
}

describe("sourceCounts evidence", () => {
  it("sums the evidence rank of every registry entry, legacy rows and rows nothing observed included", () => {
    const registry = [entry(1, true, "retrieved"), entry(2, true, "search_only"), entry(3, false, "attempted"), entry(4, true, "attempted"), entry(5, false, "unobserved"), entry(6, true), entry(7, false)];
    const counts = sourceCounts(stateOf(registry), 0);
    assert.equal(counts.evidence, rankSum(registry));
    assert.equal(counts.evidence, 13 + 11 + 2 + 12 + 0 + 10 + 0);
  });

  it("stays a finite number for a provenance this build does not know, which JSON would turn into null", () => {
    // A later build may write a value this one cannot rank, and a damaged state may hold anything.
    const odd = entry(1, true, "some_future_value" as SourceEntry["provenance"]);
    assert.equal(evidenceRank(odd), 10, "an unknown provenance adds nothing beyond the citable point");
    assert.equal(evidenceRank({ ...odd, verified: false }), 0);
    const counts = sourceCounts(stateOf([odd, entry(2, true, "retrieved")]), 0);
    assert.equal(counts.evidence, 10 + 13);
    assert.equal(JSON.parse(JSON.stringify(counts)).evidence, 23, "it survives the wire");
  });

  it("is zero for a run with no registry, and for no state at all", () => {
    assert.equal(sourceCounts(stateOf([]), 0).evidence, 0);
    assert.equal(sourceCounts(null, 0).evidence, 0);
  });

  it("rises when a source takes stronger evidence and never when it does not, which a count of one provenance cannot say", () => {
    const before = sourceCounts(stateOf([entry(1, true, "search_only"), entry(2, true, "search_only")]), 0);
    const failed = sourceCounts(stateOf([entry(1, true, "search_only"), entry(2, true, "attempted")]), 0);
    const opened = sourceCounts(stateOf([entry(1, true, "search_only"), entry(2, true, "retrieved")]), 0);
    assert.ok((failed.evidence ?? 0) > (before.evidence ?? 0), "a search hit whose fetch then failed");
    assert.ok((opened.evidence ?? 0) > (failed.evidence ?? 0), "and then one that was opened");
    assert.equal(before.searchOnly, 2);
    assert.equal(opened.searchOnly, 1, "while the count of search-only sources fell");
  });
});

describe("the counts a two-round run broadcasts", () => {
  it("never lowers the registry, the citable, the curated, the opened or the evidence, though search-only and failed sources fall", async () => {
    const store = seededStore();
    const run = newRun(store, "c1");
    const release = deferred();
    let supervisorCalls = 0;
    const model: ModelClient = {
      complete: async (request: ModelRequest) => {
        if (request.role === "brief") {
          return { text: fenced({ research_brief: "Brief.", input_language: "English", target_language: "English" }), usage: null, modelId: null };
        }
        if (request.role === "supervisor") {
          supervisorCalls += 1;
          if (supervisorCalls === 3) {
            // The decision after the last worker's results are stored takes a while: the window the counts are read in.
            await release.promise;
          }
          const body = supervisorCalls <= 2 ? { reflection: "r", verdict: "CONTINUE_RESEARCH", delegations: [{ topic: `T${supervisorCalls}`, discovery: false }] } : { reflection: "done", verdict: "RESEARCH_COMPLETE", delegations: [] };
          return { text: fenced(body), usage: null, modelId: null };
        }
        return { text: "# Report\n\nAn answer [A1-S1].", usage: null, modelId: null };
      },
    };
    const broadcasts: { view: ResearchRunView; registry: SourceEntry[] }[] = [];
    const manager = new ResearchJobManager({
      store,
      engine: runResearch,
      createModelClient: () => model,
      createWorkerRunner: (r, _thread, onWorkerUpdate) => {
        const runner: WorkerRunner = {
          async run(task) {
            const update = (state: WorkerUpdate["state"], toolCalls: number): void => {
              onWorkerUpdate({
                runId: r.id, round: task.round, agentId: task.agentId, topic: task.topic, discovery: false, workerSessionId: `w${task.agentId}`,
                state, toolCalls, searches: 1, reads: 1, saved: 2,
                startedAt: new Date().toISOString(), endedAt: state === "working" ? null : new Date().toISOString(),
              });
            };
            const at = new Date().toISOString();
            update("working", 0);
            // The worker has made its last call: it finishes once a broadcast has shown that, so each round is seen by clients before its results are stored.
            const shown = broadcasts.length;
            update("working", 2);
            await waitFor(() => broadcasts.length > shown, "a broadcast of the worker at work");
            if (task.agentId === 1) {
              // Round one: X is only in a search result, and the fetch of Y failed.
              update("completed", 2);
              return {
                status: "completed", findings: "f", usage: null, error: null,
                saved: [{ url: X, title: "X", reason: "r", excerpt: null }, { url: Y, title: "Y", reason: "r", excerpt: null }],
                observed: [
                  { tool: "web_search", kind: "search", query: "q", urls: [], results: [{ url: X, title: "X" }], at, outcome: "ok", outputSize: 100 },
                  { tool: "web_fetch", kind: "fetch", query: null, urls: [Y], results: [], at, outcome: "failed", outputSize: 0 },
                ],
              };
            }
            // Round two opens X: the registry entry for X takes the stronger evidence when this result is merged.
            update("completed", 2);
            return {
              status: "completed", findings: "f2", usage: null, error: null,
              saved: [{ url: X, title: "X", reason: "r", excerpt: null }],
              observed: [{ tool: "web_fetch", kind: "fetch", query: null, urls: [X], results: [], at, outcome: "ok", outputSize: 500 }],
            };
          },
        };
        return runner;
      },
      broadcast: (view) => {
        // The view was read from the record a moment ago and nothing ran in between, so the stored registry is the view's.
        broadcasts.push({ view, registry: structuredClone(store.getResearchRun(view.runId)?.state?.registry ?? []) });
        if (view.sources.opened === 1 && view.round === 2) release.resolve();
      },
      writeReport: async () => null,
    });
    manager.start(store.getResearchRun(run.id)!, thread());
    await waitFor(() => !manager.isActive(run.id), "the run to end", 15_000);

    assert.equal(store.getResearchRun(run.id)?.status, "completed");
    assert.ok(broadcasts.length >= 3, `broadcasts: ${broadcasts.length}`);
    for (const { view, registry } of broadcasts) {
      assert.equal(view.sources.evidence, rankSum(registry), "the broadcast's evidence is the sum over the registry the run holds");
    }
    const monotone = ["registry", "verified", "curated", "opened", "evidence"] as const;
    for (let i = 1; i < broadcasts.length; i += 1) {
      const before = (broadcasts[i - 1] as (typeof broadcasts)[number]).view.sources;
      const after = (broadcasts[i] as (typeof broadcasts)[number]).view.sources;
      for (const key of monotone) {
        assert.ok((after[key] ?? 0) >= (before[key] ?? 0), `${key} fell from ${before[key]} to ${after[key]} between broadcasts ${i - 1} and ${i}`);
      }
    }
    const fell = broadcasts.some(({ view }, i) => {
      const before = (broadcasts[i - 1]?.view.sources ?? view.sources);
      return i > 0 && (view.sources.searchOnly ?? 0) < (before.searchOnly ?? 0) && (view.sources.opened ?? 0) > (before.opened ?? 0);
    });
    assert.ok(fell, "the run did move a source from search only to opened between two broadcasts, so the check above was tested by it");
    const last = (broadcasts.at(-1) as (typeof broadcasts)[number]).view.sources;
    assert.deepEqual([last.registry, last.opened, last.searchOnly, last.attempted], [2, 1, 0, 1]);
  });
});
