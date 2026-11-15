import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AuditLog, maskArgs } from "../src/connectors/audit.js";
import { BREVO, CATALOG, GITHUB, SUPABASE } from "../src/connectors/catalog.js";
import { cut, flattenResult, HIDDEN, offerTools, parametersOf, redact, sanitizeSchema } from "../src/connectors/manifest.js";
import { FileSecretStore } from "../src/connectors/secrets.js";
import { LISTED_WRITES, OTHER_KEY, SCHEMA, TOKEN, WRITE_TOOLS, fakeServer, piece, readNames } from "./connectors-fixtures.js";

/**
 * The parts of a connector that need no server: the tool list that is ours alone, what is stripped from a server's words, what
 * is hidden in what comes back, where the token is kept, and what is written down.
 */

const dir = () => mkdtempSync(join(tmpdir(), "ancilla-connectors-"));

describe("the tool list that is ours", () => {
  it("offers only the tools on the list, in the list's order, in our words, and says what it left out", () => {
    const server = fakeServer();
    const offering = offerTools(GITHUB, server.tools);
    assert.deepEqual(offering.offered.map((t) => t.name), readNames(GITHUB), "every read tool of the list, and nothing else: no kind of change is switched on");
    assert.deepEqual(offering.off, LISTED_WRITES, "the changes on the list are held back by the settings, not hidden");
    assert.equal(offering.offered[0]?.text, GITHUB.tools["get_me"]?.text, "our description, never the server's");
    for (const name of WRITE_TOOLS) assert.ok(offering.hidden.includes(name), `${name} is hidden`);
    const on = offerTools(GITHUB, server.tools, { reversible: "off", communicates: "ask", destructive: "off" });
    assert.deepEqual(on.offered.filter((t) => t.class !== "read").map((t) => t.name), ["add_issue_comment", "issue_write", "create_pull_request"], "one kind switched on offers the tools of that kind and no other");
    assert.deepEqual(on.off, ["create_branch", "merge_pull_request"]);
    assert.ok(offering.hidden.includes("get_secret_scanning_alert"), "a read tool that is not on the list is not offered either");
    assert.deepEqual(offering.missing, []);
  });

  it("does not offer a tool the server renamed, says so, and cannot be fooled by a tool called __proto__ or constructor", () => {
    const tools = fakeServer().tools.filter((t) => t.name !== "search_issues" && t.name !== "get_me");
    const offering = offerTools(GITHUB, tools);
    assert.deepEqual(offering.missing.sort(), ["get_me", "search_issues"]);
    assert.ok(!offering.offered.some((t) => t.name === "search_issues"));
    assert.ok(offering.hidden.includes("__proto__") && offering.hidden.includes("constructor"));
    assert.ok(!offering.offered.some((t) => t.name === "__proto__" || t.name === "constructor"));
  });

  it("classes every tool: a read never reads like a change, a change is in a class the person can switch, and the check is a read", () => {
    const changes = /(^|_)(create|update|delete|write|merge|push|send|run|apply|deploy|remove|set|post|add|dismiss|mark|manage|assign|fork|star|unstar|submit|restore|pause|reset|rebase)(_|$)/;
    for (const manifest of CATALOG) {
      for (const [name, entry] of Object.entries(manifest.tools)) {
        if (entry.class === "read") assert.ok(!changes.test(name), `${manifest.id}.${name} is classed as a read but reads like a change`);
        else assert.ok(["reversible", "communicates", "destructive"].includes(entry.class) && changes.test(name), `${manifest.id}.${name}`);
      }
      assert.equal(manifest.tools[manifest.probe.tool]?.class, "read", `${manifest.id}: the check is a read on the list`);
      assert.ok(readNames(manifest).length <= 14, `${manifest.id}: every offered tool costs tokens on every step`);
      assert.ok(Object.keys(manifest.tools).length - readNames(manifest).length <= 8, `${manifest.id}: and so does every tool that changes something`);
    }
    assert.deepEqual(Object.entries(GITHUB.tools).filter(([, e]) => e.class !== "read").map(([n, e]) => [n, e.class]), [["create_branch", "reversible"], ["add_issue_comment", "communicates"], ["issue_write", "communicates"], ["create_pull_request", "communicates"], ["merge_pull_request", "destructive"]]);
    for (const manifest of CATALOG) {
      assert.ok(
        Object.entries(manifest.tools).filter(([, e]) => e.class !== "read").every(([, e]) => e.target !== undefined),
        `${manifest.id}: every tool that changes something names the target it is about`,
      );
    }
    assert.deepEqual(
      Object.entries(SUPABASE.tools).filter(([, e]) => e.class !== "read").map(([n, e]) => [n, e.class]),
      [["create_branch", "reversible"], ["apply_migration", "destructive"]],
    );
    assert.deepEqual(
      Object.entries(BREVO.tools).filter(([, e]) => e.class !== "read").map(([n, e]) => [n, e.class]),
      [["contacts_create_contact", "reversible"], ["transactional_emails_send_transac_email", "communicates"]],
    );
    assert.deepEqual(CATALOG.map((m) => m.id), ["github", "gmail", "google_drive", "supabase", "brevo", "hostinger"]);
    assert.ok(!Object.hasOwn(SUPABASE.tools, "execute_sql"), "arbitrary SQL waits for the gate that reads the statement");
    assert.ok(BREVO.caution && SUPABASE.caution, "a provider that cannot limit the token says so before the token is given");
  });

  it("keeps the shape of a tool's arguments and nothing a server wrote to persuade", () => {
    const params = parametersOf(SCHEMA);
    assert.deepEqual(params, { type: "object", properties: { query: { type: "string" }, page: { type: "integer", minimum: 1, default: 1 }, sort: { type: "string", enum: ["created", "updated"] } }, required: ["query"] });
    assert.ok(!JSON.stringify(params).includes("evil@example.com"), "no description, title or example survives");
    assert.deepEqual(parametersOf(null), { type: "object", properties: {} });
    const deep = sanitizeSchema({ type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "object", properties: { e: { type: "string" } } } } } } } } } } });
    assert.ok(JSON.stringify(deep).length < 400, "depth is limited");
    const wide = sanitizeSchema({ type: "object", properties: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`p${i}`, { type: "string" }])) });
    assert.equal(Object.keys(wide["properties"] as object).length, 24, "and so is width");
  });
});

