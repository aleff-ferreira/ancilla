import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { BROWSER_PROTOCOL_VERSION, encodeFrame, parseClientMessage, serialize, type ClientMessage, type PaneTab, type ServerMessage } from "./protocol.js";
import { BrowserError, type BrowserEvent, type BrowserService, type ScreencastFrame, type TabInfo } from "./service.js";

/**
 * The Browser pane's WebSocket: one connection drives the person's own tabs (the `you` context, never the assistant's).
 * It is plumbing between the socket and `BrowserService`: pictures out (one in flight until the pane acknowledges it,
 * newest wins), input in, in order. Who may connect is decided before this (the server checks host, origin and token
 * on the upgrade request), and only one pane controls the browser at a time.
 */

export const BROWSER_SOCKET_PATH = "/api/browser/ws";

const MAX_PAYLOAD = 400_000;
const HELLO_WITHIN_MS = 8_000;
const PING_EVERY_MS = 20_000;
/** The browser stops after ten idle minutes; a pane that is open is not idle. */
const KEEPALIVE_MS = 60_000;
const FPS = 40;
const JPEG_QUALITY = 60;
/** A picture a tab's stream owes the pane: of this tab, at this size (null: any), and whether it has come. */
interface OwedPicture {
  id: string;
  want: { width: number; height: number } | null;
  met: boolean;
}

/** A client that has this much not yet sent to it is given time to catch up before the next picture. */
const BACKLOG_BYTES = 1_000_000;
const FRAME_ACK_TIMEOUT_MS = 1_500;
/**
 * A tab that has just been shown or resized may go this long without a picture before its stream is started again; if that
 * brings none, the next wait on this list is followed by a screenshot, then the stream again, and so on down the list.
 */
const PICTURE_AFTER_MS = [300, 700, 1_000, 1_000, 2_000, 2_000];
/** A screenshot that has not answered in this time is given up on (a tab still being set up may never answer) and asked for again. */
const SCREENSHOT_TIMEOUT_MS = 2_500;
const MAX_PENDING_MOVES = 4;

