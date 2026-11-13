import { readFileSync } from "node:fs";
import { toPcm16, type TtsEngine, type Voice } from "../engines.js";
import { loadSherpa, type SherpaModule, type TtsLike } from "./sherpa.js";

/**
 * Speech from Supertonic 3 through sherpa-onnx: one model, ten voices, English and Portuguese (it knows thirty-one
 * languages; the call recognises two for now). A sentence is made whole and then handed over, which is why the call
 * speaks in short sentences and starts with a short first one: the time to the first sound is the time to say that first
 * phrase, about half a second for a phrase of five or six words.
 */

/** The ten styles in the model's order: the first five sound feminine, the last five masculine (measured by pitch). */
export const SUPERTONIC_STYLES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;
export const SUPERTONIC_LANGS: readonly string[] = ["en", "pt", "es"];

const FILLER_PHRASES = new Set([
  "One moment.",
  "Let me think.",
  "Let me check.",
  "Give me a second.",
  "Um momento.",
  "Deixa eu pensar.",
  "Deixa eu ver.",
  "Só um segundo.",
  "Un momento.",
  "Déjame pensar.",
  "Déjame revisar.",
  "Dame un segundo.",
]);

function splitLongClause(text: string, maxLen = 95): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return [trimmed];
  const out: string[] = [];
  let rest = trimmed;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    let cut = -1;
    for (const re of [/[,;:]\s/g, /\s[—-]\s/g]) {
      for (let m = re.exec(window); m !== null; m = re.exec(window)) {
        if (m.index + m[0].length >= 24) cut = Math.max(cut, m.index + m[0].length);
      }
      if (cut > 0) break;
    }
    if (cut < 0) break;
    const head = rest.slice(0, cut).trim();
    if (head !== "") out.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest !== "") out.push(rest);
  return out.length > 0 ? out : [trimmed];
}

export interface SherpaTtsOptions {
  runtimeDir: string | null;
  modelDir: string;
  /** The model gains nothing from more than two or three threads; more is slower. */
  threads: number;
  /** Denoising steps: fewer is faster and a little rougher (5 is the model's own default). */
  steps: number;
  log?: (line: string) => void;
}

function readSampleRate(modelDir: string): number {
  try {
    const json = JSON.parse(readFileSync(`${modelDir}/tts.json`, "utf8")) as { ae?: { sample_rate?: number } };
    return json.ae?.sample_rate ?? 44100;
  } catch {
    return 44100;
  }
}

export function supertonicVoices(langs: readonly string[] = SUPERTONIC_LANGS): Voice[] {
  const voices: Voice[] = [];
  for (const lang of langs) {
    for (const style of SUPERTONIC_STYLES) voices.push({ id: `${lang}:${style}`, name: `${style.startsWith("F") ? "Female" : "Male"} ${style.slice(1)}`, lang });
  }
  return voices;
}

function parseVoice(id: string): { lang: string; sid: number } {
  const [lang, style] = id.includes(":") ? id.split(":") : ["en", id];
  const sid = SUPERTONIC_STYLES.indexOf((style ?? "F1") as (typeof SUPERTONIC_STYLES)[number]);
  return { lang: lang && lang !== "" ? lang : "en", sid: sid < 0 ? 0 : sid };
}

export class SherpaTts implements TtsEngine {
  readonly id = "supertonic-3";
  readonly sampleRate: number;
  readonly voices: readonly Voice[];
  private sherpa: SherpaModule | null = null;
  private model: TtsLike | null = null;
  private loading: Promise<TtsLike> | null = null;
  private warmPromise: Promise<void> | null = null;
  private readonly fillerCache = new Map<string, Int16Array[]>();
  /** The model makes one thing at a time: the next sentence waits for this to settle. */
  private busy: Promise<unknown> = Promise.resolve();
  loadMs = 0;

  constructor(private readonly options: SherpaTtsOptions) {
    this.sampleRate = readSampleRate(options.modelDir);
    this.voices = supertonicVoices();
  }

