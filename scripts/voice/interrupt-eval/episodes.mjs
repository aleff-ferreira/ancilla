// The paired synthetic episodes: what the person says over a long reply, and what the right outcome is.
// Deterministic from a seed. Voices: `dev` voices are for tuning; `heldout` voices (other Supertonic styles and Kokoro, a
// different model family) are never looked at while tuning.
import { createRequire } from "node:module";
import * as rig from "./rig.mjs";

export const VOICES = {
  dev: { en: ["en:F2", "en:M2", "en:F3", "en:M3"], pt: ["pt:F2", "pt:M2", "pt:F3", "pt:M3"] },
  heldout: {
    en: ["en:F4", "en:F5", "en:M4", "en:M5", "kokoro-us:3", "kokoro-us:16", "kokoro-gb:21", "kokoro-gb:26"],
    pt: ["pt:F4", "pt:F5", "pt:M4", "pt:M5"],
  },
};

// small deterministic PRNG
export function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length) % xs.length];

export const STOPS = {
  en: ["Stop.", "Stop it.", "Wait.", "Hold on.", "Enough.", "Okay, stop.", "Pause.", "That's enough."],
  pt: ["Pare.", "Para.", "Pare aí.", "Espera.", "Peraí.", "Calma.", "Chega.", "Já chega."],
};
export const BACKCHANNELS = {
  en: ["Yeah.", "Uh-huh.", "Right.", "Okay.", "Mm-hm.", "I see."],
  pt: ["Aham.", "Uhum.", "Sim.", "É.", "Entendi.", "Certo."],
};
/** Ordinary turns, nobody interrupting: the latency to the first useful audio must not grow. */
export const QUESTIONS = {
  en: ["What time is it in Lisbon?", "Can you tell me how tall the Eiffel Tower is?", "What is the capital of Portugal?", "How many days are there in February this year?", "Remind me what a prime number is."],
  pt: ["Que horas são em Lisboa?", "Quanto mede a Torre Eiffel?", "Qual é a capital de Portugal?", "Quantos dias tem fevereiro este ano?", "Me lembra o que é um número primo."],
};
export const OTHER_TALK = {
  en: ["Did you remember to call the plumber about the kitchen sink this morning?", "I think the meeting moved to three o'clock, but let me check my calendar again."],
  pt: ["Você lembrou de ligar para o encanador por causa da pia da cozinha hoje de manhã?", "Acho que a reunião mudou para as três horas, mas deixa eu olhar a agenda de novo."],
};

