import type { ResearchConfig, ResearchRunView, ResearchWorkerState, ResearchWorkerView } from "../types.js";

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
