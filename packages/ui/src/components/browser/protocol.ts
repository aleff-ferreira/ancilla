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

/** A finished download waiting for the person to say where it goes (it is staged on the server, not saved). */
export interface PaneDownload {
  id: string;
  tabId: string | null;
  name: string;
  size: number | null;
  origin: string;
  page: string;
  folder: string;
  rememberFolder?: boolean;
  warning: string | null;
}

/** An `<input type="file">` chooser opened by a page, waiting for the person to choose local file(s). */
export interface PaneUpload {
  id: string;
  tabId: string;
  multiple: boolean;
  origin: string;
  page: string;
  folder: string;
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
  | { type: "save"; id: string; accept: boolean; folder?: string; remember?: boolean }
  | { type: "upload"; id: string; accept: boolean; files?: string[] }
  | { type: "choose"; id: string; index: number }
  | { type: "ack"; seq: number };

export type ServerMessage =
  | { type: "ready"; v: number; tabs: PaneTab[]; active: string | null }
  | { type: "tabs"; tabs: PaneTab[]; active: string | null }
  | { type: "dialog"; dialog: PaneDialog }
  | { type: "dialog-closed"; tabId: string }
  | { type: "download"; download: PaneDownload }
  | { type: "download-closed"; id: string }
  | { type: "upload"; upload: PaneUpload }
  | { type: "upload-closed"; id: string }
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
export interface SiteQuestionView {
  origin: string;
  kind: "public" | "local";
}

/** An action that changes something: what it is, the page it is on, and what will be sent (secrets masked by the server). */
export interface ActionQuestionView {
  type: "action";
  origin: string;
  kind: "public" | "local";
  page: string;
  what: string;
  fields: Array<{ name: string; value: string }>;
  /** Said in words when something about the fields needs saying (all values hidden, because the page did not say which are passwords). */
  note?: string;
  /** A download to save: the file, and where it goes unless the person picks another folder. */
  download?: { id: string; name: string; size: number | null; folder: string; warning: string | null };
  /** A file chooser opened on the page: the person selects local file(s) to upload. */
  upload?: { id: string; multiple: boolean; folder: string };
}

export type WatchQuestion = SiteQuestionView | ActionQuestionView;

export function isActionQuestion(question: WatchQuestion): question is ActionQuestionView {
  return "what" in question;
}

/** A question as the server sends it: a site (no more is said of it than before), or an action; anything else is nothing. */
export function parseQuestion(raw: unknown): WatchQuestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const q = raw as Record<string, unknown>;
  if (typeof q["origin"] !== "string") return null;
  const kind = q["kind"] === "local" ? ("local" as const) : ("public" as const);
  if (q["type"] === "action" && typeof q["what"] === "string") {
    const fields = (Array.isArray(q["fields"]) ? q["fields"] : [])
      .map((f) => f as Record<string, unknown> | null)
      .filter((f): f is Record<string, unknown> => f !== null && typeof f["name"] === "string" && typeof f["value"] === "string")
      .slice(0, 20)
      .map((f) => ({ name: f["name"] as string, value: f["value"] as string }));
    const d = q["download"] as Record<string, unknown> | null | undefined;
    const download = d && typeof d === "object" && typeof d["name"] === "string" && typeof d["folder"] === "string"
      ? { id: typeof d["id"] === "string" ? d["id"] : "", name: d["name"], size: typeof d["size"] === "number" ? d["size"] : null, folder: d["folder"], warning: typeof d["warning"] === "string" ? d["warning"] : null }
      : undefined;
    const u = q["upload"] as Record<string, unknown> | null | undefined;
    const upload = u && typeof u === "object" && typeof u["folder"] === "string"
      ? { id: typeof u["id"] === "string" ? u["id"] : "", multiple: u["multiple"] === true, folder: u["folder"] }
      : undefined;
    const note = typeof q["note"] === "string" && q["note"] !== "" ? q["note"].slice(0, 300) : undefined;
    return {
      type: "action",
      origin: q["origin"],
      kind,
      page: typeof q["page"] === "string" ? q["page"] : "",
      what: q["what"],
      fields,
      ...(note ? { note } : {}),
      ...(download ? { download } : {}),
      ...(upload ? { upload } : {}),
    };
  }
  return { origin: q["origin"], kind };
}

export interface WatchJob {
  taskId: string;
  goal: string;
  steps: string[];
  startedAt: number;
  question: WatchQuestion | null;
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
    const question = parseQuestion(o["question"]);
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
