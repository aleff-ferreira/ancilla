import type { ResearchConfig } from "./config.js";
import type { ResearchPhase, ResearchStatus, TokenUsage, WorkerStatus } from "./types.js";

/** What the server tells clients about one worker. */
export interface ResearchWorkerView {
  agentId: number;
  round: number;
  topic: string;
  discovery: boolean;
  state: "queued" | "working" | WorkerStatus;
  toolCalls: number;
  searches: number;
  reads: number;
  saved: number;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * The wire summary of a run: what `GET /api/research`, the SSE `research-run` event and `loadTranscript` carry.
 * `report` is only filled by `GET /api/research/:runId`; lists say `reportAvailable` instead.
 */
export interface ResearchRunView {
  runId: string;
  sessionId: string;
  status: ResearchStatus;
  phase: ResearchPhase;
  question: string;
  brief: string | null;
  round: number;
  maxRounds: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  researchDeadlineAt: string | null;
  workers: ResearchWorkerView[];
  sources: { registry: number; verified: number; curated: number };
  usage: TokenUsage;
  failure: string | null;
  reportAvailable: boolean;
  report: string | null;
  /** Where the report was written inside the workspace, relative to the project folder; null until written. */
  reportPath: string | null;
  config: ResearchConfig;
}
