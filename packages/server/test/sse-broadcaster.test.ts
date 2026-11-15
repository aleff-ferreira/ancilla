import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { SseBroadcaster } from "../src/sse.js";
import { FakeRes, ManualClock, tick } from "./sseFakes.js";

/**
 * The stall deadline and the heartbeat, on a clock the test moves by hand. `sweep()` is what the broadcaster's own
 * timer calls, so a test drives it directly and decides how late each call is.
 */

const SWEEP = 5_000;

function rig(over: { stallMs?: number; maxBacklogBytes?: number } = {}) {
  const clock = new ManualClock();
  const hub = new SseBroadcaster({
    maxBacklogBytes: over.maxBacklogBytes ?? 1024 * 1024,
    stallMs: over.stallMs ?? 90_000,
    sweepMs: SWEEP,
    now: clock.now,
    timer: false,
  });
  /** `ms` of regular ticks: the sweep runs on time, every `SWEEP`. */
  const run = (ms: number): void => {
    for (let spent = 0; spent < ms; spent += SWEEP) {
      clock.advance(Math.min(SWEEP, ms - spent));
      hub.sweep();
    }
  };
  return { clock, hub, run };
}

const FRAME = `event: ancilla\ndata: ${JSON.stringify({ type: "msp", sessionId: "s1" })}\n\n`;

