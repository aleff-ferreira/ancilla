import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AsrEngine, AsrResult, AsrStream } from "../engines.js";
import type { AsrInit, FinalResult, FromWorker, ToWorker } from "./asr-protocol.js";

/**
 * The recogniser as the call sees it: streams that take audio and give words. The models run in a worker thread (see
 * asr-worker.ts); this side only moves audio across and keeps the latest words, so that asking what has been heard costs
 * nothing and never waits behind a decode.
 */

export interface SherpaAsrOptions extends AsrInit {
  log?: (line: string) => void;
  /** Where the worker script is, when it is not beside this file (tests). */
  workerPath?: string;
}

/**
 * Where the worker's file is. Compiled for development it is the neighbour of this file (`asr-worker.js`); in the
 * desktop app the server is one bundled file, and the worker is bundled beside it (`asr-worker.cjs`).
 */
function workerFile(): string {
  for (const name of ["asr-worker.js", "asr-worker.cjs"]) {
    const candidate = join(__dirname, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(__dirname, "asr-worker.js");
}

interface Pending {
  resolve: (value: FinalResult | { loadMs: number } | null) => void;
  reject: (error: Error) => void;
}

class WorkerStream implements AsrStream {
  latest = "";
  private done = false;

  constructor(
    private readonly owner: SherpaAsr,
    readonly id: number,
  ) {}

  accept(samples: Float32Array): void {
    if (this.done) return;
    this.owner.send({ op: "audio", id: this.id, samples: samples.slice() }, true);
  }

  partial(): AsrResult {
    return { text: this.latest };
  }

  flush(): void {
    if (!this.done) this.owner.send({ op: "flush", id: this.id });
  }

  async finish(): Promise<AsrResult> {
    this.done = true;
    const value = (await this.owner.request((req) => ({ op: "finish", req, id: this.id, sentAt: Date.now() }))) as FinalResult | null;
    this.owner.forget(this.id);
    if (!value) return { text: this.latest };
    this.owner.noteFinal(value);
    return { text: value.text };
  }

  dispose(): void {
    if (!this.done) {
      this.done = true;
      this.owner.send({ op: "dispose", id: this.id });
    }
    this.owner.forget(this.id);
  }
}

export class SherpaAsr implements AsrEngine {
  readonly id: string;
  private worker: Worker | null = null;
  private starting: Promise<void> | null = null;
  private nextReq = 1;
  private nextStream = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly streams = new Map<number, WorkerStream>();
  private lastFinal: FinalResult | null = null;
  loadMs = 0;

  constructor(private readonly options: SherpaAsrOptions) {
    this.id = options.finalDir ? "nemotron-3.5 + parakeet-v3" : "nemotron-3.5";
  }

  /** What the last turn's final reading was (for the screen and for measurements). */
  get lastResult(): FinalResult | null {
    return this.lastFinal;
  }

  async open(lang: string | null): Promise<AsrStream> {
    await this.ensure();
    const id = this.nextStream++;
    await this.request((req) => ({ op: "open", req, id, lang }));
    const stream = new WorkerStream(this, id);
    this.streams.set(id, stream);
    return stream;
  }

  async warm(): Promise<void> {
    await this.ensure();
    await this.request((req) => ({ op: "warm", req }));
  }

  /** Stops the worker and lets go of the models' memory. */
  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    this.fail(new Error("the recogniser was shut down"));
    if (worker) await worker.terminate();
  }

  // -------------------------------------------------------------------------------------------------------------------

  /** @internal */
  send(message: ToWorker, transfer = false): void {
    const worker = this.worker;
    if (!worker) return;
    if (transfer && message.op === "audio") worker.postMessage(message, [message.samples.buffer as ArrayBuffer]);
    else worker.postMessage(message);
  }

  /** @internal */
  request(build: (req: number) => ToWorker): Promise<FinalResult | { loadMs: number } | null> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("the recogniser is not running"));
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject });
      worker.postMessage(build(req));
    });
  }

  /** @internal */
  forget(id: number): void {
    this.streams.delete(id);
  }

  /** @internal */
  noteFinal(value: FinalResult): void {
    this.lastFinal = value;
  }

  private ensure(): Promise<void> {
    if (this.worker && this.starting) return this.starting;
    const path = this.options.workerPath ?? workerFile();
    const worker = new Worker(path);
    this.worker = worker;
    worker.on("message", (message: FromWorker) => this.onMessage(message));
    worker.on("error", (error) => {
      this.options.log?.(`the recogniser stopped: ${error.message}`);
      if (this.worker === worker) this.worker = null;
      this.starting = null;
      this.fail(error);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = null;
        this.starting = null;
        this.fail(new Error(`the recogniser exited (code ${code})`));
      }
    });
    const init: AsrInit = {
      runtimeDir: this.options.runtimeDir,
      streamingDir: this.options.streamingDir,
      finalDir: this.options.finalDir,
      threads: this.options.threads,
      finalThreads: this.options.finalThreads,
    };
    this.starting = this.request((req) => ({ op: "init", req, init })).then((value) => {
      this.loadMs = (value as { loadMs: number } | null)?.loadMs ?? 0;
    });
    return this.starting;
  }

  private onMessage(message: FromWorker): void {
    switch (message.op) {
      case "reply": {
        const pending = this.pending.get(message.req);
        if (!pending) return;
        this.pending.delete(message.req);
        if (message.ok) pending.resolve(message.value ?? null);
        else pending.reject(new Error(message.error));
        return;
      }
      case "partial": {
        const stream = this.streams.get(message.id);
        if (stream) stream.latest = message.text;
        return;
      }
      case "log":
        this.options.log?.(message.line);
        return;
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.streams.clear();
  }
}
