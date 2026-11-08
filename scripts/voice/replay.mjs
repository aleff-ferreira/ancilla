#!/usr/bin/env node
/**
 * Replays a recorded call through a real voice session with the real engines, at the pace of a microphone, and prints what
 * the session did and when. A call is recorded by starting the server with ANCILLA_VOICE_DEBUG=1: the audio it receives is
 * written, as raw 16 kHz mono 16-bit PCM, to <tmp>/ancilla-voice-debug/call-<id>.pcm (the file is the person's voice: it is
 * kept only for as long as the debug setting is on, and is yours to delete).
 *
 *   node scripts/voice/replay.mjs <file.pcm> [from-seconds] [to-seconds] --runtime <dir> --models <dir>
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const voice = (p) => require(path.join(root, "packages/server/dist/src/voice", p));

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const [file, fromArg, toArg] = positional;
const runtimeDir = flag("runtime");
const modelsDir = flag("models");
if (!file || !runtimeDir || !modelsDir) {
  console.error("usage: replay.mjs <file.pcm> [from-seconds] [to-seconds] --runtime <dir> --models <dir>");
  process.exit(2);
}

const { createSherpaEngines } = voice("engines/index.js");
const { VoiceSession } = voice("session.js");
const { ScriptedBrain, FakeHost } = voice("testing.js");
const { systemScheduler } = voice("scheduler.js");

const bytes = fs.readFileSync(file);
const all = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
const pcm = all.subarray(Math.floor(Number(fromArg ?? 0) * 16000), Math.min(all.length, Math.floor(Number(toArg ?? 1e9) * 16000)));

const set = createSherpaEngines({ runtimeDir, modelsDir }, { refine: true, log: (l) => console.log("[engine]", l) });
const t0 = performance.now();
const stamp = () => String(Math.round(performance.now() - t0)).padStart(6);
const session = new VoiceSession({
  engines: set.engines,
  brain: new ScriptedBrain(systemScheduler, () => ({ text: "Understood.", ttftMs: 100 })),
  host: new FakeHost(),
  scheduler: systemScheduler,
  send: (m) => {
    if (m.type !== "level") console.log(stamp(), m.type, JSON.stringify(m).slice(0, 110));
  },
  sendAudio: () => {},
  log: (l) => console.log(stamp(), "[log]", l),
  id: "replay",
  config: { debug: true },
});
await session.start({ type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null });
console.log(stamp(), "started");
const start = performance.now();
for (let i = 0, k = 0; i < pcm.length; i += 512, k++) {
  const wait = start + k * 32 - performance.now();
  if (wait > 1) await new Promise((r) => setTimeout(r, wait));
  const frame = pcm.subarray(i, i + 512);
  session.onAudio(frame.length === 512 ? frame : Int16Array.from([...frame, ...new Array(512 - frame.length).fill(0)]));
}
await new Promise((r) => setTimeout(r, 3000));
console.log(stamp(), "last recogniser result", JSON.stringify(set.asr.lastResult));
await session.close("replay done");
await set.dispose();
process.exit(0);
