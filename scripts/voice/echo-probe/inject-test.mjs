#!/usr/bin/env node
// Validation of analyze.mjs with injected ground truth.  usage: node inject-test.mjs <recordings-dir> <new-dir> [run ids...]
// Copies recordings made with silent speakers (real room noise, nothing of ours audible) into <new-dir> and adds, at known
// levels and delays, a modelled echo of the reply (ERL 24 dB, a second reflection 5 ms later) and a modelled copy of every
// word (24 dB path loss, 130 ms after the call in the raw stream, 25 ms later and 3 dB lower in the processed stream), plus a
// residue of the reply in the processed stream (ERLE 25 dB). It writes truth.json. Then run analyze.sh on <new-dir> and compare.
// The call-to-sample mapping is implemented here independently of analyze.mjs, so the two cross-check each other.
import fs from "node:fs";
import path from "node:path";

const [src, dst, ...ids0] = process.argv.slice(2);
const ids = ids0.length ? ids0 : ["clicks", "reply-en", "reply-pt", "solo", "dt-g0-a", "dt-g6-a", "dt-g12-a", "dt-g0-b", "dt-g6-b", "dt-g12-b"];
const P = { erlReply: 24, erle: 25, erlWord: 24, echoLagMs: 90, wordDelayRawMs: 130, wordDelayProcMs: 155, procWordDb: -3 };
fs.mkdirSync(path.join(dst, "clips"), { recursive: true });
for (const f of fs.readdirSync(path.join(src, "clips"))) fs.copyFileSync(path.join(src, "clips", f), path.join(dst, "clips", f));
fs.copyFileSync(path.join(src, "session.json"), path.join(dst, "session.json"));

function readWav(file) {
  const b = fs.readFileSync(file);
  const n = (b.length - 44) >> 1, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + 2 * i) / 32768;
  return x;
}
function writeWav(file, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), 44 + 2 * i);
  fs.writeFileSync(file, b);
}
const ms = (v) => Math.round((v * 16000) / 1000);
const db = (p) => 10 * Math.log10(Math.max(p, 1e-14));
function activeSpan(t) {
  let s = -1, e = -1;
  for (let i = 0; i + 320 <= t.length; i += 160) { let q = 0; for (let j = 0; j < 320; j++) q += t[i + j] ** 2; if (q / 320 > 3e-5) { if (s < 0) s = i; e = i + 320; } }
  return { s, e };
}
const truth = [];
for (const id of ids) {
  const meta = JSON.parse(fs.readFileSync(path.join(src, `${id}.json`), "utf8")), ex = meta.export;
  const A = readWav(path.join(src, `${id}-A.wav`)), B = readWav(path.join(src, `${id}-B.wav`)), R = readWav(path.join(src, `${id}-ref.wav`));
  const d = [];
  for (const tag of ["A", "B"]) for (const [, cf, arr] of ex.frames[tag]) d.push(arr - (1000 * cf) / ex.sr);
  d.sort((p, q) => p - q);
  const dMed = d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
  const off = (meta.sync.before.offset + meta.sync.after.offset) / 2;
  const callIdx = (hr) => (((hr - off - dMed) / 1000) * ex.sr - ex.segStartCf) / ex.ratio;
  const gE = 10 ** (-P.erlReply / 20), gR = gE * 10 ** (-P.erle / 20);
  if (ex.plays.some((p) => p.kind === "reply")) {
    for (let i = 0; i + ms(P.echoLagMs) + ms(5) < R.length; i++) {
      const j = i + ms(P.echoLagMs);
      B[j] += gE * R[i]; B[j + ms(5)] += 0.5 * gE * R[i];
      A[j] += gR * R[i];
    }
  }
  const clicks = ex.plays.find((p) => p.kind === "clicks");
  if (clicks) {
    // each click as the reference tap saw it, 100 ms later and 30 dB down in the raw stream, 103 ms later and 36 dB down in the processed one
    for (const c of clicks.times) {
      const s0 = Math.round((c * ex.sr - ex.segStartCf) / ex.ratio) - 40;
      for (let n = 0; n < 200; n++) { B[s0 + ms(100) + n] += 0.0316 * R[s0 + n]; A[s0 + ms(103) + n] += 0.0158 * R[s0 + n]; }
    }
    truth.push({ run: id, clicks: clicks.times.length, delayRawMs: 100, delayProcMs: 103 });
  }
  for (const ev of meta.events) {
    const t = readWav(path.join(src, "clips", ev.clipFile)), { s, e } = activeSpan(t);
    const i0 = Math.round(callIdx(ev.hrCallBeforePlay));
    const gW = 10 ** (-P.erlWord / 20), gA = gW * 10 ** (P.procWordDb / 20);
    const W = Math.min(6400, e - s);
    let q = 0;
    for (let k = 0; k < W; k++) q += t[s + k] ** 2;
    const jb = i0 + ms(P.wordDelayRawMs), ja = i0 + ms(P.wordDelayProcMs);
    for (let k = 0; k < t.length; k++) { if (jb + k < B.length) B[jb + k] += gW * t[k]; if (ja + k < A.length) A[ja + k] += gA * t[k]; }
    truth.push({ run: id, index: ev.index, gainDb: ev.gainDb, delayRawMs: P.wordDelayRawMs, delayProcMs: P.wordDelayProcMs, wordRawDbfs: db(gW * gW * q / W), wordProcDbfs: db(gA * gA * q / W) });
  }
  writeWav(path.join(dst, `${id}-A.wav`), A); writeWav(path.join(dst, `${id}-B.wav`), B); writeWav(path.join(dst, `${id}-ref.wav`), R);
  fs.copyFileSync(path.join(src, `${id}.json`), path.join(dst, `${id}.json`));
}
fs.writeFileSync(path.join(dst, "truth.json"), JSON.stringify({ model: P, events: truth }, null, 1));
console.log(`wrote ${ids.join(", ")} and ${truth.length} injected words to ${dst}`);
