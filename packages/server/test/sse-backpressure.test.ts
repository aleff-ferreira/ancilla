import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import type { AncillaStore } from "@ancilla/daemon";
import { FakeConnection, get, send, sseEvents, start, waitFor } from "./harness.js";
import { FakeRes, tick } from "./sseFakes.js";

/**
 * What `/api/events` does with a client that stops reading. A fake response stands in for the socket wherever the
 * test needs to know exactly how much was queued; one raw `net` socket proves the same on a real connection, with no
 * assumption about how big the kernel's buffers are.
 */

function attach(server: unknown, res: FakeRes): void {
  (server as { serveEvents(r: unknown): void }).serveEvents(res);
}

function emit(server: unknown, type: string, data: unknown): void {
  (server as { emit(t: string, d: unknown): void }).emit(type, data);
}

function mspFrame(i: number, pad = 900): Record<string, unknown> {
  return { type: "msp", sessionId: "s1", method: "item/updated", params: { i, pad: "x".repeat(pad) }, at: i };
}

const sseHealth = async (base: string) => (await get(base, "/api/health")).diagnostics.sse;

describe("a client that stops reading the event stream", () => {
  it("is dropped once its backlog passes the cap, while a healthy client keeps every frame in order", async () => {
    const { server, base } = await start(new FakeConnection(), { sseMaxBacklogBytes: 64 * 1024 });
    const stuck = new FakeRes(false);
    const healthy = new FakeRes(true);
    attach(server, stuck);
    attach(server, healthy);

    for (let i = 0; i < 300; i += 1) {
      emit(server, "ancilla", mspFrame(i));
      await tick();
    }

    assert.equal(stuck.destroyed, true, "the reader that never drains is cut");
    assert.equal(stuck.ended, false, "destroyed, not ended: a graceful end would wait on the backlog it cannot send");
    assert.ok(stuck.bytes <= 64 * 1024 + 4 * 1024,`its queue stopped near the cap, not at ${stuck.bytes} bytes`);
    const seen = healthy.frames().filter((f) => f.data?.type === "msp").map((f) => f.data.params.i);
    assert.deepEqual(seen, Array.from({ length: 300 }, (_, i) => i), "the healthy client lost nothing and saw it in order");
    assert.equal(healthy.destroyed, false);
    const sse = await sseHealth(base);
    assert.equal(sse.clients, 1, "the dropped one left the registry");
    assert.equal(sse.overflowDisconnects, 1);
    assert.ok(sse.backlogHighWaterBytes >= 64 * 1024);
  });

  it("drops the last remaining client too", async () => {
    const { server, base } = await start(new FakeConnection(), { sseMaxBacklogBytes: 16 * 1024 });
    const stuck = new FakeRes(false);
    attach(server, stuck);
    for (let i = 0; i < 100; i += 1) {
      emit(server, "ancilla", mspFrame(i));
      await tick();
    }
    assert.equal(stuck.destroyed, true);
    assert.equal((await sseHealth(base)).clients, 0);
  });

  it("delivers one frame bigger than the cap onto an empty backlog, then cuts the client that still has not drained", async () => {
    const { server } = await start(new FakeConnection(), { sseMaxBacklogBytes: 1024 });
    const slow = new FakeRes(false);
    attach(server, slow);
    emit(server, "ancilla", mspFrame(1, 100 * 1024));
    await tick();
    assert.equal(slow.destroyed, false, "a single large frame is not a reason to cut a reader");
    assert.equal(slow.frames().filter((f) => f.data?.type === "msp").length, 1, "and it was delivered");
    emit(server, "ancilla", mspFrame(2, 10));
    await tick();
    assert.equal(slow.destroyed, true, "the next frame finds more than the cap still queued");
  });

  it("never merges or drops session-status and lifecycle events for a client that keeps up", async () => {
    const { server } = await start(new FakeConnection());
    const healthy = new FakeRes(true);
    attach(server, healthy);
    const sent: unknown[] = [];
    for (let i = 0; i < 400; i += 1) {
      const frame =
        i % 2 === 0
          ? { type: "session-status", sessionId: "s1", live: { activeTurnId: i % 4 === 0 ? "t1" : null, pendingApprovals: i % 3, pendingInputs: 0, lastTerminal: null, lastError: null } }
          : { type: "msp", sessionId: "s1", method: ["turn/started", "turn/completed", "approval/requested", "approval/resolved"][i % 4], params: { i }, at: i };
      sent.push(frame);
      emit(server, "ancilla", frame);
      if (i % 50 === 0) await tick();
    }
    await tick();
    const got = healthy.frames().filter((f) => f.data?.type !== "hello").map((f) => f.data);
    assert.deepEqual(got, sent, "every edge arrived, in order, as sent");
  });

  it("bounds only what it queues: edges still go to the client behind it", async () => {
    const { server } = await start(new FakeConnection(), { sseMaxBacklogBytes: 32 * 1024 });
    const stuck = new FakeRes(false);
    const healthy = new FakeRes(true);
    attach(server, stuck);
    attach(server, healthy);
    for (let i = 0; i < 120; i += 1) {
      emit(server, "ancilla", { type: "session-status", sessionId: "s1", live: { activeTurnId: `t${i}`, pad: "x".repeat(900) } });
      await tick();
    }
    const edges = healthy.frames().filter((f) => f.data?.type === "session-status");
    assert.equal(edges.length, 120);
    assert.deepEqual(edges.map((f) => f.data.live.activeTurnId), Array.from({ length: 120 }, (_, i) => `t${i}`));
  });

  it("handles an error on the response without throwing, and forgets the client", async () => {
    const { server, base } = await start(new FakeConnection());
    const res = new FakeRes(true);
    attach(server, res);
    assert.equal((await sseHealth(base)).clients, 1);
    assert.doesNotThrow(() => res.emit("error", new Error("write EPIPE")));
    await tick();
    assert.equal(res.destroyed, true);
    assert.equal((await sseHealth(base)).clients, 0);
  });

  it("serialises an event once for every client, and survives one that cannot be serialised", async () => {
    const { server, base } = await start(new FakeConnection());
    const a = new FakeRes(true);
    const b = new FakeRes(true);
    const c = new FakeRes(true);
    for (const res of [a, b, c]) attach(server, res);
    let serialised = 0;
    emit(server, "ancilla", {
      type: "msp",
      sessionId: "s1",
      toJSON() {
        serialised += 1;
        return { type: "msp", sessionId: "s1", method: "item/updated", params: {}, at: 1 };
      },
    });
    assert.equal(serialised, 1, "one JSON.stringify however many sinks");
    for (const res of [a, b, c]) assert.equal(res.frames().filter((f) => f.data?.type === "msp").length, 1);

    assert.doesNotThrow(() => emit(server, "ancilla", { type: "msp", sessionId: "s1", params: { big: 1n } }));
    emit(server, "ancilla", mspFrame(7, 4));
    for (const res of [a, b, c]) {
      assert.equal(res.frames().filter((f) => f.data?.type === "msp").length, 2, "the next frame still reaches everyone");
    }
    assert.equal((await sseHealth(base)).serializationFailures, 1);
  });

  it("tells a proxy not to buffer the stream", async () => {
    const { server, base } = await start(new FakeConnection());
    const res = new FakeRes(true);
    attach(server, res);
    assert.equal(res.headers["x-accel-buffering"], "no");
    const real = await fetch(`${base}/api/events`);
    assert.equal(real.headers.get("x-accel-buffering"), "no");
    await real.body?.cancel();
  });

  it("reports its limits next to the counters", async () => {
    const { base } = await start(new FakeConnection(), { sseMaxBacklogBytes: 123_456, sseStallMs: 7_000 });
    const sse = await sseHealth(base);
    assert.equal(sse.maxBacklogBytes, 123_456);
    assert.equal(sse.stallMs, 7_000);
    assert.deepEqual(
      Object.keys(sse).sort(),
      ["backlogHighWaterBytes", "clients", "maxBacklogBytes", "overflowDisconnects", "researchFramesSkipped", "serializationFailures", "stallDisconnects", "stallMs"],
    );
  });

  it("defaults to a 4 MiB cap and a stall deadline that is on", async () => {
    const { base } = await start(new FakeConnection());
    const sse = await sseHealth(base);
    assert.equal(sse.maxBacklogBytes, 4 * 1024 * 1024);
    assert.ok(sse.stallMs > 0 && sse.stallMs <= 120_000, `a deadline of ${sse.stallMs} ms`);
  });
});

