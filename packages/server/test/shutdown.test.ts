/**
 * How the command line ends on a signal: it closes the server and exits, a second signal exits at once, and a close
 * that does not finish by its deadline does not hold the process. Timers and the exit are fakes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createShutdown, SHUTDOWN_DEADLINE_MS } from "../src/shutdown.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rig(closing: Promise<unknown>) {
  const exits: number[] = [];
  const lines: string[] = [];
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  let closes = 0;
  const shutdown = createShutdown({
    close: () => {
      closes += 1;
      return closing;
    },
    exit: (code) => void exits.push(code),
    log: (line) => void lines.push(line),
    timers: {
      setTimeout: (run, ms) => {
        const timer = { run, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
  });
  return { shutdown, exits, lines, timers, closes: () => closes };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("createShutdown", () => {
  it("closes the server once and exits 0 when it is done, and clears its deadline", async () => {
    const closing = deferred();
    const r = rig(closing.promise);
    r.shutdown("SIGTERM");
    assert.equal(r.closes(), 1);
    assert.deepEqual(r.exits, []);
    assert.match(r.lines[0] ?? "", /SIGTERM/);
    closing.resolve();
    await flush();
    assert.deepEqual(r.exits, [0]);
    assert.equal(r.timers.length, 1);
    assert.equal(r.timers[0]!.cleared, true);
  });

  it("exits at once on a second signal, and does not close twice", async () => {
    const r = rig(new Promise(() => undefined));
    r.shutdown("SIGTERM");
    assert.deepEqual(r.exits, []);
    r.shutdown("SIGINT");
    assert.deepEqual(r.exits, [1]);
    assert.equal(r.closes(), 1);
    assert.match(r.lines.join("\n"), /second signal|again/i);
  });

  it("exits at its deadline when the close is still not done", async () => {
    const r = rig(new Promise(() => undefined));
    r.shutdown("SIGTERM");
    assert.equal(r.timers[0]!.ms, SHUTDOWN_DEADLINE_MS);
    assert.deepEqual(r.exits, []);
    r.timers[0]!.run();
    assert.deepEqual(r.exits, [1]);
    assert.match(r.lines.join("\n"), /did not finish/);
  });

  it("exits 1 and says why when the close fails", async () => {
    const closing = deferred();
    const r = rig(closing.promise);
    r.shutdown("SIGTERM");
    closing.reject(new Error("the store is locked"));
    await flush();
    assert.deepEqual(r.exits, [1]);
    assert.match(r.lines.join("\n"), /the store is locked/);
  });

  it("exits once even when the deadline and the close both come", async () => {
    const closing = deferred();
    const r = rig(closing.promise);
    r.shutdown("SIGTERM");
    r.timers[0]!.run();
    closing.resolve();
    await flush();
    assert.deepEqual(r.exits, [1]);
  });
});
