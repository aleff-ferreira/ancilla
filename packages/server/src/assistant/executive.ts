import type { QuestionView } from "../browser/sites.js";
import { ConflictError, NotFoundError, ValidationError } from "./store.js";
import { awaitsApproval, stepPrompt, runVerifier, TERMINAL_TASK, type FileRead, type NewTask, type Schedule, type Task, type TaskAttempt, type TaskStatus, type TaskStep, type TaskStore } from "./tasks.js";
import type { AssistantProfile } from "./types.js";

/** What a web task reports about itself while the assistant's browser works on it. */
export interface BrowseReport {
  /** What the task is doing now, for its row. */
  progress(reason: string): void;
  /** A site needs the person's answer: the task shows as waiting for their approval. */
  asking(reason: string): void;
  /** The question was answered: the task goes on. */
  resumed(reason: string): void;
  /** The task is over. `result` is untrusted text from the web, already labelled. */
  settle(outcome: { ok: boolean; result: string; reason: string }): void;
}

/** The assistant's browser, as the executive uses it. The executive owns the task's row and lifecycle; the runner owns the work. */
export interface BrowseRunnerPort {
  /** Starts the work in this process. It reports through `report` and never throws. */
  run(task: Task, report: BrowseReport): void;
  /** The person (or a limit) ended the task: stop the work. */
  cancel(taskId: string, reason: string): void;
  /** Whether the runner is working on this task now. */
  owns(taskId: string): boolean;
  /** The person's answer to the site the task is waiting on ("task", "always", "not-now" or "block"); throws when none is waiting. */
  answer(taskId: string, answer: string): void;
  /** The person's answer to the action the task is waiting on ("do" or "dont"); throws when none is waiting. */
  answerAction(taskId: string, answer: string, folder?: string): void;
  /** What the task is asking the person now (a site or an action, without ids), or null. */
  question(taskId: string): QuestionView | null;
  /** Whether a browser and a model are there for a web task, and if not, why. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  /** The saved rules about which sites the assistant may open, and may not. */
  sites(): Array<{ origin: string; decision: "allow" | "block"; at: number }>;
  removeSite(origin: string): boolean;
}

/**
 * The task executive: it takes work the user approved and sees it through, one step at a time, as turns in a thread
 * the user can open. It adds no runtime of its own. Muse does the work; this decides when a step starts, charges the
 * budget, records what happened, checks the result against something it can read, and says plainly what it does not
 * know.
 *
 * The rules that make it safe to leave running:
 *  - every decision is written before it is acted on, so a restart finds each task where it was;
 *  - every attempt has a fence and a command id; a completion that is not the current attempt's is refused and recorded;
 *  - after a crash an attempt whose outcome is not known is reconciled against the turn ledger, and a step that may have
 *    changed something is never started again on a guess: the task stops and asks;
 *  - a task finishes as completed only when something it could read confirms the result, and as unverified otherwise;
 *  - a limit that is reached stops the task with the reason and the way to raise it, never silently.
 */

export type TurnState = "running" | "completed" | "failed" | "interrupted" | "unknown" | "absent";

export interface ExecutiveHost {
  now(): number;
  /** The key a folder is known by in memory scopes. */
  projectKey(cwd: string): string;
  /** Whether a Muse host can be reached for this folder and account now. */
  hostAvailable(cwd: string, account: string | null): Promise<{ ok: boolean; reason?: string }>;
  /** `modelId` is the model the thread starts on; absent leaves it to Muse. */
  startSession(input: { cwd: string; account: string | null; title: string; modelId?: string | null }): Promise<{ sessionId: string }>;
  /** Puts a thread on a model, doing nothing when it is on it already. Only a call's thread is ever asked to; a task keeps its model. */
  setModel?(sessionId: string, modelId: string): Promise<void>;
  /**
   * Loads a thread on its Muse host as opening it does, for what runs with no page open (a call going on from an earlier
   * conversation): a host that started again holds no thread and refuses every command to one. False when the thread cannot
   * be used (this server does not know it, Muse no longer has it, or another Muse client holds it); an error when its host
   * cannot be reached. Only a call's thread is ever asked to.
   */
  openSession?(sessionId: string): Promise<boolean>;
  /**
   * Sends a prompt in a thread. A plain error means Muse did not take it. An `AmbiguousStartError` means it may have.
   */
  startTurn(input: { sessionId: string; text: string; displayText: string; commandId: string }): Promise<{ turnId: string }>;
  interruptTurn(sessionId: string, turnId: string): Promise<void>;
  /** What the turn ledger says of a turn: the way to learn, after a restart, whether it finished. */
  turnState(sessionId: string, turnId: string): Promise<TurnState>;
  /** A file of the project, for a check. Refuses anything outside the project folder. */
  readProjectFile(cwd: string, relPath: string): Promise<FileRead>;
  /** The thread is waiting for the user (an approval or a question): its time is not charged to the task. */
  needsUser(sessionId: string): boolean;
  /** Hears a thread's notifications until the returned function is called. */
  watch(sessionId: string, handler: (method: string, params: Record<string, unknown>) => void): () => void;
  log(line: string): void;
}

export class AmbiguousStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousStartError";
  }
}

export interface ExecutiveOptions {
  profile: () => AssistantProfile;
  /** The notes that bear on a step, as the block to put in front of its prompt. Its words are never read for memories. */
  memory: (input: { text: string; sessionId: string | null; project: string; account: string | null }) => string | null;
  /** Something changed that a screen may show. */
  changed: (taskId: string | null) => void;
  /** Rules for what to do on its own beyond what the user created; null when there are none. */
  initiative?: (now: number) => Promise<void> | void;
  /** The assistant's own browser, which runs web tasks; absent where there is none to use. */
  browse?: BrowseRunnerPort;
}

