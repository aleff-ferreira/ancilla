import type { KeyWire } from "./protocol.js";

/**
 * What the Browser pane does with the person's keyboard, mouse and address bar, as pure functions: which key presses
 * go to the page as key events, which text goes in as text (so a dead key, a composed `ã` or an AltGr character from a
 * Brazilian ABNT2 keyboard arrives whole), where a click lands on the page, and what an address bar entry means.
 */

export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export function modifiersOf(e: Pick<KeyLike, "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): number {
  return (e.altKey ? MOD_ALT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.metaKey ? MOD_META : 0) | (e.shiftKey ? MOD_SHIFT : 0);
}

/** Keys that are keys, not text: they reach the page as key events. `text` is what the key types when it types. */
const NAMED: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Delete: { code: "Delete", vk: 46 },
  Insert: { code: "Insert", vk: 45 },
  " ": { code: "Space", vk: 32, text: " " },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
};

/** Keys that mean nothing alone, and the ones an input method uses; they are not sent. */
const SILENT = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "Dead", "Process", "Unidentified", "OS", "ContextMenu", "Compose"]);

export type KeyPlan =
  /** Leave it to the text path or the browser (a composition, a dead key, a clipboard chord). */
  | { kind: "ignore" }
  | { kind: "send"; inputs: KeyWire[]; /** Stop the page of the pane itself from acting on the key. */ prevent: boolean };

const IGNORE: KeyPlan = { kind: "ignore" };

function virtualKey(key: string): number {
  const named = NAMED[key];
  if (named) return named.vk;
  const f = /^F([1-9]|1[0-2])$/.exec(key);
  if (f) return 111 + Number(f[1]);
  const upper = key.toUpperCase();
  return upper.length === 1 && /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0;
}

function codeOf(key: string, code: string): string {
  return NAMED[key]?.code ?? code;
}

function isPrintable(key: string): boolean {
  return [...key].length === 1;
}

/** AltGr reports as Ctrl and Alt together on Windows; the character it types is text, not a shortcut. */
function altGr(e: KeyLike): boolean {
  return e.ctrlKey && e.altKey && !e.metaKey;
}

const COMMAND_OF: Record<string, string> = { a: "selectAll", z: "undo", y: "redo" };

export function planKeyDown(e: KeyLike): KeyPlan {
  if (e.isComposing || SILENT.has(e.key)) return IGNORE;
  const named = NAMED[e.key];
  const f = /^F([1-9]|1[0-2])$/.test(e.key);
  const printable = isPrintable(e.key);
  if (!named && !f && !printable) return IGNORE;
  const mods = modifiersOf(e);
  // Ctrl or Cmd with a letter is a shortcut. Copy, cut and paste come as clipboard events of their own.
  if ((e.ctrlKey || e.metaKey) && !altGr(e) && (printable || named || f)) {
    const lower = e.key.toLowerCase();
    if (lower === "c" || lower === "x" || lower === "v") return IGNORE;
    const command = printable ? (lower === "z" && e.shiftKey ? "redo" : COMMAND_OF[lower]) : undefined;
    return {
      kind: "send",
      prevent: true,
      inputs: [{ type: "rawKeyDown", key: e.key, code: codeOf(e.key, e.code), windowsVirtualKeyCode: virtualKey(e.key), modifiers: mods, ...(command ? { commands: [command] } : {}) }],
    };
  }
  if (named || f) {
    const text = named?.text;
    return {
      kind: "send",
      prevent: true,
      inputs: [{ type: text ? "keyDown" : "rawKeyDown", key: e.key, code: codeOf(e.key, e.code), windowsVirtualKeyCode: virtualKey(e.key), modifiers: mods, ...(text ? { text } : {}) }],
    };
  }
  // A printable key: the page sees the key press now and the character arrives as text (`beforeinput`), which is the only
  // way a composed or AltGr character comes through whole. Ctrl and Alt of an AltGr are not passed on.
  const clean = altGr(e) ? mods & ~(MOD_CTRL | MOD_ALT) : mods;
  return { kind: "send", prevent: false, inputs: [{ type: "rawKeyDown", key: e.key, code: e.code, windowsVirtualKeyCode: virtualKey(e.key), modifiers: clean }] };
}

