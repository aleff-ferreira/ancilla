/** The workspace-write policy on its own: owned folders that are never links, and file names that are never reused. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileError } from "../src/files.js";
import { createUnique, entryState, ensureIgnoreFile, ownedDir, writeAttachment } from "../src/workspaceWrite.js";
import { tryLink } from "./fsLinks.js";

async function temp(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ancilla-ww-${label}-`));
}

function isWorkspaceWrite(status: number) {
  return (error: unknown) => error instanceof FileError && error.status === status && error.kind === "workspaceWrite";
}

describe("entryState", () => {
  it("tells a missing entry, a folder and a file apart", async () => {
    const root = await temp("state");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "file"), "x");
    assert.equal(await entryState(join(root, "nothing")), "missing");
    assert.equal(await entryState(join(root, "dir")), "dir");
    assert.equal(await entryState(join(root, "file")), "file");
    assert.equal(await entryState(join(root, "file", "below")), "missing", "a path under a file is simply not there");
  });

  it("calls a folder link and a dangling file link links, without following them", async (t) => {
    const root = await temp("links");
    await mkdir(join(root, "real"));
    if (!(await tryLink(join(root, "real"), join(root, "folder-link"), "dir"))) {
      return t.skip("this machine cannot create a folder link");
    }
    assert.equal(await entryState(join(root, "folder-link")), "link");
    if (await tryLink(join(root, "missing-target"), join(root, "dangling"), "file")) {
      assert.equal(await entryState(join(root, "dangling")), "link");
    }
  });
});

describe("ownedDir", () => {
  it("creates the folders it owns, one level at a time, and answers the last one", async () => {
    const root = await temp("owned");
    const made = await ownedDir(root, [".ancilla", "research", "run-1"]);
    assert.equal(made, join(root, ".ancilla", "research", "run-1"));
    assert.equal(await entryState(made), "dir");
    assert.equal(await ownedDir(root, [".ancilla", "research", "run-1"]), made, "an existing folder is simply answered");
  });

  it("answers 404 when the project folder itself is gone", async () => {
    const root = await temp("gone");
    await rm(root, { recursive: true });
    await assert.rejects(ownedDir(root, [".ancilla", "attachments"]), (error: unknown) => error instanceof FileError && error.status === 404);
  });

  it("refuses an owned folder that is a link, naming the path and how to fix it", async (t) => {
    const root = await temp("refuse");
    const outside = await temp("outside");
    await mkdir(join(root, ".ancilla"));
    if (!(await tryLink(outside, join(root, ".ancilla", "attachments"), "dir"))) {
      return t.skip("this machine cannot create a folder link");
    }
    await assert.rejects(ownedDir(root, [".ancilla", "attachments"]), (error: unknown) => {
      assert.ok(isWorkspaceWrite(409)(error));
      const message = (error as FileError).message;
      assert.ok(message.includes(join(root, ".ancilla", "attachments")), message);
      assert.match(message, /link/i);
      assert.match(message, /remove|replace/i);
      return true;
    });
    assert.deepEqual(await readdir(outside), []);
  });

  it("refuses a link at the first level too, and a plain file where a folder belongs", async (t) => {
    const root = await temp("levels");
    const outside = await temp("outside");
    if (await tryLink(outside, join(root, ".ancilla"), "dir")) {
      await assert.rejects(ownedDir(root, [".ancilla", "attachments"]), isWorkspaceWrite(409));
      assert.deepEqual(await readdir(outside), [], "nothing was made behind the link");
    } else {
      t.diagnostic("folder links are unavailable here; the link cases were skipped");
    }
    const other = await temp("file");
    await writeFile(join(other, ".ancilla"), "not a folder");
    await assert.rejects(ownedDir(other, [".ancilla", "attachments"]), isWorkspaceWrite(409));
  });
});

describe("createUnique", () => {
  it("keeps the name when it is free and numbers the next ones", async () => {
    const dir = await temp("names");
    assert.equal(await createUnique(dir, "notes.txt", Buffer.from("1")), "notes.txt");
    assert.equal(await createUnique(dir, "notes.txt", Buffer.from("2")), "notes-2.txt");
    assert.equal(await createUnique(dir, "notes.txt", Buffer.from("3")), "notes-3.txt");
    assert.equal(await createUnique(dir, "README", Buffer.from("4")), "README");
    assert.equal(await createUnique(dir, "README", Buffer.from("5")), "README-2");
  });

  it("passes the sequential names after about twenty and then uses a random suffix, never reusing one", async () => {
    const dir = await temp("cap");
    const names: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      names.push(await createUnique(dir, "log.txt", Buffer.from(`entry ${index}`)));
    }
    assert.equal(new Set(names).size, 60);
    assert.deepEqual(names.slice(0, 3), ["log.txt", "log-2.txt", "log-3.txt"]);
    // A random suffix that happens to be all digits still reads as a hashed name, never as a sequential one.
    const hashed = names.filter((name) => /^log-[0-9a-f]{8}\.txt$/.test(name));
    const sequential = names.filter((name) => !hashed.includes(name) && /^log(-\d+)?\.txt$/.test(name));
    assert.equal(sequential.length + hashed.length, 60, `every name is one of the two shapes: ${names.join(", ")}`);
    assert.ok(sequential.length <= 25 && hashed.length >= 35, "the sequential run is capped");
    for (const [index, name] of names.entries()) {
      assert.equal(await readFile(join(dir, name), "utf8"), `entry ${index}`);
    }
  });

  it("gives eight concurrent writers of one name eight different files", async () => {
    const dir = await temp("race");
    const names = await Promise.all(Array.from({ length: 8 }, (_, index) => createUnique(dir, "same.txt", Buffer.from(`writer ${index}`))));
    assert.equal(new Set(names).size, 8);
    const contents = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));
    assert.equal(new Set(contents).size, 8);
  });

  it("skips a name that is held by a dangling link rather than writing through it", async (t) => {
    const dir = await temp("dangling");
    const outside = await temp("outside");
    if (!(await tryLink(join(outside, "target.txt"), join(dir, "a.txt"), "file"))) {
      return t.skip("this machine cannot create a file link");
    }
    assert.equal(await createUnique(dir, "a.txt", Buffer.from("data")), "a-2.txt");
    assert.deepEqual(await readdir(outside), []);
  });

  it("removes the file it created when the write fails, and says so", async () => {
    const dir = await temp("fail");
    await assert.rejects(
      createUnique(dir, "big.bin", Buffer.from("data"), {
        write: async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
      }),
      /disk full/,
    );
    assert.deepEqual(await readdir(dir), [], "no half-written file stays behind");
    assert.equal(await createUnique(dir, "big.bin", Buffer.from("data")), "big.bin", "and the name is free again");
  });
});

describe("ensureIgnoreFile and writeAttachment", () => {
  it("writes a lone * once and never replaces what is there", async () => {
    const dir = await temp("ignore");
    await ensureIgnoreFile(dir);
    assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n");
    await writeFile(join(dir, ".gitignore"), "mine\n");
    await ensureIgnoreFile(dir);
    assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "mine\n");
  });

  it("writes it again when it was deleted, which is no opt out, and never replaces an edited one", async () => {
    const dir = await temp("ignore-deleted");
    await ensureIgnoreFile(dir);
    await rm(join(dir, ".gitignore"));
    await ensureIgnoreFile(dir);
    assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n", "a missing file is the one case Ancilla writes");
    await writeFile(join(dir, ".gitignore"), "*\n!research/\n!research/**\n");
    await ensureIgnoreFile(dir);
    assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n!research/\n!research/**\n", "an edited file is left as it is");
  });

  it("puts an attachment under .ancilla/attachments with the ignore file beside it", async () => {
    const root = await temp("attach");
    assert.equal(await writeAttachment(root, "a.txt", Buffer.from("A")), "a.txt");
    assert.equal(await writeAttachment(root, "a.txt", Buffer.from("B")), "a-2.txt");
    assert.equal(await readFile(join(root, ".ancilla", "attachments", "a-2.txt"), "utf8"), "B");
    assert.equal(await readFile(join(root, ".ancilla", ".gitignore"), "utf8"), "*\n");
    assert.equal((await stat(join(root, ".ancilla", "attachments"))).isDirectory(), true);
  });
});
