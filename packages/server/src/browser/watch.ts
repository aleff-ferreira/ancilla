import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { encodeFrame, parseClientMessage } from "./protocol.js";
import type { BrowserEvent, BrowserService, ScreencastFrame } from "./service.js";
import type { SiteQuestion } from "./sites.js";

/**
 * A second socket for the Browser panel, to watch the assistant work: the pictures of its one tab and what its web task is doing.
 * It is read only by construction: nothing a watcher sends is carried out, except the acknowledgement of a picture. Who may
 * connect is decided before this, on the upgrade request, as for the pane. Any number of windows may watch at once; the tab is
 * cast once and every watcher gets the newest picture it has room for.
 */

export const BROWSER_WATCH_PATH = "/api/browser/watch";

/** What a watcher is told about the web task being worked on (no ids it could act on but the task's own, which the Tasks list shows too). */
export interface WatchJob {
  taskId: string;
  goal: string;
  steps: string[];
  startedAt: number;
  question: { origin: string; kind: "public" | "local" } | null;
}

export interface WatchState {
  type: "state";
  /** The assistant's tab whose pictures follow, or null when it has none. */
  tab: string | null;
  job: WatchJob | null;
}

/** What the watcher needs of the browsing runner. */
export interface WatchSource {
  current(): { taskId: string; goal: string; steps: string[]; startedAt: number; question: SiteQuestion | null } | null;
  on(listener: () => void): () => void;
}

const MAX_PAYLOAD = 4_096;
const PING_EVERY_MS = 20_000;
/** The assistant's tab changes little and is shown small: a few pictures a second, at a lower quality, are enough. */
const FPS = 8;
const JPEG_QUALITY = 50;
const BACKLOG_BYTES = 600_000;
const FRAME_ACK_TIMEOUT_MS = 1_500;
/** How long a tab that has just begun to be cast may go without a picture before one is taken for it. */
const FIRST_FRAME_MS = 300;
/** The size an assistant tab has until something changes it (see `BrowserService`). */
const TAB_SIZE = { width: 1280, height: 800 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** One watching window: the newest picture waits for it, one in flight until it has acknowledged it. */
class WatchClient {
  private latest: { tab: string; frame: ScreencastFrame } | null = null;
  private pumping = false;
  private seq = 0;
  private waiter: { seq: number; done: () => void } | null = null;
  private dead = false;
  alive = true;

  constructor(readonly ws: WebSocket) {}

  text(raw: string): void {
    if (!this.dead && this.ws.readyState === WebSocket.OPEN) this.ws.send(raw);
  }

  offer(tab: string, frame: ScreencastFrame): void {
    this.latest = { tab, frame };
    void this.pump();
  }

  ack(seq: number): void {
    if (this.waiter && seq >= this.waiter.seq) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.done();
    }
  }

  stop(): void {
    this.dead = true;
    this.waiter?.done();
    this.waiter = null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.latest && !this.dead) {
        while (!this.dead && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount > BACKLOG_BYTES) await sleep(20);
        const next = this.latest;
        this.latest = null;
        if (!next || this.dead || this.ws.readyState !== WebSocket.OPEN) continue;
        const seq = ++this.seq;
        this.ws.send(encodeFrame(seq, next.frame.width, next.frame.height, next.tab, Buffer.from(next.frame.data, "base64")), { binary: true });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, FRAME_ACK_TIMEOUT_MS);
          function done(): void {
            clearTimeout(timer);
            resolve();
          }
          this.waiter = { seq, done };
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}