const MIN = 60_000;
const DAY = 86_400_000;
const BACKOFF_MS = [30_000, 60_000, 2 * MIN, 5 * MIN, 10 * MIN];
const MAX_OPEN_TASKS = 50;
/** The proposals from the voice that may wait on the user at once, and how long one waits before it is dropped. */
export const MAX_PROPOSALS = 3;
export const PROPOSAL_TTL_MS = DAY;
const EARLY_TTL_MS = 2 * MIN;
const MISSED_AFTER_MS = 5 * MIN;

export interface RecoverySummary {
  resumed: number;
  reconciled: number;
  blocked: number;
}

export class Executive {
  private ticking = false;
  private closed = false;
  private readonly watchers = new Map<string, () => void>();
  /** Events heard before the start that caused them was recorded: kept briefly, then matched, never dropped on a race. */
  private readonly early = new Map<string, { at: number; events: { method: string; params: Record<string, unknown> }[] }>();

  constructor(
    readonly tasks: TaskStore,
    private readonly host: ExecutiveHost,
    private readonly opts: ExecutiveOptions,
  ) {}

  close(): void {
    this.closed = true;
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
  }

  private log(line: string): void {
    this.host.log(`assistant tasks: ${line}`);
  }

  private watch(sessionId: string): void {
    if (this.watchers.has(sessionId) || this.closed) return;
    this.watchers.set(sessionId, this.host.watch(sessionId, (method, params) => this.onTurnEvent(sessionId, method, params)));
  }

  // ------------------------------------------------------------------------------------------------ what the user does

  create(spec: NewTask): Task {
    const profile = this.opts.profile();
    if (!profile.enabled) throw new ConflictError("The assistant is switched off.");
    this.requireRoom();
    const task = this.tasks.create(spec);
    this.opts.changed(task.id);
    this.kick();
    return task;
  }

  private requireRoom(): void {
    if (this.tasks.count(["queued", "running", "waiting", "paused", "blocked"]) >= MAX_OPEN_TASKS) throw new ConflictError(`There are already ${MAX_OPEN_TASKS} open tasks. Finish or cancel some first.`);
  }

  /**
   * The voice's way to ask for a change: the task is made paused and never started, and it stays so until the user
   * approves it on the screen. It takes a place among the open tasks like any task, and only a few may wait at once, so a
   * model that keeps proposing cannot fill the list; the same proposal made twice is the one already waiting.
   */
  propose(spec: NewTask): Task {
    const profile = this.opts.profile();
    if (!profile.enabled) throw new ConflictError("The assistant is switched off.");
    if (!spec.allowWrites || !profile.policy.allowProjectWrites) throw new ConflictError("Project writes are off in the assistant's settings, so a change cannot be proposed.");
    const waiting = this.tasks.byStatus(["paused"]).filter(awaitsApproval);
    const same = waiting.find((t) => t.goal === spec.goal && t.cwd === spec.cwd);
    if (same) return same;
    if (waiting.length >= MAX_PROPOSALS) throw new ConflictError(`${MAX_PROPOSALS} proposals already wait for the user's approval. They need to approve or decline one first.`);
    this.requireRoom();
    const folder = spec.cwd.split(/[\\/]/).filter(Boolean).pop() ?? spec.cwd;
    const task = this.tasks.create({ ...spec, origin: "voice", hold: `Proposed by voice. Waiting for your approval to change files in ${folder}. Nothing runs until you approve it.` });
    this.opts.changed(task.id);
    return task;
  }

  /** The user's approval of a proposal, given on the screen: the only thing that lets it start. */
  approve(taskId: string): Task {
    const task = this.tasks.require(taskId);
    if (!awaitsApproval(task)) throw new ConflictError("There is nothing here to approve.");
    const profile = this.opts.profile();
    if (!profile.enabled) throw new ConflictError("The assistant is switched off.");
    if (!profile.policy.allowProjectWrites) throw new ConflictError("Project writes are off in the assistant's settings. Switch them on to approve this.");
    this.tasks.event(taskId, "approved", null, "the user approved it on the screen");
    const out = this.tasks.setStatus(taskId, "queued", "Approved by you.", { retryAt: null });
    this.opts.changed(taskId);
    this.kick();
    return out;
  }

  // ------------------------------------------------------------------------------------------------ web tasks

  /** A web task is worked on by the assistant's browser in this process: it is only ever running, waiting for an answer, or over. */
  private refuseWeb(task: Task, what: string): void {
    if (task.origin === "browse") throw new ConflictError(`A web task cannot be ${what}. Cancel it and ask again.`);
  }

  /**
   * Starts a web task: a row the person can see and cancel, worked on at once by the assistant's own browser. The row is made
   * running and never queued, so the step machine never meets it; its end comes back through the report.
   */
  createBrowse(spec: NewTask): Task {
    const profile = this.opts.profile();
    if (!profile.enabled) throw new ConflictError("The assistant is switched off.");
    const runner = this.opts.browse;
    if (!runner) throw new ConflictError("Browsing is not available here.");
    // One at a time: there is one assistant tab. A row that nothing is working on (the runner lost track of it) does not count.
    for (const open of this.tasks.byStatus(["running", "paused"]).filter((t) => t.origin === "browse")) {
      if (runner.owns(open.id)) throw new ConflictError("The assistant is already browsing. Wait for it to finish, or cancel it.");
      this.tasks.setStatus(open.id, "failed", "The assistant lost track of this web task.");
      this.opts.changed(open.id);
    }
    this.requireRoom();
    const created = this.tasks.create({ ...spec, origin: "browse", allowWrites: false, steps: [{ title: "Look it up on the web", prompt: null, effect: "read", verifier: null }] });
    const task = this.tasks.setStatus(created.id, "running", "Starting the browser.");
    this.opts.changed(task.id);
    runner.run(task, this.browseReport(task.id));
    return task;
  }

