import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The part of sherpa-onnx-node the call needs, written down as types, and the one place that loads it. The package is an
 * optional download (it carries native code for each platform and is large), so nothing else imports it: everything that
 * needs a recogniser, a detector or a voice asks for it here and gets a clear error when it is not installed.
 */

export interface SherpaWave {
  samples: Float32Array;
  sampleRate: number;
}

export interface OnlineStreamLike {
  acceptWaveform(wave: SherpaWave): void;
  inputFinished(): void;
  setOption(key: string, value: string): void;
}

export interface OnlineRecognizerLike {
  createStream(): OnlineStreamLike;
  isReady(stream: OnlineStreamLike): boolean;
  decode(stream: OnlineStreamLike): void;
  getResult(stream: OnlineStreamLike): { text: string };
}

export interface OfflineStreamLike {
  acceptWaveform(wave: SherpaWave): void;
}

export interface OfflineRecognizerLike {
  createStream(): OfflineStreamLike;
  decode(stream: OfflineStreamLike): void;
  getResult(stream: OfflineStreamLike): { text: string };
}

export interface VadLike {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  pop(): void;
  reset(): void;
  clear(): void;
}

export interface TtsRequest {
  text: string;
  sid: number;
  speed: number;
  generationConfig?: object;
  onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
}

export interface TtsLike {
  readonly sampleRate: number;
  readonly numSpeakers: number;
  generateAsync(request: TtsRequest): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export interface SherpaModule {
  OnlineRecognizer: new (config: object) => OnlineRecognizerLike;
  OfflineRecognizer: new (config: object) => OfflineRecognizerLike;
  Vad: new (config: object, bufferSizeInSeconds: number) => VadLike;
  OfflineTts: { createAsync(config: object): Promise<TtsLike> };
  GenerationConfig: new (options: object) => object;
  version?: string;
}

/** The voice engines are not installed, or would not load. The message says what to do about it. */
export class VoiceRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceRuntimeError";
  }
}

const cache = new Map<string, SherpaModule>();

/**
 * Loads sherpa-onnx-node from `runtimeDir` (a folder with a node_modules inside, where the pack was installed) or, when
 * there is none, from wherever Node finds it. Loading is cached; a failure is explained, not thrown raw.
 */
export function loadSherpa(runtimeDir: string | null): SherpaModule {
  const key = runtimeDir ?? "";
  const known = cache.get(key);
  if (known) return known;
  try {
    const require = createRequire(runtimeDir ? join(runtimeDir, "noop.js") : __filename);
    const loaded = require("sherpa-onnx-node") as SherpaModule;
    cache.set(key, loaded);
    return loaded;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new VoiceRuntimeError(
      runtimeDir
        ? `The voice engines could not be loaded from ${runtimeDir} (${reason}). Reinstall them from Settings, Voice.`
        : `The voice engines are not installed (${reason}). Install them from Settings, Voice.`,
    );
  }
}

/** Float32 samples (-1..1) of a whole stretch of audio, joined from the pieces it arrived in. */
export function joinSamples(pieces: readonly Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}
