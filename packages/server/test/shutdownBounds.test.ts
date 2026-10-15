/**
 * The numbers behind the command line's shutdown: the deadline is longer than the worst case of `close()` with the
 * waits the command line gives it, the worst case follows the waits that are in force, and the signals that end the
 * server are the ones each system delivers (SIGHUP on every system, since a terminal that goes away sends it, and
 * SIGBREAK on Windows) and every one of them is registered by the command line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_HOST_WAITS, DEFAULT_HOST_WAITS } from "../src/hostBounds.js";
import { INSTALLER_KILL_GRACE_MS } from "../src/linuxMuseInstaller.js";
import { CLOSE_TIMEOUT_MS } from "../src/research/jobManager.js";
import { SHELL_KILL_SETTLE_MS } from "../src/runCapture.js";
import { LINUX_INSTALLER_CLEANUP_MS, LINUX_INSTALLER_STOP_MS,SHUTDOWN_DEADLINE_MS, shutdownSignals, worstCaseCloseMs } from "../src/shutdown.js";

/** The code of a source file: whole-line `//` comments and block comments left out, so text in a comment never counts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The command line as written (cli.ts) and as it runs (cli.js, next to this test's own compiled folder), comments left out. */
async function cliSources(): Promise<[string, string][]> {
  const written = await readFile(join(__dirname, "..", "..", "src", "cli.ts"), "utf8");
  const compiled = await readFile(join(__dirname, "..", "src", "cli.js"), "utf8");
  return [
    ["cli.ts", withoutComments(written)],
    ["the compiled cli.js", withoutComments(compiled)],
  ];
}

describe("the shutdown deadline", () => {
  it("is longer than the worst case of a close with the command line's waits, by at least a second", () => {
    const worst = worstCaseCloseMs(CLI_HOST_WAITS);
    assert.ok(SHUTDOWN_DEADLINE_MS - worst >= 1000, `a close can take ${worst} ms and the deadline is ${SHUTDOWN_DEADLINE_MS} ms`);
  });

  it("is shorter than the worst case with the waits an embedder gets, which is why the command line passes its own", () => {
    assert.ok(worstCaseCloseMs() > SHUTDOWN_DEADLINE_MS);
    assert.deepEqual({ ...CLI_HOST_WAITS, closeMs: DEFAULT_HOST_WAITS.closeMs }, DEFAULT_HOST_WAITS, "the command line changes only the host close wait");
    assert.ok(CLI_HOST_WAITS.closeMs < DEFAULT_HOST_WAITS.closeMs);
  });

  it("reaches the server from the command line, in the source and in the compiled program that runs", async () => {
    // A source check, with the comments left out so that a commented-out line does not count: the process that would
    // show it is the real command line, which takes the deadline itself (11.5 s of host close) to end.
    for (const [name, source] of await cliSources()) {
      assert.match(source, /hostWaits:\s*CLI_HOST_WAITS\s*,/, `${name} does not hand CLI_HOST_WAITS to the server`);
    }
  });

  it("counts the installer's stop from the grace the installer itself uses, and what it cleans up after the kill", () => {
    // One constant in linuxMuseInstaller.ts: the number in the sum cannot drift from the one the stop waits for.
    assert.ok(LINUX_INSTALLER_STOP_MS >= INSTALLER_KILL_GRACE_MS + LINUX_INSTALLER_CLEANUP_MS);
    assert.ok(LINUX_INSTALLER_STOP_MS > INSTALLER_KILL_GRACE_MS, "the cleanup after the kill is not counted");
    assert.equal(worstCaseCloseMs(CLI_HOST_WAITS), INSTALLER_KILL_GRACE_MS + LINUX_INSTALLER_CLEANUP_MS + CLOSE_TIMEOUT_MS + CLI_HOST_WAITS.closeMs);
  });
});

describe("worstCaseCloseMs", () => {
  it("adds the installer and the research runs to the longest of the waits that run at once", () => {
    assert.equal(worstCaseCloseMs({ startsMs: 10, closeMs: 1000, shellsMs: 10 }), LINUX_INSTALLER_STOP_MS + CLOSE_TIMEOUT_MS + 1000);
    assert.equal(worstCaseCloseMs({ startsMs: 2000, closeMs: 1000, shellsMs: 10 }), LINUX_INSTALLER_STOP_MS + CLOSE_TIMEOUT_MS + 2000);
    assert.equal(
      worstCaseCloseMs({ startsMs: 10, closeMs: 100, shellsMs: 5000 }),
      LINUX_INSTALLER_STOP_MS + CLOSE_TIMEOUT_MS + 5000 + SHELL_KILL_SETTLE_MS,
      "the commands are stopped, then given a moment more after the kill",
    );
  });

  it("takes what is not given from the defaults", () => {
    assert.equal(worstCaseCloseMs(), worstCaseCloseMs(DEFAULT_HOST_WAITS));
    assert.equal(worstCaseCloseMs({ closeMs: 100 }), worstCaseCloseMs({ ...DEFAULT_HOST_WAITS, closeMs: 100 }));
  });
});

describe("the signals that end the server", () => {
  it("are SIGINT, SIGTERM and SIGHUP everywhere, and SIGBREAK too on Windows", () => {
    assert.deepEqual(shutdownSignals("linux"), ["SIGINT", "SIGTERM", "SIGHUP"]);
    assert.deepEqual(shutdownSignals("darwin"), ["SIGINT", "SIGTERM", "SIGHUP"]);
    assert.deepEqual(shutdownSignals("win32"), ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]);
  });

  it("are every one the command line registers: it loops over shutdownSignals() and names none of its own", async () => {
    for (const [name, source] of await cliSources()) {
      assert.match(source, /for\s*\(\s*const\s+signal\s+of\s+shutdownSignals\(\)\s*\)/, `${name} does not register the signals of shutdownSignals()`);
      assert.match(source, /process\.on\(\s*signal\s*,/, `${name} does not register a handler for each of them`);
      assert.doesNotMatch(source, /process\.(?:on|once)\(\s*["']SIG/, `${name} registers a signal by name, outside shutdownSignals()`);
    }
  });

  it("are listened to on stderr's errors too: a terminal that is gone must not turn the close into an uncaught error", async () => {
    for (const [name, source] of await cliSources()) {
      assert.match(source, /process\.stderr\.on\(\s*["']error["']/, `${name} does not guard stderr against a write error`);
      assert.match(source, /process\.stdout\.on\(\s*["']error["']/, `${name} does not guard stdout against a write error`);
    }
  });
});
