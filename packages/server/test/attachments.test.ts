/**
 * Attachments over HTTP: how the stored bytes are served back, where a file lands in the workspace, and what a
 * link inside the project's own `.ancilla` folder can and cannot do. The server runs on a scripted MSP connection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn } from "@ancilla/daemon";
import { FakeConnection, fakeFactory, send, start } from "./harness.js";
import { safeFileName } from "../src/server.js";
import { tryLink, unlinkLink } from "./fsLinks.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

interface Rig {
  connection: FakeConnection;
  base: string;
  cwd: string;
  server: Awaited<ReturnType<typeof start>>["server"];
}

/** A server with one session in a real project folder, whose turns are accepted with a fresh id each. */
async function rig(extra: Parameters<typeof start>[1] = {}): Promise<Rig> {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  let turns = 0;
  connection.replies.set("turn/start", () => ({ turnId: `t${++turns}`, status: "accepted", disposition: "started" }));
  const cwd = await mkdtemp(join(tmpdir(), "ancilla-attach-"));
  const { server, base } = await start(connection, extra);
  const started = await send(base, "/api/sessions", { cwd });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  return { connection, base, cwd, server };
}

const attachmentsDir = (cwd: string) => join(cwd, ".ancilla", "attachments");

async function upload(base: string, file: { name: string; mediaType: string; base64: string }, text = "see attached") {
  return send(base, "/api/turns", { sessionId: "s1", text, attachments: [file] });
}

describe("attachment responses", () => {
  const INERT = [
    { sent: "text/html", name: "page.html", served: "application/octet-stream" },
    { sent: "application/xhtml+xml", name: "page.xhtml", served: "application/octet-stream" },
    { sent: "text/xml", name: "data.xml", served: "application/octet-stream" },
    { sent: "image/svg+xml", name: "logo.svg", served: "image/svg+xml" },
    { sent: "IMAGE/SVG+XML", name: "logo-upper.svg", served: "image/svg+xml" },
  ];

  for (const entry of INERT) {
    it(`serves ${entry.sent} as a download that cannot run as a page`, async () => {
      const { base } = await rig();
      const body = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
      const sent = await upload(base, { name: entry.name, mediaType: entry.sent, base64: b64(body) });
      assert.equal(sent.status, 200, JSON.stringify(sent.json));
      const res = await fetch(`${base}${sent.json.attachments[0].url}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), entry.served);
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment\b/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox\b/);
      assert.equal(res.headers.get("cross-origin-resource-policy"), null, "an img on another allowed origin still loads it");
      assert.equal(await res.text(), body, "the bytes are served exactly as stored");
    });
  }

  it("keeps a png inline, with the same hardening", async () => {
    const { base } = await rig();
    const sent = await upload(base, { name: "shot.png", mediaType: "image/png", base64: b64(PNG) });
    const res = await fetch(`${base}${sent.json.attachments[0].url}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-disposition"), "inline");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox\b/);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG));
  });

  it("maps image/jpg to image/jpeg and keeps it inline", async () => {
    const { base } = await rig();
    const sent = await upload(base, { name: "photo.jpg", mediaType: "image/jpg", base64: b64("jpeg bytes") });
    const res = await fetch(`${base}${sent.json.attachments[0].url}`);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("content-disposition"), "inline");
  });

  it("stores and serves a hostile media type as an opaque download", async () => {
    const { base, connection } = await rig();
    for (const mediaType of ["image/png\r\nX-Injected: yes", `text/${"a".repeat(25_000)}`, "not a type", "text/html; charset=utf-8"]) {
      const sent = await upload(base, { name: "odd.bin", mediaType, base64: b64("payload") });
      assert.equal(sent.status, 200, `${mediaType.slice(0, 30)}: ${JSON.stringify(sent.json).slice(0, 200)}`);
      const stored = sent.json.attachments[0];
      assert.ok(!/[\r\n]/.test(stored.mediaType), "no control characters survive");
      assert.ok(stored.mediaType.length <= 255, "a type is never longer than a header can carry");
      const res = await fetch(`${base}${stored.url}`);
      assert.equal(res.status, 200, `${mediaType.slice(0, 30)} must still be served`);
      assert.equal(res.headers.get("x-injected"), null);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment\b/);
      assert.equal(await res.text(), "payload");
    }
    assert.equal(connection.of("turn/start").length, 4);
  });

  it("makes an old row safe when it is read, whatever it was stored as", async () => {
    const { base, server } = await rig();
    const store = (server as unknown as { store: { addAttachment(input: Record<string, unknown>): unknown } }).store;
    const rows: [string, string, string, string][] = [
      ["old-jpg", "IMAGE/JPG", "image/jpeg", "inline"],
      ["old-html", "text/html", "application/octet-stream", "attachment"],
      ["old-crlf", "image/png\r\nX-Old: 1", "application/octet-stream", "attachment"],
      ["old-svg", "image/svg+xml", "image/svg+xml", "attachment"],
    ];
    rows.forEach(([id, mediaType], ord) => {
      store.addAttachment({ id, sessionId: "s1", turnId: null, ord, name: `${id}.bin`, mediaType, kind: "file", width: null, height: null, bytes: Buffer.from("old") });
    });
    for (const [id, , served, disposition] of rows) {
      const res = await fetch(`${base}/api/attachments/${id}`);
      assert.equal(res.status, 200, id);
      assert.equal(res.headers.get("content-type"), served, id);
      assert.match(res.headers.get("content-disposition") ?? "", new RegExp(`^${disposition}\\b`), id);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", id);
      assert.equal(res.headers.get("x-old"), null);
    }
  });
});

