/**
 * Streaming markdown rendering strategy configuration for Ancilla.
 *
 * Managing interactive markdown layout recalculation overhead:
 * Rapid token deltas during active generation degrade rendering performance if full AST
 * parsing is run on large documents. Ancilla dynamically selects appropriate render modes
 * based on document length and generation status.
 */

/** Maximum document character length eligible for smooth per-word entry animations. */
export const STREAM_WORD_LIMIT = 10_000;

/** Length threshold above which rendering switches from plain layout to periodic sampled snapshots. */
export const STREAM_SAMPLE_LIMIT = 30_000;

/** Sampling cadence in milliseconds applied to high-volume streaming outputs. */
export const STREAM_SAMPLE_MS = 500;

export type StreamRenderMode = "static" | "words" | "plain" | "sampled";

interface RenderThreshold {
  readonly maxChars: number;
  readonly mode: StreamRenderMode;
}

const STREAM_THRESHOLDS: readonly RenderThreshold[] = [
  { maxChars: STREAM_WORD_LIMIT, mode: "words" },
  { maxChars: STREAM_SAMPLE_LIMIT, mode: "plain" },
];

/**
 * Resolves the optimal Markdown render mode based on text length and whether generation is active.
 * Inactive streams always resolve to static mode.
 */
export function streamRenderMode(textLength: number, streaming: boolean): StreamRenderMode {
  if (!streaming) {
    return "static";
  }

  for (const threshold of STREAM_THRESHOLDS) {
    if (textLength <= threshold.maxChars) {
      return threshold.mode;
    }
  }

  return "sampled";
}