/** The scenarios of the corrections: a request, the long answer being spoken, corrections with the word that must reach the model. */
export const SCENARIOS = {
  en: [
    { request: "Book a table for Monday at eight.", reply: "Sure. I'll book a table for Monday at eight in the evening for two people. While I take care of that, let me tell you a little about the place. It is a small restaurant near the river, with a quiet terrace and a short menu that changes every week. They are known for the grilled fish and for a dessert made with oranges. I will confirm the booking in a moment, and send you the address as well.", fixed: (d) => `Done. A table for ${d} at eight.`, corrections: [["No, I meant Tuesday.", "tuesday"], ["Actually, make it Wednesday.", "wednesday"], ["Sorry, not Monday, Friday.", "friday"], ["No, Thursday.", "thursday"]] },
    { request: "Remind me to call Anna on Monday at five.", reply: "Of course. I'll set a reminder to call Anna on Monday at five in the afternoon. In the meantime, here is what is on your calendar. You have a call with the design team at two, a review of the budget at three thirty, and nothing else after that. I can also move the review earlier if you would like some free time before the reminder goes off.", fixed: (d) => `Okay. I'll remind you to call Anna on ${d} at five.`, corrections: [["No, I meant Tuesday.", "tuesday"], ["Actually, make it Wednesday.", "wednesday"], ["Sorry, not Monday, Friday.", "friday"], ["No, Thursday.", "thursday"]] },
  ],
  pt: [
    { request: "Reserve uma mesa para segunda às oito.", reply: "Claro. Vou reservar uma mesa para segunda às oito da noite para duas pessoas. Enquanto cuido disso, deixa eu contar um pouco sobre o lugar. É um restaurante pequeno perto do rio, com um terraço tranquilo e um cardápio curto que muda toda semana. Eles são conhecidos pelo peixe grelhado e por uma sobremesa feita com laranja. Vou confirmar a reserva em um instante e mandar o endereço também.", fixed: (d) => `Pronto. Uma mesa para ${d} às oito.`, corrections: [["Não, eu quis dizer terça.", "terça"], ["Na verdade, quarta.", "quarta"], ["Espera, não segunda, sexta.", "sexta"], ["Não, quinta.", "quinta"]] },
    { request: "Me lembre de ligar para a Ana às cinco.", reply: "Claro. Vou criar um lembrete para ligar para a Ana às cinco da tarde de hoje. Enquanto isso, aqui está o que tem na sua agenda. Você tem uma chamada com o time de design às duas, uma revisão do orçamento às três e meia, e mais nada depois disso. Também posso antecipar a revisão se você quiser ter um tempo livre antes do lembrete tocar.", fixed: (d) => `Certo. Vou lembrar você de ligar para ${d} às cinco.`, corrections: [["Não, eu quis dizer Bruno.", "bruno"], ["Espera, não a Ana, o Bruno.", "bruno"], ["Na verdade, ligar para a Marta.", "marta"], ["Não, o Pedro.", "pedro"]] },
  ],
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- non-speech sounds (synthetic: honest limit, there is no recording of a cough here)
function bandNoise(r, n, lowHz, highHz) {
  // one-pole high-pass then low-pass of white noise
  const out = new Float32Array(n);
  let hp = 0, lp = 0;
  const aH = Math.exp((-2 * Math.PI * lowHz) / 16000), aL = Math.exp((-2 * Math.PI * highHz) / 16000);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = r() * 2 - 1;
    hp = aH * (hp + x - prev);
    prev = x;
    lp = aL * lp + (1 - aL) * hp;
    out[i] = lp;
  }
  return out;
}
export function genCough(r, bursts = 2) {
  const parts = [];
  for (let b = 0; b < bursts; b++) {
    const n = Math.round(16 * (110 + r() * 120));
    const noise = bandNoise(r, n, 300, 3800);
    const f0 = 120 + r() * 60;
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 160) * Math.exp((-3.2 * i) / n);
      noise[i] = env * (noise[i] * 1.2 + 0.35 * Math.sin((2 * Math.PI * f0 * i) / 16000));
    }
    parts.push(noise, new Float32Array(Math.round(16 * (70 + r() * 130))));
  }
  const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}
export function genClicks(r, n = 5) {
  const out = new Float32Array(16000 * 1.2);
  for (let k = 0; k < n; k++) {
    const at = Math.round(16000 * (0.05 + k * 0.2 + r() * 0.05));
    for (let i = 0; i < 80; i++) out[at + i] += (r() * 2 - 1) * Math.exp(-i / 14);
  }
  return out;
}

