#!/usr/bin/env node
// Echo probe analysis. Runs in WSL with Node 22 (see analyze.sh):  node analyze.mjs <recordings-dir> [--no-engines] [--selftest]
// Reads what driver.mjs wrote (per run: <id>-A.wav processed mic, <id>-B.wav raw mic, <id>-ref.wav what the page played, all
// 16 kHz mono on ONE sample grid, plus <id>.json with the audio-clock and wall-clock stamps) and writes results.json and
// summary.md next to them. Never uses the WSL wall clock (it is stepped every ~30 s): time here is sample counts on the page's
// audio clock, related to the Windows clock only through the stamps the driver recorded.
//
// Levels are dBFS of 16-bit samples. "Plain" level numbers are RMS over the stated windows. Because a room is never silent,
// echo power is ALSO estimated by magnitude-squared coherence with the reference (the part of the microphone that is linearly
// related to what was played), which is blind to uncorrelated room sound; the estimator's own floor is measured with a
// deliberately wrong lag. Words are found with a matched filter against the exact clip that was played.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RATE = 16000;
const FRAME = 512;
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const dir = path.resolve(argv.find((a) => !a.startsWith("--")) ?? process.env.ECHO_PROBE_OUT ?? ".");

// ---------- numerics
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
/** c(tau) = sum_n x[n + tau] * y[n], for any integer tau with -(ly-1) <= tau <= lx-1. */
function xcorr(x, y) {
  let n = 1;
  while (n < x.length + y.length) n <<= 1;
  const xr = new Float64Array(n), xi = new Float64Array(n), yr = new Float64Array(n), yi = new Float64Array(n);
  xr.set(x); yr.set(y);
  fft(xr, xi); fft(yr, yi);
  for (let k = 0; k < n; k++) { const a = xr[k], b = xi[k], c = yr[k], d = -yi[k]; xr[k] = a * c - b * d; xi[k] = a * d + b * c; }
  fft(xr, xi, true);
  return (tau) => xr[(tau + n) % n];
}
const db10 = (p) => 10 * Math.log10(Math.max(p, 1e-14));
const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const std = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
function quantile(arr, q) {
  const s = Array.from(arr).filter(Number.isFinite).sort((p, r) => p - r);
  if (!s.length) return null;
  const pos = (s.length - 1) * q, lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}
function meanSq(x, a, b) {
  a = Math.max(0, Math.round(a)); b = Math.min(x.length, Math.round(b));
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return b > a ? s / (b - a) : 0;
}
const lvl = (x, a, b) => db10(meanSq(x, a, b));
function readWav(file) {
  const b = fs.readFileSync(file);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === "data") {
      const n = Math.min(size, b.length - at - 8) >> 1, x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(at + 8 + 2 * i) / 32768;
      return x;
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}
function parabolic(y0, y1, y2) {
  const d = y0 - 2 * y1 + y2;
  return d === 0 ? 0 : (0.5 * (y0 - y2)) / d;
}
/** First-order pre-emphasis (whitens the speech tilt) of x[a..b). */
function pre(x, a, b) {
  const o = new Float64Array(Math.max(0, b - a));
  for (let i = a; i < b; i++) o[i - a] = x[i] - 0.95 * (i > 0 ? x[i - 1] : 0);
  return o;
}

// ---------- delay and echo power
/** Lag (samples) of the echo of R inside X: the peak of the pre-emphasised cross-correlation over the playing interval. */
function estimateLag(R, X, i0, n, maxLag = 9600) {
  const r = pre(R, i0, Math.min(R.length, i0 + n)), x = pre(X, i0, Math.min(X.length, i0 + n + maxLag));
  const c = xcorr(x, r);
  let er = 0, ex = 0;
  for (const v of r) er += v * v;
  for (const v of x) ex += v * v;
  const norm = Math.sqrt(er * ex) + 1e-20;
  const vals = new Float64Array(maxLag + 1);
  let k = 0;
  for (let t = 0; t <= maxLag; t++) { vals[t] = Math.abs(c(t)) / norm; if (vals[t] > vals[k]) k = t; }
  const rest = [];
  for (let t = 0; t <= maxLag; t++) if (Math.abs(t - k) > 80) rest.push(vals[t]);
  const m = mean(rest), s = std(rest);
  const frac = k > 0 && k < maxLag ? parabolic(vals[k - 1], vals[k], vals[k + 1]) : 0;
  return { lag: k + frac, rho: vals[k], z: (vals[k] - m) / (s || 1e-12) };
}
/**
 * Power (linear, full-scale^2) of X in a band, total and coherent with R, from Welch segments with the lag removed.
 * `specs` is a list of {R, X, i0, n} (several runs that played the same reply can be pooled for a lower estimator floor).
 */
function coherent(specs, lag, N = 2048, band = [100, 7500]) {
  const hop = N / 2, w = new Float64Array(N);
  let wss = 0;
  for (let i = 0; i < N; i++) { w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N); wss += w[i] * w[i]; }
  const H = N / 2 + 1;
  const Srr = new Float64Array(H), Sxx = new Float64Array(H), Sre = new Float64Array(H), Sim = new Float64Array(H);
  const rr = new Float64Array(N), ri = new Float64Array(N), xr = new Float64Array(N), xi = new Float64Array(N);
  let K = 0;
  for (const { R, X, i0, n } of specs) {
    for (let t = i0; t + N <= i0 + n && t + lag + N <= X.length; t += hop) {
      for (let i = 0; i < N; i++) { rr[i] = R[t + i] * w[i]; ri[i] = 0; xr[i] = X[t + lag + i] * w[i]; xi[i] = 0; }
      fft(rr, ri); fft(xr, xi);
      for (let k = 0; k < H; k++) {
        Srr[k] += rr[k] * rr[k] + ri[k] * ri[k];
        Sxx[k] += xr[k] * xr[k] + xi[k] * xi[k];
        Sre[k] += xr[k] * rr[k] + xi[k] * ri[k];
        Sim[k] += xi[k] * rr[k] - xr[k] * ri[k];
      }
      K++;
    }
  }
  if (K < 8) return null;
  const k1 = Math.ceil((band[0] / RATE) * N), k2 = Math.floor((band[1] / RATE) * N), Keff = K / 1.056;
  let Pr = 0, Px = 0, Pc = 0;
  for (let k = k1; k <= k2; k++) {
    const srr = Srr[k] / K, sxx = Sxx[k] / K, re = Sre[k] / K, im = Sim[k] / K;
    const g2 = (re * re + im * im) / (srr * sxx + 1e-30);
    Pr += srr; Px += sxx; Pc += Math.max(0, (Keff * g2 - 1) / (Keff - 1)) * sxx;
  }
  const scale = 2 / (N * wss);
  return { K, Pr: Pr * scale, Px: Px * scale, Pc: Pc * scale };
}
/** Coherent power at the true lag and at lags that cannot hold an echo (the estimator's own floor). */
function echoPower(specs, lag) {
  const real = coherent(specs, Math.round(lag));
  if (!real) return null;
  const nulls = [48000, 72000, 96000].map((s) => coherent(specs, Math.round(lag) + s)).filter(Boolean).map((v) => v.Pc);
  const floor = nulls.length ? quantile(nulls, 0.5) : null;
  return { refDbfs: db10(real.Pr), micTotalDbfs: db10(real.Px), echoDbfs: db10(real.Pc), floorDbfs: floor === null ? null : db10(floor), segments: real.K, detected: floor !== null && real.Pc > 2 * floor };
}