describe("what comes back", () => {
  it("hides every credential shape, and the connector's own token wherever it shows", () => {
    const text = [
      `token ${TOKEN}`,
      OTHER_KEY,
      piece("sb", "p_", "0123456789abcdef0123456789abcdef01234567"),
      piece("xkey", "sib-", "0123456789abcdef0123456789abcdef-AbCdEf"),
      piece("Authorization: Bear", "er abcdefghijklmnopqrstuvwxyz123456"),
      piece("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      piece("-----BEGIN RSA PRIV", "ATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIV", "ATE KEY-----"),
      "my own secret value s3cr3t-value-123",
      "an ordinary sentence about issue 42 and a link https://github.com/o/r/issues/42",
    ].join("\n");
    const out = redact(text, ["s3cr3t-value-123"]);
    for (const secret of [TOKEN, OTHER_KEY, piece("sb", "p_0123"), piece("xkey", "sib-0123"), "abcdefghijklmnopqrstuvwxyz123456", "eyJhbGci", "MIIBOgIBAAJBAK", "s3cr3t-value-123"]) assert.ok(!out.includes(secret), `${secret.slice(0, 12)} is hidden`);
    assert.ok(out.includes(HIDDEN));
    assert.ok(out.includes("an ordinary sentence about issue 42 and a link https://github.com/o/r/issues/42"), "and nothing else is touched");
    assert.equal(redact("short", ["abc"]), "short", "a known value too short to be a secret is not a reason to mangle words");
  });

  it("keeps text, names anything else and leaves it out, flags an error, and cuts what is long", () => {
    const out = flattenResult({ content: [{ type: "text", text: "one" }, { type: "image", data: "AAAA" }, { type: "resource", resource: { uri: "file:///x", text: "two" } }, { type: "resource_link", uri: "https://example.com" }], isError: true });
    assert.deepEqual(out, { text: "one\n[image left out]\ntwo\n[content left out]", isError: true });
    assert.deepEqual(flattenResult({ toolResult: 1 } as never), { text: "", isError: false });
    assert.equal(cut("short", 100), "short");
    const long = cut("x".repeat(6000), 4000);
    assert.ok(long.length < 4100 && long.includes("(cut: "));
  });
});

describe("where the token is kept", () => {
  it("is a file only the user can read, that survives a restart and goes when it is deleted", () => {
    const path = join(dir(), "connectors", "secrets.json");
    const first = new FileSecretStore(path);
    assert.equal(first.get("github"), null);
    first.set("github", TOKEN);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600, "mode 0600");
    assert.equal(new FileSecretStore(path).get("github"), TOKEN, "a new process reads it");
    assert.equal(first.has("github"), true);
    assert.equal(first.delete("github"), true);
    assert.equal(first.delete("github"), false);
    assert.equal(new FileSecretStore(path).get("github"), null);
    assert.match(first.where, /only your user account can read/);
  });

  it("lives in memory with no path, and treats a damaged file as empty instead of failing", () => {
    const memory = new FileSecretStore(null);
    memory.set("brevo", "k".repeat(20));
    assert.equal(memory.get("brevo"), "k".repeat(20));
    assert.match(memory.where, /memory/);
    const path = join(dir(), "secrets.json");
    writeFileSync(path, "{ not json");
    const lines: string[] = [];
    const store = new FileSecretStore(path, Date.now, (line) => lines.push(line));
    assert.equal(store.get("github"), null);
    assert.equal(lines.length, 1);
    store.set("github", TOKEN);
    assert.equal(new FileSecretStore(path).get("github"), TOKEN);
    assert.equal(store.get("__proto__"), null, "an id that is a name on every object is not a secret");
  });
});

