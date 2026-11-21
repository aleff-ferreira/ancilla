#!/usr/bin/env node
// Real-browser test of WebPlayer (packages/ui/src/model/voice/player.ts) in Microsoft Edge. See README.md.
//   <path to the app's node.exe> player-edge.mjs --assets <dir> --player <player.js> --out <dir> [options]
// It serves player-edge.html and the bundled player over http://127.0.0.1:<port>, launches msedge.exe with a throwaway
// profile and --mute-audio, drives the page over the DevTools Protocol, and analyses what the player handed to the audio
// destination (recorded by a tap in the page) against the source audio. It never changes a volume, a mute, a default device
// or any other system setting, and runs no git command.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);
const DB = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const RATE = 44100; // the replies and the player's buffers
const LEAD_S = 0.04; // WebPlayer's LEAD_SECONDS
const THR = 1e-3; // -60 dBFS
const TYPES_ALL = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"];
let progressFile = "";
const log = (...a) => {
  const line = new Date().toISOString().slice(11, 23) + " " + a.join(" ");
  console.error(line);
  if (progressFile) try { fs.appendFileSync(progressFile, line + "\n"); } catch { /* ignore */ }
};

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, v] = a.slice(2).split("=");
    if (v !== undefined) o[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}

// ------------------------------------------------------------------------------------------------ audio helpers
function readWav16(file) {
  const b = fs.readFileSync(file);
  let at = 12, rate = 0, data = null;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt ") rate = b.readUInt32LE(at + 12);
    if (id === "data") { data = new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + Math.min(size, b.length - at - 8))); break; }
    at += 8 + size + (size & 1);
  }
  if (!data || rate !== RATE) throw new Error(`expected 44.1 kHz 16-bit mono in ${file} (rate ${rate})`);
  return data;
}

/** Linear interpolation, the way Chromium plays a 44.1 kHz buffer on a context of another rate. */
function resample(src, rateOut) {
  if (rateOut === RATE) return Float32Array.from(src, (s) => s / 32768);
  const n = Math.floor((src.length * rateOut) / RATE);
  const out = new Float32Array(n);
  const step = RATE / rateOut;
  for (let i = 0; i < n; i++) {
    const p = i * step, i0 = Math.floor(p), f = p - i0;
    const a = src[i0] / 32768, b = i0 + 1 < src.length ? src[i0 + 1] / 32768 : a;
    out[i] = a + f * (b - a);
  }
  return out;
}
const sources = { en: null, pt: null };
const refCache = new Map();
const refFor = (name, fs) => {
  const key = name + "@" + fs;
  if (!refCache.has(key)) refCache.set(key, resample(sources[name], fs));
  return refCache.get(key);
};

/** Where utterance 2 starts in the Portuguese reply: the first place after 0.3 s whose next 100 ms are at least -35 dBFS RMS. */
function utterance2Offset(pcm) {
  const win = 4410;
  for (let s = 13230; s + win < pcm.length; s += 441) {
    let sum = 0;
    for (let i = 0; i < win; i++) sum += (pcm[s + i] / 32768) ** 2;
    if (Math.sqrt(sum / win) >= 10 ** (-35 / 20)) return s;
  }
  throw new Error("no loud start found in the Portuguese reply");
}

// ------------------------------------------------------------------------------------------------ FFT and alignment
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wlr = Math.cos(ang), wli = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nwr = wr * wlr - wi * wli;
        wi = wr * wli + wi * wlr;
        wr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const nextPow2 = (n) => { let m = 1; while (m < n) m <<= 1; return m; };

/** c[k] = sum_i x[i] * y[k + i] for k in [0, L). Direct for small work, by FFT otherwise (y is at least x.length + L - 1 long). */
function xcorr(x, y, L) {
  const N = x.length;
  if (N * L <= 3e6) {
    const c = new Float64Array(L);
    for (let k = 0; k < L; k++) { let s = 0; for (let i = 0; i < N; i++) s += x[i] * y[k + i]; c[k] = s; }
    return c;
  }
  const M = nextPow2(y.length);
  const xr = new Float64Array(M), xi = new Float64Array(M), yr = new Float64Array(M), yi = new Float64Array(M);
  xr.set(x);
  yr.set(y);
  fft(xr, xi, false);
  fft(yr, yi, false);
  for (let i = 0; i < M; i++) {
    const a = xr[i], b = -xi[i], c = yr[i], d = yi[i];
    yr[i] = a * c - b * d;
    yi[i] = a * d + b * c;
  }
  fft(yr, yi, true);
  return yr.subarray(0, L);
}

/**
 * Finds the offset `a` (in samples at the tap's rate) such that tap[n] ~ ref[n - a] around the window tap[n0 .. n0 + N), searching
 * a in [aPred - R, aPred + R]. Normalised cross-correlation with a parabolic refinement of the peak.
 */
function alignWindow(tap, n0, N, ref, aPred, R) {
  const L = 2 * R + 1, ylen = N + 2 * R, base = n0 - aPred - R;
  const y = new Float64Array(ylen);
  for (let j = 0; j < ylen; j++) { const m = base + j; y[j] = m >= 0 && m < ref.length ? ref[m] : 0; }
  const x = new Float64Array(N);
  let ex = 0;
  for (let i = 0; i < N; i++) { const v = n0 + i < tap.length ? tap[n0 + i] : 0; x[i] = v; ex += v * v; }
  const c = xcorr(x, y, L);
  const ps = new Float64Array(ylen + 1);
  for (let j = 0; j < ylen; j++) ps[j + 1] = ps[j] + y[j] * y[j];
  const ncc = new Float64Array(L);
  let best = -2, bk = 0;
  for (let k = 0; k < L; k++) {
    const v = c[k] / Math.sqrt(Math.max(ex * (ps[k + N] - ps[k]), 1e-18));
    ncc[k] = v;
    if (v > best) { best = v; bk = k; }
  }
  let frac = 0;
  if (bk > 0 && bk < L - 1) {
    const y1 = ncc[bk - 1], y2 = ncc[bk], y3 = ncc[bk + 1], d = y1 - 2 * y2 + y3;
    if (d < 0) frac = (0.5 * (y1 - y3)) / d;
  }
  return { a: aPred + R - (bk + frac), ncc: best };
}

/**
 * Checks that the tap plays the source in place along tap[from .. to): windows of winSec with at least -50 dBFS RMS must
 * correlate (>= 0.9) with the source at the offset `a`, within +-1 ms. Anything else (a gap, a repeat, a piece out of order or
 * lost) fails the windows after it; the first failures are searched over +-0.5 s to say where the audio really was.
 */
