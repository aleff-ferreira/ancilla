import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUserAuthorizationIntent } from "../assistant/launcher.js";
import type { BrainEvent, BrainProvider, ChatMessage, ToolCall } from "./brain.js";
import { pickVoice, toFloat, type AsrStream, type Engines } from "./engines.js";
import type { HostEvent, VoiceHost } from "./host.js";
import { TurnTrace } from "./metrics.js";
import { buildSystemPrompt, didntCatchPhrase, failedPhrase, thinkingPhrase } from "./prompt.js";
import type { CallMode, ClientMessage, ServerMessage } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { Scheduler } from "./scheduler.js";
import { SpeechOut } from "./speech.js";
import { guessLanguage, hasCodeSwitch, isBackchannel, isStopIntent, paceForText, SpeechChunker, wordsOf, type Lang } from "./text.js";
import { DEFAULT_TURN_CONFIG, TurnTaker, type AgentActivity, type TurnConfig, type TurnEvent } from "./turn.js";

/**
 * One voice call. Microphone audio goes in; speech comes out, and in between the call listens, decides when the person has
 * finished, asks a model what to say, says it a sentence at a time, and gives way when it is interrupted. Everything that
 * touches a model, an engine, the clock or the network is handed in, so the whole of it runs in a test.
 *
 * Work is done one thing at a time, in the order it arrived: audio frames and control messages go through one queue, so
 * that nothing here races with anything else. What takes long (a model, a tool, a sentence being said) runs beside the
 * queue and is only ever cancelled, never waited on, by the code that listens.
 */

export interface SessionConfig {
  turn: TurnConfig;
  /** How much past audio is kept, for the first words of a turn and for an interruption. */
  ringMs: number;
  /** How often the recogniser is asked what it has heard so far. */
  partialEveryMs: number;
  /** After this much quiet in a turn the recogniser is flushed, so its last words are there when the pause is judged. */
  flushAfterSilenceMs: number;
  /** Audio is made this far ahead of what has been played. */
  aheadMs: number;
  /** A model that has said nothing after this long is covered by a short phrase. */
  fillerAfterMs: number;
  /** Speech that resumes within this long of a turn ending, before the reply is heard, continues that turn. */
  mergeWindowMs: number;
  /** How long it must have been quiet before the assistant says something nobody asked for. */
  proactiveQuietMs: number;
  maxHistory: number;
  maxToolRounds: number;
  speed: number;
  /** Frames waiting to be processed beyond which new ones are dropped. */
  maxBacklogFrames: number;
  /** Writes what the turn-taker decided, and when, to the log: for finding out why a call did what it did. */
  debug: boolean;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  turn: DEFAULT_TURN_CONFIG,
  ringMs: 2000,
  partialEveryMs: 120,
  flushAfterSilenceMs: 160,
  aheadMs: 2400,
  fillerAfterMs: 1500,
  mergeWindowMs: 1200,
  proactiveQuietMs: 2500,
  maxHistory: 40,
  maxToolRounds: 6,
  speed: 1,
  maxBacklogFrames: 160,
  debug: false,
};

export interface SessionDeps {
  engines: Engines;
  brain: BrainProvider;
  host: VoiceHost;
  scheduler: Scheduler;
  send: (message: ServerMessage) => void;
  sendAudio: (frame: Buffer) => void;
  log: (line: string) => void;
  config?: Partial<SessionConfig>;
  id?: string;
  /** Called once when the call ends, whichever side ended it, so that whatever holds the connection can let it go. */
  onClosed?: (reason: string) => void;
}

const INPUT_RATE = 16;

const ECHO_NEVER_SUPPRESS = new Set([
  "no", "nope", "not", "cancel", "never", "stop", "wait", "hold", "pause",
  "nao", "não", "pare", "para", "espera", "espere", "cancela", "cancele",
]);

function hasContiguousPhrase(words: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || words.length < phrase.length) return false;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    let match = true;
    for (let k = 0; k < phrase.length; k++) {
      if (words[i + k] !== phrase[k]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

class SampleRing {
  private readonly buf: Float32Array;
  private end = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  get total(): number {
    return this.end;
  }

  append(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) this.buf[(this.end + i) % this.capacity] = samples[i] as number;
    this.end += samples.length;
  }

  /** The samples from absolute position `from` to now, as far back as they are still held. */
  read(from: number): Float32Array {
    const start = Math.max(from, this.end - this.capacity, 0);
    const out = new Float32Array(Math.max(0, this.end - start));
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(start + i) % this.capacity] as number;
    return out;
  }
}

interface Reply {
  id: number;
  turn: number;
  userText: string | null;
  source: "voice" | "text" | "event";
  abort: AbortController;
  speech: SpeechOut;
  chunker: SpeechChunker;
  trace: TurnTrace | null;
  full: string;
  startedAt: number;
  aborted: boolean;
  fillerUsed: boolean;
  cancelFiller: (() => void) | null;
  sentFirstToken: boolean;
  completedTools: string[];
}