describe("the stall deadline", () => {
  it("destroys a client that has not drained for the whole deadline, and not before", () => {
    const { hub, run } = rig();
    const stuck = new FakeRes(false);
    hub.add(stuck, FRAME);
    run(85_000);
    assert.equal(stuck.destroyed, false, "85 s in");
    run(5_000);
    assert.equal(stuck.destroyed, true, "90 s in");
    assert.equal(hub.stats().stallDisconnects, 1);
    assert.equal(hub.stats().clients, 0);
  });

  it("starts over when the client drains", () => {
    const { hub, run } = rig();
    const slow = new FakeRes(false);
    hub.add(slow, FRAME);
    run(80_000);
    slow.drain();
    hub.publish(FRAME);
    run(80_000);
    assert.equal(slow.destroyed, false, "a drain 80 s in restarts the clock");
    run(15_000);
    assert.equal(slow.destroyed, true, "and it expires 90 s after the write that was not accepted");
  });

  it("never expires a client whose writes are all accepted, however much time passes", () => {
    const { hub, run } = rig();
    const healthy = new FakeRes(true);
    hub.add(healthy, FRAME);
    for (let i = 0; i < 10; i += 1) {
      run(60_000);
      hub.publish(FRAME);
    }
    assert.equal(healthy.destroyed, false);
    assert.equal(hub.stats().stallDisconnects, 0);
  });

  it("can be turned off with a deadline of zero", () => {
    const { hub, run } = rig({ stallMs: 0 });
    const stuck = new FakeRes(false);
    hub.add(stuck, FRAME);
    run(60 * 60_000);
    assert.equal(stuck.destroyed, false);
  });

  it("is not tripped by the wall clock jumping while every client drains", () => {
    const { clock, hub, run } = rig();
    const clients = Array.from({ length: 6 }, () => new FakeRes(true));
    for (const res of clients) hub.add(res, FRAME);
    run(10_000);
    // A suspend and resume, or a clock set forward by an hour, between two ticks.
    clock.advance(60 * 60_000);
    hub.sweep();
    run(10_000);
    hub.publish(FRAME);
    assert.deepEqual(clients.map((res) => res.destroyed), clients.map(() => false));
    assert.equal(hub.stats().stallDisconnects, 0);
  });

  it("does not count a blocked event loop or a suspend against clients that were already stalled", () => {
    const { clock, hub, run } = rig();
    const clients = Array.from({ length: 6 }, () => new FakeRes(false));
    for (const res of clients) hub.add(res, FRAME);
    run(60_000);
    // The loop was blocked (or the machine slept) for ten minutes: the next tick is that late.
    clock.advance(10 * 60_000);
    hub.sweep();
    assert.deepEqual(clients.map((res) => res.destroyed), clients.map(() => false), "no client expires all at once");
    run(85_000);
    assert.deepEqual(clients.map((res) => res.destroyed), clients.map(() => false), "the clock started over at the late tick");
    run(10_000);
    assert.deepEqual(clients.map((res) => res.destroyed), clients.map(() => true), "and a client that is still stuck a full deadline later goes");
  });

  it("forgives a tick that is only a little late, since a stalled client has no excuse for that", () => {
    const { clock, hub, run } = rig();
    const stuck = new FakeRes(false);
    hub.add(stuck, FRAME);
    run(85_000);
    clock.advance(SWEEP + 500);
    hub.sweep();
    assert.equal(stuck.destroyed, true, "half a second of lag does not buy a client more time");
  });

  it("starts the deadline over from a clock that ran backwards, rather than waiting for it to catch up", () => {
    const { clock, hub, run } = rig();
    const stuck = new FakeRes(false);
    hub.add(stuck, FRAME);
    run(60_000);
    // Set back half an hour: the stall began at a reading far in the future of this one. Left alone, the client
    // would be given those thirty minutes on top of the deadline.
    clock.advance(-30 * 60_000);
    assert.doesNotThrow(() => hub.sweep());
    assert.equal(stuck.destroyed, false);
    run(80_000);
    assert.equal(stuck.destroyed, false, "80 s after the step is inside the deadline");
    run(15_000);
    assert.equal(stuck.destroyed, true, "and 95 s after it the client is gone, not half an hour later");
  });

  it("keeps a slow client that is taking its backlog down, however long it takes", () => {
    const { hub, run } = rig();
    const slow = new FakeRes(false);
    hub.add(slow, FRAME);
    // A link slower than the stream: some bytes leave every tick, new ones arrive every tick, and the queue is
    // never empty, so `drain` never fires. Nothing about that is a stall.
    //
    // The fake models a continuous drain: `take` lowers the queue a few bytes at a time. A real response does not.
    // Node sends everything buffered behind a write in flight as one batch, and `writableLength` only falls when a
    // whole batch is done, so a reader taking bytes steadily inside one large batch shows no progress until it ends
    // (measured on a real socket: socket.bytesWritten and the handle's own queue size are flat inside the batch too).
    // What this test pins is the rule that follows progress as the response reports it; the next-but-one test pins
    // what the rule means for a batch that is not finished in time.
    for (let i = 0; i < 60; i += 1) {
      hub.publish(FRAME);
      slow.take(FRAME.length + 40);
      hub.publish(FRAME);
      run(5_000);
    }
    assert.equal(slow.destroyed, false, "five minutes of progress is not a stall");
    assert.ok(slow.writableLength > 0, "and the queue never emptied");
    assert.equal(hub.stats().stallDisconnects, 0);
  });

  it("starts the deadline over at the last progress, and cuts a client that then stops for a whole deadline", () => {
    const { hub, run } = rig();
    const slow = new FakeRes(false);
    hub.add(slow, FRAME);
    hub.publish(FRAME);
    run(60_000);
    slow.take(10);
    run(5_000);
    assert.equal(slow.destroyed, false, "progress at 65 s");
    run(80_000);
    assert.equal(slow.destroyed, false, "80 s since the last byte left");
    run(10_000);
    assert.equal(slow.destroyed, true, "90 s without a byte leaving");
  });

  it("cuts a client that finishes no write batch for a whole deadline, however slowly it was reading inside it", () => {
    const { hub, run } = rig();
    const midBatch = new FakeRes(false);
    hub.add(midBatch, FRAME);
    hub.publish(FRAME);
    // A real response shows no change while a batch is in flight, which this is: nothing the response reports moves.
    // That the reader may be taking bytes meanwhile is not visible, and the documented rule is stated in those terms.
    run(85_000);
    assert.equal(midBatch.destroyed, false, "inside the deadline");
    run(5_000);
    assert.equal(midBatch.destroyed, true, "a deadline without a completed batch");
    assert.equal(hub.stats().stallDisconnects, 1);
  });

  it("does not take a growing queue for progress", () => {
    const { hub, run } = rig();
    const stuck = new FakeRes(false);
    hub.add(stuck, FRAME);
    for (let i = 0; i < 20; i += 1) {
      hub.publish(FRAME);
      run(5_000);
    }
    assert.equal(stuck.destroyed, true, "more arriving and nothing leaving");
  });

  it("falls back to the default for a deadline that is not a number or is negative, and only zero turns it off", () => {
    for (const bad of [Number.NaN, -1, -90_000, Number.POSITIVE_INFINITY]) {
      assert.equal(new SseBroadcaster({ stallMs: bad, timer: false }).stats().stallMs, 90_000, `${bad}`);
    }
    assert.equal(new SseBroadcaster({ stallMs: 0, timer: false }).stats().stallMs, 0);
    assert.equal(new SseBroadcaster({ timer: false }).stats().stallMs, 90_000);
    assert.equal(new SseBroadcaster({ stallMs: 7_000, timer: false }).stats().stallMs, 7_000);
  });
});

