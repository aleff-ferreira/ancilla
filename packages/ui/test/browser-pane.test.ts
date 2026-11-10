import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogBox, Status, TabStrip, Toolbar, addressOf, tabLabel } from "../src/components/browser/BrowserPanel.js";
import { MOD_ALT, MOD_CTRL, MOD_SHIFT, TextGate, planKeyDown, planKeyUp, resolveAddress, toPagePoint, toScreenRect, type KeyLike } from "../src/components/browser/input.js";
import { decodeFrame } from "../src/components/browser/protocol.js";
import { BrowserSession, EMPTY_VIEW, type SocketLike } from "../src/components/browser/session.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";

const html = (element: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, element));

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, code: "", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra });

describe("the keys that go to the page as keys", () => {
  it("sends Enter with its text, Backspace and the arrows as raw keys, and keeps shift for selecting", () => {
    const enter = planKeyDown(key("Enter", { code: "Enter" }));
    assert.deepEqual(enter, { kind: "send", prevent: true, inputs: [{ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r" }] });
    const back = planKeyDown(key("Backspace", { code: "Backspace" }));
    assert.equal(back.kind === "send" && back.inputs[0]?.type, "rawKeyDown");
    const select = planKeyDown(key("ArrowLeft", { code: "ArrowLeft", shiftKey: true }));
    assert.equal(select.kind === "send" && select.inputs[0]?.modifiers, MOD_SHIFT);
    const space = planKeyDown(key(" ", { code: "Space" }));
    assert.equal(space.kind === "send" && space.inputs[0]?.text, " ", "a space is a key too, so a focused button can use it");
    assert.equal(planKeyUp(key("Enter", { code: "Enter" })).kind, "send");
  });

  it("maps shortcuts to editing commands and leaves the clipboard to its own events", () => {
    const all = planKeyDown(key("a", { code: "KeyA", ctrlKey: true }));
    assert.deepEqual(all.kind === "send" && all.inputs[0]?.commands, ["selectAll"]);
    const redo = planKeyDown(key("Z", { code: "KeyZ", ctrlKey: true, shiftKey: true }));
    assert.deepEqual(redo.kind === "send" && redo.inputs[0]?.commands, ["redo"]);
    for (const k of ["c", "x", "v", "C"]) assert.equal(planKeyDown(key(k, { ctrlKey: true })).kind, "ignore", `ctrl+${k} is a clipboard event`);
    assert.equal(planKeyUp(key("c", { ctrlKey: true })).kind, "ignore");
  });

  it("ignores modifiers alone, input-method keys and a composition in progress", () => {
    for (const k of ["Shift", "Control", "Alt", "AltGraph", "Dead", "Process", "Unidentified", "CapsLock"]) assert.equal(planKeyDown(key(k)).kind, "ignore", k);
    assert.equal(planKeyDown(key("a", { isComposing: true })).kind, "ignore");
    assert.equal(planKeyUp(key("Dead")).kind, "ignore");
  });
});

describe("a Brazilian ABNT2 keyboard", () => {
  it("lets ç, ã, é and AltGr characters through as text, with the key press the page may listen for", () => {
    for (const k of ["ç", "ã", "é", "/", "?", "°", "€"]) {
      const plan = planKeyDown(key(k, { code: "Slash" }));
      assert.equal(plan.kind, "send", k);
      assert.equal(plan.kind === "send" && plan.prevent, false, `${k} arrives as text, so the field must not swallow the key`);
      assert.equal(plan.kind === "send" && plan.inputs[0]?.type, "rawKeyDown");
      assert.equal(plan.kind === "send" && "text" in (plan.inputs[0] ?? {}), false, `${k} carries no text of its own: the text path sends it once`);
    }
  });

  it("does not take AltGr (Ctrl+Alt on Windows) for a shortcut, and does not pass the two on", () => {
    const plan = planKeyDown(key("/", { code: "KeyQ", ctrlKey: true, altKey: true }));
    assert.equal(plan.kind === "send" && plan.prevent, false);
    assert.equal(plan.kind === "send" && plan.inputs[0]?.modifiers, 0);
    const real = planKeyDown(key("q", { code: "KeyQ", ctrlKey: true }));
    assert.equal(real.kind === "send" && real.inputs[0]?.modifiers, MOD_CTRL, "Ctrl alone is still Ctrl");
    const alt = planKeyDown(key("f", { code: "KeyF", altKey: true }));
    assert.equal(alt.kind === "send" && alt.inputs[0]?.modifiers, MOD_ALT);
  });

  it("sends a dead key then a letter as the one composed character: ~ then a is ã, ´ then e is é", () => {
    const gate = new TextGate();
    const sent: string[] = [];
    const feed = (value: string | null) => value && sent.push(value);
    // ~ is a dead key: a composition starts, nothing is typed yet
    assert.equal(planKeyDown(key("Dead", { code: "Quote" })).kind, "ignore");
    gate.compositionStart();
    feed(gate.beforeInput("insertCompositionText", "~", true, 0));
    feed(gate.compositionEnd("ã", 10));
    // the same on Linux, where the finished letter also arrives as a plain insertText a moment later
    feed(gate.beforeInput("insertText", "ã", false, 20));
    gate.compositionStart();
    feed(gate.beforeInput("insertCompositionText", "´", true, 100));
    feed(gate.compositionEnd("é", 110));
    // ~ then space is the ~ itself
    gate.compositionStart();
    feed(gate.compositionEnd("~", 200));
    // a plain letter, and then the same letter again much later, are both typed
    feed(gate.beforeInput("insertText", "a", false, 300));
    feed(gate.beforeInput("insertText", "a", false, 400));
    assert.deepEqual(sent, ["ã", "é", "~", "a", "a"]);
  });

  it("types ç and pastes without leaving anything to a second path", () => {
    const gate = new TextGate();
    assert.equal(gate.beforeInput("insertText", "ç", false, 0), "ç");
    assert.equal(gate.beforeInput("insertFromPaste", "texto colado", false, 1), null, "a paste has its own event");
    assert.equal(gate.beforeInput("insertLineBreak", null, false, 2), null, "Enter is a key");
    assert.equal(gate.beforeInput("deleteContentBackward", null, false, 3), null, "Backspace is a key");
    assert.equal(gate.beforeInput("insertText", null, false, 4), null);
  });
});

describe("where a click lands", () => {
  it("scales the pointer from the drawn canvas to the page and keeps it inside", () => {
    const box = { left: 100, top: 50, width: 640, height: 400 };
    const page = { width: 1280, height: 800 };
    assert.deepEqual(toPagePoint(box, page, 100, 50), { x: 0, y: 0 });
    assert.deepEqual(toPagePoint(box, page, 420, 250), { x: 640, y: 400 });
    assert.deepEqual(toPagePoint(box, page, 740, 450), { x: 1280, y: 800 });
    assert.deepEqual(toPagePoint(box, page, 5000, -5), { x: 1280, y: 0 }, "a drag outside is held at the edge");
    assert.equal(toPagePoint({ ...box, width: 0 }, page, 1, 1), null);
    assert.equal(toPagePoint(box, { width: 0, height: 0 }, 1, 1), null, "before the first picture");
    const back = toScreenRect(box, page, { x: 640, y: 400, width: 128, height: 40 });
    assert.deepEqual(back, { left: 420, top: 250, width: 64, height: 20 });
  });

});

describe("the address bar", () => {
  it("opens addresses and hosts, this machine over http, and searches the rest", () => {
    assert.equal(resolveAddress("https://example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(resolveAddress("example.com"), "https://example.com");
    assert.equal(resolveAddress("sub.example.com.br/path?q=1"), "https://sub.example.com.br/path?q=1");
    assert.equal(resolveAddress("localhost:5173"), "http://localhost:5173");
    assert.equal(resolveAddress("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    assert.equal(resolveAddress("about:blank"), "about:blank");
    assert.equal(resolveAddress("receita de pão de queijo"), "https://duckduckgo.com/?q=receita%20de%20p%C3%A3o%20de%20queijo");
    assert.equal(resolveAddress("cats"), "https://duckduckgo.com/?q=cats");
    assert.equal(resolveAddress("file:///etc/passwd"), "https://duckduckgo.com/?q=file%3A%2F%2F%2Fetc%2Fpasswd", "no scheme but the web's is opened");
    assert.equal(resolveAddress("javascript:alert(1)"), "https://duckduckgo.com/?q=javascript%3Aalert(1)");
    assert.equal(resolveAddress("  "), "about:blank");
  });
});

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
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
  say(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  frame(seq: number, tab: string): void {
    const id = new TextEncoder().encode(tab);
    const bytes = new Uint8Array(10 + id.length + 3);
    const view = new DataView(bytes.buffer);
    bytes[0] = 3;
    view.setUint32(1, seq, true);
    view.setUint16(5, 640, true);
    view.setUint16(7, 480, true);
    bytes[9] = id.length;
    bytes.set(id, 10);
    bytes.set([0xff, 0xd8, 0xff], 10 + id.length);
    this.onmessage?.({ data: bytes.buffer });
  }
}

function rig() {
  const socket = new FakeSocket();
  const views: Array<ReturnType<BrowserSession["current"]["valueOf"]>> = [];
  const drawn: Array<{ seq: number; done: () => void }> = [];
  const copied: string[] = [];
  const session = new BrowserSession({
    url: () => "ws://x/api/browser/ws",
    open: () => socket,
    onChange: (v) => void views.push(v),
    onFrame: (frame, done) => void drawn.push({ seq: frame.seq, done }),
    onSelection: (text) => void copied.push(text),
    now: () => 1,
  });
  return { socket, session, views, drawn, copied };
}

describe("the pane's connection", () => {
  it("says hello, shows the tabs, and acknowledges a picture only once it is drawn", () => {
    const { socket, session, drawn } = rig();
    session.connect();
    assert.equal(session.current.status, "connecting");
    socket.open();
    assert.deepEqual(JSON.parse(socket.sent[0] as string), { type: "hello", v: 1, takeover: false });
    socket.say({ type: "ready", v: 1, tabs: [{ id: "T1", url: "https://example.com/", title: "Example", loading: false }], active: "T1" });
    assert.equal(session.current.status, "open");
    assert.equal(session.current.active, "T1");
    socket.frame(7, "T1");
    assert.equal(drawn.length, 1);
    assert.equal(socket.sent.length, 1, "no acknowledgement yet");
    drawn[0]?.done();
    assert.deepEqual(JSON.parse(socket.sent[1] as string), { type: "ack", seq: 7 });
    socket.frame(8, "OTHER");
    assert.equal(drawn.length, 1, "a picture of a tab that is not in front is not drawn");
    assert.deepEqual(JSON.parse(socket.sent[2] as string), { type: "ack", seq: 8 }, "but it is acknowledged so the stream goes on");
    assert.equal(session.stats.frames, 1);
  });

  it("keeps dialogs, selects, notices and errors apart and clears them", () => {
    const { socket, session, copied } = rig();
    session.connect();
    socket.open();
    socket.say({ type: "ready", v: 1, tabs: [], active: "T1" });
    socket.say({ type: "dialog", dialog: { tabId: "T1", kind: "confirm", message: "Sure?", url: "x" } });
    assert.equal(session.current.dialog?.message, "Sure?");
    socket.say({ type: "dialog-closed", tabId: "T1" });
    assert.equal(session.current.dialog, null);
    socket.say({ type: "select", tabId: "T1", probe: { rect: { x: 0, y: 0, width: 1, height: 1 }, multiple: false, options: [] } });
    assert.ok(session.current.select);
    session.closeSelect();
    assert.equal(session.current.select, null);
    socket.say({ type: "notice", kind: "download", text: "Downloads are not allowed yet." });
    assert.equal(session.current.notice, "Downloads are not allowed yet.");
    session.clearNotice();
    assert.equal(session.current.notice, null);
    socket.say({ type: "error", message: "No." });
    assert.equal(session.current.message, "No.");
    socket.say({ type: "selection", text: "copiado" });
    assert.deepEqual(copied, ["copiado"]);
    socket.onmessage?.({ data: "not json" });
    assert.equal(session.current.status, "open");
  });

  it("tells a second window it is second, and a first that it was taken over", () => {
    const { socket, session } = rig();
    session.connect();
    socket.open();
    socket.onclose?.({ code: 4009, reason: "" });
    assert.equal(session.current.status, "busy");
    assert.match(session.current.message ?? "", /another window/);
    const again = rig();
    again.session.connect();
    again.socket.open();
    again.socket.onclose?.({ code: 4010, reason: "" });
    assert.equal(again.session.current.status, "taken");
    const third = rig();
    third.session.connect(true);
    third.socket.open();
    assert.deepEqual(JSON.parse(third.socket.sent[0] as string), { type: "hello", v: 1, takeover: true });
  });

  it("says so when there is no browser to reach", () => {
    const session = new BrowserSession({ url: () => null, open: () => new FakeSocket(), onChange: () => undefined, onFrame: () => undefined, onSelection: () => undefined });
    session.connect();
    assert.equal(session.current.status, "closed");
    assert.equal(EMPTY_VIEW.status, "idle");
  });

  it("decodes the frame header a server writes", () => {
    const socket = new FakeSocket();
    const box: { got: ReturnType<typeof decodeFrame> } = { got: null };
    socket.onmessage = (event) => void (box.got = decodeFrame(event.data as ArrayBuffer));
    socket.frame(5, "ABCD");
    assert.deepEqual({ ...box.got, jpeg: [...(box.got?.jpeg ?? [])] }, { seq: 5, width: 640, height: 480, tabId: "ABCD", jpeg: [0xff, 0xd8, 0xff] });
    assert.equal(decodeFrame(new ArrayBuffer(4)), null);
  });
});

describe("what the pane shows", () => {
  const tabs = [
    { id: "T1", url: "https://example.com/page", title: "Example page", loading: false },
    { id: "T2", url: "about:blank", title: "", loading: true },
    { id: "T3", url: "http://localhost:3000/", title: "", loading: false },
  ];

  it("names tabs by title, else host, else New tab, and leaves a blank page's address empty", () => {
    assert.deepEqual(tabs.map(tabLabel), ["Example page", "New tab", "localhost:3000"]);
    assert.equal(addressOf(tabs[1]), "");
    assert.equal(addressOf(tabs[0]), "https://example.com/page");
    assert.equal(addressOf(undefined), "");
  });

  it("draws the tab strip, the loading bar and the reasons the browser is not showing", () => {
    const strip = html(createElement(TabStrip, { tabs, active: "T1", onNew: () => undefined, onSwitch: () => undefined, onClose: () => undefined, onHide: () => undefined }));
    assert.match(strip, /role="tablist"/);
    assert.match(strip, /aria-selected="true"[^>]*>Example page/);
    assert.match(strip, /Close Example page/);
    const loading = html(createElement(Toolbar, { tab: tabs[1], disabled: false, onBack: () => undefined, onForward: () => undefined, onReload: () => undefined, onGo: () => undefined }));
    assert.match(loading, /role="progressbar"/);
    assert.match(loading, /Open in my browser/);
    const idle = html(createElement(Toolbar, { tab: tabs[0], disabled: false, onBack: () => undefined, onForward: () => undefined, onReload: () => undefined, onGo: () => undefined }));
    assert.doesNotMatch(idle, /role="progressbar"/);
    assert.match(idle, /value="https:\/\/example.com\/page"/);
    const busy = html(createElement(Status, { view: { ...EMPTY_VIEW, status: "busy", message: "The browser is open in another window." }, onConnect: () => undefined }));
    assert.match(busy, /open in another window/);
    assert.match(busy, /Use it here/);
    const gone = html(createElement(Status, { view: { ...EMPTY_VIEW, status: "closed", message: "The connection to the browser ended." }, onConnect: () => undefined }));
    assert.match(gone, /Reconnect/);
    assert.match(html(createElement(Status, { view: { ...EMPTY_VIEW, status: "connecting" }, onConnect: () => undefined })), /Opening the browser/);
  });

  it("shows a script's dialog with the buttons its kind needs", () => {
    const render = (kind: string, extra: Record<string, unknown> = {}) =>
      html(createElement(DialogBox, { dialog: { tabId: "T1", kind, message: "Apagar tudo?", url: "x", ...extra }, onAnswer: () => undefined }));
    const alert = render("alert");
    assert.match(alert, /Apagar tudo\?/);
    assert.doesNotMatch(alert, /Cancel/);
    assert.match(render("confirm"), /Cancel/);
    assert.match(render("prompt", { defaultPrompt: "Maria" }), /value="Maria"/);
    assert.match(render("beforeunload"), /Stay[\s\S]*Leave/);
  });
});
