import type { TtsEngine } from "./engines.js";
import { encodeAudioOut, type ServerMessage } from "./protocol.js";
import type { Scheduler } from "./scheduler.js";
import { SpokenLedger, wordsHeard } from "./spoken.js";

/**
 * The assistant's voice for one reply. Sentences are said in order; the audio goes to the person's speakers a little
 * ahead of what they have heard and no further, so that cutting the assistant off costs little work and wastes little
 * audio, and everything said is accounted for, so that after an interruption the model goes on from what was heard.
 */

export interface SpeechDeps {
  tts: TtsEngine;
  scheduler: Scheduler;
  send: (message: ServerMessage) => void;
  sendAudio: (frame: Buffer) => void;
  /** The voice and speed for a sentence. */
  voiceFor: (text: string) => { voice: string; speed: number };
  /** Audio is sent this far ahead of what has played, in milliseconds. */
  aheadMs: number;
  /** Called when the first sound of the reply is on its way to the speakers. */
  onFirstAudio: () => void;
  log: (line: string) => void;
}

const FRAME_MS = 40;

export class SpeechOut {
  readonly ledger = new SpokenLedger();
  private readonly queue: string[] = [];
  private readonly abortController = new AbortController();
  private sent = 0;
  private played = 0;
  private chunk = 0;
  private working = false;
  private ended = false;
  private firstSent = false;
  private wake: (() => void) | null = null;
  private cancelFallback: (() => void) | null = null;
  private readonly waiters: Array<() => void> = [];
  private aborted = false;
  private lastReportAt = 0;
  private firstAudioAt = 0;

  constructor(
    readonly utterance: number,
    readonly turn: number,
    private readonly deps: SpeechDeps,
  ) {}

  get isAborted(): boolean {
    return this.aborted;
  }

  get sentSamples(): number {
    return this.sent;
  }

  get playedSamples(): number {
    return this.played;
  }

  /** Whether anything has been sent to the speakers yet. */
  get started(): boolean {
    return this.firstSent;
  }

  /** The text of the reply that is queued or said so far. */
  get spokenText(): string {
    return [...this.ledger.segments.map((s) => s.text), ...this.queue].join(" ");
  }

  enqueue(text: string): void {
    if (this.aborted || this.ended || text.trim() === "") return;
    this.queue.push(text);
    if (!this.working) void this.run();
  }

  /** No more text will come: resolves once all of it has been said and played (or the voice was cut off). */
  async finish(): Promise<void> {
    this.ended = true;
    if (!this.working && this.queue.length === 0) this.settleIfDone();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.settleIfDone();
    });
  }

  /** A client that has stopped saying what it plays is taken to play in real time, so the voice is not held back for ever. */
  private estimatePlayed(): void {
    if (!this.firstSent) return;
    const now = this.deps.scheduler.now();
    if (now - this.lastReportAt < 2000) return;
    const elapsed = ((now - this.firstAudioAt) / 1000) * this.deps.tts.sampleRate;
    this.played = Math.max(this.played, Math.min(this.sent, Math.round(elapsed)));
  }

  /** What the speakers have played, as the client reports it. */
  reportPlayed(samples: number): void {
    this.lastReportAt = this.deps.scheduler.now();
    if (samples > this.played) this.played = Math.min(samples, this.sent);
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
    this.settleIfDone();
  }

  /** The words of the reply the person heard, given what the speakers had played. */
  heard(playedSamples = this.played): { text: string; complete: boolean } {
    const h = this.ledger.heard(playedSamples);
    return { text: h.text, complete: h.complete && this.queue.length === 0 };
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.queue.length = 0;
    this.abortController.abort();
    this.cancelFallback?.();
    this.cancelFallback = null;
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
    for (const w of this.waiters.splice(0)) w();
  }

  private settleIfDone(): void {
    if (this.aborted) return;
    if (!this.ended || this.working || this.queue.length > 0) return;
    if (this.played >= this.sent) {
      this.cancelFallback?.();
      this.cancelFallback = null;
      this.deps.send({ type: "speak_end", utterance: this.utterance });
      for (const w of this.waiters.splice(0)) w();
      return;
    }
    // A client that does not say what it played must not hold the reply open for ever: the audio's own length, and a grace.
    if (!this.cancelFallback) {
      const remainingMs = ((this.sent - this.played) / this.deps.tts.sampleRate) * 1000 + 1500;
      this.cancelFallback = this.deps.scheduler.after(remainingMs, () => {
        this.cancelFallback = null;
        this.played = this.sent;
        this.settleIfDone();
      });
    }
  }

  private async run(): Promise<void> {
    this.working = true;
    const { tts, scheduler } = this.deps;
    const rate = tts.sampleRate;
    try {
      while (this.queue.length > 0 && !this.aborted) {
        const text = this.queue.shift() as string;
        const { voice, speed } = this.deps.voiceFor(text);
        this.deps.send({ type: "speaking", utterance: this.utterance, turn: this.turn, text, samples: Math.round(text.length * 0.06 * rate) });
        let samples = 0;
        let cut = false;
        const startedAt = this.sent;
        for await (const pcm of tts.synthesize(text, { voice, speed, signal: this.abortController.signal })) {
          if (this.aborted) {
            cut = true;
            break;
          }
          // Hold back while the speakers are far behind: audio that is not needed yet is not made yet.
          while (!this.aborted && ((this.sent - this.played) / rate) * 1000 > this.deps.aheadMs) {
            await new Promise<void>((resolve) => {
              const cancel = scheduler.after(250, () => {
                this.wake = null;
                this.estimatePlayed();
                resolve();
              });
              this.wake = () => {
                cancel();
                resolve();
              };
            });
          }
          if (this.aborted) {
            cut = true;
            break;
          }
          const step = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
          for (let i = 0; i < pcm.length; i += step) {
            const piece = pcm.subarray(i, Math.min(pcm.length, i + step));
            this.deps.sendAudio(encodeAudioOut(this.utterance, this.chunk++, this.sent, piece));
            this.sent += piece.length;
            samples += piece.length;
            if (!this.firstSent) {
              this.firstSent = true;
              this.firstAudioAt = this.lastReportAt = scheduler.now();
              this.deps.onFirstAudio();
            }
          }
        }
        if (cut || this.aborted) {
          // The sentence was cut while it was being made: what was sent of it counts in proportion.
          if (samples > 0) {
            const estimate = Math.max(samples, Math.round(text.length * 0.06 * rate));
            this.ledger.add(wordsHeard(text, samples / estimate) || text.split(" ")[0] || text, samples);
          }
          break;
        }
        this.ledger.add(text, this.sent - startedAt);
      }
    } catch (error) {
      if (!this.aborted) this.deps.log(`the voice failed on a sentence: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.working = false;
      if (this.queue.length > 0 && !this.aborted) void this.run();
      else this.settleIfDone();
    }
  }
}
