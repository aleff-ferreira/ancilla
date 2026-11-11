/**
 * Test doubles for a call, and a simulated client, so that whole conversations run without a model, a microphone or a
 * clock. The "audio" is real samples that carry their meaning: a person's sentence is a tone whose pitch says which
 * sentence it is, and the recogniser double listens for that pitch. The assistant's voice is a different tone whose length
 * follows its text. The simulated client plays what it is sent at real speed (in the scheduler's time), reports how much
 * it played, and drops what is left when told it was cut off, as a browser would.
 */

import type { PendingAuthorizationView } from "../assistant/launcher.js";
import type { BrainEvent, BrainProvider, BrainRequest, ChatMessage, ToolCall, ToolSpec } from "./brain.js";
import type { AsrEngine, AsrResult, AsrStream, Engines, TtsEngine, VadEngine, Voice } from "./engines.js";
import type { HostEvent, Persona, ToolResult, TranscriptEntry, VoiceHost } from "./host.js";
import { decodeAudioOut, type ClientMessage, type ServerMessage } from "./protocol.js";
import type { ManualScheduler, Scheduler } from "./scheduler.js";
import { VoiceSession, type SessionConfig } from "./session.js";

const IN_RATE = 16_000;

/** A pure tone, as microphone samples. */
export function tone(freq: number, ms: number, amp = 0.3, rate = IN_RATE): Int16Array {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767);
  return out;
}

/** The pitch of the person's sentence number `code`. */
export const pitchOf = (code: number): number => 600 + 50 * code;

/** Says speech from silence by loudness. */
export class FakeVad implements VadEngine {
  readonly id = "fake-vad";
  readonly frameSamples = 512;
  process(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += (frame[i] as number) ** 2;
    return Math.min(1, Math.sqrt(sum / frame.length) / 0.08);
  }
  reset(): void {}
}

interface Run {
  freq: number;
  ms: number;
}

class FakeAsrStream implements AsrStream {
  private readonly runs: Run[] = [];
  private current: { crossings: number; samples: number; last: number } | null = null;
  private voicedMs = 0;
  disposed = false;

  constructor(
    private readonly sentences: ReadonlyMap<number, string>,
    private readonly delayMs: number,
    private readonly scheduler: Scheduler,
  ) {}

