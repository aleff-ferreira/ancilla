/**
 * Research budgets. Defaults and ceilings follow Deep Dog 2's `run_config.py` where the two engines share a knob;
 * the caps that Deep Dog 2 leaves to prompt text (parallelism, tool calls) are enforced here.
 */

export interface ResearchModelIds {
  supervisor: string | null;
  worker: string | null;
  writer: string | null;
}

export interface ResearchConfig {
  /** No research-complete verdict is accepted before this many minutes unless nothing is left to delegate. */
  windowMinMinutes: number;
  /** Research routes to writing once this many minutes plus one have elapsed. */
  windowMaxMinutes: number;
  maxRounds: number;
  /** Workers running at once within one run. */
  maxParallel: number;
  workerMaxToolCalls: number;
  workerMaxSearches: number;
  workerMaxReads: number;
  workerMaxSaves: number;
  workerWallTimeMinutes: number;
  /** Draft-first: an initial scaffold the supervisor refines. Off in the MVP. */
  draftFirst: boolean;
  /** Fraction of the window after which an aborted loop still writes from what it has. */
  salvageFraction: number;
  /** Ends research early once the run's summed tokens pass it; null for no cap. */
  tokenSoftCap: number | null;
  /** Content-rich trace events on top of the content-free ones. */
  trace: boolean;
  models: ResearchModelIds;
}

export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
  windowMinMinutes: 3,
  windowMaxMinutes: 10,
  maxRounds: 12,
  maxParallel: 3,
  workerMaxToolCalls: 25,
  workerMaxSearches: 3,
  workerMaxReads: 10,
  workerMaxSaves: 10,
  workerWallTimeMinutes: 10,
  draftFirst: false,
  salvageFraction: 0.6,
  tokenSoftCap: null,
  trace: false,
  models: { supervisor: null, worker: null, writer: null },
};

/** Hard ceilings, from upstream's `run_config.py` caps. */
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

function clampNumber(value: unknown, fallback: number, range: { min: number; max: number }): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

/** A complete config from a partial one: missing fields take the base, and every number is clamped. */
export function resolveResearchConfig(input: Partial<ResearchConfig> | null | undefined, base: ResearchConfig = DEFAULT_RESEARCH_CONFIG): ResearchConfig {
  const p = input ?? {};
  const windowMin = clampNumber(p.windowMinMinutes, base.windowMinMinutes, RESEARCH_LIMITS.windowMinutes);
  const windowMax = Math.max(windowMin, clampNumber(p.windowMaxMinutes, base.windowMaxMinutes, RESEARCH_LIMITS.windowMinutes));
  const models = { ...base.models, ...(p.models ?? {}) };
  return {
    windowMinMinutes: windowMin,
    windowMaxMinutes: windowMax,
    maxRounds: Math.round(clampNumber(p.maxRounds, base.maxRounds, RESEARCH_LIMITS.rounds)),
    maxParallel: Math.round(clampNumber(p.maxParallel, base.maxParallel, RESEARCH_LIMITS.parallel)),
    workerMaxToolCalls: Math.round(clampNumber(p.workerMaxToolCalls, base.workerMaxToolCalls, RESEARCH_LIMITS.workerToolCalls)),
    workerMaxSearches: Math.round(clampNumber(p.workerMaxSearches, base.workerMaxSearches, RESEARCH_LIMITS.workerSearches)),
    workerMaxReads: Math.round(clampNumber(p.workerMaxReads, base.workerMaxReads, RESEARCH_LIMITS.workerReads)),
    workerMaxSaves: Math.round(clampNumber(p.workerMaxSaves, base.workerMaxSaves, RESEARCH_LIMITS.workerSaves)),
    workerWallTimeMinutes: clampNumber(p.workerWallTimeMinutes, base.workerWallTimeMinutes, RESEARCH_LIMITS.workerWallTimeMinutes),
    draftFirst: typeof p.draftFirst === "boolean" ? p.draftFirst : base.draftFirst,
    salvageFraction: clampNumber(p.salvageFraction, base.salvageFraction, { min: 0, max: 1 }),
    tokenSoftCap: p.tokenSoftCap === null ? null : typeof p.tokenSoftCap === "number" && p.tokenSoftCap > 0 ? Math.round(p.tokenSoftCap) : base.tokenSoftCap,
    trace: typeof p.trace === "boolean" ? p.trace : base.trace,
    models: {
      supervisor: typeof models.supervisor === "string" && models.supervisor ? models.supervisor : null,
      worker: typeof models.worker === "string" && models.worker ? models.worker : null,
      writer: typeof models.writer === "string" && models.writer ? models.writer : null,
    },
  };
}

/** What the server keeps under the `research` settings key. */
export interface ResearchSettings {
  enabled: boolean;
  config: ResearchConfig;
}

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = { enabled: true, config: DEFAULT_RESEARCH_CONFIG };
