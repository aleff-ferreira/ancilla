import type { DialogInfo, KeyInput, MouseInput, SelectProbe } from "./service.js";

/**
 * The wire format of the Browser pane's socket. Pictures travel as binary frames, everything else as JSON text.
 *
 *   from the server  0x03 + sequence (u32) + width (u16) + height (u16) + tab id length (u8) + tab id + JPEG
 *                    (width and height are the page's size in CSS pixels; the picture may have more pixels)
 *   to the server    JSON, one of `ClientMessage`; a frame is acknowledged with `{ "type": "ack", "seq": n }` and the next
 *                    one is not sent before that.
 *
 * Whatever arrives from the network is untrusted: the parser checks the shape, the sizes and the allowed values of every
 * message and drops anything else, and never throws.
 */

export const BROWSER_PROTOCOL_VERSION = 1;
export const FRAME_TAG = 0x03;
export const MAX_MESSAGE_CHARS = 200_000;
export const MAX_URL_CHARS = 4096;
export const MAX_TEXT_CHARS = 100_000;

export interface PaneTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

export type ClientMessage =
  | { type: "hello"; v: number; takeover: boolean }
  | { type: "open"; url: string | null }
  | { type: "close"; id: string }
  | { type: "activate"; id: string }
  | { type: "navigate"; id: string; url: string }
  | { type: "back" | "forward" | "reload"; id: string }
  | { type: "viewport"; id: string; width: number; height: number }
  | { type: "mouse"; id: string; input: MouseInput }
  | { type: "key"; id: string; input: KeyInput }
  | { type: "text"; id: string; text: string }
  | { type: "dialog"; id: string; accept: boolean; promptText?: string }
  | { type: "selection"; id: string }
  | { type: "choose"; id: string; index: number }
  | { type: "ack"; seq: number };

export type ServerMessage =
  | { type: "ready"; v: number; tabs: PaneTab[]; active: string | null }
  | { type: "tabs"; tabs: PaneTab[]; active: string | null }
  | { type: "dialog"; dialog: DialogInfo }
  | { type: "dialog-closed"; tabId: string }
  | { type: "notice"; kind: "download" | "file"; text: string }
  | { type: "select"; tabId: string; probe: SelectProbe }
  | { type: "selection"; text: string }
  | { type: "error"; message: string }
  | { type: "busy"; message: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}
