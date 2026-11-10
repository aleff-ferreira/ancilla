import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { GITHUB } from "../src/connectors/catalog.js";
import { ConnectorError, explainError, makeOpener } from "../src/connectors/connection.js";
import type { ConnectorManifest } from "../src/connectors/manifest.js";
import { SCHEMA } from "./connectors-fixtures.js";

/**
 * The official MCP client against servers written in the test: HTTP with the token as a bearer (answering in JSON or as a
 * stream, and listing its tools over two pages), and a program on this computer that is given the token in its own environment
 * and nothing of Ancilla's. Nothing here is a real account.
 */

const TOKEN = "fake-token-0123456789abcdef";
const open = makeOpener("test");

interface Seen {
  auth: string[];
  methods: string[];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    req.on("end", () => resolve(text));
  });
}

/** A server that speaks streamable HTTP just enough: initialize, a list over two pages, and calls. `stream` answers as an event stream. */
async function startHttp(options: { stream?: boolean } = {}): Promise<{ url: string; seen: Seen; server: Server }> {
  const seen: Seen = { auth: [], methods: [] };
  const answer = (res: ServerResponse, id: unknown, result: unknown, headers: Record<string, string> = {}): void => {
    const body = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (options.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", ...headers });
      res.end(`event: message\ndata: ${body}\n\n`);
    } else {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(body);
    }
  };
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      seen.auth.push(String(req.headers["authorization"] ?? ""));
      if (req.headers["authorization"] !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const message = JSON.parse(await readBody(req)) as { id?: unknown; method?: string; params?: { protocolVersion?: string; cursor?: string; name?: string } };
      seen.methods.push(String(message.method));
      if (message.method === "initialize") return answer(res, message.id, { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }, { "mcp-session-id": "s1" });
      if (message.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === "tools/list") {
        return message.params?.cursor === "page2"
          ? answer(res, message.id, { tools: [{ name: "search_issues", inputSchema: SCHEMA }, { name: "issue_write", inputSchema: { type: "object" } }] })
          : answer(res, message.id, { tools: [{ name: "get_me", inputSchema: { type: "object", properties: {} } }], nextCursor: "page2" });
      }
      if (message.method === "tools/call") {
        if (message.params?.name === "get_me") return answer(res, message.id, { content: [{ type: "text", text: '{"login":"aleff"}' }] });
        if (message.params?.name === "boom") return answer(res, message.id, { content: [{ type: "text", text: "it broke" }], isError: true });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } }));
        return;
      }
      res.writeHead(202);
      res.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, server };
}

const httpManifest = (url: string): ConnectorManifest => ({ ...GITHUB, transport: { kind: "http", url } });

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

describe("a connection over HTTP", () => {
  for (const stream of [false, true]) {
    it(`sends the token as a bearer on every request, lists all pages, and calls a tool (${stream ? "an event stream" : "JSON"})`, async () => {
      const { url, seen, server } = await startHttp({ stream });
      servers.push(server);
      const connection = await open(httpManifest(url), TOKEN);
      const tools = await connection.tools();
      assert.deepEqual(tools.map((t) => t.name), ["get_me", "search_issues", "issue_write"], "two pages, in order");
      assert.deepEqual(await connection.call("get_me", {}, new AbortController().signal), { text: '{"login":"aleff"}', isError: false });
      await connection.close();
      assert.ok(seen.auth.length >= 4 && seen.auth.every((a) => a === `Bearer ${TOKEN}`), "the token is a bearer on every request, and nowhere else");
      assert.ok(seen.methods.includes("initialize") && seen.methods.includes("tools/list") && seen.methods.includes("tools/call"));
    });
  }

  it("carries a tool's own error as an error result, and a protocol error as a plain sentence", async () => {
    const { url, server } = await startHttp();
    servers.push(server);
    const connection = await open(httpManifest(url), TOKEN);
    assert.deepEqual(await connection.call("boom", {}, new AbortController().signal), { text: "it broke", isError: true });
    await assert.rejects(() => connection.call("nothing", {}, new AbortController().signal), (error: unknown) => error instanceof ConnectorError && !error.message.includes(TOKEN));
    await connection.close();
  });

  it("refuses a token the server does not accept, in words, without ever repeating the token", async () => {
    const { url, server } = await startHttp();
    servers.push(server);
    await assert.rejects(
      () => open(httpManifest(url), "wrong-token-0123456789"),
      (error: unknown) => error instanceof ConnectorError && /did not accept the token \(401\)/.test(error.message) && !error.message.includes("wrong-token"),
    );
  });

  it("says so when the server cannot be reached", async () => {
    const { url, server } = await startHttp();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await assert.rejects(() => open(httpManifest(url), TOKEN), (error: unknown) => error instanceof ConnectorError && /could not reach the server|did not answer/.test(error.message));
  });
});

describe("a connection to a program on this computer", () => {
  it("gives it the token in its own environment, and nothing of Ancilla's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-stdio-"));
    const script = join(dir, "fake-mcp.cjs");
    writeFileSync(
      script,
      [
        'const readline = require("node:readline");',
        'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
        'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
        "  let m; try { m = JSON.parse(line); } catch { return; }",
        '  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-stdio", version: "1" } } });',
        '  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "env_report", inputSchema: { type: "object", properties: {} } }] } });',
        '  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ gotToken: process.env.FAKE_TOKEN === "' + TOKEN + '", leaked: process.env.ANCILLA_TEST_SECRET || null, hasPath: Boolean(process.env.PATH) }) }] } });',
        "});",
      ].join("\n"),
    );
    process.env["ANCILLA_TEST_SECRET"] = "ancilla-private-value";
    try {
      const manifest: ConnectorManifest = { ...GITHUB, transport: { kind: "stdio", command: process.execPath, args: [script], tokenEnv: "FAKE_TOKEN" } };
      const connection = await open(manifest, TOKEN);
      assert.deepEqual((await connection.tools()).map((t) => t.name), ["env_report"]);
      const reply = await connection.call("env_report", {}, new AbortController().signal);
      assert.deepEqual(JSON.parse(reply.text), { gotToken: true, leaked: null, hasPath: true }, "it has the token and a small safe environment, not Ancilla's");
      await connection.close();
    } finally {
      delete process.env["ANCILLA_TEST_SECRET"];
    }
  });

  it("says in words when the program cannot start", async () => {
    const manifest: ConnectorManifest = { ...GITHUB, transport: { kind: "stdio", command: join(tmpdir(), "no-such-program-ancilla"), args: [], tokenEnv: "FAKE_TOKEN" } };
    await assert.rejects(() => open(manifest, TOKEN), (error: unknown) => error instanceof ConnectorError && !error.message.includes(TOKEN));
  });
});

describe("what is said about a failure", () => {
  it("names the usual causes and never carries the token", () => {
    assert.match(explainError(new Error("HTTP 401: Unauthorized"), TOKEN), /did not accept the token/);
    assert.match(explainError(new Error("Error POSTing to endpoint (HTTP 403): forbidden"), TOKEN), /refused the token/);
    assert.match(explainError(new Error("getaddrinfo ENOTFOUND mcp.example"), TOKEN), /could not reach the server/);
    assert.match(explainError(new Error("Request timed out"), TOKEN), /did not answer in time/);
    const odd = explainError(new Error(`the server said ${TOKEN} is bad`), TOKEN);
    assert.ok(!odd.includes(TOKEN));
    assert.equal(explainError("", TOKEN), "The server could not be used.");
    assert.ok(explainError(new Error("x".repeat(500)), TOKEN).length <= 243);
  });
});
