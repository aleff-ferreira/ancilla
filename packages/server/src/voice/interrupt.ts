import { isBackchannel, isStopIntent, wordsOf } from "./text.js";

/**
 * Spoken interruption, decided in two steps. Nothing here touches audio, a clock or the network: every call carries its own
 * time (milliseconds on the microphone's clock, counted in samples), what the microphone and the assistant's own voice
 * sounded like in that frame, and what the recogniser has heard, so a recorded call replays exactly and the same logic can
 * sit behind any host that can hand it those numbers and carry out what it answers (`InterruptCommand`).
 *
 * Why two steps. The recogniser needs the whole of a short word before it can write it down (measured: 0.7 s after the
 * start of "Stop" on a 160 ms streaming model), long after the word is over. Deciding earlier than that is deciding blind:
 * a cough, a "mm-hm" or the assistant's own voice coming back cannot be told from "Stop" by sound alone. So:
 *
 *  1. When the microphone carries speech-like sound that the assistant's own voice does not explain, the assistant's voice
 *     is PAUSED, at once, keeping its place. This is cheap and undoable.
 *  2. What the sound says then decides: a stop word cuts the reply off, words of any other kind are the person taking the
 *     floor, a sound of listening or the assistant's own words coming back ends the pause and the voice goes on from the
 *     same place, and a sound with no words in it does the same. A pause that nothing decides ends by itself.
 *
 * Nothing is cancelled by sound alone. Whether a task is cancelled is not decided here at all.
 */

export interface InterruptConfig {
  /** Length of one frame. */
  frameMs: number;
  /** Frames of sound the assistant's own voice does not explain, in a row, before the voice is paused. */
  pauseFrames: number;
  /** Lowest speech probability at which a frame can be the person (the soft detector: pausing costs little and is undone). */
  evidenceProb: number;
  /** The microphone must be this many times louder than the assistant's own voice would make it. */
  excessRatio: number;
  /** Words that look like the assistant's own are taken for its echo only while the sound is less than this many times louder than its voice would make it. */
  echoExcessMax: number;
  /** A frame quieter than this (RMS, 0 to 1) is never the person. */
  minRms: number;
  /** How long the host may keep the voice paused without hearing from the judge again; the judge says so again before then. */
  pauseLeaseMs: number;
  /** A pause that the sound still goes on in may last this long at most. */
  pauseMaxMs: number;
  /** A pause that nothing has decided ends after this long, once the sound has stopped. */
  pauseIdleMs: number;
  /** Quiet this long ends the sound: the recogniser is asked for its final reading. */
  burstEndQuietMs: number;
  /** How long to wait for that reading when the recogniser cannot say when it has given it. */
  finalWaitMs: number;
  /** And when it can: only a safety, for a recogniser that never answers. */
  ackWaitMs: number;
  /** Words that last at least this long, that are not a sound of listening, are the person taking the floor. */
  speechMinMs: number;
  /** Sound quieter than this fraction of how loud the person has been speaking in the call is not them (a television in the next room). */
  foregroundShare: number;
  /** After a pause that came to nothing, this long the next one needs more evidence. */
  cooldownMs: number;
  /** How far before the first frame of sound the audio handed to the recogniser starts. */
  preRollMs: number;
  /** The least a word takes to say: a reading with more words than the sound has room for is not believed. */
  msPerWord: number;
}

export const DEFAULT_INTERRUPT_CONFIG: InterruptConfig = {
  frameMs: 32,
  pauseFrames: 2,
  evidenceProb: 0.4,
  excessRatio: 2.2,
  echoExcessMax: 6,
  minRms: 0.004,
  pauseLeaseMs: 1500,
  pauseMaxMs: 4000,
  pauseIdleMs: 1400,
  burstEndQuietMs: 160,
  // The accurate model's reading of the sound takes about 0.2 s on an idle machine and several times that on a busy one (a
  // model running beside it, three calls at once in the measurements): giving up too early reads a stop as nothing.
  finalWaitMs: 900,
  ackWaitMs: 4000,
  speechMinMs: 224,
  foregroundShare: 0.15,
  cooldownMs: 600,
  // Long enough that the stretch handed to the recogniser, with the sound and the quiet that follows it, is more than the
  // 0.6 s under which the recogniser's worker does not ask the accurate model to read it (measured: a 0.3 s "Wait" in a
  // stretch of 0.5 s was read as nothing, and as "Wait." once the stretch was 0.8 s).
  preRollMs: 480,
  msPerWord: 110,
};

