/**
 * The real `ancilla-server` process asked to stop while a Muse host is stuck starting: it ends instead of waiting for
 * the host, and a second signal ends it at once. The same for a hangup (a terminal that goes away sends SIGHUP) with a
 * `!` command still pending: the server closes, stops the command and exits 0, as it does on SIGTERM. Every wait is
 * for an event (a pid file, a log line, an exit); the timeouts only keep a hung child from hanging the suite. The
 * stuck host and the command are scripts and the signals are POSIX ones, so this is POSIX only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FAKE_MUSE_SKIP, isRunning } from "./fakeMuse.js";
import { HUNG, exitedWithin, serverWithPendingCommand, serverWithStuckHost, until } from "./cliRig.js";

describe("ancilla-server on a signal with a `!` command pending", () => {
  const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell and signals" : false;
  // SIGTERM is the control: what a hangup does has to be what a terminate does.
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    it(`closes on ${signal}, exits 0 and leaves the command stopped`, { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
      const pending = await serverWithPendingCommand();
      try {
        assert.equal(isRunning(pending.pid), true, "the command is running before the signal");
        pending.run.child.kill(signal);
        const ended = await exitedWithin(pending.run);
        assert.notEqual(ended, null, `the server was still running ${HUNG} ms after ${signal}; stderr:\n${pending.run.stderr()}`);
        assert.deepEqual(ended, { code: 0, signal: null }, `${signal} must end the server by a close, not by the signal; stderr:\n${pending.run.stderr()}`);
        assert.match(pending.run.stderr(), new RegExp(`${signal} received: closing the server`));
        await until(() => !isRunning(pending.pid), `the command to be stopped after ${signal}`);
      } finally {
        await pending.cleanup();
      }
    });
  }

  it("closes on SIGHUP all the same when nothing reads its stderr any more, as after a terminal has gone", { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
    const pending = await serverWithPendingCommand();
    try {
      // The reader's end is closed, so every line the shutdown writes finds the pipe broken.
      pending.run.child.stderr!.destroy();
      pending.run.child.kill("SIGHUP");
      const ended = await exitedWithin(pending.run);
      assert.notEqual(ended, null, `the server was still running ${HUNG} ms after SIGHUP`);
      assert.deepEqual(ended, { code: 0, signal: null }, "a write to a stderr that is gone ended the server before its close had run");
      await until(() => !isRunning(pending.pid), "the command to be stopped after SIGHUP");
    } finally {
      await pending.cleanup();
    }
  });
});

describe("ancilla-server on SIGTERM with a host that is stuck starting", () => {
  it("exits, and does not wait for the host", { skip: FAKE_MUSE_SKIP, timeout: 60_000 }, async () => {
    const stuck = await serverWithStuckHost();
    try {
      stuck.run.child.kill("SIGTERM");
      const ended = await exitedWithin(stuck.run);
      assert.notEqual(ended, null, `the server was still running ${HUNG} ms after SIGTERM; stderr:\n${stuck.run.stderr()}`);
      assert.equal(ended?.code, 0, stuck.run.stderr());
      assert.match(stuck.run.stderr(), /SIGTERM/);
    } finally {
      await stuck.cleanup();
    }
  });

  it("exits at once on a second signal while the first is still closing", { skip: FAKE_MUSE_SKIP, timeout: 60_000 }, async () => {
    const stuck = await serverWithStuckHost();
    try {
      stuck.run.child.kill("SIGTERM");
      await until(() => /SIGTERM/.test(stuck.run.stderr()), "the shutdown to begin");
      // Only a close that is still waiting can be cut short, so this is sent before the first one ends.
      stuck.run.child.kill("SIGTERM");
      const ended = await exitedWithin(stuck.run);
      assert.notEqual(ended, null, "a second signal did not end the server");
      assert.match(stuck.run.stderr(), /second signal/, "the second signal was seen while the first close was still waiting");
      assert.equal(ended?.code, 1, "the second signal is an exit, not a clean close");
    } finally {
      await stuck.cleanup();
    }
  });
});