// ---------- matched filter: where, and how strongly, a known clip is inside a stream
function matchedFilter(x, t, lo, hi) {
  const L = t.length;
  const a = Math.max(0, Math.floor(lo)), b = Math.min(x.length - L, Math.ceil(hi));
  if (b <= a) return null;
  const seg = x.subarray(a, b + L), cc = xcorr(seg, t);
  const cs = new Float64Array(seg.length + 1);
  for (let i = 0; i < seg.length; i++) cs[i + 1] = cs[i] + seg[i] * seg[i];
  let Et = 0;
  for (const v of t) Et += v * v;
  const rho = new Float64Array(b - a + 1);
  let k = 0;
  for (let i = 0; i <= b - a; i++) { rho[i] = cc(i) / Math.sqrt((cs[i + L] - cs[i]) * Et + 1e-20); if (Math.abs(rho[i]) > Math.abs(rho[k])) k = i; }
  const rest = [];
  for (let i = 0; i <= b - a; i++) if (Math.abs(i - k) > 800) rest.push(Math.abs(rho[i]));
  const m = mean(rest), s = std(rest);
  const frac = k > 0 && k < b - a ? parabolic(Math.abs(rho[k - 1]), Math.abs(rho[k]), Math.abs(rho[k + 1])) : 0;
  return { tau: a + k + frac, idx: a + k, rho: rho[k], z: (Math.abs(rho[k]) - m) / (s || 1e-12), alpha: cc(k) / Et };
}

// ---------- engines (the shipped VAD and recogniser)
async function loadEngines() {
  if (flags.has("--no-engines")) return null;
  try {
    const require = createRequire(import.meta.url);
    const root = process.env.WT ?? path.resolve(here, "../../..");
    const mod = require(path.join(root, "packages/server/dist/src/voice/engines/index.js"));
    const set = mod.createSherpaEngines({ runtimeDir: process.env.VOICE_RUNTIME_DIR ?? path.join(os.homedir(), "voice-lab"), modelsDir: process.env.VOICE_MODELS_DIR ?? path.join(process.env.VOICE_RUNTIME_DIR ?? path.join(os.homedir(), "voice-lab"), "models") }, { refine: false, log: () => undefined });
    await set.engines.asr.warm?.();
    return set;
  } catch (e) {
    console.error("engines unavailable:", e?.message ?? e);
    return null;
  }
}
async function vadTrace(set, x) {
  set.engines.vad.reset();
  const out = new Float32Array(Math.floor(x.length / FRAME));
  for (let f = 0; f < out.length; f++) out[f] = await set.engines.vad.process(x.subarray(f * FRAME, f * FRAME + FRAME));
  return out;
}
async function asrText(set, x, lang) {
  const stream = await set.engines.asr.open(lang);
  for (let f = 0; f + FRAME <= x.length; f += FRAME) await stream.accept(x.subarray(f, f + FRAME));
  const out = await stream.finish();
  stream.dispose();
  return out.text;
}
const grade = (p) => (p >= 0.8 ? "sure" : p >= 0.6 ? "probable" : p >= 0.4 ? "soft" : "quiet");
function vadStats(probs, from, to) {
  const f0 = Math.max(0, Math.ceil(from / FRAME)), f1 = Math.min(probs.length, Math.floor(to / FRAME));
  const hist = { quiet: 0, soft: 0, probable: 0, sure: 0 };
  let run = 0, longest = 0;
  for (let f = f0; f < f1; f++) {
    hist[grade(probs[f])]++;
    if (probs[f] >= 0.6) { run++; longest = Math.max(longest, run); } else run = 0;
  }
  const frames = Math.max(0, f1 - f0), hit = hist.probable + hist.sure;
  return { frames, hist, probableOrSureFraction: frames ? round(hit / frames, 3) : null, longestRunFrames: longest, longestRunMs: longest * 32 };
}
function wordRecall(script, text, playedFraction) {
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const S = norm(script).slice(0, Math.max(1, Math.round(norm(script).length * playedFraction))), T = norm(text), have = new Set(T);
  return { playedScriptWords: S.length, recognizedWords: T.length, scriptWordsFound: S.filter((w) => have.has(w)).length };
}
const SCRIPT = {
  en: "Sure. Tomorrow in Lisbon the weather will be mostly sunny, with a light breeze from the north and a high of twenty two degrees. In the evening it cools down, so bring a jacket if you plan to eat outside. On Thursday clouds roll in from the coast, and there is a small chance of rain in the late afternoon. Friday looks bright again, with temperatures climbing back to twenty four degrees by lunchtime. If you are planning a long walk, the best hours are between ten in the morning and four in the afternoon.",
  pt: "Claro. Amanhã em Lisboa o tempo vai estar quase todo ensolarado, com uma brisa leve do norte e máxima de vinte e dois graus. À noite esfria, então leve um casaco se for jantar ao ar livre. Na quinta-feira entram nuvens vindas da costa, e há uma pequena chance de chuva no fim da tarde. A sexta-feira volta a ficar clara, com temperaturas subindo para vinte e quatro graus na hora do almoço. Se você pretende fazer uma caminhada longa, os melhores horários são entre dez da manhã e quatro da tarde.",
};

// ---------- one run, loaded
function loadRun(id) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  const ex = meta.export;
  const wav = (s) => readWav(path.join(dir, `${id}-${s}.wav`));
  const run = { id, meta, ex, A: wav("A"), B: wav("B"), R: wav("ref") };
  const d = [];
  for (const tag of ["A", "B"]) for (const [, cf, arr] of ex.frames[tag]) d.push(arr - (1000 * cf) / ex.sr);
  run.dMed = quantile(d, 0.5);
  run.dSpreadMs = quantile(d, 0.9) - quantile(d, 0.1);
  run.ctxToIdx = (c) => (c * ex.sr - ex.segStartCf) / ex.ratio;
  run.perfToIdx = (p) => run.ctxToIdx((p - run.dMed) / 1000);
  run.idxToPerf = (i) => run.dMed + (1000 * ((i * ex.ratio + ex.segStartCf) / ex.sr));
  run.syncOffset = (meta.sync.before.offset + meta.sync.after.offset) / 2;
  return run;
}
function ambientOf(run, i0) {
  const end = Math.max(1600, Math.min(i0 ?? run.A.length, Math.round(1.3 * RATE)) - 1600);
  return { A: round(lvl(run.A, 0, end)), B: round(lvl(run.B, 0, end)), seconds: round(end / RATE, 2) };
}

