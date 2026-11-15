/** What the main thread and the recogniser's worker thread say to each other. */

export interface AsrInit {
  runtimeDir: string | null;
  /** The streaming model: partial words as the person speaks. */
  streamingDir: string;
  /** The offline model that re-reads a finished turn for a more accurate transcript, or null to use the streaming one's. */
  finalDir: string | null;
  threads: number;
  finalThreads: number;
}

export type ToWorker =
  | { op: "init"; req: number; init: AsrInit }
  | { op: "warm"; req: number }
  | { op: "open"; req: number; id: number; lang: string | null; vocabulary?: readonly string[] }
  /** Samples at 16 kHz; the buffer is handed over. */
  | { op: "audio"; id: number; samples: Float32Array }
  /** The person went quiet: the last words are flushed out and, with an offline model, what was said is read ahead of time. */
  | { op: "flush"; id: number }
  | { op: "finish"; req: number; id: number; sentAt: number }
  | { op: "dispose"; id: number };

export interface FinalResult {
  text: string;
  /** What the streaming model had, for comparison. */
  streamingText?: string;
  /** The offline model's reading was used. */
  refined: boolean;
  /** How many stretches of the turn the offline model read, and how many of those were already read when the turn ended. */
  segments: number;
  readAhead: number;
  /** Time spent reading after the turn ended, and time the request waited for the worker to be free. */
  refineMs: number;
  queueMs: number;
  tokens?: string[];
  tokenLogProbs?: number[];
  snapshotHit?: boolean;
}

export type FromWorker =
  | { op: "reply"; req: number; ok: true; value?: FinalResult | { loadMs: number } | null }
  | { op: "reply"; req: number; ok: false; error: string }
  | { op: "partial"; id: number; text: string }
  | { op: "log"; line: string };
