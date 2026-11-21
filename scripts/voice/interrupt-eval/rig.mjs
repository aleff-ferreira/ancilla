// A real VoiceSession (real Silero VAD, real streaming ASR + re-reader, real TTS) driven in REAL TIME by a simulated browser
// page: it plays what the server sends on a speaker timeline (with the device's output latency), flushes on `interrupted`,
// ducks on `duck`, reports playback, and feeds the microphone = user track + a modelled residual of the speaker output.
// All times are milliseconds on one monotonic axis (performance.now() since the episode began); never the WSL wall clock.
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RATE16 = 16000;
export const FRAME = 512;
export const FRAME_MS = 32;

export function loadVoice(root) {
  const v = (p) => require(path.join(root, "packages/server/dist/src/voice", p));
  return {
    engines: v("engines/index.js"),
    session: v("session.js"),
    testing: v("testing.js"),
    protocol: v("protocol.js"),
    turn: v("turn.js"),
    text: v("text.js"),
  };
}

/** The scheduler on a monotonic clock (the system one reads Date.now(), which this WSL distro steps back every ~30 s). */
export function monotonicScheduler() {
  return {
    now: () => performance.now(),
    after: (ms, fn) => {
      const h = setTimeout(fn, Math.max(0, ms));
      h.unref?.();
      return () => clearTimeout(h);
    },
  };
}

// ---------- audio helpers
export const dbfs = (r) => 20 * Math.log10(Math.max(r, 1e-9));
export function rmsOf(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}
export function activeRms(x, rate = RATE16) {
  // RMS over 20 ms windows that are above -50 dBFS: the level of the speech, not of the silences around it
  const w = Math.round(rate * 0.02);
  let s = 0, n = 0;
  for (let at = 0; at + w <= x.length; at += w) {
    let e = 0;
    for (let i = 0; i < w; i++) e += x[at + i] * x[at + i];
    const r = Math.sqrt(e / w);
    if (r > 0.003) { s += e; n += w; }
  }
  return n === 0 ? 0 : Math.sqrt(s / n);
}
export function toFloat32(i16) {
  const o = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) o[i] = i16[i] / 32768;
  return o;
}
export function resampleTo16k(i16, rate) {
  const ratio = rate / RATE16;
  const out = new Float32Array(Math.floor(i16.length / ratio));
  for (let k = 0; k < out.length; k++) {
    const pos = k * ratio, i = Math.floor(pos), f = pos - i;
    out[k] = ((i16[i] ?? 0) * (1 - f) + (i16[Math.min(i + 1, i16.length - 1)] ?? 0) * f) / 32768;
  }
  return out;
}
/** Trims the leading silence of a synthetic utterance to `leadMs` before the first 10 ms window above `thrDb`; returns {pcm, onsetMs}. */
export function trimLead(f32, leadMs = 20, thrDb = -42) {
  const w = 160;
  let first = -1;
  for (let at = 0; at + w <= f32.length; at += w / 2) {
    if (dbfs(rmsOf(f32.subarray(at, at + w))) > thrDb) { first = at; break; }
  }
  if (first < 0) return { pcm: f32, onsetMs: 0 };
  const keepFrom = Math.max(0, first - Math.round(leadMs * 16));
  return { pcm: f32.slice(keepFrom), onsetMs: (first - keepFrom) / 16 };
}
export function setActiveRmsDb(f32, db) {
  const cur = activeRms(f32);
  if (cur === 0) return f32;
  const g = 10 ** (db / 20) / cur;
  const o = new Float32Array(f32.length);
  for (let i = 0; i < o.length; i++) o[i] = Math.max(-1, Math.min(1, f32[i] * g));
  return o;
}

export async function synth(tts, text, voiceId, speed = 1) {
  const parts = [];
  for await (const chunk of tts.synthesize(text, { voice: voiceId, speed, signal: new AbortController().signal })) parts.push(chunk);
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return resampleTo16k(all, tts.sampleRate);
}

// ---------- one episode
/**
 * opts: { v (loadVoice), engines (the real set), userTrack: Float32Array (16 kHz; onset at userOnsetMs inside it) | null,
 *         replyText, prompt, userAfterFirstAudioMs, echoDb (null = none), echoDelayMs, outLatMs, leadMs, tailMs, brainScript?,
 *         sessionConfig?, hello? }
 */