/** ERL and ERLE from the coherent powers of the raw stream (echo) and the processed stream (residue). */
function coherentSummary(echoB, echoA) {
  return {
    refDbfs: round(echoB.refDbfs, 1), rawEchoDbfs: round(echoB.echoDbfs, 1), rawEchoFloorDbfs: round(echoB.floorDbfs, 1), rawEchoDetected: echoB.detected,
    ERL_dB: round(echoB.refDbfs - echoB.echoDbfs, 1), ERL_lowerBound_dB: round(echoB.refDbfs - (echoB.floorDbfs ?? -140), 1),
    procResidueDbfs: round(echoA.echoDbfs, 1), procResidueFloorDbfs: round(echoA.floorDbfs, 1), procResidueDetected: echoA.detected,
    residueRelativeToRef_dB: round(echoA.echoDbfs - echoB.refDbfs, 1),
    ERLE_dB: round(echoB.echoDbfs - echoA.echoDbfs, 1), ERLE_lowerBound_dB: round(echoB.echoDbfs - (echoA.detected ? echoA.echoDbfs : Math.max(echoA.floorDbfs ?? -140, echoA.echoDbfs)), 1),
    segments: echoB.segments,
  };
}

// ---------- a reply played alone (the echo conditions)
async function analyzeReply(run, set, lagFallback) {
  const { ex, A, B, R, meta } = run;
  const play = ex.plays.find((p) => p.kind === "reply");
  const i0 = Math.round(run.ctxToIdx(play.when)), n = Math.round(play.durSec * RATE);
  let first = -1;
  for (let i = 0; i + 320 <= R.length; i += 160) if (meanSq(R, i, i + 320) > 9e-6) { first = i; break; }
  const lagB = estimateLag(R, B, i0, n), lagA = estimateLag(R, A, i0, n);
  const lag = lagB.z > 8 ? lagB.lag : lagFallback;
  const L = Math.round(lag);
  // plain levels on 20 ms windows where the reference is active, with the microphone windows moved by the lag
  const acc = (from, to) => {
    let pr = 0, pb = 0, pa = 0, c = 0;
    for (let i = from; i + 320 <= to; i += 320) {
      const p = meanSq(R, i, i + 320);
      if (p > 9e-6) { pr += p; pb += meanSq(B, i + L, i + L + 320); pa += meanSq(A, i + L, i + L + 320); c++; }
    }
    return c ? { activeMs: c * 20, ref: db10(pr / c), raw: db10(pb / c), proc: db10(pa / c), ERL: db10(pr / pb), ERLE: db10(pb / pa), pb: pb / c } : { activeMs: 0 };
  };
  const perSecond = [];
  for (let s = 0; s < Math.floor(play.durSec); s++) {
    const r = acc(i0 + s * RATE, i0 + (s + 1) * RATE);
    perSecond.push({ s, activeMs: r.activeMs, refDbfs: round(r.ref, 1), rawDbfs: round(r.raw, 1), procDbfs: round(r.proc, 1), ERL_plain_dB: round(r.ERL, 1), ERLE_plain_dB: round(r.ERLE, 1) });
  }
  const all = acc(i0, i0 + n), steady = acc(i0 + 3 * RATE, i0 + n);
  const ambPre = ambientOf(run, i0);
  const tailFrom = i0 + n + L + 8000;
  const tail = tailFrom + 16000 < A.length ? { A: round(lvl(A, tailFrom, A.length)), B: round(lvl(B, tailFrom, A.length)), seconds: round((A.length - tailFrom) / RATE, 2) } : null;
  const echoB = echoPower([{ R, X: B, i0, n }], lag), echoA = echoPower([{ R, X: A, i0, n }], lag);
  const out = {
    kind: "reply", lang: meta.item.lang, replySeconds: play.durSec, startCheckMs: first < 0 ? null : round((first - i0) / 16, 1),
    delay: { rawEchoMs: round(lagB.lag / 16, 2), rawEchoPeakRho: round(lagB.rho, 4), rawEchoZ: round(lagB.z, 1), procResidueMs: round(lagA.lag / 16, 2), procResidueZ: round(lagA.z, 1), usedMs: round(lag / 16, 2) },
    plain: { all: roundObj(all), after3s: roundObj(steady) },
    perSecond,
    coherent: echoB && echoA ? coherentSummary(echoB, echoA) : null,
    ambient: { preRoll: ambPre, afterReply: tail },
    noiseFloorWhileReferenceSilent: { procDbfs: ambPre.A, rawDbfs: ambPre.B, note: "ambient sound at the microphone (a room is never silent), not electrical noise" },
    i0, lagSamples: L,
  };
  if (set) {
    const vA = await vadTrace(set, A), vB = await vadTrace(set, B);
    run.vad = { A: vA, B: vB };
    const lang = meta.item.lang, played = play.durSec / (ex.assetSeconds ?? (lang === "en" ? 36 : 42));
    out.vad = {
      referenceActive: { A: vadStats(vA, i0 + L, i0 + n + L), B: vadStats(vB, i0 + L, i0 + n + L) },
      referenceActiveAfter3s: { A: vadStats(vA, i0 + L + 3 * RATE, i0 + n + L), B: vadStats(vB, i0 + L + 3 * RATE, i0 + n + L) },
      preRollNoReference: { A: vadStats(vA, 0, Math.max(0, i0 - 1600)), B: vadStats(vB, 0, Math.max(0, i0 - 1600)) },
    };
    const tA = await asrText(set, A.subarray(0, Math.min(A.length, i0 + n + L + 16000)), lang), tB = await asrText(set, B.subarray(0, Math.min(B.length, i0 + n + L + 16000)), lang);
    out.asr = { A: { text: tA, ...wordRecall(SCRIPT[lang], tA, played) }, B: { text: tB, ...wordRecall(SCRIPT[lang], tB, played) }, script: lang };
  }
  return out;
}
function roundObj(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = typeof v === "number" ? round(v, 2) : v; delete r.pb; return r; }

// ---------- ambient-only runs
async function analyzeSilence(run, set) {
  const { A, B } = run;
  const wins = (x) => { const l = []; for (let i = 0; i + 320 <= x.length; i += 320) l.push(lvl(x, i, i + 320)); return l; };
  const out = { kind: "silence", seconds: round(A.length / RATE, 1), rawDbfs: round(lvl(B, 0, B.length)), procDbfs: round(lvl(A, 0, A.length)), rawWindowMedianDbfs: round(quantile(wins(B), 0.5)), procWindowMedianDbfs: round(quantile(wins(A), 0.5)), rawWindowP10P90: [round(quantile(wins(B), 0.1)), round(quantile(wins(B), 0.9))], procWindowP10P90: [round(quantile(wins(A), 0.1)), round(quantile(wins(A), 0.9))] };
  if (set) {
    const vA = await vadTrace(set, A), vB = await vadTrace(set, B);
    run.vad = { A: vA, B: vB };
    out.vad = { A: vadStats(vA, 0, A.length), B: vadStats(vB, 0, B.length) };
    out.asr = { A: { chars: (await asrText(set, A, "en")).length }, B: { chars: (await asrText(set, B, "en")).length }, note: "English recogniser; text not kept (the room is private)" };
  }
  return out;
}

