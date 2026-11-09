import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CdpConnection, CdpError } from "./cdp.js";
import { findBrowser, type FindResult, type FoundBrowser } from "./find.js";
import { launchBrowser, type BrowserProcess, type LaunchOptions } from "./launch.js";
import { buildSnapshot, visibleBackendIds, type AxNode, type DomSnapshotLike } from "./snapshot.js";

/**
 * The browser the server owns: a Chromium-family browser started lazily, headless, driven over a private CDP pipe.
 * Two contexts keep the user's world apart from the assistant's: `you` is the browser's persistent default context
 * (where sign-ins will live), `assistant` is an ephemeral one made with Target.createBrowserContext; cookies never cross.
 * The pane (B2) and the browsing agent (B3) plug into this class; it has no HTTP, no UI and no model in it.
 */

export type BrowserContextName = "you" | "assistant";
export type BrowserErrorCode = "unavailable" | "scheme" | "limit" | "no-tab" | "stale-ref" | "invalid" | "closed";

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
  | { type: "stopped" };

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
}

export interface BrowserServiceOptions {
  /** Where `browser/profile` lives. Missing or ":memory:" gives a throwaway folder under the system temp dir. */
  dataDir?: string;
  log?: (line: string) => void;
  idleMs?: number;
  maxTabs?: number;
  find?: () => FindResult;
  launch?: (options: LaunchOptions) => BrowserProcess;
  /** How long a graceful Browser.close may take before the process tree is killed. */
  gracefulMs?: number;
  /** Version lookup for a browser that is not running (the real one reads the install folder or asks `--version`). */
  versionOf?: (browser: FoundBrowser) => Promise<string | null>;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SIZE = { width: 1280, height: 800 };
const SETTLE_MS = 150;
const NAVIGATION_WAIT_MS = 15_000;
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
  dialog: DialogInfo | null;
  loadWaiters: Array<() => void>;
  screencast: ScreencastState | null;
  axEnabled: boolean;
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
  private versionCache: { path: string; version: string | null } | null = null;
  private readonly options: BrowserServiceOptions;

  constructor(options: BrowserServiceOptions = {}) {
    this.options = options;
    const base = options.dataDir && options.dataDir !== ":memory:" ? options.dataDir : mkdtempSync(join(tmpdir(), "ancilla-browser-"));
    this.profileDir = join(base, "browser", "profile");
  }

  // ---------------------------------------------------------------- status and events

  profilePath(): string {
    return this.profileDir;
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
    const found = (this.options.find ?? (() => findBrowser()))();
    if (!found.browser) {
      return { available: false, browser: null, reason: found.reason ?? "No browser was found.", running: false, tabs: 0 };
    }
    const running = this.runtime;
    let version = running ? running.version : null;
    if (version === null) {
      if (this.versionCache?.path !== found.browser.path) {
        this.versionCache = { path: found.browser.path, version: await (this.options.versionOf ?? defaultVersionOf)(found.browser) };
      }
      version = this.versionCache.version;
    }
    return {
      available: true,
      browser: { kind: found.browser.kind, path: found.browser.path, version },
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
      // Someone watching (a screencast) or a dialog waiting keeps it open; the next idle period asks again.
      if ([...rt.tabs.values()].some((t) => t.screencast || t.dialog)) {
        this.touch();
        return;
      }
      this.options.log?.("browser: stopped after being idle");
      void this.stop();
    }, idleMs);
    this.idleTimer.unref?.();
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

  private async start(): Promise<Runtime> {
    const found = (this.options.find ?? (() => findBrowser()))();
    if (!found.browser) throw new BrowserError("unavailable", found.reason ?? "No browser was found.");
    const browser = found.browser;
    mkdirSync(this.profileDir, { recursive: true });
    const launch = this.options.launch ?? launchBrowser;
    const proc = launch({ path: browser.path, profileDir: this.profileDir });
    const conn = new CdpConnection(proc.toBrowser, proc.fromBrowser);
    const tabs = new Map<string, Tab>();
    const rt: Runtime = { proc, conn, version: "", browser, tabs, bySession: new Map(), assistantContextId: null, activeId: null, stopping: false };

    const died = proc.exited.then((code) => {
      throw new BrowserError(
        "unavailable",
        `${browser.kind} exited while starting (code ${code ?? "none"}). Ancilla never turns the browser's sandbox off; if it cannot start sandboxed here (running as root, or in a container without user namespaces) it has to run as a normal user, or ANCILLA_BROWSER can name a browser that can.`,
      );
    });
    died.catch(() => undefined);
    try {
      const info = await Promise.race([conn.send("Browser.getVersion", {}, undefined, 20_000), died]);
      rt.version = String(info.product ?? "").replace(/^[^/]*\//, "") || "unknown";
      conn.onEvent((method, params, sessionId) => this.onCdp(rt, method, params, sessionId));
      const teardown = () => this.teardown(rt);
      conn.onClose(teardown);
      void proc.exited.then(teardown);
      await conn.send("Target.setDiscoverTargets", { discover: true });
      await conn.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => undefined);
      await this.denyPermissions(rt, undefined);
      // The blank page the browser opens with becomes the first tab of `you`.
      const targets = await conn.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>("Target.getTargets");
      for (const target of targets.targetInfos.filter((t) => t.type === "page")) await this.adopt(rt, target.targetId, "you", undefined, target);
    } catch (error) {
      rt.stopping = true;
      conn.close();
      await proc.killTree().catch(() => undefined);
      throw error;
    }
    this.runtime = rt;
    this.options.log?.(`browser: started ${browser.kind} ${rt.version}`);
    return rt;
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
  private teardown(rt: Runtime): void {
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
      dialog: null,
      loadWaiters: [],
      screencast: null,
      axEnabled: false,
    };
    rt.tabs.set(targetId, tab);
    rt.bySession.set(tab.sessionId, tab);
    await rt.conn.send("Page.enable", {}, tab.sessionId);
    await this.setViewport(targetId, DEFAULT_SIZE.width, DEFAULT_SIZE.height, rt);
    if (!rt.activeId) rt.activeId = targetId;
    this.emit({ type: "tab", tab: this.info(rt, tab) });
    return tab;
  }

