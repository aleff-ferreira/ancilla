#!/usr/bin/env node
// Runs the paired episodes (docs/voice-interrupt-evaluation.md) through one or more builds ("arms") of the voice session, in
// real time, with the real voice engines and a simulated page, and writes one JSON line per (episode, arm).
//
//   node scripts/voice/interrupt-eval/run.mjs --split heldout|dev --arm baseline=<built checkout> --arm pilot=<built checkout>:pilot
//        [--kinds stop,correction,control,ordinary] [--shard 0/1] [--limit N] [--echo off,-50,-40] [--only id,id]
//        [--runtime <dir with node_modules/sherpa-onnx-node>] [--models <voice models dir>] [--seed N] [--out file.jsonl]
//
// An arm is `name=<root>` (the voice code of that checkout, as it is), `name=<root>:pilot` (the same build with the
// spoken-interruption setting on and a page that can pause) or `name=<root>:tuned` (the shipped pipeline tuned by settings
// alone: the quick reading of the speech detector, sensitive thresholds for cutting in, no pause: what a tuned version of what
// shipped can do). The engines come from the pilot's build when there is one; `engines-equal.mjs` shows that its shipped paths
// are the baseline's. Time is the engine of the episode itself: nothing here reads the wall clock (the WSL clock of the
// development machine is stepped back every 30 s).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as rig from "./rig.mjs";
import * as ep from "./episodes.mjs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const all = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const split = flag("split", "heldout");
const arms = all("arm").map((s) => {
  const [name, spec] = s.split("=");
  const [root, mode] = spec.split(":");
  const pilot = mode === "pilot";
  const v = rig.loadVoice(root);
  const arm = { name, root, v, pause: pilot, sessionConfig: pilot ? { interruptPilot: true } : undefined, tuned: mode === "tuned" };
  if (arm.tuned) {
    arm.sessionConfig = { turn: { ...v.turn.DEFAULT_TURN_CONFIG, onsetFrames: 2, minSpeechMs: 96, bargeInProb: 0.4, bargeInMinMs: 96, bargeInNoTextMs: 160, duckAfterMs: 32 } };
  }
  return arm;
});
if (arms.length === 0) { console.error("need --arm name=root"); process.exit(2); }
const kinds = flag("kinds", "stop,correction,control").split(",");
const [shardI, shardN] = flag("shard", "0/1").split("/").map(Number);
const limit = Number(flag("limit", "1e9"));
const echoDbs = flag("echo", "off,-50,-40").split(",").map((s) => (s === "off" ? null : Number(s)));
const out = flag("out", null);
const seed = Number(flag("seed", "20261120"));
const only = flag("only", null)?.split(",") ?? null;
const runtimeDir = flag("runtime", process.env.ANCILLA_VOICE_RUNTIME ?? path.join(os.homedir(), "voice-lab"));
const modelsDir = flag("models", process.env.ANCILLA_VOICE_MODELS ?? path.join(runtimeDir, "models"));

// the engines come from the pilot's build (it has the quick reading of the detector; its `process` is the shipped one)
const engineArm = arms.find((a) => a.pause) ?? arms[0];
const set = engineArm.v.engines.createSherpaEngines({ runtimeDir, modelsDir }, { refine: true, log: () => undefined });
await set.engines.asr.warm?.();
await set.engines.tts.warm?.();
const voices = new ep.UserVoices(arms[0].v, set, runtimeDir, modelsDir);
// the tuned arm hears the same frames through the detector's quick reading
const quickVad = { id: "silero-vad-quick", frameSamples: set.engines.vad.frameSamples, process: (f) => set.engines.vad.processOnset(f), reset: () => set.engines.vad.reset() };
for (const a of arms) a.engines = a.tuned ? { ...set.engines, vad: quickVad } : set.engines;

class LateBrain {
  id = "late"; label = "Late"; capabilities = { tools: true, speculative: true, local: true }; requests = [];
  constructor(sched, script) { this.sched = sched; this.script = script; }
  async *stream(request) {
    this.requests.push({ messages: request.messages });
    const reply = this.script(request.messages, this.requests.length);
    await new Promise((r) => setTimeout(r, reply.ttftMs ?? 150)); // on purpose: the abort signal is ignored, as a model that cannot be interrupted would
    if (reply.tool) {
      yield { type: "tool", call: { id: `c${this.requests.length}`, name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } };
      yield { type: "done", reason: "tool" };
      return;
    }
    const text = reply.text ?? "";
    for (let i = 0; i < text.length; i += 8) { yield { type: "text", delta: text.slice(i, i + 8) }; await new Promise((r) => setTimeout(r, 20)); }
    yield { type: "done", reason: "stop" };
  }
}