// ---------- the click train: round trip of output -> speaker -> air -> microphone -> worklet
function analyzeClicks(run) {
  const { ex, A, B, R } = run;
  const play = ex.plays.find((p) => p.kind === "clicks");
  const res = { kind: "clicks", clicks: play.times.length, B: [], A: [] };
  for (const [tag, x] of [["B", B], ["A", A]]) {
    const delays = [], detail = [];
    for (const c of play.times) {
      const idx = run.ctxToIdx(c), s0 = Math.round(idx) - 40;
      const t = R.slice(s0, s0 + 200);
      const m = matchedFilter(x, t, s0 - 160, s0 + 6400);
      const ok = m && m.z > 7;
      detail.push({ ctx: round(c, 4), delayMs: ok ? round((m.tau - s0) / 16, 3) : null, z: round(m?.z, 1), rho: round(m?.rho, 3) });
      if (ok) delays.push((m.tau - s0) / 16);
    }
    res[tag] = { found: delays.length, meanMs: round(mean(delays), 3), stdMs: round(std(delays), 3), minMs: round(Math.min(...delays), 3), maxMs: round(Math.max(...delays), 3), perClick: detail };
  }
  res.outputLatencyReportedMs = round(1000 * (play.outLat ?? NaN), 1);
  return res;
}

// ---------- word events (solo and over a reply)
function clipInfo(file) {
  const t = readWav(file);
  let s = -1, e = -1;
  for (let i = 0; i + 320 <= t.length; i += 160) if (meanSq(t, i, i + 320) > 3e-5) { if (s < 0) s = i; e = i + 320; }
  return { t, speechStart: s, speechEnd: e, speechMs: round((e - s) / 16, 0) };
}
function ruleOnset(x, arr, iCall, perfCall, matchedStartIdx) {
  const f0 = Math.max(21, Math.floor(iCall / FRAME)), lev = [];
  for (let f = 0; f < Math.floor(x.length / FRAME); f++) lev.push(lvl(x, f * FRAME, (f + 1) * FRAME));
  const floor = Math.max(-90, quantile(lev.slice(f0 - 20, f0), 0.5));
  for (let f = f0; f < Math.min(lev.length, f0 + 60); f++) {
    if (lev[f] >= floor + 10) {
      const startMs = (f * FRAME - iCall) / 16;
      const valid = matchedStartIdx === null || Math.abs(f * FRAME + 512 - matchedStartIdx) < 2400; // within 150 ms of the matched word onset
      return { floorDbfs: round(floor, 1), frame: f, frameStartMs: round(startMs, 1), arrivalMs: arr[f] ? round(arr[f][2] - perfCall, 1) : null, levelDbfs: round(lev[f], 1), plausible: valid };
    }
  }
  return { floorDbfs: round(floor, 1), frame: null };
}
function streamEnergy(x) {
  const cs = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + x[i] * x[i];
  return cs;
}
/** Normalised cross-correlation of the clip against every clip-start position of x. */
function rhoCurve(x, cs, t, Et) {
  const L = t.length, n = x.length - L + 1, cc = xcorr(x, t), rho = new Float32Array(Math.max(0, n));
  for (let k = 0; k < n; k++) rho[k] = cc(k) / Math.sqrt((cs[k + L] - cs[k]) * Et + 1e-20);
  return rho;
}
function peakIn(rho, lo, hi) {
  lo = Math.max(0, Math.floor(lo)); hi = Math.min(rho.length - 1, Math.ceil(hi));
  let k = lo;
  for (let i = lo; i <= hi; i++) if (Math.abs(rho[i]) > Math.abs(rho[k])) k = i;
  return k;
}
/** The statistic "largest |rho| inside a window" over windows that cannot hold a word: the empirical null. */
function nullMaxima(rho, winLen, excl) {
  const out = [];
  for (let t0 = 0; t0 + winLen < rho.length; t0 += 800) {
    if (excl.some(([a, b]) => t0 < b && t0 + winLen > a)) continue;
    let m = 0;
    for (let i = t0; i < t0 + winLen; i++) { const v = Math.abs(rho[i]); if (v > m) m = v; }
    out.push(m);
  }
  return out;
}
/**
 * Finds each clip in A and in B. The clip is searched only in a window of plausible delays after the call; a word counts as
 * found when its peak correlation beats (p <= 0.02) the same peak statistic measured over windows of this run that hold no
 * word. A z-score would be wrong here: a room with speech in it correlates with a speech clip far more than noise does.
 * The solo run narrows the window around its own confident detections and hands it to the runs with a reply.
 */
