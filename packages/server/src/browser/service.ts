import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CdpConnection, CdpError } from "./cdp.js";
import { findBrowsers, type FindAllResult, type FindResult, type FoundBrowser } from "./find.js";
import { launchBrowser, type BrowserProcess, type LaunchOptions } from "./launch.js";
import { bodyText } from "./commit.js";
import { isRestrictedAssistantHost, isRestrictedAssistantOrigin, isRestrictedAssistantUrl, originOf } from "./sites.js";
import {
  DownloadDesk,
  DownloadError,
  checkDownloadFolder,
  checkUploadFiles,
  listUploadDirectory,
  MAX_DOWNLOAD_BYTES,
  MAX_STAGED_BYTES,
  ASK_MS,
  pickNativeFiles,
  pickNativeFolder,
  riskWarning,
  sanitizeFileName,
  type DownloadInfo,
  type NativeFilePickResult,
  type NativeFolderPickResult,
  type UploadDirectoryListing,
  type UploadInfo,
} from "./downloads.js";
import { buildSnapshot, passwordInputNames, visibleBackendIds, type AxNode, type DomSnapshotLike } from "./snapshot.js";

/**
 * The browser the server owns: a Chromium-family browser started lazily, headless, driven over a private CDP pipe.
 * Two contexts keep the user's world apart from the assistant's: `you` is the browser's persistent default context
 * (where sign-ins will live), `assistant` is an ephemeral one made with Target.createBrowserContext; cookies never cross.
 * The pane (B2) and the browsing agent (B3) plug into this class; it has no HTTP, no UI and no model in it.
 */

export type BrowserContextName = "you" | "assistant";
export type BrowserErrorCode = "unavailable" | "scheme" | "limit" | "no-tab" | "stale-ref" | "invalid" | "closed" | "blocked";

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export interface TabInfo {
  id: string;
  context: BrowserContextName;
  url: string;
  title: string;
  loading: boolean;
  active: boolean;
  openerId?: string;
}

export interface DialogInfo {
  tabId: string;
  kind: string;
  message: string;
  defaultPrompt?: string;
  url: string;
}

export type BrowserEvent =
  | { type: "tab"; tab: TabInfo }
  | { type: "tab-closed"; id: string }
  | { type: "active"; id: string }
  | { type: "dialog"; dialog: DialogInfo }
  | { type: "dialog-closed"; tabId: string }
  | { type: "notice"; kind: "download" | "file" | "popup"; tabId?: string; text: string }
  | { type: "download"; download: DownloadInfo }
  | { type: "download-closed"; id: string; tabId: string | null }
  | { type: "upload"; upload: UploadInfo }
  | { type: "upload-closed"; id: string; tabId: string }
  | { type: "stopped" };

/** One download, from the browser's first word of it to the person's answer. */
interface Flight {
  guid: string;
  context: BrowserContextName;
  tabId: string | null;
  name: string;
  url: string;
  origin: string;
  page: string;
  size: number | null;
  finishing: boolean;
  /** Set while the person's own pane is being asked. */
  ask: { info: DownloadInfo; resolve: (folder: string | null) => void; timer: NodeJS.Timeout } | null;
}

/** One intercepted `<input type="file">` chooser waiting for the person's own pane to supply file path(s). */
interface PendingUpload {
  id: string;
  tabId: string;
  info: UploadInfo;
  resolve: (files: string[] | null) => void;
  timer: NodeJS.Timeout;
}

/** What the assistant's download question needs: the file, the page and the site it came from, and where it would go by default. */
export type DownloadRequest = Omit<DownloadInfo, "id" | "tabId">;

/** What the assistant's file-upload question needs: whether multiple files are accepted, the site/page, and the initial folder. */
export type UploadRequest = Omit<UploadInfo, "id" | "tabId">;

export interface BrowserStatus {
  available: boolean;
  browser: { kind: string; path: string; version: string | null } | null;
  reason?: string;
  running: boolean;
  tabs: number;
}

export interface ScreencastFrame {
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  /** Milliseconds since the epoch on the server, not the browser's clock. */
  at: number;
}

/** A `<select>` found under a point: what a pane needs to draw its own dropdown (the screencast never shows the native one). */
export interface SelectProbe {
  /** The select's box in page (CSS) pixels. */
  rect: { x: number; y: number; width: number; height: number };
  options: Array<{ index: number; label: string; disabled: boolean; selected: boolean }>;
  multiple: boolean;
}