describe("attachments written into the workspace", () => {
  it("lands a file in .ancilla/attachments and mentions it in the prompt", async () => {
    const { base, cwd, connection } = await rig();
    const sent = await upload(base, { name: "notes.txt", mediaType: "text/plain", base64: b64("hello") }, "read this");
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(await readFile(join(attachmentsDir(cwd), "notes.txt"), "utf8"), "hello");
    const input = connection.of("turn/start")[0]?.params?.["input"] as { type: string; text?: string }[];
    assert.equal(input[0]?.text, "read this\n\n@.ancilla/attachments/notes.txt");
  });

  it("never overwrites a file: 60 uploads under one name leave 60 files", async () => {
    const { base, cwd } = await rig();
    for (let index = 0; index < 60; index += 1) {
      const sent = await upload(base, { name: "notes.txt", mediaType: "text/plain", base64: b64(`version ${index}`) });
      assert.equal(sent.status, 200, `upload ${index}: ${JSON.stringify(sent.json)}`);
    }
    const names = await readdir(attachmentsDir(cwd));
    assert.equal(names.length, 60, "every upload keeps a file of its own");
    const contents = new Set(await Promise.all(names.map((name) => readFile(join(attachmentsDir(cwd), name), "utf8"))));
    assert.equal(contents.size, 60, "and each one still holds what was uploaded");
    assert.ok(names.includes("notes.txt") && names.includes("notes-2.txt"), "the first names stay the readable ones");
  });

  it("never overwrites a file when eight uploads of one name arrive together", async () => {
    const { base, cwd } = await rig();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => upload(base, { name: "same.txt", mediaType: "text/plain", base64: b64(`parallel ${index}`) })),
    );
    assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
    const names = await readdir(attachmentsDir(cwd));
    assert.equal(names.length, 8);
    const contents = new Set(await Promise.all(names.map((name) => readFile(join(attachmentsDir(cwd), name), "utf8"))));
    assert.equal(contents.size, 8);
  });

  it("refuses a linked .ancilla/attachments before anything is sent to Muse", async (t) => {
    const { base, cwd, connection } = await rig();
    const outside = await mkdtemp(join(tmpdir(), "ancilla-outside-"));
    await mkdir(join(cwd, ".ancilla"));
    if (!(await tryLink(outside, attachmentsDir(cwd), "dir"))) {
      return t.skip("this machine cannot create a folder link");
    }
    const sent = await upload(base, { name: "notes.txt", mediaType: "text/plain", base64: b64("secret") });
    assert.equal(sent.status, 409, JSON.stringify(sent.json));
    assert.equal(sent.json.kind, "workspaceWrite");
    assert.ok(sent.json.error.includes(attachmentsDir(cwd)), "the message names the path");
    assert.match(sent.json.error, /link/i, "and says it is a link");
    assert.match(sent.json.error, /remove|replace/i, "and says how to fix it");
    assert.deepEqual(await readdir(outside), [], "nothing was written through the link");
    assert.equal(connection.of("turn/start").length, 0, "the prompt was not sent");
    await rm(outside, { recursive: true, force: true });
  });

  it("refuses a linked .ancilla, and a link that stays inside the project", async (t) => {
    const { base, cwd, connection } = await rig();
    const outside = await mkdtemp(join(tmpdir(), "ancilla-outside-"));
    if (!(await tryLink(outside, join(cwd, ".ancilla"), "dir"))) {
      return t.skip("this machine cannot create a folder link");
    }
    const viaDot = await upload(base, { name: "a.txt", mediaType: "text/plain", base64: b64("a") });
    assert.equal(viaDot.status, 409);
    assert.equal(viaDot.json.kind, "workspaceWrite");
    assert.deepEqual(await readdir(outside), []);
    await unlinkLink(join(cwd, ".ancilla"));

    await mkdir(join(cwd, ".ancilla"));
    await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
    assert.ok(await tryLink(join(cwd, ".git", "hooks"), attachmentsDir(cwd), "dir"));
    const inside = await upload(base, { name: "pre-commit", mediaType: "text/plain", base64: b64("#!/bin/sh\n") });
    assert.equal(inside.status, 409, "a link is refused even when it points inside the project");
    assert.deepEqual(await readdir(join(cwd, ".git", "hooks")), []);
    assert.equal(connection.of("turn/start").length, 0);
    await rm(outside, { recursive: true, force: true });
  });

  it("does not follow a dangling link left where a new file would go", async (t) => {
    const { base, cwd } = await rig();
    const outside = await mkdtemp(join(tmpdir(), "ancilla-outside-"));
    await mkdir(attachmentsDir(cwd), { recursive: true });
    if (!(await tryLink(join(outside, "planted.txt"), join(attachmentsDir(cwd), "notes.txt"), "file"))) {
      return t.skip("this machine cannot create a file link");
    }
    const sent = await upload(base, { name: "notes.txt", mediaType: "text/plain", base64: b64("kept") });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(await readdir(outside), [], "nothing was created at the link's target");
    assert.equal(await readFile(join(attachmentsDir(cwd), "notes-2.txt"), "utf8"), "kept", "the next free name was used");
    await rm(outside, { recursive: true, force: true });
  });

  it("writes .ancilla/.gitignore once and leaves a changed one alone", async () => {
    const { base, cwd } = await rig();
    await upload(base, { name: "a.txt", mediaType: "text/plain", base64: b64("a") });
    const ignore = join(cwd, ".ancilla", ".gitignore");
    assert.equal(await readFile(ignore, "utf8"), "*\n");
    await writeFile(ignore, "# mine\n");
    await upload(base, { name: "b.txt", mediaType: "text/plain", base64: b64("b") });
    assert.equal(await readFile(ignore, "utf8"), "# mine\n", "an existing file is never replaced");
  });

  it("writes it again when it was deleted, and never replaces one that was edited", async () => {
    const { base, cwd } = await rig();
    const ignore = join(cwd, ".ancilla", ".gitignore");
    await upload(base, { name: "a.txt", mediaType: "text/plain", base64: b64("a") });
    await rm(ignore);
    await upload(base, { name: "b.txt", mediaType: "text/plain", base64: b64("b") });
    assert.equal(await readFile(ignore, "utf8"), "*\n", "deleting it is not an opt out: Ancilla protects the folder again");
    await writeFile(ignore, "*\n!research/\n!research/**\n");
    await upload(base, { name: "c.txt", mediaType: "text/plain", base64: b64("c") });
    assert.equal(await readFile(ignore, "utf8"), "*\n!research/\n!research/**\n", "an edited file is left exactly as it is");
  });

  it("does not create .ancilla for an image, which goes to the model and not the workspace", async () => {
    const { base, cwd } = await rig();
    await upload(base, { name: "shot.png", mediaType: "image/png", base64: b64(PNG) });
    await assert.rejects(stat(join(cwd, ".ancilla")), { code: "ENOENT" });
  });
});

