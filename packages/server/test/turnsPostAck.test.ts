/**
 * POST /api/turns once Muse has the prompt. What Ancilla writes after that (the saved attachments, the thread's
 * activity stamp) can fail without the prompt having failed, and the answer must say so: a 5xx for a prompt Muse
 * accepted makes the client think nothing was sent, and the user sends it again.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeConnection, send, start } from "./harness.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

interface Store {
  addAttachment(input: Record<string, unknown>): unknown;
  updateSession(id: string, patch: Record<string, unknown>): unknown;
}

async function rig() {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  let turns = 0;
  connection.replies.set("turn/start", () => ({ turnId: `t${++turns}`, status: "accepted", disposition: "started" }));
  const cwd = await mkdtemp(join(tmpdir(), "ancilla-ack-"));
  const logs: string[] = [];
  const { server, base } = await start(connection);
  (server as unknown as { log: (line: string) => void }).log = (line) => {
    logs.push(line);
  };
  assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
  const store = (server as unknown as { store: Store }).store;
  return { connection, base, cwd, store, logs };
}

describe("a turn Muse has accepted", () => {
  it("is still answered as accepted when saving its attachments fails", async () => {
    const { base, store, logs } = await rig();
    store.addAttachment = () => {
      throw new Error("database is locked");
    };
    const sent = await send(base, "/api/turns", {
      sessionId: "s1",
      text: "look",
      attachments: [{ name: "shot.png", mediaType: "image/png", base64: PNG_BASE64 }],
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.turnId, "t1");
    assert.equal(sent.json.disposition, "started");
    assert.deepEqual(sent.json.attachments, [], "what could not be saved is simply not listed");
    assert.ok(logs.some((line) => /database is locked/.test(line)), `the failure is logged: ${logs.join(" | ")}`);
  });

  it("keeps the attachments that did save when one of several fails", async () => {
    const { base, store } = await rig();
    const real = store.addAttachment.bind(store);
    let calls = 0;
    store.addAttachment = (input: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("one write failed");
      }
      return real(input);
    };
    const sent = await send(base, "/api/turns", {
      sessionId: "s1",
      text: "look",
      attachments: [
        { name: "a.png", mediaType: "image/png", base64: PNG_BASE64 },
        { name: "b.png", mediaType: "image/png", base64: PNG_BASE64 },
      ],
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(sent.json.attachments.map((file: { name: string }) => file.name), ["b.png"]);
  });

  it("is still answered as accepted when stamping the thread's activity fails", async () => {
    const { base, store, connection } = await rig();
    store.updateSession = () => {
      throw new Error("disk I/O error");
    };
    const sent = await send(base, "/api/turns", { sessionId: "s1", text: "go" });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.turnId, "t1");
    assert.equal(connection.of("turn/start").length, 1, "and the prompt went exactly once");
  });

  it("is still an error when Muse itself refuses the prompt", async () => {
    const { base, connection } = await rig();
    connection.replies.set("turn/start", Object.assign(new Error("Muse said no"), { kind: "turnRefused" }));
    const sent = await send(base, "/api/turns", { sessionId: "s1", text: "go" });
    assert.ok(sent.status >= 400, `a refused prompt is not an accepted one: ${sent.status}`);
  });
});

describe("attachments of a send that failed before Muse took it", () => {
  const notLoaded = () => Object.assign(new Error("The session is not loaded."), { kind: "sessionNotLoaded" });
  const file = (text = "contents") => ({ name: "notes.txt", mediaType: "text/plain", base64: b64(text) });

  it("are reused when the same file is sent again, so a retry leaves one file", async () => {
    const { base, cwd, connection } = await rig();
    const accepted = connection.replies.get("turn/start");
    connection.replies.set("turn/start", notLoaded());
    const first = await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    assert.equal(first.status, 409, JSON.stringify(first.json));
    assert.equal(first.json.kind, "sessionNotLoaded");
    assert.deepEqual(await readdir(join(cwd, ".ancilla", "attachments")), ["notes.txt"]);

    connection.replies.set("turn/start", accepted);
    const retry = await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.deepEqual(await readdir(join(cwd, ".ancilla", "attachments")), ["notes.txt"], "the retry did not leave a second copy");
    const input = connection.of("turn/start").at(-1)?.params?.["input"] as { text?: string }[];
    assert.equal(input[0]?.text, "read\n\n@.ancilla/attachments/notes.txt", "and it points at the file the first attempt wrote");
    assert.equal(retry.json.attachments[0].name, "notes.txt");
  });

  it("are reused only for the same bytes, and only until a send has succeeded", async () => {
    const { base, cwd, connection } = await rig();
    const dir = join(cwd, ".ancilla", "attachments");
    const accepted = connection.replies.get("turn/start");
    connection.replies.set("turn/start", notLoaded());
    await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file("first version")] });
    // The positive leg: the same file again is the one on disk, which is what makes the legs after it mean something.
    await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file("first version")] });
    assert.deepEqual(await readdir(dir), ["notes.txt"], "a second failed try of the same file reuses it");
    connection.replies.set("turn/start", accepted);

    const edited = await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file("second version")] });
    assert.equal(edited.status, 200);
    assert.deepEqual((await readdir(dir)).sort(), ["notes-2.txt", "notes.txt"], "other bytes under the same name are a file of their own");
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "first version");
    assert.equal(await readFile(join(dir, "notes-2.txt"), "utf8"), "second version");

    const taken = await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file("first version")] });
    assert.equal(taken.status, 200);
    assert.equal((await readdir(dir)).length, 2, "the send that finally goes through uses the file already written for it");

    const again = await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file("first version")] });
    assert.equal(again.status, 200);
    assert.deepEqual((await readdir(dir)).sort(), ["notes-2.txt", "notes-3.txt", "notes.txt"], "once a send has succeeded, the same file is a new copy again");
  });

  it("are not reused when the file is gone", async () => {
    const { base, cwd, connection } = await rig();
    const dir = join(cwd, ".ancilla", "attachments");
    const accepted = connection.replies.get("turn/start");
    connection.replies.set("turn/start", notLoaded());
    await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    assert.deepEqual(await readdir(dir), ["notes.txt"], "reused while it is there");
    connection.replies.set("turn/start", accepted);
    await rm(join(dir, "notes.txt"));
    const retry = await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "contents", "it was written again");
  });

  it("are not reused when the file was changed after the failed attempt", async () => {
    const { base, cwd, connection } = await rig();
    const dir = join(cwd, ".ancilla", "attachments");
    const accepted = connection.replies.get("turn/start");
    connection.replies.set("turn/start", notLoaded());
    await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    assert.deepEqual(await readdir(dir), ["notes.txt"], "reused while it is as it was written");
    connection.replies.set("turn/start", accepted);
    await writeFile(join(dir, "notes.txt"), "someone edited this file, so it is longer now");
    const retry = await send(base, "/api/turns", { sessionId: "s1", text: "read", attachments: [file()] });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "someone edited this file, so it is longer now", "the edited file is left alone");
    assert.equal(await readFile(join(dir, "notes-2.txt"), "utf8"), "contents", "and what was attached is written beside it");
  });
});
