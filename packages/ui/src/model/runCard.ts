import { runLive, summaryLine, type AgentState, type AgentVM, type RunVM, type SummaryChip } from "./crew.js";
import type { TaskPlanView } from "./taskPlan.js";

/**
 * What the run card says, decided from the run and its plan and nothing else. Every line is a fact Muse sent or one
 * Ancilla derived from the order it arrived in: the card never grows a bar with the clock and never guesses a
 * percentage, so what it shows as progress is a step Muse marked done or an agent that landed.
 */

const LIVE: ReadonlySet<AgentState> = new Set(["scheduled", "working", "finishing", "no-update", "waiting-on-you"]);

export type ActionTone = "work" | "need" | "done" | "fail" | "idle";

/** One tool call as the card names it: `Editing` and the path, `Ran` and the command. */
export interface ActionLook {
  id: string;
  state: AgentState;
  tone: ActionTone;
  verb: string;
  subject: string | null;
  mono: boolean;
  live: boolean;
  /** The call's own duration once it ended; null while it runs and when Muse sent none. */
  ms: number | null;
  /** The model's own words for what the call does, when it gave some. */
  note: string | null;
}

function toneOf(state: AgentState): ActionTone {
  switch (state) {
    case "working": case "finishing": case "no-update": case "scheduled": return "work";
    case "waiting-on-you": return "need";
    case "done": return "done";
    case "failed": return "fail";
    default: return "idle";
  }
}

/** The first line of a command or path, cut so a pasted script never fills a row. */
export function oneLine(text: string | null | undefined, limit = 140): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  if (!line) return null;
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** The foreground tool calls of a prompt's run, in the order the transcript has them; a workflow or research run has none. */
export function actionsOf(run: RunVM): AgentVM[] {
  return run.kind === "turn" ? run.agents.filter((agent) => agent.kind === "task") : [];
}

export function actionLook(agent: AgentVM): ActionLook {
  const info = agent.taskInfo;
  const look = info?.look;
  const live = LIVE.has(agent.state);
  const unreported = agent.state === "unknown";
  return {
    id: agent.id,
    state: agent.state,
    tone: toneOf(agent.state),
    verb: unreported ? "Started" : look?.verb ?? (live ? "Running" : "Ran"),
    subject: oneLine(look?.subject ?? info?.command ?? agent.name),
    mono: look?.mono ?? true,
    live,
    ms: live ? null : agent.durationMs,
    note: oneLine(look?.note ?? null, 200),
  };
}

/** One call by id, as the card names it; null once the run no longer has it. */
export function actionById(run: RunVM, id: string): ActionLook | null {
  const agent = actionsOf(run).find((candidate) => candidate.id === id);
  return agent ? actionLook(agent) : null;
}

/** The calls still going, in the order they started. */
export function liveActions(run: RunVM): ActionLook[] {
  return actionsOf(run).filter((agent) => LIVE.has(agent.state)).map(actionLook);
}

/** The last `limit` calls, the running ones last. */
export function recentActions(run: RunVM, limit: number): ActionLook[] {
  return actionsOf(run).slice(-limit).map(actionLook);
}

/** The newest call that has ended, when none is running: what just happened while the model thinks. */
export function lastEnded(run: RunVM): ActionLook | null {
  const ended = actionsOf(run).filter((agent) => !LIVE.has(agent.state));
  const last = ended[ended.length - 1];
  return last ? actionLook(last) : null;
}

export interface Tick {
  id: string;
  tone: ActionTone;
}

/** One tick per call, newest last: the card's heartbeat. */
export function trailOf(run: RunVM, limit = 18): Tick[] {
  return actionsOf(run).slice(-limit).map((agent) => ({ id: agent.id, tone: toneOf(agent.state) }));
}

/** How many calls have ended, so the heartbeat can answer each one. */
export function endedCount(run: RunVM): number {
  return actionsOf(run).filter((agent) => !LIVE.has(agent.state)).length;
}

/** `0.4s`, `3.2s`, `41s`, `1m 05s`: a call's time, with the tenths a quick call needs. */
export function callTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The call as one phrase, for a tooltip and a reader: `Editing src/scene.ts`. */
export function actionText(action: Pick<ActionLook, "verb" | "subject">): string {
  return action.subject ? `${action.verb} ${action.subject}` : action.verb;
}

// ---------------------------------------------------------------- the plan

/** Whether the plan Muse reported belongs to this run, so the card can take it in as its spine. */
export function planMerges(run: Pick<RunVM, "kind" | "runId"> | null, plan: Pick<TaskPlanView, "turnId"> | null): boolean {
  return run !== null && plan !== null && run.kind === "turn" && plan.turnId !== null && plan.turnId === run.runId;
}

export type SegTone = "done" | "live" | "hold" | "fail" | "skip" | "todo";

export interface Seg {
  key: string;
  tone: SegTone;
  /** What the segment is, for its tooltip. */
  label: string;
}

