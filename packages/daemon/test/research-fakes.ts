/**
 * Offline doubles for the research engine: a fake clock, a model client scripted per role and per call, and a
 * worker runner that records concurrency. No timers anywhere; time moves only when a test says so.
 */

import { DEFAULT_RESEARCH_CONFIG, resolveResearchConfig, type ResearchConfig } from "../src/research/config.js";
import { createRunState } from "../src/research/engine.js";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelRole,
  ObservedToolCall,
  ResearchDeps,
  ResearchEvent,
  ResearchInput,
  ResearchRunState,
  SavedSource,
  TokenUsage,
  WorkerBudgets,
  WorkerResult,
  WorkerRunner,
  WorkerSink,
  WorkerTask,
} from "../src/research/types.js";

export const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);

export class FakeClock {
  now = T0;
  advanceMinutes(minutes: number): void {
    this.now += minutes * 60_000;
  }
  advanceMs(ms: number): void {
    this.now += ms;
  }
}

export type ModelScript = string | Error | ((request: ModelRequest, index: number) => string | Promise<string>);

export function usage(total: number): TokenUsage {
  return { inputTokens: Math.floor(total / 2), outputTokens: total - Math.floor(total / 2), cachedInputTokens: 0, totalTokens: total };
}

/** Replies per role in call order; the last script of a role repeats once the list runs out. */
export class FakeModel implements ModelClient {
  readonly calls: ModelRequest[] = [];
  readonly counts: Record<ModelRole, number> = { brief: 0, draft: 0, supervisor: 0, writer: 0 };
  scripts: Partial<Record<ModelRole, ModelScript[]>>;
  usagePerCall = 100;
  onCall: ((request: ModelRequest) => void) | null = null;

  constructor(scripts: Partial<Record<ModelRole, ModelScript[]>> = {}) {
    this.scripts = scripts;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const index = this.counts[request.role]++;
    this.onCall?.(request);
    const list = this.scripts[request.role] ?? [];
    if (list.length === 0) throw new Error(`no script for role ${request.role}`);
    const script = list[Math.min(index, list.length - 1)] as ModelScript;
    if (script instanceof Error) throw script;
    const text = typeof script === "function" ? await script(request, index) : script;
    return { text, usage: usage(this.usagePerCall), modelId: "fake-model" };
  }
}

export type WorkerScript = (task: WorkerTask, budgets: WorkerBudgets, signal: AbortSignal, sink: WorkerSink) => WorkerResult | Promise<WorkerResult>;

/** Runs scripted results, yielding to the event loop so the engine's lanes overlap, and records the overlap. */
export class FakeWorker implements WorkerRunner {
  readonly tasks: WorkerTask[] = [];
  readonly budgets: WorkerBudgets[] = [];
  running = 0;
  maxConcurrent = 0;
  script: WorkerScript;
  /** Called at the start of each worker, for example to advance the clock or abort the run. */
  onStart: ((task: WorkerTask) => void) | null = null;

  constructor(script: WorkerScript = () => completedResult("findings", [])) {
    this.script = script;
  }

  async run(task: WorkerTask, budgets: WorkerBudgets, signal: AbortSignal, sink: WorkerSink): Promise<WorkerResult> {
    this.tasks.push(task);
    this.budgets.push(budgets);
    this.running += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
    this.onStart?.(task);
    try {
      // Let every lane start before any result lands, so concurrency is observable without timers.
      for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
      const result = await this.script(task, budgets, signal, sink);
      if (signal.aborted && result.status === "completed") return { ...result, status: "cancelled", error: "cancelled" };
      return result;
    } finally {
      this.running -= 1;
    }
  }
}

export function searchCall(query: string, results: { url: string; title: string | null }[]): ObservedToolCall {
  return { tool: "web_search", kind: "search", query, urls: results.map((r) => r.url), results, at: new Date(T0).toISOString() };
}

export function fetchCall(url: string): ObservedToolCall {
  return { tool: "web_fetch", kind: "fetch", query: null, urls: [url], results: [], at: new Date(T0).toISOString() };
}

export function saved(url: string, title: string | null = null, reason = "relevant", excerpt: string | null = null): SavedSource {
  return { url, title, reason, excerpt };
}

export function completedResult(findings: string, sources: SavedSource[], observed: ObservedToolCall[] = [], tokens = 50): WorkerResult {
  return { status: "completed", findings, saved: sources, observed, usage: usage(tokens), error: null };
}

export function failedResult(error: string, status: WorkerResult["status"] = "failed"): WorkerResult {
  return { status, findings: "", saved: [], observed: [], usage: null, error };
}

/** A worker that saves one verified source per task, titled after its agent id. */
export function verifiedWorkerScript(): WorkerScript {
  return (task) => {
    const url = `https://example.org/a${task.agentId}`;
    return completedResult(`Findings of A${task.agentId} on ${task.topic} (${url}).`, [saved(url, `Source A${task.agentId}`, "supports the claim", "quoted passage")], [
      searchCall(task.topic, [{ url, title: `Source A${task.agentId}` }]),
      fetchCall(url),
    ]);
  };
}

export function decision(verdict: "CONTINUE_RESEARCH" | "RESEARCH_COMPLETE", topics: (string | { topic: string; discovery?: boolean; max_reads?: number })[] = [], reflection = "Denoise report. VERDICT: CONTINUE_RESEARCH"): string {
  const delegations = topics.map((t) => (typeof t === "string" ? { topic: t, discovery: false, max_reads: null } : { discovery: false, max_reads: null, ...t }));
  return `Thinking about it.\n\n\`\`\`json\n${JSON.stringify({ reflection, verdict, delegations }, null, 2)}\n\`\`\``;
}

export function briefText(brief = "Research brief for the question.", language = "English"): string {
  return `\`\`\`json\n${JSON.stringify({ research_brief: brief, input_language: language, target_language: language })}\n\`\`\``;
}

export interface Harness {
  clock: FakeClock;
  model: FakeModel;
  worker: FakeWorker;
  deps: ResearchDeps;
  events: ResearchEvent[];
  checkpoints: ResearchRunState[];
  logs: string[];
}

export function makeHarness(model: FakeModel, worker: FakeWorker, clock = new FakeClock()): Harness {
  const events: ResearchEvent[] = [];
  const checkpoints: ResearchRunState[] = [];
  const logs: string[] = [];
  const deps: ResearchDeps = {
    model,
    worker,
    events: { emit: (event) => events.push(event) },
    checkpoint: (state) => {
      checkpoints.push(JSON.parse(JSON.stringify(state)));
    },
    now: () => clock.now,
    log: (message) => logs.push(message),
  };
  return { clock, model, worker, deps, events, checkpoints, logs };
}

export const TEST_CONFIG: ResearchConfig = resolveResearchConfig(
  { windowMinMinutes: 3, windowMaxMinutes: 10, maxRounds: 12, maxParallel: 3, salvageFraction: 0.6 },
  DEFAULT_RESEARCH_CONFIG,
);

export function testConfig(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return resolveResearchConfig(overrides, TEST_CONFIG);
}

export const INPUT: ResearchInput = { runId: "run-1", question: "What is the state of small modular reactors in 2026?" };

/** A state parked at the start of research, for driving the supervisor loop directly. */
export function researchingState(config: ResearchConfig, nowMs: number, input: ResearchInput = INPUT): ResearchRunState {
  const state = createRunState(input, config, nowMs);
  state.phase = "researching";
  state.brief = "Brief.";
  state.inputLanguage = "English";
  state.targetLanguage = "English";
  return state;
}
