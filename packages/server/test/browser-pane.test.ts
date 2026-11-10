import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { BROWSER_PROTOCOL_VERSION, decodeFrame, encodeFrame, parseClientMessage } from "../src/browser/protocol.js";
import { BrowserService } from "../src/browser/service.js";
import { BROWSER_SOCKET_PATH, BrowserSocketServer, jpegSize } from "../src/browser/ws.js";
import { fakeBrowser, healthy, type FakeBrowser } from "./browser-fake.js";
import { FakeConnection, start, waitFor } from "./harness.js";

const FOUND = { browser: { kind: "edge" as const, path: "/fake/edge" } };

describe("the pane's wire format", () => {
  it("round-trips a frame with its tab and sequence, and refuses a short or foreign one", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const decoded = decodeFrame(encodeFrame(70_000, 1280, 800, "ABC123", jpeg));
    assert.deepEqual({ ...decoded, jpeg: [...(decoded?.jpeg ?? [])] }, { seq: 70_000, width: 1280, height: 800, tabId: "ABC123", jpeg: [...jpeg] });
    assert.equal(decodeFrame(Buffer.from([3, 0, 0])), null);
    assert.equal(decodeFrame(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
    assert.equal(decodeFrame(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 9, 65])), null, "an id longer than the frame");
  });

  it("reads the size a JPEG says it has, past other segments, and nothing from bytes that are not one", () => {
    const sof = (width: number, height: number) => [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
    assert.deepEqual(jpegSize(Buffer.from([0xff, 0xd8, ...sof(800, 600), 0xff, 0xd9])), { width: 800, height: 600 });
    // A start of image, a quantization table (4 bytes of length and data), a Huffman table (0xC4, which is not a frame) and then the frame.
    const tables = [0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x03, 0x00];
    assert.deepEqual(jpegSize(Buffer.from([0xff, 0xd8, ...tables, ...sof(1280, 720)])), { width: 1280, height: 720 });
    assert.equal(jpegSize(Buffer.from("jpeg-shot")), null, "not a JPEG");
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00])), null, "cut short");
    assert.equal(jpegSize(Buffer.alloc(0)), null);
  });

  it("parses what is allowed and drops the rest without throwing", () => {
    assert.deepEqual(parseClientMessage('{"type":"hello","v":1}'), { type: "hello", v: 1, takeover: false });
    assert.deepEqual(parseClientMessage('{"type":"open","url":null}'), { type: "open", url: null });
    assert.deepEqual(parseClientMessage('{"type":"viewport","id":"T1","width":800,"height":600}'), { type: "viewport", id: "T1", width: 800, height: 600 });
    assert.deepEqual(parseClientMessage('{"type":"mouse","id":"T1","input":{"type":"mousePressed","x":10,"y":20.5,"button":"left","clickCount":1,"evil":1}}'), {
      type: "mouse", id: "T1", input: { type: "mousePressed", x: 10, y: 20.5, button: "left", clickCount: 1 },
    });
    assert.deepEqual(parseClientMessage('{"type":"key","id":"T1","input":{"type":"keyDown","key":"a","commands":["selectAll","rm -rf"]}}'), {
      type: "key", id: "T1", input: { type: "keyDown", key: "a", commands: ["selectAll"] },
    });
    assert.deepEqual(parseClientMessage('{"type":"text","id":"T1","text":"ção ã é"}'), { type: "text", id: "T1", text: "ção ã é" });
    for (const bad of [
      "", "nope", "[]", "null", '{"type":"nope"}', '{"type":"navigate","id":"T 1","url":"x"}', '{"type":"navigate","id":"T1","url":5}',
      '{"type":"mouse","id":"T1","input":{"type":"mousePressed","x":"1","y":2}}', '{"type":"mouse","id":"T1","input":{"type":"drag","x":1,"y":2}}',
      '{"type":"text","id":"T1","text":""}', '{"type":"ack","seq":-1}', '{"type":"choose","id":"T1","index":1.5e9}', '{"type":"dialog","id":"T1"}',
      `{"type":"navigate","id":"T1","url":"${"a".repeat(5000)}"}`,
    ]) assert.equal(parseClientMessage(bad), null, bad.slice(0, 40));
  });
});

