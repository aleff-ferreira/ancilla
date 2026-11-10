import type { BrowseReport, ConnectorRunnerPort } from "../assistant/executive.js";
import type { Task } from "../assistant/tasks.js";
import type { BrainProvider } from "../voice/brain.js";
import { ConnectorAgent, type ConnectorOutcome } from "./agent.js";
import type { ConnectorRegistry } from "./registry.js";

/**
 * Runs the connector task the executive made: the reading agent, on one connected account, with the model the voice is set to
 * use. It owns nothing of the task's row; it reports what happens, and the executive writes it down. One task at a time, which
 * keeps what a Muse-backed task costs (about 16k tokens a step) from stacking up unseen. A cancel comes in through `cancel`.
 */

export interface ConnectorRunnerDeps {
  registry: ConnectorRegistry;
  /** The model that does the reading, or why there is none. */
  brain: () => { brain: BrainProvider; problem: string | null };
  log: (line: string) => void;
  now?: () => number;
}

interface Job {
  taskId: string;
  abort: AbortController;
  startedAt: number;
}

/** What is kept of a task that answered: the answer, labelled as what it is, and where it came from. */
export function describeOutcome(source: string, outcome: ConnectorOutcome): { ok: boolean; result: string; reason: string } {
  if (!outcome.ok) return { ok: false, result: "", reason: outcome.reason };
  const used = outcome.tools.length > 0 ? `\nTools used: ${outcome.tools.join(", ")}` : "";
  return {
    ok: true,
    result: `From ${source} (not checked):\n${outcome.answer}${used}`,
    reason: `Done after ${outcome.steps} step${outcome.steps === 1 ? "" : "s"}.`,
  };
}

export class ConnectorRunner implements ConnectorRunnerPort {
  private job: Job | null = null;

  constructor(private readonly deps: ConnectorRunnerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  owns(taskId: string): boolean {
    return this.job?.taskId === taskId;
  }

  /** Whether a connector and a model are there to work with, and if not, why: said before a task is made, not after it fails. */
  async available(connector: string): Promise<{ ok: boolean; reason?: string }> {
    const ready = this.deps.registry.ready(connector);
    if (!ready.ok) return ready;
    const chosen = this.deps.brain();
    return chosen.problem ? { ok: false, reason: chosen.problem } : { ok: true };
  }

  run(task: Task, connector: string, report: BrowseReport): void {
    if (this.job) {
      report.settle({ ok: false, result: "", reason: "The assistant is already using a connector.", });
      return;
    }
    const job: Job = { taskId: task.id, abort: new AbortController(), startedAt: this.now() };
    this.job = job;
    void this.execute(job, task, connector, report).catch((error: unknown) => this.deps.log(`connector: ${error instanceof Error ? error.message : String(error)}`));
  }

  cancel(taskId: string, _reason: string): void {
    if (this.job?.taskId === taskId) this.job.abort.abort();
  }

  /** The server is closing: the task being worked on is stopped. */
  stop(): void {
    this.job?.abort.abort();
  }

  private async execute(job: Job, task: Task, connector: string, report: BrowseReport): Promise<void> {
    let outcome: ConnectorOutcome;
    let source = connector;
    try {
      source = this.deps.registry.view(connector).name;
      const chosen = this.deps.brain();
      if (chosen.problem) throw new Error(chosen.problem);
      const session = await this.deps.registry.open(connector);
      try {
        outcome = await new ConnectorAgent(chosen.brain, session).run(task.goal, {
          signal: job.abort.signal,
          task: task.id,
          elapsedMs: () => this.now() - job.startedAt,
          onStep: (line) => report.progress(line),
          log: this.deps.log,
        });
      } finally {
        await session.close().catch(() => undefined);
      }
    } catch (error) {
      outcome = { ok: false, answer: "", reason: error instanceof Error ? error.message : String(error), steps: 0, tools: [], tokens: 0 };
    } finally {
      if (this.job === job) this.job = null;
    }
    const tokens = outcome.tokens > 0 ? `, ${outcome.tokens} tokens` : "";
    this.deps.log(`connector: task ${task.id} on ${connector} ${outcome.ok ? "answered" : `stopped (${outcome.reason})`} after ${outcome.steps} steps${tokens}`);
    report.settle(describeOutcome(source, outcome));
  }
}