  accept(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i += 160) {
      const win = samples.subarray(i, Math.min(samples.length, i + 160));
      let sum = 0;
      for (let k = 0; k < win.length; k++) sum += (win[k] as number) ** 2;
      const loud = Math.sqrt(sum / win.length) > 0.03;
      if (!loud) {
        this.closeRun();
        continue;
      }
      if (!this.current) this.current = { crossings: 0, samples: 0, last: 0 };
      for (let k = 0; k < win.length; k++) {
        const v = win[k] as number;
        if ((v >= 0) !== (this.current.last >= 0) && this.current.samples > 0) this.current.crossings++;
        this.current.last = v;
        this.current.samples++;
      }
    }
  }

  private closeRun(): void {
    const c = this.current;
    this.current = null;
    if (!c || c.samples < 800) return;
    const seconds = c.samples / IN_RATE;
    this.runs.push({ freq: c.crossings / 2 / seconds, ms: seconds * 1000 });
    this.voicedMs += seconds * 1000;
  }

  private textOf(run: Run): string {
    let best: { d: number; text: string } | null = null;
    for (const [code, text] of this.sentences) {
      const d = Math.abs(pitchOf(code) - run.freq);
      if (d < 26 && (!best || d < best.d)) best = { d, text };
    }
    return best?.text ?? "";
  }

  private snapshotRuns(): Run[] {
    const c = this.current;
    if (!c || c.samples < 800) return this.runs;
    const seconds = c.samples / IN_RATE;
    return [...this.runs, { freq: c.crossings / 2 / seconds, ms: seconds * 1000 }];
  }

  /** How many times the session asked for the last words (the person had gone quiet). */
  flushes = 0;

  flush(): void {
    this.flushes++;
    this.closeRun();
  }

  partial(): AsrResult {
    // While a person is speaking the words come out at their pace, a little behind the sound; once they stop, the rest follows.
    const closed = this.runs.length;
    const runs = this.snapshotRuns();
    const words: string[] = [];
    runs.forEach((run, index) => {
      const text = this.textOf(run).split(/\s+/).filter(Boolean);
      const shown = index < closed ? text.length : Math.min(text.length, Math.floor(run.ms / 250));
      words.push(...text.slice(0, shown));
    });
    return { text: words.join(" ") };
  }

  async finish(): Promise<AsrResult> {
    this.closeRun();
    if (this.delayMs > 0) await new Promise<void>((resolve) => this.scheduler.after(this.delayMs, resolve));
    return { text: this.runs.map((r) => this.textOf(r)).filter(Boolean).join(" ") };
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeAsr implements AsrEngine {
  readonly id = "fake-asr";
  readonly streams: FakeAsrStream[] = [];
  private readonly sentences: Map<number, string>;

  constructor(
    sentences: Record<number, string>,
    private readonly scheduler: Scheduler,
    private readonly finalDelayMs = 0,
  ) {
    this.sentences = new Map(Object.entries(sentences).map(([k, v]) => [Number(k), v]));
  }

  open(): AsrStream {
    const s = new FakeAsrStream(this.sentences, this.finalDelayMs, this.scheduler);
    this.streams.push(s);
    return s;
  }

  get openStreams(): number {
    return this.streams.filter((s) => !s.disposed).length;
  }
}

/** The assistant's voice: a low tone as long as the sentence would take to say. */
export class FakeTts implements TtsEngine {
  readonly id = "fake-tts";
  readonly sampleRate = 16_000;
  readonly voices: readonly Voice[] = [
    { id: "en-1", name: "English", lang: "en" },
    { id: "pt-1", name: "Portuguese", lang: "pt" },
  ];
  readonly said: Array<{ text: string; voice: string }> = [];

  constructor(
    private readonly scheduler: Scheduler,
    private readonly options: { msPerChar?: number; latencyMs?: number } = {},
  ) {}

  async *synthesize(text: string, o: { voice: string; speed: number; signal: AbortSignal }): AsyncGenerator<Int16Array> {
    this.said.push({ text, voice: o.voice });
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await new Promise<void>((resolve) => this.scheduler.after(latency, resolve));
    if (o.signal.aborted) return;
    const ms = Math.max(300, text.length * (this.options.msPerChar ?? 60));
    yield tone(300, ms, 0.25, this.sampleRate);
  }
}

export interface Reply {
  text?: string;
  /** Time before the first word. */
  ttftMs?: number;
  /** Time between pieces of text. */
  pieceMs?: number;
  tool?: { name: string; args: Record<string, unknown> };
  error?: string;
  /** Said to the person before the reply, which goes on. */
  notice?: string;
}

/** A model that says what it is told, at the pace it is told. */
export class ScriptedBrain implements BrainProvider {
  readonly id = "scripted";
  readonly label = "Scripted";
  readonly capabilities = { tools: true, speculative: true, local: true };
  readonly requests: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }> = [];
  aborted = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly script: (messages: ChatMessage[], call: number) => Reply,
  ) {}

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    this.requests.push({ messages: request.messages, tools: request.tools });
    const reply = this.script(request.messages, this.requests.length);
    const wait = (ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const cancel = this.scheduler.after(ms, () => resolve(true));
        request.signal.addEventListener("abort", () => {
          cancel();
          resolve(false);
        }, { once: true });
      });
    if (!(await wait(reply.ttftMs ?? 200))) {
      this.aborted++;
      return;
    }
    if (reply.notice) yield { type: "notice", text: reply.notice };
    if (reply.error) {
      yield { type: "error", message: reply.error, retryable: true };
      return;
    }
    if (reply.tool) {
      const call: ToolCall = { id: `c${this.requests.length}`, name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) };
      yield { type: "tool", call };
      yield { type: "done", reason: "tool" };
      return;
    }
    const text = reply.text ?? "";
    for (let i = 0; i < text.length; i += 8) {
      if (i > 0 && !(await wait(reply.pieceMs ?? 20))) {
        this.aborted++;
        return;
      }
      if (request.signal.aborted) {
        this.aborted++;
        return;
      }
      yield { type: "text", delta: text.slice(i, i + 8) };
    }
    yield { type: "done", reason: "stop" };
  }
}

