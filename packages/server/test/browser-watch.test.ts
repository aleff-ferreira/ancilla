import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { decodeFrame } from "../src/browser/protocol.js";
import { BrowserService } from "../src/browser/service.js";
import type { ActionQuestion, SiteQuestion } from "../src/browser/sites.js";
import { BROWSER_WATCH_PATH, BrowserWatchServer, type WatchSource } from "../src/browser/watch.js";
import { fakeBrowser, healthy, type FakeBrowser } from "./browser-fake.js";
import { waitFor } from "./harness.js";

/**
 * The Browser panel's second socket: the assistant's tab and its task, watched and never touched. Over a scripted browser,
 * with the runner replaced by a source whose job the test changes.
 */

const FOUND = { browser: { kind: "edge" as const, path: "/fake/edge" } };
const sent = (fake: FakeBrowser, method: string) => fake.calls.filter((c) => c.method === method);

type Job = NonNullable<ReturnType<WatchSource["current"]>>;

class Source implements WatchSource {
  job: Job | null = null;
  private readonly listeners = new Set<() => void>();
  current(): Job | null {
    return this.job;
  }
  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(job: Job | null): void {
    this.job = job;
    for (const l of [...this.listeners]) l();
  }
  get listening(): number {
    return this.listeners.size;
  }
}

interface Watcher {
  ws: WebSocket;
  states: Array<Record<string, any>>;
  frames: Array<NonNullable<ReturnType<typeof decodeFrame>>>;
  send(message: unknown): void;
  ack(seq: number): void;
}

function watch(url: string, autoAck = true): Promise<Watcher> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const states: Watcher["states"] = [];
    const frames: Watcher["frames"] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = decodeFrame(data as Buffer);
        if (!frame) return;
        frames.push(frame);
        if (autoAck) ws.send(JSON.stringify({ type: "ack", seq: frame.seq }));
      } else states.push(JSON.parse(String(data)));
    });
    ws.on("error", reject);
    ws.on("open", () => resolve({ ws, states, frames, send: (m) => ws.send(JSON.stringify(m)), ack: (seq) => ws.send(JSON.stringify({ type: "ack", seq })) }));
  });
}

