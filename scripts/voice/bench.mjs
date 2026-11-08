#!/usr/bin/env node
/**
 * Runs the voice call with the real engines on a real clock and measures it: how long after a person stops speaking the
 * first sound of the reply reaches the client, how well the words were heard, how fast an interruption stops the voice.
 * The model of the assistant is a scripted one with a fixed time to first word, so what is measured is the call itself;
 * pass --ttft to see what a slower or faster model does to the total.
 *
 *   node scripts/voice/bench.mjs --runtime ~/voice-lab --models ~/voice-lab/models --clips ~/voice-lab/data [--suite latency|barge|echo|all] [--n 8] [--ttft 350]
 *
 * Needs the server built (npm run build --workspace @ancilla/server) and the voice pack installed. The clips are
 * folders `en/` and `pt/` of 16 kHz wav files, each with a .txt beside it whose second line is what is said (FLEURS).
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const voice = (p) => require(path.join(root, "packages/server/dist/src/voice", p));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const RUNTIME = arg("runtime", null);
const MODELS = arg("models", null);
const CLIPS = arg("clips", null);
const SUITE = arg("suite", "latency");
const N = Number(arg("n", "8"));
const TTFT = Number(arg("ttft", "350"));
const REFINE = arg("refine", "yes") !== "no";
const STEPS = Number(arg("steps", "4"));
const OUT = arg("out", null);
if (!RUNTIME || !MODELS) {
  console.error("usage: bench.mjs --runtime <dir with node_modules/sherpa-onnx-node> --models <models dir> --clips <dir> [--suite latency|barge|echo|all] [--n 8] [--ttft 350] [--refine yes|no] [--steps 4] [--out file.json]");
  process.exit(2);
}

const { createSherpaEngines, loadSherpa } = voice("engines/index.js");
const { VoiceSession } = voice("session.js");
const { ScriptedBrain, FakeHost } = voice("testing.js");
const { systemScheduler } = voice("scheduler.js");
const { decodeAudioOut } = voice("protocol.js");
const sherpa = loadSherpa(RUNTIME);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

// ---------------------------------------------------------------------------------------------------------------------
// Audio

function readWave(file) {
  const wave = sherpa.readWave ? sherpa.readWave(file) : require(path.join(RUNTIME, "node_modules/sherpa-onnx-node")).readWave(file);
  return wave;
}

function toInt16At16k(samples, rate, peak = 0.6) {
  const ratio = rate / 16000;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = k * ratio;
    const i = Math.floor(p);
    const f = p - i;
    out[k] = samples[i] * (1 - f) + (samples[Math.min(i + 1, samples.length - 1)] ?? 0) * f;
  }
  let max = 1e-9;
  for (const v of out) max = Math.max(max, Math.abs(v));
  const gain = peak / max;
  const pcm = new Int16Array(n);
  for (let k = 0; k < n; k++) pcm[k] = Math.max(-32768, Math.min(32767, Math.round(out[k] * gain * 32767)));
  return pcm;
}

const quiet = (ms) => {
  const pcm = new Int16Array(Math.round((ms * 16000) / 1000));
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round((Math.random() - 0.5) * 60); // a quiet room, not digital zero
  return pcm;
};
const join = (...parts) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function loadClips(lang, count) {
  if (!CLIPS) return [];
  const dir = path.join(CLIPS, lang);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".wav"))
    .sort()
    .slice(0, count)
    .map((f) => {
      const wave = readWave(path.join(dir, f));
      const ref = (fs.readFileSync(path.join(dir, f.replace(".wav", ".txt")), "utf8").split("\n")[1] ?? "").trim();
      return { id: f, lang, pcm: toInt16At16k(wave.samples, wave.sampleRate), ref };
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// WER

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const pct = (xs, p) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------------------------------------------------------------------------------------------------------------------
// A client that behaves like the browser: speaks into the microphone at the pace of the clock and plays what it is sent

class RealClient {
  constructor(sampleRate) {
    this.messages = [];
    this.audio = [];
    this.rate = sampleRate;
    this.session = null;
    this.queued = 0;
    this.played = 0;
    this.utterance = 0;
    this.lastTick = now();
    this.sinceReport = 0;
    this.timer = setInterval(() => this.tick(), 20);
    this.t0 = now();
  }
  receive = (msg) => {
    this.messages.push({ at: now(), msg });
    if (msg.type === "interrupted") this.queued = this.played;
  };
  receiveAudio = (buf) => {
    const frame = decodeAudioOut(buf);
    if (!frame) return;
    const at = now();
    if (frame.utterance !== this.utterance) {
      this.utterance = frame.utterance;
      this.queued = 0;
      this.played = 0;
    }
    this.queued += frame.pcm.length;
    this.audio.push({ at, utterance: frame.utterance, samples: frame.pcm.length });
  };
  tick() {
    const t = now();
    const dt = (t - this.lastTick) / 1000;
    this.lastTick = t;
    const can = this.queued - this.played;
    if (can > 0) {
      this.played = Math.min(this.queued, this.played + Math.round(dt * this.rate));
      this.sinceReport += dt * 1000;
    }
    if (this.sinceReport >= 100 && this.utterance > 0 && this.session) {
      this.sinceReport = 0;
      this.session.onMessage({ type: "playback", utterance: this.utterance, samples: this.played });
    }
  }
  stop() {
    clearInterval(this.timer);
  }
  of(type) {
    return this.messages.filter((m) => m.msg.type === type);
  }
  /** Sends microphone audio at the pace of the clock; returns when the last frame went out, and the time each sample region went. */
  async mic(pcm) {
    const frame = 512;
    const start = now();
    for (let i = 0, k = 0; i < pcm.length; i += frame, k++) {
      const due = start + k * 32;
      const wait = due - now();
      if (wait > 1) await sleep(wait);
      const slice = pcm.subarray(i, i + frame);
      this.session.onAudio(slice.length === frame ? slice : join(slice, new Int16Array(frame - slice.length)));
    }
    return start;
  }
  async until(predicate, limitMs) {
    const end = now() + limitMs;
    while (now() < end) {
      if (predicate()) return true;
      await sleep(10);
    }
    return predicate();
  }
}

