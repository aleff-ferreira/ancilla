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
 * The source counts of a run. `verified` is how many sources can be cited. The four that follow say how the sources
 * were reached and are optional because a view from before provenance has none: `opened` (a fetch of the page
 * ended ok), `searchOnly` (seen in search results only), `attempted` (a fetch failed, was cancelled or never reported), and `listedEarlier` (rows an
 * earlier version marked verified without recording how, so they are not claimed as opened). `searchOnly`,
 * `attempted` and `listedEarlier` can fall while a run goes, because a source found in a search result and opened
 * later moves from one count to another; `evidence` is the one number that cannot: the sum of every registry entry's
 * `evidenceRank`, which only grows while a run goes, so a client can tell which of two snapshots is the later.
 */
export interface ResearchSourceCounts {
  registry: number;
  verified: number;
  curated: number;
  opened?: number;
  searchOnly?: number;
  attempted?: number;
  listedEarlier?: number;
  evidence?: number;
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
  sources: ResearchSourceCounts;
  usage: TokenUsage;
  failure: string | null;
  /** How many times the run was resumed after an interruption. Clients compare it before anything else when two snapshots of one run disagree. */
  resumes?: number;
  reportAvailable: boolean;
  report: string | null;
  /** Where the report was written inside the workspace, relative to the project folder; null until written. */
  reportPath: string | null;
  /** Why the report has no file, when the project would not take it; the report itself is still in Ancilla. */
  reportWriteError?: string | null;
  /** Present, and true, when the report was written with no citable source at all. */
  noCitableSources?: boolean;
  config: ResearchConfig;
}
