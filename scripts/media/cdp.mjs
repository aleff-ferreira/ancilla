// A small Chrome DevTools Protocol driver for a headless Chromium, so a page can be rendered as a foreground page would be
// (a browser pane that is not on screen freezes animations). `import { launch } from "./cdp.mjs"`. Node 22's global
// WebSocket does the talking. The browser is CHROME_BIN, or else the newest chrome-headless-shell in Playwright's cache
// (`npx playwright install chromium-headless-shell`).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function findBrowser() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright");
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse() : [];
  for (const build of builds) {
    const bin = join(cache, build, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("No headless Chromium found. Set CHROME_BIN to a chrome-headless-shell binary.");
}

const BIN = findBrowser();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYS = { Enter: { code: "Enter", vk: 13, text: "\r" }, Escape: { code: "Escape", vk: 27 }, Tab: { code: "Tab", vk: 9 }, ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowUp: { code: "ArrowUp", vk: 38 } };

export async function launch({ width = 1000, height = 720, dpr = 2, scheme = "dark", reduce = false } = {}) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), "cdp-"));
  const proc = spawn(BIN, ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  let targets = null;
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.length) break;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  if (!targets?.length) throw new Error(`no debugging endpoint: ${stderr.slice(0, 400)}`);
  const target = targets.find((t) => t.type === "page") ?? targets[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let counter = 0;
  const waiting = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined && waiting.has(data.id)) {
      const { resolve, reject } = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error) reject(new Error(`${data.error.message}`));
      else resolve(data.result);
    } else if (data.method) {
      for (const fn of listeners.get(data.method) ?? []) fn(data.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++counter;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const once = (method) => new Promise((resolve) => {
    const fn = (params) => {
      listeners.set(method, (listeners.get(method) ?? []).filter((f) => f !== fn));
      resolve(params);
    };
    listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  });
  /** A listener that stays (the `once` above is for a single event): `on("Page.screencastFrame", fn)`. */
  const on = (method, fn) => {
    listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });

  const api = {
    send,
    on,
    async goto(url, settleMs = 800) {
      const loaded = once("Page.loadEventFired");
      await send("Page.navigate", { url });
      // A change of the hash alone is a navigation inside the page and fires no load event, so the wait has an end.
      await Promise.race([loaded, sleep(6000)]);
      await sleep(settleMs);
    },
    async eval(expression) {
      const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
      return out.result.value;
    },
    async rect(selector) {
      return api.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    },
    /** A screenshot of the page, or of a clip of it, written to `file`. */
    async shot(file, clip) {
      const out = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
      writeFileSync(file, Buffer.from(out.data, "base64"));
      return file;
    },
    async click(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    async move(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    },
    async type(text) {
      await send("Input.insertText", { text });
    },
    async press(key) {
      const k = KEYS[key] ?? { code: key, vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk });
    },
    sleep,
    async close() {
      try {
        ws.close();
      } catch {
        /* closed already */
      }
      proc.kill("SIGKILL");
      await sleep(200);
      rmSync(profile, { recursive: true, force: true });
    },
  };
  return api;
}
