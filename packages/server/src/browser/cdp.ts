import type { Readable, Writable } from "node:stream";

/**
 * The Chrome DevTools Protocol over `--remote-debugging-pipe`: every message is one JSON text ended by a NUL byte, the
 * parent writes to the child's fd 3 and reads its fd 4. No TCP port is opened, so nothing else on the machine can attach
 * to the browser. This class only frames, correlates replies and fans out events; it knows no domain.
 */

export class CdpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export type CdpEventListener = (method: string, params: Record<string, any>, sessionId: string | undefined) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<CdpEventListener>();
  private readonly closeListeners = new Set<() => void>();
  private chunks: Buffer[] = [];
  private closed = false;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.on("data", (chunk: Buffer | string) => this.feed(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    input.on("end", () => this.shutdown());
    input.on("close", () => this.shutdown());
    input.on("error", () => this.shutdown());
    out.on("error", () => this.shutdown());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.add(listener);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("the browser connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      const message = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
      try {
        this.out.write(`${message}\0`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new CdpError(String(error)));
      }
    });
  }

  /** Stops listening and fails everything in flight. The caller ends the process. */
  close(): void {
    this.shutdown();
  }

  private feed(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const nul = chunk.indexOf(0, start);
      if (nul < 0) {
        if (start < chunk.length) this.chunks.push(chunk.subarray(start));
        return;
      }
      this.chunks.push(chunk.subarray(start, nul));
      const text = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      start = nul + 1;
      if (text) this.dispatch(text);
    }
  }

  private dispatch(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new CdpError(`${waiting.method}: ${message.error.message ?? "failed"}`, message.error.code));
      else waiting.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of [...this.listeners]) {
        try {
          listener(message.method, message.params ?? {}, message.sessionId);
        } catch {
          // a listener's fault is not the connection's
        }
      }
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new CdpError("the browser connection closed"));
      this.pending.delete(id);
    }
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
    this.listeners.clear();
  }
}