  /** Whether a web task can be made now, and if not, why: said before the task exists, not after it fails. */
  async browseAvailable(): Promise<{ ok: boolean; reason?: string }> {
    return this.opts.browse ? this.opts.browse.available() : { ok: false, reason: "Browsing is not available here." };
  }

  /** The saved rules about which sites the assistant may open, and may not. */
  browseSites(): Array<{ origin: string; decision: "allow" | "block"; at: number }> {
    return this.opts.browse?.sites() ?? [];
  }

  removeBrowseSite(origin: string): boolean {
    return this.opts.browse?.removeSite(origin) ?? false;
  }

  /** The person's answer, on the screen, to the site a web task is waiting on. */
  answerSite(taskId: string, answer: string): Task {
    const task = this.tasks.require(taskId);
    if (task.origin !== "browse" || TERMINAL_TASK.has(task.status)) throw new ConflictError("This task is not waiting on a site.");
    if (!this.opts.browse) throw new ConflictError("Browsing is not available here.");
    this.opts.browse.answer(taskId, answer);
    return this.tasks.require(taskId);
  }

  /** The person's answer, on the screen, to the action a web task is waiting on: "do" or "dont". */
  answerAction(taskId: string, answer: string, folder?: string): Task {
    const task = this.tasks.require(taskId);
    if (task.origin !== "browse" || TERMINAL_TASK.has(task.status)) throw new ConflictError("This task is not waiting on an action.");
    if (!this.opts.browse) throw new ConflictError("Browsing is not available here.");
    this.opts.browse.answerAction(taskId, answer, folder);
    return this.tasks.require(taskId);
  }

  /** What a web task is asking the person now: a site or an action, as a screen shows it. */
  browseQuestion(taskId: string): QuestionView | null {
    const task = this.tasks.get(taskId);
    if (!task || task.origin !== "browse" || TERMINAL_TASK.has(task.status)) return null;
    return this.opts.browse?.question(taskId) ?? null;
  }

  private browseReport(taskId: string): BrowseReport {
    const open = (status: TaskStatus): Task | null => {
      const task = this.tasks.get(taskId);
      return task && task.status === status ? task : null;
    };
    return {
      progress: (reason) => {
        if (!open("running")) return;
        this.tasks.setStatus(taskId, "running", reason);
        this.opts.changed(taskId);
      },
      asking: (reason) => {
        // Also when it already waits: the question on the screen may have changed to the next one.
        const task = this.tasks.get(taskId);
        if (!task || (task.status !== "running" && task.status !== "paused") || (task.status === "paused" && task.reason === reason)) return;
        this.tasks.setStatus(taskId, "paused", reason);
        this.opts.changed(taskId);
      },
      resumed: (reason) => {
        if (!open("paused")) return;
        this.tasks.setStatus(taskId, "running", reason);
        this.opts.changed(taskId);
      },
      settle: ({ ok, result, reason }) => {
        const task = this.tasks.get(taskId);
        // A task the person cancelled in the meantime stays cancelled.
        if (!task || TERMINAL_TASK.has(task.status)) return;
        const step = this.tasks.steps(taskId)[0];
        if (step) this.tasks.updateStep(step.id, { status: ok ? "done" : "failed", evidence: reason });
        this.tasks.setStatus(taskId, ok ? "completed" : "failed", reason, { result });
        this.opts.changed(taskId);
      },
    };
  }

