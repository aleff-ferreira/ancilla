import type { ResearchRunView } from "../../src/types.js";

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