const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function dipMs(duckLog, endMs) {
  // time during which the speaker was ducked or paused (on -> off)
  let total = 0, since = null, longest = 0;
  for (const d of duckLog) {
    if (d.on || d.paused) { if (since === null) since = d.t; }
    else if (since !== null) { const len = d.t - since; total += len; longest = Math.max(longest, len); since = null; }
  }
  if (since !== null) { total += endMs - since; longest = Math.max(longest, endMs - since); }
  return { total: Math.round(total), longest: Math.round(longest) };
}

function scoreRun(e, rendered, res) {
  const onset = res.userStartMs === null ? null : res.userStartMs + rendered.onsetMs;
  const refT = onset ?? ((res.firstAudioAt ?? 0) + e.afterFirstAudioMs);
  const o = { id: e.id, kind: e.kind, sub: e.sub, lang: e.lang, voice: e.voice, echoDb: e.echoDb, levelDb: Math.round(e.levelDb * 10) / 10, text: e.text ?? null, onset };
  o.firstAudioAt = res.firstAudioAt;
  o.interruptedAt = res.interruptedAt;
  o.interruptRel = res.interruptedAt === null ? null : res.interruptedAt - refT;
  const lastOld = rig.lastAudibleMs(res.speaker, res.speakerUtt, 1);
  o.lastOldRel = lastOld < 0 ? null : lastOld - refT;
  // was the old voice audible at the onset (a natural gap between two sentences leaves nothing to silence)?
  o.audibleAtOnset = rig.audibleBetween(res.speaker, res.speakerUtt, 1, refT - 30, refT + 100);
  const users = res.events.filter((x) => x.msg.type === "user" && x.msg.source === "voice").map((x) => ({ t: x.t, text: x.msg.text, turn: x.msg.turn }));
  o.userTurns = users.map((u) => `${Math.round(u.t - refT)}:${u.text}`);
  const assistant = new Map();
  for (const x of res.events) if (x.msg.type === "assistant") assistant.set(x.msg.turn, { t: x.t, text: x.msg.text, done: x.msg.done });
  o.assistantAfter = [...assistant.entries()].filter(([turn, a]) => a.t >= refT).map(([turn, a]) => `${Math.round(a.t - refT)}:${a.text.slice(0, 70)}`);
  const dips = dipMs(res.duckLog, res.endMs);
  o.dipMs = dips.total; o.dipLongest = dips.longest; o.duckEvents = res.duckLog.length;
  o.tools = res.toolLog.map((x) => ({ t: Math.round(x.t - refT), name: x.call.name, args: x.call.arguments }));
  o.fates = res.flights.map((f) => `${f.line.fate}[${(f.line.rules || []).join(",")}]`);
  o.brainRequests = res.brainRequests;
  const attributed = res.interruptedAt !== null && o.interruptRel >= -50;
  o.attributed = attributed;
  if (e.kind === "stop") {
    o.within350 = attributed && o.lastOldRel !== null && o.lastOldRel <= 350;
    o.success = attributed && o.lastOldRel !== null && o.lastOldRel <= 2000;
    o.selfInterrupt = res.interruptedAt !== null && o.interruptRel < -50;
  } else if (e.kind === "correction") {
    const slot = norm(e.slot);
    const heardSlot = users.some((u) => u.t >= refT - 50 && norm(u.text).includes(slot));
    const fixedReplies = [...assistant.values()].filter((a) => a.t >= refT && norm(a.text).includes(slot) && a.done);
    // A task started after the person began to correct belongs to the answer they were correcting (the only tool calls in
    // these episodes come from the first answer): whether or not an interruption was ever sent.
    const staleTool = res.toolLog.filter((x) => x.t >= refT);
    o.heardSlot = heardSlot; o.fixedReplies = fixedReplies.length; o.staleTools = staleTool.length;
    const dup = new Set(); let d = 0;
    for (const x of res.toolLog) { const k = `${x.call.name}|${x.call.arguments}`; if (dup.has(k)) d++; dup.add(k); }
    o.duplicateTasks = d;
    o.within350 = attributed && o.lastOldRel !== null && o.lastOldRel <= 350;
    o.success = attributed && o.lastOldRel !== null && o.lastOldRel <= 2000 && heardSlot && fixedReplies.length === 1 && staleTool.length === 0 && d === 0;
    o.selfInterrupt = res.interruptedAt !== null && o.interruptRel < -50;
  } else {
    const sinceT = refT - 100;
    o.falseCancel = res.interruptedAt !== null || users.some((u) => u.t >= sinceT);
    o.success = !o.falseCancel;
  }
  return o;
}

