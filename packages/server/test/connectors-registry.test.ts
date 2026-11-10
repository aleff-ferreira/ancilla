import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConflictError, NotFoundError, ValidationError } from "../src/assistant/store.js";
import { AuditLog } from "../src/connectors/audit.js";
import { GITHUB } from "../src/connectors/catalog.js";
import { ConnectorError } from "../src/connectors/connection.js";
import { RESULT_MAX } from "../src/connectors/manifest.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { FileSecretStore } from "../src/connectors/secrets.js";
import { OTHER_KEY, TOKEN, WRITE_TOOLS, fakeServer, openerFor, type FakeServer } from "./connectors-fixtures.js";

/** Which accounts are connected, what is kept, and the one door to a connection: the registry and the session it opens. */

function rig(options: { server?: FakeServer; folder?: string } = {}) {
  const server = options.server ?? fakeServer();
  const audit = new AuditLog(null);
  const secrets = new FileSecretStore(options.folder ? join(options.folder, "secrets.json") : null);
  const registry = new ConnectorRegistry({ file: options.folder ? join(options.folder, "connectors.json") : null, secrets, audit, open: openerFor(server), now: () => 1_000 });
  return { server, audit, secrets, registry };
}

const ctx = () => ({ task: "t_1", signal: new AbortController().signal });

describe("connecting an account", () => {
  it("keeps a token only when the server accepts it and the check passes, and shows the person what it will be given", async () => {
    const r = rig();
    assert.equal(r.registry.view("github").connected, false);
    assert.deepEqual(r.registry.usable(), []);
    const view = await r.registry.connect("github", `  ${TOKEN}  `);
    assert.equal(view.connected, true);
    assert.equal(view.mode, "read");
    assert.equal(view.test?.ok, true);
    assert.deepEqual(view.test?.offered.map((t) => t.name), Object.keys(GITHUB.tools));
    assert.equal(view.test?.hidden, WRITE_TOOLS.length + 3, "the writes, a read tool that is not on the list, and the two odd names are not offered");
    assert.match(view.test?.message ?? "", /Works\. 12 read tools are offered, and 11 more that it has are not offered/);
    assert.equal(r.secrets.get("github"), TOKEN, "trimmed, and kept where only the user can read it");
    assert.deepEqual(r.registry.usable(), ["github"]);
    assert.equal(r.server.closed, r.server.opened, "every connection it opened was closed");
    const everything = JSON.stringify([r.registry.views(), r.audit.recent(50)]);
    assert.ok(!everything.includes(TOKEN) && !everything.includes("github_pat_"), "the token is in no view and no activity line");
  });

  it("refuses what is not a token, a token the server refuses, a server with nothing to read, and a check that fails, and keeps nothing", async () => {
    const r = rig();
    for (const bad of ["", "short", "has a space in it 12345", "line\nbreak-0123456789", "x".repeat(2100), 42, null]) {
      await assert.rejects(() => r.registry.connect("github", bad), (error: unknown) => error instanceof ValidationError);
    }
    await assert.rejects(() => r.registry.connect("github", "wrong-token-0123456789"), (error: unknown) => error instanceof ConnectorError && /401/.test(error.message) && !error.message.includes("wrong-token"));

    const writesOnly = rig({ server: fakeServer({ tools: WRITE_TOOLS.map((name) => ({ name, inputSchema: {} })) }) });
    await assert.rejects(() => writesOnly.registry.connect("github", TOKEN), /none of the tools Ancilla reads with are offered/);

    const broken = rig({ server: fakeServer({ answer: () => ({ text: "Bad credentials", isError: true }) }) });
    await assert.rejects(() => broken.registry.connect("github", TOKEN), /the check failed: Bad credentials/);

    for (const each of [r, writesOnly, broken]) {
      assert.equal(each.secrets.has("github"), false, "nothing was kept");
      assert.equal(each.registry.view("github").connected, false);
    }
    assert.ok(r.audit.recent(20).some((e) => e.kind === "connect" && !e.ok), "a refusal is written down too");
    assert.equal(r.server.closed, r.server.opened);
    await assert.rejects(() => r.registry.connect("nothing", TOKEN), (error: unknown) => error instanceof NotFoundError);
  });

  it("checks again with the saved token, and a token that was revoked shows as a failed check, not a crash", async () => {
    const r = rig();
    await r.registry.connect("github", TOKEN);
    r.server.tokens = [];
    const after = await r.registry.test("github");
    assert.equal(after.test?.ok, false);
    assert.match(after.test?.message ?? "", /did not accept the token/);
    assert.equal(after.connected, true, "it stays connected: the person decides to disconnect");
    r.server.tokens = [TOKEN];
    assert.equal((await r.registry.test("github")).test?.ok, true);
    await assert.rejects(() => r.registry.test("brevo"), (error: unknown) => error instanceof ConflictError);
  });
});

