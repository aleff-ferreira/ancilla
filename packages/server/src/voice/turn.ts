import { isBackchannel, isStopIntent, readCompleteness } from "./text.js";

/**
 * Who has the floor. It is fed what the audio says (a speech probability for every frame), what the recogniser heard so
 * far, and what the assistant is doing, and says when the person started to speak, when they have finished, and when
 * they are trying to cut the assistant off. It never touches audio and never reads a clock: every call carries its own
 * time, so a recorded conversation replays exactly.
 *
 * The choices that make a call feel natural are all here:
 *  - how long to wait after the person goes quiet depends on what they said: a finished sentence is answered quickly, a
 *    sentence that trails off on "and" or "um" is given time, a one-word command is answered at once;
 *  - a short sound of listening ("mm-hm") does not take the turn;
 *  - words that mean "stop" cut in at once, other speech after it is sustained and heard;
 *  - when the person starts to talk over the assistant, its voice is lowered first and stopped only when the interruption
 *    is confirmed, so a cough or an echo costs a dip and not a sentence.
 */

export interface TurnConfig {
  /** Length of one voice-activity frame. */
  frameMs: number;
  /** Probability from which a frame counts as speech, and under which it counts as quiet (a gap between keeps the state). */
  onProb: number;
  offProb: number;
  /** Frames of speech in a row before speech is declared. */
  onsetFrames: number;
  /** Speech shorter than this is a click or a cough, not a turn. */
  minSpeechMs: number;
  /** How far before the first speech frame the audio handed to the recogniser starts. */
  preRollMs: number;
  /** Silence after speech that ends the turn, by how finished the words look. */
  silenceCompleteMs: number;
  silenceUnknownMs: number;
  silenceIncompleteMs: number;
  silenceCommandMs: number;
  /** Silence that ends the turn whatever the words say. */
  silenceMaxMs: number;
  /** Silence after which a finished-looking turn is announced as likely over, so a reply can be prepared early. */
  candidateAfterMs: number;
  /** A turn this long ends where it is. */
  maxUtteranceMs: number;
  /** While the assistant speaks: speech this long, this surely, is an interruption. */
  bargeInMinMs: number;
  bargeInProb: number;
  /** An interruption confirmed by sound alone, when no words came. */
  bargeInNoTextMs: number;
  /** How soon after speech begins over the assistant its voice is lowered. */
  duckAfterMs: number;
  /** A sound of listening shorter than this is not an interruption. */
  backchannelMaxMs: number;
  /** After the assistant stops, the first moments of the microphone are not trusted (the tail of its own voice). */
  postAgentGraceMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  frameMs: 32,
  onProb: 0.5,
  offProb: 0.35,
  onsetFrames: 3,
  minSpeechMs: 160,
  // Generous on purpose: the detector is slow to believe a short first word ("What", "Hey") and a first word that is cut
  // off is a sentence misheard. What comes before the speech is silence, which costs nothing to hand to the recogniser.
  preRollMs: 700,
  silenceCompleteMs: 480,
  silenceUnknownMs: 760,
  silenceIncompleteMs: 1500,
  silenceCommandMs: 380,
  silenceMaxMs: 2400,
  candidateAfterMs: 220,
  maxUtteranceMs: 90_000,
  bargeInMinMs: 224,
  bargeInProb: 0.62,
  bargeInNoTextMs: 420,
  duckAfterMs: 96,
  backchannelMaxMs: 1000,
  postAgentGraceMs: 220,
};

export type AgentActivity = "idle" | "thinking" | "speaking";

export type TurnEndReason = "complete" | "unknown" | "incomplete" | "command" | "max-silence" | "max-length" | "model";

export type TurnEvent =
  | { type: "speech_start"; t: number; audioFrom: number }
  | { type: "speech_resume"; t: number }
  | { type: "end_candidate"; t: number; silenceMs: number }
  | { type: "turn_end"; t: number; reason: TurnEndReason; speechMs: number; silenceMs: number; text: string }
  | { type: "noise"; t: number; speechMs: number }
  | { type: "duck"; t: number; on: boolean }
  | { type: "barge_in"; t: number; reason: "speech" | "keyword"; audioFrom: number }
  | { type: "backchannel"; t: number; text: string }
  /** Sound has begun over the assistant's voice: it may be an interruption, and is worth listening to. */
  | { type: "overlap_start"; t: number; audioFrom: number }
  /** That sound stopped, or turned out to be a sound of listening or the assistant's own voice. */
  | { type: "overlap_end"; t: number };

