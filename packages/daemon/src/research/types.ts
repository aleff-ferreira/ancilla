/**
 * DeepResearch engine contracts.
 *
 * The engine (`./engine.js`) is a port of Deep Dog 2's control plane (see UPSTREAM.md in this folder): it plans a
 * research brief, runs a supervisor loop that delegates focused tasks to parallel research workers, tracks every
 * source those workers actually touched, and writes a cited report. It owns no model, no network and no clock: the
 * host hands it a `ModelClient` for tool-less completions, a `WorkerRunner` that runs one delegated task with
 * whatever search and read tools the runtime has, an `EventSink`, and a checkpoint callback. In Ancilla the host is
 * the server and the runtime behind both is Muse; in tests the host is a handful of fakes.
 */

export type ModelRole = "brief" | "draft" | "supervisor" | "writer";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage | null | undefined): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Why a model call or a worker run failed; `retryable` decides whether the engine tries again. */
export type ResearchFailureKind =
  | "timeout"
  | "cancelled"
  | "auth"
  | "quota"
  | "rate_limited"
  | "unavailable"
  | "invalid_output"
  | "other";

export class ResearchFailure extends Error {
  readonly kind: ResearchFailureKind;
  constructor(kind: ResearchFailureKind, message: string) {
    super(message);
    this.name = "ResearchFailure";
    this.kind = kind;
  }
  /** Auth and quota failures end the run; the others may be retried once. */
  get fatal(): boolean {
    return this.kind === "auth" || this.kind === "quota" || this.kind === "cancelled";
  }
  get retryable(): boolean {
    return this.kind === "timeout" || this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "other";
  }
}

export interface ModelRequest {
  role: ModelRole;
  /** The whole prompt, instructions and material together; the host adds nothing. */
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  text: string;
  usage: TokenUsage | null;
  modelId: string | null;
}

/** One tool-less completion. Rejects with a `ResearchFailure` on timeout, abort or transport trouble. */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface WorkerTask {
  runId: string;
  round: number;
  /** 1-based, unique within the run; citation codes carry it as `A{agentId}`. */
  agentId: number;
  topic: string;
  /** Discovery maps a topic broadly; research answers a focused question. Changes the prompt and the budgets. */
  discovery: boolean;
  /** The complete instructions for the worker, prompt and task together. */
  instructions: string;
  /** The supervisor may raise the read allowance for one task. */
  maxReads: number | null;
}

export interface WorkerBudgets {
  maxToolCalls: number;
  maxSearches: number;
  maxReads: number;
  maxSaves: number;
  wallTimeMs: number;
}

/** A tool call the runtime made on the worker's behalf, as the host observed it. Ground truth for provenance. */
export interface ObservedToolCall {
  tool: string;
  kind: "search" | "fetch" | "other";
  query: string | null;
  /** URLs named in the call's arguments (fetches) or returned by it (searches). */
  urls: string[];
  results: { url: string; title: string | null }[];
  at: string;
}

export interface WorkerProgress {
  toolCalls: number;
  searches: number;
  reads: number;
}

export interface WorkerSink {
  onToolCall(call: ObservedToolCall): void;
  onProgress(progress: WorkerProgress): void;
}

export type WorkerStatus = "completed" | "failed" | "timed_out" | "cancelled";

export interface SavedSource {
  url: string;
  title: string | null;
  reason: string;
  excerpt: string | null;
}

export interface WorkerResult {
  status: WorkerStatus;
  /** The worker's own account of what it found, Markdown. Empty when it produced nothing. */
  findings: string;
  /** Sources the worker chose to keep, as it reported them. */
  saved: SavedSource[];
  /** Every tool call the host saw, in order. */
  observed: ObservedToolCall[];
  usage: TokenUsage | null;
  /** Set when status is not `completed`; a `ResearchFailureKind` word first when known, e.g. "quota: ...". */
  error: string | null;
}

/** Runs one delegated task to completion under the budgets. Never rejects: trouble comes back in `status`. */
export interface WorkerRunner {
  run(task: WorkerTask, budgets: WorkerBudgets, signal: AbortSignal, sink: WorkerSink): Promise<WorkerResult>;
}

export type ResearchEventType =
  | "run_started"
  | "scope_started"
  | "scope_completed"
  | "draft_started"
  | "draft_completed"
  | "supervisor_iteration"
  | "delegation_started"
  | "subagent_started"
  | "subagent_completed"
  | "subagent_failed"
  | "worker_tool_call"
  | "source_found"
  | "source_read"
  | "source_saved"
  | "report_started"
  | "citations_validated"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "run_interrupted"
  | "run_resumed";

