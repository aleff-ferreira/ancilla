import { randomBytes } from "node:crypto";
import type {
  AncillaStore,
  ModelClient,
  ResearchEvent,
  ResearchInput,
  ResearchOutcome,
  ResearchRunRecord,
  ResearchRunState,
  ResearchRunView,
  ResearchStatus,
  WorkerBudgets,
  WorkerResult,
  WorkerRunner,
  WorkerSink,
  WorkerTask,
  runResearch,
} from "@ancilla/daemon";
import type { WorkerUpdate } from "./sessionWorkerRunner.js";
import { runView, type LiveRunOverlay } from "./views.js";

/** How long run broadcasts are held so a burst of events reaches clients as one `research-run`. */
export const RESEARCH_BROADCAST_DEBOUNCE_MS = 120;

/** Workers running at once across every run, whatever each run's own cap says. */
export const DEFAULT_GLOBAL_WORKER_CAP = 4;

/** How long shutdown waits for in-flight runs to persist their outcome after the abort. */
export const CLOSE_TIMEOUT_MS = 5000;

/** A UUIDv7: 48 bits of Unix milliseconds, then random bits, so run ids sort by creation time. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Math.max(0, Math.floor(now)));
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The thread a run belongs to, as the adapters need it: its folder, account and model. */
export interface ResearchThread {
  sessionId: string;
  cwd: string;
  accountId: string | null;
  modelId: string | null;
}

/**
 * What a stop asked for, handed to the engine as the abort reason (`signal.reason`) and on the input object it
 * was started with. ASSUMPTION: the engine reads one of the two to decide whether to write a salvage report
 * from what it has (`partial`) or to return `cancelled`; until it does, every stop comes back `cancelled`.
 */
export interface ResearchStopRequest {
  type: "stop";
  writeReport: boolean;
}

/** The engine's input; `stopWritesReport` is set just before the abort so the engine can read it at cancellation. */
export interface ResearchJobInput extends ResearchInput {
  stopWritesReport: boolean;
}

export type ResearchEngine = typeof runResearch;

export interface ResearchJobManagerOptions {
  store: AncillaStore;
  engine: ResearchEngine;
  createModelClient(run: ResearchRunRecord, thread: ResearchThread): ModelClient;
  createWorkerRunner(run: ResearchRunRecord, thread: ResearchThread, onWorkerUpdate: (update: WorkerUpdate) => void): WorkerRunner;
  /** Sends the run's current view to clients; called at most every `RESEARCH_BROADCAST_DEBOUNCE_MS` per run. */
  broadcast(run: ResearchRunView): void;
  /** Writes report.md and sources.json into the workspace; resolves the report path relative to the project folder, or null. */
  writeReport(thread: ResearchThread, run: ResearchRunRecord, report: string, state: ResearchRunState): Promise<string | null>;
  globalWorkerCap?: number;
  now?(): number;
  log?(message: string): void;
}

interface Job {
  runId: string;
  thread: ResearchThread;
  controller: AbortController;
  input: ResearchJobInput;
  live: LiveRunOverlay;
  /** Resolves once the engine has returned and the outcome is persisted. */
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  lastSeq: number;
}

/** A counting semaphore: `acquire` resolves with the release function, or rejects when the signal fires first. */
class Semaphore {
  private inUse = 0;
  private readonly waiters: { grant: () => void; signal: AbortSignal; onAbort: () => void }[] = [];

  constructor(private readonly limit: number) {}