type Mode = "quiet" | "speech" | "trailing";

const ANSWER_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright",
  "sim", "claro", "isso", "pode", "beleza",
  "si", "sí", "vale", "claro", "dale",
]);

function isPolarityAnswer(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/^[.,!?;:¡¿\s]+|[.,!?;:¡¿\s]+$/g, "");
  return ANSWER_WORDS.has(clean);
}

export class TurnTaker {
  private mode: Mode = "quiet";
  private agent: AgentActivity = "idle";
  private agentStoppedAt = -Infinity;
  private expectAnswer = false;

  // Onset: speech that has begun but is not yet declared.
  private onsetCount = 0;
  private onsetStart = 0;
  private onsetVoicedMs = 0;
  private lastVoicedT = 0;
  private holdUntilQuiet = false;
  private quietFrames = 0;

  // The turn in progress.
  private speechStart = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private resumeFrames = 0;
  private candidateSent = false;
  private text = "";
  private semantic: number | null = null;

  // The overlap with the assistant's voice.
  private ducked = false;
  private duckedAt = 0;
  private overlapText = "";

  constructor(private readonly cfg: TurnConfig = DEFAULT_TURN_CONFIG) {}

  /** What the assistant is doing now; it changes how the microphone is read. */
  setAgent(t: number, activity: AgentActivity): TurnEvent[] {
    const out: TurnEvent[] = [];
    if (this.agent === "speaking" && activity !== "speaking") {
      this.agentStoppedAt = t;
      if (this.ducked) {
        this.ducked = false;
        out.push({ type: "duck", t, on: false });
      }
      this.overlapText = "";
    }
    this.agent = activity;
    return out;
  }

  /** How long it has been since the last sound of speech, or 0 while a turn is in progress: the measure of a lull. */
  quietForMs(t: number): number {
    if (this.mode !== "quiet") return 0;
    return Math.max(0, t - this.lastVoicedT);
  }

  get inTurn(): boolean {
    return this.mode !== "quiet";
  }

  /** How long the person has been quiet since they last spoke, while the turn is still open; 0 otherwise. */
  get trailingSilenceMs(): number {
    return this.mode === "trailing" ? this.silenceMs : 0;
  }

  /** Timestamp (ms) at which the current open speech turn started. */
  get currentSpeechStart(): number {
    return this.speechStart;
  }

  /** What the recogniser has heard of the turn in progress, or of the overlap while the assistant speaks. */
  transcript(t: number, text: string): TurnEvent[] {
    if (this.mode === "quiet") {
      if (this.agent !== "speaking") return [];
      this.overlapText = text;
      return this.judgeOverlap(t);
    }
    this.text = text;
    return [];
  }

  /** The verdict of a model that listens to the end of the audio, as the chance that the turn is over (0 to 1). */
  semanticEnd(probability: number | null): void {
    this.semantic = probability;
  }

  /** Marks whether the assistant just asked a question or awaits approval, so "Yes"/"Yeah"/"Sim" is not dropped as a backchannel. */
  setExpectAnswer(expect: boolean): void {
    this.expectAnswer = expect;
  }

  /** One voice-activity frame, ending at time `t` (milliseconds). */
  frame(t: number, prob: number): TurnEvent[] {
    const out: TurnEvent[] = [];
    const cfg = this.cfg;
    if (prob >= cfg.onProb) this.lastVoicedT = t;
    switch (this.mode) {
      case "quiet":
        this.frameQuiet(t, prob, out);
        break;
      case "speech": {
        if (prob > cfg.offProb) {
          this.voicedMs += cfg.frameMs;
          this.silenceMs = 0;
        } else {
          this.mode = "trailing";
          this.silenceMs = cfg.frameMs;
          this.resumeFrames = 0;
          this.candidateSent = false;
        }
        if (t - this.speechStart >= cfg.maxUtteranceMs) this.finish(t, "max-length", out);
        break;
      }
      case "trailing": {
        if (prob >= cfg.onProb) {
          this.resumeFrames++;
          this.silenceMs += cfg.frameMs;
          if (this.resumeFrames >= 2) {
            this.mode = "speech";
            this.voicedMs += this.resumeFrames * cfg.frameMs;
            this.silenceMs = 0;
            this.resumeFrames = 0;
            out.push({ type: "speech_resume", t });
            this.candidateSent = false;
          }
        } else {
          this.resumeFrames = 0;
          this.silenceMs += cfg.frameMs;
          this.evaluateSilence(t, out);
        }
        break;
      }
    }
    return out;
  }

