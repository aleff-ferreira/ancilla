import { initialCall, reduceServer, withTyped, type CallView } from "./callState.js";
import { PROTOCOL_VERSION, decodeAudioOut, encodeMicFrame, parseServerMessage, type CallMode, type ClientMessage } from "./protocol.js";
import type { Player } from "./player.js";

/**
 * One call, as the page runs it: the socket to the server, the microphone that feeds it and the speakers that play what
 * comes back. The pieces that touch the machine (the socket, the microphone, the speakers) are handed in, so the whole
 * of this is tested with stand-ins. What the screen shows is `view`, a pure function of what the server said.
 */

/** The part of a WebSocket the call uses. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** What the microphone is doing, as the browser reports it: heard, held muted by the system or the device, or gone. */
export type MicState = "live" | "muted" | "ended";

export interface MicHandle {
  stop(): void;
  /** The browser is cancelling the speakers' sound out of the microphone. */
  echoCancelled: boolean;
  /** What the browser calls the microphone in use, for the words said to the person. */
  label?: string;
  /** The system, or the device itself, holds the microphone muted: it hears nothing, whatever the person says. */
  muted?(): boolean;
  /** Told when that changes, and when the microphone is lost altogether (unplugged, or taken by another program). */
  watch?(listener: (state: MicState) => void): void;
}

export interface CallIO {
  /** The address of the call's socket, or null where there is none. */
  socketUrl(): string | null;
  openSocket(url: string): SocketLike;
  /** Starts the microphone; `onFrame` gets 32 ms of 16 kHz audio and how loud it was. Rejects when the person says no. */
  startMic(onFrame: (pcm: Int16Array, rms: number) => void): Promise<MicHandle>;
  createPlayer(sampleRate: number): Player;
  /** Lets go of the audio machinery once the call is over. */
  dispose?(): void;
}

export interface CallOptions {
  mode: CallMode;
  lang: string | null;
  project: string | null;
}

const OPEN = 1;
const MAX_BUFFERED = 1_000_000;
const REPORT_EVERY_MS = 100;
const MAX_RECONNECTS = 2;
/**
 * A frame whose loudest sample is this small (of 32 768) is digital silence: a room, even a quiet one, is louder than
 * that through any microphone, so a line this flat is a microphone that is muted, blocked or not the one being spoken into.
 */
const SILENT_PEAK = 2;
/** How many frames of 32 ms of it, in a row, are worth saying so: a little over six seconds. */
const SILENT_FRAMES = 190;

function micMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is blocked. Allow it for Ancilla in the browser or system settings, then start the call again. You can still type.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. You can still type.";
  return "The microphone could not be opened. You can still type.";
}

const MIC_MUTED = "The microphone is muted (in the system's sound settings, or by a key or switch on the device), so Ancilla hears nothing. Unmute it and the call picks up by itself. You can still type.";
const MIC_ENDED = "The microphone stopped, which happens when it is unplugged or another program takes it. End the call and start it again. You can still type.";

function micSilent(label: string): string {
  const which = label === "" ? "" : ` (${label.length > 70 ? `${label.slice(0, 69)}…` : label})`;
  return `Ancilla is getting no sound at all from the microphone${which}. Check that it is not muted and is the one you speak into. You can still type.`;
}

export class CallSession {
  private state: CallView;
  private readonly listeners = new Set<() => void>();
  private socket: SocketLike | null = null;
  private mic: MicHandle | null = null;
  private player: Player | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private reconnects = 0;
  private micLevel = 0;
  private echoCancelled = true;
  /** Why the microphone could not be opened at all, in words for the person; null when it was. */
  private openProblem: string | null = null;
  private micState: MicState = "live";
  private micLabel = "";
  /** Frames in a row that were digital silence, and whether that has gone on long enough to say so. */
  private quiet = 0;
  private silent = false;

  constructor(
    private readonly io: CallIO,
    private readonly options: CallOptions,
    private readonly clock: () => number = Date.now,
  ) {
    this.state = initialCall(options.mode);
  }