function analyzeEvents(run, clipDir, prior) {
  const { ex, A, B, meta } = run;
  const reply = ex.plays.find((p) => p.kind === "reply");
  const evs = meta.events.map((ev) => {
    const perfCall = ev.hrCallBeforePlay - run.syncOffset;
    const clip = clipInfo(path.join(clipDir, ev.clipFile));
    let Et = 0;
    for (const v of clip.t) Et += v * v;
    return { ev, perfCall, iCall: run.perfToIdx(perfCall), clip, Et };
  });
  const cs = { A: streamEnergy(A), B: streamEnergy(B) }, X = { A, B };
  const curves = evs.map((e) => ({ A: rhoCurve(A, cs.A, e.clip.t, e.Et), B: rhoCurve(B, cs.B, e.clip.t, e.Et) }));
  const detect = (win, tag, i) => {
    const e = evs[i], rho = curves[i][tag];
    const lo = e.iCall + win.loMs * 16, hi = e.iCall + win.hiMs * 16;
    const nm = nullMaxima(rho, Math.round(hi - lo), evs.map((o) => [o.iCall + win.loMs * 16 - 8000, o.iCall + win.hiMs * 16 + 8000]));
    const k = peakIn(rho, lo, hi), peak = Math.abs(rho[k]);
    const frac = k > 0 && k < rho.length - 1 ? parabolic(Math.abs(rho[k - 1]), peak, Math.abs(rho[k + 1])) : 0;
    const alpha = rho[k] * Math.sqrt((cs[tag][k + e.clip.t.length] - cs[tag][k]) / e.Et);
    return { k, tau: k + frac, rho: rho[k], p: (1 + nm.filter((v) => v >= peak).length) / (1 + nm.length), nNull: nm.length, nullP99: quantile(nm, 0.99), alpha, delayMs: (k + frac - e.iCall) / 16 };
  };
  const wide = { loMs: 20, hiMs: 700 };
  let det = evs.map((e, i) => ({ A: detect(prior?.A ?? wide, "A", i), B: detect(prior?.B ?? wide, "B", i) }));
  const stats = {};
  for (const tag of ["A", "B"]) {
    const d = det.map((x) => x[tag]).filter((x) => x.p <= 0.01).map((x) => x.delayMs);
    if (d.length >= 3) stats[tag] = { loMs: Math.max(10, quantile(d, 0.5) - 120), hiMs: quantile(d, 0.5) + 220, medianMs: round(quantile(d, 0.5), 1), p10Ms: round(quantile(d, 0.1), 1), p90Ms: round(quantile(d, 0.9), 1), n: d.length };
  }
  if (!prior) det = evs.map((e, i) => ({ A: stats.A ? detect(stats.A, "A", i) : det[i].A, B: stats.B ? detect(stats.B, "B", i) : det[i].B }));
  const winUsed = { A: prior?.A ?? stats.A ?? wide, B: prior?.B ?? stats.B ?? wide };
  const out = [];
  evs.forEach((e, i) => {
    const { ev, iCall, clip, perfCall } = e;
    const d = det[i], found = { A: d.A.p <= 0.02, B: d.B.p <= 0.02 };
    const W = Math.min(6400, clip.speechEnd - clip.speechStart);
    const o = { run: run.id, index: ev.index, clip: ev.clip, gainDb: ev.gainDb, atSec: ev.atSec, replyPositionSec: reply ? round((iCall - run.ctxToIdx(reply.when)) / RATE, 2) : null, speechMs: clip.speechMs };
    for (const tag of ["A", "B"]) {
      const x = X[tag], m = d[tag], otherTag = tag === "A" ? "B" : "A";
      const r = { detected: found[tag], p: round(m.p, 4), peakRho: round(Math.abs(m.rho), 3), nullP99Rho: round(m.nullP99, 3), searchedMs: [round(winUsed[tag].loMs, 0), round(winUsed[tag].hiMs, 0)], delayFromCallMs: found[tag] ? round(m.delayMs, 1) : null };
      const start = found[tag] ? m.k : found[otherTag] ? d[otherTag].k : null;
      if (start !== null) {
        const w0 = start + clip.speechStart, w1 = w0 + W;
        r.window400Dbfs = round(lvl(x, w0, w1), 1);
        r.windowFrom = found[tag] ? "own" : "other stream";
        r.ambientBeforeDbfs = round(lvl(x, iCall - 16000, iCall - 800), 1);
        if (found[tag]) {
          const pw = m.alpha * m.alpha * meanSq(clip.t, clip.speechStart, clip.speechStart + W);
          let res = 0;
          for (let j = 0; j < W; j++) { const v = x[w0 + j] - m.alpha * clip.t[clip.speechStart + j]; res += v * v; }
          r.wordProjDbfs = round(db10(pw), 1);
          r.wordToResidualDb = round(db10(pw / (res / W + 1e-14)), 1);
        }
        if (run.vad) {
          r.vadWord = vadStats(run.vad[tag], w0, w1);
          r.vadBefore = vadStats(run.vad[tag], iCall - 16000, iCall - 800);
        }
      }
      r.rule10dB = ruleOnset(x, ex.frames[tag], iCall, perfCall, found[tag] ? m.k + clip.speechStart : null);
      o[tag] = r;
    }
    o.AminusB = {
      delayMs: found.A && found.B ? round((d.A.tau - d.B.tau) / 16, 2) : null,
      wordProjDb: o.A.wordProjDbfs !== undefined && o.B.wordProjDbfs !== undefined ? round(o.A.wordProjDbfs - o.B.wordProjDbfs, 1) : null,
      window400Db: o.A.window400Dbfs !== undefined && o.B.window400Dbfs !== undefined ? round(o.A.window400Dbfs - o.B.window400Dbfs, 1) : null,
      ruleOnsetFrames: o.A.rule10dB.frame !== null && o.B.rule10dB.frame !== null ? o.A.rule10dB.frame - o.B.rule10dB.frame : null,
    };
    out.push(o);
  });
  return { events: out, stats: { A: winUsed.A, B: winUsed.B, found: stats } };
}
function summarizeEvents(events) {
  const groups = {};
  for (const e of events) {
    const key = `${e.run.startsWith("solo") ? "solo" : "overReply"} g${e.gainDb}`;
    (groups[key] ??= []).push(e);
  }
  const out = {};
  for (const [key, list] of Object.entries(groups)) {
    const pick = (f) => list.map(f).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const speechVad = (tag) => { const v = list.filter((e) => e[tag].vadWord).map((e) => (e[tag].vadWord.hist.probable + e[tag].vadWord.hist.sure > 0 ? 1 : 0)); return v.length ? round(mean(v), 2) : null; };
    const baseline = (tag) => { const v = list.filter((e) => e[tag].vadBefore?.frames).map((e) => e[tag].vadBefore.probableOrSureFraction); return v.length ? round(mean(v), 2) : null; };
    out[key] = {
      events: list.length,
      detectedInA: list.filter((e) => e.A.detected).length,
      detectedInB: list.filter((e) => e.B.detected).length,
      wordProjA_dBFS_median: round(quantile(pick((e) => e.A.wordProjDbfs), 0.5), 1),
      wordProjB_dBFS_median: round(quantile(pick((e) => e.B.wordProjDbfs), 0.5), 1),
      AminusB_wordProj_dB_median: round(quantile(pick((e) => e.AminusB.wordProjDb), 0.5), 1),
      AminusB_wordProj_dB_p10_p90: [round(quantile(pick((e) => e.AminusB.wordProjDb), 0.1), 1), round(quantile(pick((e) => e.AminusB.wordProjDb), 0.9), 1)],
      AminusB_window400_dB_median: round(quantile(pick((e) => e.AminusB.window400Db), 0.5), 1),
      wordToResidualA_dB_median: round(quantile(pick((e) => e.A.wordToResidualDb), 0.5), 1),
      wordToResidualB_dB_median: round(quantile(pick((e) => e.B.wordToResidualDb), 0.5), 1),
      delayFromCallA_ms_median: round(quantile(pick((e) => e.A.delayFromCallMs), 0.5), 1),
      delayFromCallB_ms_median: round(quantile(pick((e) => e.B.delayFromCallMs), 0.5), 1),
      AminusB_delay_ms_median: round(quantile(pick((e) => e.AminusB.delayMs), 0.5), 2),
      ruleOnsetFoundA: list.filter((e) => e.A.rule10dB.frame !== null && e.A.rule10dB.plausible).length,
      ruleOnsetFoundB: list.filter((e) => e.B.rule10dB.frame !== null && e.B.rule10dB.plausible).length,
      ruleArrivalA_ms_median: round(quantile(list.filter((e) => e.A.rule10dB.frame !== null && e.A.rule10dB.plausible).map((e) => e.A.rule10dB.arrivalMs), 0.5), 1),
      ruleArrivalB_ms_median: round(quantile(list.filter((e) => e.B.rule10dB.frame !== null && e.B.rule10dB.plausible).map((e) => e.B.rule10dB.arrivalMs), 0.5), 1),
      ruleAminusB_frames_median: round(quantile(pick((e) => e.AminusB.ruleOnsetFrames), 0.5), 1),
      vadWordFramesSpeechFractionA: (() => { const v = list.filter((e) => e.A.vadWord?.frames).map((e) => (e.A.vadWord.hist.probable + e.A.vadWord.hist.sure) / e.A.vadWord.frames); return v.length ? round(mean(v), 2) : null; })(),
      vadGradesWordAsSpeechInA: speechVad("A"),
      vadProbableOrSureFractionBeforeWordInA: baseline("A"),
      vadGradesWordAsSpeechInB: speechVad("B"),
    };
  }
  return out;
}

