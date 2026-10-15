import { EventEmitter } from "node:events";

/** One turn of the event loop, after anything Node holds back until the next tick has gone out. */
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The bit of `ServerResponse` the event stream touches. One that `drains` takes everything; the other queues what it
 * is given and never gives a byte back until a test says so with `drain()`.
 */
export class FakeRes extends EventEmitter {
  chunks: string[] = [];
  bytes = 0;
  writableLength = 0;
  writableNeedDrain = false;
  writableEnded = false;
  destroyed = false;
  ended = false;
  statusCode = 0;
  headers: Record<string, unknown> = {};

  /**
   * `drains` false is a reader that takes nothing. `flushesOnTick` is the real response with a reader that keeps up:
   * what is written in one tick is held until the next, then goes out whole and `drain` fires.
   */
  constructor(
    private readonly drains: boolean,
    private readonly options: { flushesOnTick?: boolean } = {},
  ) {
    super();
  }

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    const size = Buffer.byteLength(chunk);
    this.bytes += size;
    if (this.drains) {
      return true;
    }
    this.writableLength += size;
    this.writableNeedDrain = true;
    if (this.options.flushesOnTick) {
      process.nextTick(() => {
        if (this.writableNeedDrain && !this.destroyed) {
          this.drain();
        }
      });
    }
    return false;
  }

  /** The reader took `bytes` of the queue and is still behind: no `drain`, as Node only says that when it is empty. */
  take(bytes: number): void {
    this.writableLength = Math.max(0, this.writableLength - bytes);
  }

  /** The reader caught up: the queue is empty and `drain` fires, as the real response does. */
  drain(): void {
    this.writableLength = 0;
    this.writableNeedDrain = false;
    this.emit("drain");
  }

  end(): this {
    this.writableEnded = true;
    this.ended = true;
    process.nextTick(() => this.emit("close"));
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      process.nextTick(() => this.emit("close"));
    }
    return this;
  }

  /** Every frame written, parsed. */
  frames(): { event: string; data: any }[] {
    return this.chunks.map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      return { event, data: data === undefined ? null : JSON.parse(data) };
    });
  }

  /** The heartbeats written so far. */
  pings(): number {
    return this.chunks.filter((chunk) => chunk.startsWith("event: ping\n")).length;
  }
}

/** A clock a test moves by hand. */
export class ManualClock {
  constructor(public at = 1_000) {}
  now = (): number => this.at;
  advance(ms: number): void {
    this.at += ms;
  }
}
