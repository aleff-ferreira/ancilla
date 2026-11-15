/**
 * The runner behind the composer's `!` commands. It answers when the command is over, not when every pipe it
 * touched is closed (a command that leaves a background process behind holds the pipes for as long as that process
 * lives), and a command that outruns its timeout is stopped with what it started. Nothing here adds a deadline of its
 * own: a command that runs longer than the timeout is still the user's own.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "../src/runCapture.js";
import { isRunning, killQuietly } from "./fakeMuse.js";
import { sleep } from "./research-rigs.js";

const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell and process groups" : false;

/** `node -e` runs the same everywhere, so these cases are not left to POSIX. */
const node = (script: string): [string, string[]] => [process.execPath, ["-e", script]];

async function pidFrom(file: string, deadlineMs = 5000): Promise<number> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text) return Number(text);
    } catch {
      /* not written yet */
    }
    if (Date.now() > until) throw new Error(`no pid in ${file}`);
    await sleep(20);
  }
}

describe("runCapture, regression guards (these hold before the change too)", () => {
  it("returns what a command printed and its exit code", async () => {
    const [command, args] = node("process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)");
    const result = await runCapture(command, args, undefined, 30_000);
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /out/);
    assert.match(result.output, /err/);
    assert.equal(result.truncated, false);
  });

  it("keeps the tail of a long output and says it was cut", async () => {
    const [command, args] = node("process.stdout.write('x'.repeat(200000) + 'END')");
    const result = await runCapture(command, args, undefined, 30_000);
    assert.equal(result.truncated, true);
    assert.equal(result.output.length <= 64 * 1024, true);
    assert.ok(result.output.endsWith("END"));
  });

  it("reports a command that cannot be started instead of rejecting", async () => {
    const result = await runCapture(join(tmpdir(), "ancilla-no-such-command"), [], undefined, 30_000);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /ENOENT|no such file|not found/i);
  });
});

describe("runCapture and a command that leaves a process behind", () => {
  it("answers when the command exits, not when the process it left holding the pipes does", { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
    const started = Date.now();
    // The shell exits at once; `sleep` goes on holding its stdout for ten seconds.
    const result = await runCapture("sh", ["-c", "sleep 10 & echo started"], undefined, 60_000, { drainGraceMs: 100 });
    const elapsed = Date.now() - started;
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /started/);
    assert.equal(result.truncated, false, "this is not a timeout");
    assert.ok(elapsed < 5000, `the answer waited ${elapsed} ms for a background process`);
  });

  it("does not wait for a background process on Windows either", { timeout: 30_000 }, async () => {
    // A grandchild that keeps the inherited pipes open after its parent is gone; node is the one program every system has.
    const grandchild = "setTimeout(() => {}, 10000)";
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] }).unref(); process.stdout.write('started\\n')`;
    const [command, args] = node(parent);
    const started = Date.now();
    const result = await runCapture(command, args, undefined, 60_000, { drainGraceMs: 100 });
    const elapsed = Date.now() - started;
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /started/);
    assert.ok(elapsed < 6000, `the answer waited ${elapsed} ms for a background process`);
  });
});

describe("runCapture past its timeout", () => {
  it("stops the command and what it started in its own process group", { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-capture-"));
    const pidFile = join(dir, "background.pid");
    let background = 0;
    try {
      const started = Date.now();
      const result = await runCapture("sh", ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`], undefined, 400, { drainGraceMs: 100, killGraceMs: 2000 });
      const elapsed = Date.now() - started;
      background = await pidFrom(pidFile);
      assert.equal(result.truncated, true);
      assert.match(result.output, /\[stopped/);
      assert.ok(elapsed < 8000, `the stop took ${elapsed} ms`);
      const until = Date.now() + 5000;
      while (isRunning(background) && Date.now() < until) await sleep(25);
      assert.equal(isRunning(background), false, "the background process outlived the command that started it");
    } finally {
      if (background) killQuietly(background);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ends a command that ignores the polite stop once the grace has run out", { skip: POSIX_ONLY, timeout: 30_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-capture-"));
    const shellPidFile = join(dir, "shell.pid");
    const backgroundPidFile = join(dir, "background.pid");
    let shell = 0;
    let background = 0;
    try {
      const started = Date.now();
      // The shell and what it started both ignore SIGTERM (an ignored signal stays ignored in a child), so only the kill ends them.
      const script = `trap "" TERM; sleep 30 & echo $! > "${backgroundPidFile}"; echo $$ > "${shellPidFile}"; wait`;
      const result = await runCapture("sh", ["-c", script], undefined, 1000, { drainGraceMs: 100, killGraceMs: 300 });
      const elapsed = Date.now() - started;
      shell = await pidFrom(shellPidFile);
      background = await pidFrom(backgroundPidFile);
      assert.equal(result.truncated, true);
      assert.ok(elapsed < 8000, `a command that ignored the stop held the request for ${elapsed} ms`);
      const until = Date.now() + 5000;
      while ((isRunning(shell) || isRunning(background)) && Date.now() < until) await sleep(25);
      assert.equal(isRunning(shell), false, "the command that ignored the polite stop was left running after the answer");
      assert.equal(isRunning(background), false, "what that command started was left running after the answer");
    } finally {
      if (shell) killQuietly(shell);
      if (background) killQuietly(background);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops a plain command that outruns the timeout on every system", { timeout: 30_000 }, async () => {
    const [command, args] = node("setInterval(() => {}, 1000)");
    const result = await runCapture(command, args, undefined, 300, { drainGraceMs: 100, killGraceMs: 500 });
    assert.equal(result.truncated, true);
    assert.match(result.output, /\[stopped/);
  });
});
