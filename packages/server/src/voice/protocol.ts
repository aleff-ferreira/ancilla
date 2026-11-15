/**
 * The wire format of a call. Audio travels as binary frames, everything else as JSON text, over one WebSocket.
 *
 *   to the server   0x01 + PCM16 little-endian, mono, 16 kHz (20 to 40 ms per frame)
 *   from the server 0x02 + utterance (u32) + chunk (u32) + first sample (u32) + PCM16 little-endian, mono, at the rate
 *                   the `ready` message names
 *
 * Whatever arrives from the network is untrusted: the parser checks the shape, the sizes and the allowed values of every
 * message and drops anything else, and never throws.
 */

export const PROTOCOL_VERSION = 1;
export const AUDIO_IN = 0x01;
export const AUDIO_OUT = 0x02;
export const INPUT_RATE = 16_000;
/** The largest binary frame accepted: one second of audio. */
export const MAX_AUDIO_FRAME_BYTES = 1 + INPUT_RATE * 2;
export const MAX_TEXT_CHARS = 4000;

export type CallMode = "hands-free" | "push-to-talk";

export type ClientMessage =
  /**
   * Opens the call. `thread` names the conversation to go on from (null: the last one, or a new one); `project` is the folder
   * work started by voice runs in. Either may be left out.
   */
  | { type: "hello"; v: number; mode: CallMode; lang: string | null; echoCancelled: boolean; resume: string | null; thread: string | null; project?: string | null }
  | { type: "playback"; utterance: number; samples: number }
  | { type: "interrupt"; utterance: number; samples: number }
  | { type: "text"; text: string }
  | { type: "mute"; on: boolean }
  | { type: "ptt"; down: boolean }
  | { type: "decide"; id: string; allow: boolean }
  | { type: "resume_mic" }
  | { type: "end" }
  | { type: "ping"; t: number };

export type CallState = "listening" | "thinking" | "speaking" | "idle";

export interface CallApproval {
  id: string;
  kind: string;
  title: string;
  detail: string;
  allowLabel: string;
  denyLabel: string;
}

export interface TurnMetrics {
  turn: number;
  /** Milliseconds from the end of speech to each point, where it was reached. */
  endpointMs: number | null;
  asrMs: number | null;
  firstTokenMs: number | null;
  firstAudioMs: number | null;
  totalMs: number | null;
  bargeIn: boolean;
  endpointReason?: string;
  asrRefineMs?: number;
  asrConfidence?: number;
  snapshotHit?: boolean;
  contextCacheHit?: boolean;
  eotGateSavedMs?: number;
  groundedEntities?: string[];
}

export type ServerMessage =
  | { type: "ready"; session: string; sampleRate: number; engine: string; voice: string; lang: string | null; resumed: boolean; model?: string | null }
  | { type: "model"; label: string }
  | { type: "mic_paused"; paused: boolean; reason: string | null }
  | { type: "state"; state: CallState }
  | { type: "level"; speaking: boolean }
  | { type: "partial"; turn: number; text: string }
  | { type: "user"; turn: number; text: string; source: "voice" | "text" }
  | { type: "assistant"; turn: number; text: string; done: boolean }
  | { type: "speaking"; utterance: number; turn: number; text: string; samples: number }
  | { type: "speak_end"; utterance: number }
  | { type: "interrupted"; utterance: number; heard: string }
  | { type: "duck"; on: boolean }
  | { type: "task"; id: string; title: string; status: string; note: string | null }
  | { type: "approval"; request: CallApproval | null }
  | { type: "notice"; level: "info" | "warn"; text: string }
  | { type: "metrics"; metrics: TurnMetrics }
  | { type: "pong"; t: number }
  | { type: "error"; code: string; message: string }
  | { type: "ended"; reason: string };

const MODES: readonly string[] = ["hands-free", "push-to-talk"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uint(value: unknown, max = 0xffffffff): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function short(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** A client message, or null when the text is not one this server understands. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_TEXT_CHARS + 512) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value["type"] !== "string") return null;
  switch (value["type"]) {
    case "hello": {
      const v = uint(value["v"], 1000);
      const mode = typeof value["mode"] === "string" && MODES.includes(value["mode"]) ? (value["mode"] as CallMode) : "hands-free";
      const lang = value["lang"] === null || value["lang"] === undefined ? null : short(value["lang"], 12);
      const resume = value["resume"] === null || value["resume"] === undefined ? null : short(value["resume"], 80);
      const thread = value["thread"] === null || value["thread"] === undefined ? null : short(value["thread"], 80);
      const project = value["project"] === null || value["project"] === undefined ? null : short(value["project"], 500);
      if (v === null) return null;
      return { type: "hello", v, mode, lang, echoCancelled: value["echoCancelled"] === true, resume, thread, project };
    }
    case "playback":
    case "interrupt": {
      const utterance = uint(value["utterance"]);
      const samples = uint(value["samples"], 2 ** 40);
      if (utterance === null || samples === null) return null;
      return { type: value["type"], utterance, samples };
    }
    case "text": {
      const text = short(value["text"], MAX_TEXT_CHARS);
      return text === null || text.trim() === "" ? null : { type: "text", text };
    }
    case "mute":
      return typeof value["on"] === "boolean" ? { type: "mute", on: value["on"] } : null;
    case "ptt":
      return typeof value["down"] === "boolean" ? { type: "ptt", down: value["down"] } : null;
    case "decide": {
      const id = short(value["id"], 120);
      if (id === null || id.trim() === "" || typeof value["allow"] !== "boolean") return null;
      return { type: "decide", id: id.trim(), allow: value["allow"] };
    }
    case "resume_mic":
      return { type: "resume_mic" };
    case "end":
      return { type: "end" };
    case "ping": {
      const t = uint(value["t"], 2 ** 50);
      return t === null ? null : { type: "ping", t };
    }
    default:
      return null;
  }
}

/** One frame of microphone audio as samples, or null when the frame is not audio of this protocol. */
export function parseAudioFrame(data: Buffer): Int16Array | null {
  if (data.length < 3 || data.length > MAX_AUDIO_FRAME_BYTES || data[0] !== AUDIO_IN) return null;
  const bytes = data.length - 1;
  if (bytes % 2 !== 0) return null;
  const out = new Int16Array(bytes / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(1 + i * 2);
  return out;
}

/** The binary frame for a stretch of speech. */
export function encodeAudioOut(utterance: number, chunk: number, firstSample: number, pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(13 + pcm.length * 2);
  out[0] = AUDIO_OUT;
  out.writeUInt32LE(utterance >>> 0, 1);
  out.writeUInt32LE(chunk >>> 0, 5);
  out.writeUInt32LE(firstSample >>> 0, 9);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i] as number, 13 + i * 2);
  return out;
}

export function decodeAudioOut(data: Buffer): { utterance: number; chunk: number; firstSample: number; pcm: Int16Array } | null {
  if (data.length < 13 || data[0] !== AUDIO_OUT || (data.length - 13) % 2 !== 0) return null;
  const pcm = new Int16Array((data.length - 13) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(13 + i * 2);
  return { utterance: data.readUInt32LE(1), chunk: data.readUInt32LE(5), firstSample: data.readUInt32LE(9), pcm };
}

export function serialize(message: ServerMessage): string {
  return JSON.stringify(message);
}