  /** Runs a tick without making the caller wait for it. */
  kick(): void {
    void this.tick().catch((error) => this.log(`a tick failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  pause(taskId: string): Task {
    const task = this.tasks.require(taskId);
    if (TERMINAL_TASK.has(task.status)) throw new ConflictError("This task is finished.");
    this.refuseWeb(task, "paused");
    if (task.status === "paused") return task;
    // Pausing stops new work. A turn that is running is left to finish, and its result is recorded.
    const out = this.tasks.setStatus(taskId, "paused", this.tasks.runningAttempt(taskId) ? "Paused. The turn in progress will finish first." : "Paused by you.", { retryAt: null });
    this.opts.changed(taskId);
    return out;
  }

  /** The assistant was switched off: nothing new starts. A turn already running finishes and is recorded. */
  pauseAll(reason: string): number {
    let n = 0;
    for (const task of this.tasks.byStatus(["queued", "running", "waiting", "paused"])) {
      if (task.origin === "browse") {
        // A web task cannot wait, not even for an answer: switching the assistant off stops it.
        this.tasks.setStatus(task.id, "cancelled", reason, { retryAt: null });
        this.opts.browse?.cancel(task.id, reason);
      } else if (task.status !== "paused") {
        this.tasks.setStatus(task.id, "paused", reason, { retryAt: null });
      } else {
        continue;
      }
      this.opts.changed(task.id);
      n += 1;
    }
    return n;
  }

  resume(taskId: string): Task {
    const task = this.tasks.require(taskId);
    if (awaitsApproval(task)) throw new ConflictError("This proposal waits for the user's approval on the screen, and a resume does not give it.");
    this.refuseWeb(task, "resumed");
    if (task.status !== "paused" && task.status !== "waiting") throw new ConflictError("Only a paused or waiting task can be resumed.");
    const out = this.tasks.setStatus(taskId, this.tasks.runningAttempt(taskId) ? "running" : "queued", "Resumed.", { retryAt: null });
    this.opts.changed(taskId);
    this.kick();
    return out;
  }

  async cancel(taskId: string, reason = "Cancelled by you."): Promise<Task> {
    const task = this.tasks.require(taskId);
    if (TERMINAL_TASK.has(task.status)) throw new ConflictError("This task is finished.");
    const attempt = this.tasks.runningAttempt(taskId);
    // The task is cancelled first. Whatever the turn does from here on is refused as stale when it reports.
    for (const step of this.tasks.steps(taskId)) {
      if (step.status === "pending" || step.status === "running") this.tasks.updateStep(step.id, { status: "cancelled" });
    }
    if (attempt) this.tasks.finishAttempt(attempt.id, "cancelled", reason);
    const out = this.tasks.setStatus(taskId, "cancelled", reason, { retryAt: null });
    this.opts.changed(taskId);
    if (task.origin === "browse") this.opts.browse?.cancel(taskId, reason);
    if (attempt?.sessionId && attempt.turnId) {
      try {
        await this.host.interruptTurn(attempt.sessionId, attempt.turnId);
        this.tasks.event(taskId, "interrupt-sent", attempt.id, attempt.turnId);
      } catch (error) {
        // Said, not hidden: the task is cancelled either way, but the turn may still be running in the thread.
        this.tasks.event(taskId, "interrupt-not-confirmed", attempt.id, error instanceof Error ? error.message : String(error));
      }
    }
    return out;
  }

  retry(taskId: string): Task {
    const task = this.tasks.require(taskId);
    this.refuseWeb(task, "tried again");
    if (task.status !== "failed" && task.status !== "blocked") throw new ConflictError("Only a failed or blocked task can be tried again.");
    if (this.tasks.runningAttempt(taskId)) throw new ConflictError("A turn of this task is still running.");
    for (const step of this.tasks.steps(taskId)) {
      if (step.status === "failed" || step.status === "unknown") this.tasks.updateStep(step.id, { status: "pending", evidence: "", verified: false });
    }
    this.tasks.event(taskId, "retried", null, "the user asked for it to be tried again");
    const out = this.tasks.setStatus(taskId, "queued", "Trying again.", { retryAt: null, failures: 0 });
    this.opts.changed(taskId);
    this.kick();
    return out;
  }

  extend(taskId: string, turns: number, minutes: number): Task {
    const task = this.tasks.require(taskId);
    if (TERMINAL_TASK.has(task.status)) throw new ConflictError("This task is finished.");
    this.refuseWeb(task, "extended");
    const p = this.opts.profile().policy;
    const t = Math.max(0, Math.min(50, Math.floor(turns)));
    const m = Math.max(0, Math.min(240, Math.floor(minutes)));
    if (t === 0 && m === 0) throw new ValidationError("turns", "extend by some turns or some minutes");
    if (task.maxTurns + t > p.maxTurnsPerTask * 2 || task.maxMinutes + m > p.maxMinutesPerTask * 2) throw new ValidationError("turns", "a task may be extended to at most twice the assistant's limits");
    this.tasks.extendBudget(taskId, t, m);
    const budgetStop = task.status === "blocked" && /budget/i.test(task.reason);
    const out = budgetStop ? this.tasks.setStatus(taskId, "queued", "Budget extended.", { retryAt: null }) : this.tasks.require(taskId);
    this.opts.changed(taskId);
    if (budgetStop) this.kick();
    return out;
  }

  /** The user's answer for a step the executive could not settle: it did run, run it again, or leave it out. */
  resolve(taskId: string, stepId: string, resolution: "done" | "retry" | "skip"): Task {
    const task = this.tasks.require(taskId);
    this.refuseWeb(task, "resolved by hand");
    const step = this.tasks.step(stepId);
    if (!step || step.taskId !== taskId) throw new NotFoundError("The step");
    if (TERMINAL_TASK.has(task.status)) throw new ConflictError("This task is finished.");
    if (step.status !== "unknown" && step.status !== "failed") throw new ConflictError("Only a step that failed or could not be settled can be resolved.");
    if (resolution === "done") this.tasks.updateStep(stepId, { status: "done", evidence: "Marked as done by you.", verified: false });
    else if (resolution === "skip") this.tasks.updateStep(stepId, { status: "skipped", evidence: "Left out by you." });
    else this.tasks.updateStep(stepId, { status: "pending", evidence: "", verified: false });
    this.tasks.event(taskId, "resolved", null, `${resolution}: step ${step.ord + 1}`);
    const blockedStill = this.tasks.steps(taskId).some((st) => st.status === "unknown" || st.status === "failed");
    const out = blockedStill ? this.tasks.require(taskId) : this.tasks.setStatus(taskId, "queued", "Continuing.", { retryAt: null });
    this.opts.changed(taskId);
    if (!blockedStill) this.kick();
    return out;
  }

  /** The user looked at a task that finished without a check, or waits on a manual one, and says it is right. */
  confirm(taskId: string): Task {
    const task = this.tasks.require(taskId);
    this.refuseWeb(task, "confirmed");
    const steps = this.tasks.steps(taskId);
    const waiting = task.status === "unverified" || (task.status === "blocked" && steps.every((st) => st.status === "done" || st.status === "skipped"));
    if (!waiting) throw new ConflictError("There is nothing here to confirm.");
    for (const st of steps) if (st.verifier?.type === "manual") this.tasks.updateStep(st.id, { status: "done", evidence: "Confirmed by you.", verified: true });
    const out = this.tasks.setStatus(taskId, "completed", "Confirmed by you.", { result: `${task.result} Confirmed by you.`.trim() });
    this.opts.changed(taskId);
    return out;
  }

  // ------------------------------------------------------------------------------------------------ the loop

  /**
   * One pass: due schedules become tasks, tasks over their time are stopped, tasks waiting on a retry are woken, and
   * queued tasks start as far as the limits allow. Safe to call at any time and from anywhere; a pass that is running
   * makes the next one a no-op.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const profile = this.opts.profile();
      if (!profile.enabled) return;
      const now = this.host.now();
      this.pruneEarly(now);
      // Each stage on its own: one that fails does not take the others, or the next pass, with it.
      await this.stage("schedules", () => this.releaseSchedules(now, profile));
      await this.stage("initiative", () => this.opts.initiative?.(now));
      await this.stage("limits", () => this.enforceLimits());
      await this.stage("proposals", () => this.expireProposals(now));
      await this.stage("waiting", () => this.wakeWaiting(now));
      await this.stage("start", () => this.startQueued(now, profile));
    } finally {
      this.ticking = false;
    }
  }

  private async stage(name: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A proposal nobody approved within a day is dropped: what it was about has probably moved on, and it holds a place in the list. */
  private async expireProposals(now: number): Promise<void> {
    for (const task of this.tasks.byStatus(["paused"])) {
      if (awaitsApproval(task) && now - task.createdAt >= PROPOSAL_TTL_MS) await this.cancel(task.id, "Nobody approved this within a day, so it was dropped.");
    }
  }

  private wakeWaiting(now: number): void {
    for (const task of this.tasks.byStatus(["waiting"])) {
      if (task.retryAt !== null && task.retryAt <= now) {
        this.tasks.setStatus(task.id, "queued", "Trying again.", { retryAt: null });
        this.opts.changed(task.id);
      }
    }
  }

  private async startQueued(now: number, profile: AssistantProfile): Promise<void> {
    const running = this.tasks.count(["running"]);
    let slots = Math.max(0, profile.policy.maxConcurrent - running);
    let startedToday = this.tasks.startedSince(now - DAY);
    for (const task of this.tasks.byStatus(["queued"])) {
      const fresh = task.startedAt === null;
      if (slots <= 0) {
        this.note(task, `Waiting for a free slot: ${profile.policy.maxConcurrent} task${profile.policy.maxConcurrent === 1 ? " is" : "s are"} running, which is the limit.`);
        continue;
      }
      if (fresh && startedToday >= profile.policy.maxTasksPerDay) {
        this.note(task, `Waiting: ${profile.policy.maxTasksPerDay} tasks have started in the last day, which is the limit.`);
        continue;
      }
      slots -= 1;
      if (fresh) startedToday += 1;
      await this.advance(task.id);
    }
  }

  private note(task: Task, reason: string): void {
    if (task.reason !== reason) {
      this.tasks.setStatus(task.id, "queued", reason, { retryAt: null });
      this.opts.changed(task.id);
    }
  }

  private wait(task: Task, reason: string): void {
    const failures = task.failures + 1;
    const delay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] as number;
    this.tasks.setStatus(task.id, "waiting", reason, { retryAt: this.host.now() + delay, failures });
    this.opts.changed(task.id);
  }

  private block(task: Task, reason: string): void {
    this.tasks.setStatus(task.id, "blocked", reason, { retryAt: null });
    this.opts.changed(task.id);
  }

  /** Starts the next step of a task, or finishes it. The one place a turn is begun. */
  private async advance(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== "queued" && task.status !== "running")) return;
    if (this.tasks.runningAttempt(taskId)) return;
    const steps = this.tasks.steps(taskId);
    const hurt = steps.find((st) => st.status === "unknown" || st.status === "failed");
    if (hurt) {
      this.block(task, `Step ${hurt.ord + 1} ${hurt.status === "unknown" ? "may or may not have run" : "failed"}. ${hurt.evidence}`.trim());
      return;
    }
    const step = steps.find((st) => st.status === "pending");
    if (!step) {
      await this.finish(task, steps);
      return;
    }
    if (task.turnsUsed >= task.maxTurns) {
      this.block(task, `The turn budget is used up (${task.turnsUsed} of ${task.maxTurns}). Extend it to continue.`);
      return;
    }
    if (this.tasks.elapsedMs(taskId) >= task.maxMinutes * MIN) {
      this.block(task, `The time budget is used up (${task.maxMinutes} minutes). Extend it to continue.`);
      return;
    }
    const reach = await this.host.hostAvailable(task.cwd, task.account);
    if (!reach.ok) {
      this.wait(task, `Muse is not reachable${reach.reason ? `: ${reach.reason}` : ""}. Trying again shortly.`);
      return;
    }
    let sessionId = task.sessionId;
    if (!sessionId) {
      try {
        sessionId = (await this.host.startSession({ cwd: task.cwd, account: task.account, title: `Task: ${task.title}` })).sessionId;
      } catch (error) {
        this.wait(task, `Could not open a thread for it: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.tasks.setSession(taskId, sessionId);
    }
    this.watch(sessionId);
    // The user may have cancelled or paused while a host was starting.
    const current = this.tasks.get(taskId);
    if (!current || (current.status !== "queued" && current.status !== "running")) return;
    const attempt = this.tasks.startAttempt(taskId, step.id);
    this.tasks.setStatus(taskId, "running", `Step ${step.ord + 1} of ${steps.length}: ${step.title}`, { retryAt: null });
    this.opts.changed(taskId);
    const notes = this.opts.memory({ text: `${task.goal}\n${step.title}`, sessionId, project: task.project, account: task.account });
    const prompt = stepPrompt(task, step, step.ord, steps.length);
    let turnId: string;
    try {
      turnId = (await this.host.startTurn({ sessionId, text: notes ? `${notes}\n\n${prompt}` : prompt, displayText: `Task: ${task.title}\nStep ${step.ord + 1} of ${steps.length}: ${step.title}`, commandId: attempt.commandId })).turnId;
    } catch (error) {
      this.startFailed(task, step, attempt, error);
      return;
    }
    const after = this.tasks.get(taskId);
    const mine = this.tasks.attempt(attempt.id);
    if (!after || !mine || mine.outcome !== "running" || mine.fence !== after.fence || TERMINAL_TASK.has(after.status)) {
      // Cancelled while the turn was being started: it started anyway, and is stopped.
      this.tasks.bindTurn(attempt.id, sessionId, turnId);
      this.tasks.event(taskId, "stale-start-stopped", attempt.id, turnId);
      void this.host.interruptTurn(sessionId, turnId).catch(() => undefined);
      return;
    }
    this.tasks.bindTurn(attempt.id, sessionId, turnId);
    this.flushEarly(sessionId, turnId);
  }

  private startFailed(task: Task, step: TaskStep, attempt: TaskAttempt, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AmbiguousStartError) {
      // The prompt may have reached Muse. A step that only reads can be asked again; one that can change things cannot.
      this.tasks.finishAttempt(attempt.id, "unknown", message);
      if (step.effect === "read") {
        this.tasks.updateStep(step.id, { status: "pending" });
        this.wait(this.tasks.require(task.id), `Not sure the step started (${message}). It only reads, so it will be tried again.`);
      } else {
        this.tasks.updateStep(step.id, { status: "unknown", evidence: `Muse may have started it: ${message}` });
        this.block(this.tasks.require(task.id), `Step ${step.ord + 1} may have started: ${message}. Check the thread, then say whether it ran.`);
      }
      return;
    }
    // Muse did not take the prompt, so nothing ran: the step goes back, and the turn it did not use is not charged.
    this.tasks.finishAttempt(attempt.id, "failed", message);
    this.tasks.updateStep(step.id, { status: "pending" });
    this.tasks.refundTurn(task.id);
    const fresh = this.tasks.require(task.id);
    if (fresh.failures + 1 >= 5) this.block(fresh, `Muse refused the step five times: ${message}`);
    else this.wait(fresh, `Could not start the step: ${message}`);
  }