describe("using and stopping an account", () => {
  it("is switched off, or on for reading, by the person; off means no task and no session", async () => {
    const r = rig();
    await r.registry.connect("github", TOKEN);
    assert.deepEqual(r.registry.ready("github"), { ok: true });
    assert.equal(r.registry.setMode("github", "off").mode, "off");
    assert.match(r.registry.ready("github").reason ?? "", /GitHub is switched off\. Switch it on under Assistant, Connectors\./);
    assert.deepEqual(r.registry.usable(), []);
    await assert.rejects(() => r.registry.open("github"), (error: unknown) => error instanceof ConflictError && /switched off/.test(error.message));
    assert.equal(r.registry.setMode("github", "read").mode, "read");
    assert.throws(() => r.registry.setMode("github", "write"), (error: unknown) => error instanceof ValidationError);
    assert.throws(() => r.registry.setMode("brevo", "read"), (error: unknown) => error instanceof ConflictError);
    assert.match(r.registry.ready("brevo").reason ?? "", /Brevo is not connected/);
  });

  it("forgets the token and the settings on disconnect, and says where to revoke it, because it cannot", async () => {
    const r = rig();
    await r.registry.connect("github", TOKEN);
    const view = r.registry.disconnect("github");
    assert.equal(view.connected, false);
    assert.equal(r.secrets.has("github"), false);
    assert.match(view.revoke.text, /delete the token/);
    assert.match(view.revoke.url, /^https:\/\/github\.com\//);
    assert.ok(r.audit.recent(10).some((e) => e.kind === "disconnect"));
    assert.equal(r.registry.disconnect("github").connected, false, "doing it again is harmless");
  });

  it("is still connected after a restart, from the files, and a token with no settings (or settings with no token) is not a connection", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ancilla-registry-"));
    const first = rig({ folder });
    await first.registry.connect("github", TOKEN);
    first.registry.setMode("github", "off");
    const second = rig({ folder, server: first.server });
    const view = second.registry.view("github");
    assert.equal(view.connected, true);
    assert.equal(view.mode, "off");
    assert.equal(view.test?.ok, true);
    second.secrets.delete("github");
    assert.equal(second.registry.view("github").connected, false, "settings with no token");
    const third = rig({ folder, server: first.server });
    third.secrets.set("brevo", "a-token-with-no-settings-0123");
    assert.equal(third.registry.view("brevo").connected, false, "a token with no settings");
  });
});

describe("a connection used for a task", () => {
  it("offers only what is on the list, refuses everything else without asking the server, and says what was done", async () => {
    const r = rig();
    await r.registry.connect("github", TOKEN);
    r.server.calls.length = 0;
    const session = await r.registry.open("github");
    assert.deepEqual(session.offered.map((t) => t.name), Object.keys(GITHUB.tools));
    assert.equal(await session.call("search_issues", { query: "is:open involves:aleff" }, ctx()), "answer of search_issues");
    for (const name of [...WRITE_TOOLS, "get_secret_scanning_alert", "__proto__", "constructor", "toString"]) {
      const refused = await session.call(name, { title: "x" }, ctx());
      assert.match(refused, /^There is no tool called /, name);
    }
    assert.deepEqual(r.server.calls.map((c) => c.name), ["search_issues"], "nothing else reached the server");
    const lines = r.audit.recent(50).filter((e) => e.kind === "call");
    assert.equal(lines.filter((e) => e.ok).length, 1);
    assert.equal(lines.filter((e) => !e.ok && e.note === "refused: not on the list").length, WRITE_TOOLS.length + 4);
    assert.equal(lines.find((e) => e.ok)?.task, "t_1");
    await session.close();
    assert.equal(r.server.closed, r.server.opened);
  });

  it("hides a credential in what comes back, cuts what is long, and says in words what failed", async () => {
    const r = rig();
    await r.registry.connect("github", TOKEN);
    r.server.answer = (name) => {
      if (name === "get_me") return { text: `the token is ${TOKEN} and a key ${OTHER_KEY}` };
      if (name === "search_issues") return { text: "z".repeat(9000) };
      if (name === "list_issues") return { text: "no access", isError: true };
      if (name === "get_commit") throw new ConnectorError("The server did not answer in time.");
      return { text: "" };
    };
    const session = await r.registry.open("github");
    const leaked = await session.call("get_me", {}, ctx());
    assert.ok(!leaked.includes(TOKEN) && !leaked.includes(OTHER_KEY.slice(0, 10)) && leaked.includes("[hidden]"));
    const long = await session.call("search_issues", { query: "x" }, ctx());
    assert.ok(long.length <= RESULT_MAX + 50 && long.includes("(cut: "));
    assert.equal(await session.call("list_issues", {}, ctx()), "The tool reported an error: no access");
    assert.equal(await session.call("get_commit", {}, ctx()), "That did not work: The server did not answer in time.");
    assert.equal(await session.call("list_commits", {}, ctx()), "(nothing came back)");
    const activity = JSON.stringify(r.audit.recent(50));
    assert.ok(!activity.includes(TOKEN) && !activity.includes(OTHER_KEY.slice(0, 10)));
    await session.close();
  });

  it("is not opened for an account that is not connected, nor for one that does not exist", async () => {
    const r = rig();
    await assert.rejects(() => r.registry.open("github"), (error: unknown) => error instanceof ConflictError && /not connected/.test(error.message));
    await assert.rejects(() => r.registry.open("nothing"), (error: unknown) => error instanceof NotFoundError);
  });
});
