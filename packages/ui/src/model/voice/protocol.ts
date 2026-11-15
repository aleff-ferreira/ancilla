/**
 * The page's side of the call's wire format. Audio goes as binary frames, everything else as JSON text, over one
 * WebSocket (the server's `voice/protocol.ts` is the other half, and a test holds the two to the same bytes).
 *
 *   to the server   0x01 + PCM16 little-endian, mono, 16 kHz
 *   from the server 0x02 + utterance (u32) + chunk (u32) + first sample (u32) + PCM16 little-endian at the `ready` rate
 */

export const PROTOCOL_VERSION = 1;
export const AUDIO_IN = 0x01;
export const AUDIO_OUT = 0x02;
export const INPUT_RATE = 16_000;

export type CallMode = "hands-free" | "push-to-talk";
export type CallPhase = "listening" | "thinking" | "speaking" | "idle";

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
  endpointMs: number | null;
  asrMs: number | null;
  firstTokenMs: number | null;
  firstAudioMs: number | null;
  totalMs: number | null;
  bargeIn: boolean;
  endpointReason?: string | null;
  asrRefineMs?: number | null;
  asrConfidence?: number | null;
  snapshotHit?: boolean | null;
  contextCacheHit?: boolean | null;
  eotGateSavedMs?: number | null;
  groundedEntities?: string[] | null;
}

export type ClientMessage =
  | { type: "hello"; v: number; mode: CallMode; lang: string | null; echoCancelled: boolean; resume: string | null; thread: string | null; project?: string | null }
  | { type: "playback"; utterance: number; samples: number }
  | { type: "interrupt"; utterance: number; samples: number }
  | { type: "text"; text: string }
  | { type: "mute"; on: boolean }
  | { type: "resume_mic" }
  | { type: "ptt"; down: boolean }
  | { type: "decide"; id: string; allow: boolean }
  | { type: "end" }
  | { type: "ping"; t: number };

export type ServerMessage =
  | { type: "ready"; session: string; sampleRate: number; engine: string; voice: string; lang: string | null; resumed: boolean; model?: string }
  | { type: "model"; label: string }
  | { type: "mic_paused"; paused: boolean; reason: string | null }
  | { type: "state"; state: CallPhase }
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

/** One frame of microphone audio (16 kHz, mono) as the bytes to send. */
export function encodeMicFrame(pcm: Int16Array): ArrayBuffer {
  const out = new ArrayBuffer(1 + pcm.length * 2);
  const view = new DataView(out);
  view.setUint8(0, AUDIO_IN);
  for (let i = 0; i < pcm.length; i++) view.setInt16(1 + i * 2, pcm[i] as number, true);
  return out;
}

export interface AudioChunk {
  utterance: number;
  chunk: number;
  firstSample: number;
  pcm: Int16Array;
}

/** A stretch of the assistant's voice from its bytes, or null when they are not audio of this protocol. */
export function decodeAudioOut(data: ArrayBuffer): AudioChunk | null {
  if (data.byteLength < 13 || (data.byteLength - 13) % 2 !== 0) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== AUDIO_OUT) return null;
  const pcm = new Int16Array((data.byteLength - 13) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(13 + i * 2, true);
  return { utterance: view.getUint32(1, true), chunk: view.getUint32(5, true), firstSample: view.getUint32(9, true), pcm };
}

/** A server message from text, or null when it is not one this page understands. Never throws. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") return null;
  return value as ServerMessage;
}