function verifyRange(tap, ref, a, from, to, cs, fs, winSec = 0.04) {
  const Wn = Math.round(winSec * fs), lagR = Math.max(2, Math.round(0.001 * fs)), ai = Math.round(a);
  const out = { windows: 0, skipped: 0, failed: 0, minNcc: 1, maxLagMs: 0, bad: [] };
  const lo = Math.max(0, Math.round(from)), hi = Math.min(tap.length, Math.round(to));
  for (let n0 = lo; n0 + Wn <= hi; n0 += Wn) {
    const e = Math.sqrt(Math.max(0, cs[n0 + Wn] - cs[n0]) / Wn);
    // the tap is a copy of the source, so even a quiet window correlates; windows below -66 dBFS RMS are only a few 16-bit steps
    if (e < 10 ** (-66 / 20)) { out.skipped++; continue; }
    const r = alignWindow(tap, n0, Wn, ref, ai, lagR);
    out.windows++;
    out.minNcc = Math.min(out.minNcc, r.ncc);
    out.maxLagMs = Math.max(out.maxLagMs, (Math.abs(r.a - ai) / fs) * 1000);
    if (r.ncc < 0.9) {
      out.failed++;
      if (out.bad.length < 3) {
        const w = alignWindow(tap, n0, Math.round(0.1 * fs), ref, ai, Math.round(0.5 * fs));
        out.bad.push({ atMs: round(((n0 - lo) / fs) * 1000, 1), ncc: round(r.ncc, 3), wideNcc: round(w.ncc, 3), wideShiftMs: round(((w.a - ai) / fs) * 1000, 2) });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the analysis of one trial
/**
 * meta: what the page returned (events stamped on the audio clock, the player's own numbers); tap: the recorded Float32 samples
 * from meta.tap.startFrame. Returns { valid, why, m: numbers, c: checks (booleans), note }.
 */
function analyze(meta, tap) {
  const spec = meta.spec, type = spec.type, fs = meta.sr;
  const W = Math.round(0.005 * fs); // 5 ms
  const f0 = meta.tap.startFrame;
  const idx = (frame) => frame - f0;
  const res = { id: spec.id, type, moment: spec.moment, valid: true, why: [], m: {}, c: {}, note: {} };
  const bad = (why) => { res.valid = false; res.why.push(why); };
  const refEn = refFor("en", fs);
  const N = tap.length;
  const cs = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cs[i + 1] = cs[i] + tap[i] * tap[i];
  const rmsAt = (s, w = W) => { const a = Math.max(0, s), b = Math.min(N, s + w); return b > a ? Math.sqrt(Math.max(0, cs[b] - cs[a]) / (b - a)) : 0; };
  const lastNonZero = (a, b) => { for (let i = Math.min(b, N) - 1; i >= Math.max(a, 0); i--) if (tap[i] !== 0) return i; return -1; };
  const firstNonZero = (a, b = N) => { for (let i = Math.max(a, 0); i < Math.min(b, N); i++) if (tap[i] !== 0) return i; return -1; };
  const p44 = (n, a) => ((n - a) * RATE) / fs; // source sample (44.1 kHz) played at tap index n, given the offset a
  const ms = (samples) => (samples / fs) * 1000;
  /** Start of the silent run that reaches holdEnd (5 ms windows below -60 dBFS), or null when the run does not reach it. */
  const silenceStart = (from, holdEnd) => {
    const lo = Math.max(from, 0);
    let s = Math.min(holdEnd, N) - W;
    if (s < lo || rmsAt(s) >= THR) return null;
    while (s - 1 >= lo && rmsAt(s - 1) < THR) s--;
    return s;
  };
  /** The first moment (end of a 5 ms window, from `from` on) at which the output is at or above -60 dBFS RMS. */
  const audibleAgain = (from) => {
    for (let s = Math.max(from, 0); s + W <= N; s++) if (rmsAt(s) >= THR) return s + W - 1;
    return -1;
  };
  const calls = meta.events;
  const named = (name) => calls.filter((e) => e.name === name);
  const ci = idx(calls[0].f0);

  res.m.tapGaps = meta.tap.gaps;
  res.m.callMs = calls[0].ms;
  res.m.callPhaseFrames = calls[0].f0 % 128;
  res.m.baseLatencyMs = meta.baseLatency * 1000;
  res.m.outputLatencyMs = meta.outputLatency * 1000;
  if (meta.tap.gaps) { bad(`the tap has ${meta.tap.gaps} hole(s) in the recorded run`); res.note.tapHoles = { relativeToCallMs: (meta.tap.gapList ?? []).map(([a, b]) => [round(((a - (calls[0].f0 - f0)) / fs) * 1000, 1), round(((b - (calls[0].f0 - f0)) / fs) * 1000, 1)]), skips: (meta.skips ?? []).slice(0, 10) }; }
  if (!meta.energyOk) bad("the call could not wait for a moment with energy");
  if (ci < Math.round(0.55 * fs)) { bad("record too short before the call"); return res; }
  res.m.staleFrameLabels = meta.staleLabels ?? NaN;
  const ticks = [];
  const preReads = meta.reads.filter((r) => r[0] <= calls[0].c0);
  for (let i = 1; i < preReads.length; i++) ticks.push((preReads[i][0] - preReads[i - 1][0]) * 1000);
  res.m.maxTickGapMs = ticks.length ? Math.max(...ticks) : NaN;

  const pre100 = rmsAt(ci - Math.round(0.1 * fs), Math.round(0.1 * fs));
  res.m.preCallDbfs = DB(pre100);
  if (pre100 < 10 ** (-45 / 20)) bad(`the call landed on a pause (last 100 ms at ${round(DB(pre100), 1)} dBFS)`);
  const aPred = idx(meta.enq.f) + Math.round(LEAD_S * fs);
  const A1 = alignWindow(tap, ci - Math.round(0.5 * fs), Math.round(0.45 * fs), refEn, aPred, Math.round(0.3 * fs));
  res.m.anchorNcc = A1.ncc;
  res.m.anchorShiftMs = ms(A1.a - aPred);
  if (!(A1.ncc >= 0.9)) { bad(`pre-call alignment failed (ncc ${round(A1.ncc, 3)})`); return res; }
  const a1 = A1.a;
  const pv = verifyRange(tap, refEn, a1, 0, ci - Math.round(0.04 * fs), cs, fs);
  res.m.preCallMinNcc = pv.minNcc;
  res.m.preCallWindows = pv.windows;
  // a quiet stretch before the call leaves too few windows to say anything: the check is then left out, not failed
  if (pv.windows >= 5) res.c.baseline = pv.failed === 0;
  if (res.c.baseline === false) res.note.baseline = pv;

  /** How the player's own count compares with what reached the tap. */
  const accounting = (ret, exactEnd, heard = false) => {
    const tapCount = p44(exactEnd, a1);
    res.m.tapCount = tapCount;
    res.m.acctDiffSamples = ret.played - tapCount;
    res.m.acctDiffMs = (ret.played - tapCount) / 44.1;
    res.c.accounting = Math.abs(res.m.acctDiffMs) <= 1;
    res.c.accountingNoOver = res.m.acctDiffMs <= 1;
    if (heard) {
      // stop() counts what was heard by now, which is the output minus the device latency the player subtracts
      const lat = (meta.outputLatency || meta.baseLatency || 0) * 1000;
      res.m.acctDiffPlusLatencyMs = res.m.acctDiffMs + lat;
      res.c.accountingHeard = Math.abs(res.m.acctDiffPlusLatencyMs) <= 1;
    }
  };
  /** played(1) as read by the page every 100 ms, against the source position that is at the output at that moment (minus the latency the player subtracts). */
  const readErrs = (a, lo, hi) => {
    const out = [];
    for (const [c, played, lat] of meta.reads) {
      const n = (c - lat) * fs - f0;
      if (n >= lo && n <= hi) out.push((played - p44(n, a)) / 44.1);
    }
    return out;
  };
  const absMax = (v) => (v.length ? Math.max(...v.map(Math.abs)) : NaN);
  const base = readErrs(a1, Math.round(0.05 * fs), ci - Math.round(0.05 * fs));
  res.m.acctBaseMaxMs = absMax(base);
  /** From the last non-zero sample before a silence to the first one after it: is the source continuous? */
  const continuity = (exactEnd, B2) => {
    const lo = B2 + Math.round(0.05 * fs);
    if (lo + Math.round(0.45 * fs) > N) return null;
    const a2pred = a1 + (B2 - exactEnd);
    const A2 = alignWindow(tap, lo, Math.round(0.4 * fs), refEn, Math.round(a2pred), Math.round(1.0 * fs));
    const out = { a2: A2.a, ncc: A2.ncc };
    out.gapMs = (p44(B2, A2.a) - p44(exactEnd, a1)) / 44.1; // positive: audio skipped, negative: audio repeated
    out.verify = verifyRange(tap, refEn, A2.a, lo, N, cs, fs);
    // the anchor window (400 ms) and the gap carry the check when the rest of the record is quiet; postWindows says how many more were checked
    out.pass = A2.ncc >= 0.9 && Math.abs(out.gapMs) <= 1 && out.verify.failed === 0;
    return out;
  };
  const putContinuity = (exactEnd, B2) => {
    const k = continuity(exactEnd, B2);
    if (!k) { bad("record too short after the resume"); return null; }
    res.m.gapMs = k.gapMs;
    res.m.postNcc = k.ncc;
    res.m.postMinNcc = k.verify.minNcc;
    res.m.postWindows = k.verify.windows;
    res.m.postFailed = k.verify.failed;
    res.c.continuity = k.pass;
    if (!k.pass) res.note.continuity = { gapMs: round(k.gapMs, 3), ncc: round(k.ncc, 3), verify: k.verify };
    const after = readErrs(k.a2, B2 + Math.round(0.1 * fs), N - Math.round(0.05 * fs));
    res.m.acctAfterMaxMs = absMax(after);
    res.m.acctAfterMedianMs = after.length ? after.slice().sort((x, y) => x - y)[Math.floor(after.length / 2)] : NaN;
    res.c.acctAfter = after.length >= 3 && absMax(after) <= 5;
    return k;
  };
  /** Tail of a pause: the last non-zero sample, the stray non-zero samples after it, and the click it ends with. */
  const tail = (s, holdEnd) => {
    // the last sample the player's sources produced: a few ms before the call at the earliest, a little after the silence began at the latest
    const exactEnd = lastNonZero(ci - 2 * W, Math.min(holdEnd, s + 20 * W)) + 1;
    res.m.silenceMs = ms(s - ci);
    if (exactEnd <= 0) return { exactEnd: 0, peak: 0 };
    // after the last non-zero sample every source has stopped: anything there is stale audio
    let peak = 0, stray = 0;
    for (let i = exactEnd; i < holdEnd; i++) { const v = Math.abs(tap[i]); if (v > peak) peak = v; if (v !== 0) stray++; }
    res.m.silenceExactMs = ms(exactEnd - ci);
    res.m.stalePeakDbfs = DB(peak);
    res.m.strayNonZero = stray;
    res.m.endStepDbfs = DB(Math.abs(tap[exactEnd - 1]));
    return { exactEnd, peak };
  };
  /** The first sample after a silence against the signal around it: a step from zero as large as the signal is a click. */
  const onsetStep = (B2) => {
    res.m.onsetStepDbfs = DB(Math.abs(tap[B2]));
    res.m.onsetStepRelDb = DB(Math.abs(tap[B2])) - DB(rmsAt(B2, Math.round(0.02 * fs)));
  };

  if (type === "T1") {
    if (N < ci + Math.round(1.6 * fs)) { bad("record too short after the call"); return res; }
    const s = silenceStart(ci - 2 * W, N);
    if (s === null || s <= ci - 2 * W) { res.c.stale = false; res.note.stale = "the output never went silent for good"; return res; }
    const { exactEnd, peak } = tail(s, N);
    res.m.silentTailMs = ms(N - s);
    res.m.playedAfterStop = calls[0].playedAfter;
    res.c.stale = N - s >= 1.5 * fs && peak < THR;
    if (exactEnd <= 0) { bad("no last non-zero sample"); return res; }
    accounting(calls[0].ret, exactEnd, true);
    return res;
  }

  if (type === "T3" || type === "T4") {
    const pauseEv = named("pause")[0], resumeEv = named("resume")[0];
    const cr = idx(resumeEv.f0);
    res.m.resumeCallMs = resumeEv.ms;
    const s = silenceStart(ci - 2 * W, cr);
    if (s === null || s <= ci - 2 * W) { res.c.stale = false; res.note.stale = "not silent up to the resume"; return res; }
    const { exactEnd, peak } = tail(s, cr);
    res.c.stale = peak < THR && res.m.silenceMs <= 100;
    if (exactEnd <= 0) { bad("no last non-zero sample"); return res; }
    accounting(pauseEv.ret, exactEnd);
    res.c.pausedReadsHold = meta.reads.filter((r) => r[0] > pauseEv.c0 && r[0] < resumeEv.c0).every((r) => r[1] === pauseEv.ret.played);
    res.c.playedAfterPauseSame = pauseEv.playedAfter === pauseEv.ret.played;
    const B2 = firstNonZero(cr);
    const nAud = audibleAgain(cr);
    if (B2 < 0 || nAud < 0) { res.c.continuity = false; res.note.continuity = "the voice did not come back"; return res; }
    res.m.resumeExactMs = ms(B2 - cr);
    res.m.resumeAudibleMs = ms(nAud - cr);
    onsetStep(B2);
    const k = putContinuity(exactEnd, B2);
    if (k && type === "T4") {
      const held = named("enqueueHeld")[0];
      const n0 = Math.round(k.a2 + (held.sent0 / RATE) * fs), n1 = Math.round(k.a2 + (held.sent1 / RATE) * fs);
      const hv = verifyRange(tap, refEn, k.a2, n0 - Math.round(0.02 * fs), n1 + Math.round(0.02 * fs), cs, fs, 0.02);
      res.m.heldEnergyDbfs = DB(rmsAt(n0, n1 - n0));
      res.m.heldWindows = hv.windows;
      res.m.heldMinNcc = hv.minNcc;
      res.m.heldAfterResumeMs = ms(n0 - B2);
      // with no speech in the held pieces the check says nothing: it is then left out (and counted) instead of passed
      if (hv.windows >= 2 && n1 + Math.round(0.02 * fs) <= N) res.c.heldOrder = hv.failed === 0;
      else { res.note.heldVacuous = true; res.m.heldVacuous = 1; }
      if (res.c.heldOrder === false) res.note.heldOrder = hv;
    }
    return res;
  }

  if (type === "T2" || type === "T5") {
    const pauses = named("pause");
    const last = pauses[pauses.length - 1];
    const cl = idx(last.f0);
    const hold = cl + Math.round(1.3 * fs);
    if (N < hold) { bad("record too short after the last pause"); return res; }
    const s = silenceStart(ci - 2 * W, hold);
    if (s === null || s <= ci - 2 * W) { res.c.stale = false; res.note.stale = "not silent until 1.3 s after the last pause (the voice came back early or never went silent)"; return res; }
    const { exactEnd, peak } = tail(s, hold);
    res.c.stale = peak < THR && res.m.silenceMs <= 100;
    if (exactEnd <= 0) { bad("no last non-zero sample"); return res; }
    accounting(pauses[0].ret, exactEnd);
    const B2 = firstNonZero(exactEnd);
    const nAud = audibleAgain(exactEnd);
    if (B2 < 0 || nAud < 0) { res.c.leaseReturn = false; res.note.leaseReturn = "the voice never came back"; return res; }
    res.m.returnExactMs = ms(B2 - cl);
    res.m.returnMs = ms(nAud - cl);
    onsetStep(B2);
    // the lease is 1500 ms from the last pause; the voice then starts 40 ms later (the player's lead)
    res.c.leaseReturn = res.m.returnExactMs >= 1500 - 20 && res.m.returnExactMs <= 1500 + 40 + 150;
    res.m.returnLateMs = res.m.returnExactMs - 1540;
    if (type === "T5") {
      res.c.renewalNull = pauses.length === 3 && pauses[0].ret !== null && pauses[1].ret === null && pauses[2].ret === null;
      res.m.pauseSpacingMs = ((pauses[2].c0 - pauses[0].c0) / 2) * 1000;
      res.m.sinceFirstPauseMs = ms(B2 - ci);
    }
    putContinuity(exactEnd, B2);
    return res;
  }

  if (type === "T6") {
    const pauseEv = named("pause")[0], stopEv = named("stop")[0], enq2 = named("enqueue2")[0];
    const ce = idx(enq2.f0);
    if (N < ce + Math.round(0.5 * fs)) { bad("record too short after enqueue(2)"); return res; }
    const s = silenceStart(ci - 2 * W, ce);
    if (s === null || s <= ci - 2 * W) { res.c.stale = false; res.note.stale = "not silent from the pause to enqueue(2)"; return res; }
    const { exactEnd, peak } = tail(s, ce);
    res.c.stale = peak < THR && res.m.strayNonZero === 0 && res.m.silenceMs <= 100;
    if (exactEnd <= 0) { bad("no last non-zero sample"); return res; }
    accounting(pauseEv.ret, exactEnd);
    res.c.stopPlayedEqualsPause = stopEv.ret.played === pauseEv.ret.played && stopEv.ret.utterance === 1;
    res.c.currentIs2 = enq2.current === 2;
    const B2 = firstNonZero(ce);
    const nAud = audibleAgain(ce);
    if (B2 < 0 || nAud < 0) { res.c.fullVolume = false; res.note.fullVolume = "utterance 2 was never heard"; return res; }
    res.m.u2OnsetMs = ms(B2 - ce);
    res.m.u2AudibleMs = ms(nAud - ce);
    const ref2 = refFor("pt", fs);
    const win = Math.round(0.1 * fs);
    const a2pred = B2 - Math.round((spec.u2Offset * fs) / RATE);
    const A = alignWindow(tap, B2, win, ref2, a2pred, Math.round(0.05 * fs));
    const ai = Math.round(A.a);
    let xy = 0, yy = 0, xx = 0;
    for (let i = 0; i < win; i++) { const x = tap[B2 + i], y = ref2[B2 + i - ai] ?? 0; xy += x * y; yy += y * y; xx += x * x; }
    res.m.u2LevelDb = DB(xy / Math.max(yy, 1e-18));
    res.m.u2RmsRatioDb = DB(Math.sqrt(xx / win)) - DB(Math.sqrt(yy / win));
    res.m.u2Ncc = A.ncc;
    res.m.u2SourceShiftMs = ms(A.a - a2pred);
    res.c.fullVolume = Math.abs(res.m.u2LevelDb) <= 1 && A.ncc >= 0.9;
    return res;
  }
  if (type === "T7") {
    // the page's answer to a server resume with drop: true: stop() while paused, with audio held. Nothing may be heard from then on.
    const pauseEv = named("pause")[0], heldEv = named("enqueueHeld")[0], dropEv = named("drop")[0];
    const cd = idx(dropEv.f0);
    if (N < cd + Math.round(2.5 * fs)) { bad("record too short after the drop"); return res; }
    const s = silenceStart(ci - 2 * W, N);
    if (s === null || s <= ci - 2 * W) { res.c.stale = false; res.note.stale = "audible after the pause or after the drop"; return res; }
    const { exactEnd, peak } = tail(s, N);
    if (exactEnd <= 0) { bad("no last non-zero sample"); return res; }
    res.m.silentAfterDropMs = ms(N - cd);
    res.m.discardedMs = ((heldEv.sent1 - pauseEv.ret.played) / RATE) * 1000; // paused remainder plus held pieces thrown away
    res.c.stale = peak < THR && res.m.strayNonZero === 0 && res.m.silenceMs <= 100;
    res.c.afterDropNoAudio = tap.subarray(cd).every((v) => v === 0);
    res.c.dropPlayedEqualsPause = dropEv.ret.played === pauseEv.ret.played && dropEv.ret.utterance === 1;
    accounting(pauseEv.ret, exactEnd);
    return res;
  }
  bad("unknown type " + type);
  return res;
}

// ------------------------------------------------------------------------------------------------ summaries
function stats(v) {
  const s = [...v].sort((x, y) => x - y), n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return {
    n, min: s[0], median, p95: s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)], max: s[n - 1],
    maxAbs: Math.max(Math.abs(s[0]), Math.abs(s[n - 1])), mean: s.reduce((a, b) => a + b, 0) / n,
  };
}
function summarize(results) {
  const out = {};
  for (const t of TYPES_ALL) {
    const rs = results.filter((r) => r.type === t);
    if (!rs.length) continue;
    const ok = rs.filter((r) => r.valid);
    const metrics = {}, checks = {};
    for (const key of new Set(ok.flatMap((r) => Object.keys(r.m)))) {
      const vals = ok.map((r) => r.m[key]).filter((v) => Number.isFinite(v));
      if (vals.length) metrics[key] = stats(vals);
    }
    for (const key of new Set(ok.flatMap((r) => Object.keys(r.c)))) {
      const vals = ok.map((r) => r.c[key]).filter((v) => typeof v === "boolean");
      checks[key] = { pass: vals.filter(Boolean).length, n: vals.length, failed: ok.filter((r) => r.c[key] === false).map((r) => r.id) };
    }
    out[t] = { total: rs.length, valid: ok.length, invalid: rs.filter((r) => !r.valid).map((r) => ({ id: r.id, why: r.why })), metrics, checks };
  }
  return out;
}

const LATENCIES = {
  T1: [["silenceMs", "stop() to silence for good (spec: 5 ms windows below -60 dBFS)"], ["silenceExactMs", "stop() to the last non-zero sample"]],
  T2: [["silenceMs", "pause(1500) to silence"], ["silenceExactMs", "pause() to the last non-zero sample"], ["returnMs", "pause() to audible again (lease)"], ["returnExactMs", "pause() to the first non-zero sample after the lease"]],
  T3: [["silenceMs", "pause(60000) to silence"], ["silenceExactMs", "pause() to the last non-zero sample"], ["resumeAudibleMs", "resume() to audible again"], ["resumeExactMs", "resume() to the first non-zero sample"]],
  T4: [["silenceMs", "pause(60000) to silence"], ["silenceExactMs", "pause() to the last non-zero sample"], ["resumeAudibleMs", "resume() to audible again"], ["resumeExactMs", "resume() to the first non-zero sample"]],
  T5: [["silenceMs", "first pause(1500) to silence"], ["silenceExactMs", "first pause() to the last non-zero sample"], ["returnMs", "last pause() to audible again"], ["returnExactMs", "last pause() to the first non-zero sample"], ["sinceFirstPauseMs", "first pause() to the first non-zero sample"]],
  T6: [["silenceMs", "pause(1500) to silence"], ["silenceExactMs", "pause() to the last non-zero sample"], ["u2AudibleMs", "enqueue(2) to audible"], ["u2OnsetMs", "enqueue(2) to the first non-zero sample"]],
  T7: [["silenceMs", "pause(1500) to silence (the drop comes 600 ms later)"], ["silenceExactMs", "pause() to the last non-zero sample"], ["silentAfterDropMs", "silence recorded after the drop (ms)"], ["discardedMs", "paused audio thrown away by the drop (ms)"]],
};
const OTHER = [
  ["acctDiffSamples", "played count of stop()/pause() minus source samples that reached the tap (samples)"],
  ["acctDiffMs", "same, in ms (negative: the player under-counts)"],
  ["acctBaseMaxMs", "played(1) every 100 ms during steady play, max |error| against the tap (ms)"],
  ["acctAfterMaxMs", "same after the voice came back, max |error| (ms)"],
  ["gapMs", "continuity: source skipped (+) or repeated (-) across the silence (ms)"],
  ["postMinNcc", "lowest correlation of any 40 ms window after the voice came back"],
  ["heldMinNcc", "T4: lowest correlation over the three held pieces"],
  ["u2LevelDb", "T6: level of the first 100 ms of utterance 2 against the source (dB)"],
  ["endStepDbfs", "level of the last non-zero sample before silence (the size of the step to zero), dBFS"],
  ["onsetStepDbfs", "level of the first sample after the voice came back (the size of the step from zero), dBFS"],
  ["onsetStepRelDb", "same, against the RMS of the next 20 ms (dB; around 0 or above: a click as large as the speech)"],
  ["acctDiffPlusLatencyMs", "stop(): played minus tap count plus the output latency the player subtracts (ms)"],
  ["staleFrameLabels", "audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio)"],
  ["stalePeakDbfs", "largest sample in the silence (dBFS; -240 is digital zero)"],
  ["callMs", "main-thread time of the first call (ms)"],
  ["outputLatencyMs", "ctx.outputLatency at the end of the trial (ms)"],
  ["maxTickGapMs", "longest gap between the page's 100 ms feeder ticks (ms)"],
];
const CHECKS = {
  baseline: "the stream before the call plays the source in place (every 40 ms window correlates >= 0.9 at one offset)",
  stale: "nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call",
  accounting: "played count equals the samples that reached the tap (|diff| <= 1 ms)",
  accountingNoOver: "played count never claims more than reached the tap (diff <= 1 ms)",
  accountingHeard: "stop(): played count equals the tap count minus the output latency (what had been heard by now), |diff| <= 1 ms",
  continuity: "resume continues at the sample where it stopped (|gap| <= 1 ms) and everything after it plays in place",
  acctAfter: "played(1) after the resume agrees with the tap (max |error| <= 5 ms)",
  pausedReadsHold: "played(1) stays at the paused value while paused",
  playedAfterPauseSame: "played(1) right after pause() equals what pause() returned",
  heldOrder: "the three pieces held while paused play after the paused remainder, in order",
  leaseReturn: "the voice returns 1500 ms after the last pause, plus the 40 ms lead (-20 ms to +150 ms)",
  renewalNull: "a pause while paused returns null (renews the lease only)",
  stopPlayedEqualsPause: "stop() while paused returns the paused position",
  currentIs2: "current() is 2 after enqueue(2)",
  fullVolume: "utterance 2 plays at full volume at once (first 100 ms within 1 dB of the source, correlation >= 0.9)",
  afterDropNoAudio: "T7, after the drop (stop() while paused, audio held): every sample to the end of the record is exactly zero (2.7 s later, past the end of the lease)",
  dropPlayedEqualsPause: "T7: the drop's stop() returns the paused position",
};

function fmt(x, d = 2) { return Number.isFinite(x) ? x.toFixed(d) : "n/a"; }
function markdown(summary, results, env, params) {
  const L = [];
  L.push("# WebPlayer in Edge: results", "");
  L.push(`Run ${env.date}. ${env.browser} (${env.userAgent}). Node ${env.node}. Windows ${env.os}.`, "");
  L.push(`Audio context: ${env.sampleRate} Hz, baseLatency ${fmt(env.baseLatencyMs, 2)} ms, outputLatency ${env.outputLatencyNote}. Flags: ${env.muted ? "--mute-audio" : "NOT muted"}, --autoplay-policy=no-user-gesture-required. ${params.workers} browser(s) in parallel, ${params.n} trial(s) per type, seed ${params.seed}.`, "");
  L.push("Times are on the audio clock: a latency is the tap's time minus `ctx.currentTime` read synchronously just before the call. The tap is the node just before `ctx.destination` (what the page hands to the audio device); the device's own latency is not in these numbers.", "");
  L.push("## Latencies (ms)", "", "| Trial | Measure | n | min | median | p95 | max |", "|---|---|---:|---:|---:|---:|---:|");
  for (const t of TYPES_ALL) {
    if (!summary[t]) continue;
    for (const [key, label] of LATENCIES[t]) {
      const s = summary[t].metrics[key];
      if (s) L.push(`| ${t} | ${label} | ${s.n} | ${fmt(s.min)} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.max)} |`);
    }
  }
  const pooled = (key) => results.filter((r) => r.valid && ["T2", "T3", "T4", "T5", "T6", "T7"].includes(r.type)).map((r) => r.m[key]).filter(Number.isFinite);
  if (pooled("silenceMs").length) {
    L.push("", "Pause to silence, T2 to T7 pooled (every trial starts with the same `pause()`):", "", "| Measure | n | min | median | p95 | max |", "|---|---:|---:|---:|---:|---:|");
    for (const [label, key] of [["pause() to silence (spec)", "silenceMs"], ["pause() to the last non-zero sample", "silenceExactMs"]]) {
      const s = stats(pooled(key));
      L.push(`| ${label} | ${s.n} | ${fmt(s.min)} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.max)} |`);
    }
  }
  L.push("", "## Checks", "", "| Trial | Check | Pass | Result |", "|---|---|---:|---|");
  for (const t of TYPES_ALL) {
    if (!summary[t]) continue;
    for (const [key, c] of Object.entries(summary[t].checks)) {
      if (key === "baseline" && c.pass === c.n) continue;
      L.push(`| ${t} | ${CHECKS[key] ?? key} | ${c.pass}/${c.n} | ${c.pass === c.n ? "PASS" : "FAIL"} |`);
    }
    L.push(`| ${t} | valid trials | ${summary[t].valid}/${summary[t].total} | ${summary[t].valid === summary[t].total ? "" : "see invalid list"} |`);
  }
  L.push("", "## Other numbers", "", "| Trial | Measure | n | min | median | p95 | max |", "|---|---|---:|---:|---:|---:|---:|");
  for (const t of TYPES_ALL) {
    if (!summary[t]) continue;
    for (const [key, label] of OTHER) {
      const s = summary[t].metrics[key];
      if (s) L.push(`| ${t} | ${label} | ${s.n} | ${fmt(s.min, 3)} | ${fmt(s.median, 3)} | ${fmt(s.p95, 3)} | ${fmt(s.max, 3)} |`);
    }
  }
  const failing = results.filter((r) => r.valid && Object.entries(r.c).some(([k, v]) => v === false && k !== "baseline"));
  L.push("", "## Failing trials", "");
  if (!failing.length) L.push("None.");
  for (const r of failing.slice(0, 40)) {
    const keys = Object.entries(r.c).filter(([k, v]) => v === false && k !== "baseline").map(([k]) => k);
    L.push(`- ${r.id} (moment ${r.moment} s): ${keys.join(", ")}. m: ${JSON.stringify(Object.fromEntries(Object.entries(r.m).filter(([k]) => ["silenceMs", "gapMs", "acctDiffMs", "acctAfterMaxMs", "returnExactMs", "u2LevelDb", "postFailed", "heldMinNcc"].includes(k)).map(([k, v]) => [k, round(v, 3)])))}${Object.keys(r.note).length ? ". note: " + JSON.stringify(r.note) : ""}`);
  }
  if (failing.length > 40) L.push(`- ... and ${failing.length - 40} more (see the JSON)`);
  const invalid = results.filter((r) => !r.valid);
  L.push("", "## Invalid trials (left out of the numbers)", "");
  if (!invalid.length) L.push("None.");
  for (const r of invalid) L.push(`- ${r.id}: ${r.why.join("; ")}`);
  L.push("");
  return L.join("\n");
}

// ------------------------------------------------------------------------------------------------ the browser
let pageHtml = "";
let serverPort = 0;
function startServer(assetsDir, playerJs) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code, body, type = "text/plain") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    try {
      if (url.pathname === "/" || url.pathname === "/player-edge.html") return send(200, fs.readFileSync(path.join(here, "player-edge.html")), "text/html; charset=utf-8");
      if (url.pathname === "/player.js") return send(200, fs.readFileSync(playerJs), "application/javascript");
      if (url.pathname === "/favicon.ico") return send(204, "");
      if (url.pathname.startsWith("/assets/")) {
        const file = path.join(assetsDir, path.basename(url.pathname));
        if (!file.endsWith(".wav") || !fs.existsSync(file)) return send(404, "no such asset");
        return send(200, fs.readFileSync(file), "audio/wav");
      }
      return send(404, "not found");
    } catch (e) {
      return send(500, String(e));
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { serverPort = server.address().port; resolve(server); }));
}