describe("the name an attachment is saved under", () => {
  it("keeps only ASCII letters, digits, dot, dash and underscore, so an accented name is stored without its accent", async () => {
    const { base, cwd } = await rig();
    const sent = await upload(base, { name: "relatório final.pdf", mediaType: "application/pdf", base64: b64("%PDF-1.4") });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const stored = sent.json.attachments[0];
    assert.equal(stored.name, "relat-rio-final.pdf");
    assert.equal(await readFile(join(attachmentsDir(cwd), "relat-rio-final.pdf"), "utf8"), "%PDF-1.4");
    const res = await fetch(`${base}${stored.url}`);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="relat-rio-final.pdf"', "the header's name is the quoted ASCII one, with no filename* beside it");
  });

  it("strips trailing dots and spaces and shields Windows device names, in the file and in the @ mention alike", async () => {
    const { base, cwd, connection } = await rig();
    const names: [string, string][] = [
      ["CON.txt", "_CON.txt"],
      ["nul", "_nul"],
      ["report. .", "report"],
    ];
    for (const [sentName, savedName] of names) {
      const sent = await upload(base, { name: sentName, mediaType: "text/plain", base64: b64(sentName) }, "read this");
      assert.equal(sent.status, 200, JSON.stringify(sent.json));
      assert.equal(sent.json.attachments[0].name, savedName);
      assert.equal(await readFile(join(attachmentsDir(cwd), savedName), "utf8"), sentName, "the file is on disk under that name");
      const turns = connection.of("turn/start");
      const input = turns[turns.length - 1]?.params?.["input"] as { text?: string }[];
      assert.equal(input[0]?.text, `read this\n\n@.ancilla/attachments/${savedName}`, "and the prompt points at the same name");
    }
  });
});

