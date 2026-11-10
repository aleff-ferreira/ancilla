import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionQuestionCard } from "../src/components/browser/ActionQuestion.js";
import { AssistantBarView, type AssistantBarViewProps } from "../src/components/browser/AssistantBar.js";
import { parseWatchState, watchUrl } from "../src/components/browser/protocol.js";
import type { SocketLike } from "../src/components/browser/session.js";
import { AssistantWatch, EMPTY_WATCH, type WatchView } from "../src/components/browser/watch.js";

/**
 * The assistant's side of the Browser panel: what a watcher is told and what it makes of it, and the bar that shows it, with the
 * question's four answers, a Stop, and when nothing is going on the box that starts a task and the saved sites.
 */

const job = (over: Record<string, unknown> = {}) => ({ taskId: "t_1", goal: "Find the opening hours", steps: ["Opened shop.example", "Read the page"], startedAt: 5, question: null, ...over });
const state = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "state", tab: "T7", job: job(), ...over });

const action = { type: "action", origin: "https://shop.example", kind: "public", page: "Your cart", what: "Click “Place order”, which sends a form to https://shop.example/order", fields: [{ name: "item", value: "Blue Widget" }, { name: "password", value: "••••••••" }, { name: "note", value: "" }] };

describe("an action the assistant wants to take", () => {
  it("is read from the watcher's state, with its fields, and a site question stays what it was", () => {
    const told = parseWatchState(state({ job: job({ question: action }) }))?.job?.question;
    assert.deepEqual(told, action);
    assert.deepEqual(parseWatchState(state({ job: job({ question: { type: "site", origin: "https://a.example", kind: "public" } }) }))?.job?.question, { origin: "https://a.example", kind: "public" });
    assert.deepEqual(parseWatchState(state({ job: job({ question: { ...action, fields: [{ name: "a", value: "b" }, { name: 3 }, null, "x"], page: 7 } }) }))?.job?.question, { ...action, page: "", fields: [{ name: "a", value: "b" }] });
    assert.equal(parseWatchState(state({ job: job({ question: { type: "action", origin: "https://a.example" } }) }))?.job?.question?.hasOwnProperty("what"), false, "an action with no words is not shown as one");
  });

  it("is shown with what it is, where, and what will be sent, and two answers", () => {
    const html = renderToStaticMarkup(createElement(ActionQuestionCard, { question: action as never, onAnswer: () => undefined }));
    assert.match(html, /The assistant wants to/);
    assert.ok(html.includes("Click “Place order”, which sends a form to https://shop.example/order"));
    assert.ok(html.includes("“Your cart” at https://shop.example"));
    for (const text of ["item", "Blue Widget", "password", "••••••••", "(empty)"]) assert.ok(html.includes(text), text);
    assert.match(html, />Do it</);
    assert.match(html, />Don(&#x27;|')t</);
    assert.match(html, /asks again next time/);
    assert.match(renderToStaticMarkup(createElement(ActionQuestionCard, { question: { ...action, kind: "local" } as never, onAnswer: () => undefined })), /a page on this computer or your network/);
  });

  it("takes the place of the site question in the bar, with Stop still there", () => {
    const html = renderToStaticMarkup(createElement(AssistantBarView, props({ watch: watching({ question: action }) })));
    assert.match(html, /An action the assistant wants to take/);
    assert.match(html, />Do it</);
    assert.doesNotMatch(html, /Allow for this task/);
    assert.doesNotMatch(html, /A site the assistant wants to open/);
    assert.match(html, />Stop</);
  });
});

describe("what a watcher is told", () => {
  it("reads a state message, and refuses anything that is not one", () => {
    assert.deepEqual(parseWatchState(state()), { tab: "T7", job: job() });
    assert.deepEqual(parseWatchState(state({ tab: null, job: null })), { tab: null, job: null });
    assert.deepEqual(parseWatchState(state({ job: job({ question: { origin: "http://localhost:5173", kind: "local" } }) }))?.job?.question, { origin: "http://localhost:5173", kind: "local" });
    assert.equal(parseWatchState(state({ job: job({ question: { origin: "https://a.example", kind: "odd" } }) }))?.job?.question?.kind, "public", "an unknown kind is not taken for local");
    assert.equal(parseWatchState(state({ job: job({ steps: Array.from({ length: 12 }, (_, i) => `s${i}`) }) }))?.job?.steps.length, 8);
    assert.deepEqual(parseWatchState(state({ job: job({ steps: ["a", 5, null, "b"] }) }))?.job?.steps, ["a", "b"]);
    for (const bad of ["", "nope", "[]", "null", '{"type":"tabs"}', '{"type":"state","job":7}', '{"type":"state","tab":"T1","job":{"goal":"x","steps":[]}}']) assert.equal(parseWatchState(bad), null, bad);
  });

  it("finds the watcher's address from the pane's, and only from a pane's", () => {
    assert.equal(watchUrl("ws://127.0.0.1:3127/api/browser/ws"), "ws://127.0.0.1:3127/api/browser/watch");
    assert.equal(watchUrl("wss://ancilla.example/base/api/browser/ws?x=1"), "wss://ancilla.example/base/api/browser/watch?x=1");
    assert.equal(watchUrl("ws://127.0.0.1:3127/api/voice/ws"), null);
    assert.equal(watchUrl(null), null);
    assert.equal(watchUrl("not a url"), null);
  });
});

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(data: unknown): void {
    this.onmessage?.({ data });
  }
  end(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

function frameBytes(seq: number, tab: string): ArrayBuffer {
  const id = new TextEncoder().encode(tab);
  const out = new Uint8Array(10 + id.length + 3);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0x03);
  view.setUint32(1, seq, true);
  view.setUint16(5, 1280, true);
  view.setUint16(7, 800, true);
  view.setUint8(9, id.length);
  out.set(id, 10);
  out.set([0xff, 0xd8, 0xd9], 10 + id.length);
  return out.buffer;
}

describe("the watcher's connection", () => {
  it("follows what the server says, draws the pictures of the tab it names and acknowledges each once drawn, and says nothing else", () => {
    const sockets: FakeSocket[] = [];
    const views: WatchView[] = [];
    const drawn: number[] = [];
    const dones: Array<() => void> = [];
    const watch = new AssistantWatch({
      url: () => "ws://127.0.0.1:1/api/browser/watch",
      open: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onChange: (v) => views.push(v),
      onFrame: (frame, done) => {
        drawn.push(frame.seq);
        dones.push(done);
      },
    });
    watch.connect();
    const s = sockets[0] as FakeSocket;
    assert.equal(s.binaryType, "arraybuffer");
    assert.equal(watch.current.status, "connecting");
    s.open();
    assert.equal(watch.current.status, "open");
    s.say(state());
    assert.deepEqual([watch.current.tab, watch.current.job?.goal], ["T7", "Find the opening hours"]);
    s.say(frameBytes(1, "T7"));
    assert.deepEqual(drawn, [1]);
    assert.deepEqual(s.sent, [], "not acknowledged before it is drawn");
    dones[0]?.();
    assert.deepEqual(s.sent, ['{"type":"ack","seq":1}']);
    s.say(frameBytes(2, "T-other"));
    assert.deepEqual(drawn, [1], "a picture of another tab is not drawn");
    assert.equal(s.sent.at(-1), '{"type":"ack","seq":2}', "but it is acknowledged, so the server goes on");
    s.say("not a state");
    s.say(new ArrayBuffer(3));
    assert.equal(watch.current.tab, "T7");
    assert.ok(s.sent.every((m) => JSON.parse(m).type === "ack"), "only acknowledgements are ever sent");
    s.end();
    assert.deepEqual([watch.current.status, watch.current.tab, watch.current.job], ["closed", null, null]);
    assert.ok(views.length >= 4);
  });

  it("looks again after the connection ends while it is wanted, and not after it was let go", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const watch = new AssistantWatch({
      url: () => "ws://x/api/browser/watch",
      open: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onChange: () => undefined,
      onFrame: () => undefined,
      retryMs: 3000,
      schedule: (run) => (timers.push(run), timers.length),
      cancel: () => undefined,
    });
    watch.connect();
    (sockets[0] as FakeSocket).end();
    assert.equal(timers.length, 1);
    timers[0]?.();
    assert.equal(sockets.length, 2, "a second connection");
    watch.disconnect();
    assert.equal(watch.current.status, "closed");
    const before = timers.length;
    (sockets[1] as FakeSocket).end();
    assert.equal(timers.length, before, "no retry for a connection that was let go");
    const none = new AssistantWatch({ url: () => null, open: () => new FakeSocket(), onChange: () => undefined, onFrame: () => undefined });
    none.connect();
    assert.equal(none.current.status, "closed", "no browser to watch");
  });
});

const props = (over: Partial<AssistantBarViewProps> = {}): AssistantBarViewProps => ({
  watch: EMPTY_WATCH,
  sites: null,
  sitesOpen: false,
  draft: "",
  busy: false,
  error: null,
  onDraft: () => undefined,
  onAsk: () => undefined,
  onStop: () => undefined,
  onAnswer: () => undefined,
  onAction: () => undefined,
  onToggleSites: () => undefined,
  onRemove: () => undefined,
  ...over,
});
const render = (p: AssistantBarViewProps) => renderToStaticMarkup(createElement(AssistantBarView, p));
const watching = (over: Record<string, unknown> = {}): WatchView => ({ status: "open", tab: "T7", job: job(over) as WatchView["job"] });

describe("the assistant's bar in the Browser panel", () => {
  it("when nothing is going on offers a box to ask, enabled once there is something to ask, and the saved sites", () => {
    const idle = render(props());
    assert.match(idle, /Ask the assistant to look something up/);
    assert.match(idle, /disabled=""[^>]*>Ask</, "nothing to send yet");
    assert.doesNotMatch(idle, /Stop/);
    assert.doesNotMatch(idle, /<canvas/);
    assert.match(idle, /Sites it may open</);
    assert.doesNotMatch(render(props({ draft: "What are the opening hours?" })), /disabled=""[^>]*>Ask</);
    assert.match(render(props({ sitesOpen: true, sites: null })), /Loading/);
    assert.match(render(props({ sitesOpen: true, sites: [] })), /None saved\. It asks before each new site\./);
    const listed = render(props({ sitesOpen: true, sites: [{ origin: "https://a.example", decision: "allow", at: 1 }, { origin: "https://b.example", decision: "block", at: 2 }] }));
    assert.match(listed, /Sites it may open \(2\)/);
    assert.match(listed, /Always allowed/);
    assert.match(listed, /Blocked/);
    assert.equal((listed.match(/>Remove</g) ?? []).length, 2);
    assert.match(render(props({ error: "No browser was found on this computer." })), /No browser was found on this computer\./);
  });

  it("while the assistant browses shows what it sees and did, with a Stop, and no box to start another", () => {
    const html = render(props({ watch: watching() }));
    assert.match(html, /The assistant is browsing/);
    assert.match(html, /Find the opening hours/);
    assert.match(html, /<canvas[^>]*aria-label="What the assistant sees"/);
    assert.match(html, /Opened shop\.example/);
    assert.match(html, /Read the page/);
    assert.match(html, />Stop</);
    assert.doesNotMatch(html, /Ask the assistant to look something up/);
    assert.doesNotMatch(html, /Sites it may open/);
    assert.doesNotMatch(html, /A site the assistant wants to open/);
    assert.doesNotMatch(render(props({ watch: { status: "open", tab: null, job: job() as WatchView["job"] } })), /<canvas/, "no tab, nothing to draw");
    assert.match(render(props({ watch: watching({ steps: ["a", "b", "c", "d", "e", "f"] }) })), /<li[^>]*>f<\/li>/);
    assert.doesNotMatch(render(props({ watch: watching({ steps: ["a", "b", "c", "d", "e", "f"] }) })), /<li[^>]*>b<\/li>/, "the last four");
  });

  it("asks the question when a site waits, with the four answers, and says when it leads inside", () => {
    const html = render(props({ watch: watching({ question: { origin: "https://shop.example", kind: "public" } }) }));
    assert.match(html, /A site the assistant wants to open/);
    assert.match(html, /It wants to open <span[^>]*>https:\/\/shop\.example<\/span>\. Allow it\?/);
    for (const label of ["Allow for this task", "Always allow", "Not now", "Block"]) assert.match(html, new RegExp(`>${label}<`), label);
    assert.doesNotMatch(html, /on this computer/);
    const local = render(props({ watch: watching({ question: { origin: "http://localhost:5173", kind: "local" } }) }));
    assert.match(local, /http:\/\/localhost:5173<\/span> \(a page on this computer or your network\)\. Allow it\?/);
    assert.match(render(props({ watch: watching({ question: { origin: "https://shop.example", kind: "public" } }), busy: true })), /disabled=""[^>]*>Allow for this task</);
  });
});
