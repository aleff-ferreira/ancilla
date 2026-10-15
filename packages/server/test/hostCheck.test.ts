/**
 * The front door: which Host the server answers, what a token buys under a foreign Host, Fetch Metadata, the bind
 * refusal, malformed input that used to be a 500, the cap on the handshake body and the framing headers.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { AncillaServer } from "../src/server.js";
import { FakeConnection, rawRequest, rawRequestWithoutHost, rawWire, send, start } from "./harness.js";

const FOREIGN = "evil.example";

function portOf(base: string): string {
  return new URL(base).port;
}

async function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  let text = "";
  process.stderr.write = ((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return text;
}

describe("the Host check on a loopback bind", () => {
  it("refuses a foreign Host, with or without a matching Origin, saying how to allow it", async () => {
    const { base } = await start(new FakeConnection());
    const matching = await rawRequest(base, "/api/health", { headers: { host: FOREIGN, origin: `http://${FOREIGN}` } });
    assert.equal(matching.status, 403);
    assert.equal(matching.json.kind, "host");
    assert.match(matching.json.error, /evil\.example/, "the message names the host it refused");
    assert.match(matching.json.error, /--allow-host/);
    assert.match(matching.json.error, /allowHosts/);
    const bare = await rawRequest(base, "/api/health", { headers: { host: `${FOREIGN}:${portOf(base)}` } });
    assert.equal(bare.status, 403);
    assert.equal(bare.json.kind, "host");
    assert.equal(bare.headers["access-control-allow-origin"], undefined);
  });

  it("refuses 0.0.0.0, look-alike names and a request with no Host at all", async () => {
    const { base } = await start(new FakeConnection());
    for (const host of [`0.0.0.0:${portOf(base)}`, "evil.localhost", `evil.localhost:${portOf(base)}`, "localhost.evil.example", "127.0.0.1.evil.example", "localhost.", "127.1"]) {
      const reply = await rawRequest(base, "/api/health", { headers: { host } });
      assert.equal(reply.status, 403, host);
      assert.equal(reply.json.kind, "host", host);
    }
    const none = await rawRequestWithoutHost(base, "/api/health");
    assert.equal(none.status, 403);
    assert.equal(none.json.kind, "host");
  });

  it("answers localhost, LOCALHOST, 127.0.0.1 and [::1], with their ports", async () => {
    const { base } = await start(new FakeConnection());
    const port = portOf(base);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, "localhost", `[::1]:${port}`, "[::1]"]) {
      const reply = await rawRequest(base, "/api/health", { headers: { host } });
      assert.equal(reply.status, 200, host);
    }
  });

  it("runs before everything else: a preflight, a write, the static shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-host-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>shell</title>");
    const { base } = await start(new FakeConnection(), { staticDir: dir, allowOrigins: ["https://listed.example"] });
    const preflight = await rawRequest(base, "/api/turns", { method: "OPTIONS", headers: { host: FOREIGN, origin: "https://listed.example" } });
    assert.equal(preflight.status, 403, "even a listed origin does not get a preflight under a foreign Host");
    assert.equal(preflight.json.kind, "host");
    const write = await rawRequest(base, "/api/sandbox-settings", {
      method: "PATCH",
      headers: { host: "other.example", "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(write.status, 403);
    const shell = await rawRequest(base, "/", { headers: { host: "other.example" } });
    assert.equal(shell.status, 403);
    assert.equal(shell.json.kind, "host");
    assert.equal((await rawRequest(base, "/", { headers: { host: `localhost:${portOf(base)}` } })).status, 200);
  });

  it("logs each distinct refused host once", async () => {
    const { base } = await start(new FakeConnection());
    const logged = await captureStderr(async () => {
      await rawRequest(base, "/api/health", { headers: { host: "first.example" } });
      await rawRequest(base, "/api/health", { headers: { host: "second.example" } });
      await rawRequest(base, "/api/health", { headers: { host: "first.example:8443" } });
      await rawRequest(base, "/api/health", { headers: { host: "FIRST.example" } });
    });
    const lines = logged.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 2, "one line for each of the two hosts, however often or in what case they come back");
    assert.match(lines[0]!, /first\.example/);
    assert.match(lines[1]!, /second\.example/);
    assert.match(logged, /if this is your own proxy or tunnel, add --allow-host first\.example/);
  });

  it("stops logging after five distinct hosts, so a stream of made-up names cannot fill the log", async () => {
    const { base } = await start(new FakeConnection());
    const logged = await captureStderr(async () => {
      for (let n = 1; n <= 8; n += 1) {
        await rawRequest(base, "/api/health", { headers: { host: `host${n}.example` } });
      }
      await rawRequest(base, "/api/health", { headers: { host: "host1.example" } });
    });
    const lines = logged.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 5);
    assert.match(lines[4]!, /host5\.example/);
    assert.match(lines[4]!, /no more refused hosts will be logged/i);
    assert.doesNotMatch(logged, /host6\.example/);
  });

  it("counts every refusal in the diagnostics, however many the log stopped reporting", async () => {
    const { base } = await start(new FakeConnection());
    const diagnostics = async () => (await rawRequest(base, "/api/health", { headers: { host: `127.0.0.1:${portOf(base)}` } })).json.diagnostics;
    const before = await diagnostics();
    assert.equal(before.hostRefusals, 0);
    assert.equal(before.lastRefusedHost, null);
    const logged = await captureStderr(async () => {
      for (let n = 1; n <= 8; n += 1) {
        await rawRequest(base, "/api/health", { headers: { host: `host${n}.example` } });
      }
      await rawRequest(base, "/api/health", { headers: { host: "host1.example" } });
    });
    assert.equal(logged.split("\n").filter((line) => line.trim() !== "").length, 5, "the log kept its cap");
    const after = await diagnostics();
    assert.equal(after.hostRefusals, 9, "all nine, not five");
    assert.equal(after.lastRefusedHost, "host1.example", "the last one, as a plain name");
  });

  it("shows the last refused host only as a name that could be listed, never the header text", async () => {
    const { base } = await start(new FakeConnection());
    const diagnostics = async () => (await rawRequest(base, "/api/health", { headers: { host: `127.0.0.1:${portOf(base)}` } })).json.diagnostics;
    await captureStderr(async () => {
      await rawRequest(base, "/api/health", { headers: { host: "Tunnel.Example:8443" } });
      for (const host of ["$(id).evil.example", "a b.example", "*.example", "[::1]$(id)", "x".repeat(300)]) {
        const reply = await rawRequest(base, "/api/health", { headers: { host } });
        assert.equal(reply.status, 403, host);
        assert.doesNotMatch(reply.json.error, /--allow-host/, "no command for text that is not a name, one too long to be one included");
      }
      await rawRequestWithoutHost(base, "/api/health");
    });
    const seen = await diagnostics();
    assert.equal(seen.hostRefusals, 7);
    assert.equal(seen.lastRefusedHost, "tunnel.example", "lower case, without the port; an unusable header does not replace it");
    assert.doesNotMatch(JSON.stringify(seen), /\$\(id\)|\*\.example|a b|x{100}/, "none of the hostile text is echoed, a name too long to be one included");
    // An address that was allowed is not a refusal.
    assert.equal((await rawRequest(base, "/api/health", { headers: { host: "localhost" } })).status, 200);
    assert.equal((await diagnostics()).hostRefusals, 7);
  });

  it("does not turn a hostile Host into a command to paste", async () => {
    const { base } = await start(new FakeConnection());
    const hostile = ["$(id).evil.example", "evil.example;rm", "a b.example", "`id`.example", "[::1]$(id)", "[fe80::1%25eth0]", "*.example"];
    const logged = await captureStderr(async () => {
      for (const host of hostile) {
        const reply = await rawRequest(base, "/api/health", { headers: { host } });
        assert.equal(reply.status, 403, host);
        assert.equal(reply.json.kind, "host", host);
        assert.match(reply.json.error, /an unusable host name/, host);
        assert.doesNotMatch(reply.json.error, /--allow-host/, `${host}: no command is offered for a name that cannot be listed`);
      }
    });
    assert.match(logged, /an unusable host name/);
    assert.doesNotMatch(logged, /--allow-host/, "the log offers no command for them either");
  });

  it("offers the bare address for an IPv6 Host, and the name for a real one", async () => {
    const { base } = await start(new FakeConnection());
    const logged = await captureStderr(async () => {
      const v6 = await rawRequest(base, "/api/health", { headers: { host: "[2001:db8::7]:9000" } });
      assert.equal(v6.status, 403);
      assert.match(v6.json.error, /--allow-host 2001:db8::7(?![\w:])/);
      assert.doesNotMatch(v6.json.error, /--allow-host \[/);
      const named = await rawRequest(base, "/api/health", { headers: { host: "Tunnel.Example:8443" } });
      assert.match(named.json.error, /--allow-host tunnel\.example(?![\w.:])/);
    });
    assert.match(logged, /add --allow-host 2001:db8::7(?![\w:])/);
    assert.match(logged, /add --allow-host tunnel\.example(?![\w.:])/);
  });
});

describe("a bind to one specific loopback address", () => {
  /** Whether this machine can bind 127.0.0.2: Linux and Windows can, macOS only after an alias is added. */
  async function canBind(address: string): Promise<boolean> {
    const probe = createNetServer();
    const bound = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(0, address, () => resolve(true));
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return bound;
  }

  it("answers the address it was bound to, and still refuses a name that is not its own", async (t) => {
    if (!(await canBind("127.0.0.2"))) {
      t.skip("this machine has no 127.0.0.2 loopback address (macOS needs an alias for it)");
      return;
    }
    const { base } = await start(new FakeConnection(), { host: "127.0.0.2" });
    const own = `http://127.0.0.2:${portOf(base)}`;
    assert.equal((await rawRequest(own, "/api/health", { headers: { host: `127.0.0.2:${portOf(base)}` } })).status, 200);
    assert.equal((await rawRequest(own, "/api/health", { headers: { host: "127.0.0.2" } })).status, 200);
    assert.equal((await rawRequest(own, "/api/health", { headers: { host: `localhost:${portOf(base)}` } })).status, 200);
    const evil = await rawRequest(own, "/api/health", { headers: { host: `${FOREIGN}:${portOf(base)}` } });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.kind, "host");
    assert.equal((await rawRequest(own, "/api/health", { headers: { host: "127.0.0.3" } })).status, 403, "another loopback address is not this server's name");
  });
});