describe("the heartbeat", () => {
  it("pings a client every 25 s", () => {
    const { hub, run } = rig();
    const healthy = new FakeRes(true);
    hub.add(healthy, FRAME);
    run(24_000);
    assert.equal(healthy.pings(), 0);
    run(6_000);
    assert.equal(healthy.pings(), 1);
    run(60_000);
    assert.ok(healthy.pings() >= 3);
  });

  it("writes nothing while the response still needs to drain", () => {
    const { hub, run } = rig();
    const stuck = new FakeRes(false);
    hub.add(stuck, FRAME);
    const before = stuck.bytes;
    run(80_000);
    assert.equal(stuck.pings(), 0);
    assert.equal(stuck.bytes, before, "not one more byte queued behind a reader that is not reading");
  });

  it("pings again once the client has drained", () => {
    const { hub, run } = rig();
    const slow = new FakeRes(false);
    hub.add(slow, FRAME);
    run(30_000);
    assert.equal(slow.pings(), 0);
    slow.drain();
    run(5_000);
    assert.equal(slow.pings(), 1);
  });
});

describe("the backlog cap", () => {
  it("cuts a client when more than the cap was already queued before this frame, never for the frame itself", async () => {
    const { hub } = rig({ maxBacklogBytes: 1000 });
    const frame = (n: number) => `event: ancilla\ndata: ${"x".repeat(n)}\n\n`;
    const slow = new FakeRes(false);
    hub.add(slow, "");
    hub.publish(frame(5000));
    await tick();
    assert.equal(slow.destroyed, false, "one frame over the cap onto an empty backlog is admitted");
    hub.publish(frame(10));
    await tick();
    assert.equal(slow.destroyed, true, "the next finds 5000 queued against a cap of 1000");
    assert.equal(hub.stats().overflowDisconnects, 1);
    assert.equal(hub.stats().backlogHighWaterBytes >= 5000, true);
  });

  it("leaves a client that is exactly at the cap", async () => {
    const { hub } = rig({ maxBacklogBytes: 1000 });
    const slow = new FakeRes(false);
    hub.add(slow, "");
    const frame = (n: number) => "x".repeat(n);
    hub.publish(frame(1000));
    hub.publish(frame(1));
    await tick();
    assert.equal(slow.destroyed, false, "1000 queued is not more than 1000");
    hub.publish(frame(1));
    await tick();
    assert.equal(slow.destroyed, true);
  });

  it("does not cut a client that keeps up because a burst in one tick was bigger than the cap", async () => {
    const { hub } = rig({ maxBacklogBytes: 1000 });
    // What Node does with a reader that is fast: everything written in a tick is held until the tick is over, then
    // goes out whole. Judged mid-burst, this client would look 4000 bytes behind.
    const quick = new FakeRes(false, { flushesOnTick: true });
    hub.add(quick, "");
    for (let i = 0; i < 10; i += 1) {
      hub.publish("x".repeat(500));
    }
    await tick();
    assert.equal(quick.destroyed, false, "the burst went out and the client is not behind");
    assert.equal(hub.stats().overflowDisconnects, 0);
    assert.equal(quick.bytes, 5000, "and it was sent all of it");
  });

  it("still cuts a client whose backlog is over the cap once the burst is over, and says so only then", async () => {
    const { hub } = rig({ maxBacklogBytes: 1000 });
    const stuck = new FakeRes(false);
    hub.add(stuck, "");
    for (let i = 0; i < 10; i += 1) {
      hub.publish("x".repeat(500));
    }
    await tick();
    assert.equal(stuck.destroyed, true);
    assert.equal(stuck.ended, false);
    assert.equal(hub.stats().overflowDisconnects, 1, "counted once, however many frames saw the backlog");
    assert.equal(hub.stats().clients, 0);
  });

  it("does not look at a client again after it left before the end of the tick", async () => {
    const { hub } = rig({ maxBacklogBytes: 1000 });
    const stuck = new FakeRes(false);
    hub.add(stuck, "");
    for (let i = 0; i < 5; i += 1) {
      hub.publish("x".repeat(500));
    }
    stuck.destroy();
    await tick();
    assert.equal(hub.stats().overflowDisconnects, 0, "it was gone, not cut");
  });

  it("forgets a response that closed or was destroyed elsewhere", () => {
    const { hub } = rig();
    const gone = new FakeRes(true);
    hub.add(gone, FRAME);
    gone.destroy();
    hub.publish(FRAME);
    assert.equal(hub.stats().clients, 0);
    assert.equal(gone.frames().length, 1, "nothing was written to it after it went");
  });
});

