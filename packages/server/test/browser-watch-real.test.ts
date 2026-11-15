import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { findBrowser } from "../src/browser/find.js";
import { decodeFrame } from "../src/browser/protocol.js";
import { BrowserError, BrowserService } from "../src/browser/service.js";
import { BROWSER_WATCH_PATH, BrowserWatchServer, type WatchSource } from "../src/browser/watch.js";

/**
 * The assistant's watcher against a real browser: the pictures of the assistant's tab arrive, the person's own tabs never do, a
 * click sent by a watcher is not carried out, and a page that is not changing still gets a picture. Skipped, with the reason,
 * where there is no browser.
 */

const found = findBrowser();
const SKIP: string | false = found.browser ? false : `no browser to drive: ${found.reason}`;

let pages: Server;
let base = "";
let dataDir = "";
let svc: BrowserService;
let watchers: BrowserWatchServer;
let http: Server;
let url = "";
let clicks = 0;
let sandboxSkip: string | null = null;
const source: WatchSource = { current: () => null, on: () => () => undefined };

before(async () => {
  if (SKIP) return;
  dataDir = mkdtempSync(join(tmpdir(), "ancilla-watch-real-"));
  pages = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/favicon.ico") return void res.writeHead(404).end();
    if (path === "/clicked") {
      clicks += 1;
      return void res.writeHead(204).end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (path === "/anim") return void res.end("<!doctype html><title>Anim</title><body style='margin:0'><div id=b style='width:80px;height:80px;background:#08c;position:absolute'></div><script>let n=0;(function f(){n++;document.getElementById('b').style.left=(n%600)+'px';document.getElementById('b').style.top=((n*3)%400)+'px';requestAnimationFrame(f)})()</script>");
    if (path === "/click") return void res.end("<!doctype html><title>Click</title><body style='margin:0'><button style='position:absolute;left:10px;top:10px;width:120px;height:50px' onclick=\"fetch('/clicked')\">Press</button>");
    res.end("<!doctype html><title>Still</title><h1>Nothing moves here</h1>");
  });
  await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
  svc = new BrowserService({ dataDir });
  watchers = new BrowserWatchServer(() => svc, () => source, () => undefined);
  http = createServer();
  http.on("upgrade", (req, socket, head) => watchers.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${BROWSER_WATCH_PATH}`;
});

after(async () => {
  if (SKIP) return;
  watchers.close();
  await svc.dispose();
  http.closeAllConnections?.();
  http.close();
  await new Promise<void>((resolve) => pages.close(() => resolve()));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may hold a profile file for a moment after the browser exits
  }
});

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Watcher {
  ws: WebSocket;
  states: Array<{ tab: string | null }>;
  frames: Array<{ tabId: string; jpeg: Buffer; width: number; height: number }>;
}

function watch(): Promise<Watcher> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const w: Watcher = { ws, states: [], frames: [] };
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = decodeFrame(data as Buffer);
        if (!frame) return;
        w.frames.push(frame);
        ws.send(JSON.stringify({ type: "ack", seq: frame.seq }));
      } else w.states.push(JSON.parse(String(data)));
    });
    ws.on("error", reject);
    ws.on("open", () => resolve(w));
  });
}

const real = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: SKIP, timeout: 120_000 }, async (t) => {
    if (sandboxSkip) return void t.skip(sandboxSkip);
    await fn();
  });

let w: Watcher;
let tab = "";

real("the assistant's tab is cast to a watcher, and the person's own tab never is", async () => {
  w = await watch();
  try {
    tab = (await svc.openTab("assistant", `${base}/anim`)).id;
  } catch (error) {
    if (process.platform === "linux" && error instanceof BrowserError && error.code === "unavailable") {
      sandboxSkip = `the browser could not start sandboxed on this Linux machine: ${error.message}`;
      console.log(`SKIPPED: ${sandboxSkip}`);
      return;
    }
    throw error;
  }
  await until(() => w.states.at(-1)?.tab === tab, "the state to name the assistant's tab");
  await until(() => w.frames.length >= 3, "pictures of the animated page");
  assert.ok(w.frames.every((f) => f.tabId === tab));
  assert.deepEqual([...w.frames[0]!.jpeg.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
  const mine = await svc.openTab("you", `${base}/still`);
  const seen = w.frames.length;
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(w.frames.length > seen, "the assistant's page goes on animating");
  assert.ok(w.frames.every((f) => f.tabId === tab), `no picture of the person's tab (${mine.id}) was sent`);
});

real("a click sent by a watcher does nothing, where the same click made by the service does", async () => {
  await svc.navigate(tab, `${base}/click`);
  await new Promise((r) => setTimeout(r, 300));
  const before = clicks;
  w.ws.send(JSON.stringify({ type: "mouse", id: tab, input: { type: "mousePressed", x: 30, y: 25, button: "left", clickCount: 1 } }));
  w.ws.send(JSON.stringify({ type: "mouse", id: tab, input: { type: "mouseReleased", x: 30, y: 25, button: "left", clickCount: 1 } }));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(clicks, before, "read only");
  await svc.click(tab, { x: 30, y: 25 });
  await until(() => clicks === before + 1, "the click the service made");
});

real("a page that is not changing still gets a picture, and the watcher is told when the tab is gone", async () => {
  await svc.resetAssistant();
  await until(() => w.states.at(-1)?.tab === null, "the tab to go");
  const seen = w.frames.length;
  const quiet = (await svc.openTab("assistant", `${base}/still`)).id;
  await until(() => w.states.at(-1)?.tab === quiet, "the state to name the new tab");
  await until(() => w.frames.slice(seen).some((f) => f.tabId === quiet), "a picture of the quiet page", 8_000);
  w.ws.close();
});