class Cdp {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.closed = false; }
  async open() {
    await new Promise((resolve, reject) => { this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true }); });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
    });
    this.ws.addEventListener("message", (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== undefined) {
        const p = this.pending.get(d.id);
        if (!p) return;
        this.pending.delete(d.id);
        if (d.error) p.reject(new Error(d.error.message)); else p.resolve(d.result);
      } else if (d.method) for (const fn of this.handlers.get(d.method) ?? []) fn(d.params);
    });
  }
  on(method, fn) { this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]); }
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("browser connection closed"));
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 60000) {
    const out = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    return out.result.value;
  }
}

class Session {
  constructor(id) { this.id = id; this.edge = null; this.profile = ""; this.cdp = null; this.version = ""; this.exe = ""; this.info = null; }
  async start() {
    const candidates = [args.edge, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
    const exe = candidates.find((c) => fs.existsSync(String(c)));
    if (!exe) throw new Error("msedge.exe not found; pass --edge <path>");
    this.exe = String(exe);
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), "player-edge-"));
    const debugPort = 9100 + Math.floor(Math.random() * 600) + this.id;
    const flags = [
      `--user-data-dir=${this.profile}`, `--remote-debugging-port=${debugPort}`, "--remote-allow-origins=*",
      ...(args.unmuted ? [] : ["--mute-audio"]),
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions", "--disable-default-apps",
      "--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--no-pings",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-size=520,300", `--window-position=${30 + 40 * this.id},${30 + 40 * this.id}`,
      `http://127.0.0.1:${serverPort}/player-edge.html`,
    ];
    this.edge = spawn(this.exe, flags, { stdio: "ignore", cwd: os.tmpdir() });
    this.edge.on("exit", (code) => log(`[w${this.id}] msedge exited`, code));
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === "page" && String(t.url).includes(`127.0.0.1:${serverPort}`));
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error("the Edge page did not appear on the DevTools port");
    this.version = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).Browser;
    this.cdp = new Cdp(target.webSocketDebuggerUrl);
    await this.cdp.open();
    await this.cdp.send("Runtime.enable");
    this.cdp.on("Runtime.exceptionThrown", (p) => log(`[w${this.id}] page exception:`, p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
    this.cdp.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error" || p.type === "warning") log(`[w${this.id}] page console`, p.type, (p.args ?? []).map((a) => a.value ?? a.description).join(" ")); });
    try { await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch { /* optional */ }
    try { await this.cdp.send("Page.bringToFront"); } catch { /* optional */ }
    for (let i = 0; i < 100; i++) {
      if (await this.cdp.eval("typeof window.edge !== 'undefined' && document.readyState === 'complete'").catch(() => false)) break;
      await sleep(100);
    }
    this.info = await this.cdp.eval("edge.init()", 60000);
    return this.info;
  }
  async trial(spec) {
    const payload = await this.cdp.eval(`edge.runTrial(${JSON.stringify(spec)})`, (spec.moment + 30) * 1000);
    return payload;
  }
  stop() {
    try { this.cdp?.ws.close(); } catch { /* gone */ }
    if (this.edge?.pid) spawnSync("taskkill", ["/PID", String(this.edge.pid), "/T", "/F"], { stdio: "ignore" });
    this.edge = null;
    if (this.profile) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(this.profile, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); }
      }
      this.profile = "";
    }
  }
}

