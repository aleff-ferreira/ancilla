/**
 * What a call needs of the machinery that listens and speaks, as interfaces: whatever recognises speech, whatever says a
 * sentence, whatever tells speech from silence. The real ones are native models (sherpa-onnx, an optional download); the
 * test doubles in `testing.ts` stand in for them so the conversation logic is tested without any model.
 *
 * Calls may be synchronous or return a promise: a model that runs in a worker thread answers later, a double answers at
 * once, and the session treats both alike.
 */

export type MaybePromise<T> = T | Promise<T>;

/** Tells speech from silence, a frame at a time. */
export interface VadEngine {
  readonly id: string;
  /** Samples (16 kHz) in each frame the engine takes. */
  readonly frameSamples: number;
  /** The chance, 0 to 1, that the frame is speech. */
  process(frame: Float32Array): MaybePromise<number>;
  reset(): void;
}

export interface AsrResult {
  text: string;
  /** The recogniser has no more to add to this stretch of audio. */
  endpoint?: boolean;
}

/** One stretch of speech, fed to a recogniser as it arrives. */
export interface AsrStream {
  /** Samples at 16 kHz, mono, as float32 in -1..1. */
  accept(samples: Float32Array): MaybePromise<void>;
  /** What has been heard so far; it may be revised by the next call. */
  partial(): MaybePromise<AsrResult>;
  /**
   * The person has gone quiet: gives the recogniser the trailing silence it needs to say the last words it was waiting
   * to be sure of, without ending the stream (the person may go on).
   */
  flush?(): MaybePromise<void>;
  /** The end of the audio: the final words. The stream is not used again. */
  finish(): MaybePromise<AsrResult>;
  dispose(): void;
}

export interface AsrEngine {
  readonly id: string;
  /** Names the language to hear (BCP 47 such as "pt-BR"), or null to let the model decide. */
  open(lang: string | null): MaybePromise<AsrStream>;
  /** Loads the model and runs it once, so that the first words of a call are not the slowest. */
  warm?(): Promise<void>;
}

export interface Voice {
  id: string;
  name: string;
  /** Primary language subtag: "en", "pt". */
  lang: string;
}

export interface TtsEngine {
  readonly id: string;
  /** Rate of the audio it makes. */
  readonly sampleRate: number;
  readonly voices: readonly Voice[];
  /**
   * Says one sentence. Audio comes out in pieces as soon as it exists; the iterator ends when the sentence is said, and
   * stops early when `signal` is aborted.
   */
  synthesize(text: string, options: { voice: string; speed: number; signal: AbortSignal }): AsyncIterable<Int16Array>;
  warm?(): Promise<void>;
}

export interface Engines {
  vad: VadEngine;
  asr: AsrEngine;
  tts: TtsEngine;
}

/** Converts microphone samples to the float form the engines take. */
export function toFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] as number) / 32768;
  return out;
}

export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

/** Picks the voice for a language: the first one that speaks it, else the first there is. */
export function pickVoice(voices: readonly Voice[], lang: string | null, preferred: string | null): Voice | null {
  if (voices.length === 0) return null;
  if (preferred) {
    const found = voices.find((v) => v.id === preferred && (lang === null || v.lang === lang));
    if (found) return found;
  }
  if (lang) {
    const found = voices.find((v) => v.lang === lang);
    if (found) return found;
  }
  return voices[0] ?? null;
}
