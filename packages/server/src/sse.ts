/**
 * The clients of the event stream, and what keeps one that stopped reading from costing the daemon its memory.
 *
 * Every frame goes straight to every client, as before: nothing here queues, merges or reorders, so every lifecycle
 * edge reaches a client that keeps up exactly as sent. What it adds is a bound on what Node itself holds for a client
 * that does not. A response whose `write()` was refused and which has not drained since is in trouble; one whose
 * unsent backlog is still past the cap at the end of the tick, or that completes no write for the whole stall
 * deadline, is destroyed. Nothing is lost by that: the browser reconnects, the server says hello, and the app rereads
 * what it missed.
 *
 * What counts as progress is what the response reports: its queue shrinking. Node sends everything buffered behind a
 * write in flight as one batch and lowers `writableLength` only when the whole batch is done, so a reader that is
 * taking bytes steadily inside one large batch shows nothing until the batch ends. Nothing finer is readable: on a
 * real socket `socket.bytesWritten` counts what was handed over (it is flat inside the batch just as `writableLength`
 * is, and equals what this class already counts), and the queue size the handle reports changes only when a batch is
 * dispatched, not as the kernel takes it. So the deadline is stated in terms of completed batches: a reader slower
 * than the batch it was handed divided by the deadline (about 46 KB/s for a backlog at the 4 MiB cap and the 90 s
 * default) can be cut even though it is still reading.
 */
import { performance } from "node:perf_hooks";

/** The most unsent bytes a client may hold behind the frame being added. */
export const SSE_MAX_BACKLOG_BYTES = 4 * 1024 * 1024;
/** How long a client may go without completing a write once one was refused. Long enough for a throttled webview. */
export const SSE_STALL_MS = 90_000;
/** A quiet stream says so this often, so a client can tell it from a dead one. The UI gives up after two missed. */
const HEARTBEAT_MS = 25_000;
const SWEEP_MS = 5_000;
/**
 * How late a sweep may be before it says the process was not running rather than the client not reading: a blocked
 * event loop, a suspended machine, a clock set forward. A little lateness is ordinary and counts against the client.
 */
const LAG_SLACK_MS = 2_000;

/** What a response has to offer. `ServerResponse` does; a test hands over a fake with the same four readings. */
export interface SseResponse {
  readonly writableLength: number;
  readonly writableNeedDrain: boolean;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  write(chunk: string): boolean;
  destroy(): unknown;
  on(event: "drain" | "close" | "error", listener: (...args: any[]) => void): unknown;
}

export interface SseOptions {
  maxBacklogBytes?: number;
  /** Zero turns the deadline off. */
  stallMs?: number;
  heartbeatMs?: number;
  sweepMs?: number;
  lagSlackMs?: number;
  /** A monotonic reading in milliseconds; the process's own clock by default. */
  now?: () => number;
  /** False leaves the sweeping to the caller, which is what a test with a clock of its own wants. */
  timer?: boolean;
}

export interface SseStats {
  clients: number;
  backlogHighWaterBytes: number;
  overflowDisconnects: number;
  stallDisconnects: number;
  serializationFailures: number;
  researchFramesSkipped: number;
  maxBacklogBytes: number;
  stallMs: number;
}

interface Client {
  res: SseResponse;
  /** When a write was refused and nothing has drained since, or the last time its queue was seen to shrink; null while it keeps up. */
  stalledSince: number | null;
  lastPingAt: number;
  /** Bytes handed to the response so far, and how many of them had left it when the stall was last looked at. */
  handed: number;
  flushed: number;
}

export class SseBroadcaster {
  private readonly clients = new Set<Client>();
  private readonly suspects = new Set<Client>();
  private settling = false;
  private readonly maxBacklogBytes: number;
  private readonly stallMs: number;
  private readonly heartbeatMs: number;
  private readonly sweepMs: number;
  private readonly lagSlackMs: number;
  private readonly now: () => number;
  private readonly useTimer: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSweepAt = 0;
  private backlogHighWaterBytes = 0;
  private overflowDisconnects = 0;
  private stallDisconnects = 0;
  private serializationFailures = 0;
  private researchFramesSkipped = 0;

  constructor(options: SseOptions = {}) {
    this.maxBacklogBytes = positive(options.maxBacklogBytes) ?? SSE_MAX_BACKLOG_BYTES;
    // Only an explicit zero turns the deadline off: a value that is not a number or is negative is a typo in a
    // setting, and the safeguard stays on as it does for the backlog cap.
    this.stallMs = options.stallMs === 0 ? 0 : positive(options.stallMs) ?? SSE_STALL_MS;
    this.heartbeatMs = positive(options.heartbeatMs) ?? HEARTBEAT_MS;
    this.sweepMs = positive(options.sweepMs) ?? (this.stallMs > 0 ? Math.min(SWEEP_MS, Math.max(250, this.stallMs / 4)) : SWEEP_MS);
    this.lagSlackMs = options.lagSlackMs ?? LAG_SLACK_MS;
    this.now = options.now ?? (() => performance.now());
    this.useTimer = options.timer !== false;
  }

  get size(): number {
    return this.clients.size;
  }