  async openTab(context: BrowserContextName, url?: string): Promise<TabInfo> {
    const target = url === undefined ? undefined : checkUrl(url);
    const rt = await this.ensure();
    if (rt.tabs.size >= (this.options.maxTabs ?? 8)) throw new BrowserError("limit", `At most ${this.options.maxTabs ?? 8} tabs can be open; close one first.`);
    let browserContextId: string | undefined;
    if (context === "assistant") {
      if (!rt.assistantContextId) {
        const made = await rt.conn.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false });
        rt.assistantContextId = made.browserContextId;
        await rt.conn.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: made.browserContextId }).catch(() => undefined);
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
    await rt.conn.send("Target.disposeBrowserContext", { browserContextId: id }).catch(() => undefined);
  }

  private removeTab(rt: Runtime, id: string): void {
    const tab = rt.tabs.get(id);
    if (!tab) return;
    this.endScreencast(tab);
    rt.tabs.delete(id);
    rt.bySession.delete(tab.sessionId);
    for (const wake of tab.loadWaiters.splice(0)) wake();
    if (rt.activeId === id) rt.activeId = [...rt.tabs.keys()][0] ?? null;
    this.emit({ type: "tab-closed", id });
    if (rt.activeId) this.emit({ type: "active", id: rt.activeId });
  }

  async setViewport(id: string, width: number, height: number, known?: Runtime): Promise<void> {
    const rt = known ?? (await this.ensure());
    const tab = this.requireTab(rt, id);
    const w = Math.round(Math.min(4096, Math.max(100, Number(width) || DEFAULT_SIZE.width)));
    const h = Math.round(Math.min(4096, Math.max(100, Number(height) || DEFAULT_SIZE.height)));
    await rt.conn.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
  }

  // ---------------------------------------------------------------- navigation

  private async navigateTab(rt: Runtime, tab: Tab, url: string): Promise<void> {
    const loaded = this.waitLoad(tab);
    const result = await rt.conn.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url }, tab.sessionId);
    if (result.errorText) {
      loaded.cancel();
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

  async navigate(id: string, url: string): Promise<TabInfo> {
    const target = checkUrl(url);
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
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
  async snapshot(id: string): Promise<{ text: string; refs: number; truncated: boolean }> {
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
    const result = buildSnapshot(tree.nodes ?? [], { url: tab.url, title: tab.title, visible: dom ? visibleBackendIds(dom) : null });
    tab.refs = result.refs;
    return { text: result.text, refs: result.refs.size, truncated: result.truncated };
  }

  async screenshot(id: string, format: "png" | "jpeg" = "png"): Promise<Buffer> {
    const rt = await this.ensure();
    const tab = this.requireTab(rt, id);
    const shot = await rt.conn.send<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 80 } : {}) }, tab.sessionId);
    return Buffer.from(shot.data, "base64");
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
    const state: ScreencastState = { onFrame, minGapMs: 1000 / fps, lastSent: 0, pending: null, timer: null };
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
      state.lastSent = Date.now();
      let result: void | Promise<void>;
      try {
        result = state.onFrame(f);
      } catch {
        result = undefined;
      }
      if (result && typeof (result as Promise<void>).then === "function") (result as Promise<void>).then(done, done);
      else done();
    };
    const wait = state.minGapMs - (Date.now() - state.lastSent);
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
      case "Page.javascriptDialogOpening":
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
      case "Page.screencastFrame":
        this.onScreencastFrame(rt, tab, params);
        break;
      default:
        break;
    }
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
