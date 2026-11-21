#!/usr/bin/env node
// Are the baseline build's voice engines the pilot build's, on the paths the shipped call uses? The evaluation runs every arm on
// one set of engines (the pilot build's), so this checks that doing so does not favor either arm: the same audio goes through
// the speech detector (`process`) and the recogniser of both builds, and the probabilities and the words must be identical.
//
//   node scripts/voice/interrupt-eval/engines-equal.mjs --baseline <checkout of v0.30.0> --pilot <this checkout>
//        [--runtime <dir>] [--models <dir>]
import os from "node:os";
import path from "node:path";
import * as rig from "./rig.mjs";
import * as ep from "./episodes.mjs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const baselineRoot = flag("baseline");
const pilotRoot = flag("pilot");
if (!baselineRoot || !pilotRoot) { console.error("need --baseline <root> --pilot <root>"); process.exit(2); }
const runtimeDir = flag("runtime", process.env.ANCILLA_VOICE_RUNTIME ?? path.join(os.homedir(), "voice-lab"));
const modelsDir = flag("models", process.env.ANCILLA_VOICE_MODELS ?? path.join(runtimeDir, "models"));

const A = rig.loadVoice(baselineRoot);
const B = rig.loadVoice(pilotRoot);
const make = (v) => v.engines.createSherpaEngines({ runtimeDir, modelsDir }, { refine: true, log: () => undefined });
const setA = make(A);
const setB = make(B);
await Promise.all([setA.engines.asr.warm?.(), setB.engines.asr.warm?.(), setB.engines.tts.warm?.()]);
const voices = new ep.UserVoices(B, setB, runtimeDir, modelsDir);

async function read(set, pcm, lang) {
  const stream = await set.engines.asr.open(lang === "pt" ? "pt-BR" : "en-US");
  for (let off = 0; off < pcm.length; off += 512) await stream.accept(pcm.subarray(off, Math.min(pcm.length, off + 512)));
  await stream.flush?.();
  const res = await stream.finish();
  stream.dispose();
  return res.text ?? "";
}

const lines = [
  ["Remind me to call Ana at five.", "en:F2", "en"],
  ["Actually, make it Wednesday.", "en:M3", "en"],
  ["Stop.", "en:F3", "en"],
  ["Me lembre de ligar para a Ana às cinco.", "pt:M2", "pt"],
  ["Na verdade, quarta.", "pt:F3", "pt"],
  ["Pare.", "pt:M3", "pt"],
];
const random = ep.prng(20261120);
const room = (n, rms) => Float32Array.from({ length: n }, () => (random() * 2 - 1) * rms * 1.7);
let frames = 0;
let differing = 0;
let maxDiff = 0;
let textDiffs = 0;
for (const [text, voice, lang] of lines) {
  const spoken = rig.setActiveRmsDb((await voices.say(text, voice)).pcm, -27);
  const track = new Float32Array(8000 + spoken.length + 16000);
  track.set(room(8000, 0.002), 0);
  track.set(spoken, 8000);
  track.set(room(16000, 0.002), 8000 + spoken.length);
  setA.engines.vad.reset();
  setB.engines.vad.reset();
  const n = setA.engines.vad.frameSamples;
  for (let off = 0; off + n <= track.length; off += n) {
    const f = track.subarray(off, off + n);
    const a = await setA.engines.vad.process(f);
    const b = await setB.engines.vad.process(f);
    frames++;
    const d = Math.abs(a - b);
    if (d > 0) differing++;
    maxDiff = Math.max(maxDiff, d);
  }
  const [ta, tb] = [await read(setA, track, lang), await read(setB, track, lang)];
  if (ta !== tb) textDiffs++;
  console.log(`${voice} "${text}"  baseline engine: "${ta}"  pilot engine: "${tb}"${ta === tb ? "" : "   DIFFERENT"}`);
}
console.log(`speech detector: ${frames} frames, ${differing} differ, largest difference ${maxDiff}; recogniser: ${textDiffs} of ${lines.length} readings differ`);
await setA.dispose();
await setB.dispose();
process.exit(differing === 0 && textDiffs === 0 ? 0 : 1);
