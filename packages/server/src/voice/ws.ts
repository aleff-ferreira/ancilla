import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { PROTOCOL_VERSION, parseAudioFrame, parseClientMessage, serialize } from "./protocol.js";
import { VoiceUnavailableError, type CallHandle, type CallSocket, type VoiceService } from "./service.js";

/**
 * The call's WebSocket: one connection is one call. This is only plumbing between the socket and the service: it checks
 * that the first message is a hello, hands audio and messages on, keeps the connection alive, and ends the call when the
 * socket goes. Who may connect is decided before this (the server checks host, origin and token on the upgrade request).
 */

export const VOICE_SOCKET_PATH = "/api/voice/ws";

/** The most a frame may be: one second of audio and its header, or a message of text. */
const MAX_PAYLOAD = 70_000;
/** The call must say hello within this long of connecting. */
const HELLO_WITHIN_MS = 8_000;
const PING_EVERY_MS = 20_000;
/** Audio that came in while the call was still starting is kept, up to this many frames, and played into it. */
const MAX_EARLY_FRAMES = 150;
/** A client that has this much not yet sent to it is not keeping up; it is let go. */
const MAX_BUFFERED_BYTES = 4_000_000;

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class VoiceSocketServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  private readonly open = new Set<WebSocket>();

  constructor(
    private readonly service: () => VoiceService | null,
    private readonly log: (line: string) => void,
  ) {}

  /** Completes the handshake on a request the server has already let through. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const tcp = socket as Duplex & { setNoDelay?: (noDelay?: boolean) => void };
    tcp.setNoDelay?.(true);
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
    const service = this.service();
    void service?.warm();
    let handle: CallHandle | null = null;
    let starting = false;
    let gone = false;
    let alive = true;
    let warnedBacklog = false;
    const early: Buffer[] = [];

    const sendText = (text: string): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    };
    const callSocket: CallSocket = {
      sendText,
      sendBinary: (data) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          if (!warnedBacklog) {
            warnedBacklog = true;
            this.log("voice: the client is not keeping up with the audio; the call is ended");
          }
          ws.close(1013, "the client cannot keep up");
          return;
        }
        ws.send(data, { binary: true });
      },
      close: (code, reason) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
      },
    };

    const helloTimer = setTimeout(() => {
      if (!handle && !starting) ws.close(4000, "no hello");
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

    ws.on("message", (data: RawData, isBinary: boolean) => {
      alive = true;
      if (isBinary) {
        const buffer = toBuffer(data);
        if (handle) {
          const pcm = parseAudioFrame(buffer);
          if (pcm) handle.onAudio(pcm);
        } else if (starting && early.length < MAX_EARLY_FRAMES) {
          early.push(buffer);
        }
        return;
      }
      const message = parseClientMessage(toBuffer(data).toString("utf8"));
      if (!message) return;
      if (handle) {
        handle.onMessage(message);
        return;
      }
      if (starting) return;
      if (message.type !== "hello") {
        ws.close(4002, "the first message must be a hello");
        return;
      }
      clearTimeout(helloTimer);
      if (message.v !== PROTOCOL_VERSION) {
        sendText(serialize({ type: "error", code: "version", message: `This server speaks call protocol ${PROTOCOL_VERSION}; the page speaks ${message.v}. Reload the page.` }));
        ws.close(4003, "protocol version");
        return;
      }
      if (!service) {
        sendText(serialize({ type: "error", code: "unavailable", message: "The voice is not available on this server." }));
        ws.close(1011, "unavailable");
        return;
      }
      starting = true;
      service.attach(callSocket, message).then(
        (opened) => {
          if (gone) {
            void opened.close("the connection closed while the call was starting");
            return;
          }
          handle = opened;
          for (const frame of early.splice(0)) {
            const pcm = parseAudioFrame(frame);
            if (pcm) opened.onAudio(pcm);
          }
        },
        (error: unknown) => {
          starting = false;
          const unavailable = error instanceof VoiceUnavailableError;
          if (!unavailable) this.log(`voice: a call could not start: ${error instanceof Error ? error.message : String(error)}`);
          sendText(serialize({ type: "error", code: unavailable ? "unavailable" : "internal", message: unavailable ? error.message : "The call could not start." }));
          ws.close(1011, "the call could not start");
        },
      );
    });

    const finish = (): void => {
      if (gone) return;
      gone = true;
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      this.open.delete(ws);
      if (handle) void handle.close("the connection closed");
    };
    ws.on("close", finish);
    ws.on("error", (error) => {
      this.log(`voice: a call's socket failed: ${error.message}`);
      finish();
    });
  }
}