describe("what a token buys under a foreign Host", () => {
  it("lets a valid Bearer through, which keeps a loopback server behind a proxy working", async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    const ok = await rawRequest(base, "/api/health", { headers: { host: "ancilla.proxy.example", authorization: "Bearer secret" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
  });

  it("does not let a wrong Bearer, a cookie or ?token= through", async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    const wrong = await rawRequest(base, "/api/health", { headers: { host: FOREIGN, authorization: "Bearer nope" } });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.kind, "host");
    const cookie = await rawRequest(base, "/api/health", { headers: { host: FOREIGN, cookie: "ancilla_token=secret" } });
    assert.equal(cookie.status, 403);
    assert.equal(cookie.json.kind, "host");
    const query = await rawRequest(base, "/api/health?token=secret", { headers: { host: FOREIGN } });
    assert.equal(query.status, 403);
    assert.equal(query.json.kind, "host");
    const handshake = await rawRequest(base, "/api/auth", {
      method: "POST",
      headers: { host: FOREIGN, "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    });
    assert.equal(handshake.status, 403, "the handshake is no way around the Host check");
    assert.equal(handshake.headers["set-cookie"], undefined);
  });

  it("gives a Bearer nothing to match when the server has no token", async () => {
    const { base } = await start(new FakeConnection());
    const reply = await rawRequest(base, "/api/health", { headers: { host: FOREIGN, authorization: "Bearer anything" } });
    assert.equal(reply.status, 403);
  });

  it("keeps the Bearer-or-cookie rule: a stale Bearer beside a good cookie is let in", async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    const reply = await rawRequest(base, "/api/health", { headers: { authorization: "Bearer stale", cookie: "ancilla_token=secret" } });
    assert.equal(reply.status, 200);
    assert.equal((await rawRequest(base, "/api/health", { headers: { authorization: "Bearer stale" } })).status, 401);
  });
});

describe("hosts that are allowed on purpose", () => {
  it("takes --allow-host on a loopback bind, and nothing that was not listed", async () => {
    const { base } = await start(new FakeConnection(), { allowHosts: ["Ancilla.Example"] });
    assert.equal((await rawRequest(base, "/api/health", { headers: { host: "ancilla.example" } })).status, 200);
    assert.equal((await rawRequest(base, "/api/health", { headers: { host: `ANCILLA.example:8443` } })).status, 200);
    assert.equal((await rawRequest(base, "/api/health", { headers: { host: `127.0.0.1:${portOf(base)}` } })).status, 200);
    assert.equal((await rawRequest(base, "/api/health", { headers: { host: "other.example" } })).status, 403);
  });

  it("takes the host of every --allow-origin URL", async () => {
    const { base } = await start(new FakeConnection(), { allowOrigins: ["https://ancilla.example:8443", "https://second.example"] });
    for (const host of ["ancilla.example", "ancilla.example:8443", "second.example"]) {
      assert.equal((await rawRequest(base, "/api/health", { headers: { host } })).status, 200, host);
    }
    assert.equal((await rawRequest(base, "/api/health", { headers: { host: FOREIGN } })).status, 403);
  });

  it("checks a non-loopback bind only once --allow-host is given, and then refuses what is not listed", async () => {
    const open = await start(new FakeConnection(), { host: "0.0.0.0", token: "secret" });
    assert.equal(
      (await rawRequest(open.base, "/api/health", { headers: { host: "anything.example", cookie: "ancilla_token=secret" } })).status,
      200,
      "the README recipe (--host 0.0.0.0 with a token) answers every Host as before",
    );
    const fenced = await start(new FakeConnection(), { host: "0.0.0.0", token: "secret", allowHosts: ["ancilla.example"] });
    const cookie = "ancilla_token=secret";
    assert.equal((await rawRequest(fenced.base, "/api/health", { headers: { host: "ancilla.example:3127", cookie } })).status, 200);
    assert.equal((await rawRequest(fenced.base, "/api/health", { headers: { host: `127.0.0.1:${portOf(fenced.base)}`, cookie } })).status, 200);
    const refused = await rawRequest(fenced.base, "/api/health", { headers: { host: "unlisted.example", cookie } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.kind, "host");
    assert.equal((await rawRequest(fenced.base, "/api/health", { headers: { host: "unlisted.example", authorization: "Bearer secret" } })).status, 200);
  });
});

describe("a bind that anyone on the network can reach", () => {
  it("is refused without a token, and the message says to pass --token", async () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com", ""]) {
      const server = new AncillaServer({ port: 0, host, dataDir: ":memory:", platform: "linux", home: tmpdir() });
      after(async () => { await server.close().catch(() => undefined); });
      await assert.rejects(server.listen(), /--token/, `host ${JSON.stringify(host)}`);
    }
  });

  it("is refused with an empty token too", async () => {
    const server = new AncillaServer({ port: 0, host: "0.0.0.0", token: "", dataDir: ":memory:", platform: "linux", home: tmpdir() });
    after(async () => { await server.close().catch(() => undefined); });
    await assert.rejects(server.listen(), /--token/);
  });

  it("starts with a token, and a loopback bind starts without one", async () => {
    const { base } = await start(new FakeConnection(), { host: "0.0.0.0", token: "secret" });
    assert.equal((await rawRequest(base, "/api/health", { headers: { authorization: "Bearer secret" } })).status, 200);
    const local = new AncillaServer({ port: 0, host: "localhost", dataDir: ":memory:", platform: "linux", home: tmpdir() });
    after(async () => { await local.close().catch(() => undefined); });
    const bound = await local.listen();
    assert.equal(bound.host, "localhost");
  });
});

describe("Fetch Metadata", () => {
  it("refuses a cross-site or same-site request to the API that is not a navigation", async () => {
    const { base } = await start(new FakeConnection());
    for (const [site, mode] of [["cross-site", "no-cors"], ["cross-site", "cors"], ["same-site", "no-cors"], ["same-site", "cors"]] as const) {
      const reply = await rawRequest(base, "/api/health", { headers: { "sec-fetch-site": site, "sec-fetch-mode": mode } });
      assert.equal(reply.status, 403, `${site} ${mode}`);
      assert.equal(reply.json.kind, "fetchMetadata", `${site} ${mode}`);
    }
  });

  it("lets through absent headers, same-origin and user navigations, and anything outside the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-fetch-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>shell</title>");
    const { base } = await start(new FakeConnection(), { staticDir: dir });
    assert.equal((await rawRequest(base, "/api/health")).status, 200, "an older webview sends no Fetch Metadata");
    assert.equal((await rawRequest(base, "/api/health", { headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" } })).status, 200);
    assert.equal((await rawRequest(base, "/api/health", { headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" } })).status, 200);
    assert.equal((await rawRequest(base, "/api/health", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).status, 200, "a link from another site opens the page");
    assert.equal((await rawRequest(base, "/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).status, 200);
  });

  it("is not applied when origins were listed: an image or frame from a listed site still loads", async () => {
    const { base } = await start(new FakeConnection(), { allowOrigins: ["https://ancilla.example"] });
    const image = await rawRequest(base, "/api/health", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } });
    assert.equal(image.status, 200);
    const frame = await rawRequest(base, "/api/health", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } });
    assert.equal(frame.status, 200);
  });
});

describe("input that used to end in a 500", () => {
  it("answers a cookie with a malformed escape as no cookie", async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    for (const cookie of ["ancilla_token=%E0%A4%A", "helicon_token=%", "ancilla_token=%zz; other=1"]) {
      const reply = await rawRequest(base, "/api/health", { headers: { cookie } });
      assert.equal(reply.status, 401, cookie);
    }
    assert.equal((await rawRequest(base, "/api/health", { headers: { cookie: "ancilla_token=%E0%A4%A; helicon_token=secret" } })).status, 200, "the other cookie still counts");
  });

  it("answers a malformed escape in a path segment with 400", async () => {
    const { base } = await start(new FakeConnection());
    const cases: [string, string][] = [
      ["POST", "/api/sessions/%zz/shell-proxy"],
      ["GET", "/api/sessions/%E0%A4%A/output?itemId=a&outputRef=b"],
      ["GET", "/api/sessions/%zz"],
      ["POST", "/api/accounts/%zz/login"],
      ["PATCH", "/api/accounts/%zz"],
      ["DELETE", "/api/accounts/%zz"],
      ["GET", "/api/research/%zz"],
      ["GET", "/api/research/%zz/export"],
    ];
    for (const [method, path] of cases) {
      const reply = await rawRequest(base, path, { method, headers: { "content-type": "application/json" }, body: method === "POST" || method === "PATCH" ? "{}" : undefined });
      assert.equal(reply.status, 400, `${method} ${path}`);
      assert.equal(typeof reply.json?.error, "string", `${method} ${path}`);
    }
    // A well-formed escape still reaches the route.
    assert.equal((await rawRequest(base, "/api/sessions/s%2D1/output?itemId=a&outputRef=b")).status !== 400, true);
  });
});

describe("the handshake body", () => {
  it("is refused when it is larger than a token could be, before the token is compared", async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    const body = JSON.stringify({ token: "secret", pad: "x".repeat(1024 * 1024) });
    // A server that answers and closes with a megabyte unread may reset the connection under the client; either way
    // the cookie must not have been handed out.
    const outcome = await rawRequest(base, "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body }).then(
      (reply) => reply,
      (error: NodeJS.ErrnoException) => error,
    );
    if (outcome instanceof Error) {
      // Windows can report a write to a connection the server already reset as ECONNABORTED.
      assert.match(String(outcome.code), /ECONNRESET|EPIPE|ECONNABORTED/);
    } else {
      assert.equal(outcome.status, 413);
      assert.equal(outcome.headers["set-cookie"], undefined);
    }
  });

  // The next two put the request on the wire by hand: no body is sent for the first, so only a server that decides
  // from the header alone can answer, and the chunked one has no Content-Length to decide from.
  const head = (framing: string) => `POST /api/auth HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\ncontent-type: application/json\r\n${framing}\r\n`;

  it("refuses a declared size above the cap on the header alone, without waiting for the body", { timeout: 30_000 }, async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    const reply = await rawWire(base, [head("content-length: 10000\r\n")]);
    assert.equal(reply.status, 413);
    assert.equal(reply.headers["set-cookie"], undefined);
  });

  it("refuses a chunked body that runs past the cap", { timeout: 30_000 }, async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    const reply = await rawWire(base, [head("transfer-encoding: chunked\r\n"), `${(10000).toString(16)}\r\n`, "x".repeat(10000), "\r\n0\r\n\r\n"]);
    assert.equal(reply.status, 413);
    assert.equal(reply.headers["set-cookie"], undefined);
  });

  it("makes room for the token it was started with, so a long or escape-heavy token never locks itself out", async () => {
    // A quote costs two bytes in the JSON body and a control character six, which is what the cap allows per character.
    for (const token of ["k".repeat(3000), '"'.repeat(3000), "\u0001".repeat(3000)]) {
      const { base } = await start(new FakeConnection(), { token });
      const reply = await rawRequest(base, "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      assert.equal(reply.status, 200, `a token of ${token.length} characters starting with U+${token.charCodeAt(0).toString(16).padStart(4, "0")}`);
      assert.match(String(reply.headers["set-cookie"]), /^ancilla_token=/);
    }
  });

  it("still takes a normal handshake, a wrong token and a short body", async () => {
    const { base } = await start(new FakeConnection(), { token: "secret" });
    const good = await rawRequest(base, "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret" }) });
    assert.equal(good.status, 200);
    assert.match(String(good.headers["set-cookie"]), /ancilla_token=secret/);
    assert.equal((await send(base, "/api/auth", { token: "wrong" })).status, 401);
    assert.equal((await send(base, "/api/auth", { token: "wrong".repeat(300) })).status, 401);
    assert.equal((await send(base, "/api/auth", {})).status, 401);
  });
});

describe("framing", () => {
  it("keeps Ancilla out of other sites' frames: JSON answers and the static shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-frame-static-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>shell</title>");
    await writeFile(join(dir, "app.js"), "export {}");
    const { base } = await start(new FakeConnection(), { staticDir: dir });
    for (const path of ["/api/health", "/api/nope", "/", "/app.js", "/missing.html"]) {
      const reply = await rawRequest(base, path);
      assert.match(String(reply.headers["content-security-policy"]), /frame-ancestors 'self'/, path);
      assert.equal(reply.headers["x-frame-options"], "SAMEORIGIN", path);
    }
  });

  it("leaves project files alone: the PDF preview frames /api/files/raw from the same origin", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-frame-project-"));
    await writeFile(join(cwd, "a.txt"), "hello");
    await writeFile(join(cwd, "doc.pdf"), "%PDF-1.4\n");
    const { base } = await start(connection);
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    for (const name of ["a.txt", "doc.pdf"]) {
      const reply = await rawRequest(base, `/api/files/raw?cwd=${encodeURIComponent(cwd)}&path=${name}`);
      assert.equal(reply.status, 200, name);
      assert.equal(reply.headers["x-frame-options"], undefined, name);
      assert.doesNotMatch(String(reply.headers["content-security-policy"] ?? ""), /frame-ancestors/, name);
    }
  });
});
