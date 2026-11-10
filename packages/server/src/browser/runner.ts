import type { BrowseReport, BrowseRunnerPort } from "../assistant/executive.js";
import { ConflictError, ValidationError } from "../assistant/store.js";
import type { Task } from "../assistant/tasks.js";
import type { BrainProvider } from "../voice/brain.js";
import { BrowseAgent, type BrowseOutcome } from "./agent.js";
import type { BrowserService } from "./service.js";
import { actionReason } from "./commit.js";
import { ACTION_ANSWERS, SITE_ANSWERS, questionView, type ActionAnswer, type GateQuestion, type QuestionView, type SiteAnswer, type SiteGate } from "./sites.js";
import { ServiceSurface, type BrowseSurface, type SurfaceGate } from "./surface.js";

/**
 * Runs the web task the executive made: the browsing agent, on the assistant's browser, behind the sites gate. It owns nothing
 * of the task's row; it reports what happens, and the executive writes it down. One task at a time, because there is one
 * assistant tab; a person's answer to a site question comes in through `answer`, and a cancel through `cancel`.
 */

export interface BrowseRunnerDeps {
  /** The browser the server owns (made the first time it is asked for). */
  service: () => BrowserService;
  /** The model that does the browsing, or why there is none. */
  brain: () => { brain: BrainProvider; problem: string | null };
  gate: SiteGate;
  log: (line: string) => void;
  /** Tests give their own surface. */
  surface?: (service: BrowserService, gate: SurfaceGate) => BrowseSurface;
  now?: () => number;
}

/** A question nobody answers in this long counts as "not now". */
export const QUESTION_MS = 10 * 60_000;

interface Job {
  taskId: string;
  abort: AbortController;
  report: BrowseReport;
  goal: string;
  steps: string[];
  asking: boolean;
  startedAt: number;
  /** When the clock was stopped for a question, or null while it runs; and how long it has been stopped in all. */
  pausedAt: number | null;
  pausedTotal: number;
  surface: BrowseSurface | null;
}

/** What the person sees waiting for them: the site, and that it leads into this computer or their network when it does; or the action. */
export function questionReason(question: GateQuestion | null): string {
  if (!question) return "Waiting for your approval to open a site.";
  if (question.type === "action") return actionReason(question);
  return `Waiting for your approval to open ${question.origin}${question.kind === "local" ? " (a page on this computer or your network)" : ""}.`;
}

/** What is kept of a task that answered: the answer, labelled as what it is, and where it came from. */
export function describeOutcome(outcome: BrowseOutcome): { ok: boolean; result: string; reason: string } {
  if (!outcome.ok) return { ok: false, result: "", reason: outcome.reason };
  const pages = outcome.pages.length > 0 ? `\nPages: ${outcome.pages.join(", ")}` : "";
  return {
    ok: true,
    result: `From the web (not checked):\n${outcome.answer}${pages}`,
    reason: `Done after ${outcome.steps} step${outcome.steps === 1 ? "" : "s"}.`,
  };
}

export class BrowseRunner implements BrowseRunnerPort {
  private job: Job | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: BrowseRunnerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  owns(taskId: string): boolean {
    return this.job?.taskId === taskId;
  }

  /** The task being worked on and what it did lately, for a screen that shows it. */
  current(): { taskId: string; goal: string; steps: string[]; startedAt: number; question: GateQuestion | null } | null {
    const job = this.job;
    if (!job) return null;
    const question = this.deps.gate.pending();
    return { taskId: job.taskId, goal: job.goal, steps: job.steps.slice(-8), startedAt: job.startedAt, question: question && question.taskId === job.taskId ? question : null };
  }