  private frameQuiet(t: number, prob: number, out: TurnEvent[]): void {
    const cfg = this.cfg;
    const speaking = this.agent === "speaking";
    const afterAgent = t - this.agentStoppedAt < cfg.postAgentGraceMs;
    const threshold = speaking || afterAgent ? cfg.bargeInProb : cfg.onProb;
    const voiced = prob >= threshold;
    if (this.holdUntilQuiet) {
      // The tail of a sound of listening: it is not looked at again until there has been a moment of quiet.
      if (voiced) this.quietFrames = 0;
      else if (++this.quietFrames >= 6) this.holdUntilQuiet = false;
      if (this.holdUntilQuiet) return;
    }
    if (!voiced) {
      if (this.onsetCount > 0 && speaking) out.push({ type: "overlap_end", t });
      if (!speaking && this.onsetCount >= cfg.onsetFrames && this.onsetVoicedMs >= cfg.minSpeechMs) {
        if (afterAgent) {
          // Hold a confirmed short utterance (e.g. "Yes"/"Sim") spoken inside the post-agent grace window until grace ends.
          return;
        }
        this.beginSpeech(t, out);
        this.mode = "trailing";
        this.silenceMs = cfg.frameMs;
        this.resumeFrames = 0;
        this.candidateSent = false;
        return;
      }
      this.onsetCount = 0;
      this.onsetVoicedMs = 0;
      if (this.ducked && t - this.duckedAt > 400) {
        this.ducked = false;
        out.push({ type: "duck", t, on: false });
        this.overlapText = "";
      }
      return;
    }
    if (this.onsetCount === 0) {
      this.onsetStart = t - cfg.frameMs;
      if (speaking) out.push({ type: "overlap_start", t, audioFrom: Math.max(0, this.onsetStart - cfg.preRollMs) });
    }
    this.onsetCount++;
    this.onsetVoicedMs += cfg.frameMs;
    if (speaking) {
      if (this.onsetCount >= cfg.onsetFrames && !this.ducked && t - this.onsetStart >= cfg.duckAfterMs) {
        this.ducked = true;
        this.duckedAt = t;
        out.push({ type: "duck", t, on: true });
      }
      out.push(...this.judgeOverlap(t));
      return;
    }
    if (afterAgent) return;
    if (this.onsetCount >= cfg.onsetFrames) this.beginSpeech(t, out);
  }

  /** Decides whether speech over the assistant is an interruption, from how long it lasts and what it says. */
  private judgeOverlap(t: number): TurnEvent[] {
    const cfg = this.cfg;
    if (this.mode !== "quiet" || this.agent !== "speaking" || this.onsetCount === 0) return [];
    const out: TurnEvent[] = [];
    const sustained = this.onsetVoicedMs;
    const text = this.overlapText.trim();
    if (text !== "" && isStopIntent(text)) {
      this.interrupt(t, "keyword", out);
      return out;
    }
    if (text !== "" && isBackchannel(text) && !(this.expectAnswer && isPolarityAnswer(text)) && sustained < cfg.backchannelMaxMs) {
      // A sound of listening: noted, the voice comes back up, and the rest of the sound is not read as speech.
      out.push({ type: "backchannel", t, text });
      out.push(...this.dropOverlap(t));
      return out;
    }
    if (text !== "" && sustained >= cfg.bargeInMinMs && (!isBackchannel(text) || (this.expectAnswer && isPolarityAnswer(text)))) {
      this.interrupt(t, "speech", out);
      return out;
    }
    if (text === "" && sustained >= cfg.bargeInNoTextMs) {
      this.interrupt(t, "speech", out);
      return out;
    }
    return out;
  }

