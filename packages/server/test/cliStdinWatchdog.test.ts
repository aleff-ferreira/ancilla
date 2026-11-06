/**
 * The real `ancilla-server` process and the end of its stdin. With the hidden flag the desktop shell passes it closes
 * as on SIGTERM (exit 0, the port freed, the lock released), also when the end comes during the boot (then no ready
 * line is written) and when the parent that held the pipe dies without closing it (the Task Manager case). Without
 * the flag stdin is never read: a server under systemd, Docker, nohup or cron has a stdin that ends at once. Every wait
 * is for an event; the one-second waits are for nothing to happen. Runs on every system.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunning, killQuietly } from "./fakeMuse.js";
import { CLI, HUNG, answers, exitedWithin, serverWithPendingCommand, startCli, until } from "./cliRig.js";
import { sleep } from "./research-rigs.js";
import { OWNER_LOCK_FILE } from "../src/ownerLock.js";
import { STDIN_EOF_FLAG } from "../src/shutdown.js";

const FLAG = STDIN_EOF_FLAG;

async function dataDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ancilla-stdin-")), "data");
}

describe("ancilla-server with the stdin watchdog flag", () => {
  it("closes when stdin ends: exit 0, the port no longer answers, the lock file is gone", { timeout: 60_000 }, async () => {
    const dir = await dataDir();
    const run = startCli(["--port", "0", "--data-dir", dir, FLAG], {}, { stdin: "pipe" });
    const base = await run.ready;
    assert.equal(existsSync(join(dir, OWNER_LOCK_FILE)), true, "the record is there while the server runs");
    run.child.stdin!.end();
    const ended = await exitedWithin(run);
    assert.notEqual(ended, null, `the server was still running ${HUNG} ms after its stdin ended; stderr:\n${run.stderr()}`);
    assert.deepEqual(ended, { code: 0, signal: null }, run.stderr());
    assert.match(run.stderr(), /stdin EOF received: closing the server/);
    assert.equal(await answers(base), false, "the port still answers after the close");
    assert.equal(existsSync(join(dir, OWNER_LOCK_FILE)), false, "the record was not released");
  });

  it("keeps running while the pipe stays open", { timeout: 60_000 }, async () => {
    const run = startCli(["--port", "0", "--data-dir", await dataDir(), FLAG], {}, { stdin: "pipe" });
    const base = await run.ready;
    try {
      await sleep(1000);
      assert.equal(await answers(base), true, `the server went away with its stdin still open; stderr:\n${run.stderr()}`);
    } finally {
      run.child.stdin!.end();
      await exitedWithin(run);
    }
  });

  it("closes before it is ready when stdin ends during the boot, and then writes no ready line at all", { timeout: 60_000 }, async () => {
    const run = startCli(["--port", "0", "--data-dir", await dataDir(), FLAG], {}, { stdin: "pipe" });
    run.child.stdin!.end();
    const ended = await exitedWithin(run);
    assert.notEqual(ended, null, `the server was still running ${HUNG} ms after its stdin ended during the boot; stderr:\n${run.stderr()}`);
    assert.deepEqual(ended, { code: 0, signal: null }, run.stderr());
    assert.equal(run.stdout(), "", "a ready line was written for a server that was already closing");
    assert.match(run.stderr(), /stdin EOF received/);
  });

  it("closes when the process that held its stdin dies without closing it, as when the desktop app is killed", { timeout: 60_000 }, async () => {
    const dir = await dataDir();
    const root = join(dir, "..");
    const stderrFile = join(root, "server.stderr");
    const parentScript = join(root, "parent.js");
    // The parent starts the server with a pipe for its stdin, relays the ready line and its child's pid, then exits
    // without closing the pipe: the system closes it, and that end is what the server has to notice. The server is
    // spawned detached: on Windows libuv puts a child that is not detached into a job object that kills it when
    // its parent exits (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE), so the server died with the parent before it could see the
    // pipe end, and the test measured libuv, not the watchdog. The desktop app is a Rust process, which makes no job
    // object, so a detached child is the shape of the real case. `windowsHide` keeps a console window from opening.
    await writeFile(
      parentScript,
      [
        'const { spawn } = require("node:child_process");',
        'const { openSync } = require("node:fs");',
        "const [cli, dir, flag, stderrFile] = process.argv.slice(2);",
        'const child = spawn(process.execPath, [cli, "--port", "0", "--data-dir", dir, flag], { stdio: ["pipe", "pipe", openSync(stderrFile, "w")], detached: true, windowsHide: true });',
        'child.stdout.on("data", (chunk) => {',
        "  process.stdout.write(`${child.pid} ${chunk}`, () => process.exit(0));",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    const parent = spawn(process.execPath, [parentScript, CLI, dir, FLAG, stderrFile], { stdio: ["ignore", "pipe", "pipe"] });
    let relayed = "";
    let parentGone = false;
    parent.stdout.on("data", (chunk: Buffer) => { relayed += chunk.toString(); });
    parent.once("close", () => { parentGone = true; });
    // The server is the parent's child, not this test's: when an assertion fails it is still running, and so is the
    // parent if it never relayed. Both are ended here, or the runner waits on them for good.
    let finished = false;
    const orphan = () => {
      const first = /^(\d+) /.exec(relayed);
      return first ? Number(first[1]) : null;
    };
    try {
      await until(() => parentGone, "the parent to relay the ready line and exit");
      const match = /^(\d+) ancilla-server listening on (http:\/\/\S+)/.exec(relayed);
      assert.ok(match, `the parent did not relay the ready line: ${JSON.stringify(relayed)}`);
      const pid = Number(match[1]);
      const base = match[2]!;
      await until(() => !isRunning(pid), "the orphaned server to exit");
      const stderr = await readFile(stderrFile, "utf8");
      assert.match(stderr, /stdin EOF received: closing the server/, stderr);
      assert.doesNotMatch(stderr, /did not finish|closing failed|second signal/, stderr);
      assert.equal(await answers(base), false, "the port still answers after the orphaned server closed");
      assert.equal(existsSync(join(dir, OWNER_LOCK_FILE)), false, "the orphaned server did not release its record");
      finished = true;
    } finally {
      if (!finished) {
        const pid = orphan();
        if (pid !== null) {
          killQuietly(pid);
        }
        parent.kill("SIGKILL");
      }
    }
  });

  it("stops a `!` command still pending, as a signal does", { skip: process.platform === "win32" ? "needs a POSIX shell" : false, timeout: 60_000 }, async () => {
    const pending = await serverWithPendingCommand({ args: [FLAG], stdin: "pipe" });
    try {
      assert.equal(isRunning(pending.pid), true, "the command is running before stdin ends");
      pending.run.child.stdin!.end();
      const ended = await exitedWithin(pending.run);
      assert.notEqual(ended, null, `the server was still running ${HUNG} ms after its stdin ended; stderr:\n${pending.run.stderr()}`);
      assert.deepEqual(ended, { code: 0, signal: null }, pending.run.stderr());
      await until(() => !isRunning(pending.pid), "the command to be stopped");
    } finally {
      await pending.cleanup();
    }
  });
});

describe("ancilla-server without the flag", () => {
  it("never reads stdin: a stdin that ends at once leaves it running", { timeout: 60_000 }, async () => {
    const run = startCli(["--port", "0", "--data-dir", await dataDir()], {}, { stdin: "pipe" });
    run.child.stdin!.end();
    const base = await run.ready;
    try {
      await sleep(1000);
      assert.equal(await answers(base), true, `the server closed on a stdin it was not asked to watch; stderr:\n${run.stderr()}`);
    } finally {
      run.child.kill("SIGKILL");
      await exitedWithin(run);
    }
  });

  it("runs with no stdin at all, and still closes on a signal", { timeout: 60_000 }, async () => {
    const run = startCli(["--port", "0", "--data-dir", await dataDir()]);
    const base = await run.ready;
    await sleep(1000);
    assert.equal(await answers(base), true, run.stderr());
    if (process.platform === "win32") {
      // Windows delivers no signal a process can answer; the kill is the test's cleanup only.
      run.child.kill();
      await exitedWithin(run);
      return;
    }
    run.child.kill("SIGTERM");
    const ended = await exitedWithin(run);
    assert.deepEqual(ended, { code: 0, signal: null }, run.stderr());
  });

  it("does not list the flag in its usage: it is the desktop shell's, never a default", () => {
    const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--data-dir/);
    assert.doesNotMatch(help.stdout, new RegExp(FLAG));
  });
});