export function planKeyUp(e: KeyLike): KeyPlan {
  if (e.isComposing || SILENT.has(e.key)) return IGNORE;
  const named = NAMED[e.key];
  const f = /^F([1-9]|1[0-2])$/.test(e.key);
  const printable = isPrintable(e.key);
  if (!named && !f && !printable) return IGNORE;
  const lower = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !altGr(e) && (lower === "c" || lower === "x" || lower === "v")) return IGNORE;
  const mods = altGr(e) && printable ? modifiersOf(e) & ~(MOD_CTRL | MOD_ALT) : modifiersOf(e);
  return { kind: "send", prevent: Boolean(named || f), inputs: [{ type: "keyUp", key: e.key, code: codeOf(e.key, e.code), windowsVirtualKeyCode: virtualKey(e.key), modifiers: mods }] };
}

/**
 * The text a person types, whole. A dead key (`~`, then `a`), an input method or an AltGr character is not a key press
 * the page can act on; it is a string. `beforeinput` gives the plain characters and `compositionend` the composed ones;
 * a character a method reports both ways is sent once.
 */
export class TextGate {
  private composing = false;
  private last = "";
  private lastAt = -Infinity;

  compositionStart(): void {
    this.composing = true;
  }

  compositionEnd(data: string, now: number): string | null {
    this.composing = false;
    if (!data) return null;
    this.last = data;
    this.lastAt = now;
    return data;
  }

  beforeInput(inputType: string, data: string | null, isComposing: boolean, now: number): string | null {
    if (this.composing || isComposing || inputType === "insertCompositionText") return null;
    // Only typed characters. A paste has its own event, a line break is the Enter key, a deletion is the Backspace key.
    if (inputType !== "insertText" && inputType !== "insertReplacementText") return null;
    if (!data) return null;
    if (data === this.last && now - this.lastAt < 40) return null;
    return data;
  }
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a pointer at (clientX, clientY) is on the page, in the page's own pixels; null when the pane has no size. */
export function toPagePoint(box: Box, page: { width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return null;
  const x = ((clientX - box.left) * page.width) / box.width;
  const y = ((clientY - box.top) * page.height) / box.height;
  return { x: Math.min(page.width, Math.max(0, x)), y: Math.min(page.height, Math.max(0, y)) };
}

/** Where a point of the page is on the screen: the inverse of `toPagePoint`. */
export function toScreenRect(box: Box, page: { width: number; height: number }, r: { x: number; y: number; width: number; height: number }): Box {
  const sx = page.width > 0 ? box.width / page.width : 1;
  const sy = page.height > 0 ? box.height / page.height : 1;
  return { left: box.left + r.x * sx, top: box.top + r.y * sy, width: r.width * sx, height: r.height * sy };
}

export const SEARCH_URL = "https://duckduckgo.com/?q=";

const HOST_PORT = /^[^\s/]+:\d+(\/|$)/;
const LOCAL_HOST = /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i;
const DOMAIN = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i;

/** What an address bar entry opens: an address as it is, a host with `https://` (or `http://` for this machine), else a search. */
export function resolveAddress(input: string): string {
  const text = input.trim();
  if (text === "") return "about:blank";
  if (/^https?:\/\/\S+$/i.test(text) || text === "about:blank") return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !HOST_PORT.test(text)) return SEARCH_URL + encodeURIComponent(text);
  if (/\s/.test(text)) return SEARCH_URL + encodeURIComponent(text);
  if (LOCAL_HOST.test(text)) return `http://${text}`;
  if (DOMAIN.test(text)) return `https://${text}`;
  return SEARCH_URL + encodeURIComponent(text);
}