describe("safeFileName", () => {
  it("leaves an ordinary name alone and keeps only the base name", () => {
    assert.equal(safeFileName("notes.txt"), "notes.txt");
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("C:\\Users\\me\\doc.pdf"), "doc.pdf");
    assert.equal(safeFileName(null), "file");
    assert.equal(safeFileName("..."), "file");
  });

  it("strips trailing dots and spaces, which Windows would drop or refuse", () => {
    assert.equal(safeFileName("foo."), "foo");
    assert.equal(safeFileName("foo..."), "foo");
    assert.equal(safeFileName("foo. ."), "foo");
    assert.equal(safeFileName("foo   "), "foo");
    assert.equal(safeFileName("archive.tar.gz."), "archive.tar.gz");
  });

  it("puts an underscore before a stem that is a Windows device name, with or without an extension, in any case", () => {
    const devices = ["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, n) => `com${n + 1}`), ...Array.from({ length: 9 }, (_, n) => `lpt${n + 1}`)];
    for (const device of devices) {
      assert.equal(safeFileName(device), `_${device}`, device);
      assert.equal(safeFileName(device.toUpperCase()), `_${device.toUpperCase()}`, device);
      assert.equal(safeFileName(`${device}.txt`), `_${device}.txt`, device);
      assert.equal(safeFileName(`${device}.tar.gz`), `_${device}.tar.gz`, device);
    }
    assert.equal(safeFileName("Con."), "_Con");
  });

  it("does not touch names that merely start with, or contain, a device name", () => {
    for (const fine of ["console.txt", "auxiliary.md", "com0.txt", "com10.txt", "lpt0", "my-con.txt", "nullable", "prn1.txt"]) {
      assert.equal(safeFileName(fine), fine);
    }
  });

  it("never gives back more than eighty characters or a name ending in a dot", () => {
    const long = safeFileName(`${"a".repeat(79)}.....txt`);
    assert.ok(long.length <= 80);
    assert.ok(!/[. -]$/.test(long), long);
    assert.ok(safeFileName(`con${"x".repeat(100)}`).length <= 80);
    assert.ok(safeFileName(`${"b".repeat(79)}...`).length <= 80);
  });
});