async function rig(extra: (method: string, params: Record<string, any>, sessionId?: string) => unknown = () => undefined) {
  const fake = fakeBrowser(healthy(extra));
  const service = new BrowserService({ dataDir: ":memory:", find: () => FOUND, launch: () => fake.proc, gracefulMs: 200 });
  const source = new Source();
  const server = new BrowserWatchServer(() => service, () => source, () => undefined);
  const http: Server = createServer();
  http.on("upgrade", (req, socket, head) => server.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  after(async () => {
    server.close();
    await service.dispose();
    http.closeAllConnections?.();
    http.close();
  });
  const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}${BROWSER_WATCH_PATH}`;
  return { fake, service, source, server, url };
}

const jpeg = (text: string) => Buffer.from(text).toString("base64");
const frame = (fake: FakeBrowser, session: string, text: string, n = 1) => fake.emit("Page.screencastFrame", { data: jpeg(text), sessionId: n, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, session);
const question: SiteQuestion = { type: "site", id: "sq_secret", taskId: "t_1", origin: "https://a.example", kind: "public", at: 7 };
const job = (over: Partial<Job> = {}): Job => ({ taskId: "t_1", goal: "Find the opening hours", steps: ["Opened a.example"], startedAt: 5, question: null, ...over });
const last = (w: Watcher) => w.states.at(-1) as Record<string, any>;

describe("the assistant's watcher", () => {
  it("says nothing is on until the assistant has a tab, then casts that tab and only that one", async () => {
    const r = await rig();
    const w = await watch(r.url);
    await waitFor(() => w.states.length >= 1, "the first state");
    assert.deepEqual(last(w), { type: "state", tab: null, job: null });
    assert.equal(sent(r.fake, "Page.startScreencast").length, 0, "nothing is cast while there is nothing to see");

    const mine = await r.service.openTab("you");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(sent(r.fake, "Page.startScreencast").length, 0, "the person's own tabs are never cast to a watcher");
    assert.equal(last(w).tab, null);

    const theirs = await r.service.openTab("assistant");
    await waitFor(() => last(w).tab === theirs.id, "the state to name the assistant's tab");
    const casts = sent(r.fake, "Page.startScreencast");
    assert.equal(casts.length, 1);
    assert.equal(casts[0]?.sessionId, `S-${theirs.id}`);

    frame(r.fake, `S-${theirs.id}`, "assistant-one");
    await waitFor(() => w.frames.length === 1, "a picture of the assistant's tab");
    assert.equal(w.frames[0]?.tabId, theirs.id);
    assert.equal(w.frames[0]?.jpeg.toString(), "assistant-one");
    frame(r.fake, `S-${mine.id}`, "person-secret", 2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(w.frames.length, 1, "a frame of the person's tab is not sent, whatever the browser says");
    w.ws.close();
  });

  it("tells what the task is doing, with the question as a site and no id, and takes the task away when it ends", async () => {
    const r = await rig();
    const w = await watch(r.url);
    await waitFor(() => w.states.length >= 1, "the first state");
    const steps = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`);
    r.source.set(job({ goal: "g".repeat(500), steps, question }));
    await waitFor(() => last(w).job !== null, "the task");
    const told = last(w).job as Record<string, any>;
    assert.equal(told.goal.length, 300);
    assert.deepEqual(told.steps, steps.slice(-8));
    assert.deepEqual(told.question, { type: "site", origin: "https://a.example", kind: "public" }, "the site and where it leads, nothing to act on");
    assert.equal(JSON.stringify(last(w)).includes("sq_secret"), false);
    r.source.set(job({ question: null }));
    await waitFor(() => last(w).job.question === null, "the question to go");
    r.source.set(null);
    await waitFor(() => last(w).job === null, "the task to go");
    w.ws.close();
  });

  it("tells an action the person is asked to allow: what, where and what will be sent, still with no id", async () => {
    const r = await rig();
    const w = await watch(r.url);
    await waitFor(() => w.states.length >= 1, "the first state");
    const action: ActionQuestion = { type: "action", id: "sq_secret", taskId: "t_1", origin: "https://shop.example", kind: "public", at: 7, page: "Cart", what: "Click “Place order”", fields: [{ name: "item", value: "Blue Widget" }] };
    r.source.set(job({ question: action }));
    await waitFor(() => last(w).job?.question?.type === "action", "the action");
    assert.deepEqual((last(w).job as Record<string, any>).question, { type: "action", origin: "https://shop.example", kind: "public", page: "Cart", what: "Click “Place order”", fields: [{ name: "item", value: "Blue Widget" }] });
    assert.equal(JSON.stringify(last(w)).includes("sq_secret"), false, "nothing a window could act on");
    w.ws.close();
  });

  it("is read only: nothing a watcher sends is carried out, and only an acknowledgement is heard", async () => {
    const r = await rig();
    await r.service.openTab("assistant");
    const w = await watch(r.url, false);
    await waitFor(() => sent(r.fake, "Page.startScreencast").length === 1, "the cast");
    const before = r.fake.calls.length;
    const mouse = { type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 };
    for (const message of [
      { type: "hello", v: 1, takeover: true },
      { type: "mouse", id: "T1", input: mouse },
      { type: "key", id: "T1", input: { type: "keyDown", key: "Enter" } },
      { type: "text", id: "T1", text: "typed" },
      { type: "navigate", id: "T1", url: "https://evil.example/" },
      { type: "open", url: "https://evil.example/" },
      { type: "close", id: "T1" },
      { type: "activate", id: "T1" },
      { type: "viewport", id: "T1", width: 300, height: 300 },
      { type: "dialog", id: "T1", accept: true },
    ]) w.send(message);
    w.ws.send(Buffer.from([1, 2, 3]));
    w.ws.send("not json");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = r.fake.calls.slice(before).filter((c) => !/^(Page\.(bringToFront|captureScreenshot))$/.test(c.method));
    assert.deepEqual(after, [], "no input, navigation, tab change or resize reached the browser");
    assert.equal(w.ws.readyState, WebSocket.OPEN, "and the socket was not hurt by them");

    // One picture at a time until it is acknowledged.
    const session = `S-${(await r.service.listTabs()).find((t) => t.context === "assistant")?.id}`;
    frame(r.fake, session, "one", 1);
    await waitFor(() => w.frames.length === 1, "the first picture");
    frame(r.fake, session, "two", 2);
    frame(r.fake, session, "three", 3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(w.frames.length, 1, "nothing more while the first is unacknowledged");
    w.ack(w.frames[0]?.seq ?? -1);
    await waitFor(() => w.frames.length === 2, "the newest after the ack");
    assert.equal(w.frames[1]?.jpeg.toString(), "three", "the newest, not the one in between");
    w.ws.close();
  });

  it("casts the tab once for any number of windows, gives a late one the last picture, and stops with the last one", async () => {
    const r = await rig();
    const tab = await r.service.openTab("assistant");
    const a = await watch(r.url);
    const b = await watch(r.url);
    await waitFor(() => sent(r.fake, "Page.startScreencast").length >= 1 && r.source.listening === 1, "the cast");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent(r.fake, "Page.startScreencast").length, 1, "one cast, whoever watches");
    assert.equal(r.source.listening, 1, "and one listener on the task");
    frame(r.fake, `S-${tab.id}`, "shared");
    await waitFor(() => a.frames.length === 1 && b.frames.length === 1, "the picture in both windows");
    const late = await watch(r.url);
    await waitFor(() => late.frames.length === 1, "the last picture for a window that came late");
    assert.equal(late.frames[0]?.jpeg.toString(), "shared");
    a.ws.close();
    b.ws.close();
    late.ws.close();
    await waitFor(() => sent(r.fake, "Page.stopScreencast").length >= 1 && r.source.listening === 0, "the cast to stop with the last window");
    assert.equal(r.server.connections, 0);
  });

  it("follows the tab: told when it is gone, and when the browser stops", async () => {
    const r = await rig();
    const tab = await r.service.openTab("assistant");
    const w = await watch(r.url);
    await waitFor(() => last(w).tab === tab.id, "the tab");
    await r.service.closeTab(tab.id);
    await waitFor(() => last(w).tab === null, "the tab to go");
    const again = await r.service.openTab("assistant");
    await waitFor(() => last(w).tab === again.id, "the next task's tab");
    assert.equal(sent(r.fake, "Page.startScreencast").length, 2, "a new tab is cast, the old one is not");
    w.ws.close();
  });

  it("takes a picture itself when the tab is quiet", async () => {
    const shot = jpeg("jpeg-shot");
    const r = await rig((method) => (method === "Page.captureScreenshot" ? { data: shot } : undefined));
    const tab = await r.service.openTab("assistant");
    const w = await watch(r.url);
    await waitFor(() => w.frames.length === 1, "a picture taken instead");
    assert.equal(w.frames[0]?.tabId, tab.id);
    assert.equal(w.frames[0]?.jpeg.toString(), "jpeg-shot");
    assert.deepEqual([w.frames[0]?.width, w.frames[0]?.height], [1280, 800]);
    w.ws.close();
  });
});
