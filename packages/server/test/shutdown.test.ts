/**
 * How the command line ends on a signal or the end of its stdin: it closes the server and exits, a second signal exits
 * at once, and a close that does not finish by its deadline does not hold the process. Timers, stdin and the exit are
 * fakes.
 */
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { closeWhenStdinEnds, createShutdown, settleStdin, SHUTDOWN_DEADLINE_MS, STDIN_SETTLE_MS } from "../src/shutdown.js";

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

/** A clock that only moves when something sleeps, so that waiting is counted and costs no time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
}

describe("settleStdin", () => {
  it("returns at once when a close has already begun", async () => {
    const clock = fakeClock();
    await settleStdin({ begun: () => true }, clock);
    assert.equal(clock.elapsed(), 0);
  });

  it("waits the whole settle time when nothing happens: a pipe that stays open costs one wait, and no more", async () => {
    const clock = fakeClock();
    await settleStdin({ begun: () => false }, clock);
    assert.ok(clock.elapsed() >= STDIN_SETTLE_MS && clock.elapsed() < STDIN_SETTLE_MS + 10, `waited ${clock.elapsed()} ms`);
    // Every start of the desktop app pays it, in front of a boot that takes seconds: it stays a fraction of a second.
    assert.ok(STDIN_SETTLE_MS <= 250, `the settle time is ${STDIN_SETTLE_MS} ms`);
  });

  it("stops waiting as soon as the end of stdin is reported, however late in the wait", async () => {
    for (const reportedAt of [5, 40, 95]) {
      const clock = fakeClock();
      await settleStdin({ begun: () => clock.elapsed() >= reportedAt }, clock);
      assert.ok(clock.elapsed() >= reportedAt && clock.elapsed() < reportedAt + 10, `reported at ${reportedAt} ms, stopped at ${clock.elapsed()} ms`);
    }
  });

  it("counts by the clock and not by the number of looks, since a timer can take longer than it was asked for", async () => {
    let t = 0;
    let looks = 0;
    // Every sleep takes three times what it asked for, as a timer on Windows can.
    await settleStdin(
      { begun: () => false },
      {
        now: () => t,
        sleep: async (ms) => {
          looks += 1;
          t += ms * 3;
        },
      },
    );
    assert.ok(t >= STDIN_SETTLE_MS && t < STDIN_SETTLE_MS + 20, `waited ${t} ms`);
    assert.ok(looks <= Math.ceil(STDIN_SETTLE_MS / 15) + 1, `looked ${looks} times`);
  });

  it("closes a server whose stdin ended while it was waiting, and so no ready line is written", async () => {
    // What the command line does after the server is listening: wait, then write the line only if no close has begun.
    const closing = deferred();
    const r = rig(closing.promise);
    const stdin = fakeStdin();
    closeWhenStdinEnds(stdin, r.shutdown);
    const clock = fakeClock();
    const written: string[] = [];
    await settleStdin(r.shutdown, {
      now: clock.now,
      // The end of the pipe is reported thirty milliseconds into the wait: later than one turn of the event loop.
      sleep: async (ms) => {
        await clock.sleep(ms);
        if (clock.elapsed() >= 30) stdin.emit("end");
      },
    });
    if (!r.shutdown.begun()) written.push("ancilla-server listening on http://127.0.0.1:1\n");
    assert.deepEqual(written, []);
    assert.equal(r.closes(), 1);
  });
});
