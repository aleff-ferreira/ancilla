import { decodeFrame, parseWatchState, type Frame, type WatchJob } from "./protocol.js";
import type { SocketLike } from "./session.js";

/**
 * The connection that only watches the assistant: what its web task is doing, and the pictures of its tab. It never sends
 * anything but the acknowledgement of a picture, once the picture has been drawn.
 */

export type WatchStatus = "idle" | "connecting" | "open" | "closed";

export interface WatchView {
  status: WatchStatus;
  tab: string | null;
  job: WatchJob | null;
}

export const EMPTY_WATCH: WatchView = { status: "idle", tab: null, job: null };

export interface WatchOptions {
  /** The watcher socket's address, or null where the page has no browser. */
  url: () => string | null;
  open: (url: string) => SocketLike;
  onChange: (view: WatchView) => void;
  /** A picture to draw; `done` says it was drawn (or could not be) so the server may send the next. */
  onFrame: (frame: Frame, done: () => void) => void;
  /** Milliseconds before looking again after the connection ends; 0 or absent does not try again. */
  retryMs?: number;
  /** For tests. */
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

const OPEN = 1;

export class AssistantWatch {
  private socket: SocketLike | null = null;
  private view: WatchView = EMPTY_WATCH;
  private wanted = false;
  private timer: unknown = null;

  constructor(private readonly options: WatchOptions) {}

  get current(): WatchView {
    return this.view;
  }

  private set(patch: Partial<WatchView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onChange(this.view);
  }

  connect(): void {
    this.wanted = true;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    if (this.timer !== null) (this.options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
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
    if (this.view.status !== "idle") this.view = { ...EMPTY_WATCH, status: "closed" };
  }

  private open(): void {
    this.timer = null;
    const url = this.options.url();
    if (!url) {
      this.set({ status: "closed" });
      return;
    }
    this.set({ status: "connecting" });
    let socket: SocketLike;
    try {
      socket = this.options.open(url);
    } catch {
      this.set({ status: "closed" });
      this.retry();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.set({ status: "open" });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") this.onText(event.data);
      else if (event.data instanceof ArrayBuffer) this.onBinary(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.set({ status: "closed", tab: null, job: null });
      this.retry();
    };
    socket.onerror = () => undefined;
  }

  private retry(): void {
    const ms = this.options.retryMs ?? 0;
    if (!this.wanted || ms <= 0 || this.timer !== null) return;
    this.timer = (this.options.schedule ?? ((run, wait) => setTimeout(run, wait)))(() => this.open(), ms);
  }

  private send(message: { type: "ack"; seq: number }): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private onText(raw: string): void {
    const state = parseWatchState(raw);
    if (state) this.set({ tab: state.tab, job: state.job });
  }

  private onBinary(buffer: ArrayBuffer): void {
    const frame = decodeFrame(buffer);
    if (!frame) return;
    const ack = (): void => this.send({ type: "ack", seq: frame.seq });
    // Only the tab the state names is drawn; a picture of any other is acknowledged and dropped.
    if (this.view.tab !== null && frame.tabId !== this.view.tab) {
      ack();
      return;
    }
    this.options.onFrame(frame, ack);
  }
}