async function runOrdinary(arm, e, rendered) {
  // a question asked of an idle assistant: end of speech to the first sound of the answer
  const padded = new Float32Array(rendered.track.length + 16000 * 2);
  padded.set(rendered.track, 0);
  const res = await rig.runEpisode({
    v: arm.v, engines: arm.engines, userTrack: padded, prompt: null, userStartAtMs: 600,
    brainScript: () => ({ text: e.lang === "pt" ? "Claro. São quase três horas da tarde." : "Sure. It is almost three in the afternoon.", ttftMs: 150 }),
    echoDb: null, lang: e.lang === "pt" ? "pt-BR" : "en-US", maxMs: 20000, sessionConfig: arm.sessionConfig, pause: arm.pause,
    until: ({ firstAudioAt, now }) => firstAudioAt !== null && now - firstAudioAt > 600,
  });
  const o = { id: e.id, kind: "ordinary", sub: e.sub, lang: e.lang, voice: e.voice, text: e.text, levelDb: Math.round(e.levelDb * 10) / 10 };
  o.latencyMs = res.firstAudioAt === null ? null : Math.round(res.firstAudioAt - (res.userStartMs + rendered.speechEndMs));
  o.success = o.latencyMs !== null;
  o.answered = res.events.filter((x) => x.msg.type === "user" && x.msg.source === "voice").map((x) => x.msg.text).join("|");
  return o;
}

async function runEpisode(arm, e, rendered) {
  if (e.kind === "ordinary") return runOrdinary(arm, e, rendered);
  const sc = rendered.scenario;
  const trackLen = rendered.track ? rendered.track.length : 0;
  const padded = rendered.track ? new Float32Array(trackLen + 16000 * 3) : null;
  if (padded) padded.set(rendered.track, 0);
  const langTag = e.lang === "pt" ? "pt-BR" : "en-US";
  const tailMs = e.kind === "correction" ? 11000 : 4500;
  let brainOpt = {};
  let afterFirst = e.afterFirstAudioMs;
  if (e.kind === "correction" && e.lateBrain) {
    const script = (messages, call) => (call === 1 ? { tool: { name: "delegate_task", args: { title: sc.request, detail: sc.request } }, ttftMs: 4200 } : brainScript(messages, call));
    brainOpt = { brain: (sched) => new LateBrain(sched, script) };
    afterFirst = Math.round(150 + (e.afterFirstAudioMs % 500));
  }
  const brainScript = ep.brainScriptFor(e, rendered);
  const res = await rig.runEpisode({
    v: arm.v, engines: arm.engines, userTrack: padded,
    replyText: rendered.replyText, prompt: rendered.promptTrack ? null : rendered.prompt, promptTrack: rendered.promptTrack, brainScript,
    userAfterFirstAudioMs: afterFirst, echoDb: e.echoDb, echoDelayMs: 15, outLatMs: 25, lang: langTag,
    maxMs: 40000,
    sessionConfig: arm.sessionConfig,
    pause: arm.pause,
    ...brainOpt,
    until: ({ events, now, interruptedAt, firstAudioAt }) => {
      const us = events.find((x) => x.msg.type === "user_track_start");
      if (us) return now - us.t > Math.max(tailMs, trackLen / 16 + tailMs - 1500);
      return firstAudioAt !== null && now - firstAudioAt > e.afterFirstAudioMs + 4500;
    },
  });
  return scoreRun(e, rendered, res);
}

const plan = ep.planEpisodes({ split, seed, echoDbs }).filter((e) => kinds.includes(e.kind) && (only === null || only.includes(e.id)));
const mine = plan.filter((_, i) => i % shardN === shardI).slice(0, limit);
const sink = out ? fs.createWriteStream(out, { flags: "a" }) : null;
let k = 0;
for (const e of mine) {
  const rendered = await ep.renderEpisode(e, voices, seed);
  const order = k++ % 2 === 0 ? arms : [...arms].reverse();
  for (const arm of order) {
    const r = await runEpisode(arm, e, rendered);
    r.arm = arm.name;
    sink?.write(JSON.stringify(r) + "\n");
    const f = (x) => (x === null || x === undefined ? "-" : Math.round(x));
    if (e.kind === "ordinary") {
      console.log(`${e.id} ${arm.name.padEnd(8)} ordinary ${e.lang} ${e.voice} "${e.text}" latency=${r.latencyMs} heard="${r.answered}"`);
      continue;
    }
    console.log(`${e.id} ${arm.name.padEnd(8)} ${e.kind}/${e.sub} ${e.lang} ${e.voice} "${e.text ?? ""}" lvl=${r.levelDb} echo=${e.echoDb} ok=${r.success} int=${f(r.interruptRel)} silenced=${f(r.lastOldRel)} dip=${r.dipMs}${r.falseCancel ? " FALSE-CANCEL" : ""} ${r.userTurns.join("|").slice(0, 50)}`);
  }
}
sink?.end();
await set.dispose();
process.exit(0);
