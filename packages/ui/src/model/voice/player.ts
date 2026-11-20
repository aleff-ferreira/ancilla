/**
 * The assistant's voice on the speakers. Audio arrives in pieces ahead of when it is to be heard; each piece is scheduled
 * to start exactly where the one before it ends, so there is no gap and no click, and the page keeps count of how much of
 * the reply the person has really heard, which is what the server needs when it is cut off: what they did not hear is not
 * remembered as said.
 */

export interface Player {
  /** A stretch of the reply; `utterance` names the reply it belongs to. */
  enqueue(utterance: number, pcm: Int16Array): void;
  /** How many samples of the reply the speakers have played by now. */
  played(utterance: number): number;
  /** The reply that is playing or was last scheduled, or 0. */
  current(): number;
  /** Silence the speakers now; returns the reply that was cut and how much of it was heard. */
  stop(): { utterance: number; played: number };
  /** Lower the voice (someone may be about to speak) or bring it back. */
  duck(on: boolean): void;
  /**
   * Silence the voice at once but keep its place (and whatever arrives meanwhile), until `resume` or until `leaseMs` have
   * passed with no further `pause`, so that a voice paused for a sound that was never meant for it cannot stay silent for
   * ever. Returns where it stopped; null when it was paused already (the lease is only renewed).
   */
  pause?(leaseMs: number): { utterance: number; played: number } | null;
  /** Goes on from where `pause` stopped. */
  resume?(): void;
  /** How loud the voice is right now, 0 to 1. */
  level(): number;
  close(): void;
}

interface Piece {
  utterance: number;
  samples: number;
  start: number;
}

/**
 * The accounting of what has played, apart from any speaker, so that it is tested with a clock that is moved by hand.
 * Times are seconds on the audio clock.
 */
export class PlaybackLedger {
  private pieces: Piece[] = [];
  private readonly retired = new Map<number, number>();
  private end = 0;
  private latest = 0;

  constructor(private readonly rate: number) {}

  /** Where a piece of `samples` is to start, given the time now and how soon audio may begin. Remembers it. */
  schedule(utterance: number, samples: number, now: number, lead: number): number {
    const start = Math.max(now + lead, this.end);
    this.pieces.push({ utterance, samples, start });
    this.end = start + samples / this.rate;
    this.latest = utterance;
    return start;
  }

  /** Samples of `utterance` heard by `now` (the time at the speaker, so output latency is already taken off). */
  played(utterance: number, now: number): number {
    let total = this.retired.get(utterance) ?? 0;
    for (const p of this.pieces) {
      if (p.utterance !== utterance) continue;
      total += Math.max(0, Math.min(p.samples, Math.floor((now - p.start) * this.rate)));
    }
    return total;
  }

  get current(): number {
    return this.latest;
  }

  /** Time until everything scheduled has played, in seconds. */
  remaining(now: number): number {
    return Math.max(0, this.end - now);
  }

  /** Drops everything scheduled, and says what was heard of the reply that was playing. */
  clear(now: number): { utterance: number; played: number } {
    const utterance = this.latest;
    const played = this.played(utterance, now);
    this.pieces = [];
    this.retired.clear();
    this.end = 0;
    return { utterance, played };
  }

  /** Moves everything that had not finished at `at` later by `delta` seconds, as when the voice was paused for that long. */
  shift(at: number, delta: number): void {
    for (const p of this.pieces) if (p.start + p.samples / this.rate > at) p.start += delta;
    if (this.end > at) this.end += delta;
  }

