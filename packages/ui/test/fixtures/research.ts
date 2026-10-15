import type { ResearchRunView, ResearchSourceCounts, ResearchWorkerView } from "../../src/types.js";

/** The research scenario's run started at 14:02:00; `rs` counts minutes and seconds into it. */
export const R0 = Date.UTC(2026, 8, 26, 14, 2, 0);
export const rs = (m: number, s = 0): number => R0 + (m * 60 + s) * 1000;
/** Six minutes in: round one has landed one worker and lost one, round two has one out. */
export const RESEARCH_NOW = rs(6, 0);

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A worker row as the daemon reports one. */
export function fakeResearchWorker(over: Partial<ResearchWorkerView> & { agentId: number }): ResearchWorkerView {
  return { round: 1, topic: "a topic", discovery: false, state: "working", toolCalls: 0, searches: 0, reads: 0, saved: 0, startedAt: null, endedAt: null, ...over };
}

/** The Crew surfaces' research scenario: three workers in two rounds, one done, one failed, one working. */
export function runningResearch(over: Partial<ResearchRunView> = {}): ResearchRunView {
  const base = fakeResearchRun({});
  return fakeResearchRun({
    runId: "run-1",
    sessionId: "s1",
    status: "running",
    phase: "researching",
    question: "How do Radix Colors, GitHub Primer and Material 3 choose their muted text colours for dark themes, and what contrast do they land on?",
    round: 2,
    maxRounds: 12,
    createdAt: iso(rs(0, 0)),
    startedAt: iso(rs(0, 1)),
    endedAt: null,
    researchDeadlineAt: iso(rs(10, 1)),
    workers: [
      fakeResearchWorker({ agentId: 1, round: 1, topic: "Radix Colors dark scales", state: "completed", toolCalls: 6, searches: 2, reads: 3, saved: 1, startedAt: iso(rs(0, 20)), endedAt: iso(rs(2, 10)) }),
      fakeResearchWorker({ agentId: 2, round: 1, topic: "Primer's functional colour roles", state: "failed", toolCalls: 1, searches: 1, startedAt: iso(rs(0, 20)), endedAt: iso(rs(1, 0)) }),
      fakeResearchWorker({ agentId: 3, round: 2, topic: "Material 3 tonal palettes", state: "working", toolCalls: 3, searches: 2, reads: 1, startedAt: iso(rs(3, 0)) }),
    ],
    sources: { registry: 9, verified: 7, curated: 0 },
    usage: { inputTokens: 88_300, outputTokens: 3_120, cachedInputTokens: 40_100, totalTokens: 91_420 },
    config: { ...base.config, models: { supervisor: null, worker: "muse-spark-1.3", writer: null } },
    ...over,
  });
}

/** One registry entry as the server holds it: whether it can be cited, and how the worker reached it (absent on a legacy row). */
export interface FakeSource {
  verified: boolean;
  provenance?: "retrieved" | "attempted" | "search_only" | "unobserved";
}

const FAKE_PROVENANCE_RANK = { retrieved: 3, attempted: 2, search_only: 1, unobserved: 0 } as const;

/**
 * The strength of an entry's evidence, as the daemon's `evidenceRank` computes it. The real function and the
 * server's `sourceCounts` are checked by packages/server/test/research-sources-live.test.ts; nothing ties this copy
 * to them, so a change to the ranks there is a change here.
 */
export function fakeEvidenceRank(source: FakeSource): number {
  return (source.verified ? 10 : 0) + FAKE_PROVENANCE_RANK[source.provenance ?? "unobserved"];
}

/** The source counts the server derives from a registry, kept in step with `sourceCounts` in the server by hand. */
export function fakeSourceCounts(registry: readonly FakeSource[], curated = 0): ResearchSourceCounts {
  const count = (provenance: string): number => registry.filter((s) => s.provenance === provenance).length;
  return {
    registry: registry.length,
    verified: registry.filter((s) => s.verified).length,
    curated,
    opened: count("retrieved"),
    searchOnly: count("search_only"),
    attempted: count("attempted"),
    listedEarlier: registry.filter((s) => s.provenance === undefined && s.verified).length,
    evidence: registry.reduce((sum, s) => sum + fakeEvidenceRank(s), 0),
  };
}

/** A run view with every field filled, for the fake client and for render tests. */
export function fakeResearchRun(over: Partial<ResearchRunView>): ResearchRunView {
  return {
    runId: "run-1",
    sessionId: "s1",
    status: "running",
    phase: "researching",
    question: "How is geothermal energy developing in Europe?",
    brief: null,
    round: 1,
    maxRounds: 12,
    createdAt: "2026-09-26T00:00:00.000Z",
    startedAt: "2026-09-26T00:00:01.000Z",
    endedAt: null,
    researchDeadlineAt: "2026-09-26T00:10:01.000Z",
    workers: [],
    sources: { registry: 0, verified: 0, curated: 0 },
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    failure: null,
    reportAvailable: false,
    report: null,
    reportPath: null,
    config: {
      windowMinMinutes: 3,
      windowMaxMinutes: 10,
      maxRounds: 12,
      maxParallel: 3,
      workerMaxToolCalls: 25,
      workerMaxSearches: 3,
      workerMaxReads: 10,
      workerMaxSaves: 10,
      workerWallTimeMinutes: 10,
      draftFirst: false,
      salvageFraction: 0.6,
      tokenSoftCap: null,
      trace: false,
      models: { supervisor: null, worker: null, writer: null },
    },
    ...over,
  };
}