export class VoiceSession {
  private readonly cfg: SessionConfig;
  private readonly ring: SampleRing;
  private taker: TurnTaker;
  private chain: Promise<void> = Promise.resolve();
  private carry = new Float32Array(0);
  private backlog = 0;
  private droppedNotice = 0;

  private mode: CallMode = "hands-free";
  private muted = false;
  private pttDown = false;
  private closed = false;
  private started = false;
  private echoCancelled = false;
  private lang: string | null = null;
  private userLang: Lang = "unknown";

  private stream: AsrStream | null = null;
  private userText = "";
  private flushed = false;
  private flushedAtSample = 0;
  private lastPartialAt = -Infinity;
  private lastLevelAt = 0;
  private lastSpeaking = false;

  private agent: AgentActivity = "idle";
  private reply: Reply | null = null;
  private replyCounter = 0;
  private utteranceCounter = 0;
  private turnCounter = 0;
  private history: ChatMessage[] = [];
  private lastTurnEndAt = -Infinity;
  private pendingMerge: { text: string; turn: number } | null = null;
  private speculativeContext: { text: string; promise: Promise<string | null> } | null = null;
  private abortedToolNotes: string[] = [];
  private echoDismissedAtSample = 0;
  private echoDismissedUntilQuiet = false;
  private recentSpoken: Array<{ at: number; words: string[] }> = [];
  private readonly pendingSay: HostEvent[] = [];
  /** The news waiting for the call to open, said once after a moment's quiet; dropped if the person speaks first. */
  private openingSay: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeApprovals: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  /** With `debug` on, the audio the call received, as raw 16 kHz PCM, for listening to what the server heard. */
  private debugAudio: WriteStream | null = null;
  readonly id: string;