/** The pixel size a JPEG says it has (from its first start-of-frame marker), or null when the bytes are not a JPEG this can read. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 <= jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1] as number;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // SOF0..SOF15 carry the size; 0xC4, 0xC8 and 0xCC share the range but are tables.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: jpeg.readUInt16BE(at + 7), height: jpeg.readUInt16BE(at + 5) };
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  return null;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function paneTab(tab: TabInfo): PaneTab {
  return { id: tab.id, url: tab.url, title: tab.title, loading: tab.loading };
}

export class BrowserSocketServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  private readonly open = new Set<WebSocket>();
  private controller: WebSocket | null = null;

  constructor(
    private readonly service: () => BrowserService,
    private readonly log: (line: string) => void,
  ) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  get connections(): number {
    return this.open.size;
  }

  close(): void {
    for (const ws of this.open) {
      try {
        ws.close(1001, "Ancilla is shutting down");
      } catch {
        /* already closed */
      }
    }
    this.wss.close();
  }

  private onConnection(ws: WebSocket): void {
    this.open.add(ws);
    let attached = false;
    let gone = false;
    let alive = true;
    const helloTimer = setTimeout(() => {
      if (!attached) ws.close(4000, "no hello");
    }, HELLO_WITHIN_MS);
    const pingTimer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* the close handler follows */
      }
    }, PING_EVERY_MS);
    pingTimer.unref?.();
    helloTimer.unref?.();
    ws.on("pong", () => {
      alive = true;
    });

    let session: PaneSession | null = null;
    ws.on("message", (data: RawData, isBinary: boolean) => {
      alive = true;
      if (isBinary) return;
      const message = parseClientMessage(toBuffer(data).toString("utf8"));
      if (!message) return;
      if (session) {
        session.handle(message);
        return;
      }
      if (attached) return;
      if (message.type !== "hello") {
        ws.close(4002, "the first message must be a hello");
        return;
      }
      clearTimeout(helloTimer);
      if (message.v !== BROWSER_PROTOCOL_VERSION) {
        ws.send(serialize({ type: "error", message: `This server speaks browser protocol ${BROWSER_PROTOCOL_VERSION}; the page speaks ${message.v}. Reload the page.` }));
        ws.close(4003, "protocol version");
        return;
      }
      if (this.controller && this.controller.readyState === WebSocket.OPEN) {
        if (!message.takeover) {
          ws.send(serialize({ type: "busy", message: "The browser is open in another window." }));
          ws.close(4009, "the browser is open in another window");
          return;
        }
        this.controller.close(4010, "the browser was taken over by another window");
      }
      attached = true;
      this.controller = ws;
      let service: BrowserService;
      try {
        service = this.service();
      } catch (error) {
        ws.send(serialize({ type: "error", message: "The browser is not available on this server." }));
        ws.close(1011, "unavailable");
        return;
      }
      const made = new PaneSession(ws, service, this.log);
      session = made;
      made.start().catch((error: unknown) => {
        const unavailable = error instanceof BrowserError && error.code === "unavailable";
        if (!unavailable) this.log(`browser: the pane could not start: ${error instanceof Error ? error.message : String(error)}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(serialize({ type: "error", message: error instanceof BrowserError ? error.message : "The browser could not start." }));
          ws.close(1011, "the browser could not start");
        }
      });
    });

    const finish = (): void => {
      if (gone) return;
      gone = true;
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      this.open.delete(ws);
      if (this.controller === ws) this.controller = null;
      session?.stop();
    };
    ws.on("close", finish);
    ws.on("error", (error) => {
      this.log(`browser: a pane's socket failed: ${error.message}`);
      finish();
    });
  }
}

/** What one connected pane has: its tabs, its viewport and the picture stream of its active tab. */
class PaneSession {
  private readonly tabs = new Map<string, PaneTab>();
  private active: string | null = null;
  private viewport: { width: number; height: number } | null = null;
  private stopCast: (() => void) | null = null;
  private castFor: string | null = null;
  private seq = 0;
  private ackWaiter: { seq: number; done: () => void } | null = null;
  private unsubscribe: (() => void) | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingMoves = 0;
  private latest: { id: string; frame: ScreencastFrame } | null = null;
  private pumping = false;
  private swallowRelease = false;
  /** True while `init` reads and shows the person's tabs. */
  private starting = false;
  /** The picture this pane is waiting for: of the tab just shown or resized, and at the size wanted (null: any). */
  private owed: OwedPicture | null = null;
  /** The size of the newest picture the tab on show has sent (or had taken for it). */
  private lastSize: { id: string; width: number; height: number } | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly service: BrowserService,
    private readonly log: (line: string) => void,
  ) {}

  private send(message: ServerMessage): void {
    if (!this.stopped && this.ws.readyState === WebSocket.OPEN) this.ws.send(serialize(message));
  }

  private fail(error: unknown): void {
    if (error instanceof BrowserError) this.send({ type: "error", message: error.message });
    else {
      this.log(`browser: a pane request failed: ${error instanceof Error ? error.message : String(error)}`);
      this.send({ type: "error", message: "That did not work." });
    }
  }

  async start(): Promise<void> {
    this.unsubscribe = this.service.on((event) => this.onEvent(event));
    this.keepalive = setInterval(() => void this.service.listTabs().catch(() => undefined), KEEPALIVE_MS);
    this.keepalive.unref?.();
    await this.init();
    if (this.stopped) return;
    this.send({ type: "ready", v: BROWSER_PROTOCOL_VERSION, tabs: [...this.tabs.values()], active: this.active });
    for (const download of this.service.pendingDownloads()) if (download.tabId === null || this.own(download.tabId)) this.send({ type: "download", download });
  }

  /** Reads the person's tabs, opening a blank one when there are none. */
  private async init(): Promise<void> {
    // Tabs the browser reports while this runs are not shown on their own (see "tab" in `onEvent`): the tab to show is brought
    // forward here and only then cast, in that order (see `activate`).
    this.starting = true;
    try {
      await this.service.open();
      let mine = (await this.service.listTabs()).filter((t) => t.context === "you");
      if (mine.length === 0) mine = [await this.service.openTab("you")];
      this.tabs.clear();
      for (const tab of mine) this.tabs.set(tab.id, paneTab(tab));
      const preferred = mine.find((t) => t.active) ?? mine[0];
      this.active = preferred ? preferred.id : null;
      if (this.active) {
        await this.service.activateTab(this.active).catch(() => undefined);
        await this.startCast(this.active);
      }
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    if (this.keepalive) clearInterval(this.keepalive);
    this.stopCast?.();
    this.stopCast = null;
    this.ackWaiter?.done();
  }

  /** Only the person's own tabs are ever touched; an id of any other context is refused. */
  private own(id: string): boolean {
    return this.tabs.has(id);
  }

  private tabList(): void {
    this.send({ type: "tabs", tabs: [...this.tabs.values()], active: this.active });
  }

  private onEvent(event: BrowserEvent): void {
    if (this.stopped) return;
    switch (event.type) {
      case "tab": {
        if (event.tab.context !== "you") return;
        const before = this.tabs.get(event.tab.id);
        this.tabs.set(event.tab.id, paneTab(event.tab));
        if (!before) {
          this.applyViewport(event.tab.id);
          // A popup or a link that opens a tab brings it to the front.
          if (event.tab.openerId || (!this.active && !this.starting)) void this.activate(event.tab.id, Boolean(event.tab.openerId));
        } else if (before.loading && !event.tab.loading) {
          // On Linux the browser can drop a tab's emulated size when a page commits (measured: the page is then drawn at the
          // browser window's own size, 780x437, not the pane's), so the tab is sized again once its page has loaded.
          this.applyViewport(event.tab.id);
        }
        this.tabList();
        return;
      }
      case "tab-closed": {
        if (!this.tabs.delete(event.id)) return;
        if (this.active === event.id) {
          this.active = null;
          const next = [...this.tabs.keys()].pop();
          if (next) void this.activate(next);
          else void this.service.openTab("you").catch((error) => this.fail(error));
        }
        this.tabList();
        return;
      }
      case "active":
        if (this.own(event.id) && this.active !== event.id && !this.starting) void this.activate(event.id);
        return;
      case "dialog":
        if (this.own(event.dialog.tabId)) this.send({ type: "dialog", dialog: event.dialog });
        return;
      case "download":
        if (event.download.tabId === null || this.own(event.download.tabId)) this.send({ type: "download", download: event.download });
        return;
      case "download-closed":
        if (event.tabId === null || this.own(event.tabId)) this.send({ type: "download-closed", id: event.id });
        return;
      case "dialog-closed":
        if (this.own(event.tabId)) this.send({ type: "dialog-closed", tabId: event.tabId });
        return;
      case "notice":
        // A popup notice is about the assistant's tabs, which this pane never shows.
        if (event.kind !== "popup" && (event.tabId === undefined || this.own(event.tabId))) this.send({ type: "notice", kind: event.kind, text: event.text });
        return;
      case "stopped":
        // The browser went away (idle, or it crashed): start over on the next breath, which brings a blank tab.
        this.stopCast = null;
        this.castFor = null;
        this.tabs.clear();
        this.active = null;
        this.tabList();
        setTimeout(() => {
          if (!this.stopped) this.init().then(() => this.tabList(), (error) => this.fail(error));
        }, 300).unref?.();
        return;
    }
  }

  private applyViewport(id: string): void {
    const v = this.viewport;
    if (v) void this.service.setViewport(id, v.width, v.height).then((size) => this.resized(id, size), () => undefined);
  }

  /** A tab was sized: if it is the one on show, a picture at that size is owed to the pane. */
  private resized(id: string, size: { width: number; height: number }): void {
    if (!this.stopped && this.active === id) this.owePicture(id, size);
  }

  /**
   * Shows the tab. When the browser has to be told to bring it forward, that comes BEFORE its pictures are asked for: on Linux a
   * tab brought forward while its screencast runs can lose the screencast for good (measured: about one time in three, with
   * `Target.activateTarget` or `Page.bringToFront`), and nothing says so; the pane just stops getting pictures.
   */
  private async activate(id: string, bring = false): Promise<void> {
    if (!this.own(id)) return;
    const showing = this.active === id && this.castFor === id;
    this.active = id;
    this.applyViewport(id);
    this.tabList();
    if (bring && !showing) await this.service.activateTab(id).catch(() => undefined);
    await this.startCast(id);
  }

  /** The picture stream: the newest frame once the last one was acknowledged and the socket has room. */
  private async startCast(id: string, keepPlan = false): Promise<void> {
    if (this.castFor === id && this.stopCast) return;
    this.stopCast?.();
    this.stopCast = null;
    this.castFor = id;
    // The picture owed for this start is noted before the browser is asked to start: the first picture can arrive before its answer.
    const owed = keepPlan ? null : this.expectPicture(id, null);
    const stop = await this.service.screencast(
      id,
      (frame) => {
        this.lastSize = { id, width: frame.width, height: frame.height };
        const owed = this.owed;
        if (owed && owed.id === id && (!owed.want || (owed.want.width === frame.width && owed.want.height === frame.height))) owed.met = true;
        // The newest picture replaces one that is still waiting; the one being sent is never overtaken.
        this.latest = { id, frame };
        void this.pump();
      },
      { maxFps: FPS, quality: JPEG_QUALITY },
    );
    if (this.stopped || this.castFor !== id) {
      stop();
      return;
    }
    this.stopCast = stop;
    // Starting the stream sends a first picture on its own; a page that is quiet from then on is what the plan is for.
    if (owed) this.armPicturePlan(owed);
  }

  /** Starts the tab's picture stream again: a first picture comes at once, and a stream that had gone silent is alive. */
  private async restartCast(id: string): Promise<void> {
    if (this.castFor !== id) return;
    this.stopCast?.();
    this.stopCast = null;
    this.castFor = null;
    await this.startCast(id, true);
  }

  /**
   * A page that is not changing sends the screencast nothing, so a tab that was just shown, or resized, can stay blank (or at its
   * old size) until something moves, and a stream that has silently died looks just the same. If no picture of the size wanted
   * has come soon after, the stream is started again (which sends one at once and revives it); if that brings none either, a
   * screenshot stands in; and so on, one after the other, for a few seconds: a tab still being set up may refuse a screenshot,
   * or never answer it, or show a size that is not yet the one asked for. A page that paints needs none of this.
   */
  private owePicture(id: string, want: { width: number; height: number } | null): void {
    this.armPicturePlan(this.expectPicture(id, want));
  }

  /** Notes that a picture is owed (of the size wanted, if any); a picture of the tab that fits meets it, and one that already came did. */
  private expectPicture(id: string, want: { width: number; height: number } | null): OwedPicture {
    const last = this.lastSize;
    const owed: OwedPicture = { id, want, met: want !== null && last !== null && last.id === id && last.width === want.width && last.height === want.height };
    this.owed = owed;
    return owed;
  }

  private armPicturePlan(owed: OwedPicture): void {
    const { id, want } = owed;
    const open = (): boolean => this.owed === owed && !owed.met && !this.stopped && this.active === id;
    const attempt = (n: number): void => {
      const wait = PICTURE_AFTER_MS[n];
      if (wait === undefined) return;
      setTimeout(() => {
        if (!open()) return;
        // Even turns start the stream again, odd ones take a screenshot.
        this.log(`browser: no picture of tab ${id.slice(0, 6)}${want ? ` at ${want.width}x${want.height}` : ""} after ${PICTURE_AFTER_MS.slice(0, n + 1).reduce((a, b) => a + b, 0)} ms; ${n % 2 === 0 ? "its stream is started again" : "a screenshot stands in"}`);
        if (n % 2 === 0) {
          void this.restartCast(id).then(
            () => attempt(n + 1),
            () => attempt(n + 1),
          );
          return;
        }
        void this.service.screenshot(id, "jpeg", SCREENSHOT_TIMEOUT_MS).then(
          (jpeg) => {
            if (!open()) return;
            const size = jpegSize(jpeg) ?? this.viewport ?? { width: 1280, height: 800 };
            if (!want || (size.width === want.width && size.height === want.height)) owed.met = true;
            this.lastSize = { id, ...size };
            this.latest = { id, frame: { data: jpeg.toString("base64"), width: size.width, height: size.height, at: Date.now() } };
            void this.pump();
            if (!owed.met) attempt(n + 1);
          },
          () => attempt(n + 1),
        );
      }, wait).unref?.();
    };
    attempt(0);
  }

  /** Sends the newest waiting picture, then waits for the pane to acknowledge it (or for a pause) before the next. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.latest && !this.stopped) {
        while (!this.stopped && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount > BACKLOG_BYTES) await sleep(20);
        const next = this.latest;
        this.latest = null;
        if (!next || this.stopped || this.ws.readyState !== WebSocket.OPEN || this.active !== next.id) continue;
        const seq = ++this.seq;
        this.ws.send(encodeFrame(seq, next.frame.width, next.frame.height, next.id, Buffer.from(next.frame.data, "base64")), { binary: true });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, FRAME_ACK_TIMEOUT_MS);
          function done(): void {
            clearTimeout(timer);
            resolve();
          }
          this.ackWaiter = { seq, done };
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Messages are carried out one after the other, so a press is never overtaken by its release. */
  handle(message: ClientMessage): void {
    switch (message.type) {
      case "ack":
        if (this.ackWaiter && message.seq >= this.ackWaiter.seq) {
          const waiter = this.ackWaiter;
          this.ackWaiter = null;
          waiter.done();
        }
        return;
      case "hello":
        return;
      // Slow ones (a page may take seconds to load) must not hold the input behind them.
      case "open":
        void this.service.openTab("you", message.url ?? undefined).catch((error) => this.fail(error));
        return;
      case "navigate":
        if (this.own(message.id)) void this.service.navigate(message.id, message.url).catch((error) => this.fail(error));
        return;
      case "back":
      case "forward":
      case "reload":
        if (this.own(message.id)) void this.service[message.type](message.id).catch((error) => this.fail(error));
        return;
      case "activate":
        if (this.own(message.id)) void this.activate(message.id, true);
        return;
      case "close":
        if (this.own(message.id)) void this.service.closeTab(message.id).catch((error) => this.fail(error));
        return;
      // A click that opens a dialog does not finish until the dialog is answered, so the answer cannot wait behind it.
      case "dialog":
        if (this.own(message.id)) void this.service.answerDialog(message.id, message.accept, message.promptText).catch((error) => this.fail(error));
        return;
      case "save":
        try {
          this.service.answerDownload(message.id, message.accept, message.folder, message.remember);
        } catch (error) {
          this.fail(error);
        }
        return;
      case "mouse":
        if (message.input.type === "mouseMoved") {
          if (this.pendingMoves >= MAX_PENDING_MOVES) return;
          this.pendingMoves += 1;
        }
        break;
      default:
        break;
    }
    this.queue = this.queue.then(() => this.input(message)).catch((error) => this.fail(error));
  }

  private async input(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "viewport": {
        if (!this.own(message.id)) return;
        this.viewport = { width: message.width, height: message.height };
        this.resized(message.id, await this.service.setViewport(message.id, message.width, message.height));
        return;
      }
      case "mouse": {
        if (message.input.type === "mouseMoved") this.pendingMoves = Math.max(0, this.pendingMoves - 1);
        if (!this.own(message.id)) return;
        const input = message.input;
        // The screencast never shows a native dropdown, so a click on a select is answered by the pane's own.
        if (input.type === "mousePressed" && (input.button ?? "left") === "left") {
          const probe = await this.service.selectAt(message.id, input.x, input.y);
          if (probe && !probe.multiple) {
            this.swallowRelease = true;
            this.send({ type: "select", tabId: message.id, probe });
            return;
          }
        }
        if (input.type === "mouseReleased" && this.swallowRelease) {
          this.swallowRelease = false;
          return;
        }
        await this.service.dispatchMouse(message.id, input);
        return;
      }
      case "key":
        if (this.own(message.id)) await this.service.dispatchKey(message.id, message.input);
        return;
      case "text":
        if (this.own(message.id)) await this.service.insertText(message.id, message.text);
        return;
      case "selection":
        if (this.own(message.id)) this.send({ type: "selection", text: await this.service.selectionText(message.id) });
        return;
      case "choose":
        if (this.own(message.id)) await this.service.chooseOption(message.id, message.index);
        return;
      default:
        return;
    }
  }
}