/** The plan's steps as spine segments: only an active step of a plan that is running moves; a step nobody confirmed holds still. */
export function stepSegs(plan: TaskPlanView): Seg[] {
  return plan.items.map((item, index) => {
    let tone: SegTone;
    switch (item.status) {
      case "completed": tone = "done"; break;
      case "inProgress": tone = plan.animate ? "live" : "hold"; break;
      case "failed": tone = "fail"; break;
      case "cancelled": tone = "skip"; break;
      default: tone = "todo";
    }
    return { key: `${index}:${item.text}`, tone, label: item.status === "inProgress" && plan.animate ? item.activeForm ?? item.text : item.text };
  });
}

/** The step the card names while it runs: the one Muse marked active, in its own present tense. */
export function activeStep(plan: TaskPlanView | null): string | null {
  if (!plan || plan.activeIndex < 0 || !plan.animate) return null;
  const step = plan.items[plan.activeIndex];
  return step ? step.activeForm ?? step.text : null;
}

// ---------------------------------------------------------------- the words

export type TitleSource = "step" | "action" | "need" | "run" | "end";

export interface Title {
  text: string;
  /** Where it came from: a change inside one source is a new sentence; a change of source is the card changing its mind. */
  source: TitleSource;
}

function leadOf(run: RunVM): AgentVM | null {
  return run.agents.find((agent) => agent.kind === "lead") ?? null;
}

/**
 * The card's first line. A prompt that follows a plan says the step; one that does not says the call it is making;
 * a workflow or research run says its own name; a request waiting on you outranks all of them.
 */
export function titleOf(run: RunVM, plan: TaskPlanView | null): Title {
  if (run.kind !== "turn") return { text: run.name, source: "run" };
  const lead = leadOf(run);
  if (runLive(run)) {
    if (lead?.needs) return { text: lead.needs.kind === "approval" ? "Waiting for your approval" : "Waiting for your answer", source: "need" };
    const step = activeStep(plan);
    if (step) return { text: step, source: "step" };
    const live = liveActions(run);
    const first = live[0];
    if (first) return { text: live.length === 1 ? actionText(first) : `${live.length} actions running`, source: "action" };
    return { text: lead?.task?.text ?? "Working on your prompt", source: "run" };
  }
  return { text: lead?.task?.text ?? "Turn ended", source: "end" };
}

/** The second line's action while the title is a step or the run's own words: the call going now, else the last that ended. */
export function subAction(run: RunVM): ActionLook | null {
  if (run.kind !== "turn") return null;
  return liveActions(run)[0] ?? lastEnded(run);
}

/** The second line when there is no call to name: a workflow's phase and counts, a prompt's count of calls. */
export function subText(run: RunVM, title: Title): string | null {
  if (run.kind !== "turn") return summaryLine(run).progress;
  const calls = actionsOf(run).length;
  if (title.source === "action") return calls > 1 ? `${calls} actions` : null;
  return null;
}

/**
 * The agents the card lists as needing attention. A tool call that failed while a prompt goes on is an ordinary event
 * (Muse reads the error and tries again), so it does not take the top of the card: it shows as a red tick and in the
 * latest calls, and the summary of a finished turn counts it. Waiting on you and gone quiet still do.
 */
export function attentionOf(run: RunVM): AgentVM[] {
  return run.kind === "turn" && runLive(run) ? run.attention.filter((agent) => agent.state !== "failed") : run.attention;
}

/**
 * The chips beside the first line: what needs you or has gone quiet. For a prompt, not the calls that failed or were
 * cancelled on the way: the finished card's second line counts them, and a red chip on a turn that went fine is a false alarm.
 */
export function chipsOf(run: RunVM): SummaryChip[] {
  const chips = summaryLine(run).chips;
  if (run.kind !== "turn" || run.stale) return chips;
  const kept = chips.filter((chip) => chip.kind !== "failed" && chip.kind !== "skipped");
  if (runLive(run) && !kept.some((chip) => chip.kind === "needs" || chip.kind === "no-update") && run.counts.noUpdate > 0) {
    kept.push({ kind: "no-update", count: run.counts.noUpdate, text: `${run.counts.noUpdate} no update` });
  }
  return kept;
}

export type Glyph = "working" | "waiting" | "stale" | "done" | "failed" | "stopped" | "partial";

/** The state glyph at the card's left: the ring while it runs, the outcome once it ended, the clock when the feed is not live. */
export function glyphOf(run: RunVM): Glyph {
  if (run.stale) return "stale";
  if (runLive(run)) {
    const waiting = run.runNeeds.length > 0 || run.counts.waiting > 0;
    return waiting ? "waiting" : "working";
  }
  if (run.status === "stopped") return "stopped";
  // A tool call that failed is an ordinary event in a prompt, which goes on and adapts; only the turn itself failing is a failure.
  if (run.status === "failed" || (run.kind !== "turn" && run.counts.failed > 0)) return "failed";
  if (run.counts.skipped + run.counts.unknown > 0) return "partial";
  return "done";
}