  /** Tells a screen that what `current()` says changed: a task began, took a step, asked, or ended. */
  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a screen that fails must not stop the task
      }
    }
  }

  /** The saved rules about which sites the assistant may open. */
  sites(): Array<{ origin: string; decision: "allow" | "block"; at: number }> {
    return this.deps.gate.rules.list();
  }

  removeSite(origin: string): boolean {
    return this.deps.gate.rules.remove(origin);
  }

  /** Whether a browser and a model are there to work with, and if not, why: said before a task is made, not after it fails. */
  async available(): Promise<{ ok: boolean; reason?: string }> {
    const chosen = this.deps.brain();
    if (chosen.problem) return { ok: false, reason: chosen.problem };
    const status = await this.deps.service().status();
    return status.available ? { ok: true } : { ok: false, reason: status.reason ?? "No browser was found on this computer." };
  }

  run(task: Task, report: BrowseReport): void {
    if (this.job) {
      report.settle({ ok: false, result: "", reason: "The assistant is already browsing." });
      return;
    }
    const job: Job = { taskId: task.id, abort: new AbortController(), report, goal: task.goal, steps: [], asking: false, startedAt: this.now(), pausedAt: null, pausedTotal: 0, surface: null };
    this.job = job;
    this.changed();
    void this.execute(job, task).catch((error: unknown) => this.deps.log(`browse: ${error instanceof Error ? error.message : String(error)}`));
  }

  cancel(taskId: string, _reason: string): void {
    if (this.job?.taskId === taskId) this.job.abort.abort();
  }

  /** What the person is being asked about this task now, as a screen shows it (no ids), or null. */
  question(taskId: string): QuestionView | null {
    const question = this.deps.gate.pending();
    return question && question.taskId === taskId ? questionView(question) : null;
  }

  /** The person's answer to the site question shown for this task. */
  answer(taskId: string, answer: string): void {
    if (!(SITE_ANSWERS as readonly string[]).includes(answer)) throw new ValidationError("answer", "answer must be task, always, not-now or block");
    const question = this.deps.gate.pending();
    if (!question || question.taskId !== taskId) throw new ConflictError("No site is waiting for an answer on this task.");
    if (question.type !== "site") throw new ConflictError("An action is waiting for your answer, not a site.");
    this.deps.gate.answer(question.id, answer as SiteAnswer);
  }

  /** The person's answer to the action shown for this task: "do" or "dont". */
  answerAction(taskId: string, answer: string): void {
    if (!(ACTION_ANSWERS as readonly string[]).includes(answer)) throw new ValidationError("answer", "answer must be do or dont");
    const question = this.deps.gate.pending();
    if (!question || question.taskId !== taskId) throw new ConflictError("No action is waiting for an answer on this task.");
    if (question.type !== "action") throw new ConflictError("A site is waiting for your answer, not an action.");
    this.deps.gate.answer(question.id, answer as ActionAnswer);
  }

  /** The id of the task being worked on, or null. */
  taskId(): string | null {
    return this.job?.taskId ?? null;
  }

  /** The server is closing: the task being worked on is stopped. */
  stop(): void {
    this.job?.abort.abort();
  }

  /** The gate's questions changed: the task shows as waiting for the person while one is open, and its clock stops. */
  gateChanged(): void {
    const job = this.job;
    if (!job) return;
    const waiting = this.deps.gate.waiting(job.taskId);
    if (waiting) {
      if (!job.asking) {
        job.asking = true;
        job.pausedAt = this.now();
      }
      job.report.asking(questionReason(this.deps.gate.pending()));
    } else if (job.asking) {
      job.asking = false;
      if (job.pausedAt !== null) job.pausedTotal += this.now() - job.pausedAt;
      job.pausedAt = null;
      job.report.resumed(job.steps[job.steps.length - 1] ?? "Browsing.");
    }
    this.changed();
  }

  private elapsed(job: Job): number {
    return (job.pausedAt ?? this.now()) - job.startedAt - job.pausedTotal;
  }

  private async execute(job: Job, task: Task): Promise<void> {
    let outcome: BrowseOutcome;
    try {
      const chosen = this.deps.brain();
      if (chosen.problem) throw new Error(chosen.problem);
      const service = this.deps.service();
      const status = await service.status();
      if (!status.available) throw new Error(status.reason ?? "No browser was found on this computer.");
      const gate: SurfaceGate = {
        request: (url) => this.deps.gate.request(task.id, url, AbortSignal.any([job.abort.signal, AbortSignal.timeout(QUESTION_MS)])),
        confirm: async (ask) => {
          const allowed = await this.deps.gate.ask(task.id, ask, AbortSignal.any([job.abort.signal, AbortSignal.timeout(QUESTION_MS)]));
          // The click they allowed may send the form it is in: that form needs no second question.
          if (allowed) this.deps.gate.approved(task.id);
          return allowed;
        },
        endApproval: () => this.deps.gate.endApproval(),
        settled: async () => {
          await this.deps.gate.settled(task.id, AbortSignal.any([job.abort.signal, AbortSignal.timeout(QUESTION_MS)]));
          // Still waiting after all this time: nobody is going to answer, so it counts as "not now".
          if (this.deps.gate.waiting(task.id)) this.deps.gate.expire(task.id);
        },
      };
      const surface = this.deps.surface ? this.deps.surface(service, gate) : new ServiceSurface(service, gate);
      job.surface = surface;
      outcome = await new BrowseAgent(chosen.brain, surface).run(task.goal, null, {
        signal: job.abort.signal,
        elapsedMs: () => this.elapsed(job),
        onStep: (line) => {
          job.steps.push(line);
          if (!job.asking) job.report.progress(line);
          this.changed();
        },
        log: this.deps.log,
      });
    } catch (error) {
      outcome = { ok: false, answer: "", reason: error instanceof Error ? error.message : String(error), steps: job.steps.length, pages: [], tokens: 0 };
    } finally {
      this.deps.gate.end(task.id);
      await job.surface?.close().catch(() => undefined);
      if (this.job === job) this.job = null;
      this.changed();
    }
    const tokens = outcome.tokens > 0 ? `, ${outcome.tokens} tokens` : "";
    this.deps.log(`browse: task ${task.id} ${outcome.ok ? "answered" : `stopped (${outcome.reason})`} after ${outcome.steps} steps${tokens}`);
    job.report.settle(describeOutcome(outcome));
  }
}
