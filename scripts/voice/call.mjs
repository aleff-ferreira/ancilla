#!/usr/bin/env node
/**
 * A real call against a running Ancilla server, over its WebSocket, with the questions spoken by the voice engines
 * themselves. The server recognises the speech, finds the notes (by meaning too, when that is on), asks whatever model
 * is set for the voice, and answers aloud. This prints, for each question, what the server heard, what it answered and how
 * long after the end of the question the first sound of the answer arrived. It is the whole path, as a person would use
 * it, without a microphone.
 *
 *   node scripts/voice/call.mjs --runtime ~/voice-lab --models ~/voice-lab/models [--server http://127.0.0.1:3199] [--token T] ["a question|another one"]
 *
 * The voice pack must be installed (the questions are made with it) and the server built (npm run build --workspace
 * @ancilla/server). The call uses the server's own settings and notes: point it at a scratch data folder, not at the one
 * you use, since a call is kept as a conversation there. With a model that can start tasks, a question may start one.
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const voice = (p) => require(path.join(root, "packages/server/dist/src/voice", p));

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const flag = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const runtimeDir = flag("runtime");
const modelsDir = flag("models");
const server = new URL(flag("server", "http://127.0.0.1:3199"));
const token = flag("token");
if (!runtimeDir || !modelsDir) {
  console.error('usage: call.mjs --runtime <dir with node_modules/sherpa-onnx-node> --models <models dir> [--server http://127.0.0.1:3199] [--token T] ["a question|another one"]');
  process.exit(2);
}
const QUESTIONS = (positional[0] ?? "What time is it?|Tell me something short and kind.").split("|").map((q) => q.trim()).filter(Boolean);

let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  WebSocket = require(path.join(root, "packages/server/node_modules/ws"));
}
const { createSherpaEngines } = voice("engines/index.js");
const { PROTOCOL_VERSION, decodeAudioOut } = voice("protocol.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the questions, said by the engines' own voice and brought to the 16 kHz the call takes
const engines = createSherpaEngines({ runtimeDir, modelsDir }, { refine: false, log: () => undefined });
const tts = engines.engines.tts;
async function say(text) {
  const parts = [];
  const voiceId = (tts.voices.find((v) => v.lang === "en") ?? tts.voices[0]).id;
  for await (const chunk of tts.synthesize(text, { voice: voiceId, speed: 1, signal: new AbortController().signal })) parts.push(chunk);
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const ratio = tts.sampleRate / 16000;
  const out = new Int16Array(Math.floor(all.length / ratio));
  for (let k = 0; k < out.length; k++) {
    const pos = k * ratio;
    const i = Math.floor(pos);
    const f = pos - i;
    out[k] = Math.round(all[i] * (1 - f) + (all[Math.min(i + 1, all.length - 1)] ?? 0) * f);
  }
  return out;
}
const clips = [];
for (const q of QUESTIONS) clips.push({ q, pcm: await say(q) });
await engines.dispose();

// ---- the call
const events = [];
const played = new Map();
const url = new URL("/api/voice/ws", server);
url.protocol = server.protocol === "https:" ? "wss:" : "ws:";
const headers = { origin: server.origin, ...(token ? { authorization: `Bearer ${token}` } : {}) };
const ws = new WebSocket(url.href, { headers });
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    const decoded = decodeAudioOut(data);
    if (!decoded) return;
    const total = (played.get(decoded.utterance) ?? 0) + decoded.pcm.length;
    played.set(decoded.utterance, total);
    events.push({ t: performance.now(), type: "audio" });
    // The server truncates what it remembers of a reply to what was reported as played: report all of it, at once.
    ws.send(JSON.stringify({ type: "playback", utterance: decoded.utterance, samples: total }));
    return;
  }
  events.push({ t: performance.now(), ...JSON.parse(String(data)) });
});
await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
  ws.on("unexpected-response", (_req, res) => reject(new Error(`the server refused the call: ${res.statusCode}`)));
});
ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null }));

async function waitFor(predicate, ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(20);
  }
  return null;
}
if (!(await waitFor((e) => e.type === "ready", 60_000))) {
  console.error("The call did not open: no ready message in a minute (is the voice installed?).");
  process.exit(1);
}

const frame = (samples) => {
  const buf = Buffer.alloc(1 + samples.length * 2);
  buf[0] = 0x01;
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 1 + i * 2);
  return buf;
};
/** At the pace of a microphone: a frame of 512 samples every 32 ms. */
async function stream(pcm) {
  for (let at = 0; at < pcm.length; at += 512) {
    const slice = new Int16Array(512);
    slice.set(pcm.subarray(at, Math.min(pcm.length, at + 512)));
    ws.send(frame(slice), { binary: true });
    await sleep(32);
  }
}
const room = (ms) => {
  const pcm = new Int16Array(Math.round(ms * 16));
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round((Math.random() - 0.5) * 60); // a quiet room, not digital zero
  return pcm;
};

const firstSounds = [];
for (const { q, pcm } of clips) {
  const mark = events.length;
  await stream(room(600));
  await stream(pcm);
  const endedAt = performance.now();
  // Quiet while it answers: the text is complete before its sound has finished, so wait for the voice to end.
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline && !events.slice(mark).some((e) => e.type === "speak_end")) await stream(room(96));
  const mine = events.slice(mark);
  const heard = mine.filter((e) => e.type === "user").map((e) => e.text).join(" | ");
  const reply = mine.filter((e) => e.type === "assistant").pop();
  const first = mine.find((e) => e.type === "audio");
  if (first) firstSounds.push(first.t - endedAt);
  console.log(`\nQ: ${q}`);
  console.log(`   heard:   ${heard || "(nothing)"}`);
  console.log(`   answer:  ${reply ? reply.text : "(none)"}`);
  console.log(`   end of speech to first sound: ${first ? `${Math.round(first.t - endedAt)} ms` : "none"}`);
  await stream(room(800));
}
if (firstSounds.length > 1) {
  const sorted = [...firstSounds].sort((a, b) => a - b);
  console.log(`\nmedian ${Math.round(sorted[Math.floor(sorted.length / 2)])} ms over ${sorted.length} questions`);
}
ws.send(JSON.stringify({ type: "end" }));
await sleep(500);
ws.close();
process.exit(0);
