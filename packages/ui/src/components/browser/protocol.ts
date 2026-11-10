/**
 * The Browser pane's wire format as the page sees it (the server's twin is `packages/server/src/browser/protocol.ts`):
 * pictures arrive as binary frames, everything else is JSON text over the same socket.
 *
 *   from the server  0x03 + sequence (u32) + width (u16) + height (u16) + tab id length (u8) + tab id + JPEG
 */

export const BROWSER_PROTOCOL_VERSION = 1;
export const FRAME_TAG = 0x03;

export interface PaneTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

export interface PaneDialog {
  tabId: string;
  kind: string;
  message: string;
  defaultPrompt?: string;
  url: string;
}

export interface SelectOption {
  index: number;
  label: string;
  disabled: boolean;
  selected: boolean;
}

export interface SelectProbe {
  rect: { x: number; y: number; width: number; height: number };
  options: SelectOption[];
  multiple: boolean;
}

export interface MouseWire {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right" | "back" | "forward";
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export interface KeyWire {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key?: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
  commands?: string[];
}

export type ClientMessage =
  | { type: "hello"; v: number; takeover: boolean }
  | { type: "open"; url: string | null }
  | { type: "close" | "activate" | "back" | "forward" | "reload" | "selection"; id: string }
  | { type: "navigate"; id: string; url: string }
  | { type: "viewport"; id: string; width: number; height: number }
  | { type: "mouse"; id: string; input: MouseWire }
  | { type: "key"; id: string; input: KeyWire }
  | { type: "text"; id: string; text: string }
  | { type: "dialog"; id: string; accept: boolean; promptText?: string }
  | { type: "choose"; id: string; index: number }
  | { type: "ack"; seq: number };

export type ServerMessage =
  | { type: "ready"; v: number; tabs: PaneTab[]; active: string | null }
  | { type: "tabs"; tabs: PaneTab[]; active: string | null }
  | { type: "dialog"; dialog: PaneDialog }
  | { type: "dialog-closed"; tabId: string }
  | { type: "notice"; kind: "download" | "file"; text: string }
  | { type: "select"; tabId: string; probe: SelectProbe }
  | { type: "selection"; text: string }
  | { type: "error"; message: string }
  | { type: "busy"; message: string };

export interface Frame {
  seq: number;
  /** The page's size in CSS pixels; the picture itself may have more pixels. */
  width: number;
  height: number;
  tabId: string;
  jpeg: Uint8Array;
}

export function decodeFrame(buffer: ArrayBuffer): Frame | null {
  if (buffer.byteLength < 10) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== FRAME_TAG) return null;
  const idLength = view.getUint8(9);
  if (buffer.byteLength < 10 + idLength) return null;
  const tabId = new TextDecoder().decode(new Uint8Array(buffer, 10, idLength));
  return { seq: view.getUint32(1, true), width: view.getUint16(5, true), height: view.getUint16(7, true), tabId, jpeg: new Uint8Array(buffer, 10 + idLength) };
}

/** What a window that only watches is told about the assistant's web task (see the server's `watch.ts`). */
export interface WatchJob {
  taskId: string;
  goal: string;
  steps: string[];
  startedAt: number;
  question: { origin: string; kind: "public" | "local" } | null;
}

export interface WatchState {
  /** The assistant's tab whose pictures follow, or null when it has none. */
  tab: string | null;
  job: WatchJob | null;
}

/** A state message from the watcher socket, or null for anything else. */
export function parseWatchState(raw: string): WatchState | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof value !== "object" || value === null || value["type"] !== "state") return null;
    const tab = typeof value["tab"] === "string" ? value["tab"] : null;
    const job = value["job"];
    if (job === null || job === undefined) return { tab, job: null };
    if (typeof job !== "object") return null;
    const o = job as Record<string, unknown>;
    if (typeof o["taskId"] !== "string" || typeof o["goal"] !== "string" || !Array.isArray(o["steps"])) return null;
    const q = o["question"] as Record<string, unknown> | null | undefined;
    const question = q && typeof q["origin"] === "string" ? { origin: q["origin"], kind: q["kind"] === "local" ? ("local" as const) : ("public" as const) } : null;
    return {
      tab,
      job: { taskId: o["taskId"], goal: o["goal"], steps: o["steps"].filter((s): s is string => typeof s === "string").slice(-8), startedAt: typeof o["startedAt"] === "number" ? o["startedAt"] : 0, question },
    };
  } catch {
    return null;
  }
}

/** The watcher's address, given the pane's: the same server, the other path. */
export function watchUrl(paneUrl: string | null): string | null {
  if (!paneUrl) return null;
  try {
    const url = new URL(paneUrl);
    if (!/\/api\/browser\/ws$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/ws$/, "/watch");
    return url.toString();
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") return value as ServerMessage;
  } catch {
    /* not ours */
  }
  return null;
}