export interface InterruptObservation {
  /** The end of the frame, in milliseconds on the microphone's clock. */
  t: number;
  /** How likely the frame is speech, 0 to 1. */
  prob: number;
  /** How loud the microphone is after echo cancellation (RMS, 0 to 1). */
  rms: number;
  /** How loud the assistant's own voice is at the speaker now (RMS, 0 to 1); 0 when silent, null when not known. */
  ref: number | null;
}

export type ResumeReason = "backchannel" | "echo" | "distant" | "no-words" | "timeout" | "agent-stopped";
export type InterruptReason = "stop-word" | "speech";

/** What the host is asked to do. */
export type InterruptCommand =
  /** Start reading the sound as words; `audioFrom` is where it begins, a little early. */
  | { type: "open"; t: number; audioFrom: number }
  /** Silence the assistant's voice now and keep its place; `leaseMs` is how long it may stay silent without being told again. */
  | { type: "pause"; t: number; leaseMs: number; renewal: boolean }
  /** Bring the voice back from where it stopped: the sound was not for the assistant. */
  | { type: "resume"; t: number; reason: ResumeReason; text: string }
  /** The person has the floor: cut the assistant off and take what they say as a turn that began at `from`. */
  | { type: "interrupt"; t: number; reason: InterruptReason; from: number; audioFrom: number; voicedMs: number; text: string }
  /**
   * Ask the recogniser for its final reading of the sound so far. When it has given it, say so with `settled(t, seq)`, if it can
   * (`expectAck(true)` first); otherwise the words that come are taken as the last ones when `finalWaitMs` have gone by.
   */
  | { type: "settle"; t: number; seq: number }
  /** Stop reading the sound. */
  | { type: "close"; t: number }
  /** A sound of listening, noted. */
  | { type: "backchannel"; t: number; text: string };

export interface InterruptDeps {
  /** Whether the words are the assistant's own voice coming back. */
  looksLikeEcho(text: string): boolean;
}

const ANSWER_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright",
  "sim", "claro", "isso", "pode", "beleza",
  "si", "sí", "vale", "dale",
]);

/** What a recogniser writes for a cough, a throat cleared or a hesitation: sounds, not something said to the assistant. */
const NONVERBAL = new Set([
  "ahem", "uh", "um", "uhm", "hmm", "hm", "mm", "mmm", "ugh", "erm", "er", "ah", "eh", "ahn", "hum", "hã", "tsk", "huh", "oh",
  // what a recogniser likes to write over a stretch of non-speech, and what a person says to acknowledge: neither asks for anything
  "thank", "thanks", "you", "obrigado", "obrigada", "valeu",
]);
/** Single words a recogniser invents out of noise; as the whole of a sound they are not words said to the assistant either. */
const JUNK = new Set(["the", "a", "an", "and", "of", "to", "in", "it", "is", "i", "o", "e", "de", "que"]);

/** Frames of sound it takes to tell a voice far away from the person: the median loudness of what has been heard so far. */
const MIN_DISTANT_FRAMES = 8;
/** The most frames of a sound whose loudness is kept (about 4 s). */
const MAX_SOUND_FRAMES = 128;

function bareWords(text: string): string[] {
  return wordsOf(text).map((w) => w.replace(/[^\p{L}\p{N}ã]/gu, "")).filter((w) => w !== "");
}

/** The words that mean "be quiet" by themselves, and the words that may stand beside them without adding anything to ask. */
const STOP_CORE = new Set([
  "stop", "wait", "hold", "pause", "enough", "quiet", "silence", "shush",
  "pare", "para", "parar", "pára", "espera", "espere", "calma", "chega", "peraí", "perai", "pera", "silêncio", "silencio",
  "detente", "basta", "calla", "espérate",
]);
const STOP_FILLER = new Set([
  "on", "up", "it", "that", "thats", "is", "now", "please", "just", "okay", "ok", "alright", "one", "second", "sec", "a", "moment", "talking", "talk", "speaking", "be", "um", "uh",
  "já", "ja", "aí", "ai", "por", "favor", "agora", "de", "falar", "falando", "mais", "um", "segundo", "ya", "hablar", "hablando",
]);