describe("what is written down", () => {
  it("is one line a call, newest first, with the arguments cut and any credential hidden", () => {
    const path = join(dir(), "activity.jsonl");
    const audit = new AuditLog(path);
    audit.add({ at: 1, kind: "connect", connector: "github", ok: true, note: `accepted ${TOKEN}` });
    audit.add({ at: 2, kind: "call", connector: "github", task: "t1", tool: "search_issues", args: maskArgs({ query: `is:open ${TOKEN}`, long: "y".repeat(500) }, [TOKEN]), ok: true, size: 120, ms: 8 });
    const entries = audit.recent(10);
    assert.deepEqual(entries.map((e) => e.at), [2, 1]);
    const raw = readFileSync(path, "utf8");
    assert.ok(!raw.includes(TOKEN) && !raw.includes("github_pat_"), "no credential reaches the file");
    assert.ok((entries[0]?.args ?? "").length <= 400);
    assert.equal(entries[1]?.note?.includes(HIDDEN), true);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("starts a new file when one is full, keeps going in memory with no path, and survives a half-written line", () => {
    const path = join(dir(), "activity.jsonl");
    writeFileSync(path, `${"{}\n".repeat(700_000)}`);
    const audit = new AuditLog(path);
    audit.add({ at: 5, kind: "mode", connector: "brevo", ok: true });
    assert.equal(statSync(`${path}.1`).size > 2_000_000, true, "the full file was kept aside");
    assert.equal(audit.recent(5).length, 1);
    writeFileSync(path, `${JSON.stringify({ at: 1, kind: "test", connector: "x", ok: true })}\n{"at":2,"kind":"te`);
    assert.deepEqual(audit.recent(5).map((e) => e.at), [1]);
    const memory = new AuditLog(null);
    for (let i = 0; i < 520; i += 1) memory.add({ at: i, kind: "call", connector: "x", ok: true });
    assert.equal(memory.recent(1000).length, 500);
    assert.equal(memory.recent(1000)[0]?.at, 519);
  });
});