describe("the sweep timer", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  /** The intervals started and not yet cleared, by watching the two calls the broadcaster makes. */
  function liveIntervals(): Set<unknown> {
    const live = new Set<unknown>();
    const started = globalThis.setInterval;
    const cleared = globalThis.clearInterval;
    mock.method(globalThis, "setInterval", ((...args: Parameters<typeof setInterval>) => {
      const handle = started(...args);
      live.add(handle);
      return handle;
    }) as never);
    mock.method(globalThis, "clearInterval", ((handle: Parameters<typeof clearInterval>[0]) => {
      live.delete(handle);
      cleared(handle);
    }) as never);
    return live;
  }

  /** A broadcaster with its real timer, which is what the server runs. */
  const withTimer = () => new SseBroadcaster({ maxBacklogBytes: 1024 * 1024, stallMs: 90_000 });

  it("runs while a client is there and is gone with the last one", () => {
    const live = liveIntervals();
    const hub = withTimer();
    const first = new FakeRes(true);
    const second = new FakeRes(true);
    hub.add(first, FRAME);
    hub.add(second, FRAME);
    assert.equal(live.size, 1, "one timer for both clients");
    first.destroy();
    hub.publish(FRAME);
    assert.equal(live.size, 1, "one client is still there");
    second.destroy();
    hub.publish(FRAME);
    assert.equal(live.size, 0, "the last one left");
    hub.close();
  });

  it("is not left running by a response that was already destroyed when it was added", () => {
    const live = liveIntervals();
    const hub = withTimer();
    const dead = new FakeRes(true);
    dead.destroyed = true;
    hub.add(dead, FRAME);
    assert.equal(hub.stats().clients, 0);
    assert.equal(live.size, 0, "no client, no idle timer");
    hub.close();
  });

  it("is not left running by a response whose first write throws", () => {
    const live = liveIntervals();
    const hub = withTimer();
    const broken = new FakeRes(true);
    broken.write = () => {
      throw new Error("write after end");
    };
    assert.doesNotThrow(() => hub.add(broken, FRAME));
    assert.equal(hub.stats().clients, 0);
    assert.equal(broken.destroyed, true, "and it is destroyed, not kept");
    assert.equal(live.size, 0);
    hub.close();
  });

  it("does not disturb the timer a client that is still there is using", () => {
    const live = liveIntervals();
    const hub = withTimer();
    const good = new FakeRes(true);
    hub.add(good, FRAME);
    const dead = new FakeRes(true);
    dead.destroyed = true;
    hub.add(dead, FRAME);
    assert.equal(hub.stats().clients, 1);
    assert.equal(live.size, 1, "the first client's timer survives the second's failure");
    hub.close();
    assert.equal(live.size, 0);
  });
});
