import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { findBrowser } from "../src/browser/find.js";
import { BROWSER_PROTOCOL_VERSION, decodeFrame } from "../src/browser/protocol.js";
import { BrowserService } from "../src/browser/service.js";
import { BROWSER_SOCKET_PATH, BrowserSocketServer } from "../src/browser/ws.js";

/**
 * The pane's socket against a real browser (whichever Edge, Chrome, Chromium or Brave this machine has; skipped with
 * the reason when there is none): the whole path a person's click and keys take and the pictures that come back.
 */

const found = findBrowser();
const SKIP: string | false = found.browser ? false : `no browser to drive: ${found.reason}`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Fixture</title>
<style>body{margin:0;font:16px sans-serif} .abs{position:absolute;left:20px;width:300px;height:40px}</style>
<button id="b" class="abs" style="top:20px;background:#c00;color:#fff" onclick="this.style.background=this.style.background==='rgb(0, 0, 204)'?'#c00':'#00c';fetch('/log?kind=click')">Colour</button>
<a id="l" class="abs" style="top:80px" href="/next">Go next</a>
<input id="i" class="abs" style="top:140px;box-sizing:border-box" oninput="fetch('/log?kind=input&v='+encodeURIComponent(this.value))">
<select id="s" class="abs" style="top:200px" onchange="fetch('/log?kind=select&v='+encodeURIComponent(this.value))"><option value="um">Um</option><option value="dois">Dois</option><option value="tres">Três</option></select>
<button id="d" class="abs" style="top:260px" onclick="alert('oi');fetch('/log?kind=alerted')">Dialog</button>
<a id="p" class="abs" style="top:320px" href="/popup" target="_blank">Popup</a>
<div id="anim" style="position:absolute;left:400px;top:20px;width:50px;height:50px;background:#080"></div>
<script>let n=0;function t(){n++;document.getElementById('anim').style.transform='translate('+(n%200)+'px,'+((n*3)%300)+'px)';if(location.search==='?anim')requestAnimationFrame(t)}t();
if(location.search==='?anim')requestAnimationFrame(t)</script>`;

let http: Server;
let base = "";
let dataDir = "";
let service: BrowserService;
let sockets: BrowserSocketServer;
let paneHttp: Server;
let socketUrl = "";
const logs: Array<{ kind: string; v?: string }> = [];
const metrics: Record<string, unknown> = {};

before(async () => {
  if (SKIP) return;
  dataDir = mkdtempSync(join(tmpdir(), "ancilla-browser-real-pane-"));
  http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/log") {
      logs.push({ kind: url.searchParams.get("kind") ?? "", ...(url.searchParams.get("v") !== null ? { v: url.searchParams.get("v") as string } : {}) });
      res.writeHead(204);
      return void res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/next") return void res.end("<!doctype html><title>Arrived</title><h1>Arrived</h1>");
    if (url.pathname === "/popup") return void res.end("<!doctype html><title>Popup page</title><h1>Popup</h1>");
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  service = new BrowserService({ dataDir, log: (line) => console.log(`# service: ${line}`) });
  sockets = new BrowserSocketServer(() => service, (line) => console.log(`# pane: ${line}`));
  paneHttp = createServer();
  paneHttp.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => paneHttp.listen(0, "127.0.0.1", resolve));
  socketUrl = `ws://127.0.0.1:${(paneHttp.address() as AddressInfo).port}${BROWSER_SOCKET_PATH}`;
});