export interface MouseInput {
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

export interface KeyInput {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key?: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
  /** Editing commands the browser runs for this key (CDP needs them for select all, undo and the like). */
  commands?: string[];
}

export interface BrowserServiceOptions {
  /** Where `browser/profile` lives. Missing or ":memory:" gives a throwaway folder under the system temp dir. */
  dataDir?: string;
  log?: (line: string) => void;
  idleMs?: number;
  maxTabs?: number;
  find?: () => FindResult;
  findAll?: () => FindAllResult;
  launch?: (options: LaunchOptions) => BrowserProcess;
  /** Extra attempts for each candidate browser when startup exits immediately (defaults to 1 for real launches, 0 for injected `launch`). */
  startupRetries?: number;
  /** How long a graceful Browser.close may take before the process tree is killed. */
  gracefulMs?: number;
  /** Version lookup for a browser that is not running (the real one reads the install folder or asks `--version`). */
  versionOf?: (browser: FoundBrowser) => Promise<string | null>;
  /**
   * Asked before the assistant's browser loads a page: a page it was sent to, a redirect, a link it followed, or a frame inside
   * a page. A main-frame request waits for the answer (it may take as long as a person does); `false` fails it as blocked.
   * The person's own tabs are never asked about. Absent: the assistant's context is not gated.
   */
  siteGate?: (request: { url: string; origin: string; tabId: string; mainFrame: boolean }) => Promise<boolean>;
  /**
   * Asked before the assistant's browser sends a form: a page request that is not a plain GET (a POST from a form, in the main
   * page or in a frame), held in the browser until this answers. `false` aborts it and the page stays as it was. Absent while
   * `siteGate` is set: nothing but a GET leaves the assistant's browser.
   */
  commitGate?: (request: CommitRequest) => Promise<boolean>;
  /**
   * Asked when a download of the assistant's browser has finished (it is staged, not saved): resolves the folder the PERSON chose
   * for it, or null for "don't save". Absent: the assistant's downloads are deleted.
   */
  downloadGate?: (request: DownloadRequest) => Promise<string | null>;
  /**
   * Asked after `siteGate` allows a request: when true, cookies for that exact `origin` from the persistent `you` profile are
   * copied into the assistant's browser context before the request is sent. Unapproved origins never receive cookies.
   */
  signInGate?: (request: { url: string; origin: string; tabId: string; mainFrame: boolean }) => boolean | Promise<boolean>;
  /**
   * Asked when a page in the assistant's browser opens a file chooser (`<input type="file">`): resolves the local file path(s)
   * chosen by the PERSON, or null when cancelled. Absent: file uploads in the assistant's browser are cancelled.
   */
  uploadGate?: (request: UploadRequest) => Promise<string[] | null>;
  /** Native OS folder picker override (for tests or embedded hosts). */
  pickFolder?: (initialFolder?: string) => Promise<NativeFolderPickResult>;
  /** Native OS file picker override (for tests or embedded hosts). */
  pickFiles?: (initialFolder?: string, multiple?: boolean) => Promise<NativeFilePickResult>;
  /** How long the person's own pane may take to answer a download question (default 10 minutes). */
  downloadAskMs?: number;
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
  hostOnly?: boolean;
}

/**
 * RFC 6265 origin check for selective cookie sharing: true only when `cookie` would legitimately be sent to `origin`
 * (matching domain/host-only scope, HTTPS requirement for Secure cookies, and not expired).
 */
export function cookieMatchesOrigin(cookie: CdpCookie, origin: string, nowSec = Date.now() / 1000): boolean {
  if (!cookie.name || typeof cookie.value !== "string") return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const rawDomain = String(cookie.domain ?? "").trim().toLowerCase();
  const bareDomain = rawDomain.replace(/^\.+/, "");
  if (!bareDomain) return false;
  const host = u.hostname.toLowerCase();
  const isDomainCookie = rawDomain.startsWith(".") || cookie.hostOnly === false;
  const domainMatch = isDomainCookie ? host === bareDomain || host.endsWith(`.${bareDomain}`) : host === bareDomain;
  if (!domainMatch) return false;
  if (cookie.secure && u.protocol !== "https:") return false;
  if (!cookie.session && typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires < nowSec) return false;
  return true;
}

function toCookieParam(cookie: CdpCookie, origin: string): Record<string, unknown> {
  const rawDomain = String(cookie.domain ?? "").trim();
  const bareDomain = rawDomain.replace(/^\.+/, "");
  const isDomainCookie = rawDomain.startsWith(".") || cookie.hostOnly === false;
  const path = cookie.path || "/";
  const u = new URL(origin);
  const scheme = cookie.secure ? "https:" : u.protocol;
  return {
    name: cookie.name,
    value: cookie.value,
    path,
    ...(isDomainCookie ? { domain: rawDomain.startsWith(".") ? rawDomain : `.${bareDomain}` } : { url: `${scheme}//${bareDomain}${path.startsWith("/") ? path : `/${path}`}` }),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    ...(typeof cookie.sameSite === "string" && cookie.sameSite !== "" ? { sameSite: cookie.sameSite } : {}),
    ...(!cookie.session && typeof cookie.expires === "number" && cookie.expires > 0 ? { expires: cookie.expires } : {}),
  };
}

/** A form the assistant's page is about to send. */
export interface CommitRequest {
  url: string;
  method: string;
  /** The title of the page the form is on. */
  title: string;
  contentType: string;
  /** What is sent, when the browser lets it be read. */
  body: string | undefined;
  /**
   * Names of the password inputs of the page the form is on: a request carries no input types, so the page says which fields are
   * secret. Null when the page did not say (nothing could read it, it was never looked at, it has changed, or the form is in a
   * frame): the form is then shown with every value hidden.
   */
  secrets: string[] | null;
}

/** What the page says about an element, read for deciding whether acting on it commits something. Everything in it is page-controlled. */
export interface ElementFacts {
  tag: string;
  type: string;
  name: string;
  autocomplete: string;
  role: string;
  /** Its own text (aria-label, value or text). */
  label: string;
  form: { action: string; method: string; defaultButton: string; fields: Array<{ name: string; type: string; value: string }> } | null;
}

export interface CanvasDiagnostic {
  label: string;
  cssWidth: number;
  cssHeight: number;
  bufferWidth: number;
  bufferHeight: number;
  dpiMismatch: boolean;
  zeroSize: boolean;
}

export interface PageDiagnostics {
  url: string;
  title: string;
  viewport: { width: number; height: number; dpr: number };
  fps: { fps: number; frames: number; avgFrameMs: number; maxFrameMs: number; droppedFrames: number };
  canvases: CanvasDiagnostic[];
  animations: { total: number; running: number; paused: number; layoutThrashingProps: string[] };
  svgCount: number;
  videoCount: number;
  brokenImages: number;
  errorOverlay: string | null;
  consoleErrors: string[];
}

export function formatPageDiagnostics(diag: PageDiagnostics): string {
  const lines: string[] = [
    `Page: ${diag.title || "(untitled)"} (${diag.url})`,
    `Viewport: ${diag.viewport.width}x${diag.viewport.height} @ ${diag.viewport.dpr}x DPR`,
    `Frame pacing: ${diag.fps.fps} fps (${diag.fps.frames} frames sampled, avg ${diag.fps.avgFrameMs} ms, max ${diag.fps.maxFrameMs} ms, ${diag.fps.droppedFrames} slow >24 ms frames)`,
  ];
  if (diag.canvases.length > 0) {
    const summary = diag.canvases
      .map((c) => {
        const flags: string[] = [];
        if (c.zeroSize) flags.push("ZERO-SIZE");
        else if (c.dpiMismatch) flags.push("DPI-MISMATCH (blurry/unscaled buffer)");
        return `${c.label}: CSS ${c.cssWidth}x${c.cssHeight}, buffer ${c.bufferWidth}x${c.bufferHeight}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
      })
      .join("; ");
    lines.push(`Canvas (${diag.canvases.length}): ${summary}`);
  }
  lines.push(
    `DOM/CSS animations: ${diag.animations.running} running, ${diag.animations.paused} paused (total ${diag.animations.total})${
      diag.animations.layoutThrashingProps.length > 0
        ? ` — non-composited/heavy properties animated: ${diag.animations.layoutThrashingProps.join(", ")}`
        : ""
    }`,
  );
  if (diag.svgCount > 0 || diag.videoCount > 0 || diag.brokenImages > 0) {
    lines.push(`Media: ${diag.svgCount} SVG, ${diag.videoCount} video, ${diag.brokenImages} broken image(s)`);
  }
  if (diag.errorOverlay) {
    lines.push(`Dev error overlay: ${diag.errorOverlay}`);
  }
  if (diag.consoleErrors.length > 0) {
    lines.push(`Console/JS issues (${diag.consoleErrors.length}): ${diag.consoleErrors.slice(0, 6).join(" | ")}`);
  } else {
    lines.push("Console/JS issues: none captured.");
  }
  return lines.join("\n");
}

const DIAGNOSE_PAGE_EXPR = `(function(){
  return new Promise(function(resolve){
    var dpr = Number(window.devicePixelRatio || 1);
    var vw = Number(window.innerWidth || 0);
    var vh = Number(window.innerHeight || 0);
    var canvases = [];
    var cNodes = document.querySelectorAll('canvas');
    for (var i = 0; i < cNodes.length && canvases.length < 10; i++) {
      var c = cNodes[i];
      var r = c.getBoundingClientRect();
      var cw = Math.round(r.width);
      var ch = Math.round(r.height);
      var bw = Number(c.width || 0);
      var bh = Number(c.height || 0);
      var zero = cw === 0 || ch === 0 || bw === 0 || bh === 0;
      var mismatch = !zero && (Math.abs(bw - Math.round(cw * dpr)) > 2 || Math.abs(bh - Math.round(ch * dpr)) > 2);
      var label = c.id ? '#' + c.id : (c.className && typeof c.className === 'string' ? '.' + c.className.trim().split(/\\s+/)[0] : 'canvas[' + i + ']');
      canvases.push({ label: String(label).slice(0, 40), cssWidth: cw, cssHeight: ch, bufferWidth: bw, bufferHeight: bh, dpiMismatch: mismatch, zeroSize: zero });
    }
    var animTotal = 0, animRunning = 0, animPaused = 0;
    var heavySet = {};
    var heavyNames = { top:1, left:1, right:1, bottom:1, width:1, height:1, margin:1, marginTop:1, marginLeft:1, padding:1, borderWidth:1, boxShadow:1, filter:1, backdropFilter:1 };
    try {
      var anims = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
      animTotal = anims.length;
      for (var a = 0; a < anims.length; a++) {
        var st = anims[a].playState;
        if (st === 'running') animRunning++;
        else if (st === 'paused') animPaused++;
        var kf = anims[a].effect && typeof anims[a].effect.getKeyframes === 'function' ? anims[a].effect.getKeyframes() : [];
        for (var k = 0; k < kf.length; k++) {
          var keys = Object.keys(kf[k]);
          for (var p = 0; p < keys.length; p++) {
            if (heavyNames[keys[p]]) heavySet[keys[p]] = true;
          }
        }
      }
    } catch (e) {}
    var brokenImages = 0;
    var imgs = document.querySelectorAll('img');
    for (var m = 0; m < imgs.length; m++) {
      if (imgs[m].complete && imgs[m].naturalWidth === 0 && imgs[m].getAttribute('src')) brokenImages++;
    }
    var overlay = null;
    try {
      var vErr = document.querySelector('vite-error-overlay');
      if (vErr) overlay = String((vErr.shadowRoot ? vErr.shadowRoot.textContent : vErr.textContent) || 'Vite error overlay').replace(/\\s+/g, ' ').trim().slice(0, 260);
      if (!overlay) {
        var wErr = document.querySelector('#webpack-dev-server-client-overlay,[data-nextjs-dialog]');
        if (wErr) overlay = String(wErr.textContent || 'Build error overlay').replace(/\\s+/g, ' ').trim().slice(0, 260);
      }
    } catch (e) {}
    var times = [];
    var done = false;
    var start = performance.now();
    function finish() {
      if (done) return;
      done = true;
      var deltas = [];
      for (var t = 1; t < times.length; t++) deltas.push(times[t] - times[t - 1]);
      var elapsed = times.length >= 2 ? (times[times.length - 1] - times[0]) : Math.max(1, performance.now() - start);
      var frames = Math.max(0, times.length - 1);
      var fps = frames > 0 ? Math.round((frames * 1000) / Math.max(1, elapsed)) : 0;
      var sum = 0, maxMs = 0, dropped = 0;
      for (var d = 0; d < deltas.length; d++) {
        sum += deltas[d];
        if (deltas[d] > maxMs) maxMs = deltas[d];
        if (deltas[d] > 24) dropped++;
      }
      var avgMs = deltas.length > 0 ? Math.round((sum / deltas.length) * 10) / 10 : 0;
      resolve({
        viewport: { width: vw, height: vh, dpr: Math.round(dpr * 100) / 100 },
        fps: { fps: fps, frames: frames, avgFrameMs: avgMs, maxFrameMs: Math.round(maxMs * 10) / 10, droppedFrames: dropped },
        canvases: canvases,
        animations: { total: animTotal, running: animRunning, paused: animPaused, layoutThrashingProps: Object.keys(heavySet) },
        svgCount: document.querySelectorAll('svg').length,
        videoCount: document.querySelectorAll('video').length,
        brokenImages: brokenImages,
        errorOverlay: overlay
      });
    }
    var fallback = setTimeout(finish, 600);
    if (typeof requestAnimationFrame !== 'function') {
      clearTimeout(fallback);
      finish();
      return;
    }
    function step(ts) {
      if (done) return;
      times.push(ts);
      if (ts - (times[0] || ts) >= 420 || times.length >= 40) {
        clearTimeout(fallback);
        finish();
        return;
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
})()`;

/** Runs in the page, on an element (null: nothing is focused). Reads only; try/catch because a page can shadow what it reads. */
const FACTS_FN = `function(el){
  try {
    if (!el || el.nodeType !== 1) return null;
    var text = function(n){ return String((n && (n.getAttribute('aria-label') || n.value || n.innerText || n.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 200); };
    var form = el.form || (el.closest ? el.closest('form') : null);
    var facts = { tag: el.tagName.toLowerCase(), type: String(el.getAttribute('type') || '').toLowerCase(), name: String(el.getAttribute('name') || ''), autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase(), role: String(el.getAttribute('role') || ''), label: text(el), form: null };
    if (form) {
      var def = form.querySelector('button[type=submit],input[type=submit],button:not([type])');
      var fields = [];
      var els = form.elements;
      for (var i = 0; i < els.length && fields.length < 40; i++) {
        var f = els[i];
        var t = String(f.type || '').toLowerCase();
        var n = String(f.name || f.id || '');
        if (!n || t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || f.disabled) continue;
        if ((t === 'checkbox' || t === 'radio') && !f.checked) continue;
        if (t === 'file') { fields.push({ name: n, type: t, value: (f.files && f.files[0]) ? f.files[0].name : '' }); continue; }
        fields.push({ name: n, type: t, value: String(f.value == null ? '' : f.value).slice(0, 400) });
      }
      facts.form = { action: String(form.action || ''), method: String(form.method || 'get').toLowerCase(), defaultButton: def ? text(def) : '', fields: fields };
    }
    return facts;
  } catch (e) { return null; }
}`;

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SIZE = { width: 1280, height: 800 };
const SETTLE_MS = 150;
/** How long the look at a page's password inputs before an action may take (a page that does not answer leaves them unknown). */
const LOOK_MS = 8000;
const NAVIGATION_WAIT_MS = 15_000;
/** How long `Page.navigate` may wait in the assistant's browser, where a question to the person can hold it. */
const GATED_NAVIGATION_MS = 15 * 60_000;
const DENIED_PERMISSIONS = [
  "geolocation", "notifications", "audioCapture", "videoCapture", "midi", "midiSysex", "clipboardReadWrite",
  "clipboardSanitizedWrite", "sensors", "idleDetection", "backgroundSync", "paymentHandler", "displayCapture", "wakeLockScreen",
];

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Space: { code: "Space", vk: 32, text: " " },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
};

/** Only these may be navigated to. Everything else (file:, chrome:, edge:, devtools:, view-source:, javascript:, data:, ...) is refused. */
export function checkUrl(raw: string): string {
  const text = String(raw ?? "").trim();
  if (text === "about:blank") return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BrowserError("invalid", `"${text.slice(0, 80)}" is not a full web address (it needs http:// or https://).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserError("scheme", `Only http:, https: and about:blank pages can be opened; ${url.protocol} is refused.`);
  }
  return url.href;
}

interface Tab {
  id: string;
  sessionId: string;
  context: BrowserContextName;
  url: string;
  title: string;
  loading: boolean;
  openerId?: string;
  refs: Map<string, number>;
  refInfo: Map<string, { role: string; name: string }>;
  /**
   * Names of the password inputs of this page as last read (the page is not asked while a form is held: it may not answer), or
   * null while it has not been read, the read failed, or a new page replaced the one that was read: nothing is then known about them.
   */
  secretNames: string[] | null;
  dialog: DialogInfo | null;
  loadWaiters: Array<() => void>;
  screencast: ScreencastState | null;
  axEnabled: boolean;
  /** What the page did that the assistant should hear about (a site that was refused, a popup that was closed); read once by `takeNotes`. */
  notes: string[];
  /** A page of this tab was refused by the gate since its last navigation began: an aborted load is then a refusal, not a broken page. */
  blocked: boolean;
  /** Set while an intercepted file chooser is waiting on the person or applying `DOM.setFileInputFiles`. */
  uploading: Promise<void> | null;
  /** Recent console errors/warnings and uncaught JS exceptions on the current document, bounded to 16 entries. */
  consoleErrors: string[];
}

interface ScreencastState {
  onFrame: (frame: ScreencastFrame) => void | Promise<void>;
  minGapMs: number;
  lastSent: number;
  pending: { frame: ScreencastFrame; ack: () => void } | null;
  timer: NodeJS.Timeout | null;
}

interface Runtime {
  proc: BrowserProcess;
  conn: CdpConnection;
  version: string;
  browser: FoundBrowser;
  tabs: Map<string, Tab>;
  bySession: Map<string, Tab>;
  assistantContextId: string | null;
  sharedOrigins: Set<string>;
  activeId: string | null;
  stopping: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `promise`, or nothing after `ms`; the timer is cleared so it never holds the process open. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withinValue<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class StartupExitedError extends Error {
  constructor(readonly code: number | null) {
    super("exited");
  }
}

function compactStderr(raw: string | undefined): string {
  if (!raw) return "";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `…${flat.slice(-240)}` : flat;
}

const SANDBOX_HINT =
  "Ancilla never turns the browser's sandbox off; if it cannot start sandboxed here (running as root, or in a container without user namespaces) it has to run as a normal user, or ANCILLA_BROWSER can name a browser that can.";

function startupFailureMessage(kind: string, code: number | null | undefined, stderr: string, cause?: string): string {
  if (code !== undefined) {
    return `${kind} exited while starting (code ${code ?? "none"})${stderr ? `: ${stderr}` : ""}. ${SANDBOX_HINT}`;
  }
  return `${kind} did not answer while starting${cause ? ` (${cause})` : ""}${stderr ? `: ${stderr}` : ""}. ${SANDBOX_HINT}`;
}

export interface ProfileHygieneOptions {
  platform?: NodeJS.Platform;
  host?: string;
  isAlive?: (pid: number) => boolean;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * Cleans stale pre-launch artifacts in a browser profile directory without touching established user state:
 * - On POSIX, removes `SingletonLock` / `SingletonCookie` / `SingletonSocket` when `SingletonLock` points at a dead PID on this host.
 * - Removes an orphaned `Crashpad`-only stub left behind when a previous launch exited before creating `Default` or `Local State`.
 */
export function prepareProfileDir(dir: string, options: ProfileHygieneOptions = {}): void {
  mkdirSync(dir, { recursive: true });
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      const target = readlinkSync(join(dir, "SingletonLock"));
      const dash = target.lastIndexOf("-");
      if (dash > 0) {
        const lockHost = target.slice(0, dash);
        const pid = Number(target.slice(dash + 1));
        const currentHost = options.host ?? hostname();
        const isAlive = options.isAlive ?? defaultProcessAlive;
        if (lockHost === currentHost && Number.isInteger(pid) && pid > 0 && !isAlive(pid)) {
          for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
            rmSync(join(dir, name), { force: true });
          }
        }
      }
    } catch {
      // no symlink lock or unreadable
    }
  }
  try {
    const entries = readdirSync(dir);
    if (!entries.includes("Default") && !entries.includes("Local State") && entries.includes("Crashpad")) {
      rmSync(join(dir, "Crashpad"), { recursive: true, force: true });
    }
  } catch {
    // best-effort cleanup
  }
}

const defaultVersionOf = (browser: FoundBrowser): Promise<string | null> => {
  if (process.platform === "win32") {
    // The install keeps a folder named for its version next to the exe: no process needs to run to read it.
    try {
      const name = readdirSync(dirname(browser.path)).find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry));
      return Promise.resolve(name ?? null);
    } catch {
      return Promise.resolve(null);
    }
  }
  return new Promise((resolve) => {
    execFile(browser.path, ["--version"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : (/(\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null));
    });
  });
};

export class BrowserService {
  private runtime: Runtime | null = null;
  private starting: Promise<Runtime> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private readonly profileDir: string;
  private workingBrowser: FoundBrowser | null = null;
  private versionCache: { path: string; version: string | null } | null = null;
  private readonly options: BrowserServiceOptions;
  readonly downloads: DownloadDesk;
  /** Downloads in flight or waiting for an answer, by the browser's guid. */
  private readonly flights = new Map<string, Flight>();
  /** File upload choosers waiting for an answer in the person's own pane, by chooser id. */
  private readonly uploads = new Map<string, PendingUpload>();

  constructor(options: BrowserServiceOptions = {}) {
    this.options = options;
    const base = options.dataDir && options.dataDir !== ":memory:" ? options.dataDir : mkdtempSync(join(tmpdir(), "ancilla-browser-"));
    this.profileDir = join(base, "browser", "profile");
    this.downloads = new DownloadDesk(join(base, "browser", "downloads"), join(base, "browser", "download-folder.json"));
  }

  // ---------------------------------------------------------------- status and events

  profilePath(): string {
    return this.profileDir;
  }

  private discoverBrowsers(): FindAllResult {
    if (this.options.findAll) return this.options.findAll();
    if (this.options.find) {
      const one = this.options.find();
      return one.browser ? { browsers: [one.browser] } : { browsers: [], ...(one.reason !== undefined ? { reason: one.reason } : {}) };
    }
    return findBrowsers();
  }

  on(listener: (event: BrowserEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: BrowserEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a listener's fault is its own
      }
    }
  }

  async status(): Promise<BrowserStatus> {
    const found = this.discoverBrowsers();
    if (found.browsers.length === 0) {
      return { available: false, browser: null, reason: found.reason ?? "No browser was found.", running: false, tabs: 0 };
    }
    const running = this.runtime;
    const chosen =
      running?.browser ??
      (this.workingBrowser && found.browsers.some((b) => b.path === this.workingBrowser!.path) ? this.workingBrowser : found.browsers[0]!);
    let version = running && running.browser.path === chosen.path ? running.version : null;
    if (version === null) {
      if (this.versionCache?.path !== chosen.path) {
        this.versionCache = { path: chosen.path, version: await (this.options.versionOf ?? defaultVersionOf)(chosen) };
      }
      version = this.versionCache.version;
    }
    return {
      available: true,
      browser: { kind: chosen.kind, path: chosen.path, version },
      running: running !== null,
      tabs: running ? running.tabs.size : 0,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const rt = this.runtime;
      if (!rt) return;
      // Someone watching (a screencast) or a dialog/upload waiting keeps it open; the next idle period asks again.
      if (this.uploads.size > 0 || [...rt.tabs.values()].some((t) => t.screencast || t.dialog || t.uploading)) {
        this.touch();
        return;
      }
      this.options.log?.("browser: stopped after being idle");
      void this.stop();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  /** Starts the browser if it is not running (the first tab of `you` is the blank page it opens with). */
  async open(): Promise<void> {
    await this.ensure();
  }

  private async ensure(): Promise<Runtime> {
    if (this.disposed) throw new BrowserError("closed", "The browser service has been shut down.");
    this.touch();
    if (this.runtime) return this.runtime;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private profileDirFor(browser: FoundBrowser, primaryKind: FoundBrowser["kind"]): string {
    return browser.kind === primaryKind ? this.profileDir : join(dirname(this.profileDir), `profile-${browser.kind}`);
  }

  private async start(): Promise<Runtime> {
    const found = this.discoverBrowsers();
    if (found.browsers.length === 0) throw new BrowserError("unavailable", found.reason ?? "No browser was found.");
    const primaryKind = found.browsers[0]!.kind;
    mkdirSync(this.profileDir, { recursive: true });

    const candidates = [...found.browsers];
    if (this.workingBrowser) {
      const idx = candidates.findIndex((b) => b.path === this.workingBrowser!.path);
      if (idx > 0) {
        const [preferred] = candidates.splice(idx, 1);
        candidates.unshift(preferred!);
      }
    }

    const retries = Math.max(0, this.options.startupRetries ?? (this.options.launch ? 0 : 1));
    const failures: Array<{ browser: FoundBrowser; error: unknown }> = [];

    for (const browser of candidates) {
      if (this.disposed) throw new BrowserError("closed", "The browser service has been shut down.");
      const profileDir = this.profileDirFor(browser, primaryKind);
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (this.disposed) throw new BrowserError("closed", "The browser service has been shut down.");
        if (attempt > 0) await sleep(150);
        try {
          const rt = await this.startOne(browser, profileDir);
          this.workingBrowser = browser;
          this.runtime = rt;
          if (failures.length > 0) {
            this.options.log?.(`browser: started ${browser.kind} ${rt.version} after ${failures.map((f) => f.browser.kind).join(", ")} failed`);
          } else {
            this.options.log?.(`browser: started ${browser.kind} ${rt.version}`);
          }
          return rt;
        } catch (error) {
          if (this.disposed || (error instanceof BrowserError && error.code === "closed")) throw error;
          const msg = error instanceof Error ? error.message : String(error);
          this.options.log?.(`browser: failed to start ${browser.kind} (${browser.path}, attempt ${attempt + 1}/${retries + 1}): ${msg}`);
          if (attempt === retries) failures.push({ browser, error });
        }
      }
    }

    const last = failures.at(-1)?.error;
    if (failures.length <= 1) {
      throw last instanceof Error ? last : new BrowserError("unavailable", String(last ?? "The browser could not start."));
    }
    const tried = failures.map(({ browser, error }) => `${browser.kind} (${error instanceof Error ? error.message.split(".")[0] : String(error)})`).join("; ");
    throw new BrowserError("unavailable", `Could not start any installed browser (${tried}). ${SANDBOX_HINT}`);
  }

  private async startOne(browser: FoundBrowser, profileDir: string): Promise<Runtime> {
    prepareProfileDir(profileDir);
    const launch = this.options.launch ?? launchBrowser;
    const proc = launch({ path: browser.path, profileDir });
    const conn = new CdpConnection(proc.toBrowser, proc.fromBrowser);
    const tabs = new Map<string, Tab>();
    const rt: Runtime = {
      proc,
      conn,
      version: "",
      browser,
      tabs,
      bySession: new Map(),
      assistantContextId: null,
      sharedOrigins: new Set(),
      activeId: null,
      stopping: false,
    };

    const died = proc.exited.then((code): never => {
      throw new StartupExitedError(code);
    });
    died.catch(() => undefined);

    try {
      await Promise.race([
        (async () => {
          const info = await conn.send("Browser.getVersion", {}, undefined, 20_000);
          rt.version = String(info.product ?? "").replace(/^[^/]*\//, "") || "unknown";
          conn.onEvent((method, params, sessionId) => this.onCdp(rt, method, params, sessionId));
          await conn.send("Target.setDiscoverTargets", { discover: true });
          this.downloads.reset();
          this.flights.clear();
          await conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloads.dir, eventsEnabled: true }).catch(() => undefined);
          await this.denyPermissions(rt, undefined);
          // The blank page the browser opens with becomes the first tab of `you`.
          const targets = await conn.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>("Target.getTargets");
          for (const target of targets.targetInfos.filter((t) => t.type === "page")) await this.adopt(rt, target.targetId, "you", undefined, target);
        })(),
        died,
      ]);
      if (proc.hasExited()) throw new StartupExitedError(await proc.exited);
      const teardown = () => this.teardown(rt);
      conn.onClose(teardown);
      void proc.exited.then(teardown);
      return rt;
    } catch (error) {
      rt.stopping = true;
      conn.close();
      for (const tab of rt.tabs.values()) this.endScreencast(tab);
      rt.tabs.clear();
      rt.bySession.clear();
      let exited: { done: true; code: number | null } | { done: false };
      if (error instanceof StartupExitedError) {
        exited = { done: true, code: error.code };
      } else if (proc.hasExited()) {
        exited = { done: true, code: await proc.exited };
      } else {
        exited = await withinValue(
          proc.exited.then((code) => ({ done: true as const, code })),
          400,
          { done: false as const },
        );
      }
      await proc.killTree().catch(() => undefined);
      const stderr = compactStderr(proc.recentStderr?.());
      if (exited.done) {
        throw new BrowserError("unavailable", startupFailureMessage(browser.kind, exited.code, stderr));
      }
      if (error instanceof BrowserError) throw error;
      throw new BrowserError(
        "unavailable",
        startupFailureMessage(browser.kind, undefined, stderr, error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async denyPermissions(rt: Runtime, browserContextId: string | undefined): Promise<void> {
    await Promise.all(
      DENIED_PERMISSIONS.map((name) =>
        rt.conn
          .send("Browser.setPermission", { permission: { name }, setting: "denied", ...(browserContextId ? { browserContextId } : {}) })
          .catch(() => undefined),
      ),
    );
  }

  /** Called once when the browser is gone, however it went. */
  // ---------------------------------------------------------------- downloads

  private downloadBegan(rt: Runtime, params: Record<string, any>): void {
    const guid = String(params["guid"] ?? "");
    try {
      this.downloads.stagedPath(guid);
    } catch {
      return;
    }
    const tab = rt.tabs.get(String(params["frameId"] ?? ""));
    const url = String(params["url"] ?? "");
    let fallback = "";
    try {
      fallback = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    } catch {
      // no usable name in the address
    }
    const name = sanitizeFileName(String(params["suggestedFilename"] || fallback));
    // A frame we do not know (a frame inside a page) counts as the person's own tab: the question goes to the pane, never to a task.
    const flight: Flight = { guid, context: tab?.context ?? "you", tabId: tab?.id ?? null, name, url, origin: originOf(tab?.url ?? "") ?? originOf(url) ?? "", page: tab?.title ?? "", size: null, finishing: false, ask: null };
    this.flights.set(guid, flight);
    if (this.downloads.stagedBytes() >= MAX_STAGED_BYTES) this.cancelDownload(rt, flight, `${name} was not downloaded: too many downloads are waiting for an answer.`);
  }

  private downloadProgress(rt: Runtime, params: Record<string, any>): void {
    const flight = this.flights.get(String(params["guid"] ?? ""));
    if (!flight || flight.ask) return;
    const total = Number(params["totalBytes"]);
    const received = Number(params["receivedBytes"]);
    if (total > 0) flight.size = total;
    if (total > MAX_DOWNLOAD_BYTES || received > MAX_DOWNLOAD_BYTES) {
      this.cancelDownload(rt, flight, `${flight.name} was not downloaded: it is bigger than ${MAX_DOWNLOAD_BYTES / 1024 ** 3} GB.`);
      return;
    }
    if (params["state"] === "canceled") {
      this.flights.delete(flight.guid);
      this.downloads.discard(flight.guid);
    } else if (params["state"] === "completed" && !flight.finishing) {
      flight.finishing = true;
      if (flight.size === null && received > 0) flight.size = received;
      void this.finishDownload(flight);
    }
  }

  private cancelDownload(rt: Runtime, flight: Flight, why: string): void {
    this.flights.delete(flight.guid);
    void rt.conn.send("Browser.cancelDownload", { guid: flight.guid }).catch(() => undefined);
    setTimeout(() => this.downloads.discard(flight.guid), 200).unref?.();
    this.emit({ type: "notice", kind: "download", ...(flight.tabId ? { tabId: flight.tabId } : {}), text: why });
  }

  /** The file is complete and staged: auto-save if the user remembered a preferred folder on their own tab, else ask where to put it. */
  private async finishDownload(flight: Flight): Promise<void> {
    const request: DownloadRequest = { name: flight.name, size: flight.size, origin: flight.origin, page: flight.page, folder: this.downloads.defaultFolder(), warning: riskWarning(flight.name) };
    let folder: string | null = null;
    try {
      if (flight.context === "you") {
        const autoFolder = this.downloads.shouldAutoSave(flight.name);
        if (autoFolder !== null) {
          const saved = this.downloads.save(flight.guid, flight.name, autoFolder);
          this.say(flight, `Saved ${flight.name} to ${dirname(saved)}.`);
          return;
        }
      }
      folder = flight.context === "assistant" ? (this.options.downloadGate ? await this.options.downloadGate(request) : null) : await this.askPane(flight, request);
      if (folder === null) {
        this.say(flight, `${flight.name} was not saved.`);
      } else {
        const saved = this.downloads.save(flight.guid, flight.name, folder);
        this.say(flight, `Saved ${flight.name} to ${dirname(saved)}.`);
      }
    } catch (error) {
      this.say(flight, error instanceof DownloadError ? error.message : `${flight.name} could not be saved.`);
    } finally {
      this.flights.delete(flight.guid);
      this.downloads.discard(flight.guid);
    }
  }

  private say(flight: Flight, text: string): void {
    this.emit({ type: "notice", kind: "download", ...(flight.tabId ? { tabId: flight.tabId } : {}), text });
  }

  private askPane(flight: Flight, request: DownloadRequest): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const prefs = this.downloads.preferences();
      const info: DownloadInfo = { ...request, id: flight.guid, tabId: flight.tabId, ...(prefs.rememberFolder ? { rememberFolder: true } : {}) };
      const done = (folder: string | null): void => {
        if (!flight.ask) return;
        clearTimeout(flight.ask.timer);
        flight.ask = null;
        this.emit({ type: "download-closed", id: flight.guid, tabId: flight.tabId });
        resolve(folder);
      };
      const timer = setTimeout(() => done(null), this.options.downloadAskMs ?? ASK_MS);
      timer.unref?.();
      flight.ask = { info, resolve: done, timer };
      this.emit({ type: "download", download: info });
    });
  }

  /** The pane's answer: a folder saves the file there, null deletes it. A folder that cannot be used throws and the question stays. */
  answerDownload(id: string, accept: boolean, folder?: string, rememberFolder?: boolean): void {
    const flight = this.flights.get(id);
    if (!flight?.ask) throw new BrowserError("invalid", "That download is not waiting any more.");
    if (!accept) return flight.ask.resolve(null);
    try {
      const chosen = checkDownloadFolder(folder ?? flight.ask.info.folder);
      if (typeof rememberFolder === "boolean") {
        this.downloads.setPreferences({ folder: chosen, rememberFolder });
      }
      flight.ask.resolve(chosen);
    } catch (error) {
      throw new BrowserError("invalid", error instanceof DownloadError ? error.message : "That folder cannot be used.");
    }
  }

  /** Opens a native OS folder picker for downloads on this host, or reports `{ supported: false }` when unavailable. */
  async pickDownloadFolder(initialFolder?: string): Promise<NativeFolderPickResult> {
    const start = initialFolder ?? this.downloads.defaultFolder();
    return this.options.pickFolder ? this.options.pickFolder(start) : pickNativeFolder(start);
  }

  /** Opens a native OS file picker for browser uploads on this host, or reports `{ supported: false }` when unavailable. */
  async pickUploadFiles(initialFolder?: string, multiple = false): Promise<NativeFilePickResult> {
    const start = initialFolder ?? this.downloads.defaultFolder();
    return this.options.pickFiles ? this.options.pickFiles(start, multiple) : pickNativeFiles(start, multiple);
  }

  /** Lists folders and regular readable files inside `folderInput` for the inline upload picker. */
  listUploadFolder(folderInput?: string): UploadDirectoryListing {
    return listUploadDirectory(folderInput ?? this.downloads.defaultFolder());
  }

  /** The questions the pane has not answered yet (a pane that connects late is told of them). */
  pendingDownloads(): DownloadInfo[] {
    return [...this.flights.values()].flatMap((f) => (f.ask ? [f.ask.info] : []));
  }

  /** File upload choosers the pane has not answered yet. */
  pendingUploads(): UploadInfo[] {
    return [...this.uploads.values()].map((u) => u.info);
  }

  private askPaneUpload(tabId: string, request: UploadRequest): Promise<string[] | null> {
    // Supersede any older open chooser on the same tab so two modal choosers never stack on one page.
    for (const [oldId, old] of [...this.uploads.entries()]) {
      if (old.tabId === tabId) {
        this.uploads.delete(oldId);
        old.resolve(null);
      }
    }
    return new Promise<string[] | null>((resolve) => {
      const id = `up_${randomBytes(6).toString("hex")}`;
      const info: UploadInfo = { ...request, id, tabId };
      const done = (files: string[] | null): void => {
        const entry = this.uploads.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.uploads.delete(id);
        this.emit({ type: "upload-closed", id, tabId });
        resolve(files);
      };
      const timer = setTimeout(() => done(null), this.options.downloadAskMs ?? ASK_MS);
      timer.unref?.();
      this.uploads.set(id, { id, tabId, info, resolve: done, timer });
      this.emit({ type: "upload", upload: info });
    });
  }

  /** The pane's answer to an open file chooser: validated file paths attach to the input; `accept: false` cancels cleanly. */
  answerUpload(id: string, accept: boolean, files?: string[]): void {
    const pending = this.uploads.get(id);
    if (!pending) throw new BrowserError("invalid", "That file chooser is not waiting any more.");
    if (!accept) {
      pending.resolve(null);
      return;
    }
    try {
      const checked = checkUploadFiles(files ?? [], pending.info.multiple);
      pending.resolve(checked);
    } catch (error) {
      throw new BrowserError("invalid", error instanceof DownloadError ? error.message : "Those files cannot be uploaded.");
    }
  }

  private async handleFileChooser(rt: Runtime, tab: Tab, backendNodeId: number, multiple: boolean): Promise<void> {
    const request: UploadRequest = {
      multiple,
      origin: originOf(tab.url) ?? "",
      page: tab.title ?? "",
      folder: this.downloads.defaultFolder(),
    };
    let files: string[] | null = null;
    try {
      files =
        tab.context === "assistant"
          ? this.options.uploadGate
            ? await this.options.uploadGate(request)
            : null
          : await this.askPaneUpload(tab.id, request);
      if (rt.conn.isClosed || rt.tabs.get(tab.id) !== tab) return;
      if (!files || files.length === 0) {
        if (tab.context === "assistant") {
          this.note(tab, "No file was chosen: the person cancelled the file upload.");
        } else {
          this.emit({ type: "notice", kind: "file", tabId: tab.id, text: "File upload cancelled." });
        }
        return;
      }
      const checked = checkUploadFiles(files, multiple);
      await rt.conn.send("DOM.setFileInputFiles", { files: checked, backendNodeId }, tab.sessionId);
      this.downloads.noteFolder(dirname(checked[0]!));
      const names = checked.map((f) => f.split(/[\\/]/).pop() ?? f).join(", ");
      if (tab.context === "assistant") {
        this.note(tab, `Attached ${names} to the file input.`);
      } else {
        this.emit({ type: "notice", kind: "file", tabId: tab.id, text: `Attached ${names}.` });
      }
    } catch (error) {
      const msg = error instanceof DownloadError ? error.message : "Could not attach the chosen file.";
      if (tab.context === "assistant") this.note(tab, msg);
      else this.emit({ type: "notice", kind: "file", tabId: tab.id, text: msg });
    }
  }

  private teardown(rt: Runtime): void {
    for (const pending of [...this.uploads.values()]) {
      clearTimeout(pending.timer);
      this.uploads.delete(pending.id);
      pending.resolve(null);
    }
    for (const flight of [...this.flights.values()]) {
      flight.ask?.resolve(null);
      this.flights.delete(flight.guid);
      this.downloads.discard(flight.guid);
    }
    if (this.runtime === rt) this.runtime = null;
    if (rt.stopping && rt.tabs.size === 0) return;
    for (const tab of rt.tabs.values()) this.endScreencast(tab);
    rt.tabs.clear();
    rt.bySession.clear();
    if (!rt.stopping) this.options.log?.("browser: the browser process ended");
    rt.stopping = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.emit({ type: "stopped" });
  }

  /** Closes the browser: gracefully first, then the whole process tree. Safe to call at any time. */
  async stop(): Promise<void> {
    const rt = this.runtime ?? (await this.starting?.catch(() => null)) ?? null;
    if (!rt) return;
    this.runtime = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    rt.stopping = true;
    const grace = this.options.gracefulMs ?? 2500;
    if (!rt.conn.isClosed) await within(rt.conn.send("Browser.close", {}, undefined, grace).catch(() => undefined), grace);
    await within(rt.proc.exited, grace);
    if (!rt.proc.hasExited()) await rt.proc.killTree().catch(() => undefined);
    rt.conn.close();
    this.teardown(rt);
  }

  /** The browser's process id while it runs (for tests and diagnostics). */
  processId(): number | null {
    return this.runtime?.proc.pid ?? null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  // ---------------------------------------------------------------- tabs

  private requireTab(rt: Runtime, id: string): Tab {
    const tab = rt.tabs.get(id);
    if (!tab) throw new BrowserError("no-tab", `There is no tab ${id}.`);
    return tab;
  }

  private info(rt: Runtime, tab: Tab): TabInfo {
    return {
      id: tab.id,
      context: tab.context,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      active: rt.activeId === tab.id,
      ...(tab.openerId ? { openerId: tab.openerId } : {}),
    };
  }

  private async adopt(
    rt: Runtime,
    targetId: string,
    context: BrowserContextName,
    openerId: string | undefined,
    target?: { url?: string; title?: string },
  ): Promise<Tab> {
    const attached = await rt.conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const tab: Tab = {
      id: targetId,
      sessionId: attached.sessionId,
      context,
      url: target?.url ?? "about:blank",
      title: target?.title ?? "",
      loading: false,
      ...(openerId ? { openerId } : {}),
      refs: new Map(),
      refInfo: new Map(),
      secretNames: null,
      dialog: null,
      loadWaiters: [],
      screencast: null,
      axEnabled: false,
      notes: [],
      blocked: false,
      uploading: null,
      consoleErrors: [],
    };
    rt.tabs.set(targetId, tab);
    rt.bySession.set(tab.sessionId, tab);
    await rt.conn.send("Page.enable", {}, tab.sessionId);
    await rt.conn.send("Runtime.enable", {}, tab.sessionId).catch(() => undefined);
    // A file chooser would open a native dialog on the headless browser process; intercepting routes it through the pane or task gate.
    await rt.conn.send("Page.setInterceptFileChooserDialog", { enabled: true }, tab.sessionId).catch(() => undefined);
    // The assistant's pages are asked about before they load: every document request (a page, a redirect, a frame) pauses until the gate answers.
    if (context === "assistant" && this.options.siteGate) {
      await rt.conn.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, tab.sessionId);
    }
    await this.setViewport(targetId, DEFAULT_SIZE.width, DEFAULT_SIZE.height, rt);
    if (!rt.activeId) rt.activeId = targetId;
    this.emit({ type: "tab", tab: this.info(rt, tab) });
    // A popup may have finished loading before it was attached, so no load event will bring its title: ask now and once more shortly.
    if (openerId) {
      void this.refreshInfo(rt, tab);
      setTimeout(() => void this.refreshInfo(rt, tab), 400).unref?.();
    }
    return tab;
  }

  async openTab(context: BrowserContextName, url?: string): Promise<TabInfo> {
    const target = url === undefined ? undefined : checkUrl(url);
    if (context === "assistant" && target && isRestrictedAssistantUrl(target)) {
      throw new BrowserError("blocked", "Automated assistant browsing is disabled on Meta consumer sites; open it in your own Browser tab instead.");
    }
    const rt = await this.ensure();
    if (rt.tabs.size >= (this.options.maxTabs ?? 8)) throw new BrowserError("limit", `At most ${this.options.maxTabs ?? 8} tabs can be open; close one first.`);
    let browserContextId: string | undefined;
    if (context === "assistant") {
      if (!rt.assistantContextId) {
        const made = await rt.conn.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false });
        rt.assistantContextId = made.browserContextId;
        await rt.conn.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.downloads.dir, eventsEnabled: true, browserContextId: made.browserContextId }).catch(() => undefined);
        await this.denyPermissions(rt, made.browserContextId);
      }
      browserContextId = rt.assistantContextId;
    }
    // No width or height here: headless=new refuses them. The size is an Emulation override after attaching.
    const created = await rt.conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) });
    const tab = await this.adopt(rt, created.targetId, context, undefined);
    rt.activeId = tab.id;
    this.emit({ type: "active", id: tab.id });
    if (target && target !== "about:blank") await this.navigateTab(rt, tab, target);
    return this.info(rt, tab);
  }

  async listTabs(): Promise<TabInfo[]> {
    const rt = this.runtime;
    if (!rt) return [];
    this.touch();
    return [...rt.tabs.values()].map((t) => this.info(rt, t));
  }

  async closeTab(id: string): Promise<void> {
    const rt = await this.ensure();
    this.requireTab(rt, id);
    await rt.conn.send("Target.closeTarget", { targetId: id });
    this.removeTab(rt, id);
  }

  async activateTab(id: string): Promise<void> {
    const rt = await this.ensure();
    this.requireTab(rt, id);
    await rt.conn.send("Target.activateTarget", { targetId: id }).catch(() => undefined);
    rt.activeId = id;
    this.emit({ type: "active", id });
  }

  /** Discards the assistant's context: its cookies and storage vanish; its tabs close. */
  async resetAssistant(): Promise<void> {
    const rt = this.runtime;
    if (!rt?.assistantContextId) return;
    for (const tab of [...rt.tabs.values()].filter((t) => t.context === "assistant")) this.removeTab(rt, tab.id);
    const id = rt.assistantContextId;
    rt.assistantContextId = null;
    rt.sharedOrigins.clear();
    await rt.conn.send("Target.disposeBrowserContext", { browserContextId: id }).catch(() => undefined);
  }

  /**
   * Copies cookies matching `origin` from the persistent `you` profile into the assistant's isolated browser context.
   * Cookies belonging to any other origin are never copied.
   */
  async shareOriginSignIn(origin: string): Promise<number> {
    if (originOf(origin) !== origin) throw new BrowserError("invalid", "A full http:// or https:// origin is required.");
    if (isRestrictedAssistantOrigin(origin)) {
      throw new BrowserError("blocked", "Sign-in cookie sharing to the assistant is disabled on Meta consumer sites.");
    }
    const rt = await this.ensure();
    return this.ensureOriginSignIn(rt, origin, true);
  }

  private async ensureOriginSignIn(rt: Runtime, origin: string, force = false): Promise<number> {
    if (!rt.assistantContextId || isRestrictedAssistantOrigin(origin)) return 0;
    if (!force && rt.sharedOrigins.has(origin)) return 0;
    const reply = await rt.conn.send<{ cookies?: CdpCookie[] }>("Storage.getCookies", {}).catch(() => ({ cookies: [] as CdpCookie[] }));
    const cookies = (Array.isArray(reply.cookies) ? reply.cookies : [])
      .filter((c) => !isRestrictedAssistantHost(String(c.domain ?? "").trim().replace(/^\.+/, "")) && cookieMatchesOrigin(c, origin))
      .map((c) => toCookieParam(c, origin));
    rt.sharedOrigins.add(origin);
    if (cookies.length > 0) {
      await rt.conn.send("Storage.setCookies", { browserContextId: rt.assistantContextId, cookies }).catch(() => undefined);
    }
    return cookies.length;
  }

  private removeTab(rt: Runtime, id: string): void {
    const tab = rt.tabs.get(id);
    if (!tab) return;
    for (const [upId, pending] of [...this.uploads.entries()]) {
      if (pending.tabId === id) {
        this.uploads.delete(upId);
        pending.resolve(null);
      }
    }
    this.endScreencast(tab);
    rt.tabs.delete(id);
    rt.bySession.delete(tab.sessionId);
    for (const wake of tab.loadWaiters.splice(0)) wake();
    if (rt.activeId === id) rt.activeId = [...rt.tabs.keys()][0] ?? null;
    this.emit({ type: "tab-closed", id });
    if (rt.activeId) this.emit({ type: "active", id: rt.activeId });
  }

  /** Sizes the tab's page; says the size it was given (the one asked for, kept within what the browser takes). */
  async setViewport(id: string, width: number, height: number, known?: Runtime): Promise<{ width: number; height: number }> {
    const rt = known ?? (await this.ensure());
    const tab = this.requireTab(rt, id);
    const w = Math.round(Math.min(4096, Math.max(100, Number(width) || DEFAULT_SIZE.width)));
    const h = Math.round(Math.min(4096, Math.max(100, Number(height) || DEFAULT_SIZE.height)));
    await rt.conn.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
    return { width: w, height: h };
  }

  // ---------------------------------------------------------------- navigation

  private async navigateTab(rt: Runtime, tab: Tab, url: string): Promise<void> {
    tab.blocked = false;
    const loaded = this.waitLoad(tab);
    // A redirect to a site nobody has been asked about holds the navigation until the person answers, which can take minutes.
    const result = await rt.conn.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url }, tab.sessionId, tab.context === "assistant" && this.options.siteGate ? GATED_NAVIGATION_MS : undefined);
    if (result.errorText) {
      loaded.cancel();
      if (tab.blocked || /BLOCKED_BY_CLIENT/i.test(result.errorText)) throw new BrowserError("blocked", "The person did not allow that site, so it was not opened.");
      throw new BrowserError("invalid", `The page could not be loaded: ${result.errorText}`);
    }
    if (result.loaderId) await loaded.promise;
    else loaded.cancel();
  }

  private waitLoad(tab: Tab, ms = NAVIGATION_WAIT_MS): { promise: Promise<void>; cancel: () => void } {
    let wake: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
      tab.loadWaiters.push(wake);
    });
    return {
      promise,
      cancel: () => {
        const at = tab.loadWaiters.indexOf(wake);
        if (at >= 0) tab.loadWaiters.splice(at, 1);
        wake();
      },
    };
  }

  /** After a click or key: give a navigation time to start, then wait for it to finish (bounded). */
  private async settle(tab: Tab): Promise<void> {
    await sleep(SETTLE_MS);
    if (tab.loading) await this.waitLoad(tab, 5000).promise;
  }

  /** Waits, bounded, for a tab that is still loading or finishing an approved file upload. */
  async waitLoaded(id: string, ms: number): Promise<void> {
    const tab = this.runtime?.tabs.get(id);
    if (tab?.uploading) await within(tab.uploading, ms);
    if (tab?.loading) await this.waitLoad(tab, ms).promise;
  }

  async navigate(id: string, url: string): Promise<TabInfo> {
    const target = checkUrl(url);
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    if (tab.context === "assistant" && isRestrictedAssistantUrl(target)) {
      throw new BrowserError("blocked", "Automated assistant browsing is disabled on Meta consumer sites; open it in your own Browser tab instead.");
    }
    await this.navigateTab(rt, tab, target);
    return this.info(rt, tab);
  }

  private async history(rt: Runtime, tab: Tab, step: -1 | 1): Promise<TabInfo> {
    const h = await rt.conn.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory", {}, tab.sessionId);
    const entry = h.entries[h.currentIndex + step];
    if (entry) {
      const loaded = this.waitLoad(tab);
      await rt.conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.sessionId);
      await loaded.promise;
    }
    return this.info(rt, tab);
  }

  async back(id: string): Promise<TabInfo> {
    const rt = await this.ensure();
    return this.history(rt, this.requireTab(rt, id), -1);
  }

  async forward(id: string): Promise<TabInfo> {
    const rt = await this.ensure();
    return this.history(rt, this.requireTab(rt, id), 1);
  }

  async reload(id: string): Promise<TabInfo> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const loaded = this.waitLoad(tab);
    await rt.conn.send("Page.reload", {}, tab.sessionId);
    await loaded.promise;
    return this.info(rt, tab);
  }

  // ---------------------------------------------------------------- reading the page

  /** The page as compact accessibility text with refs; see snapshot.ts. */
  async snapshot(id: string, options: { maxChars?: number } = {}): Promise<{ text: string; refs: number; truncated: boolean }> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    if (!tab.axEnabled) {
      await rt.conn.send("Accessibility.enable", {}, tab.sessionId);
      tab.axEnabled = true;
    }
    const [tree, dom] = await Promise.all([
      rt.conn.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {}, tab.sessionId),
      rt.conn
        .send<DomSnapshotLike>("DOMSnapshot.captureSnapshot", { computedStyles: ["opacity", "visibility", "font-size"] }, tab.sessionId)
        .catch(() => null),
    ]);
    if (tab.context === "assistant") tab.secretNames = await this.readSecretNames(rt, tab, dom);
    const result = buildSnapshot(tree.nodes ?? [], { url: tab.url, title: tab.title, visible: dom ? visibleBackendIds(dom) : null, ...(options.maxChars ? { maxChars: options.maxChars } : {}) });
    tab.refs = result.refs;
    tab.refInfo = result.info;
    return { text: result.text, refs: result.refs.size, truncated: result.truncated };
  }

  /** What the latest snapshot says an element is, or null for a ref it does not know. */
  refInfo(id: string, ref: string): { role: string; name: string } | null {
    return this.runtime?.tabs.get(id)?.refInfo.get(ref) ?? null;
  }

  /** What the page says about an element (the ref's, or the focused one when `ref` is null), or null when it cannot be read. */
  async elementFacts(id: string, ref: string | null): Promise<ElementFacts | null> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    try {
      if (ref === null) {
        const result = await rt.conn.send<{ result?: { value?: ElementFacts | null } }>("Runtime.evaluate", { expression: `(${FACTS_FN})(document.activeElement)`, returnByValue: true }, tab.sessionId);
        return result.result?.value ?? null;
      }
      const backendNodeId = tab.refs.get(ref);
      if (backendNodeId === undefined) return null;
      const node = await rt.conn.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, tab.sessionId);
      const result = await rt.conn.send<{ result?: { value?: ElementFacts | null } }>(
        "Runtime.callFunctionOn",
        { objectId: node.object.objectId, functionDeclaration: `function(){ return (${FACTS_FN})(this); }`, returnByValue: true },
        tab.sessionId,
      );
      return result.result?.value ?? null;
    } catch {
      return null;
    }
  }

  /** What the page did that the assistant should hear about since it last asked: a site refused, a popup closed, a dialog dismissed. */
  takeNotes(id: string): string[] {
    return this.runtime?.tabs.get(id)?.notes.splice(0) ?? [];
  }

  private note(tab: Tab, text: string): void {
    if (tab.notes.length < 6) tab.notes.push(text);
  }

  async screenshot(id: string, format: "png" | "jpeg" = "png", timeoutMs?: number): Promise<Buffer> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const shot = await rt.conn.send<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 80 } : {}) }, tab.sessionId, timeoutMs);
    return Buffer.from(shot.data, "base64");
  }

  /**
   * Samples live rendering health on the page (frame pacing over ~420ms of requestAnimationFrame, Canvas CSS vs backing
   * buffer DPI mismatch, Web/CSS animations and layout-thrashing keyframes, dev error overlays, and captured console/JS errors).
   */
  async diagnosePage(id: string): Promise<PageDiagnostics> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    await this.refreshInfo(rt, tab).catch(() => undefined);
    type RawDiag = Omit<PageDiagnostics, "url" | "title" | "consoleErrors">;
    let raw: RawDiag | null = null;
    try {
      const evaluated = await rt.conn.send<{ result?: { value?: RawDiag } }>(
        "Runtime.evaluate",
        { expression: DIAGNOSE_PAGE_EXPR, returnByValue: true, awaitPromise: true },
        tab.sessionId,
        3000,
      );
      raw = evaluated.result?.value ?? null;
    } catch {
      raw = null;
    }
    return {
      url: tab.url,
      title: tab.title,
      viewport: raw?.viewport ?? { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, dpr: 1 },
      fps: raw?.fps ?? { fps: 0, frames: 0, avgFrameMs: 0, maxFrameMs: 0, droppedFrames: 0 },
      canvases: raw?.canvases ?? [],
      animations: raw?.animations ?? { total: 0, running: 0, paused: 0, layoutThrashingProps: [] },
      svgCount: raw?.svgCount ?? 0,
      videoCount: raw?.videoCount ?? 0,
      brokenImages: raw?.brokenImages ?? 0,
      errorOverlay: raw?.errorOverlay ?? null,
      consoleErrors: [...tab.consoleErrors],
    };
  }

  private pushConsoleError(tab: Tab, message: string): void {
    const clean = message.replace(/\s+/g, " ").trim().slice(0, 240);
    if (!clean || tab.consoleErrors.includes(clean)) return;
    if (tab.consoleErrors.length >= 16) tab.consoleErrors.shift();
    tab.consoleErrors.push(clean);
  }

  // ---------------------------------------------------------------- acting on the page

  private async centerOf(rt: Runtime, tab: Tab, ref: string): Promise<{ x: number; y: number; backendNodeId: number }> {
    const backendNodeId = tab.refs.get(ref);
    if (backendNodeId === undefined) throw new BrowserError("stale-ref", `${ref} is not a ref of the latest snapshot; take a new snapshot.`);
    try {
      await rt.conn.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, tab.sessionId).catch(() => undefined);
      const box = await rt.conn.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId }, tab.sessionId);
      const q = box.model.content;
      return { x: ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4, y: ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4, backendNodeId };
    } catch (error) {
      if (error instanceof CdpError) throw new BrowserError("stale-ref", `${ref} is no longer on the page; take a new snapshot.`);
      throw error;
    }
  }

  async click(id: string, target: { ref: string } | { x: number; y: number }): Promise<{ x: number; y: number }> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const point = "ref" in target ? await this.centerOf(rt, tab, target.ref) : target;
    const { x, y } = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError("invalid", "x and y must be numbers.");
    await this.lookAtSecrets(rt, tab);
    await this.mouse(rt, tab, { type: "mouseMoved", x, y });
    await this.mouse(rt, tab, { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.mouse(rt, tab, { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await this.settle(tab);
    return { x, y };
  }

  async type(id: string, target: { ref: string } | null, text: string, options: { clear?: boolean; submit?: boolean } = {}): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    if (target) {
      const { backendNodeId } = await this.centerOf(rt, tab, target.ref);
      await rt.conn.send("DOM.focus", { backendNodeId }, tab.sessionId);
      if (options.clear) {
        const node = await rt.conn.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, tab.sessionId);
        await rt.conn.send(
          "Runtime.callFunctionOn",
          { objectId: node.object.objectId, functionDeclaration: "function(){ if (this.select) this.select(); }" },
          tab.sessionId,
        );
        await rt.conn.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, tab.sessionId);
        await rt.conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, tab.sessionId);
      }
    }
    await this.insertText(id, text);
    if (options.submit) await this.press(id, "Enter");
  }

  async press(id: string, key: string): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const def = KEYS[key];
    if (!def && [...key].length !== 1) throw new BrowserError("invalid", `Unknown key "${key.slice(0, 20)}".`);
    const base = def
      ? { key, code: def.code, windowsVirtualKeyCode: def.vk }
      : { key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "", windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
    const text = def ? def.text : key;
    if (key === "Enter" || key === "Space" || key === " ") await this.lookAtSecrets(rt, tab);
    await rt.conn.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) }, tab.sessionId);
    await rt.conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, tab.sessionId);
    await this.settle(tab);
  }

  async scroll(id: string, options: { deltaY?: number; deltaX?: number; x?: number; y?: number }): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    await this.mouse(rt, tab, {
      type: "mouseWheel",
      x: options.x ?? DEFAULT_SIZE.width / 2,
      y: options.y ?? DEFAULT_SIZE.height / 2,
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 0,
    });
  }

  /** Moves the pointer onto an element (or point) to trigger hover menus and tooltips. */
  async hover(id: string, target: { ref: string } | { x: number; y: number }): Promise<{ x: number; y: number }> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const point = "ref" in target ? await this.centerOf(rt, tab, target.ref) : target;
    const { x, y } = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new BrowserError("invalid", "x and y must be numbers.");
    await this.mouse(rt, tab, { type: "mouseMoved", x, y });
    await sleep(SETTLE_MS);
    return { x, y };
  }

  /**
   * Selects an `<option>` inside a `<select>` element by ref and option value, label, or 0-based index, firing `input` and
   * `change` events just as a user's choice does. Returns the chosen option's visible label.
   */
  async selectOption(id: string, target: { ref: string }, option: string): Promise<string> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const backendNodeId = tab.refs.get(target.ref);
    if (backendNodeId === undefined) throw new BrowserError("stale-ref", `${target.ref} is not a ref of the latest snapshot; take a new snapshot.`);
    const wanted = String(option ?? "").trim();
    if (wanted === "") throw new BrowserError("invalid", "select needs an option label, value, or index.");
    await this.lookAtSecrets(rt, tab);
    let resolved: { object: { objectId: string } };
    try {
      resolved = await rt.conn.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, tab.sessionId);
    } catch (error) {
      if (error instanceof CdpError) throw new BrowserError("stale-ref", `${target.ref} is no longer on the page; take a new snapshot.`);
      throw error;
    }
    const reply = await rt.conn.send<{ result?: { value?: { ok: boolean; label?: string; error?: string } } }>(
      "Runtime.callFunctionOn",
      {
        objectId: resolved.object.objectId,
        arguments: [{ value: wanted }],
        functionDeclaration: `function(query) {
          var el = this && (this.tagName && this.tagName.toLowerCase() === "select" ? this : (this.closest ? this.closest("select") : null));
          if (!el) return { ok: false, error: "That element is not a <select> dropdown." };
          if (el.disabled) return { ok: false, error: "That dropdown is disabled." };
          var opts = Array.prototype.slice.call(el.options || []);
          var q = String(query || "").trim();
          var qLower = q.toLowerCase();
          var pick = -1;
          for (var i = 0; i < opts.length; i++) {
            var lbl = String(opts[i].label || opts[i].text || "").trim();
            var val = String(opts[i].value || "").trim();
            if (!opts[i].disabled && (val === q || lbl === q)) { pick = i; break; }
          }
          if (pick < 0) {
            for (var j = 0; j < opts.length; j++) {
              var lbl2 = String(opts[j].label || opts[j].text || "").trim().toLowerCase();
              var val2 = String(opts[j].value || "").trim().toLowerCase();
              if (!opts[j].disabled && (lbl2 === qLower || val2 === qLower)) { pick = j; break; }
            }
          }
          if (pick < 0 && /^\\d+$/.test(q)) {
            var idx = Number(q);
            if (idx >= 0 && idx < opts.length && !opts[idx].disabled) pick = idx;
          }
          if (pick < 0) {
            var names = opts.filter(function(o){ return !o.disabled; }).slice(0, 15).map(function(o){ return String(o.label || o.text || o.value || "").trim(); }).filter(Boolean);
            return { ok: false, error: 'No enabled option matched "' + q.slice(0, 60) + '". Available options: ' + (names.join(", ") || "none") + "." };
          }
          el.focus();
          el.selectedIndex = pick;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, label: String(opts[pick].label || opts[pick].text || opts[pick].value || "").trim().slice(0, 120) };
        }`,
        returnByValue: true,
      },
      tab.sessionId,
    );
    const out = reply.result?.value;
    if (!out?.ok) throw new BrowserError("invalid", out?.error ?? "Could not select that option.");
    await this.settle(tab);
    return out.label ?? wanted;
  }

  // ---------------------------------------------------------------- raw input (the pane)

  private async mouse(rt: Runtime, tab: Tab, input: MouseInput): Promise<void> {
    await rt.conn.send(
      "Input.dispatchMouseEvent",
      {
        type: input.type,
        x: input.x,
        y: input.y,
        button: input.button ?? "none",
        buttons: input.buttons ?? 0,
        clickCount: input.clickCount ?? 0,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        modifiers: input.modifiers ?? 0,
      },
      tab.sessionId,
    );
  }

  async dispatchMouse(id: string, input: MouseInput): Promise<void> {
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new BrowserError("invalid", "x and y must be numbers.");
    const rt = await this.ensure();
    await this.mouse(rt, this.requireTab(rt, id), input);
  }

  async dispatchKey(id: string, input: KeyInput): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    await rt.conn.send("Input.dispatchKeyEvent", { ...input }, tab.sessionId);
  }

  async insertText(id: string, text: string): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    await rt.conn.send("Input.insertText", { text: String(text) }, tab.sessionId);
  }

  /** Brings the tab to the front and re-applies its size so the browser paints it again (a screencast sends nothing for a page that does not change). */
  async repaint(id: string): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    await rt.conn.send("Page.bringToFront", {}, tab.sessionId);
  }

  /** The text selected in the tab's page (or in the focused field), for the pane's Copy. */
  async selectionText(id: string): Promise<string> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const reply = await rt.conn.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression: `(() => { const a = document.activeElement; if (a && typeof a.value === "string" && a.selectionStart != null && a.selectionEnd > a.selectionStart) return a.value.slice(a.selectionStart, a.selectionEnd); return String(getSelection() || ""); })()`,
        returnByValue: true,
      },
      tab.sessionId,
    );
    return typeof reply.result?.value === "string" ? reply.result.value.slice(0, 1_000_000) : "";
  }

  /** The `<select>` under a point, remembered in the page so `chooseOption` needs no second lookup; null when there is none. */
  async selectAt(id: string, x: number, y: number): Promise<SelectProbe | null> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const reply: { result?: { value?: SelectProbe | null } } = await rt.conn
      .send<{ result?: { value?: SelectProbe | null } }>(
        "Runtime.evaluate",
        {
          expression: `(() => { let el = document.elementFromPoint(${Number(x)}, ${Number(y)}); el = el && el.closest && el.closest("select"); if (!el || el.disabled) return null; const r = el.getBoundingClientRect(); window.__ancillaSelect = el;
          return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, multiple: el.multiple || el.size > 1,
            options: [...el.options].slice(0, 500).map((o, index) => ({ index, label: String(o.label || o.text || "").slice(0, 200), disabled: !!(o.disabled || (o.parentElement && o.parentElement.disabled)), selected: o.selected })) }; })()`,
          returnByValue: true,
        },
        tab.sessionId,
      )
      .catch(() => ({}));
    const value = reply.result?.value;
    return value && Array.isArray(value.options) ? value : null;
  }

  /** Picks an option of the select `selectAt` last found, and fires `input` and `change` the way a person's choice does. */
  async chooseOption(id: string, index: number): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    if (!Number.isInteger(index) || index < 0) throw new BrowserError("invalid", "index must be a whole number.");
    await rt.conn.send(
      "Runtime.evaluate",
      {
        expression: `(() => { const el = window.__ancillaSelect; if (!el || !el.options[${index}]) return false; el.focus(); el.selectedIndex = ${index};
          el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
        returnByValue: true,
      },
      tab.sessionId,
    );
  }

  async answerDialog(id: string, accept: boolean, promptText?: string): Promise<void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    if (!tab.dialog) throw new BrowserError("invalid", "No dialog is open in that tab.");
    await rt.conn.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) }, tab.sessionId);
  }

  // ---------------------------------------------------------------- screencast

  /**
   * Frames of the tab, each acknowledged to the browser (so it keeps sending) once `onFrame` has returned. At most
   * `maxFps` frames a second reach `onFrame`; a frame skipped for the cap is kept and delivered when the gap is over, so
   * the last picture of a page that stopped changing is never lost. Returns the function that stops it.
   */
  async screencast(
    id: string,
    onFrame: (frame: ScreencastFrame) => void | Promise<void>,
    options: { maxFps?: number; quality?: number } = {},
  ): Promise<() => void> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    this.endScreencast(tab);
    const fps = Math.min(60, Math.max(1, options.maxFps ?? 30));
    const state: ScreencastState = { onFrame, minGapMs: 1000 / fps, lastSent: -Infinity, pending: null, timer: null };
    tab.screencast = state;
    await rt.conn.send(
      "Page.startScreencast",
      { format: "jpeg", quality: Math.min(100, Math.max(10, options.quality ?? 60)), everyNthFrame: 1 },
      tab.sessionId,
    );
    return () => {
      if (tab.screencast === state) {
        this.endScreencast(tab);
        if (this.runtime?.tabs.has(tab.id)) void this.runtime.conn.send("Page.stopScreencast", {}, tab.sessionId).catch(() => undefined);
      }
    };
  }

  private endScreencast(tab: Tab): void {
    const state = tab.screencast;
    if (!state) return;
    tab.screencast = null;
    if (state.timer) clearTimeout(state.timer);
    state.pending?.ack();
    state.pending = null;
  }

  private onScreencastFrame(rt: Runtime, tab: Tab, params: Record<string, any>): void {
    const state = tab.screencast;
    const ack = () => {
      if (!rt.conn.isClosed) void rt.conn.send("Page.screencastFrameAck", { sessionId: params["sessionId"] }, tab.sessionId).catch(() => undefined);
    };
    if (!state) {
      ack();
      return;
    }
    const frame: ScreencastFrame = {
      data: String(params["data"] ?? ""),
      width: Number(params["metadata"]?.deviceWidth ?? DEFAULT_SIZE.width),
      height: Number(params["metadata"]?.deviceHeight ?? DEFAULT_SIZE.height),
      at: Date.now(),
    };
    const deliver = (f: ScreencastFrame, done: () => void) => {
      state.lastSent = performance.now();
      let result: void | Promise<void>;
      try {
        result = state.onFrame(f);
      } catch {
        result = undefined;
      }
      if (result && typeof (result as Promise<void>).then === "function") (result as Promise<void>).then(done, done);
      else done();
    };
    const wait = state.minGapMs - (performance.now() - state.lastSent);
    if (wait <= 0 && !state.pending) {
      deliver(frame, ack);
      return;
    }
    // Too soon: keep only the newest (the older one is acknowledged and dropped) and send it when the gap is over.
    state.pending?.ack();
    state.pending = { frame, ack };
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        const next = state.pending;
        state.pending = null;
        if (next && tab.screencast === state) deliver(next.frame, next.ack);
        else next?.ack();
      }, Math.max(0, wait));
      state.timer.unref?.();
    }
  }

  // ---------------------------------------------------------------- browser events

  private onCdp(rt: Runtime, method: string, params: Record<string, any>, sessionId: string | undefined): void {
    if (method === "Browser.downloadWillBegin") {
      this.downloadBegan(rt, params);
      return;
    }
    if (method === "Browser.downloadProgress") {
      this.downloadProgress(rt, params);
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const target = params["targetInfo"] ?? {};
      const tab = rt.tabs.get(target.targetId);
      if (tab && target.type === "page") {
        tab.url = String(target.url ?? tab.url);
        tab.title = String(target.title ?? tab.title);
        this.emit({ type: "tab", tab: this.info(rt, tab) });
      }
      return;
    }
    if (method === "Target.targetDestroyed" || method === "Target.detachedFromTarget") {
      const tab = method === "Target.targetDestroyed" ? rt.tabs.get(params["targetId"]) : rt.bySession.get(params["sessionId"]);
      if (tab) this.removeTab(rt, tab.id);
      return;
    }
    if (method === "Target.targetCreated") {
      const target = params["targetInfo"] ?? {};
      const opener = target.openerId ? rt.tabs.get(target.openerId) : undefined;
      if (target.type !== "page" || !opener || rt.tabs.has(target.targetId)) return;
      if (opener.context === "assistant") {
        // The assistant works in one tab, and a popup would load before anyone was asked about it: it is closed, and the assistant is told.
        void rt.conn.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
        this.note(opener, "A page tried to open a popup window, which was closed.");
        this.emit({ type: "notice", kind: "popup", tabId: opener.id, text: "A page tried to open a popup window, which was closed." });
        return;
      }
      void this.adoptPopup(rt, target, opener);
      return;
    }
    const tab = sessionId ? rt.bySession.get(sessionId) : undefined;
    if (!tab) return;
    switch (method) {
      case "Page.frameStartedLoading":
        if (!tab.loading) {
          tab.loading = true;
          this.emit({ type: "tab", tab: this.info(rt, tab) });
        }
        break;
      case "Page.frameNavigated":
        // A new page replaced the one whose password inputs were read: nothing is known about the new one until it is read.
        if (!params["frame"]?.parentId) {
          tab.secretNames = null;
          tab.consoleErrors.length = 0;
        }
        break;
      case "Runtime.consoleAPICalled": {
        const type = String(params["type"] ?? "");
        if (type === "error" || type === "warning") {
          const args = Array.isArray(params["args"]) ? (params["args"] as Array<Record<string, unknown>>) : [];
          const text = args
            .map((a) => String(a["value"] ?? a["description"] ?? ""))
            .filter(Boolean)
            .join(" ");
          if (text) this.pushConsoleError(tab, `[${type}] ${text}`);
        }
        break;
      }
      case "Runtime.exceptionThrown": {
        const details = (params["exceptionDetails"] ?? {}) as Record<string, unknown>;
        const exc = (details["exception"] ?? {}) as Record<string, unknown>;
        const desc = String(exc["description"] ?? details["text"] ?? "Uncaught exception");
        this.pushConsoleError(tab, desc);
        break;
      }
      case "Page.frameStoppedLoading":
        if (tab.loading) {
          tab.loading = false;
          this.emit({ type: "tab", tab: this.info(rt, tab) });
        }
        break;
      case "Page.loadEventFired":
        // Chromium reports a title change to the target late (measured: not until the tab closes), so ask once loaded.
        void this.refreshInfo(rt, tab).finally(() => {
          for (const wake of tab.loadWaiters.splice(0)) wake();
        });
        break;
      case "Fetch.requestPaused":
        void this.onRequestPaused(rt, tab, params);
        break;
      case "Page.javascriptDialogOpening":
        if (tab.context === "assistant") {
          // Nobody is there to answer a dialog and the page is frozen until it is: alerts and "leave this page?" are accepted, questions are declined.
          const kind = String(params["type"] ?? "alert");
          this.note(tab, `A page showed a ${kind} dialog (“${String(params["message"] ?? "").replace(/\s+/g, " ").slice(0, 120)}”), which was dismissed.`);
          void rt.conn.send("Page.handleJavaScriptDialog", { accept: kind === "alert" || kind === "beforeunload" }, tab.sessionId).catch(() => undefined);
          break;
        }
        tab.dialog = {
          tabId: tab.id,
          kind: String(params["type"] ?? "alert"),
          message: String(params["message"] ?? ""),
          ...(params["defaultPrompt"] !== undefined ? { defaultPrompt: String(params["defaultPrompt"]) } : {}),
          url: String(params["url"] ?? tab.url),
        };
        this.emit({ type: "dialog", dialog: tab.dialog });
        break;
      case "Page.javascriptDialogClosed":
        tab.dialog = null;
        this.emit({ type: "dialog-closed", tabId: tab.id });
        break;
      case "Page.fileChooserOpened": {
        const backendNodeId = params["backendNodeId"];
        if (typeof backendNodeId !== "number") {
          if (tab.context === "assistant") {
            this.note(tab, "A page opened a file picker that could not be attached to a file input.");
          } else {
            this.emit({ type: "notice", kind: "file", tabId: tab.id, text: "Choosing a file to upload is not available yet." });
          }
          break;
        }
        const multiple = params["mode"] === "selectMultiple";
        const job = this.handleFileChooser(rt, tab, backendNodeId, multiple).finally(() => {
          if (tab.uploading === job) tab.uploading = null;
        });
        tab.uploading = job;
        break;
      }
      case "Page.screencastFrame":
        this.onScreencastFrame(rt, tab, params);
        break;
      default:
        break;
    }
  }

  /**
   * A page is about to load in the assistant's browser. The request waits for the gate: allowed, it goes on; refused, it fails
   * as blocked, and for a main frame the assistant is told which site it was. A frame inside a page is a main-frame page's
   * business only when the gate says so: the gate is told which kind it is.
   */
  private async onRequestPaused(rt: Runtime, tab: Tab, params: Record<string, any>): Promise<void> {
    const requestId = String(params["requestId"] ?? "");
    const url = String(params["request"]?.url ?? "");
    const origin = originOf(url);
    const restricted = (origin !== null && isRestrictedAssistantOrigin(origin)) || isRestrictedAssistantUrl(url);
    // For a page target the main frame has the target's own id.
    const mainFrame = params["frameId"] === undefined || params["frameId"] === tab.id;
    let allowed = false;
    if (!restricted && origin && this.options.siteGate) {
      try {
        allowed = await this.options.siteGate({ url, origin, tabId: tab.id, mainFrame });
      } catch {
        allowed = false;
      }
    }
    if (allowed && origin && this.options.signInGate) {
      try {
        if (await this.options.signInGate({ url, origin, tabId: tab.id, mainFrame })) {
          await this.ensureOriginSignIn(rt, origin);
        }
      } catch {
        // cookie hydration failure never turns a refusal into a pass or crashes the gate
      }
    }
    // A form is held until the person says it may be sent (any frame); with nobody to ask, it is not sent.
    const method = String(params["request"]?.method ?? "GET").toUpperCase();
    let formRefused = false;
    if (allowed && method !== "GET" && method !== "HEAD") {
      const headers = (params["request"]?.headers ?? {}) as Record<string, unknown>;
      const typeKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
      try {
        allowed = this.options.commitGate
          ? await this.options.commitGate({ url, method, title: tab.title, contentType: typeKey ? String(headers[typeKey]) : "", body: bodyText(params["request"] ?? {}), secrets: mainFrame ? tab.secretNames : null })
          : false;
      } catch {
        allowed = false;
      }
      formRefused = !allowed;
    }
    // The browser, or this tab, went away while the person was deciding.
    if (rt.conn.isClosed || rt.tabs.get(tab.id) !== tab) return;
    if (formRefused) {
      this.note(tab, `A form to ${origin ?? url.slice(0, 80)} was not sent: the person did not allow it. Nothing was changed.`);
    } else if (!allowed && mainFrame) {
      tab.blocked = true;
      this.note(
        tab,
        restricted
          ? `${origin ?? url.slice(0, 80)} was not opened: automated assistant browsing is disabled on Meta consumer sites (open it in your own Browser tab instead).`
          : `${origin ?? url.slice(0, 80)} was not opened: the person did not allow it.`,
      );
    }
    // Refused, a request is aborted rather than blocked: an aborted navigation leaves the page that had the link where it was,
    // as Stop does, where a blocked one replaces it with the browser's error page.
    await rt.conn
      .send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed ? { requestId } : { requestId, errorReason: "Aborted" }, tab.sessionId)
      .catch(() => undefined);
  }

  /**
   * The names of the password inputs of the tab's page (a form being sent may hold one under any name), or null when nothing could
   * say. From the DOM snapshot, which runs no page script, so it cannot time out or be answered wrongly by the page; only when that
   * did not read the page, from the page itself (a second source, with a time limit). A form is then shown with every value
   * hidden, never with the values of a page nobody could read.
   */
  private async readSecretNames(rt: Runtime, tab: Tab, dom: DomSnapshotLike | null): Promise<string[] | null> {
    return (dom ? passwordInputNames(dom) : null) ?? (await this.passwordNamesFromPage(rt, tab));
  }

  private async passwordNamesFromPage(rt: Runtime, tab: Tab): Promise<string[] | null> {
    try {
      const result = await rt.conn.send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: "Array.from(document.querySelectorAll('input[type=password]')).map(function(e){return e.name||e.id||''}).filter(Boolean).slice(0,200)", returnByValue: true },
        tab.sessionId,
        1500,
      );
      const value = result.result?.value;
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
    } catch {
      return null;
    }
  }

  /**
   * Reads the password inputs again just before the assistant clicks or presses Enter or Space: an input may have appeared since the
   * last snapshot, and the form that act sends is held in the browser, where the page may not answer (a probe found it did on Edge
   * 157, earlier measurements found it did not), so nothing asks it then. A read that fails leaves the names unknown, which hides
   * every value.
   */
  private async lookAtSecrets(rt: Runtime, tab: Tab): Promise<void> {
    if (tab.context !== "assistant") return;
    const dom = await rt.conn.send<DomSnapshotLike>("DOMSnapshot.captureSnapshot", { computedStyles: [] }, tab.sessionId, LOOK_MS).catch(() => null);
    tab.secretNames = await this.readSecretNames(rt, tab, dom);
  }

  private async refreshInfo(rt: Runtime, tab: Tab): Promise<void> {
    try {
      const reply = await rt.conn.send<{ targetInfo?: { url?: string; title?: string } }>("Target.getTargetInfo", { targetId: tab.id }, undefined, 5000);
      const url = reply.targetInfo?.url ?? tab.url;
      const title = reply.targetInfo?.title ?? tab.title;
      if (url !== tab.url || title !== tab.title) {
        tab.url = url;
        tab.title = title;
        if (rt.tabs.get(tab.id) === tab) this.emit({ type: "tab", tab: this.info(rt, tab) });
      }
    } catch {
      // the tab went away
    }
  }

  private async adoptPopup(rt: Runtime, target: { targetId: string; url?: string; title?: string }, opener: Tab): Promise<void> {
    if (rt.tabs.size >= (this.options.maxTabs ?? 8)) {
      await rt.conn.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined);
      return;
    }
    try {
      await this.adopt(rt, target.targetId, opener.context, opener.id, target);
    } catch {
      // the popup closed before it could be attached
    }
  }
}
