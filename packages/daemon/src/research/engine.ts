import type { ResearchConfig } from "./config.js";
import type { ResearchDeps, ResearchInput, ResearchOutcome, ResearchRunState } from "./types.js";

/**
 * Runs one research job from question to cited report. Resolves with an outcome in every case but a thrown
 * programming error: cancellation, budget exhaustion and model trouble all come back as a status.
 * `resumeFrom` continues a checkpointed run at the start of its next supervisor round.
 */
export async function runResearch(
  input: ResearchInput,
  config: ResearchConfig,
  deps: ResearchDeps,
  signal: AbortSignal,
  resumeFrom?: ResearchRunState,
): Promise<ResearchOutcome> {
  void input;
  void config;
  void deps;
  void signal;
  void resumeFrom;
  throw new Error("runResearch: not implemented yet.");
}