describe("the front door of the pane's socket", () => {
  it("refuses no token, a wrong token, another site and a foreign host, and lets the right ones through", async () => {
    const { base } = await start(new FakeConnection(), { token: "s3cret", allowOrigins: ["https://listed.example"] });
    const url = `${base.replace("http", "ws")}${BROWSER_SOCKET_PATH}`;
    const port = new URL(base).port;
    const attempt = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.on("open", () => {
          ws.close();
          resolve(101);
        });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => undefined);
      });
    assert.equal(await attempt({}), 401, "no token");
    assert.equal(await attempt({ authorization: "Bearer wrong" }), 401, "a wrong token");
    assert.equal(await attempt({ authorization: "Bearer s3cret", origin: "https://evil.example" }), 403, "another site, token or not");
    assert.equal(await attempt({ cookie: "ancilla_token=s3cret", origin: "https://evil.example" }), 403, "its cookie does not help it");
    assert.equal(await attempt({ cookie: "ancilla_token=s3cret", host: "evil.example" }), 403, "a foreign host with only a cookie");
    assert.equal(await attempt({ cookie: "ancilla_token=s3cret", origin: `http://127.0.0.1:${port}` }), 101, "the page served from here");
    assert.equal(await attempt({ authorization: "Bearer s3cret" }), 101, "a bearer token");
  });
});

interface Pane {
  ws: WebSocket;
  texts: Array<Record<string, any>>;
  frames: Array<ReturnType<typeof decodeFrame>>;
  send(message: unknown): void;
  waitFor(predicate: (m: Record<string, any>) => boolean, what: string): Promise<Record<string, any>>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(url: string): Promise<Pane> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const texts: Pane["texts"] = [];
    const frames: Pane["frames"] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = decodeFrame(data as Buffer);
        frames.push(frame);
        if (frame) ws.send(JSON.stringify({ type: "ack", seq: frame.seq }));
      } else texts.push(JSON.parse(String(data)));
    });
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws, texts, frames, closed,
        send: (m) => ws.send(JSON.stringify(m)),
        waitFor: async (predicate, what) => {
          let found: Record<string, any> | undefined;
          await waitFor(() => (found = texts.find(predicate)) !== undefined, what);
          return found as Record<string, any>;
        },
      }),
    );
  });
}

