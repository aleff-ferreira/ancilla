/**
 * Time, as something a call is handed rather than something it reaches for. A real call uses the machine's clock and
 * timers; a test uses a manual one that moves only when told, so a whole conversation (speech, pauses, a model that
 * takes two seconds, an interruption half way through a sentence) replays in a few milliseconds and the same way every
 * time.
 */

export interface Scheduler {
  now(): number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const handle = setTimeout(fn, Math.max(0, ms));
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

/** A clock that moves when `advance` is called. Timers due within the step run in order, each at its own time. */
export class ManualScheduler implements Scheduler {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  after(ms: number, fn: () => void): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Moves the clock forward by `ms`, running whatever is due on the way, and lets pending promises settle at each stop. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let next: { id: number; at: number } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (next === null || timer.at < next.at || (timer.at === next.at && id < next.id))) next = { id, at: timer.at };
      }
      if (next === null) break;
      const timer = this.timers.get(next.id) as { at: number; fn: () => void };
      this.timers.delete(next.id);
      this.t = Math.max(this.t, timer.at);
      timer.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** Lets promise chains that are already resolvable run to their end. */
export async function settle(rounds = 24): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
