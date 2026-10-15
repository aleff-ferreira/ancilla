import { randomBytes } from "node:crypto";
import { isStoreBusy } from "@ancilla/daemon";
import type {
  AncillaStore,
  CheckpointOptions,
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
import { waitUnlessAborted } from "../hostBounds.js";
import type { WorkerUpdate } from "./sessionWorkerRunner.js";
import { runView, type LiveRunOverlay } from "./views.js";

/** How long run broadcasts are held so a burst of events reaches clients as one `research-run`. */
export const RESEARCH_BROADCAST_DEBOUNCE_MS = 120;

/** Workers running at once across every run, whatever each run's own cap says. */
export const DEFAULT_GLOBAL_WORKER_CAP = 4;

/** How long shutdown waits for in-flight runs to persist their outcome after the abort. */
export const CLOSE_TIMEOUT_MS = 5000;

/**
 * How long a finished run waits for its report file to be written. The report is in the store already and the file
 * is a convenience for the Files panel, so a write that hangs (a folder on a share that went away, say) is let go
 * of rather than holding the run's job, and with it the thread, open.
 */
export const REPORT_WRITE_TIMEOUT_MS = 30_000;

/** The most runs whose report write note is remembered at once; the oldest is forgotten first and read back from the events. */
export const MAX_REMEMBERED_REPORT_WRITE_NOTES = 512;

/**
 * The longest research question the route accepts, in characters. The question rides along verbatim in the
 * supervisor's prompt on every round, so it shares the prompt with the notes and the rounds and must leave them
 * room; twenty thousand characters is some three thousand words, far past any question and well inside what a
 * model call carries. Longer material belongs in a file in the project that the question points at.
 */
export const MAX_RESEARCH_QUESTION_CHARS = 20_000;

/**
 * How a write the run cannot do without is tried again when the database is busy: spaced out, doubling from
 * `firstDelayMs` to `maxDelayMs`, until `windowMs` has gone. The run waits meanwhile (the engine awaits its
 * checkpoints), so no new round is dispatched while the store is locked. Long enough for any other process's write,
 * short enough that a database that stays locked ends the run instead of holding it for good.
 */
export interface PersistRetry {
  windowMs: number;
  firstDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_PERSIST_RETRY: PersistRetry = { windowMs: 30_000, firstDelayMs: 100, maxDelayMs: 2_000 };

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
 * was started with: the engine reads `stopWritesReport` at the moment of cancellation to decide between a
 * salvage report (`partial`) and `cancelled`.
 */
export interface ResearchStopRequest {
  type: "stop";
  writeReport: boolean;
}

/**
 * The abort reason a shutdown carries. The worker runner reads it off `signal.reason` and cancels its turn at
 * once instead of interrupting and waiting out the grace period, so a closing server is not held up by hosts.
 */
export interface ResearchShutdownRequest {
  type: "shutdown";
}

export type ResearchAbortReason = ResearchStopRequest | ResearchShutdownRequest;

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
  /** How long `writeReport` may take before the run lets go of it; `REPORT_WRITE_TIMEOUT_MS` unless given. */
  reportWriteTimeoutMs?: number;
  /** How a write is tried again when the database is busy; `DEFAULT_PERSIST_RETRY` where not given. */
  persistRetry?: Partial<PersistRetry>;
  now?(): number;
  log?(message: string): void;
}

interface Job {
  runId: string;
  thread: ResearchThread;
  controller: AbortController;
  /** Ends a salvage write the first stop asked for: a second stop, or a shutdown, aborts it. */
  hardStop: AbortController;
  input: ResearchJobInput;
  live: LiveRunOverlay;
  /** Resolves once the engine has returned and the outcome is persisted. */
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  lastSeq: number;
  /** Set when the engine has returned: from then on its outcome, not an abort, decides how the run ends. */
  engineDone: boolean;
  /**
   * Set, synchronously, when a shutdown reaches an engine that is still going. From then on nothing the engine does
   * is stored (its checkpoints and events are dropped): its own way of winding down closes the round, records
   * cancelled summaries and says `done`, and a state like that would resume into a run that is already over. The
   * run ends `interrupted`, with the state of the last checkpoint it took before. Worker rows still follow their
   * sessions.
   */
  frozen: boolean;
  /** The newest state the engine handed to a checkpoint; what the next write stores, whenever it happens. */
  latestState: ResearchRunState | null;
  /** How many checkpoints were asked for, and how many of them a write has covered. */
  checkpointsAsked: number;
  checkpointsWritten: number;
  /** The newest checkpoint asked for that the run cannot go on without: the one before its workers are dispatched. */
  criticalAsked: number;
  /** Whether a write loop is running, and what the callers waiting on it wait for. */
  writing: boolean;
  flight: Promise<void> | null;
  /** Set when a write the run cannot do without failed for good: the run ends interrupted. */
  storeFailure: string | null;
  /** Set when a write ran out of its window; the next one is tried once, not waited for, until one gets through. */
  degraded: boolean;
}

/** Thrown out of a checkpoint the run cannot go on without, to stop the engine before it dispatches work it could not save. */
class ResearchStoreUnavailable extends Error {}

/** Whether a stored status (or an unreadable row, which is given the benefit of the doubt) is a run still going. */
function inFlight(status: ResearchStatus | "unreadable" | "gone"): boolean {
  return status === "queued" || status === "running" || status === "unreadable";
}

/** How long, between tries, the sweep at boot waits for a database another process has locked; each wait is one more try. */
export const BOOT_SWEEP_RETRY_MS: readonly number[] = [250, 500, 1000, 2000];

/**
 * A counting semaphore: `acquire` resolves with the release function, or rejects when the signal fires first. A
 * release gives its slot back once, however often it is called, so a path that releases twice cannot admit more
 * work than the limit.
 */
export class Semaphore {
  private inUse = 0;
  private readonly waiters: { grant: () => void; signal: AbortSignal; onAbort: () => void }[] = [];

  constructor(private readonly limit: number) {}

  get active(): number {
    return this.inUse;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
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
  /** The note on each run whose report file could not be written, `null` for a run known to have none. */
  private readonly reportWriteErrors = new Map<string, string | null>();
  private readonly slots: Semaphore;
  /** Set when `close()` begins: no new job starts. */
  private closing = false;
  /** Set when `close()` has returned: the store may be closed by then, so nothing is written or broadcast any more. */
  private closed = false;

  private readonly retry: PersistRetry;

  constructor(private readonly options: ResearchJobManagerOptions) {
    this.slots = new Semaphore(Math.max(1, options.globalWorkerCap ?? DEFAULT_GLOBAL_WORKER_CAP));
    this.retry = { ...DEFAULT_PERSIST_RETRY, ...(options.persistRetry ?? {}) };
  }

  /** Workers running right now across every job; tests read it to check the global cap. */
  get activeWorkers(): number {
    return this.slots.active;
  }

  isActive(runId: string): boolean {
    return this.jobs.has(runId);
  }

  /**
   * Whether a run of this thread is in flight in this process: a job is running it and its row still says so. A row
   * that says `running` with no job behind it is no evidence of that (its process may be gone), and a job that is
   * only finishing its report file after its outcome was stored is over, however long that file takes: archiving or
   * settling the thread would pull nothing out from under it, and Stop would have nothing to stop. The thread's own
   * busy state says nothing of this either.
   */
  hasLiveRun(sessionId: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.thread.sessionId === sessionId && inFlight(this.storedStatus(job))) {
        return true;
      }
    }
    return false;
  }

  /**
   * How many jobs are running, and how many were accepted but whose row does not say `running` yet (the write that
   * marks it was refused, say). A job that is only finishing its report file is neither. Counts only.
   */
  counts(): { live: number; queued: number } {
    let live = 0;
    let queued = 0;
    for (const job of this.jobs.values()) {
      const status = this.storedStatus(job);
      if (status === "queued") {
        queued += 1;
      } else if (inFlight(status)) {
        live += 1;
      }
    }
    return { live, queued };
  }

  /** What the job's row says, `"unreadable"` when the store would not answer and `"gone"` for no row at all. */
  private storedStatus(job: Job): ResearchStatus | "unreadable" | "gone" {
    try {
      return this.options.store.getResearchRun(job.runId)?.status ?? "gone";
    } catch {
      return "unreadable";
    }
  }

  /** The run's view, with the live phase and counters when the job is in flight. */
  view(record: ResearchRunRecord, withReport: boolean): ResearchRunView {
    return runView(record, this.options.store.listResearchWorkers(record.id), {
      withReport,
      live: this.jobs.get(record.id)?.live ?? null,
      reportWriteError: this.reportWriteErrorOf(record),
    });
  }

  /**
   * Why a finished run's report has no file, when the project would not take it: noted at the moment it failed, and
   * read back from the run's events for a run that ended before this process started. A run whose report was saved
   * (or that has none to save) has nothing to say.
   */
  private reportWriteErrorOf(record: ResearchRunRecord): string | null {
    if (record.reportPath !== null || !record.report) {
      return null;
    }
    if (!this.reportWriteErrors.has(record.id)) {
      this.rememberReportWriteError(record.id, this.lastReportWriteError(record.id));
    }
    return this.reportWriteErrors.get(record.id) ?? null;
  }

  /** Keeps the note on a run, forgetting the oldest one once there are too many; a forgotten note is read back from the events. */
  private rememberReportWriteError(runId: string, note: string | null): void {
    this.reportWriteErrors.delete(runId);
    this.reportWriteErrors.set(runId, note);
    while (this.reportWriteErrors.size > MAX_REMEMBERED_REPORT_WRITE_NOTES) {
      const oldest = this.reportWriteErrors.keys().next();
      if (oldest.done) break;
      this.reportWriteErrors.delete(oldest.value);
    }
  }

  private lastReportWriteError(runId: string): string | null {
    // The event is written as the run ends, so it is among the last few: one read of the tail, however long the run.
    const TAIL = 200;
    let found: string | null = null;
    try {
      const after = Math.max(0, this.options.store.lastResearchEventSeq(runId) - TAIL);
      for (const event of this.options.store.listResearchEvents(runId, after, TAIL)) {
        if (event.type === "report_write_failed") {
          const message = event.payload["error"];
          found = typeof message === "string" ? message : null;
        }
      }
    } catch {
      /* the events are a convenience; a run that cannot read them simply has no note */
    }
    return found;
  }

  /**
   * Runs the store found queued or running at boot were lost with the previous process. They become
   * `interrupted`, the status a later Resume acts on, with an event saying so.
   */
  markInterruptedOnBoot(): ResearchRunRecord[] {
    return this.sweepOnce().marked;
  }

  /**
   * `markInterruptedOnBoot`, but a database another process has locked is waited for: each pass that met a busy
   * database is followed, after the next of `delaysMs`, by another over what is left, until a pass is clean or the
   * waits are spent. A failure that waiting would not change is not waited on. Rows that could not be written stay as
   * they were, for the next boot's sweep. A manager that is closing, or a `signal` that fires (the server's own close),
   * ends the sweep at once, in the middle of a wait too, and nothing is read or written after that.
   */
  async sweepInterruptedOnBoot(delaysMs: readonly number[] = BOOT_SWEEP_RETRY_MS, signal?: AbortSignal): Promise<ResearchRunRecord[]> {
    const marked: ResearchRunRecord[] = [];
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted || this.closing || this.closed) {
        return marked;
      }
      let busy: boolean;
      try {
        const pass = this.sweepOnce();
        marked.push(...pass.marked);
        busy = pass.busy;
      } catch (error) {
        busy = isStoreBusy(error);
        this.options.log?.(`research: the runs in flight could not be listed at boot: ${error instanceof Error ? error.message : String(error)}`);
      }
      const delay = delaysMs[attempt];
      if (!busy || signal?.aborted || this.closing || this.closed) {
        return marked;
      }
      if (delay === undefined) {
        this.options.log?.("research: the database stayed locked; the runs left in flight will be marked interrupted at the next start.");
        return marked;
      }
      await waitUnlessAborted(delay, signal);
    }
  }

  /**
   * One pass over the rows the store has as queued or running; `busy` says a row was refused because the database is
   * locked. A locked database refuses every row the same way, so the pass ends at the first one: the rest are tried by
   * the next pass, and a long list does not make the wait longer.
   */
  private sweepOnce(): { marked: ResearchRunRecord[]; busy: boolean } {
    const marked: ResearchRunRecord[] = [];
    let busy = false;
    for (const run of this.options.store.listRunningResearchRuns()) {
      try {
        const updated = this.markInterrupted(run, "The server stopped while the run was in flight.");
        if (updated) {
          marked.push(updated);
          this.options.log?.(`research: run ${run.id} was in flight when the server last stopped; marked interrupted.`);
        }
      } catch (error) {
        // A row that cannot be written for another reason is not a reason to leave the others in flight.
        busy = busy || isStoreBusy(error);
        this.options.log?.(`research: run ${run.id} could not be marked interrupted: ${error instanceof Error ? error.message : String(error)}`);
        if (busy) {
          break;
        }
      }
    }
    return { marked, busy };
  }

  /**
   * A row that says `queued` or `running` for a run this manager is not running is stale: its process is gone,
   * or its bookkeeping threw before the terminal status landed. It becomes `interrupted` with an event, and the
   * thread is free to start another run. A run this manager is running is left alone, and so is one that is not in
   * flight in the store any more (it ended while the caller was reading it): nothing is written for that.
   */
  markInterrupted(run: ResearchRunRecord, reason: string): ResearchRunRecord | null {
    if (this.jobs.has(run.id)) {
      return null;
    }
    const updated = this.interruptRow(run.id, reason, null);
    if (updated) {
      try {
        this.options.broadcast(this.view(updated, false));
      } catch (error) {
        this.options.log?.(`research: run ${run.id} broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return updated;
  }

  /**
   * The one place a run becomes `interrupted`: the row (only while it still says queued or running), its worker
   * rows still working, and the `run_interrupted` event, all in one transaction, so none of them stands for a change
   * the others do not show. `job` is given for a run this manager was running, which was alive until now; for a row
   * nobody is running it was alive until its last event from the engine (the host's own events say when the server
   * noticed, not when the run stopped). Returns null, writing nothing, when the run was no longer in flight.
   */
  private interruptRow(runId: string, reason: string, job: Job | null): ResearchRunRecord | null {
    const { store } = this.options;
    return store.transaction(() => {
      const current = store.getResearchRun(runId);
      if (!current) {
        return null;
      }
      const at = this.nowIso();
      const updated = store.updateResearchRunIf(runId, ["queued", "running"], {
        status: "interrupted",
        endedAt: at,
        failure: current.failure ?? `interrupted: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
      });
      if (!updated) {
        return null;
      }
      store.closeResearchWorkers(runId);
      const aliveUntil = job ? at : store.lastResearchEventAt(runId, ["run_interrupted"]) ?? current.startedAt ?? current.createdAt;
      const seq = Math.max(job?.lastSeq ?? 0, store.lastResearchEventSeq(runId)) + 1;
      // A stop that asked for a report, which the shutdown cut short before its salvage checkpoint was taken: said here,
      // since the stored state does not yet say it, so a later continuation can still write that report.
      const stopReason = job?.controller.signal.aborted ? (job.controller.signal.reason as ResearchAbortReason | undefined) : undefined;
      const stopRequested = stopReason?.type === "stop" && stopReason.writeReport ? { writeReport: true } : null;
      store.appendResearchEvent({
        type: "run_interrupted",
        runId,
        seq,
        at,
        phase: current.state?.phase ?? null,
        round: current.state?.rounds.length ?? null,
        agentId: null,
        payload: { reason, aliveUntil, ...(stopRequested ? { stopRequested } : {}) },
      });
      if (job) {
        job.lastSeq = seq;
      }
      return updated;
    });
  }

  /** Starts the engine for a queued run. Returns once the job is registered; the run finishes on its own. */
  start(record: ResearchRunRecord, thread: ResearchThread): ResearchRunView {
    if (this.closing || this.closed) {
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
      hardStop: new AbortController(),
      input: { runId: record.id, question: record.question, stopWritesReport: false },
      live: { phase: null, round: null, workers: new Map() },
      done: Promise.resolve(),
      timer: null,
      lastSeq: this.options.store.lastResearchEventSeq(record.id),
      engineDone: false,
      frozen: false,
      latestState: null,
      checkpointsAsked: 0,
      checkpointsWritten: 0,
      criticalAsked: 0,
      writing: false,
      flight: null,
      storeFailure: null,
      degraded: false,
    };
    this.jobs.set(record.id, job);
    job.done = this.execute(job, record).catch((error: unknown) => {
      this.options.log?.(`research: run ${record.id} bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.view(this.options.store.getResearchRun(record.id) ?? record, false);
  }

  /**
   * Stops a run. The engine sees the abort and comes back with `cancelled`, or `partial` when it could write from
   * what it had and was asked to. A second stop that no longer wants a report ends the salvage write the first
   * one started, through the job's `hardStop`. A run that is not in flight is left as it is, and a repeated stop
   * that changes nothing is harmless.
   */
  stop(runId: string, writeReport: boolean): boolean {
    const job = this.jobs.get(runId);
    if (!job) {
      return false;
    }
    if (!job.controller.signal.aborted) {
      job.input.stopWritesReport = writeReport;
      const reason: ResearchStopRequest = { type: "stop", writeReport };
      this.options.log?.(`research: run ${runId} stop requested (writeReport=${writeReport}).`);
      job.controller.abort(reason);
      return true;
    }
    if (!writeReport && !job.hardStop.signal.aborted) {
      this.options.log?.(`research: run ${runId} stopped again without a report; ending the salvage write.`);
      job.hardStop.abort({ type: "stop", writeReport: false } satisfies ResearchStopRequest);
      return true;
    }
    return false;
  }

  /**
   * Aborts every job (with the shutdown reason, so workers cancel at once) and waits for each to persist its
   * outcome, but not past `timeoutMs`: a worker whose host never answers must not hold the whole shutdown, and the
   * run is closed out as interrupted right here instead (its engine is not waited for). Once this returns nothing is
   * written or broadcast any more, because the store is closed right after.
   *
   * A run the shutdown cuts off ends `interrupted`, frozen at its last checkpoint, whatever its engine records while
   * winding down (see `Job.frozen`). A run the user has already stopped without a report stays `cancelled`: the stop
   * came first and wins. One whose stop asked for a report is cut short by the shutdown like any other, so that it
   * can be finished later, and one whose engine has already returned keeps its outcome.
   */
  async close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
    this.closing = true;
    const jobs = [...this.jobs.values()];
    const shutdown: ResearchShutdownRequest = { type: "shutdown" };
    for (const job of jobs) {
      // Before the abort: the engine's first step of winding down must already find the job frozen.
      if (!job.engineDone && !(job.controller.signal.aborted && !job.input.stopWritesReport)) {
        job.frozen = true;
      }
      if (!job.controller.signal.aborted) {
        job.controller.abort(shutdown);
      }
      if (!job.hardStop.signal.aborted) {
        job.hardStop.abort(shutdown);
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
    // A job still here did not wind down in time (a worker host that never answered, say). It is not waited for any
    // longer, and it is closed out now, while the store is open and before `closed` keeps its engine from writing: one
    // local transaction. A job whose engine has returned is only finishing its own write, which the boot sweep takes
    // over if it cannot.
    for (const job of jobs) {
      if (!this.jobs.has(job.runId)) {
        continue;
      }
      this.options.log?.(`research: run ${job.runId} did not finish within ${timeoutMs} ms of shutdown.`);
      if (!job.engineDone) {
        try {
          this.interruptRow(job.runId, "The server shut down while the run was in flight.", job);
        } catch (error) {
          this.options.log?.(`research: run ${job.runId} could not be marked interrupted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    this.closed = true;
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

  /** A store write that must not take the run down: nothing after close, and a throw is logged, not raised. */
  private persist<T>(job: Job, what: string, write: () => T): T | null {
    if (this.closed) {
      return null;
    }
    try {
      return write();
    } catch (error) {
      this.options.log?.(`research: run ${job.runId} could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * A store write that is tried again while the database is busy, between event-loop turns (SQLite's own wait blocks
   * the loop, so it is kept short and the real waiting is done here), until `retry.windowMs` is spent. The first
   * attempt is made at once, before anything is awaited. `full` asks for the whole window even after an earlier write
   * ran out of its own, which the writes the run cannot do without do. Resolves with null once the write went
   * through, or with the error that ended the attempts; a failure that waiting would not change (anything but a busy
   * database) ends them at once. A frozen job (`stopWhenFrozen`) and a closed manager give up without writing.
   * `giveUp`, asked after each refusal and each wait, ends the attempts too, and a wait is cut short by the job's abort
   * when it is given: a stop pressed while the database is locked is heard now, not when the window is spent.
   */
  private async writeWithRetry(
    job: Job,
    what: string,
    write: () => unknown,
    options: { full?: boolean | (() => boolean); stopWhenFrozen?: boolean; giveUp?: () => boolean } = {},
  ): Promise<Error | null> {
    const startedAt = Date.now();
    let delay = this.retry.firstDelayMs;
    let waited = false;
    for (;;) {
      if (this.closed || (options.stopWhenFrozen && job.frozen)) {
        return new Error("the run is shutting down");
      }
      let failure: Error;
      try {
        write();
        if (waited) {
          this.options.log?.(`research: run ${job.runId}: the database let go; ${what} went through.`);
        }
        job.degraded = false;
        return null;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        const full = typeof options.full === "function" ? options.full() : options.full === true;
        const window = job.degraded && !full ? 0 : this.retry.windowMs;
        if (!isStoreBusy(error) || Date.now() - startedAt + delay > window) {
          this.options.log?.(`research: run ${job.runId} could not ${what}: ${failure.message}`);
          if (isStoreBusy(error)) {
            job.degraded = true;
          }
          return failure;
        }
        if (options.giveUp?.()) {
          this.options.log?.(`research: run ${job.runId}: ${what} was let go, the run having been stopped: ${failure.message}`);
          return failure;
        }
        if (!waited) {
          waited = true;
          this.options.log?.(`research: run ${job.runId}: the database is busy; ${what} will be tried again.`);
        }
      }
      await new Promise<void>((resolve) => {
        const signal = job.controller.signal;
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, delay);
        timer.unref?.();
        if (options.giveUp) {
          signal.addEventListener("abort", done, { once: true });
        }
      });
      if (options.giveUp?.()) {
        this.options.log?.(`research: run ${job.runId}: ${what} was let go, the run having been stopped: ${failure.message}`);
        return failure;
      }
      delay = Math.min(delay * 2, this.retry.maxDelayMs);
    }
  }

  /**
   * The engine's checkpoint. Writes are single-flight: one loop writes at a time, and each pass stores the newest
   * state the engine has handed over, serialised when the write is made. So a write that has to be retried can never
   * put an older snapshot over a newer one, and calls that arrive meanwhile are covered by the write that follows
   * them. The engine waits for its answer, which is what holds back new work while the store is busy. A checkpoint
   * that ran out of its window is let go (the next one holds everything it did, and heals it), except the one before
   * workers are dispatched: a round that was never saved must not run, so that one stops the engine with an error,
   * and the run ends interrupted.
   */
  private async checkpoint(job: Job, state: ResearchRunState, options?: CheckpointOptions): Promise<void> {
    if (this.closed || job.frozen) {
      return;
    }
    job.latestState = state;
    job.checkpointsAsked += 1;
    // The engine says which one it is; the shape of the state is not guessed at.
    const critical = options?.beforeDispatch === true;
    if (critical) {
      job.criticalAsked = job.checkpointsAsked;
    }
    if (!job.writing) {
      job.flight = this.flushCheckpoints(job);
    }
    await job.flight;
    if (critical && job.storeFailure !== null) {
      throw new ResearchStoreUnavailable(job.storeFailure);
    }
    job.live.phase = state.phase;
    job.live.round = state.rounds.length;
    this.scheduleBroadcast(job);
  }

  private async flushCheckpoints(job: Job): Promise<void> {
    job.writing = true;
    try {
      while (job.checkpointsWritten < job.checkpointsAsked && !this.closed && !job.frozen) {
        const before = job.checkpointsWritten;
        let covered = job.checkpointsAsked;
        const failure = await this.writeWithRetry(
          job,
          "checkpoint",
          () => {
            // Read at the moment of writing: what is stored is the newest the engine has made, not what it was when asked.
            covered = job.checkpointsAsked;
            this.options.store.updateResearchRun(job.runId, { state: job.latestState });
          },
          // The whole window for a write that holds the dispatch of a round, however late that call came in.
          {
            full: () => job.criticalAsked > before,
            stopWhenFrozen: true,
            // A stop that wants no report has no use for a checkpoint that will not go through; the outcome write that
            // follows is the one that matters. A stop that wants a report, and the checkpoint before a dispatch, wait.
            giveUp: () => job.controller.signal.aborted && !job.input.stopWritesReport && !(job.criticalAsked > before),
          },
        );
        job.checkpointsWritten = Math.max(job.checkpointsWritten, covered);
        const critical = job.criticalAsked > before && job.criticalAsked <= covered;
        if (failure && critical && !job.frozen && !this.closed) {
          job.storeFailure = `the next round could not be written before its workers started (${failure.message})`;
          return;
        }
      }
    } finally {
      job.writing = false;
    }
  }

  /**
   * Writes the end of a run that could not be ended as it was: `interrupted`, the state it last saved left as it is.
   * Waits out a busy database like any write the run cannot do without; if even that cannot be written the row stays
   * as it was, and the next boot's sweep closes it.
   */
  private async interruptJob(job: Job, reason: string): Promise<void> {
    await this.writeWithRetry(job, "mark itself interrupted", () => this.interruptRow(job.runId, reason, job), { full: true });
  }

  /**
   * The engine promises an outcome for everything but a programming error, and the bookkeeping around it can
   * still throw (a closed store, a bad report path). Whatever happens, the job ends with a terminal status in the
   * store while the store is open, its controllers aborted so no worker outlives it, and its entry removed.
   */
  private async execute(job: Job, record: ResearchRunRecord): Promise<void> {
    const { store } = this.options;
    let outcome: ResearchOutcome | null = null;
    let failure: string | null = null;
    try {
      const startedAt = this.nowIso();
      this.persist(job, "mark itself running", () => store.updateResearchRun(job.runId, { status: "running", startedAt }));
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
        checkpoint: (state: ResearchRunState, options?: CheckpointOptions) => this.checkpoint(job, state, options),
        now: () => this.options.now?.() ?? Date.now(),
        log: (message: string) => this.options.log?.(`research: run ${job.runId}: ${message}`),
        hardStop: job.hardStop.signal,
      };
      outcome = await this.options.engine(job.input, record.config, deps, job.controller.signal);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.options.log?.(`research: run ${job.runId} threw: ${failure}`);
    }
    job.engineDone = true;
    // Read before the controllers are aborted below: a throw that followed a stop is the stop's doing.
    const stopped = job.controller.signal.aborted;
    try {
      if (!job.controller.signal.aborted) {
        // Only a throw gets here with a live signal; a worker still running must not outlive the run.
        job.controller.abort({ type: "stop", writeReport: false } satisfies ResearchStopRequest);
      }
      if (!job.hardStop.signal.aborted) {
        job.hardStop.abort({ type: "stop", writeReport: false } satisfies ResearchStopRequest);
      }
      const endedAt = this.nowIso();
      let status: ResearchStatus;
      // Whether the outcome the engine reached is what the row now says, and whether the database refused it, so the
      // report the run made is written to the project all the same: that file does not depend on the database.
      let stored = false;
      let refusedOutcome = false;
      if (job.frozen && !outcome?.report) {
        // A shutdown cut the run off: whatever the engine says it ended as, it was interrupted, and the state it saved
        // before is what a later continuation starts from.
        status = "interrupted";
        await this.interruptJob(job, "The server shut down while the run was in flight.");
      } else if (job.storeFailure !== null) {
        status = "interrupted";
        await this.interruptJob(job, `The run's progress could not be saved: ${job.storeFailure}.`);
      } else if (outcome) {
        const finished = outcome;
        status = finished.status;
        // Fail closed: a run is not shown as finished until its outcome is stored. If it cannot be, the run ends
        // interrupted, best effort, and never `completed` on a row that says otherwise.
        const refused = await this.writeWithRetry(
          job,
          "store its outcome",
          () =>
            store.updateResearchRun(job.runId, {
              status: finished.status,
              state: finished.state,
              report: finished.report,
              failure: finished.failure,
              endedAt,
            }),
          { full: true },
        );
        job.live.phase = finished.state.phase;
        job.live.round = finished.state.rounds.length;
        if (refused) {
          status = "interrupted";
          refusedOutcome = true;
          await this.interruptJob(job, `The run's outcome could not be saved (${refused.message}).`);
        } else {
          stored = true;
        }
      } else {
        status = stopped ? "cancelled" : "failed";
        const message = failure ?? "the engine stopped without an outcome.";
        const refused = await this.writeWithRetry(
          job,
          "store its failure",
          () => store.updateResearchRun(job.runId, { status, failure: status === "cancelled" ? `cancelled: ${message}` : `other: ${message}`, endedAt }),
          { full: true },
        );
        if (refused) {
          status = "interrupted";
          await this.interruptJob(job, `How the run ended could not be saved (${refused.message}).`);
        } else {
          // The engine emits its own terminal event; when it threw instead, the log still gets one.
          this.onEvent(job, {
            type: status === "cancelled" ? "run_cancelled" : "run_failed",
            runId: job.runId,
            seq: job.lastSeq + 1,
            at: endedAt,
            phase: job.live.phase,
            round: job.live.round,
            agentId: null,
            payload: { error: message },
          });
        }
      }
      if (outcome?.report && (stored || refusedOutcome) && !this.closed) {
        let current: ResearchRunRecord | null = null;
        try {
          current = store.getResearchRun(job.runId);
        } catch (error) {
          // A database that refused the outcome may refuse this read; the run as it was started has what the file needs.
          if (!refusedOutcome) {
            throw error;
          }
          current = record;
        }
        if (current) {
          try {
            const reportPath = await this.writeReportBounded(job, current, outcome.report, outcome.state);
            if (reportPath && stored) {
              this.persist(job, "store its report path", () => store.updateResearchRun(job.runId, { reportPath }));
            } else if (reportPath) {
              this.options.log?.(`research: run ${job.runId}: its outcome could not be saved, but its report was written to ${reportPath}.`);
            }
          } catch (error) {
            // The report is in the store either way, so nothing is lost; but the person asked for a file, so the
            // run says why there is none: in its events, and on its view for the run's row to show.
            const message = error instanceof Error ? error.message : String(error);
            this.options.log?.(`research: run ${job.runId} could not write its report file: ${message}`);
            this.rememberReportWriteError(job.runId, message);
            this.onEvent(job, {
              type: "report_write_failed",
              runId: job.runId,
              seq: job.lastSeq + 1,
              at: this.nowIso(),
              phase: "done",
              round: job.live.round,
              agentId: null,
              payload: { error: message },
            });
          }
        }
      }
      this.options.log?.(`research: run ${job.runId} ended ${status}.`);
    } catch (error) {
      this.options.log?.(`research: run ${job.runId} bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.jobs.delete(job.runId);
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      this.broadcastNow(job);
    }
  }

  /**
   * `writeReport`, but not for longer than `reportWriteTimeoutMs`: the report is in the store already, and a file
   * write that hangs must not hold the job (and so the thread) open. A write that gives up is let go of, and its
   * path is still stored if it lands later while the store is open, and the run's note then clears. A write that was let
   * go of throws, so the caller records `report_write_failed` and the run's view says why there is no file.
   */
  private async writeReportBounded(job: Job, run: ResearchRunRecord, report: string, state: ResearchRunState): Promise<string | null> {
    const limit = this.options.reportWriteTimeoutMs ?? REPORT_WRITE_TIMEOUT_MS;
    // A synchronous throw from the adapter becomes a rejection like any other.
    const write = Promise.resolve().then(() => this.options.writeReport(job.thread, run, report, state));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const letGo = Symbol("write let go");
    const deadline = new Promise<typeof letGo>((resolve) => {
      timer = setTimeout(() => resolve(letGo), limit);
      timer.unref?.();
    });
    try {
      const first = await Promise.race([write, deadline]);
      if (first !== letGo) {
        return first;
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    write.then(
      (reportPath) => {
        if (reportPath && !this.closed) {
          this.persist(job, "store its report path", () => this.options.store.updateResearchRun(job.runId, { reportPath }));
          this.reportWriteErrors.delete(job.runId);
          this.broadcastNow(job);
        }
      },
      (error) => {
        this.options.log?.(`research: run ${job.runId} report file write failed after it was let go of: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    throw new Error(`the report file could not be written: the project gave no answer within ${limit} ms. The report stays in Ancilla.`);
  }

  private onEvent(job: Job, event: ResearchEvent): void {
    // A frozen job's engine is winding down after a shutdown; what it says about that is not stored (see `Job.frozen`).
    if (this.closed || job.frozen) {
      return;
    }
    // The engine numbers its events; one it left unnumbered, or numbered behind, still lands after the last.
    const seq = Number.isFinite(event.seq) && event.seq > job.lastSeq ? event.seq : job.lastSeq + 1;
    const stored: ResearchEvent = { ...event, runId: job.runId, seq, at: event.at || this.nowIso() };
    job.lastSeq = seq;
    this.persist(job, `store event ${stored.type}`, () => this.options.store.appendResearchEvent(stored));
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
    this.persist(job, `record worker A${update.agentId}`, () => {
      if (!known) {
        store.addResearchWorker({ runId: job.runId, workerSessionId: update.workerSessionId, round: update.round, agentId: update.agentId, status: update.state });
      } else if (known.state !== update.state) {
        store.updateResearchWorker(job.runId, update.workerSessionId, update.state);
      }
    });
    this.scheduleBroadcast(job);
  }

  private scheduleBroadcast(job: Job): void {
    if (job.timer || this.closed) {
      return;
    }
    job.timer = setTimeout(() => {
      job.timer = null;
      this.broadcastNow(job);
    }, RESEARCH_BROADCAST_DEBOUNCE_MS);
    job.timer.unref?.();
  }

  private broadcastNow(job: Job): void {
    if (this.closed) {
      return;
    }
    let record: ResearchRunRecord | null = null;
    try {
      record = this.options.store.getResearchRun(job.runId);
    } catch (error) {
      this.options.log?.(`research: run ${job.runId} could not be read for its broadcast: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!record) {
      return;
    }
    try {
      this.options.broadcast(
        runView(record, this.options.store.listResearchWorkers(job.runId), {
          withReport: false,
          live: job.live,
          reportWriteError: this.reportWriteErrorOf(record),
        }),
      );
    } catch (error) {
      this.options.log?.(`research: run ${job.runId} broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
