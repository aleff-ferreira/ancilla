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
    let total = 0;
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
    this.end = 0;
    return { utterance, played };
  }

  /** Forgets pieces that finished long ago, so that a long call does not keep every sentence. */
  trim(now: number): void {
    this.pieces = this.pieces.filter((p) => p.start + p.samples / this.rate > now - 5);
  }
}

/** How soon audio may start after it arrives: a little, so that two pieces that arrive together are joined. */
const LEAD_SECONDS = 0.04;
const DUCKED_GAIN = 0.2;

/** The speakers, through Web Audio. */
export class WebPlayer implements Player {
  private readonly ledger: PlaybackLedger;
  private readonly gain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly scratch: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly ctx: AudioContext,
    private readonly rate: number,
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
    const buffer = this.ctx.createBuffer(1, pcm.length, this.rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] as number) / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const start = this.ledger.schedule(utterance, pcm.length, this.ctx.currentTime, LEAD_SECONDS);
    source.start(start);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    this.ledger.trim(this.ctx.currentTime);
  }

  played(utterance: number): number {
    return this.ledger.played(utterance, this.heardAt());
  }

  current(): number {
    return this.ledger.current;
  }

  stop(): { utterance: number; played: number } {
    const out = this.ledger.clear(this.heardAt());
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
    this.duck(false);
    return out;
  }

  duck(on: boolean): void {
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