// ---------- self test on synthetic signals (checks the estimators, not the machine)
function selftest() {
  const n = 16000 * 24, rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2; })();
  const speechLike = (len, seed) => { const x = new Float32Array(len); let a = 0, b = 0; for (let i = 0; i < len; i++) { const e = 0.5 + 0.5 * Math.sin((2 * Math.PI * (2.7 + seed) * i) / RATE); a = 0.95 * a + 0.2 * rnd(); b = 0.6 * b + 0.3 * a + 0.05 * rnd(); x[i] = e * b; } return x; };
  const R = speechLike(n, 0), amb = speechLike(n, 0.3), lag = 1620; // 101.25 ms
  const gEcho = 10 ** (-22 / 20), gAmb = 10 ** (-3 / 20), resid = 10 ** (-20 / 20);
  const echo = new Float32Array(n);
  for (let i = lag; i < n; i++) echo[i] = gEcho * R[i - lag] + 0.5 * gEcho * (i - lag - 180 >= 0 ? R[i - lag - 180] : 0);
  const B = new Float32Array(n), A = new Float32Array(n);
  for (let i = 0; i < n; i++) { B[i] = echo[i] + gAmb * 0.05 * amb[i]; A[i] = 0.5 * gAmb * 0.05 * amb[i] + resid * echo[i]; }
  const pr = meanSq(R, 0, n), pe = meanSq(echo, 0, n);
  const lg = estimateLag(R, B, 0, n - 12000);
  const eb = echoPower([{ R, X: B, i0: 0, n: n - 12000 }], lg.lag), ea = echoPower([{ R, X: A, i0: 0, n: n - 12000 }], lg.lag);
  console.log(JSON.stringify({
    lagTrueMs: lag / 16, lagEstimatedMs: round(lg.lag / 16, 2),
    ERL_true_dB: round(db10(pr / pe), 1), ERL_coherent_dB: round(eb.refDbfs - eb.echoDbfs, 1), ERL_plain_dB: round(db10(pr / meanSq(B, 0, n)), 1),
    echoInProc_true_dB: round(db10(pe * resid * resid), 1), echoInProc_coherent_dB: round(ea.echoDbfs, 1), ERLE_true_dB: 20, ERLE_coherent_dB: round(eb.echoDbfs - ea.echoDbfs, 1),
    floors: [round(eb.floorDbfs, 1), round(ea.floorDbfs, 1)],
  }));
  // matched filter: a clip buried in the ambient at -6 dB SNR, found at a known place
  const clip = speechLike(8000, 1.1), x = new Float32Array(48000);
  for (let i = 0; i < x.length; i++) x[i] = 0.02 * amb[i];
  for (let i = 0; i < clip.length; i++) x[20000 + i] += 0.5 * 0.02 * clip[i] / (Math.sqrt(meanSq(clip, 0, clip.length)) / Math.sqrt(meanSq(amb, 0, 48000)));
  const m = matchedFilter(x, clip, 15000, 30000);
  console.log(JSON.stringify({ clipAtTrue: 20000, clipFound: round(m.tau, 2), z: round(m.z, 1) }));
}

