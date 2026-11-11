import { BROWSER_PROTOCOL_VERSION, decodeFrame, parseServerMessage, type ClientMessage, type Frame, type PaneDialog, type PaneDownload, type PaneTab, type PaneUpload, type SelectProbe } from "./protocol.js";

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
  /** Intercepted file choosers of the person's tabs waiting for file(s); the first is the one asked. */
  uploads: PaneUpload[];
  select: { tabId: string; probe: SelectProbe } | null;
}

export const EMPTY_VIEW: SessionView = { status: "idle", tabs: [], active: null, message: null, notice: null, dialog: null, downloads: [], uploads: [], select: null };

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
  /** Optional handshake (such as setting an auth cookie) to finish before opening the socket. */
  prepare?: () => Promise<void> | void;
  /** Initial milliseconds before retrying an unexpected disconnect; 0 or absent does not retry automatically. */
  retryMs?: number;
  /** Upper bound on exponential retry backoff (defaults to 8000 ms). */
  retryMaxMs?: number;
  /** Maximum automatic retry attempts per disconnect streak (defaults to 8). */
  maxRetries?: number;
  /** For tests. */
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
}

const OPEN = 1;
const NON_RETRYABLE_CLOSE_CODES = new Set([4002, 4003, 4009, 4010, 4011]);

export class BrowserSession {
  private socket: SocketLike | null = null;
  private view: SessionView = EMPTY_VIEW;
  private wanted = false;
  private epoch = 0;
  private timer: unknown = null;
  private attempts = 0;
  readonly stats: SessionStats = { frames: 0, bytes: 0, drawnAt: [] };

  constructor(private readonly options: SessionOptions) {}

  get current(): SessionView {
    return this.view;
  }

  private set(patch: Partial<SessionView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onChange(this.view);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      (this.options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onopen = null;
      try {
        socket.close(1000, "closed");
      } catch {
        /* already closed */
      }
    }
  }

  connect(takeover = false): void {
    this.cancelTimer();
    this.closeSocket();
    const epoch = ++this.epoch;
    this.attempts = 0;
    const url = this.options.url();
    if (!url) {
      this.wanted = false;
      this.set({ status: "closed", message: "This Ancilla has no browser.", dialog: null, select: null, downloads: [], uploads: [] });
      return;
    }
    this.wanted = true;
    this.set({ status: "connecting", message: null, dialog: null, select: null, downloads: [], uploads: [] });
    this.prepareAndOpen(url, takeover, epoch, false);
  }

  private retry(): void {
    const baseMs = this.options.retryMs ?? 0;
    const maxAttempts = this.options.maxRetries ?? 8;
    if (!this.wanted || baseMs <= 0 || this.timer !== null || this.attempts >= maxAttempts) return;
    const delay = Math.min(this.options.retryMaxMs ?? 8000, baseMs * 2 ** this.attempts);
    this.attempts += 1;
    this.timer = (this.options.schedule ?? ((run, wait) => setTimeout(run, wait)))(() => {
      this.timer = null;
      if (!this.wanted) return;
      this.closeSocket();
      const epoch = ++this.epoch;
      const url = this.options.url();
      if (!url) {
        this.wanted = false;
        this.set({ status: "closed", message: "This Ancilla has no browser." });
        return;
      }
      this.prepareAndOpen(url, false, epoch, true);
    }, delay);
  }

  private prepareAndOpen(url: string, takeover: boolean, epoch: number, background: boolean): void {
    let prep: Promise<void> | void;
    try {
      prep = this.options.prepare?.();
    } catch {
      prep = undefined;
    }
    if (prep && typeof (prep as Promise<void>).then === "function") {
      void (prep as Promise<void>).then(
        () => {
          if (this.wanted && this.epoch === epoch) this.openSocket(url, takeover, background);
        },
        () => {
          if (this.wanted && this.epoch === epoch) this.openSocket(url, takeover, background);
        },
      );
      return;
    }
    this.openSocket(url, takeover, background);
  }

  private openSocket(url: string, takeover: boolean, background: boolean): void {
    let socket: SocketLike;
    try {
      socket = this.options.open(url);
    } catch {
      if (!background) this.set({ status: "closed", message: "The browser could not be reached." });
      this.retry();
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
      const clearPending = { dialog: null, select: null, downloads: [] as PaneDownload[], uploads: [] as PaneUpload[] };
      if (event.code === 4009) {
        this.wanted = false;
        this.set({ status: "busy", message: "The browser is open in another window.", ...clearPending });
      } else if (event.code === 4010) {
        this.wanted = false;
        this.set({ status: "taken", message: "The browser moved to another window.", ...clearPending });
      } else {
        if (NON_RETRYABLE_CLOSE_CODES.has(event.code)) this.wanted = false;
        this.set({ status: "closed", message: this.view.message ?? "The connection to the browser ended.", ...clearPending });
        this.retry();
      }
    };
    socket.onerror = () => undefined;
  }

  disconnect(): void {
    this.wanted = false;
    this.epoch += 1;
    this.cancelTimer();
    this.closeSocket();
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
        this.attempts = 0;
        this.set({ status: "open", tabs: message.tabs, active: message.active, message: null, dialog: null, select: null, downloads: [], uploads: [] });
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
      case "upload":
        this.set({ uploads: [...this.view.uploads.filter((u) => u.id !== message.upload.id), message.upload] });
        return;
      case "upload-closed":
        this.set({ uploads: this.view.uploads.filter((u) => u.id !== message.id) });
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
