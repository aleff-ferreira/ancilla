/**
 * Where the time goes in a call. A turn is a chain of stages (the pause that decided the person was done, the
 * recogniser's last words, the model's first word, the voice's first sound) and the person feels their sum, so each stage
 * is timed on its own and the sum is kept, for the screen and for the tests that hold the numbers to a budget.
 */

import type { TurnMetrics } from "./protocol.js";

export class TurnTrace {
  /** The moment the person stopped making sound (not when the pause was recognised as the end). */
  speechEnd: number | null = null;
  turnEnd: number | null = null;
  asrFinal: number | null = null;
  firstToken: number | null = null;
  firstAudio: number | null = null;
  bargeIn = false;

  constructor(readonly turn: number) {}

  private since(at: number | null): number | null {
    return at === null || this.speechEnd === null ? null : Math.max(0, Math.round(at - this.speechEnd));
  }

  snapshot(): TurnMetrics {
    return {
      turn: this.turn,
      endpointMs: this.since(this.turnEnd),
      asrMs: this.since(this.asrFinal),
      firstTokenMs: this.since(this.firstToken),
      firstAudioMs: this.since(this.firstAudio),
      totalMs: this.since(this.firstAudio),
      bargeIn: this.bargeIn,
    };
  }
}

/** Percentiles of a list of numbers, nearest-rank. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface Summary {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function summarize(values: readonly number[]): Summary {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: values.length ? Math.max(...values) : null };
}
