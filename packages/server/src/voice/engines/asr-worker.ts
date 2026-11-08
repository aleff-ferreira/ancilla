import { parentPort } from "node:worker_threads";
import type { AsrInit, FinalResult, FromWorker, ToWorker } from "./asr-protocol.js";
import { joinSamples, loadSherpa, type OfflineRecognizerLike, type OnlineRecognizerLike, type OnlineStreamLike } from "./sherpa.js";

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
const SILENT_PEAK = 0.03;
/** The offline model reads a stretch up to this long; a longer one is left to the streaming model. */
const MAX_SEGMENT_SAMPLES = 40 * SAMPLE_RATE;

let streaming: OnlineRecognizerLike | null = null;
let offline: OfflineRecognizerLike | null = null;

interface Live {
  lang: string | null;
  /** The open stretch: its streaming stream, what that has said, and its audio. */
  stream: OnlineStreamLike;
  open: string;
  pieces: Float32Array[];
  total: number;
  /** The offline readings of the stretches that were closed. */
  read: string[];
  readMs: number;
  /** What was last sent as the words so far. */
  sent: string;
}
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

function newStream(lang: string | null): OnlineStreamLike {
  if (!streaming) throw new Error("the recogniser is not loaded");
  const stream = streaming.createStream();
  if (lang) stream.setOption("language", lang.toLowerCase().split("-")[0] ?? "auto");
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
function wordsSoFar(item: Live): string {
  return joinReadings([...item.read, item.open]);
}

function publish(id: number, item: Live): void {
  const text = wordsSoFar(item);
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

/** The offline model's reading of the open stretch, or null if it cannot read it (no model, too long). */
function readOpen(item: Live): string | null {
  if (!offline || item.total === 0 || item.total > MAX_SEGMENT_SAMPLES) return null;
  const t0 = now();
  const stream = offline.createStream();
  stream.acceptWaveform({ samples: joinSamples(item.pieces, item.total), sampleRate: SAMPLE_RATE });
  offline.decode(stream);
  const text = offline.getResult(stream).text.trim();
  item.readMs += now() - t0;
  return text;
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

/** Closes the open stretch with `text` as what was said in it, and starts the next one. */
function closeStretch(item: Live, text: string): void {
  item.read.push(text);
  item.pieces = [];
  item.total = 0;
  item.open = "";
  item.stream = newStream(item.lang);
}

function finish(item: Live, queueMs: number): FinalResult {
  if (!streaming) throw new Error("the recogniser is not loaded");
  const readAhead = item.read.length;
  const before = item.readMs;
  let tail = "";
  if (item.total > 0) {
    const worthReading = offline !== null && item.total >= MIN_REST_SAMPLES && item.total <= MAX_SEGMENT_SAMPLES && peakOf(joinSamples(item.pieces, item.total)) >= SILENT_PEAK;
    const read = worthReading ? readOpen(item) : null;
    // The streaming model's last words, which are also what a reading that cannot be trusted is measured against.
    const streamed = (): string => {
      item.stream.acceptWaveform({ samples: new Float32Array(TAIL_SAMPLES), sampleRate: SAMPLE_RATE });
      item.stream.inputFinished();
      decodeReady(streaming as OnlineRecognizerLike, item.stream);
      return (streaming as OnlineRecognizerLike).getResult(item.stream).text.trim();
    };
    if (read !== null && trusted(read, item.open)) {
      tail = read;
    } else if (offline === null || read !== null || item.total > MAX_SEGMENT_SAMPLES || item.open !== "") {
      tail = streamed();
    }
  }
  const text = joinReadings([...item.read, tail]);
  const refined = offline !== null && item.read.length > 0;
  return { text, streamingText: item.open.trim(), refined, segments: item.read.length, readAhead, refineMs: Math.round(item.readMs - before), queueMs: Math.round(queueMs) };
}

function handle(message: ToWorker): void {
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
          offline.decode(quiet);
        }
        ok(message.req);
      } catch (error) {
        fail(message.req, error);
      }
      return;
    case "open":
      try {
        live.set(message.id, { lang: message.lang, stream: newStream(message.lang), open: "", pieces: [], total: 0, read: [], readMs: 0, sent: "" });
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
          // The person has paused: read what they said with the accurate model, show it, and start the next stretch afresh.
          const text = readOpen(item);
          if (trusted(text, item.open)) {
            closeStretch(item, text);
            publish(message.id, item);
            return;
          }
        }
        feed(item, new Float32Array(TAIL_SAMPLES));
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
        ok(message.req, finish(item, Math.max(0, received - message.sentAt)));
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

port.on("message", (message: ToWorker) => {
  try {
    handle(message);
  } catch (error) {
    post({ op: "log", line: `the recogniser worker hit an error: ${error instanceof Error ? error.message : String(error)}` });
  }
});