/** A stop and nothing else ("Stop.", "Hold on a second", "Okay, stop", "Pare de falar"): words that ask for nothing to answer. */
export function isPureStop(text: string): boolean {
  const words = bareWords(text).map((w) => w.toLowerCase());
  return words.length >= 1 && words.length <= 5 && words.every((w) => STOP_CORE.has(w) || STOP_FILLER.has(w)) && words.some((w) => STOP_CORE.has(w));
}

/** Sounds of that kind and nothing else. */
export function isNonVerbal(text: string): boolean {
  const words = bareWords(text);
  return words.length > 0 && words.length <= 3 && words.every((w) => NONVERBAL.has(w.toLowerCase()));
}

/** "Yes" and "Sim" are answers, not sounds of listening, when the assistant has just asked something. */
export function isPolarityAnswer(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/^[.,!?;:¡¿\s]+|[.,!?;:¡¿\s]+$/g, "");
  return ANSWER_WORDS.has(clean);
}

/**
 * What the assistant's own voice puts into the microphone, learned while it speaks alone: the ratio of the microphone's
 * loudness to the voice's, over the last second or two, kept as an upper envelope. Sound clearly above that is someone else.
 */
export class EchoModel {
  private readonly ratios: number[] = [];
  private coupling = 0.05;
  constructor(private readonly keep = 48) {}

  /** A frame that is not the person, while the assistant's voice is loud enough to measure. */
  learn(rms: number, ref: number): void {
    if (ref < 0.01) return;
    this.push(rms / ref);
  }

  /** A sound that was found to be the voice's own echo after all: its mean ratio, with a margin, outweighs what was assumed. */
  learnBurst(ratio: number): void {
    for (let i = 0; i < 8; i++) this.push(ratio * 1.25);
  }

  private push(ratio: number): void {
    this.ratios.push(ratio);
    while (this.ratios.length > this.keep) this.ratios.shift();
    if (this.ratios.length >= 8) {
      const sorted = [...this.ratios].sort((a, b) => a - b);
      this.coupling = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] as number;
    }
  }

  /** The loudness the voice alone would give the microphone. */
  expected(ref: number): number {
    return this.coupling * ref;
  }

  reset(): void {
    this.ratios.length = 0;
    this.coupling = 0.05;
  }
}

/**
 * How loud the assistant's own voice is at the speaker at a given moment, from what was sent (a level for every stretch of
 * audio) and what the page says it has played (a sample count, with the time it said so). Time is passed in, never read.
 * Between two reports the voice is taken to play in real time; while it is paused, it does not move.
 */
export class PlayoutLevels {
  private readonly pieces: Array<{ utterance: number; from: number; to: number; rms: number }> = [];
  private report: { utterance: number; samples: number; at: number } | null = null;
  private firstSentAt: number | null = null;
  private pausedAt: number | null = null;

  /** `rate` is the samples a second of the audio sent; `lagMs` is how long its sound takes from the speaker to the microphone. */
  constructor(
    private readonly rate: number,
    private readonly lagMs = 120,
  ) {}

  /** A stretch of audio was sent: its first sample, its end, how loud it is, and when. */
  add(utterance: number, from: number, to: number, rms: number, at: number): void {
    if (this.firstSentAt === null) this.firstSentAt = at;
    this.pieces.push({ utterance, from, to, rms });
    while (this.pieces.length > 400) this.pieces.shift();
  }

  /** The page said it had played `samples` of `utterance`, at time `at`. */
  reported(utterance: number, samples: number, at: number): void {
    this.report = { utterance, samples, at };
  }

  pause(at: number): void {
    if (this.pausedAt === null) this.pausedAt = at;
  }

  resume(at: number): void {
    if (this.pausedAt !== null && this.report) this.report = { ...this.report, samples: this.positionAt(this.pausedAt), at };
    this.pausedAt = null;
  }

  clear(): void {
    this.pieces.length = 0;
    this.report = null;
    this.firstSentAt = null;
    this.pausedAt = null;
  }

  private positionAt(at: number): number {
    if (this.report) return this.report.samples + Math.max(0, ((at - this.report.at) * this.rate) / 1000);
    if (this.firstSentAt === null) return 0;
    return Math.max(0, ((at - this.firstSentAt - 40) * this.rate) / 1000);
  }