  constructor(private readonly deps: SessionDeps) {
    this.cfg = { ...DEFAULT_SESSION_CONFIG, ...(deps.config ?? {}) };
    this.cfg.turn = { ...this.cfg.turn, frameMs: deps.engines.vad.frameSamples / INPUT_RATE };
    this.ring = new SampleRing(Math.round(this.cfg.ringMs * INPUT_RATE));
    this.taker = new TurnTaker(this.cfg.turn);
    this.id = deps.id ?? `call-${Math.random().toString(36).slice(2, 10)}`;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Coming in

  /** Opens the call: the engines are warmed, the earlier turns of the thread are loaded and the client is told it can speak. */
  async start(hello: Extract<ClientMessage, { type: "hello" }>): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.cfg.debug) {
      try {
        const dir = join(tmpdir(), "ancilla-voice-debug");
        mkdirSync(dir, { recursive: true });
        this.debugAudio = createWriteStream(join(dir, `${this.id}.pcm`));
        this.deps.log(`debug: the audio of this call is written to ${join(dir, `${this.id}.pcm`)} (16 kHz, mono, signed 16-bit)`);
      } catch {
        this.debugAudio = null;
      }
    }
    this.mode = hello.mode;
    this.echoCancelled = hello.echoCancelled;
    this.lang = hello.lang;
    this.userLang = hello.lang ? (hello.lang.toLowerCase().startsWith("pt") ? "pt" : hello.lang.toLowerCase().startsWith("en") ? "en" : "unknown") : "unknown";
    const { engines, host } = this.deps;
    try {
      const warm = [engines.asr.warm?.(), engines.tts.warm?.()].filter((x): x is Promise<void> => x !== undefined);
      await Promise.all(warm);
    } catch (error) {
      this.deps.log(`the voice engines could not be warmed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.history = host.history(hello.thread);
    this.unsubscribe = host.subscribe((event) => this.onHostEvent(event));
    if (host.subscribeApprovals) {
      this.unsubscribeApprovals = host.subscribeApprovals((request) => {
        this.send({ type: "approval", request });
      });
    }
    const voice = pickVoice(engines.tts.voices, this.langCode(), host.persona().voice);
    this.send({ type: "ready", session: this.id, sampleRate: engines.tts.sampleRate, engine: `${engines.asr.id} + ${engines.tts.id}`, voice: voice?.id ?? "", lang: this.lang, resumed: this.history.length > 0 });
    const pendingApproval = host.pendingApproval?.() ?? null;
    if (pendingApproval) {
      this.send({
        type: "approval",
        request: {
          id: pendingApproval.id,
          kind: pendingApproval.kind,
          title: pendingApproval.title,
          detail: pendingApproval.detail,
          allowLabel: pendingApproval.allowLabel,
          denyLabel: pendingApproval.denyLabel,
        },
      });
    }
    try {
      for (const event of host.activeTasks?.() ?? []) {
        this.send({ type: "task", id: event.id, title: event.title, status: event.status, note: event.note ?? null });
      }
    } catch (error) {
      this.deps.log(`the active tasks for the call could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.send({ type: "state", state: "listening" });
    try {
      this.openingSay = host.opening?.() ?? null;
    } catch (error) {
      this.deps.log(`the news for the opening of the call could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.scheduleTick();
  }

  /** A frame of microphone audio (16 kHz mono). */
  onAudio(pcm: Int16Array): void {
    if (this.closed || !this.started || this.muted) return;
    this.debugAudio?.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    const samples = toFloat(pcm);
    const merged = new Float32Array(this.carry.length + samples.length);
    merged.set(this.carry, 0);
    merged.set(samples, this.carry.length);
    const size = this.deps.engines.vad.frameSamples;
    let at = 0;
    while (merged.length - at >= size) {
      const frame = merged.slice(at, at + size);
      at += size;
      if (this.backlog >= this.cfg.maxBacklogFrames) {
        if (++this.droppedNotice === 1) this.deps.log("the voice engine is behind real time: audio is being dropped");
        continue;
      }
      this.backlog++;
      this.enqueue(async () => {
        this.backlog--;
        await this.processFrame(frame);
      });
    }
    this.carry = merged.slice(at);
  }

  onMessage(message: ClientMessage): void {
    switch (message.type) {
      case "playback":
        if (this.reply && this.reply.speech.utterance === message.utterance) this.reply.speech.reportPlayed(message.samples);
        break;
      case "interrupt":
        this.enqueue(async () => {
          if (this.reply && this.reply.speech.utterance === message.utterance) this.reply.speech.reportPlayed(message.samples);
          this.interruptReply("the client");
        });
        break;
      case "text":
        this.enqueue(async () => {
          const trimmed = message.text.trim();
          const pending = this.deps.host.pendingApproval?.() ?? null;
          if (!(pending?.inFlightMuse && parseUserAuthorizationIntent(trimmed) !== null)) {
            this.interruptReply("typed text");
            this.cancelPendingReply();
          }
          this.beginUserTurn(trimmed, "text", null);
        });
        break;
      case "decide":
        this.enqueue(async () => {
          const pending = this.deps.host.pendingApproval?.() ?? null;
          const inFlightMuse = pending?.id === message.id && pending.inFlightMuse === true;
          const res = await this.deps.host.decideApproval?.(message.id, message.allow);
          if (!res) return;
          this.send({ type: "notice", level: res.ok ? "info" : "warn", text: res.message });
          if (!inFlightMuse && !this.reply && this.agent === "idle" && res.ok) {
            this.sayDirect(res.message, false);
          }
        });
        break;
      case "mute":
        this.enqueue(async () => {
          this.muted = message.on;
          if (message.on) {
            this.disposeStream();
            this.taker = new TurnTaker(this.cfg.turn);
            this.carry = new Float32Array(0);
            this.send({ type: "state", state: "idle" });
          } else {
            this.send({ type: "state", state: this.agent === "idle" ? "listening" : this.agent });
          }
        });
        break;
      case "ptt":
        this.enqueue(async () => this.onPushToTalk(message.down));
        break;
      case "ping":
        this.send({ type: "pong", t: message.t });
        break;
      case "end":
        void this.close("the client ended the call");
        break;
      case "hello":
        break;
    }
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelTick?.();
    this.unsubscribe?.();
    this.unsubscribeApprovals?.();
    const r = this.reply;
    if (r) {
      r.aborted = true;
      r.abort.abort();
      r.cancelFiller?.();
      r.speech.abort();
    }
    this.reply = null;
    this.disposeStream();
    this.debugAudio?.end();
    this.debugAudio = null;
    this.send({ type: "ended", reason });
    try {
      this.deps.onClosed?.(reason);
    } catch (error) {
      this.deps.log(`closing the call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.chain.catch(() => undefined);
  }

  /** For tests and for the screen: what the call has said and heard, and what it is doing. */
  snapshot(): { history: ChatMessage[]; agent: AgentActivity; turns: number } {
    return { history: [...this.history], agent: this.agent, turns: this.turnCounter };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The queue

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      try {
        await job();
      } catch (error) {
        this.deps.log(`the call hit an error: ${error instanceof Error ? error.message : String(error)}`);
        this.send({ type: "error", code: "internal", message: "Something went wrong in the call; it goes on." });
      }
    });
  }

  private send(message: ServerMessage): void {
    if (this.closed && message.type !== "ended") return;
    try {
      this.deps.send(message);
    } catch (error) {
      this.deps.log(`a message could not be sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private nowMs(): number {
    return this.ring.total / INPUT_RATE;
  }

  private langCode(): string | null {
    if (this.lang) return this.lang.toLowerCase().split("-")[0] ?? null;
    return this.userLang === "unknown" ? null : this.userLang;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Listening

  private async processFrame(frame: Float32Array): Promise<void> {
    if (this.mode === "push-to-talk") {
      this.ring.append(frame);
      if (this.pttDown && this.stream) {
        await this.stream.accept(frame);
        await this.pollPartial();
      }
      return;
    }
    const prob = await this.deps.engines.vad.process(frame);
    this.ring.append(frame);
    if (this.echoDismissedUntilQuiet) {
      if (prob >= this.cfg.turn.offProb) this.echoDismissedAtSample = this.ring.total;
      else this.echoDismissedUntilQuiet = false;
    }
    const t = this.nowMs();
    const fed = await this.handleEvents(this.taker.frame(t, prob), t);
    // Once the recogniser has been flushed it is fed nothing until the person speaks again: the quiet is not worth decoding,
    // and what is read at the pause stands ready when the turn ends.
    if (this.stream && !fed && !this.flushed) await this.stream.accept(frame);
    if (this.stream && !this.flushed && this.taker.trailingSilenceMs >= this.cfg.flushAfterSilenceMs) {
      this.flushed = true;
      this.flushedAtSample = this.ring.total;
      await this.stream.flush?.();
      this.lastPartialAt = -Infinity;
    }
    await this.pollPartial();
    this.reportLevel(prob);
  }

  private reportLevel(prob: number): void {
    const speaking = prob >= 0.5;
    const now = this.deps.scheduler.now();
    if (speaking !== this.lastSpeaking && now - this.lastLevelAt > 80) {
      this.lastSpeaking = speaking;
      this.lastLevelAt = now;
      this.send({ type: "level", speaking });
    }
  }

  /** Acts on what the turn-taker found. Returns whether the frame just processed went into a recogniser stream with it. */
  private async handleEvents(events: TurnEvent[], t: number): Promise<boolean> {
    let fed = false;
    for (const ev of events) {
      if (this.cfg.debug) this.deps.log(`turn-taker: ${ev.type} ${JSON.stringify({ ...ev, type: undefined })}`);
      switch (ev.type) {
        case "overlap_start":
          if (!this.stream) {
            await this.openStream(Math.round(ev.audioFrom * INPUT_RATE));
            fed = true;
          }
          break;
        case "overlap_end":
          if (this.stream && !this.taker.inTurn) this.disposeStream();
          break;
        case "speech_start":
          this.onSpeechStart(ev.t);
          if (!this.stream) {
            await this.openStream(Math.round(ev.audioFrom * INPUT_RATE));
            fed = true;
          }
          break;
        case "turn_end":
          await this.onTurnEnd(ev);
          break;
        case "noise":
          this.speculativeContext = null;
          this.disposeStream();
          break;
        case "duck":
          this.send({ type: "duck", on: ev.on });
          break;
        case "barge_in":
          this.interruptReply(`the person spoke (${ev.reason})`);
          break;
        case "speech_resume":
          this.speculativeContext = null;
          if (this.flushed && this.stream) {
            // The person goes on: the recogniser gets the stretch it was not fed, up to and including this frame.
            this.flushed = false;
            const missed = this.ring.read(this.flushedAtSample);
            if (missed.length > 0) await this.stream.accept(missed);
            fed = true;
          }
          this.flushed = false;
          break;
        case "backchannel":
          break;
        case "end_candidate": {
          // Pre-warm memory and harness context while the endpoint pause is still running, reusing it if the turn ends on these words.
          const candidate = this.userText.trim();
          if (candidate !== "" && !this.pendingMerge && this.speculativeContext?.text !== candidate) {
            this.speculativeContext = { text: candidate, promise: Promise.resolve(this.deps.host.context(candidate, "voice")) };
          }
          break;
        }
      }
    }
    void t;
    return fed;
  }

  private onSpeechStart(_t: number): void {
    const now = this.deps.scheduler.now();
    const r = this.reply;
    const awaitingInFlightMuse = this.deps.host.pendingApproval?.()?.inFlightMuse === true;
    if (r && !r.speech.started && !r.aborted && r.userText !== null && !awaitingInFlightMuse) {
      // The person is speaking again before they were answered. Soon after the last turn it is the same turn, carried on.
      if (now - this.lastTurnEndAt <= this.cfg.mergeWindowMs) this.pendingMerge = { text: r.userText, turn: r.turn };
      this.cancelPendingReply();
    }
    this.send({ type: "state", state: "listening" });
  }

  private async openStream(fromSample: number): Promise<void> {
    const stream = await this.deps.engines.asr.open(this.lang);
    this.stream = stream;
    this.userText = "";
    this.flushed = false;
    this.lastPartialAt = this.deps.scheduler.now();
    const pre = this.ring.read(Math.max(fromSample, this.echoDismissedAtSample));
    if (pre.length > 0) await stream.accept(pre);
  }

  private disposeStream(): void {
    const s = this.stream;
    this.stream = null;
    this.userText = "";
    if (s) {
      try {
        s.dispose();
      } catch (error) {
        this.deps.log(`a recogniser stream would not close: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async pollPartial(): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    const now = this.deps.scheduler.now();
    if (now - this.lastPartialAt < this.cfg.partialEveryMs) return;
    this.lastPartialAt = now;
    const result = await stream.partial();
    if (this.stream !== stream || result.text === this.userText) return;
    this.userText = result.text;
    const t = this.nowMs();
    if (this.agent === "speaking" && !this.taker.inTurn) {
      // Something over the assistant's voice that is the assistant's voice coming back is not the person.
      if (this.looksLikeEcho(result.text)) {
        this.echoDismissedAtSample = this.ring.total;
        this.echoDismissedUntilQuiet = true;
        await this.handleEvents(this.taker.dismissOverlap(t), t);
        return;
      }
    }
    await this.handleEvents(this.taker.transcript(t, result.text), t);
    if (this.taker.inTurn && result.text.trim() !== "") this.send({ type: "partial", turn: this.turnCounter + 1, text: result.text });
  }

  private looksLikeEcho(text: string): boolean {
    const heard = wordsOf(text);
    if (heard.length === 0) return false;
    const now = this.deps.scheduler.now();
    if (heard.length < 3) {
      if (isStopIntent(text) || isBackchannel(text) || heard.some((w) => ECHO_NEVER_SUPPRESS.has(w))) return false;
      const recent = this.recentSpoken.filter((s) => now - s.at < 3500);
      if (recent.length === 0) return false;
      if (heard.length === 1) {
        const w = heard[0] ?? "";
        if (w.length < 4) return false;
        return recent.some((s) => now - s.at < 2500 && ((s.words.length === 1 && s.words[0] === w) || s.words[0] === w));
      }
      return recent.some((s) => hasContiguousPhrase(s.words, heard));
    }
    const spoken = new Set(this.recentSpoken.filter((s) => now - s.at < 8000).flatMap((s) => s.words));
    if (spoken.size === 0) return false;
    const hits = heard.filter((w) => spoken.has(w)).length;
    return hits / heard.length >= 0.8;
  }

  private async onTurnEnd(ev: Extract<TurnEvent, { type: "turn_end" }>): Promise<void> {
    const now = this.deps.scheduler.now();
    const stream = this.stream;
    this.stream = null;
    this.lastTurnEndAt = now;
    let text = "";
    let asrDoneAt = now;
    if (stream) {
      try {
        text = (await stream.finish()).text.trim();
      } finally {
        stream.dispose();
      }
      asrDoneAt = this.deps.scheduler.now();
    }
    this.userText = "";
    const prewarmed = this.speculativeContext;
    this.speculativeContext = null;
    if (text === "") {
      this.pendingMerge = null;
      this.send({ type: "state", state: this.agent === "idle" ? "listening" : this.agent });
      // Someone clearly spoke and nothing could be made of it: say so, rather than let them wonder if they were heard.
      if (ev.speechMs >= 700 && this.agent === "idle" && !this.reply && stream) this.sayDirect(didntCatchPhrase(this.replyLang()), false);
      return;
    }
    const trace = new TurnTrace(this.turnCounter + 1);
    trace.speechEnd = now - ev.silenceMs;
    trace.turnEnd = now;
    trace.asrFinal = asrDoneAt;
    this.beginUserTurn(text, "voice", trace, prewarmed);
  }

  private async onPushToTalk(down: boolean): Promise<void> {
    if (this.mode !== "push-to-talk") return;
    this.pttDown = down;
    if (down) {
      this.interruptReply("push to talk");
      this.cancelPendingReply();
      this.disposeStream();
      await this.openStream(this.ring.total);
      this.send({ type: "state", state: "listening" });
      return;
    }
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    let text = "";
    try {
      text = (await stream.finish()).text.trim();
    } finally {
      stream.dispose();
    }
    if (text !== "") {
      const now = this.deps.scheduler.now();
      const trace = new TurnTrace(this.turnCounter + 1);
      trace.speechEnd = trace.turnEnd = trace.asrFinal = now;
      this.beginUserTurn(text, "voice", trace);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Answering

  private beginUserTurn(
    text: string,
    source: "voice" | "text",
    trace: TurnTrace | null,
    prewarmed: { text: string; promise: Promise<string | null> } | null = null,
  ): void {
    if (text === "") return;
    // The person has the floor, in words that could be made out (a cough does not take it): what the call would have opened
    // with is not said now, over the topic they chose, as if it were fresh.
    this.openingSay = null;
    this.speculativeContext = null;
    let turn: number;
    let said = text;
    if (this.pendingMerge) {
      // The same turn carried on: the earlier words go first, under the same number.
      said = `${this.pendingMerge.text} ${text}`.replace(/\s+/g, " ").trim();
      turn = this.pendingMerge.turn;
      this.pendingMerge = null;
      const last = this.history[this.history.length - 1];
      if (last && last.role === "user") this.history.pop();
      if (trace) trace.turn;
    } else {
      turn = ++this.turnCounter;
    }
    const lang = guessLanguage(said);
    if (lang !== "unknown") this.userLang = lang;
    this.send({ type: "user", turn, text: said, source });
    this.deps.host.record({ turn, role: "user", text: said, source, at: this.deps.scheduler.now() });

    const pending = this.deps.host.pendingApproval?.() ?? null;
    if (pending?.inFlightMuse && this.reply && !this.reply.aborted) {
      const intent = parseUserAuthorizationIntent(said);
      if (intent !== null && this.deps.host.decideApproval) {
        if (intent === "allow" && source === "voice" && !this.echoCancelled) {
          this.send({
            type: "notice",
            level: "warn",
            text: "Echo cancellation is off on this microphone: click the button on the call card (or type) to approve.",
          });
          return;
        }
        this.history.push({ role: "user", content: said });
        void this.deps.host
          .decideApproval(pending.id, intent === "allow")
          .then((res) => {
            this.send({ type: "notice", level: res.ok ? "info" : "warn", text: res.message });
          })
          .catch((error) => {
            this.deps.log(`resolving live approval failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        return;
      }
      this.interruptReply("new turn over pending approval");
      this.cancelPendingReply();
    }

    const contextPromise = source === "voice" && prewarmed && prewarmed.text === said ? prewarmed.promise : null;
    this.startReply(turn, said, source, trace ? Object.assign(new TurnTrace(turn), trace, { turn }) : null, contextPromise);
  }

  private newReply(turn: number, userText: string | null, source: Reply["source"], trace: TurnTrace | null): Reply {
    const utterance = ++this.utteranceCounter;
    const speech = new SpeechOut(utterance, turn, {
      tts: this.deps.engines.tts,
      scheduler: this.deps.scheduler,
      send: (m) => {
        if (m.type === "speaking") this.noteSpoken(m.text);
        this.send(m);
      },
      sendAudio: (b) => {
        if (!this.closed) this.deps.sendAudio(b);
      },
      voiceFor: (text) => this.voiceFor(text),
      aheadMs: this.cfg.aheadMs,
      onFirstAudio: () => this.onFirstAudio(reply),
      log: (line) => this.deps.log(line),
    });
    const reply: Reply = {
      id: ++this.replyCounter,
      turn,
      userText,
      source,
      abort: new AbortController(),
      speech,
      chunker: new SpeechChunker(() => this.replyLang()),
      trace,
      full: "",
      startedAt: this.deps.scheduler.now(),
      aborted: false,
      fillerUsed: false,
      cancelFiller: null,
      sentFirstToken: false,
      completedTools: [],
    };
    return reply;
  }

  private replyLang(): Lang {
    const forced = this.deps.host.persona().language;
    if (forced) return forced.toLowerCase().startsWith("pt") ? "pt" : "en";
    return this.userLang;
  }

  private voiceFor(text: string): { voice: string; speed: number } {
    const guess = guessLanguage(text);
    const lang = guess !== "unknown" ? guess : this.langCode();
    const voice = pickVoice(this.deps.engines.tts.voices, lang, this.deps.host.persona().voice);
    return { voice: voice?.id ?? "", speed: paceForText(text, this.cfg.speed) };
  }

  private noteSpoken(text: string): void {
    const now = this.deps.scheduler.now();
    this.recentSpoken = [...this.recentSpoken.filter((s) => now - s.at < 10_000), { at: now, words: wordsOf(text) }];
  }

  private onFirstAudio(reply: Reply): void {
    if (reply.aborted || this.reply !== reply) return;
    reply.cancelFiller?.();
    this.setAgent("speaking");
    if (reply.trace) {
      reply.trace.firstAudio = this.deps.scheduler.now();
      this.send({ type: "metrics", metrics: reply.trace.snapshot() });
    }
  }

  private setAgent(activity: AgentActivity): void {
    if (this.agent === activity) return;
    this.agent = activity;
    this.enqueue(async () => {
      const t = this.nowMs();
      await this.handleEvents(this.taker.setAgent(t, activity), t);
    });
    this.send({ type: "state", state: activity === "idle" ? "listening" : activity });
  }

  private startReply(
    turn: number,
    text: string,
    source: "voice" | "text",
    trace: TurnTrace | null,
    prewarmedContext: Promise<string | null> | null = null,
  ): void {
    if (this.reply && !this.reply.aborted) {
      const prev = this.reply;
      prev.aborted = true;
      prev.cancelFiller?.();
      prev.abort.abort();
      prev.speech.abort();
      this.reply = null;
    }
    const reply = this.newReply(turn, text, source, trace);
    this.reply = reply;
    this.setAgent("thinking");
    reply.cancelFiller = this.deps.scheduler.after(this.cfg.fillerAfterMs, () => this.onFillerDue(reply));
    void this.runReply(reply, text, source, prewarmedContext).catch((error) => {
      this.deps.log(`a reply failed: ${error instanceof Error ? error.message : String(error)}`);
      this.failReply(reply);
    });
  }

  private onFillerDue(reply: Reply): void {
    if (this.reply !== reply || reply.aborted || reply.sentFirstToken || reply.fillerUsed || reply.speech.started) return;
    reply.fillerUsed = true;
    const phrase = thinkingPhrase(this.replyLang(), reply.turn);
    reply.full += `${phrase} `;
    reply.speech.enqueue(phrase);
  }

  private failReply(reply: Reply): void {
    if (reply.aborted || this.reply !== reply) return;
    const phrase = failedPhrase(this.replyLang());
    reply.full += `${reply.full === "" ? "" : " "}${phrase}`;
    reply.speech.enqueue(phrase);
  }

  private async runReply(
    reply: Reply,
    text: string,
    source: "voice" | "text",
    prewarmedContext: Promise<string | null> | null = null,
  ): Promise<void> {
    const { brain, host, scheduler } = this.deps;
    let approvalOutcomeNote: string | null = null;
    const pending = host.pendingApproval?.() ?? null;
    if (pending && !pending.inFlightMuse && reply.turn > pending.createdTurn && host.decideApproval) {
      const intent = parseUserAuthorizationIntent(text);
      if (intent !== null) {
        if (intent === "allow" && source === "voice" && !this.echoCancelled) {
          this.send({
            type: "notice",
            level: "warn",
            text: "Echo cancellation is off on this microphone: click the button on the call card (or type) to approve.",
          });
          approvalOutcomeNote = `[Spoken approval for "${pending.title}" was not executed because browser echo cancellation is off on this microphone. Tell the user to click ${pending.allowLabel} on the call card (or type "go ahead") to approve it.]`;
        } else {
          const res = await host.decideApproval(pending.id, intent === "allow");
          if (reply.aborted) return;
          this.send({ type: "notice", level: res.ok ? "info" : "warn", text: res.message });
          approvalOutcomeNote = `[The user ${intent === "allow" ? "authorized" : "declined"} the pending request "${pending.title}". Outcome: ${res.message}]`;
        }
      }
    }
    const context = await (prewarmedContext ?? host.context(text, source));
    if (reply.aborted) return;
    const priorToolNote =
      this.abortedToolNotes.length > 0
        ? `[Tool actions already completed earlier in this turn before the user continued speaking — do not repeat them: ${this.abortedToolNotes.splice(0).join("; ")}]`
        : null;
    const fullContext = [approvalOutcomeNote, priorToolNote, context].filter((part): part is string => Boolean(part && part.trim() !== "")).join("\n\n");
    const system = buildSystemPrompt(host.persona(), new Date(scheduler.now()), this.replyLang(), { codeSwitched: hasCodeSwitch(text) });
    const base: ChatMessage[] = [
      { role: "system", content: system },
      ...this.history.slice(-this.cfg.maxHistory),
      { role: "user", content: fullContext !== "" ? `${fullContext}\n\n${text}` : text },
    ];
    this.history.push({ role: "user", content: text });
    const tools = host.tools();
    const rounds: ChatMessage[] = [];
    let round = 0;
    let failed = false;
    for (;;) {
      round++;
      const calls: ToolCall[] = [];
      let roundText = "";
      for await (const event of brain.stream({ messages: [...base, ...rounds], tools: round > this.cfg.maxToolRounds ? [] : tools, signal: reply.abort.signal })) {
        if (reply.aborted) return;
        this.onBrainEvent(reply, event, calls, (t) => (roundText += t));
        if (event.type === "error") failed = true;
      }
      if (reply.aborted) return;
      if (failed) break;
      if (calls.length === 0) {
        reply.full += roundText;
        break;
      }
      reply.full += roundText;
      rounds.push({ role: "assistant", content: roundText, toolCalls: calls });
      for (const call of calls) {
        if (reply.aborted) return;
        const result = await host.runTool(call, { turn: reply.turn, signal: reply.abort.signal });
        const summary = `${call.name} -> ${result.text.replace(/\s+/g, " ").trim().slice(0, 140)}`;
        if (reply.aborted) {
          this.noteAbortedToolOutcome(summary);
          return;
        }
        reply.completedTools.push(summary);
        if (result.narration && !reply.sentFirstToken) {
          reply.sentFirstToken = true;
          for (const piece of new SpeechChunker(() => this.replyLang()).push(result.narration + " ")) reply.speech.enqueue(piece);
          reply.full += `${result.narration} `;
        }
        rounds.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.text });
      }
    }
    if (reply.aborted) return;
    if (failed) this.failReply(reply);
    for (const piece of reply.chunker.flush()) reply.speech.enqueue(piece);
    this.send({ type: "assistant", turn: reply.turn, text: reply.full.trim(), done: true });
    await reply.speech.finish();
    if (reply.aborted || this.reply !== reply) return;
    this.finishReply(reply);
  }

  private onBrainEvent(reply: Reply, event: BrainEvent, calls: ToolCall[], addText: (t: string) => string): void {
    switch (event.type) {
      case "text": {
        if (!reply.sentFirstToken || !reply.trace?.firstToken) {
          if (reply.trace && reply.trace.firstToken === null) reply.trace.firstToken = this.deps.scheduler.now();
        }
        reply.sentFirstToken = true;
        reply.cancelFiller?.();
        const soFar = addText(event.delta);
        for (const piece of reply.chunker.push(event.delta)) reply.speech.enqueue(piece);
        this.send({ type: "assistant", turn: reply.turn, text: (reply.full + soFar).trim(), done: false });
        break;
      }
      case "tool":
        calls.push(event.call);
        break;
      case "error":
        this.deps.log(`the model failed: ${event.message}`);
        this.send({ type: "notice", level: "warn", text: event.message });
        break;
      case "notice":
        // Said on the card, and the answer goes on.
        this.deps.log(`the model said: ${event.text}`);
        this.send({ type: "notice", level: "warn", text: event.text });
        break;
      case "usage":
      case "done":
        break;
    }
  }

  private finishReply(reply: Reply): void {
    const text = reply.full.trim();
    if (text !== "") this.history.push({ role: "assistant", content: text });
    this.deps.host.record({ turn: reply.turn, role: "assistant", text, source: reply.source === "event" ? "event" : "voice", at: this.deps.scheduler.now() });
    this.reply = null;
    this.setAgent("idle");
  }

  private noteAbortedToolOutcome(summary: string): void {
    const last = this.history[this.history.length - 1];
    if (last && last.role === "assistant" && last.content.includes("[the user interrupted")) {
      const markerIdx = last.content.indexOf("[the user interrupted");
      const prefix = last.content.slice(0, markerIdx);
      const suffix = last.content.slice(markerIdx);
      last.content = `${prefix}[completed before interruption: ${summary}] ${suffix}`;
      return;
    }
    this.abortedToolNotes.push(summary);
  }

  /** The reply is over before it was heard (the person spoke again), or is being replaced. */
  private cancelPendingReply(): void {
    const r = this.reply;
    if (!r || r.speech.started) return;
    r.aborted = true;
    r.abort.abort();
    r.cancelFiller?.();
    r.speech.abort();
    if (r.completedTools.length > 0) this.abortedToolNotes.push(...r.completedTools);
    this.reply = null;
    this.setAgent("idle");
  }

  /** The person has cut the assistant off: stop at once, and remember only what they heard. */
  private interruptReply(reason: string): void {
    const r = this.reply;
    if (!r) return;
    const wasSpeaking = r.speech.started;
    r.aborted = true;
    r.abort.abort();
    r.cancelFiller?.();
    const heard = r.speech.heard().text;
    r.speech.abort();
    this.reply = null;
    const toolNote = r.completedTools.length > 0 ? `[completed before interruption: ${r.completedTools.join("; ")}] ` : "";
    if (wasSpeaking) {
      this.send({ type: "interrupted", utterance: r.speech.utterance, heard });
      if (heard.trim() !== "") this.history.push({ role: "assistant", content: `${heard.trim()} ${toolNote}[the user interrupted here]` });
      else this.history.push({ role: "assistant", content: `${toolNote}[the user interrupted before you said anything]` });
      this.deps.host.record({ turn: r.turn, role: "assistant", text: r.full.trim(), source: "voice", at: this.deps.scheduler.now(), heard, interrupted: true });
      if (r.trace) r.trace.bargeIn = true;
    } else if (r.completedTools.length > 0) {
      this.abortedToolNotes.push(...r.completedTools);
    }
    this.deps.log(`reply ${r.id} stopped: ${reason}${wasSpeaking ? `, heard "${heard.slice(0, 60)}"` : ""}`);
    this.setAgent("idle");
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Unprompted

  private onHostEvent(event: HostEvent): void {
    if (this.closed) return;
    const note = event.note !== undefined ? event.note : event.say;
    this.send({ type: "task", id: event.id, title: event.title, status: event.status, note });
    if (event.say) {
      const existing = this.pendingSay.findIndex((e) => e.id === event.id && e.kind === event.kind);
      if (existing >= 0) this.pendingSay.splice(existing, 1);
      this.pendingSay.push(event);
      if (this.pendingSay.length > 8) this.pendingSay.shift();
    }
  }

  private scheduleTick(): void {
    this.cancelTick = this.deps.scheduler.after(250, () => {
      if (this.closed) return;
      this.enqueue(async () => this.maybeSpeakPending());
      this.scheduleTick();
    });
  }

  private async maybeSpeakPending(): Promise<void> {
    if ((this.pendingSay.length === 0 && this.openingSay === null) || this.reply || this.agent !== "idle" || this.taker.inTurn || this.muted) return;
    if (this.taker.quietForMs(this.nowMs()) < this.cfg.proactiveQuietMs) return;
    // What was waiting when the call opened comes first; it is said once.
    if (this.openingSay !== null) {
      const text = this.openingSay;
      this.openingSay = null;
      this.sayDirect(text, true);
      return;
    }
    const event = this.pendingSay.shift() as HostEvent;
    this.sayDirect(event.say as string, true);
  }

  /** Says something that no model was asked for: a task's news, or that a turn could not be made out. */
  private sayDirect(text: string, remember: boolean): void {
    const reply = this.newReply(this.turnCounter, null, "event", null);
    this.reply = reply;
    reply.full = text;
    for (const piece of new SpeechChunker(() => this.replyLang()).push(`${text} `)) reply.speech.enqueue(piece);
    this.send({ type: "assistant", turn: reply.turn, text, done: true });
    void reply.speech.finish().then(() => {
      if (reply.aborted || this.reply !== reply) return;
      if (remember) {
        this.history.push({ role: "assistant", content: text });
        this.deps.host.record({ turn: reply.turn, role: "assistant", text, source: "event", at: this.deps.scheduler.now() });
      }
      this.reply = null;
      this.setAgent("idle");
    });
  }
}

export { PROTOCOL_VERSION };