// ---------- markdown
function table(headers, rows) {
  const line = (r) => `| ${r.map((c) => (c === null || c === undefined ? "n/a" : String(c))).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}
function markdown(R) {
  const L = [];
  const spk = R.endpoints?.render, out = R.session.defaultOutput ?? null;
  const warnings = [];
  if (spk?.muted === true) warnings.push(`**The default speakers were muted at the Windows endpoint (volume ${Math.round(spk.volume * 100)}%, read at ${R.endpoints.readAt}).** If they were muted during the runs, nothing was audible: the echo, click and word numbers below describe silence, not the canceller. The tool never changes a mute; unmute and run again.`);
  if (out && /head(phone|set)|ear(bud|phone)|buds|airpod|hands-free/i.test(out)) warnings.push(`**The default output was "${out}":** sound played there does not reach the laptop microphone.`);
  const unverified = Object.entries(R.runs).filter(([, r]) => r.refSkewSamples === undefined).map(([id]) => id);
  const skewed = Object.entries(R.runs).filter(([, r]) => r.refSkewSamples && Math.max(Math.abs(r.refSkewSamples.min), Math.abs(r.refSkewSamples.max)) > 600).map(([id]) => id);
  if (skewed.length) warnings.push(`**The reference recording is off the microphone's clock in: ${skewed.join(", ")}.** Do not use its lag, click or echo numbers.`);
  if (unverified.length) warnings.push(`The reference-versus-microphone alignment was not recorded in: ${unverified.join(", ")} (captured before the reference tap was fixed, when a long silence could shift the reference recording by seconds). Treat their reference-based numbers (lag, clicks, plain levels aligned by the reference) as unverified.`);
  L.push("# Echo probe: summary", "", ...warnings.flatMap((w) => [w, ""]),`Machine: ${R.session.browser}, audio context ${R.session.init.ctx.sampleRate} Hz, base latency ${round(R.session.init.ctx.baseLatency * 1000, 1)} ms, output latency ${round(R.session.init.ctx.outputLatency * 1000, 1)} ms. Raw stream channelCount ${R.session.init.B.settings.channelCount} (channel 0 is used), processed stream ${R.session.init.A.settings.channelCount}.`, "");
  L.push("Streams: A = echoCancellation + noiseSuppression + autoGainControl (the app), B = all three off (raw). Two simultaneous streams from one device did NOT share a processing chain: they differ sample by sample (identical-sample fraction " + R.session.micCheck.identicalSampleFraction + ").", "");
  L.push("## Room (ambient sound with nothing of ours playing)", "", table(["run", "raw dBFS", "processed dBFS", "VAD speech-like frames raw", "VAD speech-like frames processed"], R.ambient.map((a) => [a.id, a.rawDbfs, a.procDbfs, a.vadRaw, a.vadProc])), "");
  L.push("Ambient level just before each run starts (nothing of ours playing yet), in the order the runs were made:", "", table(["run", "raw dBFS", "processed dBFS"], Object.entries(R.runs).map(([id, r]) => [id, r.ambient?.B ?? r.rawDbfs, r.ambient?.A ?? r.procDbfs])), "");
  for (const r of R.replies) {
    L.push(`## Reply alone: ${r.id} (${r.lang})`, "");
    L.push(`Delay of the echo in the raw stream: ${r.delay.rawEchoMs} ms (cross-correlation z ${r.delay.rawEchoZ}); residue in the processed stream peaks at ${r.delay.procResidueMs} ms (z ${r.delay.procResidueZ}).`, "");
    const p = r.plain.all, q = r.plain.after3s;
    L.push(table(["", "reference dBFS", "raw mic dBFS", "processed dBFS", "ERL ref-raw dB", "ERLE raw-proc dB"], [["whole reply", p.ref, p.raw, p.proc, p.ERL, p.ERLE], ["after 3 s", q.ref, q.raw, q.proc, q.ERL, q.ERLE]]), "");
    if (r.coherent) {
      const c = r.coherent;
      L.push(`Coherence-based (ignores uncorrelated room sound): echo in raw ${c.rawEchoDbfs} dBFS (estimator floor ${c.rawEchoFloorDbfs}), ERL ${c.ERL_dB} dB (at least ${c.ERL_lowerBound_dB}); residue in processed ${c.procResidueDbfs} dBFS (floor ${c.procResidueFloorDbfs}, detected ${c.procResidueDetected}), which is ${c.residueRelativeToRef_dB} dB relative to the reference; ERLE ${c.ERLE_dB} dB.`, "");
    }
    L.push(`Ambient before the reply: raw ${r.ambient.preRoll.B} dBFS, processed ${r.ambient.preRoll.A} dBFS; after it: ${r.ambient.afterReply ? `raw ${r.ambient.afterReply.B}, processed ${r.ambient.afterReply.A}` : "n/a"}.`, "");
    L.push(table(["s", "active ms", "ref", "raw", "proc", "ERL", "ERLE"], r.perSecond.map((s) => [s.s, s.activeMs, s.refDbfs, s.rawDbfs, s.procDbfs, s.ERL_plain_dB, s.ERLE_plain_dB])), "");
    if (r.vad) {
      const h = (v) => `${v.hist.quiet}/${v.hist.soft}/${v.hist.probable}/${v.hist.sure} of ${v.frames}`;
      L.push("VAD grades quiet/soft/probable/sure while the reference is active and nobody speaks:", "", table(["stream", "whole reply", "after 3 s", "longest probable-or-sure run (ms)", "pre-roll, no reference"], [["raw B", h(r.vad.referenceActive.B), h(r.vad.referenceActiveAfter3s.B), r.vad.referenceActive.B.longestRunMs, h(r.vad.preRollNoReference.B)], ["processed A", h(r.vad.referenceActive.A), h(r.vad.referenceActiveAfter3s.A), r.vad.referenceActive.A.longestRunMs, h(r.vad.preRollNoReference.A)]]), "");
      L.push(`Recogniser (${r.asr.script}): raw heard ${r.asr.B.scriptWordsFound}/${r.asr.B.playedScriptWords} script words (${r.asr.B.recognizedWords} words written); processed heard ${r.asr.A.scriptWordsFound}/${r.asr.A.playedScriptWords} (${r.asr.A.recognizedWords} words written).`, "");
    }
  }
  if (R.pooledEnglishReply) {
    const c = R.pooledEnglishReply;
    L.push(`## English reply, all runs pooled (${c.runs.join(", ")}; ${c.seconds} s, ${c.segments} segments)`, "", `Pooling lowers the coherence estimator's floor. Echo in raw ${c.rawEchoDbfs} dBFS (floor ${c.rawEchoFloorDbfs}), ERL ${c.ERL_dB} dB; residue in processed ${c.procResidueDbfs} dBFS (floor ${c.procResidueFloorDbfs}, detected ${c.procResidueDetected}), ${c.residueRelativeToRef_dB} dB relative to the reference; ERLE ${c.ERLE_dB} dB (at least ${c.ERLE_lowerBound_dB} dB). The words played in the double-talk runs are uncorrelated with the reference and only add variance.`, "");
  }
  if (R.clicks) {
    const c = R.clicks;
    L.push("## Click train (3 ms chirp-click, 1 s apart, through the same context)", "", table(["stream", "found", "mean ms", "std ms", "min ms", "max ms"], [["raw B", `${c.B.found}/${c.clicks}`, c.B.meanMs, c.B.stdMs, c.B.minMs, c.B.maxMs], ["processed A", `${c.A.found}/${c.clicks}`, c.A.meanMs, c.A.stdMs, c.A.minMs, c.A.maxMs]]), "", `Delay = from the click's scheduled audio-clock time to its arrival in the worklet's timeline (output path + air + input path). The context reports an output latency of ${c.outputLatencyReportedMs} ms.`, "");
  }
  L.push("## Words (stop clips played from another process)", "", `Clip level = active RMS -22 dBFS at 0 dB. Gains 0, -6, -12 dB were written as new WAVs. A word is "found" in a stream when its matched-filter peak, searched only in the window of plausible delays after the call (${JSON.stringify(Object.fromEntries(Object.entries(R.eventWindows).map(([k, v]) => [k, { A: [Math.round(v.A.loMs), Math.round(v.A.hiMs)], B: [Math.round(v.B.loMs), Math.round(v.B.hiMs)] }])))} ms), beats 98% of the same statistic over windows of that run that hold no word. "word proj" is the matched-filter amplitude of the clip inside each stream (blind to uncorrelated sound); A-B is processed minus raw (AGC adds gain, NS/AEC remove it: net is what the app sees). Delays are from the Play() call to the clip start in the stream, so they include the SoundPlayer start-up.`, "");
  L.push(table(["case", "events", "found A", "found B", "A-B word dB (median, p10..p90)", "A-B 400 ms RMS dB", "word/residual A dB", "word/residual B dB", "call to word A ms", "call to word B ms", "A-B delay ms", "10 dB rule A", "10 dB rule B", "VAD speech in A", "VAD speech before word in A"], Object.entries(R.eventSummary).map(([k, s]) => [k, s.events, s.detectedInA, s.detectedInB, `${s.AminusB_wordProj_dB_median} (${s.AminusB_wordProj_dB_p10_p90.join("..")})`, s.AminusB_window400_dB_median, s.wordToResidualA_dB_median, s.wordToResidualB_dB_median, s.delayFromCallA_ms_median, s.delayFromCallB_ms_median, s.AminusB_delay_ms_median, `${s.ruleOnsetFoundA}/${s.events}`, `${s.ruleOnsetFoundB}/${s.events}`, s.vadGradesWordAsSpeechInA, s.vadProbableOrSureFractionBeforeWordInA])), "");
  L.push("Median 10 dB-rule onset (frame arrival, ms after the call): " + Object.entries(R.eventSummary).map(([k, s]) => `${k}: A ${s.ruleArrivalA_ms_median}, B ${s.ruleArrivalB_ms_median}, A-B ${s.ruleAminusB_frames_median} frames`).join("; ") + ". VAD frames graded probable-or-sure inside the word window in A: " + Object.entries(R.eventSummary).map(([k, s]) => `${k}: ${s.vadWordFramesSpeechFractionA}`).join("; ") + ".", "");
  const ruleArr = (t) => (t.rule10dB.frame !== null && t.rule10dB.plausible ? t.rule10dB.arrivalMs : null);
  const vadW = (t) => (t.vadWord ? `${t.vadWord.hist.probable + t.vadWord.hist.sure}/${t.vadWord.frames}` : null);
  L.push("### Every event", "", table(["run", "#", "clip", "gain dB", "reply pos s", "found A", "found B", "call to word A ms", "call to word B ms", "A-B delay ms", "word dBFS A", "word dBFS B", "A-B dB", "word/res A dB", "word/res B dB", "rule A ms", "rule B ms", "VAD frames speech A"], R.events.map((e) => [e.run, e.index, e.clip, -e.gainDb, e.replyPositionSec, e.A.detected, e.B.detected, e.A.delayFromCallMs, e.B.delayFromCallMs, e.AminusB.delayMs, e.A.wordProjDbfs, e.B.wordProjDbfs, e.AminusB.wordProjDb, e.A.wordToResidualDb, e.B.wordToResidualDb, ruleArr(e.A), ruleArr(e.B), vadW(e.A)])), "");
  L.push("## Clocks", "", `Node hrtime, PowerShell Stopwatch and the page's performance.now() share the QueryPerformanceCounter: Stopwatch minus hrtime = ${R.session.stopwatch.stopwatchMinusHrMs.toFixed(3)} ms; hrtime minus performance.now() = ${round(R.session.clockStart.cdp.offset, 3)} ms (the page's time origin on that counter), page ping and DevTools estimates differ by ${R.session.clockDriftMs.pingVsCdpStartMs} ms, drift over the session ${R.session.clockDriftMs.cdp} ms.`, "");
  return L.join("\n");
}

