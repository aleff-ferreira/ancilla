// assistant-rollback.mjs on a real assistant.db: it writes a copy first, steps the schema back one version at a time,
// keeps what the older version holds, and refuses what it cannot do. It needs the server built (npm test builds it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const script = fileURLToPath(new URL("../assistant-rollback.mjs", import.meta.url));
const dist = new URL("../../packages/server/dist/src/assistant/store.js", import.meta.url);
const built = existsSync(fileURLToPath(dist));
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function makeData() {
  const { MemoryStore } = await import(dist.href);
  const dir = mkdtempSync(join(tmpdir(), "ancilla-rollback-"));
  dirs.push(dir);
  const store = MemoryStore.open(join(dir, "assistant.db"));
  store.saveProfile({ enabled: true, name: "Jarvis" });
  store.remember({ text: "release notes go in docs/NOTES.md" });
  store.close();
  return dir;
}

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const tables = (dir) => {
  const db = new DatabaseSync(join(dir, "assistant.db"));
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  db.close();
  return { names, version };
};

describe("rolling the assistant's database back", { skip: built ? false : "the server is not built" }, () => {
  test("says which version the file is at and what the steps are", async () => {
    const dir = await makeData();
    const out = run(dir, "--status");
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /schema version 2/);
    assert.match(out.stdout, /1: memory and profile/);
    assert.match(out.stdout, /2: tasks and schedules/);
  });

  test("writes a copy of the memories first, then drops only what the newer version added", async () => {
    const dir = await makeData();
    const out = run(dir, "1");
    assert.equal(out.status, 0, out.stderr);
    const copy = readdirSync(dir).find((f) => f.startsWith("assistant-export-before-rollback-"));
    assert.ok(copy, "an export was written beside the file");
    const exported = JSON.parse(readFileSync(join(dir, copy), "utf8"));
    assert.equal(exported.format, "ancilla.assistant.export");
    assert.equal(exported.items[0].text, "release notes go in docs/NOTES.md");
    assert.equal(exported.profile.name, "Jarvis");
    const now = tables(dir);
    assert.equal(now.version, 1);
    assert.ok(now.names.includes("memory_items") && !now.names.includes("tasks") && !now.names.includes("schedules"));
  });

  test("goes all the way back to nothing when asked, and then there is nothing of the assistant left", async () => {
    const dir = await makeData();
    assert.equal(run(dir, "0").status, 0);
    const now = tables(dir);
    assert.equal(now.version, 0);
    assert.deepEqual(now.names.filter((n) => /^(memory_|assistant_|tasks|task_|schedules|capture_log)/.test(n)), []);
  });

  test("refuses a version it is not at or above, a missing file and a missing argument", async () => {
    const dir = await makeData();
    assert.equal(run(dir, "2").status, 2);
    assert.equal(run(dir, "7").status, 2);
    assert.equal(run(dir, "x").status, 2);
    assert.equal(run(dir).status, 2);
    const empty = mkdtempSync(join(tmpdir(), "ancilla-rollback-empty-"));
    dirs.push(empty);
    assert.equal(run(empty, "0").status, 1);
    assert.equal(tables(dir).version, 2, "nothing was changed by the refusals");
  });
});
