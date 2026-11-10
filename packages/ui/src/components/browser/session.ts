import { BROWSER_PROTOCOL_VERSION, decodeFrame, parseServerMessage, type ClientMessage, type Frame, type PaneDialog, type PaneDownload, type PaneTab, type SelectProbe } from "./protocol.js";

/**
 * The Browser pane's connection: a WebSocket to the server's browser, the tabs and notices it reports, and the pictures
 * it sends (each acknowledged once the pane has drawn it, so the server sends no more than the pane can show).
 */

export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SessionStatus = "idle" | "connecting" | "open" | "busy" | "taken" | "closed";

export interface SessionView {
  status: SessionStatus;
  tabs: PaneTab[];
  active: string | null;
  /** The last plain-words message from the server (an error or a refusal); cleared by the next good thing. */
  message: string | null;
  /** A download or file chooser the browser refused. */
  notice: string | null;
  dialog: PaneDialog | null;
  /** Finished downloads of the person's tabs waiting for a folder; the first is the one asked. */
  downloads: PaneDownload[];
  select: { tabId: string; probe: SelectProbe } | null;
}

export const EMPTY_VIEW: SessionView = { status: "idle", tabs: [], active: null, message: null, notice: null, dialog: null, downloads: [], select: null };

export interface SessionStats {
  frames: number;
  bytes: number;
  /** `performance.now()` of the latest frames drawn, newest last (the last 600). */
  drawnAt: number[];
}

export interface SessionOptions {
  /** The socket's address, or null where the page has no browser. */
  url: () => string | null;
  open: (url: string) => SocketLike;
  onChange: (view: SessionView) => void;
  /** A picture to draw; `done` says it was drawn (or could not be) so the server may send the next. */
  onFrame: (frame: Frame, done: () => void) => void;
  onSelection: (text: string) => void;
  now?: () => number;
}

const OPEN = 1;

export class BrowserSession {
  private socket: SocketLike | null = null;
  private view: SessionView = EMPTY_VIEW;
  readonly stats: SessionStats = { frames: 0, bytes: 0, drawnAt: [] };

  constructor(private readonly options: SessionOptions) {}

  get current(): SessionView {
    return this.view;
  }

  private set(patch: Partial<SessionView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onChange(this.view);
  }

  connect(takeover = false): void {
    this.disconnect();
    const url = this.options.url();
    if (!url) {
      this.set({ status: "closed", message: "This Ancilla has no browser." });
      return;
    }
    this.set({ status: "connecting", message: null });
    let socket: SocketLike;
    try {
      socket = this.options.open(url);
    } catch {
      this.set({ status: "closed", message: "The browser could not be reached." });
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.send({ type: "hello", v: BROWSER_PROTOCOL_VERSION, takeover });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") this.onText(event.data);
      else if (event.data instanceof ArrayBuffer) this.onBinary(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === 4009) this.set({ status: "busy", message: "The browser is open in another window." });
      else if (event.code === 4010) this.set({ status: "taken", message: "The browser moved to another window." });
      else this.set({ status: "closed", message: this.view.message ?? "The connection to the browser ended." });
    };
    socket.onerror = () => undefined;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close(1000, "closed");
      } catch {
        /* already closed */
      }
    }
    if (this.view.status !== "idle") this.view = { ...EMPTY_VIEW, status: "closed" };
  }

  send(message: ClientMessage): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private onBinary(buffer: ArrayBuffer): void {
    const frame = decodeFrame(buffer);
    if (!frame) return;
    const ack = (): void => this.send({ type: "ack", seq: frame.seq });
    if (frame.tabId !== this.view.active) {
      ack();
      return;
    }
    this.stats.frames += 1;
    this.stats.bytes += buffer.byteLength;
    this.options.onFrame(frame, () => {
      const stamp = (this.options.now ?? (() => Date.now()))();
      this.stats.drawnAt.push(stamp);
      if (this.stats.drawnAt.length > 600) this.stats.drawnAt.shift();
      ack();
    });
  }

  private onText(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "ready":
        this.set({ status: "open", tabs: message.tabs, active: message.active, message: null, downloads: [] });
        return;
      case "tabs":
        this.set({ tabs: message.tabs, active: message.active });
        return;
      case "dialog":
        this.set({ dialog: message.dialog });
        return;
      case "download":
        this.set({ downloads: [...this.view.downloads.filter((d) => d.id !== message.download.id), message.download] });
        return;
      case "download-closed":
        this.set({ downloads: this.view.downloads.filter((d) => d.id !== message.id) });
        return;
      case "dialog-closed":
        if (this.view.dialog?.tabId === message.tabId) this.set({ dialog: null });
        return;
      case "notice":
        this.set({ notice: message.text });
        return;
      case "select":
        this.set({ select: { tabId: message.tabId, probe: message.probe } });
        return;
      case "selection":
        this.options.onSelection(message.text);
        return;
      case "error":
        this.set({ message: message.message });
        return;
      case "busy":
        this.set({ status: "busy", message: message.message });
        return;
    }
  }

  clearNotice(): void {
    if (this.view.notice !== null) this.set({ notice: null });
  }

  clearMessage(): void {
    if (this.view.message !== null) this.set({ message: null });
  }

  closeSelect(): void {
    if (this.view.select) this.set({ select: null });
  }
}
