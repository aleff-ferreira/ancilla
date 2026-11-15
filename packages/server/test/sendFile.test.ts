/** Streaming a file to a client: a download that is dropped frees its file, and one that cannot be read is an error. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveExportFile } from "../src/research/export/index.js";
import { FakeConnection, send, start, waitFor } from "./harness.js";

/** How many descriptors this process holds on `file`. Only Linux can say. */
async function openCount(file: string): Promise<number> {
  let count = 0;
  for (const fd of await readdir("/proc/self/fd")) {
    try {
      if ((await readlink(`/proc/self/fd/${fd}`)) === file) {
        count += 1;
      }
    } catch {
      /* a descriptor closed while the list was read */
    }
  }
  return count;
}

/** Starts a download and drops it after the first bytes arrive. */
function abortAfterFirstChunk(url: string, headers: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve) => {
    const req = httpGet(url, { headers }, (res) => {
      res.once("data", () => {
        req.destroy();
        res.destroy();
      });
      res.on("close", () => resolve());
    });
    req.on("error", () => resolve());
  });
}

describe("project file downloads", () => {
  it("frees the file when a download is dropped, with or without a byte range", async (t) => {
    if (process.platform !== "linux") {
      return t.skip("open descriptors are only listed on Linux");
    }
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-sendfile-"));
    await writeFile(join(cwd, "big.bin"), Buffer.alloc(16 * 1024 * 1024, 7));
    const { base } = await start(connection);
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    const big = await realpath(join(cwd, "big.bin"));
    const url = `${base}/api/files/raw?cwd=${encodeURIComponent(cwd)}&path=big.bin`;

    for (let index = 0; index < 20; index += 1) {
      await abortAfterFirstChunk(url);
      await abortAfterFirstChunk(url, { range: "bytes=1000-" });
    }
    await waitFor(async () => (await openCount(big)) === 0, "the dropped downloads to release the file", 4000).catch(() => undefined);
    assert.equal(await openCount(big), 0, "no descriptor stays open on a file nobody is reading");

    // The server is fine, and a whole download still arrives complete.
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal((await whole.arrayBuffer()).byteLength, 16 * 1024 * 1024);
    const ranged = await fetch(url, { headers: { range: "bytes=10-19" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 10-19/${16 * 1024 * 1024}`);
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  });

  it("answers HEAD with the headers and no body, and 404 for a file that is not there", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-sendfile-"));
    await writeFile(join(cwd, "a.txt"), "hello");
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd });
    const url = `${base}/api/files/raw?cwd=${encodeURIComponent(cwd)}&path=a.txt`;
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "5");
    assert.equal(await head.text(), "");
    assert.equal((await fetch(url.replace("a.txt", "none.txt"))).status, 404);
    assert.equal(await (await fetch(url)).text(), "hello");
  });
});

describe("an export that cannot be read", () => {
  it("is an error for that request and not a crash, through the real route", async (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return t.skip("needs a file this process may not read, which neither Windows nor root can make");
    }
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-export-denied-"));
    const { base } = await start(connection, {
      researchEngine: async (input, config, deps) => {
        const state = {
          version: 1, runId: input.runId, eventSeq: 0, question: input.question, config, phase: "done", brief: null, inputLanguage: "en",
          targetLanguage: "en", draft: null, rounds: [], registry: [], curated: [], notes: [], consecutiveFailures: 0, aborted: false,
          abortReason: null, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 }, startedAt: "2026-09-26T10:00:00.000Z",
          researchDeadlineAt: "2026-09-26T10:10:00.000Z", nextAgentId: 1,
        } as never;
        await deps.checkpoint(state);
        return { status: "completed", report: "# Title\n\nBody.\n", state, failure: null };
      },
    });
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    const started = await send(base, "/api/research", { commandId: "c1", sessionId: "s1", question: "Is it readable?" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId: string = started.json.run.runId;
    await waitFor(async () => (await (await fetch(`${base}/api/research/${runId}`)).json() as { run: { status: string } }).run.status === "completed", "the run");
    const exported = await send(base, `/api/research/${runId}/export`, { format: "html" });
    assert.equal(exported.status, 200, JSON.stringify(exported.json));
    const file = join(cwd, ".ancilla", "research", runId, "report.html");
    await chmod(file, 0o000);
    try {
      const res = await fetch(`${base}${exported.json.url}`);
      assert.ok(res.status >= 500, `an unreadable export answers an error, not ${res.status}`);
      await res.arrayBuffer().catch(() => undefined);
      assert.equal((await fetch(`${base}/api/research/${runId}`)).status, 200, "and the server is still up");
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("does not take the process down when the file fails mid-download", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-export-dir-"));
    await mkdir(join(dir, "not-a-file"));
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/ok") {
        res.end("ok");
        return;
      }
      serveExportFile(req, res, join(dir, "not-a-file"), "html", "report.html").catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      // Where a folder can be opened it fails on the first read, after the headers; elsewhere the open itself fails.
      // Either way this request ends, without a body it could trust, and without an error reaching the process.
      await fetch(`http://127.0.0.1:${port}/`).then((res) => res.arrayBuffer()).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(uncaught, [], "no error escaped to the process");
      assert.equal(await (await fetch(`http://127.0.0.1:${port}/ok`)).text(), "ok", "and the server still takes a request");
    } finally {
      process.off("uncaughtException", record);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * One request over a raw socket that closes after the answer: the declared length, and how many body bytes really
 * came before the connection ended. `onBodyStarted` runs once, when the first body bytes have arrived.
 */
function rawDownload(port: number, path: string, onBodyStarted: () => void): Promise<{ contentLength: number; bodyBytes: number }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    let head = Buffer.alloc(0);
    let headEnd = -1;
    let bodyBytes = 0;
    let started = false;
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      if (headEnd < 0) {
        head = Buffer.concat([head, chunk]);
        headEnd = head.indexOf("\r\n\r\n");
        if (headEnd < 0) {
          return;
        }
        bodyBytes = head.length - (headEnd + 4);
        head = head.subarray(0, headEnd);
      } else {
        bodyBytes += chunk.length;
      }
      if (!started && bodyBytes > 0) {
        started = true;
        onBodyStarted();
      }
    });
    socket.on("close", () => {
      const declared = /content-length: (\d+)/i.exec(head.toString("latin1"));
      resolve({ contentLength: declared ? Number(declared[1]) : -1, bodyBytes });
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

describe("a file that grows while it is downloaded", () => {
  const SIZE = 32 * 1024 * 1024;

  it("is sent as far as its declared length and no further, as a project file", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-grow-"));
    const file = join(cwd, "grow.bin");
    await writeFile(file, Buffer.alloc(SIZE, 65));
    const { base } = await start(connection);
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    const port = Number(new URL(base).port);
    const result = await rawDownload(port, `/api/files/raw?cwd=${encodeURIComponent(cwd)}&path=grow.bin`, () => appendFileSync(file, Buffer.alloc(1024 * 1024, 66)));
    assert.equal(result.contentLength, SIZE);
    assert.equal(result.bodyBytes, SIZE, "the bytes on the wire are the declared length, not what the file grew to");
  });

  it("is sent as far as its declared length and no further, as an export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-grow-export-"));
    const file = join(dir, "report.html");
    await writeFile(file, Buffer.alloc(SIZE, 65));
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      serveExportFile(req, res, file, "html", "report.html").catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const result = await rawDownload(port, "/", () => appendFileSync(file, Buffer.alloc(1024 * 1024, 66)));
      assert.equal(result.contentLength, SIZE);
      assert.equal(result.bodyBytes, SIZE);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("still sends an empty file as an empty body", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-empty-"));
    await writeFile(join(cwd, "empty.txt"), "");
    const { base } = await start(connection);
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    const res = await fetch(`${base}/api/files/raw?cwd=${encodeURIComponent(cwd)}&path=empty.txt`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "0");
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });
});
