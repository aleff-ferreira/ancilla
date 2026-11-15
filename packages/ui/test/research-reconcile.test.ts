/**
 * How a thread's research runs are reconciled with a snapshot of them (a stream event, the answer to a stop or a
 * read, a transcript reload, a list read after a reconnect): the union by run id, the precedence between two
 * pictures of one run, and the guarantee that a snapshot which changes nothing changes nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileResearchRuns } from "../src/model/research.js";
import { unionById } from "../src/model/union.js";
import type { ResearchRunView } from "../src/types.js";
import { fakeEvidenceRank, fakeResearchRun, fakeResearchWorker, fakeSourceCounts, type FakeSource } from "./fixtures/research.js";

/** A small deterministic generator (mulberry32), so the loop below is the same on every machine and every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const live = (over: Partial<ResearchRunView> = {}): ResearchRunView => fakeResearchRun({ runId: "r1", status: "running", phase: "researching", round: 2, ...over });
const ended = (over: Partial<ResearchRunView> = {}): ResearchRunView => fakeResearchRun({ runId: "r1", status: "cancelled", phase: "done", round: 2, endedAt: "2026-09-26T00:05:00.000Z", ...over });
const interrupted = (over: Partial<ResearchRunView> = {}): ResearchRunView => ended({ status: "interrupted", phase: "researching", failure: "interrupted: the server stopped while the run was in flight.", ...over });

describe("reconcileResearchRuns: the union", () => {
  it("keeps a run only this client knows, and adds one only the snapshot knows", () => {
    const local = [live({ runId: "a" })];
    const merged = reconcileResearchRuns(local, [live({ runId: "b", createdAt: "2026-09-26T00:05:00.000Z" })]);
    assert.deepEqual(merged.map((r) => r.runId), ["a", "b"]);
    assert.equal(merged[0], local[0], "the run it already had stays the same object");
  });

  it("never drops a run because a snapshot predates it, and says nothing changed", () => {
    const local = [live({ runId: "a" }), ended({ runId: "b" })];
    assert.equal(reconcileResearchRuns(local, []), local);
    assert.equal(reconcileResearchRuns(local, [live({ runId: "a", round: 1 })]), local, "an older picture of one run leaves the whole list alone");
  });

  it("starts from an empty list with the snapshot as it came", () => {
    const incoming = [live({ runId: "a" }), ended({ runId: "b" })];
    const merged = reconcileResearchRuns([], incoming);
    assert.deepEqual(merged, incoming);
  });

  it("does not touch what it was given", () => {
    const local = Object.freeze([Object.freeze(live({ runId: "a" }))]);
    const incoming = Object.freeze([Object.freeze(live({ runId: "a", round: 3 })), Object.freeze(live({ runId: "b" }))]);
    const merged = reconcileResearchRuns(local, incoming);
    assert.equal(merged.length, 2);
    assert.equal(local[0]?.round, 2);
  });
});

describe("reconcileResearchRuns: an ending", () => {
  it("is never taken back to live by a later snapshot of the live run", () => {
    const local = [ended()];
    assert.equal(reconcileResearchRuns(local, [live({ round: 9, phase: "writing" })]), local);
  });

  it("supersedes a live run whatever the progress heuristic says", () => {
    // A restart's interrupted snapshot is behind the stale live row on every measure: it has no workers and no round open.
    const local = [live({ round: 3, phase: "writing", workers: [fakeResearchWorker({ agentId: 1, toolCalls: 12 })] })];
    const merged = reconcileResearchRuns(local, [interrupted({ round: 1, phase: "scoping", workers: [] })]);
    assert.equal(merged[0]?.status, "interrupted");
    assert.equal(merged[0]?.failure, "interrupted: the server stopped while the run was in flight.");
  });

  it("lets one ending correct another, the later answer winning", () => {
    const merged = reconcileResearchRuns([ended()], [ended({ status: "partial", reportAvailable: true })]);
    assert.equal(merged[0]?.status, "partial");
  });

  it("keeps a report already read when the summary that ends the run carries none", () => {
    const local = [ended({ status: "completed", reportAvailable: true, report: "# Report" })];
    const same = reconcileResearchRuns(local, [ended({ status: "completed", reportAvailable: true, report: null })]);
    assert.equal(same, local, "nothing about the run changed, so nothing did");
    const moved = reconcileResearchRuns([live({ report: "# Report", reportAvailable: true })], [ended({ status: "completed", reportAvailable: true, report: null })]);
    assert.equal(moved[0]?.status, "completed");
    assert.equal(moved[0]?.report, "# Report", "the report rides over the ending");
  });

  it("does not hand the report read from one attempt to the ended summary of the attempt that resumed it", () => {
    const local = [ended({ status: "partial", resumes: 0, reportAvailable: true, report: "# First attempt" })];
    const merged = reconcileResearchRuns(local, [ended({ status: "completed", resumes: 1, reportAvailable: true, report: null })]);
    assert.equal(merged[0]?.status, "completed");
    assert.equal(merged[0]?.report, null, "the row reads the new report instead of believing it already has it");
    const same = reconcileResearchRuns([ended({ status: "partial", resumes: 1, reportAvailable: true, report: "# Second" })], [ended({ status: "completed", resumes: 1, reportAvailable: true, report: null })]);
    assert.equal(same[0]?.report, "# Second", "within one attempt the report still rides over (regression guard)");
  });

  it("does not keep a report the server no longer says is there", () => {
    const merged = reconcileResearchRuns([ended({ status: "completed", reportAvailable: true, report: "# Old" })], [ended({ status: "failed", reportAvailable: false, report: null })]);
    assert.equal(merged[0]?.report, null);
  });
});

describe("reconcileResearchRuns: a resumed run", () => {
  it("compares the counter before anything else: a lower one loses whatever its status", () => {
    const resumed = live({ resumes: 1, round: 2 });
    const local = [resumed];
    assert.equal(reconcileResearchRuns(local, [interrupted({ resumes: 0 })]), local, "a stale interrupted snapshot does not flip the resumed run back");
    assert.equal(reconcileResearchRuns(local, [ended({ resumes: 0 })]), local);
    assert.equal(reconcileResearchRuns(local, [live({ resumes: 0, round: 9, phase: "writing" })]), local, "nor does a stale live one that is further along");
  });

  it("takes the higher counter over its ended predecessor, and over a stale live row further along", () => {
    const merged = reconcileResearchRuns([interrupted({ resumes: 0 })], [live({ resumes: 1, round: 1, phase: "drafting" })]);
    assert.equal(merged[0]?.status, "running");
    assert.equal(merged[0]?.resumes, 1);
    const stale = reconcileResearchRuns([live({ resumes: 0, workers: [fakeResearchWorker({ agentId: 1, toolCalls: 12 })] })], [live({ resumes: 1, workers: [fakeResearchWorker({ agentId: 1, toolCalls: 5 })] })]);
    assert.equal(stale[0]?.resumes, 1, "five calls of the resumed run beat twelve of the one it replaced");
  });

  it("replaces the predecessor exactly once", () => {
    const first = [interrupted({ resumes: 0 })];
    const once = reconcileResearchRuns(first, [live({ resumes: 1 })]);
    assert.notEqual(once, first);
    assert.equal(once.length, 1);
    const again = reconcileResearchRuns(once, [live({ resumes: 1 })]);
    assert.equal(again, once, "the same snapshot again changes nothing");
    assert.equal(reconcileResearchRuns(once, [interrupted({ resumes: 0 })]), once, "and the old ending does not come back");
  });

  it("reads a missing counter as zero, from an older server", () => {
    const old = interrupted();
    assert.equal(old.resumes, undefined);
    assert.equal(reconcileResearchRuns([old], [live({ resumes: 1 })])[0]?.status, "running");
    const local = [live({ resumes: 1 })];
    assert.equal(reconcileResearchRuns(local, [interrupted()]), local);
    const plain = [ended()];
    assert.equal(reconcileResearchRuns(plain, [live({ resumes: 0 })]), plain, "zero and missing are the same counter");
  });
});

describe("reconcileResearchRuns: two pictures of a live run", () => {
  it("keeps the more advanced one whichever arrives last", () => {
    const ahead = [live({ round: 3 })];
    assert.equal(reconcileResearchRuns(ahead, [live({ round: 2 })]), ahead);
    assert.equal(reconcileResearchRuns([live({ round: 2 })], [live({ round: 3 })])[0]?.round, 3);
    assert.equal(reconcileResearchRuns([live({ status: "queued", phase: "scoping", round: 0 })], [live({ round: 0, phase: "scoping" })])[0]?.status, "running");
  });

  it("lets the later arrival win a tie, without letting it take back what only grows", () => {
    const local = [
      live({
        brief: "old brief",
        workers: [fakeResearchWorker({ agentId: 1, state: "completed", toolCalls: 3, searches: 2, reads: 1, saved: 1, endedAt: "2026-09-26T00:02:00.000Z" })],
        sources: { registry: 9, verified: 7, curated: 2 },
        usage: { inputTokens: 8000, outputTokens: 1000, cachedInputTokens: 500, totalTokens: 9000 },
      }),
    ];
    const older = live({
      brief: "newer brief",
      workers: [fakeResearchWorker({ agentId: 1, state: "working", toolCalls: 3, searches: 1, reads: 0, saved: 0 })],
      sources: { registry: 3, verified: 1, curated: 0 },
      usage: { inputTokens: 1800, outputTokens: 200, cachedInputTokens: 0, totalTokens: 2000 },
    });
    const merged = reconcileResearchRuns(local, [older])[0] as ResearchRunView;
    assert.equal(merged.brief, "newer brief", "a tie still goes to the one that arrived last");
    assert.equal(merged.workers[0]?.state, "completed", "a finished worker is not put back to work");
    assert.equal(merged.workers[0]?.searches, 2);
    assert.equal(merged.workers[0]?.endedAt, "2026-09-26T00:02:00.000Z");
    assert.deepEqual(merged.sources, { registry: 9, verified: 7, curated: 2 });
    assert.equal(merged.usage.totalTokens, 9000);
    assert.equal(merged.usage.inputTokens, 8000);
  });

  it("takes a tie that only adds, as it came", () => {
    const local = [live({ sources: { registry: 3, verified: 1, curated: 0 }, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 } })];
    const incoming = live({ sources: { registry: 5, verified: 2, curated: 1 }, usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, totalTokens: 5 } });
    assert.deepEqual(reconcileResearchRuns(local, [incoming])[0], incoming);
  });
});

describe("reconcileResearchRuns: the source counts of a tie", () => {
  const R: FakeSource = { verified: true, provenance: "retrieved" };
  const S: FakeSource = { verified: true, provenance: "search_only" };
  const A: FakeSource = { verified: true, provenance: "attempted" };
  const category = (s: ResearchRunView["sources"]): number => (s.opened ?? 0) + (s.searchOnly ?? 0) + (s.attempted ?? 0) + (s.listedEarlier ?? 0);
  // The same six sources before and after a round's pages were opened: two search-only hits and a failed fetch became opened.
  const older = fakeSourceCounts([R, S, S, S, A, A], 5);
  const newer = fakeSourceCounts([R, R, S, S, A, R], 5);

  it("takes the snapshot that arrives last whole when it is the more advanced, not a maximum of each count", () => {
    assert.equal(older.searchOnly, 3);
    assert.equal(newer.searchOnly, 2);
    const merged = reconcileResearchRuns([live({ sources: older })], [live({ sources: newer })])[0] as ResearchRunView;
    assert.deepEqual(merged.sources, newer);
    assert.ok(category(merged.sources) <= merged.sources.registry, "never more categories than sources");
  });

  it("keeps the more advanced one whole when the older one arrives last", () => {
    const local = [live({ sources: newer })];
    const merged = reconcileResearchRuns(local, [live({ sources: older })]);
    assert.deepEqual(merged[0]?.sources, newer);
    assert.equal(merged, local, "and nothing else about the run changed");
  });

  it("ignores a stale lower snapshot that is behind on a progress measure as well", () => {
    const local = [live({ round: 3, sources: newer })];
    assert.equal(reconcileResearchRuns(local, [live({ round: 2, sources: older })]), local);
  });

  it("still takes the later arrival's other fields on a tie while it holds the more advanced sources", () => {
    const merged = reconcileResearchRuns([live({ brief: "old brief", sources: newer })], [live({ brief: "new brief", sources: older })])[0] as ResearchRunView;
    assert.equal(merged.brief, "new brief");
    assert.deepEqual(merged.sources, newer);
  });

  it("keeps the usage per count while the sources are chosen whole", () => {
    const usage = (totalTokens: number) => ({ inputTokens: totalTokens, outputTokens: 0, cachedInputTokens: 0, totalTokens });
    const merged = reconcileResearchRuns([live({ sources: older, usage: usage(9000) })], [live({ sources: newer, usage: usage(2000) })])[0] as ResearchRunView;
    assert.deepEqual(merged.sources, newer);
    assert.equal(merged.usage.totalTokens, 9000);
  });

  it("tells two snapshots apart by the evidence when the other counts are level", () => {
    // One search-only source became a failed fetch: no opened count moves, only the evidence does.
    const before = fakeSourceCounts([R, S, S], 0);
    const after = fakeSourceCounts([R, S, A], 0);
    assert.equal(before.opened, after.opened);
    assert.deepEqual(reconcileResearchRuns([live({ sources: before })], [live({ sources: after })])[0]?.sources, after);
    assert.deepEqual(reconcileResearchRuns([live({ sources: after })], [live({ sources: before })])[0]?.sources, after);
  });

  it("falls back to the counts it has from a server that sends no evidence, and from one that sends no provenance", () => {
    const bare = (counts: ResearchRunView["sources"]): ResearchRunView["sources"] => {
      const rest = { ...counts };
      delete rest.evidence;
      return rest;
    };
    const merged = reconcileResearchRuns([live({ sources: bare(older) })], [live({ sources: bare(newer) })])[0] as ResearchRunView;
    assert.deepEqual(merged.sources, bare(newer), "opened rose, so the later snapshot is whole");
    const kept = reconcileResearchRuns([live({ sources: bare(newer) })], [live({ sources: bare(older) })])[0] as ResearchRunView;
    assert.deepEqual(kept.sources, bare(newer), "opened fell, so the earlier one stays whole");
    const plain = { registry: 9, verified: 7, curated: 2 };
    assert.deepEqual(reconcileResearchRuns([live({ sources: plain })], [live({ sources: { registry: 3, verified: 1, curated: 0 } })])[0]?.sources, plain);
    assert.deepEqual(reconcileResearchRuns([live({ sources: { registry: 3, verified: 1, curated: 0 } })], [live({ sources: plain })])[0]?.sources, plain);
    const mixed = reconcileResearchRuns([live({ sources: { registry: 3, verified: 1, curated: 0 } })], [live({ sources: newer })])[0] as ResearchRunView;
    assert.deepEqual(mixed.sources, newer, "a snapshot with counts is not held back by one that has none");
  });

  it("holds the earlier counts of a server with no provenance when only the citable count has fallen", () => {
    // Level on the registry and the curated list, lower on verified, and nothing else to compare: no opened, no evidence.
    const earlier = { registry: 5, verified: 4, curated: 1 };
    const later = { registry: 5, verified: 3, curated: 1 };
    const local = [live({ sources: earlier })];
    assert.equal(reconcileResearchRuns(local, [live({ sources: later })]), local, "the lower citable count is the older picture");
    assert.deepEqual(reconcileResearchRuns([live({ sources: later })], [live({ sources: earlier })])[0]?.sources, earlier, "and the higher one is taken when it arrives last");
  });

  it("takes a resumed attempt whole at level progress, where a held gain would put the earlier attempt back", () => {
    // A resumed attempt starts again from what the run had found, but its picture can be lower on any count.
    const usage = (totalTokens: number) => ({ inputTokens: totalTokens, outputTokens: 0, cachedInputTokens: 0, totalTokens });
    const first = live({
      resumes: 0,
      workers: [fakeResearchWorker({ agentId: 1, state: "completed", toolCalls: 6, searches: 3, reads: 2, saved: 1 })],
      sources: fakeSourceCounts([R, R, S, S], 2),
      usage: usage(9000),
    });
    const second = live({
      resumes: 1,
      workers: [fakeResearchWorker({ agentId: 1, state: "working", toolCalls: 6, searches: 3, reads: 2, saved: 1 })],
      sources: fakeSourceCounts([S, S], 0),
      usage: usage(1000),
    });
    const merged = reconcileResearchRuns([first], [second])[0] as ResearchRunView;
    assert.deepEqual(merged, second, "the new attempt is the picture, not a blend with the one it replaced");
    assert.equal(merged.workers[0]?.state, "working");
    assert.equal(merged.usage.totalTokens, 1000);
    assert.equal(merged.sources.registry, 2);
    // Within one attempt the same pair is a tie, and what the first attempt gained is held.
    const tie = reconcileResearchRuns([{ ...first, resumes: 1 }], [second])[0] as ResearchRunView;
    assert.equal(tie.workers[0]?.state, "completed");
    assert.equal(tie.usage.totalTokens, 9000);
    assert.equal(tie.sources.registry, 4);
  });

  it("never compares an evidence total that is not a number, such as the null JSON makes of NaN", () => {
    const withEvidence = (evidence: unknown, registry: number): ResearchRunView["sources"] => ({ registry, verified: registry, curated: 0, opened: 0, searchOnly: registry, attempted: 0, listedEarlier: 0, evidence: evidence as number });
    for (const odd of [null, Number.NaN]) {
      // The later snapshot has more sources; its evidence is unreadable, which must not read as behind.
      const merged = reconcileResearchRuns([live({ sources: withEvidence(11, 1) })], [live({ sources: withEvidence(odd, 2) })])[0] as ResearchRunView;
      assert.equal(merged.sources.registry, 2, `evidence ${String(odd)} on the later snapshot`);
      // And the held snapshot's unreadable evidence does not hold back a later one that has some.
      const after = reconcileResearchRuns([live({ sources: withEvidence(odd, 1) })], [live({ sources: withEvidence(12, 2) })])[0] as ResearchRunView;
      assert.equal(after.sources.registry, 2, `evidence ${String(odd)} on the held snapshot`);
    }
    // A number that is readable still decides, so the guard did not turn the comparison off.
    const local = [live({ sources: withEvidence(11, 2) })];
    assert.equal(reconcileResearchRuns(local, [live({ sources: withEvidence(10, 2) })]), local);
  });

  it("is never behind on a count that only the curated list moves", () => {
    const more = { ...newer, curated: 6 };
    assert.deepEqual(reconcileResearchRuns([live({ sources: newer })], [live({ sources: more })])[0]?.sources, more);
    assert.deepEqual(reconcileResearchRuns([live({ sources: more })], [live({ sources: newer })])[0]?.sources, more);
  });

  it("shows, for any two snapshots a registry went through, the more advanced one in either arrival order", () => {
    // A registry grows the way the supervisor's merge grows it: a new source, or a shared one that takes stronger evidence.
    const options: FakeSource[] = [
      { verified: false },
      { verified: true },
      { verified: false, provenance: "unobserved" },
      { verified: true, provenance: "search_only" },
      { verified: false, provenance: "attempted" },
      { verified: true, provenance: "attempted" },
      { verified: true, provenance: "retrieved" },
    ];
    let pairs = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = seededRandom(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
      const registry: FakeSource[] = [];
      let curated = 0;
      const snapshots: ResearchRunView["sources"][] = [];
      for (let step = 0; step < 24; step += 1) {
        if (registry.length === 0 || next() < 0.4) {
          registry.push({ ...pick(options) });
        } else {
          const index = Math.floor(next() * registry.length);
          const found = pick(options);
          if (fakeEvidenceRank(found) > fakeEvidenceRank(registry[index] as FakeSource)) registry[index] = { ...found };
        }
        if (next() < 0.3) curated += 1;
        snapshots.push(fakeSourceCounts(registry, curated));
      }
      for (let i = 0; i < snapshots.length; i += 1) {
        for (let j = i; j < snapshots.length; j += 2) {
          const early = snapshots[i] as ResearchRunView["sources"];
          const late = snapshots[j] as ResearchRunView["sources"];
          for (const [held, arriving] of [[early, late], [late, early]] as const) {
            const shown = reconcileResearchRuns([live({ sources: held })], [live({ sources: arriving })])[0]?.sources as ResearchRunView["sources"];
            assert.deepEqual(shown, late, `seed ${seed}, snapshots ${i} and ${j}: the later one is shown`);
            assert.ok(category(shown) <= shown.registry, `seed ${seed}, snapshots ${i} and ${j}: no more categories than sources`);
          }
          pairs += 1;
        }
      }
    }
    assert.ok(pairs > 1000, "the loop really ran");
  });
});

describe("reconcileResearchRuns: the placeholder", () => {
  const placeholder = (): ResearchRunView => live({ runId: "pending:abc", status: "queued", phase: "scoping", round: 0 });

  it("goes once a real live run is in the list", () => {
    const merged = reconcileResearchRuns([placeholder()], [live({ runId: "real-1" })]);
    assert.deepEqual(merged.map((r) => r.runId), ["real-1"]);
  });

  it("goes when the snapshot that brings the real run arrives while the placeholder is still there beside other runs", () => {
    const old = ended({ runId: "old" });
    const merged = reconcileResearchRuns([old, placeholder()], [live({ runId: "real-1" })]);
    assert.deepEqual(merged.map((r) => r.runId), ["old", "real-1"]);
  });

  it("stays while nothing real is live, and beside a run that already ended", () => {
    const local = [placeholder()];
    assert.equal(reconcileResearchRuns(local, []), local);
    assert.equal(reconcileResearchRuns(local, [ended({ runId: "old" })]).length, 2);
  });

  it("is swapped for the answer in one step when the caller names it", () => {
    const merged = reconcileResearchRuns([placeholder()], [ended({ runId: "real-1", status: "completed", phase: "done" })], "pending:abc");
    assert.deepEqual(merged.map((r) => r.runId), ["real-1"], "even a run that has already ended replaces it");
    const none = [live({ runId: "real-1" })];
    assert.equal(reconcileResearchRuns(none, [live({ runId: "real-1" })], "pending:abc"), none, "a placeholder already gone is not an update");
  });
});

describe("reconcileResearchRuns: nothing new, nothing returned", () => {
  it("returns the list it was given for a snapshot equal to it, and keeps the old element where only another run changed", () => {
    const a = live({ runId: "a", workers: [fakeResearchWorker({ agentId: 1, toolCalls: 2 })] });
    const b = ended({ runId: "b" });
    const local = [a, b];
    const copy = JSON.parse(JSON.stringify([a, b])) as ResearchRunView[];
    assert.equal(reconcileResearchRuns(local, copy), local);
    const moved = reconcileResearchRuns(local, [{ ...copy[0], round: 3 } as ResearchRunView, copy[1] as ResearchRunView]);
    assert.notEqual(moved, local);
    assert.equal(moved[1], b, "the element that did not change is the old one");
    assert.equal(moved[0]?.round, 3);
  });
});

describe("unionById", () => {
  it("keeps what it has, first and as it is, and adds what is new after it", () => {
    const local = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
    const merged = unionById(local, [{ id: "b", v: 2 }, { id: "c", v: 1 }]);
    assert.deepEqual(merged, [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }]);
    assert.equal(merged[0], local[0]);
  });

  it("returns the list it was given when the snapshot adds nothing", () => {
    const local = [{ id: "a" }];
    assert.equal(unionById(local, []), local);
    assert.equal(unionById(local, [{ id: "a" }]), local);
  });

  it("is the snapshot when it starts from nothing", () => {
    const incoming = [{ id: "a" }, { id: "b" }];
    assert.deepEqual(unionById([], incoming), incoming);
  });
});
