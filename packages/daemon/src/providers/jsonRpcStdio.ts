import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_CONNECTION_GRACE_MS,
  DEFAULT_HOST_START_TIMEOUT_MS,
  HostStartTimeoutError,
  type HostTimers,
  type ServeExit,
  type ServeTarget,
} from "../mspHost.js";

export interface SpawnedStdioProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export type SpawnStdioFn = (target: ServeTarget) => SpawnedStdioProcess;

export function defaultSpawnStdio(target: ServeTarget): SpawnedStdioProcess {
  const env = target.env
    ? Object.fromEntries(
        Object.entries(target.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : process.env;
  return spawn(target.command, target.args, {
    cwd: target.cwd || process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(err: JsonRpcErrorObject) {
    super(err.message || `JSON-RPC error ${err.code}`);
    this.name = "JsonRpcError";
    this.code = err.code;
    this.data = err.data;
  }
}

export type JsonRpcRequestHandler = (
  method: string,
  params: unknown,
  id: string | number,
) => Promise<unknown> | unknown;

export type JsonRpcNotificationHandler = (method: string, params: unknown) => void;

const REAL_TIMERS: HostTimers = {
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const STDERR_TAIL_LINES = 16;

export interface StdioJsonRpcPeerOptions {
  spawnFn?: SpawnStdioFn;
  startTimeoutMs?: number;
  connectionGraceMs?: number;
  timers?: HostTimers;
  log?: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Bidirectional JSON-RPC 2.0 peer over newline-delimited JSON stdio.
 * Used by both ACP (`gemini --acp`, `copilot --acp`, `kimi acp`, etc.) and `codex app-server`.
 */
export class StdioJsonRpcPeer {
  private child: SpawnedStdioProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown | null }
  >();
  private requestHandler: JsonRpcRequestHandler | null = null;
  private readonly notificationHandlers: JsonRpcNotificationHandler[] = [];
  private readonly protocolErrorHandlers: ((error: unknown) => void)[] = [];
  private readonly exitHandlers: ((exit: ServeExit) => void)[] = [];
  private readonly stderrTail: string[] = [];
  private stdoutBuffer = "";
  private closing = false;
  private exitNotified = false;
  private notifiedExit: ServeExit | null = null;
  private closePromise: Promise<ServeExit> | null = null;
  private exitResolve: ((exit: ServeExit) => void) | null = null;
  private readonly exitedPromise: Promise<ServeExit>;
  private readonly spawnFn: SpawnStdioFn;
  readonly startTimeoutMs: number;
  private readonly connectionGraceMs: number;
  private readonly timers: HostTimers;
  private readonly log: (line: string) => void;
  private readonly onStderr: (chunk: string) => void;

  constructor(
    private readonly target: ServeTarget,
    options: StdioJsonRpcPeerOptions = {},
  ) {
    this.spawnFn = options.spawnFn ?? defaultSpawnStdio;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_HOST_START_TIMEOUT_MS;
    this.connectionGraceMs = options.connectionGraceMs ?? DEFAULT_CONNECTION_GRACE_MS;
    this.timers = options.timers ?? REAL_TIMERS;
    this.log = options.log ?? ((line) => void process.stderr.write(`[ancilla] ${new Date().toISOString()} ${line}\n`));
    this.onStderr = options.onStderr ?? (() => {});
    this.exitedPromise = new Promise<ServeExit>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  spawn(): void {
    if (this.child) {
      return;
    }
    const child = this.spawnFn(this.target);
    this.child = child;
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.consumeStdout(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.rememberStderr(text);
      this.onStderr(text);
    });
    child.on("error", (err) => {
      this.rememberStderr(err.message);
      this.failAllPending(err);
      this.finishExit({ code: 1, signal: null });
    });
    child.on("exit", (code, signal) => {
      if (this.stdoutBuffer.trim().length > 0) {
        this.processLine(this.stdoutBuffer);
        this.stdoutBuffer = "";
      }
      const reason = this.recentStderr;
      this.failAllPending(
        new Error(
          `Host process exited (${code ?? signal ?? "unknown"})${reason ? `: ${reason}` : ""}`,
        ),
      );
      this.finishExit({ code, signal: signal ? String(signal) : null });
    });
  }

  get recentStderr(): string {
    return this.stderrTail.join("\n").trim();
  }

  onRequest(handler: JsonRpcRequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: JsonRpcNotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  onProtocolError(handler: (error: unknown) => void): void {
    this.protocolErrorHandlers.push(handler);
  }

  onExit(handler: (exit: ServeExit) => void): void {
    this.exitHandlers.push(handler);
    const exit = this.notifiedExit;
    if (exit !== null) {
      queueMicrotask(() => {
        try {
          handler(exit);
        } catch (error) {
          this.log(`exit handler threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (!this.child || this.closing) {
      throw new Error(`Cannot send ${method}: JSON-RPC peer is not open.`);
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      payload["params"] = params;
    }
    return new Promise<T>((resolve, reject) => {
      let timer: unknown | null = null;
      if (timeoutMs > 0) {
        timer = this.timers.setTimeout(() => {
          this.pending.delete(id);
          if (method === "initialize") {
            reject(new HostStartTimeoutError(timeoutMs, this.recentStderr));
          } else {
            reject(new Error(`JSON-RPC request "${method}" timed out after ${timeoutMs} ms.`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });
      this.writeFrame(payload, (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.reject(err);
          }
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.closing) {
      return;
    }
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      payload["params"] = params;
    }
    this.writeFrame(payload);
  }

  async close(): Promise<ServeExit> {
    this.closing = true;
    this.failAllPending(new Error("Host connection closed."));
    if (!this.child) {
      const immediate: ServeExit = { code: 0, signal: null };
      this.exitResolve?.(immediate);
      return immediate;
    }
    if (!this.closePromise) {
      const child = this.child;
      this.closePromise = new Promise<ServeExit>((resolve) => {
        let killTimer: unknown | null = null;
        const done = (exit: ServeExit) => {
          if (killTimer !== null) {
            this.timers.clearTimeout(killTimer);
            killTimer = null;
          }
          resolve(exit);
        };
        void this.exitedPromise.then(done);
        try {
          child.stdin.end();
        } catch {
          /* ignore broken pipe */
        }
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        killTimer = this.timers.setTimeout(() => {
          killTimer = null;
          try {
            child.kill("SIGKILL");
          } catch {
            /* already exited */
          }
          done({ code: null, signal: "SIGKILL" });
        }, this.connectionGraceMs);
      });
    }
    return this.closePromise;
  }

  private writeFrame(frame: Record<string, unknown>, cb?: (err?: Error | null) => void): void {
    if (!this.child) {
      cb?.(new Error("Process not spawned"));
      return;
    }
    try {
      const serialized = `${JSON.stringify(frame)}\n`;
      this.child.stdin.write(serialized, "utf8", cb);
    } catch (error) {
      cb?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) {
        this.processLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private processLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      for (const handler of this.protocolErrorHandlers) {
        try {
          handler(error);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }
    const msg = parsed as Record<string, unknown>;
    const hasId = typeof msg["id"] === "string" || typeof msg["id"] === "number";
    const method = typeof msg["method"] === "string" ? msg["method"] : null;

    // 1. Server-to-Client Request (has both method and id)
    if (method !== null && hasId) {
      const id = msg["id"] as string | number;
      void this.handleIncomingRequest(method, msg["params"], id);
      return;
    }

    // 2. Response to Client-to-Server Request (has id, no method)
    if (hasId && method === null) {
      const id = msg["id"] as string | number;
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      if (entry.timer !== null) {
        this.timers.clearTimeout(entry.timer);
      }
      this.pending.delete(id);
      if (msg["error"] && typeof msg["error"] === "object") {
        const errRecord = msg["error"] as Record<string, unknown>;
        entry.reject(
          new JsonRpcError({
            code: typeof errRecord["code"] === "number" ? errRecord["code"] : -32000,
            message: typeof errRecord["message"] === "string" ? errRecord["message"] : "JSON-RPC error",
            data: errRecord["data"],
          }),
        );
      } else {
        entry.resolve(msg["result"]);
      }
      return;
    }

    // 3. Server-to-Client Notification (has method, no id)
    if (method !== null) {
      for (const handler of this.notificationHandlers) {
        try {
          handler(method, msg["params"]);
        } catch (error) {
          this.log(`notification handler (${method}) threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  private async handleIncomingRequest(method: string, params: unknown, id: string | number): Promise<void> {
    if (!this.requestHandler) {
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await this.requestHandler(method, params, id);
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        result: result ?? {},
      });
    } catch (error) {
      const code = error instanceof JsonRpcError ? error.code : -32000;
      const message = error instanceof Error ? error.message : String(error);
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      });
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer !== null) {
        this.timers.clearTimeout(entry.timer);
      }
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private finishExit(exit: ServeExit): void {
    this.exitResolve?.(exit);
    if (this.closing || this.exitNotified) {
      return;
    }
    this.exitNotified = true;
    this.notifiedExit = exit;
    for (const handler of [...this.exitHandlers]) {
      try {
        handler(exit);
      } catch (error) {
        this.log(`exit handler threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private rememberStderr(text: string): void {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    this.stderrTail.push(...lines);
    if (this.stderrTail.length > STDERR_TAIL_LINES) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES);
    }
  }
}