describe("where an attachment lands for a project in WSL", () => {
  const fakeWsl: ExecFn = async (command, args) => {
    if (command !== "wsl") return { stdout: "", exitCode: 127 };
    if (args[0] === "-l") return { stdout: "  NAME  STATE  VERSION\n* Ubuntu  Running  2\n", exitCode: 0 };
    if (args[2] === "-e" && args[3] === "test") return { stdout: "", exitCode: 0 };
    return { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 };
  };

  it("writes under the project's \\\\wsl.localhost folder, as the files and research paths do", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "started" });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/home/u/proj", title: "In WSL", turnCount: 1 }],
      nextCursor: null,
    });
    const writes: { root: string; name: string; bytes: string }[] = [];
    const { base } = await start(connection, {
      platform: "win32",
      runtime: "wsl",
      distro: "Ubuntu",
      musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl,
      hostFactory: fakeFactory(connection),
      attachmentWriter: async (root: string, name: string, bytes: Buffer) => {
        writes.push({ root, name, bytes: bytes.toString("utf8") });
        return name;
      },
    });
    assert.equal((await send(base, "/api/discover", {})).status, 200);
    const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: { sessionId: string; cwd: string }[] };
    assert.equal(sessions.sessions[0]?.cwd, "/home/u/proj", "the stored folder is the Linux path, the case that used to be written to the wrong drive");

    const sent = await send(base, "/api/turns", {
      sessionId: "s1",
      text: "read this",
      attachments: [{ name: "report.pdf", mediaType: "application/pdf", base64: b64("%PDF-1.4") }],
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(writes, [{ root: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj", name: "report.pdf", bytes: "%PDF-1.4" }]);
    const input = connection.of("turn/start")[0]?.params?.["input"] as { text?: string }[];
    assert.equal(input[0]?.text, "read this\n\n@.ancilla/attachments/report.pdf", "Muse still finds the file relative to its own workspace");
  });

  it("refuses to write into a folder that is not an absolute path on Windows, instead of the daemon's own folder", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "started" });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "projects\\relative", title: "Relative", turnCount: 1 }],
      nextCursor: null,
    });
    const writes: string[] = [];
    const { base } = await start(connection, {
      platform: "win32",
      runtime: "native",
      musePath: "C:\\muse\\muse.exe",
      exec: async () => ({ stdout: "", exitCode: 1 }),
      hostFactory: fakeFactory(connection),
      attachmentWriter: async (root: string, name: string) => {
        writes.push(root);
        return name;
      },
    });
    await send(base, "/api/discover", {});
    const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: { sessionId: string; cwd: string }[] };
    assert.equal(sessions.sessions[0]?.cwd, "projects\\relative", "the project is known by the relative folder this test is about");
    const sent = await send(base, "/api/turns", {
      sessionId: "s1",
      text: "read this",
      attachments: [{ name: "report.pdf", mediaType: "application/pdf", base64: b64("%PDF-1.4") }],
    });
    assert.equal(sent.status, 409, JSON.stringify(sent.json));
    assert.equal(sent.json.kind, "workspaceWrite");
    assert.match(sent.json.error, /projects\\relative/, "it names the folder");
    assert.deepEqual(writes, [], "nothing was written anywhere");
    assert.equal(connection.of("turn/start").length, 0, "and the prompt was not sent");
  });

  it("refuses to write when a Linux folder cannot be placed on this machine, instead of using the current drive", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "started" });
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "s1", workspaceRoot: "/home/u/proj", title: "In WSL", turnCount: 1 }],
      nextCursor: null,
    });
    // No distribution answers, so the folder has nowhere to be reached from.
    const noDistro: ExecFn = async () => ({ stdout: "", exitCode: 1 });
    const writes: string[] = [];
    const { base } = await start(connection, {
      platform: "win32",
      runtime: "wsl",
      musePath: "/home/u/.local/bin/muse",
      exec: noDistro,
      hostFactory: fakeFactory(connection),
      attachmentWriter: async (root: string, name: string) => {
        writes.push(root);
        return name;
      },
    });
    await send(base, "/api/discover", {});
    const sessions = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: { sessionId: string; cwd: string }[] };
    assert.equal(sessions.sessions[0]?.cwd, "/home/u/proj", "the project is known by its Linux path, which is what the check is about");
    const sent = await send(base, "/api/turns", {
      sessionId: "s1",
      text: "read this",
      attachments: [{ name: "report.pdf", mediaType: "application/pdf", base64: b64("%PDF-1.4") }],
    });
    assert.equal(sent.status, 409, JSON.stringify(sent.json));
    assert.equal(sent.json.kind, "workspaceWrite");
    assert.match(sent.json.error, /\/home\/u\/proj/, "it names the folder");
    assert.match(sent.json.error, /WSL/, "and what to do");
    assert.deepEqual(writes, [], "nothing was written anywhere");
    assert.equal(connection.of("turn/start").length, 0, "and the prompt was not sent");
  });
});
