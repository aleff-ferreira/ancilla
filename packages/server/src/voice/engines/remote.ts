import { toPcm16, type AsrEngine, type AsrResult, type AsrStream, type Engines, type TtsEngine, type VadEngine, type Voice } from "../engines.js";

/**
 * Speech engines that need no native runtime or downloaded model pack:
 * - `AdaptiveEnergyVad`: pure-JavaScript 16 kHz speech detector with adaptive noise-floor tracking, pre-emphasis voice-band
 *   filtering, and zero-crossing bounds so machines without ONNX native addons can still run hands-free turn-taking.
 * - `HttpWhisperAsr`: streams or batches 16 kHz mono WAV audio to any `/audio/transcriptions` server (hosted providers or
 *   local servers such as whisper.cpp, faster-whisper-server, or speaches).
 * - `HttpSpeechTts`: streams 16-bit PCM audio from any `/audio/speech` server (such as Kokoro-FastAPI, OpenedAI-Speech, or
 *   hosted speech endpoints), stripping RIFF WAV headers automatically when a server ignores `response_format: "pcm"`.
 */

const SAMPLE_RATE_IN = 16_000;
const DEFAULT_TTS_SAMPLE_RATE = 24_000;

export function httpSpeechVoices(): Voice[] {
  return [
    { id: "en:nova", name: "Nova (warm)", lang: "en" },
    { id: "en:alloy", name: "Alloy (neutral)", lang: "en" },
    { id: "en:echo", name: "Echo (calm)", lang: "en" },
    { id: "en:sage", name: "Sage (clear)", lang: "en" },
    { id: "pt:nova", name: "Nova (calorosa)", lang: "pt" },
    { id: "pt:alloy", name: "Alloy (neutra)", lang: "pt" },
    { id: "pt:coral", name: "Coral (expressiva)", lang: "pt" },
    { id: "pt:echo", name: "Echo (calma)", lang: "pt" },
    { id: "es:nova", name: "Nova (cálida)", lang: "es" },
    { id: "es:alloy", name: "Alloy (neutral)", lang: "es" },
    { id: "es:coral", name: "Coral (expresiva)", lang: "es" },
    { id: "es:echo", name: "Echo (calmada)", lang: "es" },
  ];
}

/**
 * Pure-JS voice activity detector operating on 32 ms (512-sample) 16 kHz frames.
 * Tracks the ambient noise floor continuously and scores pre-emphasized voice-band energy + zero-crossing rate.
 */
export class AdaptiveEnergyVad implements VadEngine {
  readonly id = "adaptive-energy-vad";
  readonly frameSamples = 512;

  private noiseFloor = 0.004;
  private smoothed = 0;
  private prevSample = 0;

  process(frame: Float32Array): number {
    if (frame.length === 0) return 0;
    let sumSq = 0;
    let hpSumSq = 0;
    let crossings = 0;
    let prev = this.prevSample;
    for (let i = 0; i < frame.length; i++) {
      const s = frame[i] as number;
      sumSq += s * s;
      const hp = s - 0.95 * prev;
      hpSumSq += hp * hp;
      if (i > 0 && (s >= 0) !== (prev >= 0) && Math.abs(s - prev) > 0.002) crossings++;
      prev = s;
    }
    this.prevSample = prev;

    const rms = Math.sqrt(sumSq / frame.length);
    const hpRms = Math.sqrt(hpSumSq / frame.length);
    const zcr = crossings / frame.length;
    // Blend broadband and pre-emphasized RMS so low-frequency rumble (50/60 Hz hum, desk bumps) is attenuated.
    const voiceEnergy = 0.45 * rms + 0.55 * hpRms;

    // Update ambient floor quickly when energy drops, and very slowly upward so sustained speech never becomes "silence".
    if (voiceEnergy < this.noiseFloor) {
      this.noiseFloor = Math.max(0.0008, 0.88 * this.noiseFloor + 0.12 * voiceEnergy);
    } else if (voiceEnergy < this.noiseFloor * 2.2) {
      this.noiseFloor = Math.min(0.06, 0.985 * this.noiseFloor + 0.015 * voiceEnergy);
    }

    const snrDb = 20 * Math.log10((voiceEnergy + 1e-6) / (this.noiseFloor + 1e-6));
    // Human speech at 16 kHz sits roughly in ZCR 0.015..0.48; pure ultrasonic hiss or DC drift sits outside it.
    const bandPenalty = zcr < 0.008 || zcr > 0.55 ? 0.55 : 1;
    const rawProb = voiceEnergy < 0.0035 ? 0 : Math.max(0, Math.min(1, ((snrDb - 4.5) / 11) * bandPenalty));

    // Fast attack so word onsets aren't clipped; slight release hangover so short plosive closures stay connected.
    this.smoothed = rawProb >= this.smoothed ? 0.65 * rawProb + 0.35 * this.smoothed : 0.45 * rawProb + 0.55 * this.smoothed;
    return Math.max(0, Math.min(1, this.smoothed));
  }

  reset(): void {
    this.noiseFloor = 0.004;
    this.smoothed = 0;
    this.prevSample = 0;
  }
}