  get active(): number {
    return this.inUse;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const release = (): void => {
        this.inUse -= 1;
        this.next();
      };
      if (signal.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      if (this.inUse < this.limit) {
        this.inUse += 1;
        resolve(release);
        return;
      }
      const waiter = {
        signal,
        grant: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          this.inUse += 1;
          resolve(release);
        },
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new Error("cancelled"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private next(): void {
    while (this.inUse < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift() as (typeof this.waiters)[number];
      waiter.grant();
    }
  }
}

/** A worker runner that waits for a global slot before it runs; a run stopped while waiting gets `cancelled`. */
class CappedWorkerRunner implements WorkerRunner {
  constructor(
    private readonly inner: WorkerRunner,
    private readonly slots: Semaphore,
  ) {}

  async run(task: WorkerTask, budgets: WorkerBudgets, signal: AbortSignal, sink: WorkerSink): Promise<WorkerResult> {
    let release: () => void;
    try {
      release = await this.slots.acquire(signal);
    } catch {
      return { status: "cancelled", findings: "", saved: [], observed: [], usage: null, error: "cancelled: the run was stopped before the worker got a slot." };
    }
    try {
      return await this.inner.run(task, budgets, signal, sink);
    } finally {
      release();
    }
  }
}

/**
 * One job per research run: it builds the engine's dependencies, persists every event, checkpoint and status
 * change, writes the report into the workspace, and broadcasts the run's view. The engine itself decides what the
 * run does; the manager only makes it durable and stoppable.
 */
export class ResearchJobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly slots: Semaphore;
  private closed = false;

  constructor(private readonly options: ResearchJobManagerOptions) {
    this.slots = new Semaphore(Math.max(1, options.globalWorkerCap ?? DEFAULT_GLOBAL_WORKER_CAP));
  }

  /** Workers running right now across every job; tests read it to check the global cap. */
  get activeWorkers(): number {
    return this.slots.active;
  }

  isActive(runId: string): boolean {
    return this.jobs.has(runId);
  }

  /** The run's view, with the live phase and counters when the job is in flight. */
  view(record: ResearchRunRecord, withReport: boolean): ResearchRunView {
    return runView(record, this.options.store.listResearchWorkers(record.id), { withReport, live: this.jobs.get(record.id)?.live ?? null });
  }

  /**
   * Runs the store found queued or running at boot were lost with the previous process. They become
   * `interrupted`, the status a later Resume acts on, with an event saying so.
   */
  markInterruptedOnBoot(): ResearchRunRecord[] {
    const marked: ResearchRunRecord[] = [];
    for (const run of this.options.store.listRunningResearchRuns()) {
      const at = this.nowIso();
      const seq = this.options.store.lastResearchEventSeq(run.id) + 1;
      this.options.store.appendResearchEvent({
        type: "run_interrupted",
        runId: run.id,
        seq,
        at,
        phase: run.state?.phase ?? null,
        round: run.state?.rounds.length ?? null,
        agentId: null,
        payload: { reason: "The server stopped while the run was in flight." },
      });
      const updated = this.options.store.updateResearchRun(run.id, { status: "interrupted", endedAt: at, failure: run.failure ?? "interrupted: the server stopped while the run was in flight." });
      if (updated) {
        marked.push(updated);
        this.options.log?.(`research: run ${run.id} was in flight when the server last stopped; marked interrupted.`);
      }
    }
    return marked;
  }

  /** Starts the engine for a queued run. Returns once the job is registered; the run finishes on its own. */
  start(record: ResearchRunRecord, thread: ResearchThread): ResearchRunView {
    if (this.closed) {
      throw new Error("The research job manager is closed.");
    }
    if (this.jobs.has(record.id)) {
      return this.view(record, false);
    }
    const controller = new AbortController();
    const job: Job = {
      runId: record.id,
      thread,
      controller,
      input: { runId: record.id, question: record.question, stopWritesReport: false },
      live: { phase: null, round: null, workers: new Map() },
      done: Promise.resolve(),
      timer: null,
      lastSeq: this.options.store.lastResearchEventSeq(record.id),
    };
    this.jobs.set(record.id, job);
    job.done = this.execute(job, record).catch((error: unknown) => {
      this.options.log?.(`research: run ${record.id} bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.view(this.options.store.getResearchRun(record.id) ?? record, false);
  }

  /**
   * Stops a run. The engine sees the abort and comes back with `cancelled`, or `partial` when it could write from
   * what it had and was asked to. A run that is not in flight is left as it is, so a repeated stop is harmless.
   */
  stop(runId: string, writeReport: boolean): boolean {
    const job = this.jobs.get(runId);
    if (!job || job.controller.signal.aborted) {
      return false;
    }
    job.input.stopWritesReport = writeReport;
    const reason: ResearchStopRequest = { type: "stop", writeReport };
    this.options.log?.(`research: run ${runId} stop requested (writeReport=${writeReport}).`);
    job.controller.abort(reason);
    return true;
  }

  /**
   * Aborts every job and waits for each to persist its outcome, but not past `timeoutMs`: a worker whose host
   * never answers the interrupt must not hold the whole shutdown; the run is marked interrupted at the next boot.
   */
  async close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) {
      if (!job.controller.signal.aborted) {
        job.controller.abort({ type: "stop", writeReport: false } satisfies ResearchStopRequest);
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.all(jobs.map((job) => job.done)).then(() => undefined), deadline]);
    if (timer) {
      clearTimeout(timer);
    }
    for (const job of jobs) {
      if (this.jobs.has(job.runId)) {
        this.options.log?.(`research: run ${job.runId} did not finish within ${timeoutMs} ms of shutdown.`);
      }
    }
    for (const job of jobs) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }

  private async execute(job: Job, record: ResearchRunRecord): Promise<void> {
    const { store } = this.options;
    const startedAt = this.nowIso();
    store.updateResearchRun(job.runId, { status: "running", startedAt });
    this.scheduleBroadcast(job);
    const model = this.options.createModelClient(record, job.thread);
    const worker = new CappedWorkerRunner(
      this.options.createWorkerRunner(record, job.thread, (update) => this.onWorkerUpdate(job, update)),
      this.slots,
    );
    const deps = {
      model,
      worker,
      events: { emit: (event: ResearchEvent) => this.onEvent(job, event) },
      checkpoint: (state: ResearchRunState) => {
        store.updateResearchRun(job.runId, { state });
        job.live.phase = state.phase;
        job.live.round = state.rounds.length;
        this.scheduleBroadcast(job);
      },
      now: () => this.options.now?.() ?? Date.now(),
      log: (message: string) => this.options.log?.(`research: run ${job.runId}: ${message}`),
    };
    let outcome: ResearchOutcome | null = null;
    let failure: string | null = null;
    try {
      outcome = await this.options.engine(job.input, record.config, deps, job.controller.signal);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.options.log?.(`research: run ${job.runId} threw: ${failure}`);
    }
    const endedAt = this.nowIso();
    let status: ResearchStatus;
    if (outcome) {
      status = outcome.status;
      store.updateResearchRun(job.runId, {
        status,
        state: outcome.state,
        report: outcome.report,
        failure: outcome.failure,
        endedAt,
      });
      job.live.phase = outcome.state.phase;
      job.live.round = outcome.state.rounds.length;
    } else {
      status = job.controller.signal.aborted ? "cancelled" : "failed";
      store.updateResearchRun(job.runId, { status, failure: `other: ${failure ?? "the engine stopped without an outcome."}`, endedAt });
      // The engine emits its own terminal event; when it threw instead, the log still gets one.
      this.onEvent(job, {
        type: status === "cancelled" ? "run_cancelled" : "run_failed",
        runId: job.runId,
        seq: job.lastSeq + 1,
        at: endedAt,
        phase: job.live.phase,
        round: job.live.round,
        agentId: null,
        payload: { error: failure ?? "the engine stopped without an outcome." },
      });
    }
    if (outcome?.report) {
      const current = store.getResearchRun(job.runId);
      if (current) {
        try {
          const reportPath = await this.options.writeReport(job.thread, current, outcome.report, outcome.state);
          if (reportPath) {
            store.updateResearchRun(job.runId, { reportPath });
          }
        } catch (error) {
          // The report is in the store either way; the file is a convenience for the Files panel.
          this.options.log?.(`research: run ${job.runId} could not write its report file: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    this.options.log?.(`research: run ${job.runId} ended ${status}.`);
    this.jobs.delete(job.runId);
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    this.broadcastNow(job);
  }

  private onEvent(job: Job, event: ResearchEvent): void {
    // The engine numbers its events; one it left unnumbered, or numbered behind, still lands after the last.
    const seq = Number.isFinite(event.seq) && event.seq > job.lastSeq ? event.seq : job.lastSeq + 1;
    const stored: ResearchEvent = { ...event, runId: job.runId, seq, at: event.at || this.nowIso() };
    job.lastSeq = seq;
    try {
      this.options.store.appendResearchEvent(stored);
    } catch (error) {
      this.options.log?.(`research: run ${job.runId} could not store event ${stored.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stored.phase) {
      job.live.phase = stored.phase;
    }
    if (typeof stored.round === "number") {
      job.live.round = stored.round;
    }
    this.scheduleBroadcast(job);
  }

  private onWorkerUpdate(job: Job, update: WorkerUpdate): void {
    const { store } = this.options;
    const known = job.live.workers.get(update.agentId);
    job.live.workers.set(update.agentId, update);
    try {
      if (!known) {
        store.addResearchWorker({ runId: job.runId, workerSessionId: update.workerSessionId, round: update.round, agentId: update.agentId, status: update.state });
      } else if (known.state !== update.state) {
        store.updateResearchWorker(job.runId, update.workerSessionId, update.state);
      }
    } catch (error) {
      this.options.log?.(`research: run ${job.runId} could not record worker A${update.agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.scheduleBroadcast(job);
  }

  private scheduleBroadcast(job: Job): void {
    if (job.timer) {
      return;
    }
    job.timer = setTimeout(() => {
      job.timer = null;
      this.broadcastNow(job);
    }, RESEARCH_BROADCAST_DEBOUNCE_MS);
    job.timer.unref?.();
  }

  private broadcastNow(job: Job): void {
    const record = this.options.store.getResearchRun(job.runId);
    if (!record) {
      return;
    }
    try {
      this.options.broadcast(runView(record, this.options.store.listResearchWorkers(job.runId), { withReport: false, live: job.live }));
    } catch (error) {
      this.options.log?.(`research: run ${job.runId} broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