async function openCall(brainScript) {
  const set = createSherpaEngines({ runtimeDir: RUNTIME, modelsDir: MODELS }, { refine: REFINE, ttsSteps: STEPS, log: (l) => console.error("[engine]", l) });
  const client = new RealClient(set.engines.tts.sampleRate);
  const host = new FakeHost();
  host.persona$ = { name: "Vesper", callsUser: null, language: null, tone: null, voice: null };
  const brain = new ScriptedBrain(systemScheduler, brainScript);
  const logs = [];
  const session = new VoiceSession({ engines: set.engines, brain, host, scheduler: systemScheduler, send: client.receive, sendAudio: client.receiveAudio, log: (l) => logs.push(l), id: "bench" });
  client.session = session;
  const t0 = now();
  await session.start({ type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null });
  const startMs = Math.round(now() - t0);
  return { set, client, session, host, brain, logs, startMs, close: async () => { client.stop(); await session.close("bench done"); await set.dispose(); } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Suites

const REPLY_SHORT = "Sure, I can help with that. Give me a second.";
const REPLY_LONG =
  "Of course. Let me walk you through it. First, you open the settings page and look for the section called voice. Then you pick the engine you want, and press the install button, and wait for the download to finish. After that, the call starts by itself.";

async function latencySuite() {
  const trials = [...loadClips("en", N), ...loadClips("pt", N)];
  if (trials.length === 0) throw new Error("no clips: pass --clips");
  const call = await openCall(() => ({ text: REPLY_SHORT, ttftMs: TTFT, pieceMs: 15 }));
  const rows = [];
  let errors = 0, words = 0;
  for (const clip of trials) {
    const before = call.client.messages.length;
    const mic = join(quiet(900), clip.pcm, quiet(5200));
    const clipEndOffset = 900 + (clip.pcm.length / 16000) * 1000; // ms into the mic stream where speech ends
    const t0 = now();
    const lastUtterance = call.client.audio.length ? call.client.audio[call.client.audio.length - 1].utterance : 0;
    const micDone = call.client.mic(mic);
    const gotMetrics = await call.client.until(() => call.client.messages.slice(before).some((m) => m.msg.type === "metrics"), clipEndOffset + 10000);
    await micDone;
    const metrics = call.client.messages.slice(before).find((m) => m.msg.type === "metrics");
    const user = call.client.messages.slice(before).find((m) => m.msg.type === "user");
    const speechEndAt = t0 + clipEndOffset;
    const firstAudio = call.client.audio.find((a) => a.utterance > lastUtterance && a.at >= speechEndAt);
    const heard = user ? user.msg.text : "";
    const e = editDistance(norm(clip.ref).split(" "), norm(heard).split(" ").filter(Boolean));
    errors += e;
    words += norm(clip.ref).split(" ").length;
    rows.push({
      id: clip.id.slice(0, 8),
      lang: clip.lang,
      speechSec: +(clip.pcm.length / 16000).toFixed(1),
      ok: gotMetrics,
      endpointMs: metrics?.msg.metrics.endpointMs ?? null,
      asrMs: metrics?.msg.metrics.asrMs ?? null,
      firstTokenMs: metrics?.msg.metrics.firstTokenMs ?? null,
      firstAudioMs: metrics?.msg.metrics.firstAudioMs ?? null,
      clientFirstAudioMs: firstAudio ? Math.round(firstAudio.at - speechEndAt) : null,
      wer: +(100 * e / norm(clip.ref).split(" ").length).toFixed(0),
      heard: heard.slice(0, 80),
      refined: call.set.asr.lastResult ? { segments: call.set.asr.lastResult.segments, readAhead: call.set.asr.lastResult.readAhead, restMs: call.set.asr.lastResult.refineMs, queueMs: call.set.asr.lastResult.queueMs } : null,
    });
    // let the reply finish before the next one
    await call.client.until(() => call.client.of("state").slice(-1)[0]?.msg.state === "listening" && now() - t0 > clipEndOffset + 1500, 9000);
  }
  await call.close();
  const dist = (key) => {
    const xs = rows.map((r) => r[key]).filter((x) => typeof x === "number");
    return { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), mean: xs.length ? Math.round(mean(xs)) : null };
  };
  return {
    suite: "latency",
    startMs: call.startMs,
    ttftMs: TTFT,
    refine: REFINE,
    ttsSteps: STEPS,
    WER: +(100 * errors / words).toFixed(1),
    endpointMs: dist("endpointMs"),
    asrMs: dist("asrMs"),
    firstTokenMs: dist("firstTokenMs"),
    firstAudioMs: dist("firstAudioMs"),
    clientFirstAudioMs: dist("clientFirstAudioMs"),
    rows,
    logs: call.logs.slice(0, 20),
  };
}

async function bargeSuite() {
  const interruption = loadClips("en", 3);
  if (interruption.length === 0) throw new Error("no clips: pass --clips");
  const call = await openCall(() => ({ text: REPLY_LONG, ttftMs: TTFT, pieceMs: 15 }));
  const rows = [];
  for (const clip of interruption) {
    const before = call.client.messages.length;
    // 1. ask something short, so the assistant starts its long answer
    const opening = clip;
    const mic1 = join(quiet(600), opening.pcm, quiet(2500));
    const done1 = call.client.mic(mic1);
    const t0 = now();
    await call.client.until(() => call.client.audio.length > 0 && call.client.audio[call.client.audio.length - 1].at > t0, 12000);
    await sleep(2200); // the assistant is well into its answer
    // 2. talk over it
    const talkOverAt = now();
    const interjection = interruption[(interruption.indexOf(clip) + 1) % interruption.length];
    const audioBefore = call.client.audio.length;
    const done2 = call.client.mic(join(interjection.pcm, quiet(3000)));
    await call.client.until(() => call.client.of("interrupted").some((m) => m.at > talkOverAt), 6000);
    const interrupted = call.client.of("interrupted").find((m) => m.at > talkOverAt);
    const duck = call.client.of("duck").find((m) => m.at > talkOverAt && m.msg.on);
    const lastAudioAfter = call.client.audio.slice(audioBefore).filter((a) => !interrupted || a.at <= interrupted.at + 50);
    await done2;
    await done1;
    rows.push({
      spoke: opening.id.slice(0, 8),
      talkedOverWith: interjection.id.slice(0, 8),
      duckMs: duck ? Math.round(duck.at - talkOverAt) : null,
      interruptedMs: interrupted ? Math.round(interrupted.at - talkOverAt) : null,
      stoppedSending: lastAudioAfter.length,
      heardOfReply: interrupted ? interrupted.msg.heard.slice(0, 60) : null,
    });
    await call.client.until(() => call.client.of("state").slice(-1)[0]?.msg.state === "listening", 15000);
    void before;
  }
  await call.close();
  return { suite: "barge", rows };
}

async function smokeSuite() {
  const clip = loadClips("en", 1)[0];
  const call = await openCall(() => ({ text: REPLY_SHORT, ttftMs: TTFT, pieceMs: 15 }));
  console.error(`session started in ${call.startMs} ms; engines ${call.set.engines.asr.id} / ${call.set.engines.tts.id}`);
  const t0 = now();
  await call.client.mic(join(quiet(800), clip.pcm, quiet(4000)));
  await call.client.until(() => call.client.of("metrics").length > 0, 8000);
  const out = {
    suite: "smoke",
    ms: Math.round(now() - t0),
    messages: call.client.messages.map((m) => ({ at: Math.round(m.at - t0), type: m.msg.type, ...(m.msg.type === "user" ? { text: m.msg.text } : {}), ...(m.msg.type === "metrics" ? m.msg.metrics : {}), ...(m.msg.type === "state" ? { state: m.msg.state } : {}) })).filter((m) => m.type !== "partial" && m.type !== "level"),
    audioChunks: call.client.audio.length,
    logs: call.logs,
  };
  await call.close();
  return out;
}

const suites = SUITE === "all" ? ["latency", "barge"] : [SUITE];
const results = [];
for (const name of suites) {
  const t = now();
  const result = name === "latency" ? await latencySuite() : name === "barge" ? await bargeSuite() : name === "smoke" ? await smokeSuite() : null;
  if (!result) throw new Error(`unknown suite ${name}`);
  result.wallSec = Math.round((now() - t) / 100) / 10;
  results.push(result);
  console.log(JSON.stringify(result, null, 1));
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
process.exit(0);
