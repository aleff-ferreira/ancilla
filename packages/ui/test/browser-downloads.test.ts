import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionQuestionCard } from "../src/components/browser/ActionQuestion.js";
import { DownloadBox, formatSize } from "../src/components/browser/DownloadForm.js";
import { parseQuestion } from "../src/components/browser/protocol.js";
import { BrowserSession, type SocketLike } from "../src/components/browser/session.js";

const html = (element: ReactElement) => renderToStaticMarkup(element);

const download = { id: "abcd1234-0000", tabId: "T1", name: "report.pdf", size: 3 * 1024 * 1024, origin: "https://shop.example", page: "Shop", folder: "C:\\Users\\me\\Downloads", warning: null };

describe("the Save to dialog of the person's own tab", () => {
  it("shows the file, its size, the site, the folder, and Save / Don't save, with nothing saved yet", () => {
    const out = html(createElement(DownloadBox, { download, onAnswer: () => undefined }));
    assert.match(out, /role="dialog"/);
    assert.match(out, /report\.pdf/);
    assert.match(out, /3 MB from https:\/\/shop\.example/);
    assert.match(out, /C:\\Users\\me\\Downloads/);
    assert.match(out, /computer that runs Ancilla/);
    assert.match(out, />Change</);
    assert.match(out, />Save</);
    assert.match(out, /Don&#x27;t save|Don't save/);
    assert.match(out, /Nothing is saved until you press Save/);
    assert.doesNotMatch(out, /role="alert"/, "no warning for a pdf");
  });

  it("warns, in plain words, about a file that runs programs", () => {
    const out = html(createElement(DownloadBox, { download: { ...download, name: "setup.exe", warning: ".exe files can run programs. Only keep it if you trust where it came from." }, onAnswer: () => undefined }));
    assert.match(out, /role="alert"/);
    assert.match(out, /\.exe files can run programs/);
  });

  it("sizes in words", () => {
    assert.equal(formatSize(null), "unknown size");
    assert.equal(formatSize(900), "900 B");
    assert.equal(formatSize(1536), "1.5 KB");
    assert.equal(formatSize(5 * 1024 ** 3), "5 GB");
  });
});

describe("the assistant's download as a question", () => {
  const question = { type: "action" as const, origin: "https://shop.example", kind: "public" as const, page: "Shop", what: "Save the file “a.pdf”", fields: [], download: { id: "dl_1", name: "a.pdf", size: 2048, folder: "/home/me/Downloads", warning: null } };

  it("is parsed from what the server sends, download included", () => {
    const parsed = parseQuestion(question);
    assert.deepEqual(parsed && "download" in parsed ? parsed.download : null, question.download);
    assert.equal(parseQuestion({ ...question, download: { name: 5 } }) !== null && "download" in (parseQuestion({ ...question, download: { name: 5 } }) as object), false, "a bad download is dropped, the action still shows");
  });

  it("shows the file and the folder with Save and Don't save, worded for the assistant, and no Do it", () => {
    const out = html(createElement(ActionQuestionCard, { question, onAnswer: () => undefined }));
    assert.match(out, /a\.pdf/);
    assert.match(out, /2 KB from https:\/\/shop\.example, started by the assistant/);
    assert.match(out, /\/home\/me\/Downloads/);
    assert.match(out, />Save</);
    assert.doesNotMatch(out, />Do it</);
  });

  it("keeps the old action card for an action that is not a download", () => {
    const { download: _gone, ...action } = question;
    const out = html(createElement(ActionQuestionCard, { question: { ...action, what: "Click “Buy”" }, onAnswer: () => undefined }));
    assert.match(out, />Do it</);
  });
});

class FakeSocket implements SocketLike {
  readyState = 1;
  binaryType = "blob";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  say(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("the pane's connection and downloads", () => {
  it("queues a download question, drops it when the server closes it, and forgets old ones on a new connection", () => {
    const socket = new FakeSocket();
    const session = new BrowserSession({ url: () => "ws://x/api/browser/ws", open: () => socket as never, onChange: () => undefined, onFrame: () => undefined, onSelection: () => undefined, now: () => 1 });
    session.connect();
    socket.onopen?.();
    socket.say({ type: "ready", v: 1, tabs: [], active: null });
    socket.say({ type: "download", download });
    socket.say({ type: "download", download: { ...download, id: "second-0000" } });
    assert.deepEqual(session.current.downloads.map((d) => d.id), ["abcd1234-0000", "second-0000"]);
    socket.say({ type: "download-closed", id: "abcd1234-0000" });
    assert.deepEqual(session.current.downloads.map((d) => d.id), ["second-0000"]);
    session.send({ type: "save", id: "second-0000", accept: true, folder: "/x" });
    assert.deepEqual(JSON.parse(socket.sent.at(-1) as string), { type: "save", id: "second-0000", accept: true, folder: "/x" });
    socket.say({ type: "ready", v: 1, tabs: [], active: null });
    assert.deepEqual(session.current.downloads, [], "the server tells again what is still waiting");
  });
});
