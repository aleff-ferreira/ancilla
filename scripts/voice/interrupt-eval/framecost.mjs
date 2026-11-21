#!/usr/bin/env node
// What the pilot adds to the work done for every 32 ms frame of the microphone: the shipped speech detector's `process` against
// the quick reading `processOnset` plus the judge's own step, on speech and room sound, one thread, no real-time pacing.
// (Time is performance.now(), a monotonic clock; the WSL wall clock is never read.)
//
//   node scripts/voice/interrupt-eval/framecost.mjs [--root <built checkout>] [--runtime <dir>] [--models <dir>] [--frames N]
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as rig from "./rig.mjs";
import * as ep from "./episodes.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const root = flag("root", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
const runtimeDir = flag("runtime", process.env.ANCILLA_VOICE_RUNTIME ?? path.join(os.homedir(), "voice-lab"));
const modelsDir = flag("models", process.env.ANCILLA_VOICE_MODELS ?? path.join(runtimeDir, "models"));
const frames = Number(flag("frames", "3000"));

const v = rig.loadVoice(root);
const require = createRequire(import.meta.url);
const { InterruptJudge } = require(path.join(root, "packages/server/dist/src/voice/interrupt.js"));
const set = v.engines.createSherpaEngines({ runtimeDir, modelsDir }, { refine: false, log: () => undefined });
await set.engines.tts.warm?.();
const voices = new ep.UserVoices(v, set, runtimeDir, modelsDir);
const random = ep.prng(7);

// 3000 frames of mixed sound: speech (the voice, at -26 dBFS) with room noise between
const speech = rig.setActiveRmsDb((await voices.say("What time is it in Lisbon, and how long does it take to get there by train?", "en:F2")).pcm, -26);
const n = set.engines.vad.frameSamples;
const track = new Float32Array(frames * n);
for (let i = 0; i < track.length; i++) track[i] = (random() * 2 - 1) * 0.003;
for (let at = 0; at + speech.length < track.length; at += speech.length + 16000) track.set(speech, at);

function time(fn) {
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) fn(track.subarray(i * n, (i + 1) * n), i);
  return ((performance.now() - t0) / frames) * 1000;
}
const shipped = time((f) => set.engines.vad.process(f));
set.engines.vad.reset();
const onset = time((f) => set.engines.vad.processOnset(f));
const judge = new InterruptJudge({ looksLikeEcho: () => false });
judge.setSpeaking(true);
const judging = time((f, i) => {
  let sum = 0;
  for (let k = 0; k < f.length; k++) sum += f[k] * f[k];
  judge.frame({ t: i * 32, prob: 0.5, rms: Math.sqrt(sum / f.length), ref: 0.1 });
});
console.log(`per 32 ms frame: shipped detector ${shipped.toFixed(1)} us, quick reading ${onset.toFixed(1)} us, judge step ${judging.toFixed(2)} us`);
console.log(`the pilot adds ${(onset + judging).toFixed(1)} us per frame (${(((onset + judging) / 32000) * 100).toFixed(2)}% of one core at real time)`);
await set.dispose();
process.exit(0);
