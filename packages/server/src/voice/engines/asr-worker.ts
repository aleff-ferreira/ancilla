import { parentPort } from "node:worker_threads";
import type { AsrInit, FinalResult, FromWorker, ToWorker } from "./asr-protocol.js";
import {
  joinSamples,
  loadSherpa,
  type OfflineRecognizerLike,
  type OnlineRecognizerLike,
  type OnlineStreamLike,
  type RecognizerResultLike,
} from "./sherpa.js";

/**
 * The recogniser, on a thread of its own: decoding a chunk of speech takes tens of milliseconds, which on the thread that
 * serves the screen would be felt as stutter. Two models live here. The streaming one gives words as they are said, so
 * the call can show them and judge when a sentence is complete. The offline one, when it is installed, reads what was
 * said again, and its reading is the transcript: it is far more accurate on names and numbers, and it writes punctuation.
 *
 * Speech is read in stretches. Each time the person pauses, the stretch since the last pause is read by the offline model
 * and closed; the streaming model starts afresh for the next one. So when the turn ends only the last few words, if any,
 * are left to read, and the time that costs does not grow with how long the person spoke. What the call sees as "heard so
 * far" is the offline reading of the closed stretches followed by the streaming words of the open one.
 */

if (!parentPort) throw new Error("asr-worker must run as a worker thread");
const port = parentPort;

const SAMPLE_RATE = 16000;
/** Silence fed to the streaming model so that it says the words it was waiting to be sure of. */
const TAIL_SAMPLES = Math.round(0.4 * SAMPLE_RATE);
/** At a pause, the speech since the last stretch is read if there is this much of it. */
const MIN_SEGMENT_SAMPLES = Math.round(0.6 * SAMPLE_RATE);
/** At the end of the turn, what is left is read if there is this much and it is not silence. */
const MIN_REST_SAMPLES = Math.round(0.25 * SAMPLE_RATE);
/** Quieter than this, a stretch of audio counts as silence (a peak, on a scale of 0 to 1). */
const SILENT_PEAK = 0.008;
/** Below 20 s, `flush` takes a non-destructive snapshot without resetting the streaming transducer; above 20 s it rolls over. */
const ROLLOVER_SAMPLES = 20 * SAMPLE_RATE;
/** The offline model reads a stretch up to this long; a longer one is left to the streaming model. */
const MAX_SEGMENT_SAMPLES = 40 * SAMPLE_RATE;

let streaming: OnlineRecognizerLike | null = null;
let offline: OfflineRecognizerLike | null = null;

interface DecodedReading {
  text: string;
  tokens?: string[];
  tokenLogProbs?: number[];
}

interface Snapshot extends DecodedReading {
  total: number;
}

interface OpenStream {
  lang: string | null;
  vocabulary: readonly string[];
  /** The open stretch: its streaming stream, what that has said, and its audio. */
  stream: OnlineStreamLike;
  open: string;
  pieces: Float32Array[];
  total: number;
  /** Non-destructive Parakeet snapshot decoded during `flush` for the current `total` sample count. */
  snapshot: Snapshot | null;
  /** The offline readings of the stretches that were closed (> 20 s rollover). */
  read: string[];
  /** The streaming readings of the stretches that were closed (> 20 s rollover). */
  streamingRead: string[];
  readMs: number;
  /** What was last sent as the words so far. */
  sent: string;
}
type Live = OpenStream;
const live = new Map<number, Live>();

const now = (): number => Number(process.hrtime.bigint()) / 1e6;

function post(message: FromWorker): void {
  port.postMessage(message);
}

function ok(req: number, value?: FinalResult | { loadMs: number } | null): void {
  post({ op: "reply", req, ok: true, value: value ?? null });
}

function fail(req: number, error: unknown): void {
  post({ op: "reply", req, ok: false, error: error instanceof Error ? error.message : String(error) });
}

function init(config: AsrInit): { loadMs: number } {
  const t0 = now();
  const sherpa = loadSherpa(config.runtimeDir);
  const transducer = (dir: string) => ({ encoder: `${dir}/encoder.int8.onnx`, decoder: `${dir}/decoder.int8.onnx`, joiner: `${dir}/joiner.int8.onnx` });
  streaming = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
    modelConfig: { transducer: transducer(config.streamingDir), tokens: `${config.streamingDir}/tokens.txt`, numThreads: config.threads, provider: "cpu", debug: 0 },
  });
  if (config.finalDir) {
    offline = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
      modelConfig: { transducer: transducer(config.finalDir), tokens: `${config.finalDir}/tokens.txt`, numThreads: config.finalThreads, provider: "cpu", debug: 0, modelType: "nemo_transducer" },
    });
  }
  return { loadMs: Math.round(now() - t0) };
}

function sanitizeHotwords(vocabulary?: readonly string[]): string[] {
  if (!vocabulary || vocabulary.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vocabulary) {
    const clean = raw.replace(/[\r\n\t]+/g, " ").trim();
    if (clean.length < 2 || clean.length > 80) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 32) break;
  }
  return out;
}