  /** The loudest the voice was in the last stretch the microphone could still be hearing; 0 when it is quiet or paused. */
  levelAt(at: number): number {
    if (this.pieces.length === 0) return 0;
    const paused = this.pausedAt !== null;
    if (paused && at - (this.pausedAt as number) > 240) return 0;
    const now = this.positionAt(paused ? (this.pausedAt as number) : at);
    const from = now - (this.lagMs * this.rate) / 1000;
    let level = 0;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i] as { utterance: number; from: number; to: number; rms: number };
      if (this.report && p.utterance !== this.report.utterance) continue;
      if (p.to < from) break;
      if (p.from <= now && p.rms > level) level = p.rms;
    }
    return level;
  }
}

type Phase = "idle" | "paused";

export class InterruptJudge {
  private phase: Phase = "idle";
  private speaking = false;
  private expectAnswer = false;

  private readonly echo = new EchoModel();
  private floor = 0.002;
  /** How loud the person has been speaking in this call (RMS, 0 to 1), once the call knows; 0 until then. */
  private foreground = 0;

  // Evidence before the pause.
  private evidence = 0;
  private evidenceStart = 0;
  private cooldownUntil = -Infinity;

  // The pause and the sound that caused it.
  private pausedAt = 0;
  private leaseSentAt = 0;
  private burstStart = 0;
  private voicedMs = 0;
  private lastEvidenceT = 0;
  private quietMs = 0;
  private text = "";
  private settleAt: number | null = null;
  private settleSeq = 0;
  private ackExpected = false;
  private ratioSum = 0;
  private ratioFrames = 0;
  /** The loudness of the frames of the sound being judged (RMS), to tell a person from a voice far away. */
  private soundRms: number[] = [];
  /** How far above what its own voice explains the sound has been, frame by frame (0 frames when the voice's level is not known). */
  private excessSum = 0;
  private excessFrames = 0;

  constructor(
    private readonly deps: InterruptDeps,
    private readonly cfg: InterruptConfig = DEFAULT_INTERRUPT_CONFIG,
  ) {}

  get paused(): boolean {
    return this.phase === "paused";
  }

  /** Whether the assistant is speaking now; the judge only listens for an interruption while it is. */
  setSpeaking(speaking: boolean): void {
    if (!speaking) this.reset();
    this.speaking = speaking;
  }

  /** Forgets any sound being judged, as when the microphone was muted or the turn-taker was started afresh. */
  restart(speaking: boolean): void {
    this.reset();
    this.speaking = speaking;
  }

  /** The assistant has just asked something, or awaits approval: "yes" is an answer, not a sound of listening. */
  setExpectAnswer(expect: boolean): void {
    this.expectAnswer = expect;
  }

  /** How loud the person has been speaking in this call (RMS, 0 to 1): what is much quieter than that is not them. */
  setForeground(rms: number): void {
    this.foreground = rms;
  }

  /** Whether the recogniser will say when it has read out what was asked of it (so the wait is for that, not a guess). */
  expectAck(on: boolean): void {
    this.ackExpected = on;
  }

  /** The recogniser has read out the last words of the sound that `seq` asked for. */
  settled(t: number, seq: number): InterruptCommand[] {
    if (this.phase !== "paused" || this.settleAt === null || seq !== this.settleSeq) return [];
    const decided = this.judge(t, true);
    return decided.length > 0 ? decided : this.endPause(t, "no-words");
  }

  private reset(): void {
    this.phase = "idle";
    this.ackExpected = false;
    this.evidence = 0;
    this.text = "";
    this.settleAt = null;
    this.voicedMs = 0;
    this.quietMs = 0;
    this.ratioSum = 0;
    this.ratioFrames = 0;
    this.soundRms = [];
    this.excessSum = 0;
    this.excessFrames = 0;
  }