export class FakeHost implements VoiceHost {
  readonly records: TranscriptEntry[] = [];
  readonly contexts: Array<{ text: string; source: string }> = [];
  readonly toolCalls: ToolCall[] = [];
  private handler: ((event: HostEvent) => void) | null = null;
  toolList: ToolSpec[] = [];
  toolResult: ToolResult = { ok: true, text: "done", narration: "Starting that now." };
  persona$: Persona = { name: "Vesper", callsUser: "Alex", language: null, tone: null, voice: null };
  memory: string | null = null;
  /** What the host would say as a call opens. */
  openingText: string | null = null;
  pendingApproval?: () => PendingAuthorizationView | null;
  decideApproval?: (id: string, allow: boolean) => Promise<{ ok: boolean; message: string }>;
  subscribeApprovals?: (handler: (request: PendingAuthorizationView | null) => void) => () => void;

  persona(): Persona {
    return this.persona$;
  }
  context(text: string, source: "voice" | "text"): string | null {
    this.contexts.push({ text, source });
    return this.memory;
  }
  record(entry: TranscriptEntry): void {
    this.records.push(entry);
  }
  tools(): ToolSpec[] {
    return this.toolList;
  }
  async runTool(call: ToolCall, _ctx?: { turn: number; signal: AbortSignal }): Promise<ToolResult> {
    this.toolCalls.push(call);
    return this.toolResult;
  }
  subscribe(handler: (event: HostEvent) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  history(): ChatMessage[] {
    return [];
  }
  opening(): string | null {
    return this.openingText;
  }
  emit(event: HostEvent): void {
    this.handler?.(event);
  }
}

export interface Stamped<T> {
  at: number;
  msg: T;
}

/** A browser's side of a call: speaks into the microphone, plays what it is sent, says how much it played. */
export class SimClient {
  readonly messages: Stamped<ServerMessage>[] = [];
  readonly audioIn: Stamped<{ utterance: number; samples: number }>[] = [];
  private queued = 0;
  private played = 0;
  private utterance = 0;
  private sinceReport = 0;
  private playing = false;
  firstPlayAt: number | null = null;
  playedAt: number[] = [];
  echoAmp = 0;
  rate = 16_000;

  constructor(
    readonly sched: ManualScheduler,
    private readonly getSession: () => VoiceSession,
  ) {}

  /** What the server sent, in order. */
  of<T extends ServerMessage["type"]>(type: T): Stamped<Extract<ServerMessage, { type: T }>>[] {
    return this.messages.filter((m) => m.msg.type === type) as Stamped<Extract<ServerMessage, { type: T }>>[];
  }

  receive = (msg: ServerMessage): void => {
    this.messages.push({ at: this.sched.now(), msg });
    if (msg.type === "ready") this.rate = msg.sampleRate;
    if (msg.type === "interrupted") this.queued = this.played; // the speakers are emptied
  };

  receiveAudio = (buf: Buffer): void => {
    const frame = decodeAudioOut(buf);
    if (!frame) return;
    if (frame.utterance !== this.utterance) {
      this.utterance = frame.utterance;
      this.queued = 0;
      this.played = 0;
    }
    this.queued += frame.pcm.length;
    this.audioIn.push({ at: this.sched.now(), msg: { utterance: frame.utterance, samples: frame.pcm.length } });
  };

