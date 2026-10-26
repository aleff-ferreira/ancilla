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
import { BOOT_BUSY_TIMEOUT_MS } from "@ancilla/daemon";
import { EXIT_DATA_DIR_OWNED } from "../src/exitCodes.js";
import { CLI_HOST_WAITS, DEFAULT_HOST_WAITS } from "../src/hostBounds.js";
import { INSTALLER_KILL_GRACE_MS } from "../src/linuxMuseInstaller.js";
import { BOOT_BUDGET_MS, OWNER_LOCK_WAIT_MS } from "../src/ownerLock.js";
import { CLOSE_TIMEOUT_MS } from "../src/research/jobManager.js";
import { SHELL_KILL_SETTLE_MS } from "../src/runCapture.js";
import { LINUX_INSTALLER_CLEANUP_MS, LINUX_INSTALLER_STOP_MS, SHUTDOWN_DEADLINE_MS, STDIN_EOF_FLAG, shutdownSignals, worstCaseCloseMs } from "../src/shutdown.js";

/** The desktop shell's wait for the ready line: `from_secs(45)` in main.rs, which sidecarContract.test.ts reads there. */
const SHELL_HANDSHAKE_MS = 45_000;
/** The boot itself (about 1.7 s to the ready line over a slow mount) and a margin. */
const BOOT_AND_MARGIN_MS = 2_500;

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

  it("is armed before the server listens, so a signal or the end of stdin during the boot still ends in a close", async () => {
    for (const [name, source] of await cliSources()) {
      const armed = source.indexOf("createShutdown(");
      const listening = source.indexOf("server.listen(");
      assert.ok(armed !== -1 && listening !== -1, `${name} does not create the shutdown and listen`);
      assert.ok(armed < listening, `${name} creates the shutdown only after the server listens`);
    }
  });
});

describe("the boot budget", () => {
  it("ends, with the boot itself and a margin, before the desktop shell gives up on the ready line", () => {
    // The shell waited 25 s before 0.21.0, with no retry behind that wait. Without a budget the worst case was the
    // boot, the lock wait, the store's boot busy timeout and the two sweeps' retries over a locked database (about
    // 8.5 s): 25.2 s, past that deadline. The budget cuts the sweeps, and the shell now waits 45 s.
    assert.ok(BOOT_BUDGET_MS + BOOT_AND_MARGIN_MS <= SHELL_HANDSHAKE_MS, `a boot can take ${BOOT_BUDGET_MS + BOOT_AND_MARGIN_MS} ms and the shell waits ${SHELL_HANDSHAKE_MS} ms`);
  });

  it("holds the lock wait and the store's boot wait, which run one after the other", () => {
    assert.ok(OWNER_LOCK_WAIT_MS + BOOT_BUSY_TIMEOUT_MS <= BOOT_BUDGET_MS, `${OWNER_LOCK_WAIT_MS} + ${BOOT_BUSY_TIMEOUT_MS} ms of waits in a budget of ${BOOT_BUDGET_MS} ms`);
  });
});

describe("the exit code of a refused data folder", () => {
  it("is neither of the command line's own codes, and never reads as a death by signal", () => {
    const code: number = EXIT_DATA_DIR_OWNED;
    assert.ok(![0, 1].includes(code), "0 and 1 are the clean close and any other failure");
    assert.ok(Number.isInteger(code) && code > 1 && code < 128, `${code} would read as a death by signal, or is not an exit code`);
  });
});

describe("the stdin watchdog flag", () => {
  it("is never a default and never listed: the command line takes it from the constant and keeps it out of usage and the value flags", async () => {
    assert.match(STDIN_EOF_FLAG, /^--[a-z-]+$/);
    for (const [name, source] of await cliSources()) {
      assert.doesNotMatch(source, new RegExp(STDIN_EOF_FLAG), `${name} spells the flag out instead of taking it from shutdown.ts`);
      assert.doesNotMatch(source, /VALUE_FLAGS\s*=\s*\[[^\]]*STDIN_EOF_FLAG/, `${name} lists the flag among the ones that take a value`);
      assert.match(source, /STDIN_EOF_FLAG/, `${name} does not read the flag at all`);
    }
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
