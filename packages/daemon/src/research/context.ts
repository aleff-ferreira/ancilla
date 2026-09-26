/**
 * The run context: everything the phases share. It owns the event `seq`, the clock, cancellation checks and the
 * one place model calls go through, so usage is summed and dependency errors are normalised in one spot.
 */

import type { ResearchConfig } from "./config.js";
import {
  ResearchFailure,
  addUsage,
  type ModelRole,
  type ResearchDeps,
  type ResearchEvent,
  type ResearchEventType,
  type ResearchInput,
  type ResearchRunState,
} from "./types.js";

/** Model call timeouts, from the plan's budget table (section 4.6). */
export const MODEL_TIMEOUTS_MS = {
  brief: 2 * 60_000,
  draft: 5 * 60_000,
  supervisor: 4 * 60_000,
  writer: 10 * 60_000,
} as const;

/** Output allowances per role; the writer gets the most because reports run long. */
export const MODEL_MAX_OUTPUT_TOKENS = {
  brief: 2_048,
  draft: 8_192,
  supervisor: 6_144,
  writer: 16_384,
} as const;

/** Thrown inside the engine when the run's signal is found aborted; never leaves `runResearch`. */
export class RunCancelled extends Error {
  constructor(message = "research cancelled") {
    super(message);
    this.name = "RunCancelled";
  }
}

export interface EmitOptions {
  round?: number | null;
  agentId?: number | null;
}

export class RunContext {
  readonly state: ResearchRunState;
  readonly config: ResearchConfig;
  readonly deps: ResearchDeps;
  readonly input: ResearchInput;
  /** The run's own signal; a salvage write after cancellation uses `writeSignal` instead. */
  readonly signal: AbortSignal;
  /** The signal model calls receive; swapped for a fresh one when a salvage report is written after an abort. */
  writeSignal: AbortSignal;

  constructor(state: ResearchRunState, deps: ResearchDeps, input: ResearchInput, signal: AbortSignal) {
    this.state = state;
    this.config = state.config;
    this.deps = deps;
    this.input = input;
    this.signal = signal;
    this.writeSignal = signal;
  }

  now(): number {
    return this.deps.now();
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  elapsedMinutes(): number {
    return (this.now() - Date.parse(this.state.startedAt)) / 60_000;
  }

  log(message: string): void {
    this.deps.log?.(`research ${this.state.runId}: ${message}`);
  }

  emit(type: ResearchEventType, payload: Record<string, unknown> = {}, options: EmitOptions = {}): void {
    this.state.eventSeq += 1;
    const event: ResearchEvent = {
      type,
      runId: this.state.runId,
      seq: this.state.eventSeq,
      at: this.nowIso(),
      phase: this.state.phase,
      round: options.round ?? null,
      agentId: options.agentId ?? null,
      payload,
    };
    this.deps.events.emit(event);
  }

  async checkpoint(): Promise<void> {
    await this.deps.checkpoint(this.state);
  }

  /** Throws `RunCancelled` when the signal that governs the current work has fired. */
  checkCancelled(signal: AbortSignal = this.writeSignal): void {
    if (signal.aborted) throw new RunCancelled();
  }

  /**
   * One tool-less completion. Usage is added to the run, a dependency's `cancelled` failure and an aborted signal
   * both surface as `RunCancelled`, and any other error becomes a `ResearchFailure` the caller can classify.
   */
  async complete(role: ModelRole, prompt: string, signal: AbortSignal = this.writeSignal): Promise<string> {
    this.checkCancelled(signal);
    try {
      const response = await this.deps.model.complete({
        role,
        prompt,
        maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS[role],
        timeoutMs: MODEL_TIMEOUTS_MS[role],
        signal,
      });
      this.state.usage = addUsage(this.state.usage, response.usage);
      return typeof response.text === "string" ? response.text : "";
    } catch (error) {
      if (signal.aborted) throw new RunCancelled();
      if (error instanceof ResearchFailure) {
        if (error.kind === "cancelled") throw new RunCancelled(error.message);
        throw error;
      }
      throw new ResearchFailure("other", error instanceof Error ? error.message : String(error));
    }
  }
}

/** Whether any worker delivered findings of task value (upstream `_has_research_findings`). */
export function hasFindings(state: ResearchRunState): boolean {
  if (state.registry.length > 0 || state.curated.length > 0) return true;
  return state.rounds.some((round) =>
    round.results.some((result) => result.status === "completed" && (result.findingsChars > 0 || result.savedCount > 0)),
  );
}

/** Upstream `_should_salvage`: enough of the window is spent and something was found, so writing beats aborting. */
export function shouldSalvage(ctx: RunContext): boolean {
  const fraction = ctx.config.windowMaxMinutes > 0 ? ctx.elapsedMinutes() / ctx.config.windowMaxMinutes : 0;
  return hasFindings(ctx.state) && fraction >= ctx.config.salvageFraction;
}
