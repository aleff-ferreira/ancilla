/**
 * How the command line ends on a signal or the end of its stdin: it closes the server and exits, a second signal exits
 * at once, and a close that does not finish by its deadline does not hold the process. Timers, stdin and the exit are
 * fakes.
 */
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { closeWhenStdinEnds, createShutdown, SHUTDOWN_DEADLINE_MS } from "../src/shutdown.js";

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

/** A stdin that can be made to report its end and an error in either order, and counts the times it is read. */
function fakeStdin() {
  const events = new EventEmitter();
  const stdin = Object.assign(events, { resumed: 0, resume: () => { stdin.resumed += 1; } });
  return stdin;
}

describe("closeWhenStdinEnds", () => {
  it("reads stdin, and closes the server once when it ends", async () => {
    const closing = deferred();
    const r = rig(closing.promise);
    const stdin = fakeStdin();
    closeWhenStdinEnds(stdin, r.shutdown);
    assert.equal(stdin.resumed, 1);
    assert.equal(r.closes(), 0, "nothing is closed while stdin is open");
    stdin.emit("end");
    assert.equal(r.closes(), 1);
    assert.match(r.lines[0] ?? "", /stdin EOF received/);
    closing.resolve();
    await flush();
    assert.deepEqual(r.exits, [0]);
  });

  for (const order of [["end", "error"], ["error", "end"], ["error", "error"]] as const) {
    it(`starts one close when stdin reports ${order.join(" and then ")}, and the second event is not a second signal`, async () => {
      const closing = deferred();
      const r = rig(closing.promise);
      const stdin = fakeStdin();
      closeWhenStdinEnds(stdin, r.shutdown);
      for (const event of order) {
        stdin.emit(event, event === "error" ? new Error("read EPIPE") : undefined);
      }
      assert.equal(r.closes(), 1);
      assert.deepEqual(r.exits, [], "the second event ended the process before the close had finished");
      assert.doesNotMatch(r.lines.join("\n"), /second signal/);
      closing.resolve();
      await flush();
      assert.deepEqual(r.exits, [0]);
    });
  }

  it("does not turn the end of stdin into a second signal while a signal's close is under way", async () => {
    const r = rig(new Promise(() => undefined));
    const stdin = fakeStdin();
    closeWhenStdinEnds(stdin, r.shutdown);
    r.shutdown("SIGTERM");
    stdin.emit("end");
    assert.equal(r.closes(), 1);
    assert.deepEqual(r.exits, []);
    assert.doesNotMatch(r.lines.join("\n"), /second signal/);
  });
});