after(async () => {
  if (SKIP) return;
  sockets.close();
  await service.dispose().catch(() => undefined);
  http.closeAllConnections?.();
  http.close();
  paneHttp.closeAllConnections?.();
  paneHttp.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may hold a profile file (Default\DIPS) for a moment after the browser exits; a leftover temp folder is not a failure
  }
  console.log(`PANE-METRICS ${JSON.stringify({ browser: found.browser, ...metrics })}`);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test("a pane over a real browser: pictures, a click that navigates, accented text, a select, a dialog, a popup and the selection", { skip: SKIP, timeout: 120_000 }, async () => {
  const ws = new WebSocket(socketUrl);
  const texts: Array<Record<string, any>> = [];
  const frames: Array<{ at: number; tabId: string; seq: number; width: number; height: number; jpeg: Buffer }> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const f = decodeFrame(data as Buffer);
      if (!f) return;
      frames.push({ at: performance.now(), ...f });
      ws.send(JSON.stringify({ type: "ack", seq: f.seq }));
    } else texts.push(JSON.parse(String(data)));
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const last = (type: string) => [...texts].reverse().find((m) => m.type === type);
  const click = (id: string, x: number, y: number) => {
    send({ type: "mouse", id, input: { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 } });
    send({ type: "mouse", id, input: { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 } });
  };

  send({ type: "hello", v: BROWSER_PROTOCOL_VERSION, takeover: false });
  await until(() => last("ready") !== undefined || last("error") !== undefined, "ready", 40_000);
  assert.ok(last("ready"), `the pane was not told ready: ${JSON.stringify(last("error"))}`);
  const first = (last("ready") as { tabs: Array<{ id: string }> }).tabs[0]!.id;
  send({ type: "viewport", id: first, width: 800, height: 600 });
  send({ type: "navigate", id: first, url: `${base}/` });
  await until(() => frames.some((f) => f.tabId === first && f.jpeg[0] === 0xff && f.jpeg[1] === 0xd8), "a JPEG frame");
  await until(() => (last("tabs") as { tabs: Array<{ id: string; title: string }> } | undefined)?.tabs.some((t) => t.title === "Fixture") === true, "the page title");
  // The first picture may predate the viewport; one at the size asked for follows.
  await until(() => frames.some((f) => f.tabId === first && f.width === 800 && f.height === 600), "a picture at the viewport's size");

  // Click to updated pixels over the whole path, alternating the button's colour so each click changes the picture.
  const latencies: number[] = [];
  for (let i = 0; i < 24; i++) {
    await sleep(150);
    const baseline = frames[frames.length - 1]!.jpeg;
    const t0 = performance.now();
    click(first, 100, 40);
    const changed = () => frames.find((f) => f.at > t0 && Buffer.compare(f.jpeg, baseline) !== 0);
    await until(() => changed() !== undefined, `a changed picture after click ${i}`, 3000);
    latencies.push(changed()!.at - t0);
  }
  latencies.sort((a, b) => a - b);
  metrics["clickToPixelMs"] = { p50: Math.round(percentile(latencies, 0.5)), p95: Math.round(percentile(latencies, 0.95)), max: Math.round(latencies.at(-1) as number), n: latencies.length };

  // Frames per second on an animated page, the pane acknowledging at once.
  send({ type: "navigate", id: first, url: `${base}/?anim` });
  await sleep(600);
  const mark = frames.length;
  const t1 = performance.now();
  await sleep(2000);
  const seconds = (performance.now() - t1) / 1000;
  const got = frames.slice(mark);
  metrics["fps800x600"] = Number((got.length / seconds).toFixed(1));
  metrics["kbPerFrame"] = Math.round(got.reduce((n, f) => n + f.jpeg.length, 0) / Math.max(1, got.length) / 1024);

  // Text with accents reaches the field whole, and the selection can be read back.
  send({ type: "navigate", id: first, url: `${base}/` });
  await sleep(400);
  click(first, 100, 160);
  send({ type: "text", id: first, text: "ção ã é ~ ´" });
  await until(() => logs.some((l) => l.kind === "input" && l.v === "ção ã é ~ ´"), "the accented text in the field");
  send({ type: "key", id: first, input: { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] } });
  await sleep(100);
  send({ type: "selection", id: first });
  await until(() => last("selection") !== undefined, "the selection");
  assert.equal(last("selection")?.text, "ção ã é ~ ´");

  // A select: the pane is told its options, the press and release never reach the page, and the choice fires change.
  click(first, 100, 220);
  await until(() => last("select") !== undefined, "the select's options");
  assert.deepEqual(last("select")?.probe.options.map((o: { label: string }) => o.label), ["Um", "Dois", "Três"]);
  send({ type: "choose", id: first, index: 2 });
  await until(() => logs.some((l) => l.kind === "select" && l.v === "tres"), "the change event");

  // A dialog is reported and answered.
  click(first, 100, 280);
  await until(() => last("dialog") !== undefined, "the dialog");
  assert.equal(last("dialog")?.dialog.message, "oi");
  send({ type: "dialog", id: first, accept: true });
  await until(() => logs.some((l) => l.kind === "alerted"), "the page going on after the dialog");

  // A link with target=_blank is a new tab, in front.
  const tabsBefore = (last("tabs") as { tabs: unknown[] }).tabs.length;
  click(first, 100, 340);
  await until(() => {
    if (process.env["PANE_DEBUG"]) console.log("TABS", JSON.stringify(last("tabs")));
    const t = last("tabs") as { tabs: Array<{ id: string; title: string }>; active: string } | undefined;
    return !!t && t.tabs.length === tabsBefore + 1 && t.active !== first && t.tabs.some((x) => x.id === t.active && x.title === "Popup page");
  }, "the popup as the active tab");
  const popupTab = (last("tabs") as { active: string }).active;
  await until(() => frames.some((f) => f.tabId === popupTab), "a frame of the popup");

  // A link click navigates the active tab.
  const switchedAt = performance.now();
  send({ type: "activate", id: first });
  await until(() => (last("tabs") as { active: string }).active === first, "switching back");
  // The page it switched back to is a still one, yet the pane gets a picture of it.
  await until(() => frames.some((f) => f.tabId === first && f.at > switchedAt), "a picture of the tab switched to");
  await sleep(300);
  click(first, 100, 100);
  await until(() => (last("tabs") as { tabs: Array<{ id: string; title: string }> }).tabs.some((t) => t.id === first && t.title === "Arrived"), "the page after the link");

  // The person's browser and the assistant's stay apart.
  const theirs = await service.openTab("assistant");
  await sleep(200);
  assert.ok(!JSON.stringify(texts.filter((m) => m.type === "tabs").at(-1)).includes(theirs.id));
  ws.close();
});

test("a second pane is turned away while the first is open", { skip: SKIP, timeout: 60_000 }, async () => {
  const a = new WebSocket(socketUrl);
  await new Promise((resolve) => a.on("open", resolve));
  a.send(JSON.stringify({ type: "hello", v: BROWSER_PROTOCOL_VERSION, takeover: false }));
  const b = new WebSocket(socketUrl);
  const code = await new Promise<number>((resolve) => {
    b.on("open", () => b.send(JSON.stringify({ type: "hello", v: BROWSER_PROTOCOL_VERSION, takeover: false })));
    b.on("close", (c) => resolve(c));
  });
  assert.equal(code, 4009);
  a.close();
});
