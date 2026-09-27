import {
  ZERO_USAGE,
  modernizeCitations,
  type ResearchPhase,
  type ResearchRunRecord,
  type ResearchRunView,
  type ResearchWorkerRecord,
  type ResearchWorkerView,
} from "@ancilla/daemon";
import type { WorkerUpdate } from "./sessionWorkerRunner.js";

/** What the job manager knows about a run beyond its row: the phase and round the latest events named. */
export interface LiveRunOverlay {
  phase: ResearchPhase | null;
  round: number | null;
  /** Live worker counters, keyed by agent id, kept by the runner while the run is in flight. */
  workers: Map<number, WorkerUpdate>;
}

export interface RunViewOptions {
  withReport: boolean;
  live?: LiveRunOverlay | null;
}

/**
 * The worker list: one entry per `research_workers` row, its topic from the state's delegations, its counters
 * from the live runner while the run is in flight and from the round's outcome summary afterwards.
 */
export function workerViews(record: ResearchRunRecord, rows: ResearchWorkerRecord[], live: LiveRunOverlay | null | undefined): ResearchWorkerView[] {
  const state = record.state;
  const views = new Map<number, ResearchWorkerView>();
  for (const row of rows) {
    const round = state?.rounds.find((r) => r.round === row.round) ?? null;
    const delegation = round?.delegations.find((d) => d.agentId === row.agentId) ?? null;
    const summary = round?.results.find((r) => r.agentId === row.agentId) ?? null;
    const update = live?.workers.get(row.agentId) ?? null;
    views.set(row.agentId, {
      agentId: row.agentId,
      round: row.round,
      topic: update?.topic ?? delegation?.topic ?? "",
      discovery: update?.discovery ?? delegation?.discovery ?? false,
      state: update?.state ?? (summary ? summary.status : row.status),
      toolCalls: update?.toolCalls ?? summary?.observedCount ?? 0,
      searches: update?.searches ?? 0,
      reads: update?.reads ?? 0,
      saved: update?.saved ?? summary?.savedCount ?? 0,
      startedAt: update?.startedAt ?? summary?.startedAt ?? null,
      endedAt: update?.endedAt ?? summary?.endedAt ?? null,
    });
  }
  // A worker the runner has reported but whose row has not landed yet still shows.
  for (const update of live?.workers.values() ?? []) {
    if (!views.has(update.agentId)) {
      views.set(update.agentId, {
        agentId: update.agentId,
        round: update.round,
        topic: update.topic,
        discovery: update.discovery,
        state: update.state,
        toolCalls: update.toolCalls,
        searches: update.searches,
        reads: update.reads,
        saved: update.saved,
        startedAt: update.startedAt,
        endedAt: update.endedAt,
      });
    }
  }
  return [...views.values()].sort((a, b) => a.round - b.round || a.agentId - b.agentId);
}

/** The wire summary of a run. The report only rides along when asked for, so lists stay small. */
export function runView(record: ResearchRunRecord, rows: ResearchWorkerRecord[], options: RunViewOptions): ResearchRunView {
  const state = record.state;
  const live = options.live ?? null;
  const finished = record.status === "completed" || record.status === "partial";
  const phase: ResearchPhase = finished ? "done" : (live?.phase ?? state?.phase ?? "scoping");
  const round = live?.round ?? state?.rounds.length ?? 0;
  return {
    runId: record.id,
    sessionId: record.sessionId,
    status: record.status,
    phase,
    question: record.question,
    brief: state?.brief ?? null,
    round,
    maxRounds: record.config.maxRounds,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    researchDeadlineAt: state?.researchDeadlineAt ?? null,
    workers: workerViews(record, rows, live),
    sources: {
      registry: state?.registry.length ?? 0,
      verified: state?.registry.filter((s) => s.verified).length ?? 0,
      curated: state?.curated.length ?? 0,
    },
    usage: state?.usage ?? { ...ZERO_USAGE },
    failure: record.failure,
    reportAvailable: record.report !== null && record.report.length > 0,
    report: options.withReport && record.report ? modernizeCitations(record.report) : null,
    reportPath: record.reportPath,
    config: record.config,
  };
}