  send(message: ClientMessage): void {
    this.getSession().onMessage(message);
  }

  /** One step of 20 ms: the speakers play, the microphone hears `mic`, time moves. */
  private async step(mic: Int16Array): Promise<void> {
    const session = this.getSession();
    const stepSamples = Math.round(this.rate * 0.02);
    const available = this.queued - this.played;
    const advance = Math.min(available, stepSamples);
    this.playing = advance > 0;
    if (advance > 0) {
      if (this.firstPlayAt === null) this.firstPlayAt = this.sched.now();
      this.played += advance;
      this.sinceReport += 20;
      this.playedAt.push(this.sched.now());
    }
    if (this.echoAmp > 0 && this.playing) {
      const echo = tone(300, 20, this.echoAmp);
      for (let i = 0; i < mic.length; i++) mic[i] = Math.max(-32768, Math.min(32767, (mic[i] as number) + (echo[i] as number)));
    }
    session.onAudio(mic);
    if (this.sinceReport >= 100 && this.utterance > 0) {
      this.sinceReport = 0;
      session.onMessage({ type: "playback", utterance: this.utterance, samples: this.played });
    }
    await this.sched.advance(20);
  }

  async speak(code: number, ms: number, amp = 0.3): Promise<void> {
    for (let t = 0; t < ms; t += 20) await this.step(tone(pitchOf(code), 20, amp));
  }

  async quiet(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 20) await this.step(new Int16Array(320));
  }

  /** Time passes with the microphone dead quiet until `until` holds, or `limitMs` have gone. */
  async until(until: () => boolean, limitMs = 20_000): Promise<boolean> {
    for (let t = 0; t < limitMs; t += 20) {
      if (until()) return true;
      await this.step(new Int16Array(320));
    }
    return until();
  }

  get playedSamples(): number {
    return this.played;
  }

  get playbackActive(): boolean {
    return this.playing;
  }
}

export interface Rig {
  sched: ManualScheduler;
  client: SimClient;
  session: VoiceSession;
  host: FakeHost;
  brain: ScriptedBrain;
  asr: FakeAsr;
  tts: FakeTts;
  engines: Engines;
  logs: string[];
}

/** Builds a call with every double in place. Call `rig.session.start(...)` (or `hello`) to open it. */
export async function makeRig(options: {
  sentences: Record<number, string>;
  script: (messages: ChatMessage[], call: number) => Reply;
  config?: Partial<SessionConfig>;
  asrFinalMs?: number;
  ttsLatencyMs?: number;
  msPerChar?: number;
  open?: boolean;
  mode?: "hands-free" | "push-to-talk";
}): Promise<Rig> {
  const { ManualScheduler: Manual } = await import("./scheduler.js");
  const sched = new Manual(1_000_000);
  const asr = new FakeAsr(options.sentences, sched, options.asrFinalMs ?? 0);
  const tts = new FakeTts(sched, { msPerChar: options.msPerChar ?? 60, latencyMs: options.ttsLatencyMs ?? 0 });
  const vad = new FakeVad();
  const engines: Engines = { vad, asr, tts };
  const host = new FakeHost();
  const brain = new ScriptedBrain(sched, options.script);
  const logs: string[] = [];
  let session!: VoiceSession;
  const client = new SimClient(sched, () => session);
  session = new VoiceSession({
    engines,
    brain,
    host,
    scheduler: sched,
    send: client.receive,
    sendAudio: client.receiveAudio,
    log: (line) => logs.push(line),
    ...(options.config ? { config: options.config } : {}),
    id: "test-call",
  });
  if (options.open !== false) await session.start({ type: "hello", v: 1, mode: options.mode ?? "hands-free", lang: null, echoCancelled: true, resume: null, thread: null });
  await sched.advance(0);
  return { sched, client, session, host, brain, asr, tts, engines, logs };
}