export class BrowserWatchServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  private readonly clients = new Set<WatchClient>();
  private unsubscribe: Array<() => void> = [];
  private castTab: string | null = null;
  private stopCast: (() => void) | null = null;
  /** The newest picture, for a window that begins to watch while the page is not changing. */
  private last: { tab: string; frame: ScreencastFrame } | null = null;
  private syncing: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: () => BrowserService,
    private readonly source: () => WatchSource,
    private readonly log: (line: string) => void,
  ) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  get connections(): number {
    return this.clients.size;
  }

  close(): void {
    for (const client of this.clients) {
      client.stop();
      try {
        client.ws.close(1001, "Ancilla is shutting down");
      } catch {
        /* already closed */
      }
    }
    this.clients.clear();
    this.detach();
    this.wss.close();
  }

  private onConnection(ws: WebSocket): void {
    const client = new WatchClient(ws);
    this.clients.add(client);
    if (this.clients.size === 1) this.attach();
    // A window's first look: what the task is doing, and the last picture if there is one.
    client.text(this.stateText());
    if (this.last) client.offer(this.last.tab, this.last.frame);
    const ping = setInterval(() => {
      if (!client.alive) {
        ws.terminate();
        return;
      }
      client.alive = false;
      try {
        ws.ping();
      } catch {
        /* the close handler follows */
      }
    }, PING_EVERY_MS);
    ping.unref?.();
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      client.alive = true;
      if (isBinary) return;
      // Read only: the acknowledgement of a picture is the one thing a watcher may say; anything else is not carried out.
      const message = parseClientMessage(toBuffer(data).toString("utf8"));
      if (message?.type === "ack") client.ack(message.seq);
    });
    const finish = (): void => {
      if (!this.clients.delete(client)) return;
      client.stop();
      clearInterval(ping);
      if (this.clients.size === 0) this.detach();
    };
    ws.on("close", finish);
    ws.on("error", (error) => {
      this.log(`browser: a watcher's socket failed: ${error.message}`);
      finish();
    });
  }

  private attach(): void {
    this.unsubscribe = [this.service().on((event) => this.onBrowserEvent(event)), this.source().on(() => this.broadcast())];
    this.resync();
  }

  private detach(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.stopCasting();
    this.last = null;
  }

  private onBrowserEvent(event: BrowserEvent): void {
    if (event.type === "tab" || event.type === "tab-closed" || event.type === "stopped") this.resync();
  }

  private resync(): void {
    this.syncing = this.syncing.then(() => this.sync()).catch((error: unknown) => this.log(`browser: the watchers' view could not be updated: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The assistant's tab, if it has one, is the one cast; when it goes or changes, the cast follows. */
  private async sync(): Promise<void> {
    if (this.clients.size === 0) return;
    const tab = (await this.service().listTabs()).find((t) => t.context === "assistant")?.id ?? null;
    if (tab !== this.castTab) {
      this.stopCasting();
      this.last = null;
      this.castTab = tab;
      if (tab) {
        try {
          await this.startCasting(tab);
        } catch {
          // the tab went away before it could be cast: the next change of tabs looks again
          this.castTab = null;
        }
      }
    }
    this.broadcast();
  }

  private async startCasting(tab: string): Promise<void> {
    let got = false;
    const stop = await this.service().screencast(
      tab,
      (frame) => {
        got = true;
        this.deliver(tab, frame);
      },
      { maxFps: FPS, quality: JPEG_QUALITY },
    );
    if (this.castTab !== tab || this.clients.size === 0) {
      stop();
      return;
    }
    this.stopCast = stop;
    void this.service().repaint(tab).catch(() => undefined);
    // A page that is not changing sends no picture; after a moment, if none has come, one is taken so the watcher is not left blank.
    setTimeout(() => {
      if (got || this.castTab !== tab) return;
      void this.service().screenshot(tab, "jpeg").then(
        (jpeg) => {
          if (got || this.castTab !== tab) return;
          this.deliver(tab, { data: jpeg.toString("base64"), width: TAB_SIZE.width, height: TAB_SIZE.height, at: Date.now() });
        },
        () => undefined,
      );
    }, FIRST_FRAME_MS).unref?.();
  }

  private stopCasting(): void {
    this.stopCast?.();
    this.stopCast = null;
    this.castTab = null;
  }

  private deliver(tab: string, frame: ScreencastFrame): void {
    this.last = { tab, frame };
    for (const client of this.clients) client.offer(tab, frame);
  }

  private stateText(): string {
    const job = this.source().current();
    const state: WatchState = {
      type: "state",
      tab: this.castTab,
      job: job
        ? {
            taskId: job.taskId,
            goal: job.goal.slice(0, 300),
            steps: job.steps.slice(-8),
            startedAt: job.startedAt,
            question: job.question ? { origin: job.question.origin, kind: job.question.kind } : null,
          }
        : null,
    };
    return JSON.stringify(state);
  }

  private broadcast(): void {
    const text = this.stateText();
    for (const client of this.clients) client.text(text);
  }
}