  /**
   * The sound over the assistant is not for it: its own voice coming back through the microphone, say. The voice comes
   * back up and the rest of that sound is not looked at again until there has been a moment of quiet.
   */
  dismissOverlap(t: number): TurnEvent[] {
    if (this.mode !== "quiet" || this.onsetCount === 0) return [];
    return this.dropOverlap(t);
  }

  private dropOverlap(t: number): TurnEvent[] {
    const out: TurnEvent[] = [{ type: "overlap_end", t }];
    if (this.ducked) {
      this.ducked = false;
      out.push({ type: "duck", t, on: false });
    }
    this.onsetCount = 0;
    this.onsetVoicedMs = 0;
    this.overlapText = "";
    this.holdUntilQuiet = true;
    this.quietFrames = 0;
    return out;
  }

  private interrupt(t: number, reason: "speech" | "keyword", out: TurnEvent[]): void {
    const from = Math.max(0, this.onsetStart - this.cfg.preRollMs);
    this.agent = "idle";
    this.agentStoppedAt = t;
    this.ducked = false;
    out.push({ type: "barge_in", t, reason, audioFrom: from });
    this.beginSpeech(t, out, true);
  }

  private beginSpeech(t: number, out: TurnEvent[], interrupted = false): void {
    this.mode = "speech";
    this.speechStart = this.onsetStart;
    this.voicedMs = this.onsetVoicedMs;
    this.silenceMs = 0;
    this.candidateSent = false;
    this.text = interrupted ? this.overlapText : "";
    this.semantic = null;
    this.onsetCount = 0;
    this.onsetVoicedMs = 0;
    this.overlapText = "";
    out.push({ type: "speech_start", t, audioFrom: Math.max(0, this.speechStart - this.cfg.preRollMs) });
  }

  private evaluateSilence(t: number, out: TurnEvent[]): void {
    const cfg = this.cfg;
    const reading = readCompleteness(this.text);
    let need: number;
    let reason: TurnEndReason;
    if (this.semantic !== null) {
      // A model that heard the audio: sure it is over, answer sooner (unless the words themselves end mid-repair/connective); sure it is not, wait.
      if (reading.verdict === "incomplete") [need, reason] = [cfg.silenceIncompleteMs, "incomplete"];
      else if (this.semantic <= 0.25) [need, reason] = [cfg.silenceIncompleteMs, "model"];
      else if (this.semantic >= 0.85) [need, reason] = [Math.round(cfg.silenceCompleteMs * 0.75), "model"];
      else [need, reason] = [cfg.silenceUnknownMs, "model"];
    } else if (reading.command) [need, reason] = [cfg.silenceCommandMs, "command"];
    else if (reading.verdict === "complete") [need, reason] = [cfg.silenceCompleteMs, "complete"];
    else if (reading.verdict === "incomplete") [need, reason] = [cfg.silenceIncompleteMs, "incomplete"];
    else [need, reason] = [cfg.silenceUnknownMs, "unknown"];
    const looksOver =
      reading.verdict !== "incomplete" && (this.semantic !== null ? this.semantic >= 0.7 : reading.verdict === "complete");
    if (!this.candidateSent && looksOver && this.silenceMs >= cfg.candidateAfterMs && this.silenceMs < need) {
      this.candidateSent = true;
      out.push({ type: "end_candidate", t, silenceMs: this.silenceMs });
    }
    if (this.silenceMs >= need) this.finish(t, reason, out);
    else if (this.silenceMs >= cfg.silenceMaxMs) this.finish(t, "max-silence", out);
  }

  private finish(t: number, reason: TurnEndReason, out: TurnEvent[]): void {
    const speechMs = this.voicedMs;
    this.mode = "quiet";
    this.onsetCount = 0;
    this.onsetVoicedMs = 0;
    if (speechMs < this.cfg.minSpeechMs && reason !== "max-length") {
      out.push({ type: "noise", t, speechMs });
      this.text = "";
      return;
    }
    out.push({ type: "turn_end", t, reason, speechMs, silenceMs: this.silenceMs, text: this.text });
    this.text = "";
  }
}