/** A pane server over a service whose browser is scripted. */
async function rig(extra: (method: string, params: Record<string, any>, sessionId?: string) => unknown = () => undefined) {
  const fake = fakeBrowser(healthy(extra));
  const service = new BrowserService({ dataDir: ":memory:", find: () => FOUND, launch: () => fake.proc, gracefulMs: 200 });
  const sockets = new BrowserSocketServer(() => service, () => undefined);
  const http: Server = createServer();
  http.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  after(async () => {
    sockets.close();
    await service.dispose();
    http.closeAllConnections?.();
    http.close();
  });
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${BROWSER_SOCKET_PATH}`;
  return { fake, service, url };
}

const hello = (takeover = false) => ({ type: "hello", v: BROWSER_PROTOCOL_VERSION, takeover });
const sent = (fake: FakeBrowser, method: string) => fake.calls.filter((c) => c.method === method);

/** The smallest bytes that say a size the way a JPEG does: a start of image and a start of frame. */
const jpegOf = (width: number, height: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);

/**
 * A browser whose pictures follow the size it was told to emulate (the browser keeps it within 100 to 4096). Its screencast is
 * silent when first started; started again, it sends a picture of the emulated size if `restartSends`. Its first
 * `screenshotFails` screenshots are refused, and the next `staleShots` show the size from before the emulation.
 */
function followsEmulation(options: { restartSends: boolean; screenshotFails?: number; staleShots?: number }) {
  let emulated = { width: 1280, height: 800 };
  let starts = 0;
  let shots = 0;
  let browser: FakeBrowser | null = null;
  const handler = (method: string, params: Record<string, any>): unknown => {
    if (method === "Emulation.setDeviceMetricsOverride") emulated = { width: Math.min(4096, Math.max(100, params["width"])), height: Math.min(4096, Math.max(100, params["height"])) };
    if (method === "Page.startScreencast") {
      starts += 1;
      if (options.restartSends && starts > 1) {
        const size = { ...emulated };
        setImmediate(() => browser?.emit("Page.screencastFrame", { data: jpegOf(size.width, size.height).toString("base64"), sessionId: starts, metadata: { deviceWidth: size.width, deviceHeight: size.height } }, "S-T0"));
      }
    }
    if (method === "Page.captureScreenshot") {
      shots += 1;
      const refused = options.screenshotFails ?? 0;
      if (shots <= refused) throw new Error("Unable to capture screenshot");
      if (shots <= refused + (options.staleShots ?? 0)) return { data: jpegOf(1280, 800).toString("base64") };
      return { data: jpegOf(emulated.width, emulated.height).toString("base64") };
    }
    return undefined;
  };
  return { handler, bind: (fake: FakeBrowser) => void (browser = fake) };
}

describe("the pane's socket", () => {
  it("says hello with the person's tabs, streams frames one at a time until each is acknowledged, and forwards input in order", async () => {
    const { fake, url } = await rig();
    const pane = await connect(url);
    pane.send(hello());
    const ready = await pane.waitFor((m) => m.type === "ready", "ready");
    assert.deepEqual(ready.tabs.map((t: { id: string }) => t.id), ["T0"]);
    assert.equal(ready.active, "T0");
    assert.equal(sent(fake, "Page.startScreencast").length, 1);
    // Frames from the browser reach the pane as binary, tagged with the tab.
    fake.emit("Page.screencastFrame", { data: Buffer.from("jpeg-one").toString("base64"), sessionId: 1, metadata: { deviceWidth: 640, deviceHeight: 480 } }, "S-T0");
    await waitFor(() => pane.frames.length === 1, "first frame");
    assert.equal(pane.frames[0]?.tabId, "T0");
    assert.equal(pane.frames[0]?.width, 640);
    assert.equal(pane.frames[0]?.jpeg.toString(), "jpeg-one");
    // Input keeps its order: a press, then a release; the viewport and a key and some text follow.
    pane.send({ type: "viewport", id: "T0", width: 700, height: 500 });
    pane.send({ type: "mouse", id: "T0", input: { type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 } });
    pane.send({ type: "mouse", id: "T0", input: { type: "mouseReleased", x: 5, y: 6, button: "left", clickCount: 1 } });
    pane.send({ type: "key", id: "T0", input: { type: "keyDown", key: "Enter", code: "Enter", text: "\r" } });
    pane.send({ type: "text", id: "T0", text: "ção" });
    await waitFor(() => sent(fake, "Input.insertText").length === 1, "text");
    const order = fake.calls.filter((c) => c.sessionId === "S-T0" && /^Input\./.test(c.method)).map((c) => `${c.method}:${c.params["type"] ?? c.params["text"]}`);
    assert.deepEqual(order, ["Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased", "Input.dispatchKeyEvent:keyDown", "Input.insertText:ção"]);
    const metrics = sent(fake, "Emulation.setDeviceMetricsOverride").at(-1)?.params;
    assert.deepEqual([metrics?.["width"], metrics?.["height"], metrics?.["deviceScaleFactor"]], [700, 500, 1]);
    pane.ws.close();
  });

  it("takes a picture itself when a tab that was just shown sends none, and not when one comes", async () => {
    const shot = Buffer.from("jpeg-shot").toString("base64");
    const quiet = await rig((method) => (method === "Page.captureScreenshot" ? { data: shot } : undefined));
    const pane = await connect(quiet.url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    // The page never paints again: the screencast says nothing, as a popup that loaded before it was attached does not.
    await waitFor(() => pane.frames.length === 1, "a picture taken instead");
    assert.equal(pane.frames[0]?.tabId, "T0");
    assert.equal(pane.frames[0]?.jpeg.toString(), "jpeg-shot");
    assert.deepEqual([pane.frames[0]?.width, pane.frames[0]?.height], [1280, 800], "at the size the page has");
    assert.equal(sent(quiet.fake, "Page.captureScreenshot").length, 1);
    pane.ws.close();

    const busy = await rig((method) => (method === "Page.captureScreenshot" ? { data: shot } : undefined));
    const other = await connect(busy.url);
    other.send(hello());
    await other.waitFor((m) => m.type === "ready", "ready");
    busy.fake.emit("Page.screencastFrame", { data: Buffer.from("real").toString("base64"), sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } }, "S-T0");
    await waitFor(() => other.frames.length === 1, "the real picture");
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(sent(busy.fake, "Page.captureScreenshot").length, 0, "a page that paints needs no screenshot");
    assert.equal(busy.fake.calls.filter((c) => c.method === "Page.stopScreencast").length, 0, "and no restart of the stream");
    assert.equal(other.frames.length, 1);
    other.ws.close();
  });

  it("brings a tab forward before asking for its pictures, never with a repaint, and not again for a tab already on show", async () => {
    // On Linux a tab brought forward while its screencast runs can lose the screencast for good, and nothing says so.
    const { fake, url } = await rig();
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    const where = (pred: (c: FakeBrowser["calls"][number]) => boolean) => fake.calls.flatMap((c, i) => (pred(c) ? [i] : []));
    const activations = () => where((c) => c.method === "Target.activateTarget" && c.params["targetId"] === "T0");
    const starts = (session: string) => where((c) => c.method === "Page.startScreencast" && c.sessionId === session);
    assert.ok(activations()[0]! < starts("S-T0")[0]!, "at the start, the tab is brought forward before it is cast");
    pane.send({ type: "open", url: null });
    await pane.waitFor((m) => m.type === "tabs" && m.active === "T1", "the new tab on show");
    await waitFor(() => starts("S-T1").length === 1, "the new tab cast");
    pane.send({ type: "activate", id: "T0" });
    await waitFor(() => starts("S-T0").length === 2, "the first tab cast again");
    assert.ok(activations().at(-1)! < starts("S-T0").at(-1)!, "a tab switched to is brought forward before it is cast");
    assert.equal(sent(fake, "Page.bringToFront").length, 0, "no repaint is asked for");
    const before = activations().length;
    pane.send({ type: "activate", id: "T0" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(activations().length, before, "a tab already on show is not brought forward again");
    pane.ws.close();
  });

  /** A pane whose tab has shown its first picture, so that what follows is about the picture a resize owes. */
  async function shown(options: Parameters<typeof followsEmulation>[0]) {
    const quiet = followsEmulation(options);
    const { fake, url } = await rig(quiet.handler);
    quiet.bind(fake);
    const pane = await connect(url);
    pane.send(hello());
    const ready = await pane.waitFor((m) => m.type === "ready", "ready");
    fake.emit("Page.screencastFrame", { data: jpegOf(1280, 800).toString("base64"), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, "S-T0");
    await waitFor(() => pane.frames.length === 1, "the first picture");
    return { fake, pane, id: ready["tabs"][0].id as string };
  }

  it("starts a silent picture stream again after a resize, and the picture it sends is at the size asked for", async () => {
    const { fake, pane, id } = await shown({ restartSends: true, screenshotFails: 99 });
    pane.send({ type: "viewport", id, width: 800, height: 600 });
    await waitFor(() => pane.frames.some((f) => f?.width === 800 && f.height === 600), "a picture at the size asked for");
    assert.equal(sent(fake, "Page.captureScreenshot").length, 0, "starting the stream again was enough");
    assert.ok(sent(fake, "Page.stopScreencast").length >= 1);
    pane.ws.close();
  });

  it("takes a screenshot when starting the stream again brings nothing, and tells the size the picture really has", async () => {
    const { fake, pane, id } = await shown({ restartSends: false });
    // 50 x 50 is less than the browser takes: it is kept to 100 x 100, and the picture says so.
    pane.send({ type: "viewport", id, width: 50, height: 50 });
    await waitFor(() => pane.frames.some((f) => f?.width === 100 && f.height === 100), "a screenshot at the size the browser has");
    assert.equal(sent(fake, "Page.captureScreenshot").length, 1);
    pane.ws.close();
  });

  it("does not start the stream again when its first picture came before the browser said it was started", async () => {
    let browser: FakeBrowser | null = null;
    const { fake, url } = await rig((method) => {
      if (method === "Page.startScreencast") browser?.emit("Page.screencastFrame", { data: jpegOf(1280, 800).toString("base64"), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, "S-T0");
      return undefined;
    });
    browser = fake;
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    await waitFor(() => pane.frames.length === 1, "the first picture");
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(sent(fake, "Page.stopScreencast").length, 0, "no restart");
    assert.equal(sent(fake, "Page.captureScreenshot").length, 0, "and no screenshot");
    pane.ws.close();
  });

  it("owes no picture for a resize to the size the tab already shows", async () => {
    const { fake, pane, id } = await shown({ restartSends: true });
    pane.send({ type: "viewport", id, width: 1280, height: 800 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sent(fake, "Page.stopScreencast").length, 0, "no restart");
    assert.equal(sent(fake, "Page.captureScreenshot").length, 0, "and no screenshot");
    pane.ws.close();
  });

  it("sizes a tab again once its page has loaded, because the browser can drop the emulated size when a page commits", async () => {
    const { fake, url } = await rig();
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    pane.send({ type: "viewport", id: "T0", width: 800, height: 600 });
    const sizings = () => sent(fake, "Emulation.setDeviceMetricsOverride").filter((c) => c.params["width"] === 800 && c.params["height"] === 600).length;
    await waitFor(() => sizings() === 1, "the size applied");
    fake.emit("Page.frameStartedLoading", {}, "S-T0");
    fake.emit("Page.frameStoppedLoading", {}, "S-T0");
    await waitFor(() => sizings() === 2, "the size applied again after the load");
    pane.ws.close();
  });

  it("brings a blank tab it had to open forward before casting it", async () => {
    const { fake, url } = await rig((method) => (method === "Target.getTargets" ? { targetInfos: [] } : undefined));
    const pane = await connect(url);
    pane.send(hello());
    const ready = await pane.waitFor((m) => m.type === "ready", "ready");
    assert.deepEqual(ready["tabs"].map((t: { id: string }) => t.id), ["T1"]);
    const first = (pred: (c: FakeBrowser["calls"][number]) => boolean) => fake.calls.findIndex(pred);
    const activated = first((c) => c.method === "Target.activateTarget" && c.params["targetId"] === "T1");
    const cast = first((c) => c.method === "Page.startScreencast" && c.sessionId === "S-T1");
    assert.ok(activated >= 0 && cast >= 0 && activated < cast, "brought forward, then cast");
    assert.equal(sent(fake, "Page.startScreencast").length, 1, "and cast once");
    pane.ws.close();
  });

  it("keeps trying until a picture is at the size asked for: a picture of another size does not count", async () => {
    // Right after a page loads, a picture can carry the browser window's size, and a screenshot can still show the size from before.
    const { fake, pane, id } = await shown({ restartSends: false, staleShots: 1 });
    pane.send({ type: "viewport", id, width: 800, height: 600 });
    fake.emit("Page.screencastFrame", { data: jpegOf(780, 437).toString("base64"), sessionId: 2, metadata: { deviceWidth: 780, deviceHeight: 437 } }, "S-T0");
    await waitFor(() => pane.frames.some((f) => f?.width === 800 && f.height === 600), "a picture at the size asked for", 8000);
    assert.equal(sent(fake, "Page.captureScreenshot").length, 2, "the first screenshot was of the old size, the second was right");
    pane.ws.close();
  });

  it("asks for a screenshot again when the first one is refused", async () => {
    const quiet = followsEmulation({ restartSends: false, screenshotFails: 1 });
    const { fake, url } = await rig(quiet.handler);
    quiet.bind(fake);
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    await waitFor(() => pane.frames.length >= 1, "a picture after a refused screenshot", 8000);
    assert.equal(sent(fake, "Page.captureScreenshot").length, 2, "the first was refused, the second came");
    pane.ws.close();
  });

  it("holds the next picture until the last one is acknowledged", async () => {
    const { fake, url } = await rig();
    const ws = new WebSocket(url);
    const frames: number[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) frames.push(decodeFrame(data as Buffer)?.seq ?? -1);
    });
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify(hello()));
    await waitFor(() => sent(fake, "Page.startScreencast").length === 1, "screencast");
    const frame = (n: number) => fake.emit("Page.screencastFrame", { data: Buffer.from("f").toString("base64"), sessionId: n, metadata: {} }, "S-T0");
    frame(1);
    await waitFor(() => frames.length === 1, "first");
    frame(2);
    frame(3);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(frames.length, 1, "nothing more while the first is unacknowledged");
    ws.send(JSON.stringify({ type: "ack", seq: frames[0] }));
    await waitFor(() => frames.length === 2, "second after the ack");
    ws.close();
  });

  it("lets one pane control the browser: a second is told it is open elsewhere, unless it takes over", async () => {
    const { url } = await rig();
    const first = await connect(url);
    first.send(hello());
    await first.waitFor((m) => m.type === "ready", "ready");
    const second = await connect(url);
    second.send(hello());
    const busy = await second.waitFor((m) => m.type === "busy", "busy");
    assert.match(busy.message, /another window/);
    assert.equal((await second.closed).code, 4009);
    const third = await connect(url);
    third.send(hello(true));
    await third.waitFor((m) => m.type === "ready", "ready after takeover");
    assert.equal((await first.closed).code, 4010);
    third.ws.close();
  });

  it("refuses a first message that is not a hello and a protocol it does not speak", async () => {
    const { url } = await rig();
    const a = await connect(url);
    a.send({ type: "open", url: null });
    assert.equal((await a.closed).code, 4002);
    const b = await connect(url);
    b.send({ type: "hello", v: 99 });
    assert.equal((await b.closed).code, 4003);
  });

  it("never shows or touches the assistant's tabs", async () => {
    const { fake, service, url } = await rig();
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    const theirs = await service.openTab("assistant");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(pane.texts.every((m) => !(m.tabs ?? []).some((t: { id: string }) => t.id === theirs.id)), "the pane's list never has it");
    pane.send({ type: "mouse", id: theirs.id, input: { type: "mousePressed", x: 1, y: 1, button: "left" } });
    pane.send({ type: "key", id: theirs.id, input: { type: "keyDown", key: "a" } });
    pane.send({ type: "text", id: theirs.id, text: "secret" });
    pane.send({ type: "navigate", id: theirs.id, url: "https://example.com/" });
    pane.send({ type: "close", id: theirs.id });
    pane.send({ type: "selection", id: theirs.id });
    pane.send({ type: "mouse", id: "T0", input: { type: "mouseMoved", x: 1, y: 1 } });
    await waitFor(() => sent(fake, "Input.dispatchMouseEvent").length >= 1, "the person's own tab still works");
    await new Promise((r) => setTimeout(r, 80));
    const onTheirs = fake.calls.filter((c) => c.sessionId === `S-${theirs.id}` && /^(Input\.|Page\.navigate|Target\.closeTarget|Runtime\.evaluate)/.test(c.method));
    assert.deepEqual(onTheirs, []);
    assert.equal(sent(fake, "Target.closeTarget").length, 0);
    pane.ws.close();
  });

  it("asks where to save a download of its own tab (and a late pane is told), saves on `save`, and never hears of the assistant's", async () => {
    const { fake, service, url } = await rig();
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    const guid = "abcd1234-0000-1111-2222-333344445555";
    writeFileSync(join(service.downloads.dir, guid), "bytes");
    fake.emit("Browser.downloadWillBegin", { frameId: "T0", guid, url: "https://x.example/x.zip", suggestedFilename: "x.zip" });
    fake.emit("Browser.downloadProgress", { guid, totalBytes: 5, receivedBytes: 5, state: "completed" });
    const ask = await pane.waitFor((m) => m.type === "download", "the question");
    assert.equal(ask.download.name, "x.zip");
    const folder = mkdtempSync(join(tmpdir(), "ancilla-pane-dl-"));
    pane.send({ type: "save", id: guid, accept: true, folder: join(folder, "missing") });
    await pane.waitFor((m) => m.type === "error" && /does not exist/.test(m.message), "a plain refusal");
    assert.deepEqual(readdirSync(folder), [], "nothing written for a folder that is not there");
    pane.send({ type: "save", id: guid, accept: true, folder });
    await pane.waitFor((m) => m.type === "download-closed" && m.id === guid, "the question closed");
    await waitFor(() => readdirSync(folder).includes("x.zip"), "the file");
    const theirs = await service.openTab("assistant");
    writeFileSync(join(service.downloads.dir, "feed1234-0000-1111-2222-333344445555"), "z");
    fake.emit("Browser.downloadWillBegin", { frameId: theirs.id, guid: "feed1234-0000-1111-2222-333344445555", url: "https://x.example/y.zip", suggestedFilename: "y.zip" });
    fake.emit("Browser.downloadProgress", { guid: "feed1234-0000-1111-2222-333344445555", totalBytes: 1, receivedBytes: 1, state: "completed" });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(pane.texts.filter((m) => m.type === "download").length, 1, "only its own file was asked about");
    pane.ws.close();
  });

  it("answers a click on a select with the pane's own dropdown instead of a click, and applies the choice", async () => {
    const probe = { rect: { x: 1, y: 2, width: 100, height: 20 }, multiple: false, options: [{ index: 0, label: "Um", disabled: false, selected: true }, { index: 1, label: "Dois", disabled: false, selected: false }] };
    const { fake, url } = await rig((method, params) => {
      if (method === "Runtime.evaluate" && String(params["expression"]).includes("elementFromPoint")) return { result: { value: probe } };
      return undefined;
    });
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    pane.send({ type: "mouse", id: "T0", input: { type: "mousePressed", x: 10, y: 10, button: "left", clickCount: 1 } });
    pane.send({ type: "mouse", id: "T0", input: { type: "mouseReleased", x: 10, y: 10, button: "left", clickCount: 1 } });
    const select = await pane.waitFor((m) => m.type === "select", "select");
    assert.deepEqual(select.probe.options.map((o: { label: string }) => o.label), ["Um", "Dois"]);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sent(fake, "Input.dispatchMouseEvent").length, 0, "neither the press nor the release reached the page");
    pane.send({ type: "choose", id: "T0", index: 1 });
    await waitFor(() => sent(fake, "Runtime.evaluate").some((c) => String(c.params["expression"]).includes("selectedIndex = 1")), "choice applied");
    const apply = String(sent(fake, "Runtime.evaluate").at(-1)?.params["expression"]);
    assert.match(apply, /"input"/);
    assert.match(apply, /"change"/);
    pane.ws.close();
  });

  it("passes dialogs, popups, notices and the selection through, and answers a dialog", async () => {
    const { fake, url } = await rig((method) => (method === "Runtime.evaluate" ? { result: { value: "texto copiado" } } : undefined));
    const pane = await connect(url);
    pane.send(hello());
    await pane.waitFor((m) => m.type === "ready", "ready");
    fake.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Sure?", url: "about:blank" }, "S-T0");
    const dialog = await pane.waitFor((m) => m.type === "dialog", "dialog");
    assert.equal(dialog.dialog.kind, "confirm");
    pane.send({ type: "dialog", id: "T0", accept: true });
    await waitFor(() => sent(fake, "Page.handleJavaScriptDialog").length === 1, "answered");
    assert.equal(sent(fake, "Page.handleJavaScriptDialog")[0]?.params["accept"], true);
    fake.emit("Target.targetCreated", { targetInfo: { targetId: "P1", type: "page", url: "https://popup.example/", title: "", openerId: "T0" } });
    const tabs = await pane.waitFor((m) => m.type === "tabs" && m.tabs.some((t: { id: string }) => t.id === "P1") && m.active === "P1", "the popup is a tab and in front");
    assert.equal(tabs.tabs.length, 2);
    fake.emit("Page.fileChooserOpened", { mode: "selectSingle" }, "S-P1");
    assert.match((await pane.waitFor((m) => m.type === "notice" && m.kind === "file", "file notice")).text, /not available/);
    pane.send({ type: "selection", id: "P1" });
    assert.equal((await pane.waitFor((m) => m.type === "selection", "selection")).text, "texto copiado");
    pane.ws.close();
  });
});
