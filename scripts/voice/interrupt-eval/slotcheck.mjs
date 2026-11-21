#!/usr/bin/env node
// Which correction phrases can the shipped recogniser read at all? Each phrase of the episodes is said by each voice, alone (no
// call, no interruption), and read by the real streaming and re-reading recogniser; the word that matters has to be in what
// it writes. A phrase that is misread here is lost by every arm, so the episodes use the ones that are not.
//
//   node scripts/voice/interrupt-eval/slotcheck.mjs [--split dev|heldout|both] [--lang en|pt|both] [--root <built checkout>]
//        [--runtime <dir>] [--models <dir>]
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as rig from "./rig.mjs";
import * as ep from "./episodes.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const splitArg = flag("split", "both");
const langArg = flag("lang", "both");
const root = flag("root", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
const runtimeDir = flag("runtime", process.env.ANCILLA_VOICE_RUNTIME ?? path.join(os.homedir(), "voice-lab"));
const modelsDir = flag("models", process.env.ANCILLA_VOICE_MODELS ?? path.join(runtimeDir, "models"));

const v = rig.loadVoice(root);
const set = v.engines.createSherpaEngines({ runtimeDir, modelsDir }, { refine: true, log: () => undefined });
await set.engines.asr.warm?.();
await set.engines.tts.warm?.();
const voices = new ep.UserVoices(v, set, runtimeDir, modelsDir);
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

async function read(pcm, lang) {
  const stream = await set.engines.asr.open(lang === "pt" ? "pt-BR" : "en-US");
  const padded = new Float32Array(pcm.length + 16000);
  padded.set(pcm, 0);
  for (let off = 0; off < padded.length; off += 512) await stream.accept(padded.subarray(off, Math.min(padded.length, off + 512)));
  await stream.flush?.();
  const res = await stream.finish();
  stream.dispose();
  return res.text ?? "";
}

const splits = splitArg === "both" ? ["dev", "heldout"] : [splitArg];
const langs = langArg === "both" ? ["en", "pt"] : [langArg];
const table = new Map(); // phrase -> { ok, n, bad: [] }
for (const split of splits) {
  for (const lang of langs) {
    for (const voice of ep.VOICES[split][lang]) {
      for (const sc of ep.SCENARIOS[lang]) {
        for (const [text, slot] of sc.corrections) {
          const spoken = await voices.say(text, voice);
          const heard = await read(rig.setActiveRmsDb(spoken.pcm, -27), lang);
          const key = `${lang}|${slot}|${text}`;
          const row = table.get(key) ?? { ok: 0, n: 0, bad: [] };
          row.n++;
          if (norm(heard).includes(norm(slot))) row.ok++;
          else row.bad.push(`${split}/${voice}: ${heard}`);
          table.set(key, row);
        }
      }
    }
  }
}
for (const [key, row] of [...table.entries()].sort()) {
  console.log(`${key.padEnd(52)} ${row.ok}/${row.n}${row.bad.length ? "   MISREAD " + row.bad.join(" ; ") : ""}`);
}
await set.dispose();
process.exit(0);