/** Content-free progress record, the same vocabulary as Deep Dog 2's product events. `seq` is per run, from 1. */
export interface ResearchEvent {
  type: ResearchEventType;
  runId: string;
  seq: number;
  at: string;
  phase: ResearchPhase | null;
  round: number | null;
  agentId: number | null;
  payload: Record<string, unknown>;
}

export interface EventSink {
  emit(event: ResearchEvent): void;
}

export type ResearchPhase = "scoping" | "drafting" | "researching" | "writing" | "done";

export type ResearchStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";

export interface SourceEntry {
  /** `A{agentId}-S{n}` while research runs; `finalizeCitations` renumbers cited ones to `[1..N]`. */
  code: string;
  url: string;
  title: string | null;
  agentId: number;
  round: number;
  /** True when the worker's observed searches or fetches contain the URL. Only verified sources can be cited. */
  verified: boolean;
}

export interface CuratedSource extends SavedSource {
  agentId: number;
  round: number;
  verified: boolean;
}

export type SupervisorVerdict = "CONTINUE_RESEARCH" | "RESEARCH_COMPLETE";

export interface Delegation {
  agentId: number;
  topic: string;
  discovery: boolean;
  maxReads: number | null;
}

export interface WorkerOutcomeSummary {
  agentId: number;
  status: WorkerStatus;
  findingsChars: number;
  savedCount: number;
  verifiedCount: number;
  observedCount: number;
  usage: TokenUsage | null;
  error: string | null;
  startedAt: string;
  endedAt: string;
}

export interface SupervisorRound {
  round: number;
  startedAt: string;
  endedAt: string | null;
  reflection: string;
  verdict: SupervisorVerdict | null;
  delegations: Delegation[];
  results: WorkerOutcomeSummary[];
  /** Why the loop ended after this round, when it did. */
  exit: string | null;
}

/** Everything the engine knows, JSON only. Checkpointed after each phase and each supervisor round. */
export interface ResearchRunState {
  version: 1;
  runId: string;
  question: string;
  config: import("./config.js").ResearchConfig;
  phase: ResearchPhase;
  brief: string | null;
  inputLanguage: string | null;
  targetLanguage: string | null;
  draft: string | null;
  rounds: SupervisorRound[];
  registry: SourceEntry[];
  curated: CuratedSource[];
  /** Worker findings in arrival order, each prefixed with its agent and topic. */
  notes: string[];
  consecutiveFailures: number;
  aborted: boolean;
  abortReason: string | null;
  usage: TokenUsage;
  startedAt: string;
  /** Research routes to writing once this instant plus one minute has passed (upstream's rule). */
  researchDeadlineAt: string;
  nextAgentId: number;
  /** The `seq` of the last event this run emitted, so a resumed run keeps `(runId, seq)` unique. */
  eventSeq: number;
  /**
   * How the supervisor loop ended, recorded when research ends so a run resumed at the writing phase still knows
   * whether it is writing a salvage report (`partial`) or a finished one. Absent until the loop has ended.
   */
  loopExit?: { salvage: boolean; reason: string | null };
}

export interface ResearchOutcome {
  status: "completed" | "partial" | "failed" | "cancelled";
  /** The finished report, or a salvage report when `partial`; null when nothing could be written. */
  report: string | null;
  state: ResearchRunState;
  failure: string | null;
}

export interface ResearchInput {
  runId: string;
  question: string;
  /**
   * "Stop and write": when the run's signal aborts and the salvage condition holds (enough of the window elapsed
   * and at least one worker delivered findings), write a report from what exists and end `partial` instead of
   * `cancelled`. Read at the moment of cancellation, so a host may set it on this object just before aborting.
   */
  stopWritesReport?: boolean;
}

export interface ResearchDeps {
  model: ModelClient;
  worker: WorkerRunner;
  events: EventSink;
  /** Persist the state; called after each phase and each round. Awaited, so a slow store slows the run, not events. */
  checkpoint(state: ResearchRunState): Promise<void> | void;
  now(): number;
  log?(message: string): void;
  /**
   * Ends a salvage write. The run's own signal has already fired by the time a stop-and-write report is written,
   * so the host hands the engine a second signal for the moment the user (or a shutdown) no longer wants that
   * report either. Optional: without it a salvage write runs to its timeout.
   */
  hardStop?: AbortSignal;
}