// ------------------------------------------------------------------------------------------------ main
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** n moments per type, one in each of n equal slices of 2 s to 25 s (a random point in each), shuffled; types interleaved. */
function buildSchedule(types, n, seed, smoke, u2Offset) {
  const rnd = mulberry32(seed);
  const per = {};
  for (const t of types) {
    const m = [];
    for (let i = 0; i < n; i++) m.push(smoke ? 2 + 2 * rnd() : 2 + (23 * (i + rnd())) / n);
    for (let i = m.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [m[i], m[j]] = [m[j], m[i]]; }
    per[t] = m;
  }
  const out = [];
  for (let i = 0; i < n; i++) for (const t of types) out.push({ id: `${t}-${String(i + 1).padStart(2, "0")}`, type: t, moment: round(per[t][i], 3), u2Offset });
  return out;
}
/**
 * Replacement trials for a finished run: as many of each type as were left out of its numbers (a call that never found speech
 * within the wait, a hole in the tap), with fresh moments and a longer wait for speech. Ids are T2-x1, T2-x2, ...
 */
function buildTopup(prevDir, types, n, seed, u2Offset) {
  const prev = fs.readFileSync(path.join(prevDir, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const rnd = mulberry32(seed + 7919);
  const out = [];
  for (const t of types) {
    const need = n - prev.filter((r) => r.type === t && r.valid).length;
    for (let i = 0; i < need; i++) out.push({ id: `${t}-x${i + 1}`, type: t, moment: round(2 + (23 * (i + rnd())) / need, 3), u2Offset, waitMs: 8000 });
  }
  return out;
}

function decodeTap(b64) {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const oneLine = (r) => {
  const m = r.m;
  const bits = [`sil ${fmt(m.silenceMs, 1)}`, m.silenceExactMs !== undefined ? `exact ${fmt(m.silenceExactMs, 1)}` : "", m.returnExactMs !== undefined ? `return ${fmt(m.returnExactMs, 1)}` : "", m.resumeExactMs !== undefined ? `resume ${fmt(m.resumeExactMs, 1)}` : "", m.gapMs !== undefined ? `gap ${fmt(m.gapMs, 3)}` : "", m.acctDiffMs !== undefined ? `acct ${fmt(m.acctDiffMs, 2)}` : "", m.u2LevelDb !== undefined ? `u2 ${fmt(m.u2LevelDb, 2)} dB` : ""].filter(Boolean);
  const fails = Object.entries(r.c).filter(([k, v]) => v === false).map(([k]) => k);
  return `${r.valid ? "ok" : "INVALID(" + r.why.join("; ") + ")"} ${bits.join(" ")}${fails.length ? " FAIL: " + fails.join(",") : ""}`;
};

async function reanalyze(dir, resultsDir, params) {
  sources.en = readWav16(path.join(path.resolve(String(args.assets)), "reply-en-native.wav"));
  sources.pt = readWav16(path.join(path.resolve(String(args.assets)), "reply-pt-native.wav"));
  const results = [];
  // dir may name several run folders (comma separated): the numbers are then those of all of them together
  const dirs = dir.split(",").map((d) => path.resolve(d));
  for (const d of dirs) {
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".meta.json")).sort()) {
      const meta = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
      const tap = decodeTap(fs.readFileSync(path.join(d, f.replace(".meta.json", ".f32"))).toString("base64"));
      let r;
      try { r = analyze(meta, tap); } catch (e) { r = { id: meta.spec.id, type: meta.spec.type, moment: meta.spec.moment, valid: false, why: ["analysis error: " + (e?.stack ?? e)], m: {}, c: {}, note: {} }; }
      results.push(r);
      log(r.id, oneLine(r));
    }
  }
  const envFile = path.join(dirs[0], "env.json");
  const env = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, "utf8")) : { date: new Date().toISOString(), browser: "?", userAgent: "?", node: process.version, os: os.release(), sampleRate: "?", baseLatencyMs: NaN, outputLatencyNote: "?", muted: true };
  finish(results, env, resultsDir, params);
}