  /** Forgets pieces that finished long ago, so that a long call does not keep every sentence. */
  trim(now: number): void {
    const keep: Piece[] = [];
    for (const p of this.pieces) {
      if (p.start + p.samples / this.rate > now - 5) {
        keep.push(p);
      } else {
        this.retired.set(p.utterance, (this.retired.get(p.utterance) ?? 0) + p.samples);
      }
    }
    this.pieces = keep;
    while (this.retired.size > 8) {
      const oldest = this.retired.keys().next().value;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }
}

/** How soon audio may start after it arrives: a little, so that two pieces that arrive together are joined. */
const LEAD_SECONDS = 0.04;
const DUCKED_GAIN = 0.2;
/** A paused voice fades out over about this long (the sources stop after it), so that it does not click. */
const PAUSE_FADE_SECONDS = 0.03;

interface Held {
  utterance: number;
  pcm: Int16Array;
}

interface PausedState {
  /** When the sources were told to stop, on the audio clock. */
  stopAt: number;
  /** What was still to play, in order, and where in the first of them it was. */
  pieces: Array<{ buffer: AudioBuffer; utterance: number; samples: number; start: number; offset: number }>;
  lease: ReturnType<typeof setTimeout> | null;
  /** Audio that arrived while paused. */
  held: Held[];
}

/** The speakers, through Web Audio. */
export class WebPlayer implements Player {
  private readonly ledger: PlaybackLedger;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly meta = new Map<AudioBufferSourceNode, { buffer: AudioBuffer; utterance: number; samples: number; start: number }>();
  private readonly scheduledSamples = new Map<number, number>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scratch: Uint8Array<ArrayBuffer>;
  private paused: PausedState | null = null;
  private ducked = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly rate: number,
    private readonly onIdle?: (utterance: number, played: number) => void,
  ) {
    this.ledger = new PlaybackLedger(rate);
    this.gain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.scratch = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.gain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  /** The audio clock, moved back by what the speakers and the device add, so that it says what is being heard. */
  private heardAt(): number {
    const ctx = this.ctx;
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  enqueue(utterance: number, pcm: Int16Array): void {
    if (pcm.length === 0) return;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.scheduledSamples.set(utterance, (this.scheduledSamples.get(utterance) ?? 0) + pcm.length);
    while (this.scheduledSamples.size > 8) {
      const oldest = this.scheduledSamples.keys().next().value;
      if (oldest === undefined) break;
      this.scheduledSamples.delete(oldest);
    }
    // While the voice is paused what arrives is kept, in order, for when it goes on.
    if (this.paused) {
      this.paused.held.push({ utterance, pcm });
      return;
    }
    this.begin(utterance, pcm);
  }

  private bufferOf(pcm: Int16Array): AudioBuffer {
    const buffer = this.ctx.createBuffer(1, pcm.length, this.rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] as number) / 32768;
    return buffer;
  }

  private begin(utterance: number, pcm: Int16Array): void {
    const buffer = this.bufferOf(pcm);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const start = this.ledger.schedule(utterance, pcm.length, this.ctx.currentTime, LEAD_SECONDS);
    source.start(start);
    this.track(source, buffer, utterance, pcm.length, start);
    this.ledger.trim(this.ctx.currentTime);
  }

  private track(source: AudioBufferSourceNode, buffer: AudioBuffer, utterance: number, samples: number, start: number): void {
    this.sources.add(source);
    this.meta.set(source, { buffer, utterance, samples, start });
    source.onended = () => {
      if (!this.sources.delete(source)) return;
      this.meta.delete(source);
      source.disconnect();
      if (this.sources.size === 0 && this.onIdle) {
        const playedNow = this.played(utterance);
        this.onIdle(utterance, playedNow);
        const total = this.scheduledSamples.get(utterance) ?? 0;
        const lagSec = this.ctx.outputLatency || this.ctx.baseLatency || 0;
        if (playedNow < total && lagSec > 0) {
          if (this.idleTimer !== null) clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.sources.size === 0 && this.current() === utterance && this.onIdle) {
              this.onIdle(utterance, this.played(utterance));
            }
          }, Math.min(500, Math.ceil(lagSec * 1000) + 12));
        }
      }
    };
  }

  played(utterance: number): number {
    // A paused voice has played what it had when the sources were stopped, whatever the clock says since.
    return this.ledger.played(utterance, this.paused ? this.paused.stopAt : this.heardAt());
  }

  current(): number {
    return this.ledger.current;
  }

  stop(): { utterance: number; played: number } {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.scheduledSamples.clear();
    const wasPaused = this.paused !== null;
    const pausedAt = this.paused ? this.paused.stopAt : null;
    if (this.paused?.lease) clearTimeout(this.paused.lease);
    this.paused = null;
    const out = this.ledger.clear(pausedAt ?? this.heardAt());
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        /* a source that has already ended */
      }
    }
    this.sources.clear();
    this.meta.clear();
    if (wasPaused) {
      // The voice was faded out for the pause: it is back at full at once, for whatever is said next.
      this.ducked = false;
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setValueAtTime(1, this.ctx.currentTime);
    } else {
      this.duck(false);
    }
    return out;
  }

  pause(leaseMs: number): { utterance: number; played: number } | null {
    if (this.paused) {
      this.armLease(leaseMs);
      return null;
    }
    const now = this.ctx.currentTime;
    const stopAt = now + PAUSE_FADE_SECONDS;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(0, now, 0.006);
    const state: PausedState = { stopAt, pieces: [], lease: null, held: [] };
    // What has not finished by then is stopped, and started afresh from where it was when the voice goes on.
    for (const [source, m] of [...this.meta]) {
      const elapsed = Math.max(0, stopAt - m.start);
      if (elapsed * this.rate >= m.samples) continue; // it has finished by then
      state.pieces.push({ buffer: m.buffer, utterance: m.utterance, samples: m.samples, start: m.start, offset: elapsed });
      try {
        source.onended = null;
        source.stop(stopAt);
      } catch {
        /* a source that has already ended */
      }
      this.sources.delete(source);
      this.meta.delete(source);
    }
    this.paused = state;
    this.armLease(leaseMs);
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const utterance = this.ledger.current;
    return { utterance, played: this.ledger.played(utterance, stopAt) };
  }

  private armLease(leaseMs: number): void {
    const state = this.paused;
    if (!state) return;
    if (state.lease) clearTimeout(state.lease);
    state.lease = setTimeout(() => this.resume(), Math.max(50, leaseMs));
  }

  resume(): void {
    const state = this.paused;
    if (!state) return;
    if (state.lease) clearTimeout(state.lease);
    this.paused = null;
    const now = this.ctx.currentTime;
    const resumeAt = now + LEAD_SECONDS;
    const delta = resumeAt - state.stopAt;
    this.ledger.shift(state.stopAt, delta);
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.setTargetAtTime(this.ducked ? DUCKED_GAIN : 1, now, 0.01);
    let first = true;
    for (const piece of state.pieces) {
      const source = this.ctx.createBufferSource();
      source.buffer = piece.buffer;
      source.connect(this.gain);
      const start = piece.start + delta;
      if (first && piece.offset > 0) source.start(resumeAt, piece.offset);
      else source.start(Math.max(resumeAt, start));
      first = false;
      this.track(source, piece.buffer, piece.utterance, piece.samples, start);
    }
    for (const held of state.held) this.begin(held.utterance, held.pcm);
  }

  duck(on: boolean): void {
    this.ducked = on;
    if (this.paused) return;
    this.gain.gain.setTargetAtTime(on ? DUCKED_GAIN : 1, this.ctx.currentTime, 0.04);
  }

  level(): number {
    this.analyser.getByteTimeDomainData(this.scratch);
    let sum = 0;
    for (const v of this.scratch) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.min(1, Math.sqrt(sum / this.scratch.length) * 3.2);
  }

  close(): void {
    this.stop();
    this.gain.disconnect();
    this.analyser.disconnect();
  }
}