describe("a raw socket that never reads /api/events", () => {
  it("is closed by the server, and a new connection still gets hello", { timeout: 90_000 }, async () => {
    const { server, base } = await start(new FakeConnection(), { sseMaxBacklogBytes: 256 * 1024 });
    const port = Number(new URL(base).port);
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n");
    // It reads nothing at all: not the headers, not hello, not a single frame.
    socket.pause();
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    await waitFor(async () => (await sseHealth(base)).clients === 1, "the raw client to register");

    // One frame per macrotask turn: Node holds a synchronous burst back until the next tick, so a burst says nothing
    // about whether the reader keeps up. How much the kernel absorbs first is not assumed; the loop runs until the cap bites.
    const frame = mspFrame(0, 32 * 1024);
    const deadline = Date.now() + 60_000;
    for (let i = 0; ; i += 1) {
      emit(server, "ancilla", frame);
      await tick();
      if (i % 25 === 0 && (await sseHealth(base)).overflowDisconnects >= 1) {
        break;
      }
      assert.ok(Date.now() < deadline, "the server never cut a client that does not read");
    }

    socket.resume();
    // Not `once(socket, "close")`: a reset arrives as an error first on some systems, which `once` would turn into a failure.
    await waitFor(() => closed, "the server to close the connection", 15_000);
    assert.equal(closed, true, "the server closed the connection");

    const hellos = await sseEvents(base, "hello", async () => undefined);
    assert.equal(hellos.length, 1, "a new connection gets hello");
    const sse = await sseHealth(base);
    assert.equal(sse.overflowDisconnects, 1);
    assert.equal(sse.clients, 0);
  });
});