function newStream(lang: string | null, vocabulary?: readonly string[]): OnlineStreamLike {
  if (!streaming) throw new Error("the recogniser is not loaded");
  const stream = streaming.createStream();
  if (lang) stream.setOption("language", lang.toLowerCase().split("-")[0] ?? "auto");
  const hotwords = sanitizeHotwords(vocabulary);
  if (hotwords.length > 0 && typeof stream.setOption === "function") {
    try {
      stream.setOption("hotwords", hotwords.join("\n"));
    } catch {
      // Ignore if an online stream implementation rejects unknown option keys.
    }
  }
  return stream;
}

function decodeReady(recognizer: OnlineRecognizerLike, stream: OnlineStreamLike): void {
  while (recognizer.isReady(stream)) recognizer.decode(stream);
}

function feed(item: Live, samples: Float32Array): void {
  if (!streaming) return;
  item.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  decodeReady(streaming, item.stream);
  item.open = streaming.getResult(item.stream).text;
}

/** A full stop that only marks where the person paused is dropped from every reading but the last. */
function joinReadings(parts: readonly string[]): string {
  const present = parts.map((p) => p.trim()).filter((p) => p !== "");
  return present
    .map((part, index) => (index < present.length - 1 ? part.replace(/\.$/, "") : part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the call is told has been heard: the closed stretches as the offline model read them, then the open one's words. */
function wordsSoFar(item: Live, overrideOpen?: string): string {
  return joinReadings([...item.read, overrideOpen ?? item.open]);
}

function publish(id: number, item: Live, overrideOpen?: string): void {
  const text = wordsSoFar(item, overrideOpen);
  if (text === item.sent) return;
  item.sent = text;
  post({ op: "partial", id, text });
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number);
    if (v > peak) peak = v;
  }
  return peak;
}

function extractDecoded(res: RecognizerResultLike): DecodedReading {
  const tokens = Array.isArray(res.tokens) && res.tokens.length > 0 ? res.tokens : undefined;
  let tokenLogProbs: number[] | undefined;
  if (Array.isArray(res.ys_log_probs) && res.ys_log_probs.length > 0) {
    tokenLogProbs = res.ys_log_probs.map((v) => (Number.isFinite(v) ? v : -10));
  } else if (Array.isArray(res.ys_probs) && res.ys_probs.length > 0) {
    tokenLogProbs = res.ys_probs.map((p) => Math.log(Math.max(1e-9, Number.isFinite(p) ? p : 1e-9)));
  }
  return {
    text: res.text.trim(),
    ...(tokens ? { tokens } : {}),
    ...(tokenLogProbs ? { tokenLogProbs } : {}),
  };
}

/** The offline model's reading of the open stretch, or null if it cannot read it (no model, too long). */
async function readOpen(item: Live): Promise<DecodedReading | null> {
  if (!offline || item.total === 0 || item.total > MAX_SEGMENT_SAMPLES) return null;
  const t0 = now();
  const stream = offline.createStream();
  stream.acceptWaveform({ samples: joinSamples(item.pieces, item.total), sampleRate: SAMPLE_RATE });
  if (typeof offline.decodeAsync === "function") {
    await offline.decodeAsync(stream);
  } else {
    offline.decode(stream);
  }
  const reading = extractDecoded(offline.getResult(stream));
  item.readMs += now() - t0;
  return reading;
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * Whether the offline model's reading can be trusted over what the streaming model heard. It is the more accurate of the
 * two, but a stretch that begins in the middle of a word, or is mostly noise, can leave it with nothing or a fragment;
 * then the streaming words are the better account of what was said.
 */
function trusted(offlineText: string | null, streamingText: string): offlineText is string {
  if (offlineText === null || offlineText === "") return false;
  const heard = wordCount(streamingText);
  return !(heard >= 4 && wordCount(offlineText) * 3 < heard);
}

function flushStream(stream: OnlineStreamLike): DecodedReading {
  if (!streaming) return { text: "" };
  stream.acceptWaveform({ samples: new Float32Array(TAIL_SAMPLES), sampleRate: SAMPLE_RATE });
  stream.inputFinished();
  decodeReady(streaming, stream);
  return extractDecoded(streaming.getResult(stream));
}

/** Closes the open stretch with `text` as what was said in it, and starts the next one. */
function closeStretch(item: Live, text: string): void {
  let openReading = item.open.trim();
  if (streaming && item.total > 0) {
    const flushed = flushStream(item.stream).text;
    if (flushed !== "") openReading = flushed;
  }
  if (openReading !== "") item.streamingRead.push(openReading);
  item.read.push(text);
  item.pieces = [];
  item.total = 0;
  item.snapshot = null;
  item.open = "";
  item.stream = newStream(item.lang, item.vocabulary);
}

async function finish(item: Live, queueMs: number): Promise<FinalResult> {
  if (!streaming) throw new Error("the recogniser is not loaded");
  const readAhead = item.read.length + (item.snapshot && item.snapshot.total === item.total ? 1 : 0);
  const before = item.readMs;
  let tail = "";
  let finalStreamText = item.open.trim();
  let tokens: string[] | undefined;
  let tokenLogProbs: number[] | undefined;
  let snapshotHit = false;
  let usedOffline = item.read.length > 0;
  if (item.total > 0) {
    const streamReading = flushStream(item.stream);
    if (streamReading.text !== "") finalStreamText = streamReading.text;
    if (item.snapshot && item.snapshot.total === item.total && trusted(item.snapshot.text, finalStreamText)) {
      tail = item.snapshot.text;
      tokens = item.snapshot.tokens;
      tokenLogProbs = item.snapshot.tokenLogProbs;
      snapshotHit = true;
      usedOffline = true;
    } else {
      const worthReading =
        offline !== null &&
        item.total >= MIN_REST_SAMPLES &&
        item.total <= MAX_SEGMENT_SAMPLES &&
        peakOf(joinSamples(item.pieces, item.total)) >= SILENT_PEAK;
      const read = worthReading ? await readOpen(item) : null;
      if (read !== null && trusted(read.text, finalStreamText)) {
        tail = read.text;
        tokens = read.tokens;
        tokenLogProbs = read.tokenLogProbs;
        usedOffline = true;
      } else {
        tail = streamReading.text;
        tokens = streamReading.tokens;
        tokenLogProbs = streamReading.tokenLogProbs;
      }
    }
  }
  const text = joinReadings([...item.read, tail]);
  const assembledStreaming = joinReadings([...item.streamingRead, finalStreamText]);
  const streamingText = assembledStreaming !== "" ? assembledStreaming : undefined;
  const refined = offline !== null && usedOffline;
  return {
    text,
    ...(streamingText !== undefined ? { streamingText } : {}),
    refined,
    segments: item.read.length + (tail !== "" ? 1 : 0),
    readAhead,
    refineMs: Math.round(item.readMs - before),
    queueMs: Math.round(queueMs),
    ...(tokens ? { tokens } : {}),
    ...(tokenLogProbs ? { tokenLogProbs } : {}),
    snapshotHit,
  };
}

async function handle(message: ToWorker): Promise<void> {
  switch (message.op) {
    case "init":
      try {
        ok(message.req, init(message.init));
      } catch (error) {
        fail(message.req, error);
      }
      return;
    case "warm":
      try {
        if (!streaming) throw new Error("the recogniser is not loaded");
        const stream = streaming.createStream();
        stream.acceptWaveform({ samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE });
        decodeReady(streaming, stream);
        if (offline) {
          const quiet = offline.createStream();
          quiet.acceptWaveform({ samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE });
          if (typeof offline.decodeAsync === "function") await offline.decodeAsync(quiet);
          else offline.decode(quiet);
        }
        ok(message.req);
      } catch (error) {
        fail(message.req, error);
      }
      return;
    case "open":
      try {
        const vocabulary = message.vocabulary ?? [];
        live.set(message.id, {
          lang: message.lang,
          vocabulary,
          stream: newStream(message.lang, vocabulary),
          open: "",
          pieces: [],
          total: 0,
          snapshot: null,
          read: [],
          streamingRead: [],
          readMs: 0,
          sent: "",
        });
        ok(message.req);
      } catch (error) {
        fail(message.req, error);
      }
      return;
    case "audio": {
      const item = live.get(message.id);
      if (!item) return;
      try {
        item.pieces.push(message.samples);
        item.total += message.samples.length;
        item.snapshot = null;
        feed(item, message.samples);
        publish(message.id, item);
      } catch (error) {
        post({ op: "log", line: `audio could not be decoded: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case "flush": {
      const item = live.get(message.id);
      if (!item || !streaming) return;
      try {
        if (offline && item.total >= MIN_SEGMENT_SAMPLES && item.total <= MAX_SEGMENT_SAMPLES) {
          const reading =
            item.snapshot && item.snapshot.total === item.total
              ? item.snapshot
              : peakOf(joinSamples(item.pieces, item.total)) >= SILENT_PEAK
                ? await readOpen(item)
                : null;
          if (reading && trusted(reading.text, item.open)) {
            if (item.total >= ROLLOVER_SAMPLES) {
              closeStretch(item, reading.text);
              publish(message.id, item);
            } else {
              item.snapshot = { total: item.total, ...reading };
              publish(message.id, item, reading.text);
            }
            return;
          }
        }
        decodeReady(streaming, item.stream);
        item.open = streaming.getResult(item.stream).text;
        publish(message.id, item);
      } catch (error) {
        post({ op: "log", line: `the last words could not be read: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    case "finish": {
      const received = Date.now();
      const item = live.get(message.id);
      live.delete(message.id);
      if (!item) {
        fail(message.req, new Error("no such stream"));
        return;
      }
      try {
        ok(message.req, await finish(item, Math.max(0, received - message.sentAt)));
      } catch (error) {
        fail(message.req, error);
      }
      return;
    }
    case "dispose":
      live.delete(message.id);
      return;
  }
}

let workChain: Promise<void> = Promise.resolve();
port.on("message", (message: ToWorker) => {
  workChain = workChain
    .then(() => handle(message))
    .catch((error) => {
      post({ op: "log", line: `the recogniser worker hit an error: ${error instanceof Error ? error.message : String(error)}` });
    });
});