function finish(results, env, resultsDir, params) {
  results.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  const summary = summarize(results);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, "player-edge-results.json"), JSON.stringify({ env, params, summary, trials: results }, null, 1));
  fs.writeFileSync(path.join(resultsDir, "player-edge-results.md"), markdown(summary, results, env, params));
  log("wrote", path.join(resultsDir, "player-edge-results.json"), "and .md");
}

async function main() {
  const smoke = Boolean(args.smoke);
  const outDir = path.resolve(String(args.out ?? path.join(os.tmpdir(), "player-edge-out")));
  const resultsDir = path.resolve(String(args.results ?? here));
  const n = Number(args.n ?? (smoke ? 2 : 30));
  const workers = Number(args.workers ?? 1);
  const seed = Number(args.seed ?? 20261120);
  const types = typeof args.types === "string" ? args.types.split(",") : TYPES_ALL;
  const params = { n, workers, seed, types, smoke, muted: !args.unmuted };
  fs.mkdirSync(outDir, { recursive: true });
  progressFile = path.join(outDir, "progress.log");
  if (args.reanalyze) return reanalyze(String(args.reanalyze), resultsDir, params);
  if (!args.assets || !args.player) throw new Error("usage: node player-edge.mjs --assets <dir with reply-en-native.wav and reply-pt-native.wav> --player <esbuild bundle of player.ts> --out <dir> [--n 30] [--types T1,T2,...] [--workers 1] [--smoke] [--unmuted] [--results <dir>] | --reanalyze <dir>");
  const assetsDir = path.resolve(String(args.assets));
  const playerJs = path.resolve(String(args.player));
  if (!fs.existsSync(playerJs)) throw new Error(`${playerJs} does not exist: build it first (see README.md)`);
  sources.en = readWav16(path.join(assetsDir, "reply-en-native.wav"));
  sources.pt = readWav16(path.join(assetsDir, "reply-pt-native.wav"));
  const u2Offset = utterance2Offset(sources.pt);
  const schedule = args.topup ? buildTopup(path.resolve(String(args.topup)), types, n, seed, u2Offset) : buildSchedule(types, n, seed, smoke, u2Offset);
  log(`plan: ${schedule.length} trials, ${workers} browser(s), types ${types.join(",")}, utterance 2 starts at sample ${u2Offset} of the Portuguese reply, out ${outDir}`);

  const server = await startServer(assetsDir, playerJs);
  const sessions = [];
  const results = [];
  const env = { date: new Date().toISOString(), node: process.version, os: os.release(), muted: !args.unmuted, flags: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] };
  const cleanup = () => { for (const s of sessions) s.stop(); server.close(); };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  const t0 = Date.now();
  try {
    for (let i = 0; i < workers; i++) {
      const s = new Session(i);
      sessions.push(s);
      const info = await s.start();
      log(`[w${i}] ${s.version}; context ${JSON.stringify(info)}`);
      if (i === 0) { env.browser = s.version; env.userAgent = info.userAgent; env.sampleRate = info.sampleRate; env.baseLatencyMs = info.baseLatency * 1000; env.hardwareConcurrency = info.hardwareConcurrency; env.initialOutputLatencyMs = info.outputLatency * 1000; }
      if (!(info.clockRate > 0.5 && info.clockRate < 2)) throw new Error(`the audio clock does not run at the wall clock's pace (rate ${info.clockRate})`);
      if (i === 0) env.clockRate = round(info.clockRate, 5);
      // a warm-up trial, left out of the results
      try { await s.trial({ id: `warmup-${i}`, type: "T1", moment: 2.2, u2Offset }); } catch (e) { log(`[w${i}] warm-up failed: ${e.message}`); }
    }
    const queue = schedule.slice();
    const outputLatencies = [];
    let done = 0;
    await Promise.all(sessions.map(async (s) => {
      for (;;) {
        const spec = queue.shift();
        if (!spec) break;
        let r = null;
        for (let attempt = 1; attempt <= 2 && !r; attempt++) {
          try {
            const payload = await s.trial(spec);
            const b64 = payload.tap.b64;
            delete payload.tap.b64;
            const tap = decodeTap(b64);
            fs.writeFileSync(path.join(outDir, `${spec.id}.f32`), Buffer.from(tap.buffer, tap.byteOffset, tap.byteLength));
            fs.writeFileSync(path.join(outDir, `${spec.id}.meta.json`), JSON.stringify(payload));
            outputLatencies.push(payload.outputLatency * 1000);
            try { r = analyze(payload, tap); } catch (e) { r = { id: spec.id, type: spec.type, moment: spec.moment, valid: false, why: ["analysis error: " + (e?.stack ?? e)], m: {}, c: {}, note: {} }; }
          } catch (e) {
            log(`[w${s.id}] ${spec.id} attempt ${attempt} failed: ${e.message}`);
            if (attempt === 1) {
              s.stop();
              await sleep(1000);
              try { await s.start(); } catch (e2) { log(`[w${s.id}] restart failed: ${e2.message}`); }
            }
          }
        }
        if (!r) r = { id: spec.id, type: spec.type, moment: spec.moment, valid: false, why: ["the browser run failed twice"], m: {}, c: {}, note: {} };
        results.push(r);
        done++;
        fs.appendFileSync(path.join(outDir, "results.jsonl"), JSON.stringify(r) + "\n");
        log(`[${done}/${schedule.length}] [w${s.id}] ${spec.id} t=${spec.moment}s ${oneLine(r)}`);
      }
    }));
    outputLatencies.sort((a, b) => a - b);
    env.outputLatencyNote = outputLatencies.length ? `${fmt(outputLatencies[0], 1)} to ${fmt(outputLatencies[outputLatencies.length - 1], 1)} ms over the trials (median ${fmt(outputLatencies[Math.floor(outputLatencies.length / 2)], 1)} ms; 0 means the browser reports none, as it may when muted; the player then subtracts baseLatency)` : "unknown";
    env.wallSeconds = round((Date.now() - t0) / 1000, 0);
    fs.writeFileSync(path.join(outDir, "env.json"), JSON.stringify(env, null, 1));
    finish(results, env, resultsDir, params);
  } finally {
    cleanup();
  }
}

try {
  await main();
} catch (e) {
  console.error("player-edge failed:", e?.stack ?? e);
  process.exitCode = process.exitCode || 1;
}
setTimeout(() => process.exit(process.exitCode ?? 0), 300);