describe("research sessions on the event stream", () => {
  async function rig() {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    const { server, base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/app" });
    const store = server["store"] as AncillaStore;
    const project = store.upsertProject("/work/app");
    store.recordSession({ id: "rw1", projectId: project.id, title: "Research worker A1", origin: "research-worker", createdAt: new Date().toISOString() });
    store.updateSession("rw1", { archived: true });
    // Creating a thread schedules the sidebar refresh a moment later; let it go out before a stream is opened to count.
    await waitFor(() => server["changeTimer"] === null, "the first sessions-changed to go out");
    return { connection, server, base, store };
  }

  const usage = (sessionId: string, turnId: string, cursor: string) => ({
    sessionId,
    turnId,
    modelId: "muse-spark-1.3",
    promptTokens: 900,
    totalTokens: 1000,
    durationMs: 1200,
    usage: { inputTokens: 900, outputTokens: 100, cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    viewCursor: cursor,
  });

  it("are not broadcast, while their usage rows and run listeners still get everything", async () => {
    const { connection, server, base, store } = await rig();
    const heard: string[] = [];
    (server as unknown as { onSessionNotification(id: string, h: (m: string, p: unknown) => void): () => void }).onSessionNotification("rw1", (method) => {
      heard.push(method);
    });

    const frames = await sseEvents(base, "msp", async () => {
      connection.notify("turn/started", { sessionId: "rw1", turnId: "t1" });
      connection.notify("item/updated", { sessionId: "rw1", item: { itemId: "i1", kind: "toolCall", status: "completed", revision: 1, output: "fetched web text" } });
      connection.notify("session/tokenUsage", usage("rw1", "t1", "v:rw1:4"));
      connection.notify("turn/completed", { sessionId: "rw1", turnId: "t1", terminal: "completed" });
      // The user's own thread is the control: its frames still go out.
      connection.notify("turn/started", { sessionId: "s1", turnId: "u1" });
    });
    assert.deepEqual(frames.map((f) => f.sessionId), ["s1"], "only the user's session reached the browser");

    assert.deepEqual(heard, ["turn/started", "item/updated", "session/tokenUsage", "turn/completed"], "the run's own listener heard all of it");
    const rows = store.listUsage().filter((row) => row.sessionId === "rw1");
    assert.equal(rows.length, 1, "the usage row was recorded");
    assert.equal(rows[0]?.promptTokens, 900);
    assert.equal(rows[0]?.origin, "research-worker");
    assert.ok((await sseHealth(base)).researchFramesSkipped >= 4);
  });

  it("send no session-status either, so an unlisted worker cannot make every client refresh its lists", async () => {
    const { connection, base } = await rig();
    const statuses = await sseEvents(base, "session-status", async () => {
      connection.notify("turn/started", { sessionId: "rw1", turnId: "t1" });
      connection.notify("turn/completed", { sessionId: "rw1", turnId: "t1", terminal: "completed" });
      connection.notify("turn/started", { sessionId: "s1", turnId: "u1" });
    });
    assert.deepEqual(statuses.map((s) => s.sessionId), ["s1"]);
  });

  it("do not set off a sessions-changed refresh when a worker's turn ends", async () => {
    const { connection, base } = await rig();
    const changes = await sseEvents(
      base,
      "sessions-changed",
      async () => {
        connection.notify("turn/started", { sessionId: "rw1", turnId: "t1" });
        connection.notify("turn/completed", { sessionId: "rw1", turnId: "t1", terminal: "completed" });
      },
      400,
    );
    assert.equal(changes.length, 0);
  });

  it("are looked up once for a session the store does not know, not for every frame it sends", async () => {
    const { server, base, store } = await rig();
    let lookups = 0;
    const real = store.getSession.bind(store);
    (store as unknown as { getSession(id: string): unknown }).getSession = (id: string) => {
      if (id === "ghost") lookups += 1;
      return real(id);
    };
    const ghost = (i: number) => emit(server, "ancilla", { type: "msp", sessionId: "ghost", method: "item/updated", params: { i }, at: i });
    const frames = await sseEvents(base, "msp", async () => {
      for (let i = 0; i < 30; i += 1) ghost(i);
    });
    assert.equal(frames.length, 30, "a session nobody has recorded yet is broadcast as before");
    assert.equal(lookups, 1, "and the store was asked once");

    // The run records its own worker at once, which has to win over the memory of not having known it.
    (server as unknown as { rememberResearchOrigin(id: string, research: boolean): void }).rememberResearchOrigin("ghost", true);
    const after = await sseEvents(base, "msp", async () => ghost(99), 400);
    assert.equal(after.length, 0);
  });

  it("still broadcast the run's own progress rows", async () => {
    const { server, base } = await rig();
    const runs = await sseEvents(base, "research-run", async () => {
      emit(server, "ancilla", { type: "research-run", sessionId: "s1", run: { runId: "r1", sessionId: "s1", status: "running" } });
    });
    assert.equal(runs.length, 1);
  });
});