  private load(): Promise<TtsLike> {
    if (this.model) return Promise.resolve(this.model);
    if (this.loading) return this.loading;
    const { modelDir, threads } = this.options;
    const started = Date.now();
    this.loading = (async () => {
      const sherpa = loadSherpa(this.options.runtimeDir);
      this.sherpa = sherpa;
      const model = await sherpa.OfflineTts.createAsync({
        model: {
          supertonic: {
            durationPredictor: `${modelDir}/duration_predictor.int8.onnx`,
            textEncoder: `${modelDir}/text_encoder.int8.onnx`,
            vectorEstimator: `${modelDir}/vector_estimator.int8.onnx`,
            vocoder: `${modelDir}/vocoder.int8.onnx`,
            ttsJson: `${modelDir}/tts.json`,
            unicodeIndexer: `${modelDir}/unicode_indexer.bin`,
            voiceStyle: `${modelDir}/voice.bin`,
          },
          numThreads: threads,
          debug: false,
          provider: "cpu",
        },
        maxNumSentences: 1,
      });
      this.model = model;
      this.loadMs = Date.now() - started;
      return model;
    })();
    this.loading.catch(() => {
      this.loading = null;
    });
    return this.loading;
  }

  warm(): Promise<void> {
    if (this.warmPromise) return this.warmPromise;
    const run = (async () => {
      await this.load();
      for await (const _ of this.synthesize("One moment.", { voice: "en:F1", speed: 1, signal: new AbortController().signal })) void _;
    })();
    run.catch(() => {
      if (this.warmPromise === run) this.warmPromise = null;
    });
    this.warmPromise = run;
    return run;
  }

  async *synthesize(
    text: string,
    options: { voice: string; speed: number; signal: AbortSignal; firstChunk?: boolean },
  ): AsyncIterable<Int16Array> {
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const trimmed = text.trim();
    const isFiller = FILLER_PHRASES.has(trimmed);
    const cacheKey = isFiller ? `${options.voice}|${options.speed}|${trimmed}` : null;
    if (cacheKey) {
      const hit = this.fillerCache.get(cacheKey);
      if (hit) {
        for (const chunk of hit) {
          if (options.signal.aborted) return;
          yield chunk;
        }
        return;
      }
    }
    const clauses = splitLongClause(trimmed, 95);
    const collectedForCache: Int16Array[] | null = cacheKey && this.fillerCache.size < 48 ? [] : null;
    for (let idx = 0; idx < clauses.length; idx++) {
      if (options.signal.aborted) return;
      const clause = clauses[idx] as string;
      const steps =
        options.firstChunk && idx === 0 && clause.length <= 60 && this.options.steps <= 4
          ? 3
          : this.options.steps;
      for await (const pcm of this.synthesizeClause(clause, { ...options, steps })) {
        collectedForCache?.push(pcm);
        yield pcm;
      }
    }
    if (cacheKey && collectedForCache && collectedForCache.length > 0 && !options.signal.aborted) {
      this.fillerCache.set(cacheKey, collectedForCache);
    }
  }

  private async *synthesizeClause(
    text: string,
    options: { voice: string; speed: number; signal: AbortSignal; steps: number },
  ): AsyncIterable<Int16Array> {
    const model = await this.load();
    const sherpa = this.sherpa as SherpaModule;
    const { lang, sid } = parseVoice(options.voice);
    const { signal } = options;
    // Wait for the model to be free; a sentence that was cut off may still be finishing in the native code.
    const previous = this.busy;
    let release: () => void = () => undefined;
    this.busy = new Promise<void>((resolve) => (release = resolve));
    await previous.catch(() => undefined);
    if (signal.aborted) {
      release();
      return;
    }
    const chunks: Int16Array[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    const config = new sherpa.GenerationConfig({ sid, speed: options.speed, numSteps: options.steps, extra: { lang } });
    const run = model
      .generateAsync({
        text,
        sid,
        speed: options.speed,
        generationConfig: config,
        onProgress: ({ samples }) => {
          if (signal.aborted) return 0;
          chunks.push(toPcm16(samples));
          wake?.();
          return 1;
        },
      })
      .then(
        () => undefined,
        (error: unknown) => {
          failure = error;
        },
      )
      .then(() => {
        finished = true;
        wake?.();
      });
    try {
      for (;;) {
        while (chunks.length > 0) yield chunks.shift() as Int16Array;
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (chunks.length > 0 || finished) resolve();
        });
        wake = null;
      }
      if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
    } finally {
      // Whether the sentence was said or the listener walked away, the model is released when it has really stopped.
      void run.then(release);
    }
  }
}