// ---------- synthesis of the user's voice
export class UserVoices {
  constructor(v, set, runtimeDir, modelsDir) {
    this.v = v;
    this.tts = set.engines.tts;
    this.runtimeDir = runtimeDir;
    this.modelsDir = modelsDir;
    this.kokoro = {};
    this.cache = new Map();
  }
  kokoroTts(kind) {
    if (this.kokoro[kind]) return this.kokoro[kind];
    const require = createRequire(`${this.runtimeDir}/`);
    const sherpa = require("sherpa-onnx-node");
    const K = `${this.modelsDir}/kokoro-int8-multi-lang-v1_0`;
    const t = new sherpa.OfflineTts({
      model: { kokoro: { model: `${K}/model.int8.onnx`, voices: `${K}/voices.bin`, tokens: `${K}/tokens.txt`, lexicon: `${K}/lexicon-${kind === "kokoro-gb" ? "gb" : "us"}-en.txt` }, debug: false, numThreads: 2, provider: "cpu" },
      maxNumSentences: 1,
    });
    this.kokoro[kind] = t;
    return t;
  }
  /** Float32 at 16 kHz, speech trimmed to 20 ms before its first energy; returns {pcm, onsetMs}. */
  async say(text, voiceId) {
    const key = `${voiceId}|${text}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let f16;
    if (voiceId.startsWith("kokoro")) {
      const [kind, sid] = voiceId.split(":");
      const audio = this.kokoroTts(kind).generate({ text, sid: Number(sid), speed: 1.0 });
      f16 = rig.resampleTo16k(Int16Array.from(audio.samples, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767)), audio.sampleRate);
    } else {
      f16 = await rig.synth(this.tts, text, voiceId);
    }
    const out = rig.trimLead(f16, 20);
    this.cache.set(key, out);
    return out;
  }
}

/**
 * The 120 episodes: 40 stops, 40 corrections, 40 controls, half English and half Portuguese, voices from `split`.
 * `echoDbs` is the set of residual-echo levels the episodes are spread over (null = a perfect canceller).
 */
export function planEpisodes({ split = "heldout", seed = 20261120, echoDbs = [null, -50, -40], count = { stop: 40, correction: 40, control: 40, ordinary: 40 } } = {}) {
  const r = prng(seed);
  const eps = [];
  const voiceFor = (lang, i) => VOICES[split][lang][i % VOICES[split][lang].length];
  let n = 0;
  const base = (kind, lang, sub) => ({
    id: `${kind}-${String(n++).padStart(3, "0")}`,
    kind, sub, lang,
    echoDb: echoDbs[n % echoDbs.length],
    afterFirstAudioMs: Math.round(2200 + r() * 4300),
    levelDb: -26 + (r() * 8 - 5),
  });
  for (let i = 0; i < count.stop; i++) {
    const lang = i % 2 === 0 ? "en" : "pt";
    const e = base("stop", lang, "word");
    e.text = pick(r, STOPS[lang]);
    e.voice = voiceFor(lang, Math.floor(i / 2) + Math.floor(r() * 3));
    e.scenario = Math.floor(r() * SCENARIOS[lang].length);
    eps.push(e);
  }
  for (let i = 0; i < count.correction; i++) {
    const lang = i % 2 === 0 ? "en" : "pt";
    const sc = Math.floor(r() * SCENARIOS[lang].length);
    const [text, slot] = pick(r, SCENARIOS[lang][sc].corrections);
    // a quarter with a pause inside the correction ("No, ... I meant Tuesday"): said as two pieces with a gap
    const pause = i % 4 === 3;
    const e = base("correction", lang, pause ? "paused" : "plain");
    e.text = text;
    e.slot = slot;
    e.scenario = sc;
    e.voice = voiceFor(lang, Math.floor(i / 2) + Math.floor(r() * 3));
    e.pauseMs = pause ? Math.round(500 + r() * 400) : 0;
    // some corrections arrive while a task is being started (the late brain)
    e.lateBrain = i % 5 === 4;
    eps.push(e);
  }
  // 15 sounds of listening, 5 coughs, 5 throats cleared (said by the voice as "Ahem"), 5 echoes of the assistant's own voice,
  // 5 keyboard clicks and 5 stretches of distant speech (a television in another room: 24 dB below the person's own level)
  const subs = ["backchannel", "backchannel", "cough", "throatclear", "echo", "clicks", "backchannel", "background"];
  for (let i = 0; i < count.control; i++) {
    const lang = i % 2 === 0 ? "en" : "pt";
    const sub = subs[i % subs.length];
    const e = base("control", lang, sub);
    e.voice = voiceFor(lang, i + Math.floor(r() * 3));
    e.scenario = Math.floor(r() * SCENARIOS[lang].length);
    if (sub === "backchannel") e.text = pick(r, BACKCHANNELS[lang]);
    if (sub === "throatclear") e.text = lang === "en" ? "Ahem." : "Ahem.";
    if (sub === "background") { e.text = pick(r, OTHER_TALK[lang]); e.levelDb = -50; }
    if (sub === "cough") e.bursts = 1 + Math.floor(r() * 3);
    if (sub === "echo") { e.echoDb = pick(r, [-45, -40, -35]); }
    eps.push(e);
  }
  // ordinary turns come last, so that adding them never changes the draws of the others
  for (let i = 0; i < (count.ordinary ?? 0); i++) {
    const lang = i % 2 === 0 ? "en" : "pt";
    const e = base("ordinary", lang, "question");
    e.text = pick(r, QUESTIONS[lang]);
    e.voice = voiceFor(lang, i + Math.floor(r() * 3));
    e.scenario = 0;
    eps.push(e);
  }
  return eps;
}

/** The end of the last stretch of the track that is louder than -45 dBFS, in milliseconds. */
export function lastEnergyMs(track) {
  const w = 160;
  for (let at = track.length - w; at >= 0; at -= w / 2) {
    if (rig.dbfs(rig.rmsOf(track.subarray(at, at + w))) > -45) return (at + w) / 16;
  }
  return 0;
}

/** Audio for one planned episode: {track Float32|null, onsetMs (inside the track), parts?} */
export async function renderEpisode(ep, voices, seed = 7) {
  const r = prng((seed + ep.id.split("-")[1] * 7919) >>> 0);
  const sc = SCENARIOS[ep.lang][ep.scenario];
  const out = { replyText: sc.reply, prompt: sc.request, scenario: sc, track: null, onsetMs: 0, speechEndMs: 0, promptTrack: null };
  const level = (x) => rig.setActiveRmsDb(x, ep.levelDb);
  if (ep.kind !== "ordinary") {
    // the call begins as calls do: the person speaks, in their own voice and at their own level
    const spoken = await voices.say(sc.request, ep.voice);
    out.promptTrack = rig.setActiveRmsDb(spoken.pcm, ep.kind === "control" && ep.sub === "background" ? -26 : ep.levelDb);
  }
  if (ep.kind === "stop" || ep.kind === "ordinary" || (ep.kind === "control" && (ep.sub === "backchannel" || ep.sub === "background" || ep.sub === "throatclear"))) {
    const s = await voices.say(ep.text, ep.voice);
    out.track = level(s.pcm);
    out.onsetMs = s.onsetMs;
    out.speechEndMs = lastEnergyMs(out.track);
  } else if (ep.kind === "correction") {
    if (ep.pauseMs > 0) {
      // split at the first comma or space after the first word
      const m = /^(\S+?[,]?)\s+(.*)$/.exec(ep.text);
      const a = await voices.say(m ? m[1] : ep.text, ep.voice);
      const b = await voices.say(m ? m[2] : "", ep.voice);
      const gap = new Float32Array(Math.round((ep.pauseMs * 16)));
      const cat = new Float32Array(a.pcm.length + gap.length + b.pcm.length);
      cat.set(level(a.pcm), 0); cat.set(gap, a.pcm.length); cat.set(level(b.pcm), a.pcm.length + gap.length);
      out.track = cat;
      out.onsetMs = a.onsetMs;
    } else {
      const s = await voices.say(ep.text, ep.voice);
      out.track = level(s.pcm);
      out.onsetMs = s.onsetMs;
    }
  } else if (ep.sub === "cough") {
    const c = genCough(r, ep.bursts);
    out.track = rig.setActiveRmsDb(c, ep.levelDb);
    out.onsetMs = 0;
  } else if (ep.sub === "clicks") {
    out.track = rig.setActiveRmsDb(genClicks(r), ep.levelDb + 4);
    out.onsetMs = 0;
  } else {
    out.track = null; // echo only
  }
  return out;
}

export function brainScriptFor(ep, rendered) {
  const sc = rendered.scenario;
  const slots = sc.corrections.map(([, slot]) => slot);
  return (messages, call) => {
    const last = [...messages].reverse().find((m) => m.role === "user");
    // the person's own words: `content` carries the date and the state of the call in front of them (a weekday would match a slot)
    const text = String(last?.rawUserText ?? last?.content ?? "").toLowerCase();
    const hit = slots.find((s) => text.includes(s));
    if (ep.kind === "correction" && hit) return { text: sc.fixed(cap(hit)), ttftMs: 150 };
    if (call === 1) return { text: rendered.replyText, ttftMs: 150 };
    return { text: ep.lang === "pt" ? "Certo." : "Okay.", ttftMs: 150 };
  };
}