  // ------------------------------------------------------------------------------------------------ hearing the turn

  onTurnEvent(sessionId: string, method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    const turnId = typeof params["turnId"] === "string" ? params["turnId"] : null;
    if (!turnId) return;
    if (method !== "turn/started" && method !== "turn/completed") return;
    const attempt = this.tasks.attemptOfTurn(sessionId, turnId);
    if (!attempt) {
      if (this.startInFlight(sessionId)) {
        const key = `${sessionId}:${turnId}`;
        const held = this.early.get(key) ?? { at: this.host.now(), events: [] };
        held.events.push({ method, params });
        this.early.set(key, held);
        if (this.early.size > 200) this.early.delete(this.early.keys().next().value as string);
        return;
      }
      if (method === "turn/started") this.foreignTurn(sessionId);
      return;
    }
    if (method === "turn/started") return;
    void this.completed(attempt, params).catch((error) => {
      // A server that is closing finds its file closed under a late report; that is not worth a line.
      if (!this.closed) this.log(`could not record a turn's end: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private startInFlight(sessionId: string): boolean {
    return this.tasks.unboundAttempts().some((a) => a.sessionId === sessionId);
  }

  private flushEarly(sessionId: string, turnId: string): void {
    const key = `${sessionId}:${turnId}`;
    const held = this.early.get(key);
    if (!held) return;
    this.early.delete(key);
    for (const event of held.events) this.onTurnEvent(sessionId, event.method, event.params);
  }

  private pruneEarly(now: number): void {
    for (const [key, held] of this.early) if (now - held.at > EARLY_TTL_MS) this.early.delete(key);
  }

  /** A turn the executive did not start began in a task's thread: the user is using it, and what they say comes first. */
  private foreignTurn(sessionId: string): void {
    for (const task of this.tasks.byStatus(["running", "queued", "waiting"])) {
      if (task.sessionId !== sessionId) continue;
      this.tasks.setStatus(task.id, "paused", "You sent a message in this task's thread, so the task is paused. Resume it when you are ready.", { retryAt: null });
      this.tasks.event(task.id, "takeover", null, "a turn that was not the task's began in its thread");
      this.opts.changed(task.id);
    }
  }

  private async completed(attempt: TaskAttempt, params: Record<string, unknown>): Promise<void> {
    const task = this.tasks.get(attempt.taskId);
    const fresh = this.tasks.attempt(attempt.id);
    if (!task || !fresh || fresh.outcome !== "running" || fresh.fence !== task.fence || TERMINAL_TASK.has(task.status)) {
      // Not the current attempt's turn, or the task has moved on (cancelled, say): recorded, and changes nothing.
      this.tasks.event(attempt.taskId, "stale-completion-refused", attempt.id, `${attempt.turnId ?? "?"} reported after ${fresh?.outcome ?? "its attempt was gone"}`);
      this.opts.changed(attempt.taskId);
      return;
    }
    const terminal = typeof params["terminal"] === "string" ? params["terminal"] : "completed";
    const step = this.tasks.step(attempt.stepId);
    if (!step) return;
    if (terminal === "completed") {
      this.tasks.finishAttempt(attempt.id, "succeeded", "The turn finished without an error.");
      await this.afterSuccess(task, step);
      return;
    }
    const errorText = typeof (params["error"] as { message?: unknown } | undefined)?.message === "string" ? String((params["error"] as { message: string }).message) : `The turn ${terminal}.`;
    if (terminal === "failed") {
      this.tasks.finishAttempt(attempt.id, "failed", errorText);
      this.afterFailure(task, step, errorText);
      return;
    }
    // Interrupted from outside the task (in the thread, or the host went away): nobody asked it to stop, and what it did is unknown.
    this.tasks.finishAttempt(attempt.id, "cancelled", errorText);
    if (step.effect === "read") this.tasks.updateStep(step.id, { status: "pending" });
    else this.tasks.updateStep(step.id, { status: "unknown", evidence: "The turn was interrupted before it finished." });
    this.tasks.setStatus(task.id, "paused", `The turn was interrupted, so the task is paused. ${step.effect === "read" ? "Resume it to run the step again." : "Check the thread, then say whether the step ran."}`, { retryAt: null });
    this.opts.changed(task.id);
  }

  private async afterSuccess(task: Task, step: TaskStep): Promise<void> {
    if (step.verifier) {
      const verdict = await runVerifier(step.verifier, (path) => this.host.readProjectFile(task.cwd, path));
      if (verdict.manual) {
        this.tasks.updateStep(step.id, { status: "done", evidence: verdict.evidence, verified: false });
      } else if (verdict.ok) {
        this.tasks.updateStep(step.id, { status: "done", evidence: verdict.evidence, verified: true });
        this.tasks.event(task.id, "verified", null, verdict.evidence);
      } else {
        this.tasks.updateStep(step.id, { status: "failed", evidence: verdict.evidence, verified: false });
        this.tasks.event(task.id, "verify-failed", null, verdict.evidence);
        this.block(this.tasks.require(task.id), `Step ${step.ord + 1} finished but the check failed: ${verdict.evidence}`);
        return;
      }
    } else {
      this.tasks.updateStep(step.id, { status: "done", evidence: "The turn finished without an error. Nothing checked what it did.", verified: false });
    }
    const now = this.tasks.require(task.id);
    this.opts.changed(task.id);
    if (now.status === "paused" || now.status === "cancelled") return;
    await this.advance(task.id);
  }

  private afterFailure(task: Task, step: TaskStep, message: string): void {
    const fresh = this.tasks.require(task.id);
    if (step.effect === "read" && step.attempts < 2 && fresh.status !== "paused") {
      this.tasks.updateStep(step.id, { status: "pending", evidence: `Failed once: ${message}` });
      this.wait(fresh, `The turn failed (${message}). The step only reads, so it will be tried once more.`);
      return;
    }
    this.tasks.updateStep(step.id, { status: "failed", evidence: message });
    this.tasks.setStatus(task.id, "failed", `Step ${step.ord + 1} failed: ${message}`, { retryAt: null });
    this.opts.changed(task.id);
  }

  private async finish(task: Task, steps: TaskStep[]): Promise<void> {
    const waitingOnUser = steps.filter((st) => st.verifier?.type === "manual" && !st.verified);
    if (waitingOnUser.length > 0) {
      this.block(task, "Everything ran. Look at the result and confirm it.");
      return;
    }
    const checks = steps.filter((st) => st.verifier);
    const passed = checks.filter((st) => st.verified);
    const skipped = steps.filter((st) => st.status === "skipped").length;
    const evidence = passed.map((st) => st.evidence).join(" ");
    if (checks.length > 0 && passed.length === checks.length) {
      this.tasks.setStatus(task.id, "completed", "Done, and checked.", { result: `${steps.length - skipped} of ${steps.length} steps finished. ${evidence}`.trim() });
    } else {
      this.tasks.setStatus(task.id, "unverified", "Finished, but nothing checked the result. Open the thread to see what it did, then confirm it.", { result: `${steps.length - skipped} of ${steps.length} steps finished without an error. No check was set for the result.` });
    }
    this.opts.changed(task.id);
  }

  // ------------------------------------------------------------------------------------------------ limits and schedules

  private async enforceLimits(): Promise<void> {
    for (const task of this.tasks.byStatus(["running"])) {
      const attempt = this.tasks.runningAttempt(task.id);
      if (!attempt || (task.sessionId !== null && this.host.needsUser(task.sessionId))) continue;
      if (this.tasks.elapsedMs(task.id) < task.maxMinutes * MIN) continue;
      this.tasks.finishAttempt(attempt.id, "timeout", `The time budget (${task.maxMinutes} minutes) ran out.`);
      const step = this.tasks.step(attempt.stepId);
      if (step) {
        if (step.effect === "read") this.tasks.updateStep(step.id, { status: "pending" });
        else this.tasks.updateStep(step.id, { status: "unknown", evidence: "Stopped by the time budget while it was running." });
      }
      this.block(this.tasks.require(task.id), `The time budget is used up (${task.maxMinutes} minutes), so the turn was stopped. ${step?.effect === "write" ? "Check the thread, then say whether the step ran. " : ""}Extend the budget to continue.`);
      if (attempt.sessionId && attempt.turnId) {
        try {
          await this.host.interruptTurn(attempt.sessionId, attempt.turnId);
        } catch (error) {
          this.tasks.event(task.id, "interrupt-not-confirmed", attempt.id, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  private async releaseSchedules(now: number, profile: AssistantProfile): Promise<void> {
    for (const sch of this.tasks.dueSchedules(now)) {
      const late = now - (sch.nextRunAt ?? now);
      const missed = late > MISSED_AFTER_MS;
      const previous = sch.lastTaskId ? this.tasks.get(sch.lastTaskId) : null;
      let run = true;
      let why = "";
      if (missed && sch.catchUp === "skip") {
        run = false;
        why = "missed while Ancilla was closed";
      } else if (missed && late > DAY) {
        run = false;
        why = "missed by more than a day";
      } else if (previous && !TERMINAL_TASK.has(previous.status)) {
        run = false;
        why = "the last run is still going";
      }
      let taskId: string | null = null;
      if (run) {
        try {
          taskId = this.create(this.fromSchedule(sch, profile)).id;
        } catch (error) {
          why = error instanceof Error ? error.message : String(error);
        }
      }
      this.tasks.advanceSchedule(sch, now, { taskId, at: now });
      this.log(`schedule ${sch.id} ${taskId ? `ran as ${taskId}` : `skipped a run: ${why}`}`);
    }
  }

  private fromSchedule(sch: Schedule, profile: AssistantProfile): NewTask {
    const writes = sch.allowWrites && profile.policy.allowProjectWrites;
    const steps = sch.steps.length > 0 ? sch.steps : [{ title: sch.goal.length > 120 ? `${sch.goal.slice(0, 117)}...` : sch.goal }];
    return {
      title: sch.title, goal: sch.goal, goalId: null, cwd: sch.cwd, project: sch.project, account: sch.account, allowWrites: writes,
      maxTurns: profile.policy.maxTurnsPerTask, maxMinutes: profile.policy.maxMinutesPerTask, origin: "schedule", scheduleId: sch.id,
      steps: steps.map((st) => ({ title: st.title, prompt: st.prompt ?? null, effect: writes ? (st.effect ?? "write") : "read", verifier: st.verifier ?? null })),
    };
  }

  // ------------------------------------------------------------------------------------------------ after a restart

  /**
   * Settles what a restart left in the air. An attempt whose turn the ledger knows finished is recorded as such. One
   * the ledger does not know is not retried unless the step only reads: a step that can change things stops the task
   * and asks, because running it twice is worse than asking once.
   */
  async recover(): Promise<RecoverySummary> {
    const summary: RecoverySummary = { resumed: 0, reconciled: 0, blocked: 0 };
    // A web task lives in the process that was working on it: one that is still open now has lost it, and is ended, never started again.
    for (const task of this.tasks.byStatus(["running", "queued", "waiting", "paused", "blocked"])) {
      if (task.origin !== "browse" || this.opts.browse?.owns(task.id)) continue;
      this.tasks.setStatus(task.id, "failed", "Ancilla stopped while this web task ran, so it ended. Ask again to run it again.");
      this.opts.changed(task.id);
    }
    for (const task of this.tasks.byStatus(["running", "queued", "waiting", "paused", "blocked"])) {
      if (task.sessionId) this.watch(task.sessionId);
    }
    for (const task of this.tasks.byStatus(["running"])) {
      const attempt = this.tasks.runningAttempt(task.id);
      if (!attempt) {
        this.tasks.setStatus(task.id, "queued", "Picked up again after a restart.", { retryAt: null });
        summary.resumed += 1;
        continue;
      }
      const step = this.tasks.step(attempt.stepId);
      if (!step) continue;
      let state: TurnState = "unknown";
      if (attempt.sessionId && attempt.turnId) {
        try {
          state = await this.host.turnState(attempt.sessionId, attempt.turnId);
        } catch {
          state = "unknown";
        }
      }
      summary.reconciled += 1;
      this.tasks.event(task.id, "reconciled", attempt.id, `the ledger says the turn is ${state}`);
      if (state === "completed") {
        this.tasks.finishAttempt(attempt.id, "succeeded", "Found finished after a restart.");
        await this.afterSuccess(this.tasks.require(task.id), step);
      } else if (state === "failed") {
        this.tasks.finishAttempt(attempt.id, "failed", "Found failed after a restart.");
        this.afterFailure(this.tasks.require(task.id), step, "The turn failed while Ancilla was closed.");
      } else if (state === "running") {
        // Still going, and its end will arrive on the thread's feed.
        this.tasks.event(task.id, "still-running", attempt.id, "the turn is still running");
      } else {
        this.tasks.finishAttempt(attempt.id, "unknown", `Ancilla restarted while it ran, and the turn is ${state}.`);
        if (step.effect === "read") {
          this.tasks.updateStep(step.id, { status: "pending" });
          this.tasks.setStatus(task.id, "queued", "Ancilla restarted during a step that only reads, so it will run again.", { retryAt: null });
          summary.resumed += 1;
        } else {
          this.tasks.updateStep(step.id, { status: "unknown", evidence: "Ancilla restarted while this step ran, so it is not known whether it finished." });
          this.block(this.tasks.require(task.id), `Ancilla restarted while step ${step.ord + 1} ran, so it is not known whether it finished. It was not run again. Check the thread, then say whether it ran.`);
          summary.blocked += 1;
        }
      }
      this.opts.changed(task.id);
    }
    // An attempt that never heard back from Muse (the start was cut off) belongs to a task that is not running any more.
    for (const attempt of this.tasks.unboundAttempts()) {
      const task = this.tasks.get(attempt.taskId);
      if (!task || TERMINAL_TASK.has(task.status)) {
        this.tasks.finishAttempt(attempt.id, "unknown", "The task ended before its turn started.");
        continue;
      }
      if (task.status === "running") continue;
      this.tasks.finishAttempt(attempt.id, "unknown", "Ancilla restarted before Muse answered the start.");
    }
    this.opts.changed(null);
    this.kick();
    return summary;
  }
}

export type { TaskStatus };