  get view(): CallView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: CallView): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** How loud the person (from the microphone) and the assistant (from the speakers) are now, each 0 to 1. */
  levels(): { mic: number; voice: number } {
    return { mic: this.state.muted ? 0 : this.micLevel, voice: this.player?.level() ?? 0 };
  }

  // -------------------------------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    const url = this.io.socketUrl();
    if (url === null) {
      this.set({ ...this.state, status: "failed", error: "This version of Ancilla has no voice." });
      return;
    }
    // The microphone first: its permission prompt belongs to the click that started the call.
    const micReady = this.io
      .startMic((pcm, rms) => this.onMicFrame(pcm, rms))
      .then(
        (mic) => {
          this.mic = mic;
          this.echoCancelled = mic.echoCancelled;
          this.micLabel = mic.label ?? "";
          mic.watch?.((state) => {
            this.micState = state;
            this.showMicProblem();
          });
          if (mic.muted?.()) this.micState = "muted";
          this.showMicProblem();
          return true;
        },
        (error: unknown) => {
          this.openProblem = micMessage(error);
          this.showMicProblem();
          return false;
        },
      );
    await micReady;
    if (this.closing) return;
    this.open(url);
  }

  /** The words for why the microphone is not being heard, or null when it is: what the call shows under its face. */
  private micWords(): string | null {
    if (this.openProblem !== null) return this.openProblem;
    if (this.micState === "ended") return MIC_ENDED;
    if (this.micState === "muted") return MIC_MUTED;
    return this.silent ? micSilent(this.micLabel) : null;
  }

  private showMicProblem(): void {
    const words = this.micWords();
    if (words !== this.state.micProblem) this.set({ ...this.state, micProblem: words });
  }

  /**
   * Counts the frames that are nothing but silence. A microphone the system holds muted is told by the browser, but a
   * driver, a privacy switch or a device that is not the one being spoken into may only deliver zeros, so what arrives is
   * watched as well. Counted only while the person has not muted it themselves, which is no problem.
   */
  private listenForSilence(pcm: Int16Array): void {
    if (this.state.muted) {
      this.quiet = 0;
      if (this.silent) {
        this.silent = false;
        this.showMicProblem();
      }
      return;
    }
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] as number;
      const size = v < 0 ? -v : v;
      if (size > peak) peak = size;
    }
    if (peak <= SILENT_PEAK) {
      this.quiet += 1;
      if (this.quiet >= SILENT_FRAMES && !this.silent) {
        this.silent = true;
        this.showMicProblem();
      }
    } else {
      this.quiet = 0;
      if (this.silent) {
        this.silent = false;
        this.showMicProblem();
      }
    }
  }

  private open(url: string): void {
    const socket = this.io.openSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.sendMessage({ type: "hello", v: PROTOCOL_VERSION, mode: this.state.mode, lang: this.options.lang, echoCancelled: this.echoCancelled, resume: null, thread: null, project: this.options.project });
    };
    socket.onmessage = (event) => this.onData(event.data);
    socket.onerror = () => undefined;
    socket.onclose = (event) => this.onSocketClosed(event.code, event.reason);
  }

  private onData(data: unknown): void {
    if (typeof data === "string") {
      const message = parseServerMessage(data);
      if (!message) return;
      this.onMessage(message);
      return;
    }
    if (data instanceof ArrayBuffer) {
      const chunk = decodeAudioOut(data);
      if (chunk && this.player) this.player.enqueue(chunk.utterance, chunk.pcm);
    }
  }

  private onMessage(message: Parameters<typeof reduceServer>[1]): void {
    switch (message.type) {
      case "ready":
        this.player?.close();
        this.player = this.io.createPlayer(message.sampleRate);
        this.reconnects = 0;
        this.startReports();
        break;
      case "interrupted": {
        const stopped = this.player?.stop();
        if (stopped && stopped.utterance === message.utterance) this.sendMessage({ type: "playback", utterance: stopped.utterance, samples: stopped.played });
        break;
      }
      case "duck":
        this.player?.duck(message.on);
        break;
      case "ended":
        this.player?.stop();
        break;
      default:
        break;
    }
    this.set(reduceServer(this.state, message, this.clock()));
  }

  /** Tells the server how much of the reply has been played, so that it paces itself and knows what was heard. */
  private startReports(): void {
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = setInterval(() => {
      const player = this.player;
      if (!player) return;
      const utterance = player.current();
      if (utterance > 0) this.sendMessage({ type: "playback", utterance, samples: player.played(utterance) });
    }, REPORT_EVERY_MS);
  }

  private onMicFrame(pcm: Int16Array, rms: number): void {
    this.micLevel = Math.min(1, rms * 6);
    this.listenForSilence(pcm);
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.state.muted || this.state.status !== "ready") return;
    if (socket.bufferedAmount > MAX_BUFFERED) return;
    socket.send(encodeMicFrame(pcm));
  }

  private onSocketClosed(code: number, reason: string): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    this.player?.stop();
    if (this.closing || this.state.status === "ended" || this.state.status === "failed") {
      this.releaseMachine();
      return;
    }
    // A dropped connection (not one the call ended) is tried again a couple of times: the conversation is kept on the server.
    if (this.state.status === "ready" && code !== 1000 && this.reconnects < MAX_RECONNECTS) {
      this.reconnects += 1;
      this.set({ ...this.state, status: "connecting", notice: { level: "warn", text: "Connection lost. Reconnecting…" } });
      const url = this.io.socketUrl();
      if (url) {
        setTimeout(() => {
          if (!this.closing) this.open(url);
        }, 600 * this.reconnects);
        return;
      }
    }
    this.set({ ...this.state, status: this.state.status === "ready" || this.state.status === "connecting" ? "failed" : this.state.status, error: this.state.error ?? (reason || "The connection to Ancilla was lost.") });
    this.releaseMachine();
  }

  private releaseMachine(): void {
    this.mic?.stop();
    this.mic = null;
    this.player?.close();
    this.player = null;
    this.io.dispose?.();
  }

  private sendMessage(message: ClientMessage): void {
    const socket = this.socket;
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(message));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What the person does

  sendText(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "" || this.state.status !== "ready") return;
    // Typing over the assistant's voice cuts it off, as speaking would.
    const stopped = this.player?.stop();
    if (stopped && stopped.utterance > 0) this.sendMessage({ type: "interrupt", utterance: stopped.utterance, samples: stopped.played });
    this.sendMessage({ type: "text", text: trimmed });
    this.set(withTyped(this.state, trimmed));
  }

  setMuted(on: boolean): void {
    if (on === this.state.muted) return;
    this.set({ ...this.state, muted: on, talking: false });
    this.sendMessage({ type: "mute", on });
  }

  setMode(mode: CallMode): void {
    if (mode === this.state.mode) return;
    this.set({ ...this.state, mode, talking: false });
  }

  /** Push to talk: the button is down or up. */
  talk(down: boolean): void {
    if (this.state.mode !== "push-to-talk" || this.state.muted || this.state.talking === down) return;
    if (down) {
      const stopped = this.player?.stop();
      if (stopped && stopped.utterance > 0) this.sendMessage({ type: "interrupt", utterance: stopped.utterance, samples: stopped.played });
    }
    this.set({ ...this.state, talking: down });
    this.sendMessage({ type: "ptt", down });
  }

  /** Cuts the assistant off, as a button. */
  interrupt(): void {
    const stopped = this.player?.stop();
    if (stopped && stopped.utterance > 0) this.sendMessage({ type: "interrupt", utterance: stopped.utterance, samples: stopped.played });
  }

  /** Allows or denies a pending launch, write, or thread action shown on the call card. */
  decide(id: string, allow: boolean): void {
    if (!id || this.state.status !== "ready") return;
    this.sendMessage({ type: "decide", id, allow });
    if (this.state.approval?.id === id) {
      this.set({ ...this.state, approval: null });
    }
  }

  end(): void {
    if (this.closing) return;
    this.closing = true;
    this.sendMessage({ type: "end" });
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    this.releaseMachine();
    const socket = this.socket;
    if (socket) {
      try {
        socket.close(1000, "the person hung up");
      } catch {
        /* already closed */
      }
    }
    this.set({ ...this.state, status: this.state.status === "failed" ? "failed" : "ended", phase: "idle", heard: false, partial: "", endedReason: this.state.endedReason ?? "You ended the call." });
  }
}