function num(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
function id(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

const MOUSE_TYPES = ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"];
const BUTTONS = ["none", "left", "middle", "right", "back", "forward"];
const KEY_TYPES = ["keyDown", "keyUp", "rawKeyDown", "char"];
const COMMANDS = ["selectAll", "undo", "redo", "copy", "paste", "cut"];

function parseMouse(v: unknown): MouseInput | null {
  if (!isObject(v) || typeof v["type"] !== "string" || !MOUSE_TYPES.includes(v["type"])) return null;
  const x = num(v["x"], -1e5, 1e5);
  const y = num(v["y"], -1e5, 1e5);
  if (x === null || y === null) return null;
  const out: MouseInput = { type: v["type"] as MouseInput["type"], x, y };
  if (typeof v["button"] === "string" && BUTTONS.includes(v["button"])) out.button = v["button"] as NonNullable<MouseInput["button"]>;
  const buttons = num(v["buttons"], 0, 31);
  if (buttons !== null) out.buttons = Math.trunc(buttons);
  const clickCount = num(v["clickCount"], 0, 3);
  if (clickCount !== null) out.clickCount = Math.trunc(clickCount);
  const dx = num(v["deltaX"], -1e5, 1e5);
  if (dx !== null) out.deltaX = dx;
  const dy = num(v["deltaY"], -1e5, 1e5);
  if (dy !== null) out.deltaY = dy;
  const modifiers = num(v["modifiers"], 0, 15);
  if (modifiers !== null) out.modifiers = Math.trunc(modifiers);
  return out;
}

function parseKey(v: unknown): KeyInput | null {
  if (!isObject(v) || typeof v["type"] !== "string" || !KEY_TYPES.includes(v["type"])) return null;
  const out: KeyInput = { type: v["type"] as KeyInput["type"] };
  const key = str(v["key"], 40);
  if (key !== null) out.key = key;
  const code = str(v["code"], 40);
  if (code !== null) out.code = code;
  const text = str(v["text"], 8);
  if (text !== null) out.text = text;
  const vk = num(v["windowsVirtualKeyCode"], 0, 255);
  if (vk !== null) out.windowsVirtualKeyCode = Math.trunc(vk);
  const modifiers = num(v["modifiers"], 0, 15);
  if (modifiers !== null) out.modifiers = Math.trunc(modifiers);
  if (Array.isArray(v["commands"])) {
    const commands = v["commands"].filter((c): c is string => typeof c === "string" && COMMANDS.includes(c));
    if (commands.length > 0) out.commands = commands.slice(0, 2);
  }
  return out;
}

/** A client message, or null when the text is not one this server understands. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value["type"] !== "string") return null;
  switch (value["type"]) {
    case "hello": {
      const v = num(value["v"], 0, 1000);
      return v === null ? null : { type: "hello", v: Math.trunc(v), takeover: value["takeover"] === true };
    }
    case "open": {
      if (value["url"] === null || value["url"] === undefined) return { type: "open", url: null };
      const url = str(value["url"], MAX_URL_CHARS);
      return url === null ? null : { type: "open", url };
    }
    case "close":
    case "activate":
    case "back":
    case "forward":
    case "reload":
    case "selection": {
      const tab = id(value["id"]);
      return tab === null ? null : ({ type: value["type"], id: tab } as ClientMessage);
    }
    case "navigate": {
      const tab = id(value["id"]);
      const url = str(value["url"], MAX_URL_CHARS);
      return tab === null || url === null ? null : { type: "navigate", id: tab, url };
    }
    case "viewport": {
      const tab = id(value["id"]);
      const width = num(value["width"], 1, 16_000);
      const height = num(value["height"], 1, 16_000);
      return tab === null || width === null || height === null ? null : { type: "viewport", id: tab, width, height };
    }
    case "mouse": {
      const tab = id(value["id"]);
      const input = parseMouse(value["input"]);
      return tab === null || input === null ? null : { type: "mouse", id: tab, input };
    }
    case "key": {
      const tab = id(value["id"]);
      const input = parseKey(value["input"]);
      return tab === null || input === null ? null : { type: "key", id: tab, input };
    }
    case "text": {
      const tab = id(value["id"]);
      const text = str(value["text"], MAX_TEXT_CHARS);
      return tab === null || text === null || text === "" ? null : { type: "text", id: tab, text };
    }
    case "dialog": {
      const tab = id(value["id"]);
      if (tab === null || typeof value["accept"] !== "boolean") return null;
      const promptText = str(value["promptText"], 10_000);
      return { type: "dialog", id: tab, accept: value["accept"], ...(promptText !== null ? { promptText } : {}) };
    }
    case "choose": {
      const tab = id(value["id"]);
      const index = num(value["index"], 0, 100_000);
      return tab === null || index === null ? null : { type: "choose", id: tab, index: Math.trunc(index) };
    }
    case "ack": {
      const seq = num(value["seq"], 0, 2 ** 32 - 1);
      return seq === null ? null : { type: "ack", seq: Math.trunc(seq) };
    }
    default:
      return null;
  }
}

export function serialize(message: ServerMessage): string {
  return JSON.stringify(message);
}

/** The binary frame for a picture of a tab. */
export function encodeFrame(seq: number, width: number, height: number, tabId: string, jpeg: Buffer): Buffer {
  const idBytes = Buffer.from(tabId, "utf8");
  const head = Buffer.allocUnsafe(10 + idBytes.length);
  head[0] = FRAME_TAG;
  head.writeUInt32LE(seq >>> 0, 1);
  head.writeUInt16LE(Math.min(65535, Math.max(0, Math.round(width))), 5);
  head.writeUInt16LE(Math.min(65535, Math.max(0, Math.round(height))), 7);
  head[9] = idBytes.length;
  idBytes.copy(head, 10);
  return Buffer.concat([head, jpeg]);
}

export function decodeFrame(data: Buffer): { seq: number; width: number; height: number; tabId: string; jpeg: Buffer } | null {
  if (data.length < 10 || data[0] !== FRAME_TAG) return null;
  const idLen = data[9] as number;
  if (data.length < 10 + idLen) return null;
  return {
    seq: data.readUInt32LE(1),
    width: data.readUInt16LE(5),
    height: data.readUInt16LE(7),
    tabId: data.subarray(10, 10 + idLen).toString("utf8"),
    jpeg: data.subarray(10 + idLen),
  };
}