  /** Whether the sound being judged is, all in all, far quieter than the person has been: a voice in the next room, not them. */
  private isDistant(): boolean {
    if (this.foreground < 0.02 || this.soundRms.length < MIN_DISTANT_FRAMES) return false;
    const sorted = [...this.soundRms].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] as number;
    return median < this.foreground * this.cfg.foregroundShare;
  }

  /** The mean of how many times louder than its own voice would make it the sound has been; 0 when that is not known. */
  private meanExcess(): number {
    return this.excessFrames === 0 ? 0 : this.excessSum / this.excessFrames;
  }

  /** One frame of the microphone. */
  frame(obs: InterruptObservation): InterruptCommand[] {
    const out: InterruptCommand[] = [];
    const cfg = this.cfg;
    const known = obs.ref !== null;
    const refLevel = obs.ref ?? 0;
    // The noise floor: frames with no speech in them and no voice of the assistant's to explain them.
    if (obs.prob < 0.3 && refLevel < 0.01) this.floor = Math.max(0.0008, this.floor * 0.97 + obs.rms * 0.03);
    const explained = known ? Math.max(this.echo.expected(refLevel), this.floor) : this.floor;
    const loud =
      obs.rms >= cfg.minRms &&
      obs.rms >= explained * cfg.excessRatio &&
      obs.rms >= this.floor * 2.5 &&
      (this.foreground < 0.02 || obs.rms >= this.foreground * cfg.foregroundShare);
    // Without a reference nothing separates the assistant's voice from the person's but how sure the detector is.
    const isEvidence = obs.prob >= (known ? cfg.evidenceProb : 0.62) && loud;

    if (!this.speaking) {
      this.evidence = 0;
      return out;
    }

    if (this.phase === "idle") {
      if (!isEvidence) {
        if (known) this.echo.learn(obs.rms, refLevel);
        this.evidence = 0;
        return out;
      }
      if (this.evidence === 0) this.evidenceStart = obs.t - cfg.frameMs;
      this.evidence++;
      if (known) {
        this.excessSum += obs.rms / explained;
        this.excessFrames++;
      }
      const need = obs.t < this.cooldownUntil ? cfg.pauseFrames + 2 : cfg.pauseFrames;
      if (this.evidence < need) return out;
      this.phase = "paused";
      this.pausedAt = obs.t;
      this.leaseSentAt = obs.t;
      this.burstStart = this.evidenceStart;
      this.voicedMs = this.evidence * cfg.frameMs;
      this.lastEvidenceT = obs.t;
      this.quietMs = 0;
      this.text = "";
      this.settleAt = null;
      out.push({ type: "open", t: obs.t, audioFrom: Math.max(0, this.burstStart - cfg.preRollMs) });
      out.push({ type: "pause", t: obs.t, leaseMs: cfg.pauseLeaseMs, renewal: false });
      return out;
    }

    // Paused: the sound goes on, or ends, or the reading arrives.
    if (known && refLevel >= 0.01) {
      this.ratioSum += obs.rms / refLevel;
      this.ratioFrames++;
    }
    if (isEvidence && known) {
      this.excessSum += obs.rms / explained;
      this.excessFrames++;
    }
    // The sound is found strictly and followed loosely: the tail of a word is quieter than its start, and a word that is
    // counted as over before it is must not be read before it is whole.
    const sound = obs.prob >= 0.3 && obs.rms >= Math.max(cfg.minRms * 0.6, this.floor * 1.8);
    if (sound) {
      this.voicedMs += cfg.frameMs;
      this.lastEvidenceT = obs.t;
      this.quietMs = 0;
      this.settleAt = null; // the person went on: the final reading has to wait for the end of the sound
      if (this.soundRms.length < MAX_SOUND_FRAMES) this.soundRms.push(obs.rms);
      // A loud syllable of a distant voice can start the pause; the rest of what it says shows it is not the person.
      if (this.isDistant()) return this.endPause(obs.t, "distant");
    } else {
      this.quietMs += cfg.frameMs;
    }
    const decided = this.judge(obs.t, false);
    if (decided.length > 0) return decided;
    if (this.quietMs >= cfg.burstEndQuietMs && this.settleAt === null) {
      this.settleAt = obs.t;
      this.settleSeq++;
      this.ackExpected = false; // until the host says its recogniser will answer
      out.push({ type: "settle", t: obs.t, seq: this.settleSeq });
    }
    if (this.settleAt !== null && obs.t - this.settleAt >= (this.ackExpected ? cfg.ackWaitMs : cfg.finalWaitMs)) {
      const last = this.judge(obs.t, true);
      return last.length > 0 ? last : this.endPause(obs.t, "no-words");
    }
    const age = obs.t - this.pausedAt;
    if (age >= cfg.pauseMaxMs || (this.quietMs >= cfg.pauseIdleMs && this.settleAt === null)) {
      return [...out, ...this.endPause(obs.t, "timeout")];
    }
    if (obs.t - this.leaseSentAt >= cfg.pauseLeaseMs / 2) {
      this.leaseSentAt = obs.t;
      out.push({ type: "pause", t: obs.t, leaseMs: cfg.pauseLeaseMs, renewal: true });
    }
    return out;
  }

  /**
   * The recogniser's reading of the sound: so far (`final` false), or all of it (`final` true). A reading that arrives after
   * the sound has ended and the recogniser was asked for its last (`settle`) is the last, whichever way it is said, unless
   * the recogniser says when it is done (`expectAck`).
   */
  transcript(t: number, text: string, final: boolean): InterruptCommand[] {
    if (this.phase !== "paused") return [];
    // (With a recogniser that says when it is done, it is `settled` that says the reading is the last, not the next words.)
    const last = final || (this.settleAt !== null && !this.ackExpected);
    // A recogniser that has just written something does not take it back for nothing, and the quiet after a word often
    // reads as an empty reading: what was written stands.
    if (text.trim() !== "") this.text = text.trim();
    const decided = this.judge(t, last);
    if (decided.length > 0) return decided;
    // The last reading is in and says nothing that decides: the sound was nothing to answer.
    return last && (text.trim() !== "" || this.text === "") ? this.endPause(t, "no-words") : [];
  }

  /**
   * What the words so far say. Returns the commands when the words decide it, and nothing otherwise. A stop word decides at
   * once; other words wait until there are enough of them to be sure, or until the last reading (a recogniser begins "I see"
   * with "I", and a person who says "yeah" does not mean the first word of a sentence).
   */
  private judge(t: number, final: boolean): InterruptCommand[] {
    const cfg = this.cfg;
    const text = this.text;
    if (text === "") return [];
    if (isStopIntent(text)) return this.takeFloor(t, "stop-word", text);
    // Its own words coming back are only a suspect when the sound is barely louder than its own voice would make it: a
    // person who repeats a name the assistant has just said ("no, call Marta, not Ana") is well above that.
    if (this.meanExcess() < cfg.echoExcessMax && this.deps.looksLikeEcho(text)) return this.endPause(t, "echo", text);
    const answer = this.expectAnswer && isPolarityAnswer(text);
    if ((isBackchannel(text) || isNonVerbal(text)) && !answer) {
      // "Okay" may be the first word of "Okay, stop": a sound of listening is a sound of listening only when it is all there is.
      return final ? [{ type: "backchannel", t, text }, ...this.endPause(t, "backchannel", text)] : [];
    }
    const words = bareWords(text);
    // More words than the sound is long enough to hold are not what was said (a recogniser's guess at a vocalisation).
    if (this.voicedMs < cfg.msPerWord * words.length) return [];
    if (words.length >= 3 && this.voicedMs >= cfg.speechMinMs) return this.takeFloor(t, "speech", text);
    // A single word that is not a stop is no reason to cut the voice off: a recogniser writes noise, a cough or a throat
    // cleared as one ("Fine."), and a person who wants the floor says more than that. (A one-word stop is decided above,
    // and a plain "yes" is an answer when something has been asked.)
    if (final && (answer || (words.length >= 2 && !words.every((w) => JUNK.has(w.toLowerCase()))))) return this.takeFloor(t, "speech", text);
    return [];
  }

  private takeFloor(t: number, reason: InterruptReason, text: string): InterruptCommand[] {
    const out: InterruptCommand[] = [
      { type: "interrupt", t, reason, from: this.burstStart, audioFrom: Math.max(0, this.burstStart - this.cfg.preRollMs), voicedMs: this.voicedMs, text },
    ];
    this.reset();
    this.speaking = false;
    return out;
  }

  private endPause(t: number, reason: ResumeReason, text = this.text): InterruptCommand[] {
    if (reason === "echo" && this.ratioFrames > 0) this.echo.learnBurst(this.ratioSum / this.ratioFrames);
    const out: InterruptCommand[] = [
      { type: "resume", t, reason, text },
      { type: "close", t },
    ];
    this.reset();
    this.cooldownUntil = t + this.cfg.cooldownMs;
    return out;
  }
}