/** Encodes 16 kHz mono float32 chunks into a standard 44-byte RIFF PCM16LE WAV buffer. */
export function encodeWavPcm16(chunks: readonly Float32Array[], sampleRate = SAMPLE_RATE_IN): Buffer {
  let totalSamples = 0;
  for (const c of chunks) totalSamples += c.length;
  const dataBytes = totalSamples * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buf.writeUInt16LE(1, 22); // NumChannels = 1 (mono)
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buf.writeUInt16LE(2, 32); // BlockAlign
  buf.writeUInt16LE(16, 34); // BitsPerSample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (const chunk of chunks) {
    const pcm = toPcm16(chunk);
    for (let i = 0; i < pcm.length; i++) {
      buf.writeInt16LE(pcm[i] as number, offset);
      offset += 2;
    }
  }
  return buf;
}

/** Drops bracketed sound-effect markers (`[BLANK_AUDIO]`, `(music)`) that Whisper models emit on quiet clips. */
export function cleanWhisperTranscript(raw: string): string {
  const stripped = raw
    .replace(/\[(?:blank_audio|silence|music|applause|laughter|inaudible|noise)[^\]]*\]/gi, " ")
    .replace(/\((?:upbeat music|music|silence|applause|laughter|inaudible|noise)[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

export interface HttpWhisperAsrOptions {
  baseUrl: string;
  model: string;
  apiKey?: () => string | null;
  fetchImpl?: typeof fetch;
  /** Minimum interval between live partial transcription requests during long utterances. Default 950 ms. */
  partialIntervalMs?: number;
  log?: (line: string) => void;
}

class HttpWhisperStream implements AsrStream {
  onPartial?: (result: AsrResult) => void;
  private readonly chunks: Float32Array[] = [];
  private totalSamples = 0;
  private latestText = "";
  private transcribedSamples = 0;
  private inflight: { samples: number; promise: Promise<string> } | null = null;
  private lastRequestAt = 0;
  private disposed = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly lang: string | null,
    private readonly opts: Required<Pick<HttpWhisperAsrOptions, "baseUrl" | "model">> & HttpWhisperAsrOptions,
    private readonly vocabulary: readonly string[] = [],
  ) {}

  accept(samples: Float32Array): void {
    if (this.disposed || samples.length === 0) return;
    this.chunks.push(samples.slice());
    this.totalSamples += samples.length;
  }

  partial(): AsrResult {
    if (this.disposed) return { text: this.latestText };
    const interval = this.opts.partialIntervalMs ?? 950;
    const now = Date.now();
    // Kick off a background partial transcription if enough fresh audio (~320 ms) has accumulated and none is running.
    if (
      !this.inflight &&
      this.totalSamples - this.transcribedSamples >= 5_120 &&
      this.totalSamples >= 6_400 &&
      now - this.lastRequestAt >= interval
    ) {
      void this.startTranscription();
    }
    return { text: this.latestText };
  }

  flush(): void {
    if (this.disposed || this.totalSamples < 1_600) return;
    if (!this.inflight && this.transcribedSamples < this.totalSamples) {
      void this.startTranscription();
    }
  }

  async finish(): Promise<AsrResult> {
    if (this.disposed || this.totalSamples < 1_600) return { text: this.latestText, endpoint: true };
    if (this.inflight && this.inflight.samples === this.totalSamples) {
      const text = await this.inflight.promise;
      return { text, endpoint: true, snapshotHit: true };
    }
    if (this.transcribedSamples === this.totalSamples) {
      return { text: this.latestText, endpoint: true, snapshotHit: true };
    }
    const text = await this.startTranscription();
    return { text, endpoint: true };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.chunks.length = 0;
  }

  private startTranscription(): Promise<string> {
    const snapshotChunks = this.chunks.slice();
    const snapshotSamples = this.totalSamples;
    this.lastRequestAt = Date.now();
    const promise = this.requestTranscript(snapshotChunks)
      .then((text) => {
        if (!this.disposed && snapshotSamples >= this.transcribedSamples) {
          const changed = text !== this.latestText;
          this.latestText = text;
          this.transcribedSamples = snapshotSamples;
          if (changed) this.onPartial?.({ text: this.latestText });
        }
        return this.latestText;
      })
      .catch((error) => {
        if (!this.disposed) {
          this.opts.log?.(`speech recognition failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return this.latestText;
      })
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
      });
    this.inflight = { samples: snapshotSamples, promise };
    return promise;
  }

  private async requestTranscript(chunks: readonly Float32Array[]): Promise<string> {
    const wav = encodeWavPcm16(chunks, SAMPLE_RATE_IN);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("model", this.opts.model);
    form.append("response_format", "json");
    const langCode = this.lang ? this.lang.toLowerCase().split("-")[0] : null;
    if (langCode && /^[a-z]{2}$/.test(langCode)) form.append("language", langCode);
    if (this.vocabulary.length > 0) {
      form.append("prompt", this.vocabulary.slice(0, 24).join(", "));
    }

    const headers: Record<string, string> = {};
    const key = this.opts.apiKey?.();
    if (key) headers["authorization"] = `Bearer ${key}`;

    const fetchFn = this.opts.fetchImpl ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
    const res = await fetchFn(url, { method: "POST", headers, body: form, signal: this.abort.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = (await res.json()) as { text?: unknown };
      return typeof json.text === "string" ? cleanWhisperTranscript(json.text) : "";
    }
    return cleanWhisperTranscript(await res.text());
  }
}

export class HttpWhisperAsr implements AsrEngine {
  readonly id: string;

  constructor(private readonly opts: HttpWhisperAsrOptions) {
    this.id = `http-asr:${opts.model}`;
  }

  open(lang: string | null, options?: { vocabulary?: readonly string[] }): AsrStream {
    return new HttpWhisperStream(lang, this.opts, options?.vocabulary ?? []);
  }
}

/**
 * Inspects the leading bytes of a TTS response: if it starts with a RIFF WAVE header, locates the start of the `data`
 * chunk's PCM payload; otherwise returns 0 so raw PCM streams pass straight through.
 */
export function findWavDataOffset(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // "RIFF"
  const isWave = bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45; // "WAVE"
  if (!isRiff || !isWave) return 0;

  let offset = 12;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 8 <= bytes.length) {
    const id0 = bytes[offset];
    const id1 = bytes[offset + 1];
    const id2 = bytes[offset + 2];
    const id3 = bytes[offset + 3];
    const chunkSize = view.getUint32(offset + 4, true);
    if (id0 === 0x64 && id1 === 0x61 && id2 === 0x74 && id3 === 0x61) {
      // "data"
      return offset + 8;
    }
    const next = offset + 8 + chunkSize + (chunkSize % 2);
    if (next <= offset || next > 4096) return 44 <= bytes.length ? 44 : null;
    offset = next;
  }
  // Wait for more header bytes if under 256 bytes; otherwise assume standard 44-byte header.
  return bytes.length < 256 ? null : 44;
}

export interface HttpSpeechTtsOptions {
  baseUrl: string;
  model: string;
  apiKey?: () => string | null;
  fetchImpl?: typeof fetch;
  sampleRate?: number;
  voices?: readonly Voice[];
  log?: (line: string) => void;
}

export class HttpSpeechTts implements TtsEngine {
  readonly id: string;
  readonly sampleRate: number;
  readonly voices: readonly Voice[];

  constructor(private readonly opts: HttpSpeechTtsOptions) {
    this.id = `http-tts:${opts.model}`;
    this.sampleRate = opts.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
    this.voices = opts.voices ?? httpSpeechVoices();
  }

  async *synthesize(text: string, options: { voice: string; speed: number; signal: AbortSignal }): AsyncGenerator<Int16Array> {
    const trimmed = text.trim();
    if (trimmed === "" || options.signal.aborted) return;

    const providerVoice = options.voice.includes(":") ? (options.voice.split(":")[1] ?? "nova") : options.voice || "nova";
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = this.opts.apiKey?.();
    if (key) headers["authorization"] = `Bearer ${key}`;

    const fetchFn = this.opts.fetchImpl ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/audio/speech`;
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.opts.model,
          input: trimmed,
          voice: providerVoice,
          speed: Math.max(0.5, Math.min(2.0, options.speed)),
          response_format: "pcm",
        }),
        signal: options.signal,
      });
    } catch (error) {
      if (!options.signal.aborted) this.opts.log?.(`speech synthesis failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      this.opts.log?.(`speech synthesis HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
      return;
    }

    const reader = res.body.getReader();
    let headerChecked = false;
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    try {
      for (;;) {
        if (options.signal.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        let merged: Uint8Array;
        if (pending.byteLength === 0) {
          merged = value;
        } else {
          merged = new Uint8Array(pending.byteLength + value.byteLength);
          merged.set(pending, 0);
          merged.set(value, pending.byteLength);
        }

        if (!headerChecked) {
          const dataOffset = findWavDataOffset(merged);
          if (dataOffset === null) {
            pending = merged;
            continue;
          }
          headerChecked = true;
          merged = merged.subarray(dataOffset);
        }

        const evenBytes = merged.byteLength & ~1;
        if (evenBytes > 0) {
          const samples = new Int16Array(evenBytes / 2);
          const view = new DataView(merged.buffer, merged.byteOffset, evenBytes);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
          yield samples;
        }
        pending = evenBytes < merged.byteLength ? merged.slice(evenBytes) : new Uint8Array(0);
      }
    } catch (error) {
      if (!options.signal.aborted) {
        this.opts.log?.(`speech stream interrupted: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export interface RemoteSpeechOptions {
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  apiKey?: () => string | null;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export function createRemoteEngines(options: RemoteSpeechOptions): { engines: Engines; dispose(): Promise<void> } {
  const vad = new AdaptiveEnergyVad();
  const asr = new HttpWhisperAsr({
    baseUrl: options.baseUrl,
    model: options.sttModel,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });
  const tts = new HttpSpeechTts({
    baseUrl: options.baseUrl,
    model: options.ttsModel,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });
  return {
    engines: { vad, asr, tts },
    dispose: async () => vad.reset(),
  };
}
