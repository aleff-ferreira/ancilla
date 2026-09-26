import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("recovery bootstrap reserves the first stdout line for server readiness", (t) => {
  const resources = mkdtempSync(path.join(tmpdir(), "helicon-recovery-bootstrap-"));
  assert.equal(path.dirname(path.resolve(resources)), path.resolve(tmpdir()));
  assert.ok(path.basename(resources).startsWith("helicon-recovery-bootstrap-"));
  t.after(() => rmSync(resources, { recursive: true, force: true }));

  const frontend = path.join(resources, "frontend");
  const staged = path.join(resources, "muse-recovery");
  const bootstrap = path.join(resources, "server.cjs");
  mkdirSync(frontend, { recursive: true });
  mkdirSync(path.join(staged, "frontend", "assets"), { recursive: true });
  writeFileSync(path.join(frontend, "index.html"), "old frontend");
  writeFileSync(path.join(staged, "frontend", "index.html"), "matching recovery frontend");
  writeFileSync(path.join(staged, "frontend", "assets", "app.js"), "matching recovery asset");
  copyFileSync(new URL("./recovery-bootstrap.cjs", import.meta.url), bootstrap);

  const readiness = "helicon-server listening on http://127.0.0.1:52314";
  writeFileSync(path.join(staged, "server.cjs"), `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const frontend = path.join(__dirname, "..", "frontend");
    // The server must start only after its matching frontend is activated.
    assert.equal(fs.readFileSync(path.join(frontend, "index.html"), "utf8"), "matching recovery frontend");
    assert.equal(fs.readFileSync(path.join(frontend, "assets", "app.js"), "utf8"), "matching recovery asset");
    process.stdout.write(${JSON.stringify(`${readiness}\n`)});
  `);

  const result = spawnSync(process.execPath, [bootstrap], {
    cwd: resources,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);

  // Tauri's wait_for_url reads exactly one stdout line before closing its pipe.
  assert.equal(result.stdout.split(/\r?\n/, 1)[0], readiness);
  assert.equal(result.stdout.trim(), readiness, "bootstrap diagnostics must not use stdout");
  assert.match(result.stderr, /Helicon Muse recovery repair activated \(local session titles; read-only recovery\)\./);
  assert.equal(readFileSync(path.join(frontend, "index.html"), "utf8"), "matching recovery frontend");
  assert.equal(readFileSync(path.join(frontend, "assets", "app.js"), "utf8"), "matching recovery asset");
});
