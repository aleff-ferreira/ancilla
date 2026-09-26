import type { ResearchConfig, ResearchPhase, ResearchRunView, ResearchWorkerState, ResearchWorkerView } from "../types.js";

/**
 * What the UI says about a DeepResearch run. The view is the server's summary; these are the words for it, kept
 * out of the components so the row, the composer and the controller agree on them.
 */

/**
 * A UUIDv7 for a research command: the time in the first 48 bits, then random bits. Made here rather than with
 * `crypto.randomUUID`, which a browser only offers on a secure origin, and the web app is often served over plain
 * HTTP on a home network; `getRandomValues` works everywhere, with `Math.random` behind it for a runtime without it.
 */
export function mintCommandId(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  const ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i -= 1) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A run that is still spending the thread's window: the composer refuses a second one beside it. */
export function researchLive(run: Pick<ResearchRunView, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

/** A run that ended with something to read. */
export function researchReported(run: Pick<ResearchRunView, "status">): boolean {
  return run.status === "completed" || run.status === "partial";
}

/** A run that has ended, one way or another: nothing said about it afterwards can move it back. */
export function researchEnded(run: Pick<ResearchRunView, "status">): boolean {
  return !researchLive(run);
}

/**
 * The daemon's ceilings on a run's numbers (`RESEARCH_LIMITS` in packages/daemon/src/research/config.ts), kept
 * in step by hand like the wire types. The server clamps to them too, so a field that let a value past them would
 * only have the server quietly change what was typed.
 */
export const RESEARCH_LIMITS = {
  windowMinutes: { min: 0.5, max: 240 },
  rounds: { min: 1, max: 500 },
  parallel: { min: 1, max: 12 },
  workerToolCalls: { min: 1, max: 100 },
  workerSearches: { min: 1, max: 100 },
  workerReads: { min: 1, max: 500 },
  workerSaves: { min: 1, max: 200 },
  workerWallTimeMinutes: { min: 1, max: 60 },
} as const;

export interface ResearchRange {
  readonly min: number;
  readonly max: number;
}

/** The window is set in minutes to the half; everything else is a count. */
export const WINDOW_STEP = 0.5;

/**
 * A typed number brought inside a range and onto `step`'s grid: what a field settles on when it is left, so a
 * value past a ceiling lands on the ceiling instead of going back to what the field held. Nothing typed, or
 * nothing numeric, gives null rather than a guess.
 */
export function clampResearchNumber(typed: string | number | null | undefined, range: ResearchRange, step = 1): number | null {
  if (typed === null || typed === undefined || (typeof typed === "string" && typed.trim() === "")) {
    return null;
  }
  const n = Number(typed);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.min(range.max, Math.max(range.min, Math.round(n / step) * step));
}

/** The two ways to stop a run: write a report from what the workers have, or drop it. */
export type ResearchStopAction = "write" | "now";

export const STOP_ACTIONS: Record<ResearchStopAction, { label: string; title: string }> = {
  write: { label: "Stop and write from what it has", title: "Stops the workers and writes a report from what they have found" },
  now: { label: "Stop now, no report", title: "Stops the workers and drops what they have found" },
};

/** The menu's order: the outcome that keeps the work first. */
export const STOP_ACTION_ORDER: readonly ResearchStopAction[] = ["write", "now"];

/** What a plain click on Stop does: the switch in the composer popover decides. */
export function preferredStopAction(stopWrites: boolean): ResearchStopAction {
  return stopWrites ? "write" : "now";
}

/** The row's line from the moment a stop is asked for until the run says how it ended. */
export const STOPPING_LINE: Record<ResearchStopAction, string> = {
  write: "Stopping, writing the report…",
  now: "Stopping…",
};

/**
 * The stops still waiting for their outcome, less those whose run has ended: the row shows the outcome instead.
 * Returns the same record when nothing changes, so the store sees no update.
 */
export function settleStopping(
  stopping: Record<string, ResearchStopAction>,
  runs: readonly Pick<ResearchRunView, "runId" | "status">[],
): Record<string, ResearchStopAction> {
  let next = stopping;
  for (const run of runs) {
    if (researchEnded(run) && next[run.runId]) {
      if (next === stopping) {
        next = { ...stopping };
      }
      delete next[run.runId];
    }
  }
  return next;
}

const PHASE_RANK: Record<ResearchPhase, number> = { scoping: 0, drafting: 1, researching: 2, writing: 3, done: 4 };

/** What only grows while a run goes, most telling first; the later of two snapshots is ahead on the first that differs. */
const PROGRESS: readonly ((run: ResearchRunView) => number)[] = [
  (run) => (run.status === "queued" ? 0 : 1),
  (run) => PHASE_RANK[run.phase],
  (run) => run.round,
  (run) => run.workers.length,
  (run) => run.workers.reduce((calls, worker) => calls + worker.toolCalls, 0),
];

/**
 * Whether `next` is at least as recent a picture of a live run as `current`. The answer to a stop or a read can
 * cross the stream's events, and none of them is numbered, so recency is read off what only grows while a run
 * goes. A tie goes to `next`, the one that arrived last.
 */
export function researchSnapshotCurrent(current: ResearchRunView, next: ResearchRunView): boolean {
  for (const measure of PROGRESS) {
    const before = measure(current);
    const after = measure(next);
    if (before !== after) {
      return after > before;
    }
  }
  return true;
}

/** The popover's fields as typed: null until the user touches one, so an untouched field sends nothing. */
export interface ResearchTyped {
  windowMin: string | null;
  windowMax: string | null;
  parallel: string | null;
}

export const NOTHING_TYPED: ResearchTyped = { windowMin: null, windowMax: null, parallel: null };

/**
 * The overrides a run is posted with: the fields the user touched in the popover, clamped, and none that only
 * repeat the loaded defaults. Untouched fields are the server's to fill from its settings, which is also why the
 * popover sends nothing for the fields it could not show before the settings had loaded. A maximum typed below
 * the minimum in force lowers the minimum with it, since the server would otherwise lift the maximum back up.
 */
export function popoverOverrides(typed: ResearchTyped, defaults: ResearchConfig | null): Partial<ResearchConfig> | null {
  const config: Partial<ResearchConfig> = {};
  const min = clampResearchNumber(typed.windowMin, RESEARCH_LIMITS.windowMinutes, WINDOW_STEP);
  const max = clampResearchNumber(typed.windowMax, RESEARCH_LIMITS.windowMinutes, WINDOW_STEP);
  const parallel = clampResearchNumber(typed.parallel, RESEARCH_LIMITS.parallel);
  if (min !== null && min !== defaults?.windowMinMinutes) {
    config.windowMinMinutes = min;
  }
  if (max !== null && max !== defaults?.windowMaxMinutes) {
    config.windowMaxMinutes = max;
  }
  const floor = min ?? defaults?.windowMinMinutes ?? null;
  if (max !== null && min === null && floor !== null && max < floor) {
    config.windowMinMinutes = max;
  }
  if (parallel !== null && parallel !== defaults?.maxParallel) {
    config.maxParallel = parallel;
  }
  return Object.keys(config).length > 0 ? config : null;
}

/** The run whose report the thread shows on sight: the newest that ended with one. Older reports are read on request. */
export function newestReportedRun(runs: readonly ResearchRunView[]): string | null {
  let newest: ResearchRunView | null = null;
  for (const run of runs) {
    if (researchReported(run) && (newest === null || (Date.parse(run.createdAt) || 0) >= (Date.parse(newest.createdAt) || 0))) {
      newest = run;
    }
  }
  return newest?.runId ?? null;
}

export type ReportView = "report" | "reading" | "read" | "none";

/**
 * What the row shows where the report goes: the report; a spinner while a read is out, which the newest finished
 * run starts on sight; a Read button for an older run, or after a read failed, so a failure never leaves a spinner
 * behind; or a line saying the run left nothing.
 */
export function reportView(run: Pick<ResearchRunView, "report" | "reportAvailable">, state: { latest: boolean; reading: boolean; failed: boolean }): ReportView {
  if (run.report) {
    return "report";
  }
  if (!run.reportAvailable) {
    return "none";
  }
  if (state.reading || (state.latest && !state.failed)) {
    return "reading";
  }
  return "read";
}

/** Zeroes for the optimistic row before the server has answered with its defaults. */
export const EMPTY_RESEARCH_CONFIG: ResearchConfig = {
  windowMinMinutes: 0,
  windowMaxMinutes: 0,
  maxRounds: 0,
  maxParallel: 0,
  workerMaxToolCalls: 0,
  workerMaxSearches: 0,
  workerMaxReads: 0,
  workerMaxSaves: 0,
  workerWallTimeMinutes: 0,
  draftFirst: false,
  salvageFraction: 0,
  tokenSoftCap: null,
  trace: false,
  models: { supervisor: null, worker: null, writer: null },
};

/** The one line under the question while the run goes: the phase, with the round while workers are out. */
export function phaseLine(run: Pick<ResearchRunView, "status" | "phase" | "round" | "maxRounds">): string {
  if (run.status === "queued") {
    return "Waiting for a slot";
  }
  switch (run.phase) {
    case "scoping":
      return "Scoping the question";
    case "drafting":
      return "Drafting";
    case "researching":
      return run.maxRounds > 0 ? `Researching, round ${Math.max(1, run.round)} of ${run.maxRounds}` : `Researching, round ${Math.max(1, run.round)}`;
    case "writing":
      return "Writing the report";
    case "done":
      return "Finishing";
  }
}

/** The word for a run that has ended, in the row's heading. */
export const STATUS_WORD: Record<ResearchRunView["status"], string> = {
  queued: "Queued",
  running: "Researching",
  completed: "Report",
  partial: "Partial report",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

export const WORKER_STATE_WORD: Record<ResearchWorkerState, string> = {
  queued: "Queued",
  working: "Working",
  completed: "Done",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Stopped",
};

/** `A1 · pricing models · 3 searches · 2 reads`: a worker's chip, counts only once it has made a call. */
export function workerChip(worker: ResearchWorkerView): string {
  const parts = [`A${worker.agentId}`, worker.topic];
  if (worker.searches > 0) parts.push(`${worker.searches} ${worker.searches === 1 ? "search" : "searches"}`);
  if (worker.reads > 0) parts.push(`${worker.reads} ${worker.reads === 1 ? "read" : "reads"}`);
  if (worker.saved > 0) parts.push(`${worker.saved} saved`);
  return parts.join(" · ");
}

/** `12 sources · 9 verified · 4 curated`, or nothing before the first source. */
export function sourcesLine(sources: ResearchRunView["sources"]): string | null {
  if (sources.registry === 0) return null;
  const parts = [`${sources.registry} ${sources.registry === 1 ? "source" : "sources"}`, `${sources.verified} verified`];
  if (sources.curated > 0) parts.push(`${sources.curated} curated`);
  return parts.join(" · ");
}

/**
 * How the run spent its window: elapsed since it started, and what is left before the deadline routes it to
 * writing. A queued run has neither; a finished one has its elapsed and nothing left.
 */
export function researchClock(
  run: Pick<ResearchRunView, "status" | "startedAt" | "endedAt" | "researchDeadlineAt">,
  now: number,
): { elapsedMs: number | null; remainingMs: number | null } {
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  if (!Number.isFinite(started)) {
    return { elapsedMs: null, remainingMs: null };
  }
  const ended = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
  const until = Number.isFinite(ended) ? ended : now;
  const elapsedMs = Math.max(0, until - started);
  const deadline = run.researchDeadlineAt ? Date.parse(run.researchDeadlineAt) : Number.NaN;
  const remainingMs = researchLive(run) && Number.isFinite(deadline) ? Math.max(0, deadline - now) : null;
  return { elapsedMs, remainingMs };
}
