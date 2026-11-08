import type { ChatMessage, ToolCall, ToolSpec } from "./brain.js";

/**
 * What a call needs of Ancilla around it, as one interface: who the assistant is, what it remembers that bears on what was
 * just said, where the transcript is kept, which tools it has and how they run, and what happens in the background while
 * it talks. The session knows nothing else of Ancilla, so it is tested with a double and wired to the real thing in one
 * place.
 */

export interface Persona {
  name: string;
  /** What it calls the person, or null. */
  callsUser: string | null;
  /** The language it must speak, or null to follow the person. */
  language: string | null;
  /** A line on how it sounds, from the character the user made; null when there is none. */
  tone: string | null;
  /** A voice the user chose, or null. */
  voice: string | null;
}

export interface TranscriptEntry {
  turn: number;
  role: "user" | "assistant";
  text: string;
  source: "voice" | "text" | "event";
  at: number;
  /** For an assistant entry that was cut off: the words that were heard. */
  heard?: string | null;
  interrupted?: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** What the model is told of the result. */
  text: string;
  /** A short sentence to say while it runs or when it is done, if there is anything worth saying. */
  narration?: string;
}

export interface HostEvent {
  id: string;
  kind: "task" | "notice";
  title: string;
  status: string;
  /** Something worth saying aloud when there is a lull, or null to show it without speaking. */
  say: string | null;
  needsUser: boolean;
}

export interface VoiceHost {
  persona(): Persona;
  /**
   * The notes that bear on what was just said, as a block to put before it. The memory also reads the message, so that
   * "remember that..." said aloud is remembered; it is told where the words came from.
   */
  context(text: string, source: "voice" | "text"): Promise<string | null> | string | null;
  record(entry: TranscriptEntry): void;
  tools(): ToolSpec[];
  runTool(call: ToolCall, context: { turn: number; signal: AbortSignal }): Promise<ToolResult>;
  /** Hears what happens in the background until the returned function is called. */
  subscribe(handler: (event: HostEvent) => void): () => void;
  /** The earlier turns of a thread, to go on from; empty when there are none. */
  history(thread: string | null): ChatMessage[];
  /**
   * What is worth saying as a call opens: work that finished, failed or waits on the person since they last talked. Null
   * when there is none, or when the person asked for nothing unprompted. It is said once, after a moment's quiet, and not at
   * all if the person speaks first.
   */
  opening?(): string | null;
}