  /** Registers a response and sends it its first frame. */
  add(res: SseResponse, hello: string): void {
    const client: Client = { res, stalledSince: null, lastPingAt: this.now(), handed: 0, flushed: 0 };
    this.clients.add(client);
    if (this.clients.size === 1) {
      this.lastSweepAt = this.now();
    }
    res.on("drain", () => {
      client.stalledSince = null;
    });
    // A reset or a broken pipe is the end of this client, not of the process.
    res.on("error", () => this.drop(client));
    res.on("close", () => this.remove(client));
    // Before the first write, not after: a response that is already gone, or that throws, is dropped by that write,
    // and the last client to leave stops the timer. Started afterwards, the timer would outlive a client that never was.
    this.start();
    this.write(client, hello, Buffer.byteLength(hello));
  }

  /** One frame, already serialised, to every client. */
  publish(frame: string): void {
    if (this.clients.size === 0) {
      return;
    }
    const bytes = Buffer.byteLength(frame);
    for (const client of this.clients) {
      this.write(client, frame, bytes);
    }
  }

  countSerializationFailure(): void {
    this.serializationFailures += 1;
  }

  countSkipped(): void {
    this.researchFramesSkipped += 1;
  }

  stats(): SseStats {
    return {
      clients: this.clients.size,
      backlogHighWaterBytes: this.backlogHighWaterBytes,
      overflowDisconnects: this.overflowDisconnects,
      stallDisconnects: this.stallDisconnects,
      serializationFailures: this.serializationFailures,
      researchFramesSkipped: this.researchFramesSkipped,
      maxBacklogBytes: this.maxBacklogBytes,
      stallMs: this.stallMs,
    };
  }

  /**
   * Heartbeats and the stall deadline, run on a timer. A sweep that comes much later than it was due was not a
   * client's doing, so every stall clock starts over instead of counting the gap, and a laptop waking up does not
   * cut every stream at once.
   */
  sweep(): void {
    const now = this.now();
    const gap = now - this.lastSweepAt;
    this.lastSweepAt = now;
    const lagged = gap < 0 || gap > this.sweepMs + this.lagSlackMs;
    for (const client of this.clients) {
      const res = client.res;
      if (res.destroyed || res.writableEnded) {
        this.remove(client);
        continue;
      }
      if (client.stalledSince !== null) {
        // What has left the response so far: what was handed over, less what is still held. A client that is slow
        // but completing writes is not stalled, though its queue may never empty and `drain` never fire. This sees
        // a batch finish, not bytes moving inside one: see the note at the top of the file.
        const flushed = client.handed - res.writableLength;
        const progressed = flushed > client.flushed;
        client.flushed = flushed;
        if (progressed || lagged) {
          client.stalledSince = now;
        } else if (this.stallMs > 0 && now - client.stalledSince >= this.stallMs) {
          this.stallDisconnects += 1;
          this.drop(client);
          continue;
        }
      }
      // A named event rather than a comment: EventSource never surfaces comments to a listener, so a client
      // holding a stream whose upstream died behind a proxy cannot tell it from a quiet one. This is what the
      // client's watchdog listens for. Nothing is queued behind a reader that has not taken what it was sent.
      if ((lagged || now - client.lastPingAt >= this.heartbeatMs) && !res.writableNeedDrain) {
        client.lastPingAt = now;
        const ping = `event: ping\ndata: ${Date.now()}\n\n`;
        this.write(client, ping, Buffer.byteLength(ping));
      }
    }
  }

  /** Stops sweeping and forgets every client; the connections themselves are closed by the server. */
  close(): void {
    this.clients.clear();
    this.suspects.clear();
    this.stop();
  }

  private write(client: Client, frame: string, bytes: number): void {
    const res = client.res;
    if (res.destroyed || res.writableEnded) {
      this.remove(client);
      return;
    }
    let accepted: boolean;
    try {
      accepted = res.write(frame);
    } catch {
      this.drop(client);
      return;
    }
    client.handed += bytes;
    const queued = res.writableLength;
    if (queued > this.backlogHighWaterBytes) {
      this.backlogHighWaterBytes = queued;
    }
    if (!accepted && client.stalledSince === null) {
      client.stalledSince = this.now();
      client.flushed = client.handed - queued;
    }
    // What was waiting before this frame, so a single frame bigger than the cap is delivered to a client that was
    // keeping up. A client that is over it now is only suspected: see `settle`.
    if (queued - bytes > this.maxBacklogBytes) {
      this.suspect(client);
    }
  }

  /**
   * Node holds everything written in one tick until the tick is over and sends it then, so a burst bigger than the
   * cap looks like a backlog to a client that is reading as fast as it can. The judgement waits for the end of the
   * turn of the loop: a client that is still over the cap by then is cut. Nothing stays queued past that turn, so
   * memory is still bounded by the cap plus what a single tick writes.
   */
  private suspect(client: Client): void {
    this.suspects.add(client);
    if (!this.settling) {
      this.settling = true;
      setImmediate(() => this.settle());
    }
  }

  private settle(): void {
    this.settling = false;
    const suspects = [...this.suspects];
    this.suspects.clear();
    for (const client of suspects) {
      if (!this.clients.has(client)) {
        continue;
      }
      if (client.res.destroyed || client.res.writableEnded) {
        this.remove(client);
      } else if (client.res.writableLength > this.maxBacklogBytes) {
        this.overflowDisconnects += 1;
        this.drop(client);
      }
    }
  }

  /** Destroyed, never ended: an orderly end would wait on the backlog this client is not taking. */
  private drop(client: Client): void {
    this.remove(client);
    try {
      client.res.destroy();
    } catch {
      /* already gone */
    }
  }

  private remove(client: Client): void {
    if (this.clients.delete(client) && this.clients.size === 0) {
      this.stop();
    }
  }

  private start(): void {
    if (!this.useTimer || this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