export async function runEpisode(opts) {
  const { v, engines } = opts;
  const sched = monotonicScheduler();
  const t0 = performance.now();
  const T = () => performance.now() - t0;
  const outLat = opts.outLatMs ?? 25;
  const lead = opts.leadMs ?? 40;
  const echoDelay = opts.echoDelayMs ?? 15;
  const maxSamples = RATE16 * 60;
  const handoff = new Float32Array(maxSamples);
  const handoffUtt = new Uint16Array(maxSamples);
  const events = [];
  const flights = [];
  const logs = [];
  // page state
  let rate = 44100;
  const queue = []; // {f32, i, utt, notBefore}
  let queueIdle = true;
  let gain = 1, gainTarget = 1;
  let rendered = 0; // handoff samples rendered (16 kHz)
  let consumedByUtt = new Map(); // utt -> 16k samples handed to the device
  let currentUtt = 0;
  let firstAudioAt = null;
  let interruptedAt = null;
  const duckLog = [];

  let paused = false;
  let pauseLeaseUntil = 0;
  const renderUntil = (tMs) => {
    const end = Math.min(maxSamples, Math.floor((tMs * RATE16) / 1000));
    for (; rendered < end; rendered++) {
      const tau = (rendered * 1000) / RATE16;
      gain += (gainTarget - gain) * (1 - Math.exp(-1000 / RATE16 / 40));
      if (paused && tau >= pauseLeaseUntil) {
        paused = false; // the lease ran out: the page brings the voice back by itself
        duckLog.push({ t: tau, paused: false, why: "lease" });
      }
      const head = paused ? undefined : queue[0];
      if (head && tau >= head.notBefore) {
        handoff[rendered] = head.f32[head.i++] * gain;
        handoffUtt[rendered] = head.utt;
        consumedByUtt.set(head.utt, (consumedByUtt.get(head.utt) ?? 0) + 1);
        if (head.i >= head.f32.length) queue.shift();
      } else {
        handoff[rendered] = 0;
      }
    }
  };
  const onServer = (msg) => {
    const t = T();
    renderUntil(t);
    events.push({ t, msg });
    if (msg.type === "ready") rate = msg.sampleRate;
    if (msg.type === "interrupted") {
      interruptedAt = interruptedAt ?? t;
      queue.length = 0;
      gain = 1; gainTarget = 1;
      paused = false;
      duckLog.push({ t, on: false, paused: false, why: "flush" });
    }
    if (msg.type === "pause") {
      if (!paused) duckLog.push({ t, paused: true });
      paused = true;
      pauseLeaseUntil = t + msg.leaseMs;
      const utt = currentUtt;
      const played = Math.max(0, Math.round(((((consumedByUtt.get(utt) ?? 0) - (outLat * RATE16) / 1000)) * rate) / RATE16));
      setTimeout(() => { if (utt > 0) session.onMessage({ type: "playback", utterance: utt, samples: played }); }, 3);
    }
    if (msg.type === "resume") {
      if (paused) duckLog.push({ t, paused: false, why: msg.drop ? "drop" : "resume" });
      paused = false;
      if (msg.drop) {
        // what was held is thrown away: the reply it belonged to is over. It is a cut for the person all the same.
        if (queue.length > 0) interruptedAt = interruptedAt ?? t;
        queue.length = 0; gain = 1; gainTarget = 1;
      }
    }
    if (msg.type === "duck") {
      gainTarget = msg.on ? 0.2 : 1;
      duckLog.push({ t, on: msg.on });
    }
  };
  const onAudio = (buf) => {
    const t = T();
    renderUntil(t);
    const f = v.protocol.decodeAudioOut(buf);
    if (!f) return;
    currentUtt = f.utterance;
    const f32 = resampleTo16k(f.pcm, rate);
    if (firstAudioAt === null) firstAudioAt = t;
    const was = queue.length === 0;
    queue.push({ f32, i: 0, utt: f.utterance, notBefore: was ? t + lead : 0 });
  };

  const brain = opts.brain
    ? opts.brain(sched)
    : new v.testing.ScriptedBrain(
        sched,
        opts.brainScript ?? ((messages, call) => (call === 1 ? { text: opts.replyText, ttftMs: 150 } : { text: opts.afterText ?? "Okay.", ttftMs: 150 })),
        { tools: true, speculative: true, local: true },
      );
  const host = new v.testing.FakeHost();
  host.toolList = [{ name: "delegate_task", description: "Start a task in the background.", parameters: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] } }];
  const toolLog = [];
  const baseRun = host.runTool.bind(host);
  host.runTool = async (call, ctx) => {
    toolLog.push({ t: T(), call });
    return baseRun(call, ctx);
  };
  const session = new v.session.VoiceSession({
    engines,
    brain,
    host,
    scheduler: sched,
    send: onServer,
    sendAudio: onAudio,
    log: (l) => logs.push({ t: T(), l }),
    flight: (line) => flights.push({ t: T(), line }),
    id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    config: opts.sessionConfig,
  });
  await session.start({ type: "hello", v: 1, mode: "hands-free", lang: opts.lang ?? null, echoCancelled: opts.echoCancelled ?? true, resume: null, thread: null, ...(opts.pause ? { pause: true } : {}) });

  const user = opts.userTrack; // Float32Array | null
  let userStartSample = null;
  let k = 0;
  const total = opts.maxMs ? Math.floor(opts.maxMs / FRAME_MS) : 400;
  const noiseAmp = 10 ** (-72 / 20);
  const speakerAt = (i) => {
    const j = i - Math.round((outLat * RATE16) / 1000);
    return j >= 0 && j < rendered ? handoff[j] : 0;
  };
  let promptSent = false;
  let lastReport = 0;
  const mic16 = new Float32Array(maxSamples);
  const start = performance.now();
  let endedAt = null;
  for (k = 0; k < total; k++) {
    const frameStart = k * FRAME;
    const due = start + (k + 1) * FRAME_MS;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    const now = T();
    renderUntil(now);
    if (!promptSent && now >= 300) {
      promptSent = true;
      if (opts.prompt !== null) session.onMessage({ type: "text", text: opts.prompt ?? "Tell me about the weather." });
    }
    if (opts.userStartAtMs !== undefined && user && userStartSample === null && now >= opts.userStartAtMs) {
      userStartSample = frameStart;
      events.push({ t: now, msg: { type: "user_track_start", sample: userStartSample } });
    }
    // The person starts while the voice is audible and has more queued ahead of it: a gap between two sentences is not the test.
    const audibleNow = () => {
      if (opts.startWhenAudible === false) return true;
      let e = 0;
      for (let i = Math.max(0, rendered - 1920); i < rendered; i++) e = Math.max(e, Math.abs(handoff[i]));
      let ahead = 0;
      for (const q of queue) ahead += q.f32.length - q.i;
      return e >= 0.01 && ahead >= 4800;
    };
    if (opts.userStartAtMs === undefined && user && userStartSample === null && firstAudioAt !== null && now - firstAudioAt >= (opts.userAfterFirstAudioMs ?? 3000) && (audibleNow() || now - firstAudioAt >= (opts.userAfterFirstAudioMs ?? 3000) + 2500)) {
      userStartSample = frameStart;
      events.push({ t: now, msg: { type: "user_track_start", sample: userStartSample } });
    }
    const frame = new Int16Array(FRAME);
    const g = opts.echoDb === null || opts.echoDb === undefined ? 0 : 10 ** (opts.echoDb / 20);
    for (let n = 0; n < FRAME; n++) {
      const i = frameStart + n;
      let x = (Math.random() - 0.5) * 2 * noiseAmp;
      if (g > 0) x += g * speakerAt(i - Math.round((echoDelay * RATE16) / 1000));
      if (user && userStartSample !== null) {
        const u = i - userStartSample;
        if (u >= 0 && u < user.length) x += user[u];
      }
      if (opts.promptTrack) {
        const u = i - Math.round(0.3 * RATE16);
        if (u >= 0 && u < opts.promptTrack.length) x += opts.promptTrack[u];
      }
      mic16[i] = x;
      frame[n] = Math.max(-32768, Math.min(32767, Math.round(x * 32768)));
    }
    session.onAudio(frame);
    if (now - lastReport >= 100 && currentUtt > 0) {
      lastReport = now;
      const consumed = consumedByUtt.get(currentUtt) ?? 0;
      const playedNative = Math.max(0, Math.round(((consumed - (outLat * RATE16) / 1000) * rate) / RATE16));
      session.onMessage({ type: "playback", utterance: currentUtt, samples: playedNative });
    }
    if (opts.until && opts.until({ events, now, interruptedAt, firstAudioAt })) { endedAt = now; break; }
  }
  const endMs = T();
  renderUntil(endMs);
  await session.close("episode over");
  const speaker = new Float32Array(rendered);
  const shift = Math.round((outLat * RATE16) / 1000);
  for (let i = 0; i < rendered; i++) speaker[i] = i - shift >= 0 ? handoff[i - shift] : 0;
  const speakerUtt = new Uint16Array(rendered);
  for (let i = 0; i < rendered; i++) speakerUtt[i] = i - shift >= 0 ? handoffUtt[i - shift] : 0;
  return {
    events, flights, logs, speaker, speakerUtt, duckLog, firstAudioAt, interruptedAt, endMs,
    userStartMs: userStartSample === null ? null : (userStartSample * 1000) / RATE16,
    history: session.snapshot().history,
    brainRequests: brain.requests ? brain.requests.length : null,
    toolLog,
    records: host.records,
  };
}

/** Whether the speaker played anything above thrDb from utterance `utt` between `fromMs` and `toMs`. */
export function audibleBetween(speaker, speakerUtt, utt, fromMs, toMs, thrDb = -54) {
  const thr = 10 ** (thrDb / 20);
  const a = Math.max(0, Math.floor((fromMs * RATE16) / 1000));
  const b = Math.min(speaker.length, Math.floor((toMs * RATE16) / 1000));
  for (let i = a; i < b; i++) if (Math.abs(speaker[i]) >= thr && speakerUtt[i] === utt) return true;
  return false;
}

/** Last time (ms) the speaker played anything above thrDb from utterance `utt` (or any, when utt is null); -1 when never. */
export function lastAudibleMs(speaker, speakerUtt, utt, thrDb = -54) {
  const thr = 10 ** (thrDb / 20);
  const w = 80; // 5 ms
  for (let at = speaker.length - w; at >= 0; at -= w) {
    let e = 0;
    for (let i = 0; i < w; i++) e = Math.max(e, Math.abs(speaker[at + i]));
    if (e >= thr && (utt === null || speakerUtt[at + w - 1] === utt || speakerUtt[at] === utt)) return ((at + w) * 1000) / RATE16;
  }
  return -1;
}