// ---------- main
/** --lagscan=<run id>: coherent echo power against the assumed lag (64 ms segments, 8 ms steps), for the raw and the processed stream. */
function lagScan(id) {
  const run = loadRun(id), play = run.ex.plays.find((p) => p.kind === "reply");
  const i0 = Math.round(run.ctxToIdx(play.when)), n = Math.round(play.durSec * RATE);
  const rows = [];
  for (let ms = 0; ms <= 320; ms += 8) {
    const b = coherent([{ R: run.R, X: run.B, i0, n }], ms * 16, 1024), a = coherent([{ R: run.R, X: run.A, i0, n }], ms * 16, 1024);
    rows.push({ ms, rawDbfs: b ? round(db10(b.Pc), 1) : null, procDbfs: a ? round(db10(a.Pc), 1) : null });
  }
  const nullB = [3000, 4500, 6000].map((s) => coherent([{ R: run.R, X: run.B, i0, n }], 1440 + s * 16 / 1000 * 1000, 1024)).filter(Boolean).map((v) => db10(v.Pc));
  const best = rows.reduce((p, r) => (r.rawDbfs !== null && r.rawDbfs > (p?.rawDbfs ?? -999) ? r : p), null);
  console.log(JSON.stringify({ id, bestLagMs: best?.ms, bestRawDbfs: best?.rawDbfs, nullFloorsRawDbfs: nullB.map((v) => round(v, 1)), rows }, null, 0));
}
async function main() {
  if (flags.has("--selftest")) return selftest();
  const scan = argv.find((a) => a.startsWith("--lagscan="));
  if (scan) return lagScan(scan.split("=")[1]);
  const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  const set = await loadEngines();
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => fs.existsSync(path.join(dir, `${id}-A.wav`)));
  const order = (id) => (id.startsWith("clicks") ? 0 : id.startsWith("ambient") ? 1 : id.startsWith("reply") ? 2 : id.startsWith("solo") ? 3 : 4);
  ids.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const endpointsFile = path.join(dir, "endpoints.json");
  const results = { session, endpoints: fs.existsSync(endpointsFile) ? JSON.parse(fs.readFileSync(endpointsFile, "utf8")) : session.endpoints ?? null, ambient: [], replies: [], clicks: null, events: [], runs: {}, eventWindows: {} };
  let lagFallback = 1440, lagEN = null, soloPrior;
  const pool = [];
  for (const id of ids) {
    const run = loadRun(id), kind = run.meta.item.kind;
    console.error("analysing", id);
    const base = { id, seconds: round(run.A.length / RATE, 1), mapSpreadMs: round(run.dSpreadMs, 1), gaps: run.ex.gaps, refSkewSamples: run.ex.refSkewSamples, gate: run.meta.gate };
    if (kind === "clicks") {
      results.clicks = analyzeClicks(run);
      if (results.clicks.B.found >= 5) lagFallback = results.clicks.B.meanMs * 16;
      results.runs[id] = { ...base, ambient: ambientOf(run, null) };
    } else if (kind === "silence") {
      const s = await analyzeSilence(run, set);
      results.ambient.push({ id, rawDbfs: s.rawDbfs, procDbfs: s.procDbfs, vadRaw: s.vad ? s.vad.B.probableOrSureFraction : null, vadProc: s.vad ? s.vad.A.probableOrSureFraction : null, detail: s });
      results.runs[id] = { ...base, ...s };
    } else if (kind === "reply") {
      const r = await analyzeReply(run, set, lagFallback);
      results.replies.push({ id, ...r });
      results.runs[id] = { ...base, ambient: r.ambient.preRoll };
      if (r.lang === "en") pool.push({ R: run.R, A: run.A, B: run.B, i0: r.i0, n: Math.round(r.replySeconds * RATE), id });
      lagEN ??= r.lagSamples;
    } else if (kind === "events") {
      if (set) { run.vad = { A: await vadTrace(set, run.A), B: await vadTrace(set, run.B) }; }
      const { events: ev, stats } = analyzeEvents(run, path.join(dir, "clips"), run.meta.item.reply ? soloPrior : undefined);
      if (!run.meta.item.reply) soloPrior = { A: stats.found.A ? stats.A : undefined, B: stats.found.B ? stats.B : undefined };
      results.eventWindows[id] = stats;
      results.events.push(...ev);
      const rep = run.ex.plays.find((p) => p.kind === "reply");
      const preEnd = rep ? Math.round(run.ctxToIdx(rep.when)) : Math.round(run.perfToIdx(run.meta.events[0].hrCallBeforePlay - run.syncOffset));
      results.runs[id] = { ...base, ambient: ambientOf(run, preEnd), events: ev.length };
      if (rep && run.meta.item.reply.lang === "en") pool.push({ R: run.R, A: run.A, B: run.B, i0: preEnd, n: Math.round(rep.durSec * RATE), id });
    }
  }
  // all runs that played the English reply, pooled: more segments, so a lower estimator floor (the words are uncorrelated with it)
  if (pool.length > 1 && lagEN !== null) {
    const b = echoPower(pool.map((p) => ({ R: p.R, X: p.B, i0: p.i0, n: p.n })), lagEN), a = echoPower(pool.map((p) => ({ R: p.R, X: p.A, i0: p.i0, n: p.n })), lagEN);
    if (a && b) results.pooledEnglishReply = { runs: pool.map((p) => p.id), ...coherentSummary(b, a), seconds: round(pool.reduce((s, p) => s + p.n, 0) / RATE, 0) };
  }
  results.eventSummary = summarizeEvents(results.events);
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 1));
  fs.writeFileSync(path.join(dir, "summary.md"), markdown(results));
  const brief = { dir, runs: Object.keys(results.runs).length, pooledEnglishReply: results.pooledEnglishReply, eventWindows: results.eventWindows, replies: results.replies.map((r) => ({ id: r.id, lagMs: r.delay.usedMs, plain: r.plain, coherent: r.coherent, ambient: r.ambient, vad: r.vad?.referenceActive, asr: r.asr && { A: { ...r.asr.A, text: r.asr.A.text.slice(0, 200) }, B: { ...r.asr.B, text: r.asr.B.text.slice(0, 200) } } })), clicks: results.clicks && { B: { ...results.clicks.B, perClick: undefined }, A: { ...results.clicks.A, perClick: undefined } }, eventSummary: results.eventSummary, ambient: results.ambient.map((a) => ({ id: a.id, rawDbfs: a.rawDbfs, procDbfs: a.procDbfs, vadRaw: a.vadRaw, vadProc: a.vadProc })) };
  console.log(JSON.stringify(brief, null, 1));
  await set?.dispose();
}
await main();
process.exit(0);
