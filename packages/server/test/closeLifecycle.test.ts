/**
 * What `AncillaServer.close()` and `listen()` do about the requests, frames and sweeps that overlap them: a server that
 * is closing answers 503 to everything but its health check and starts nothing, a host that outlives its close cap
 * cannot reach a closed store, and the sweeps at boot cost the same however many rows are waiting, stop when the
 * server closes, and leave no timer. Hosts are scripted and every wait is injected; nothing starts a real Muse.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AncillaStore } from "@ancilla/daemon";
import { waitUnlessAborted } from "../src/hostBounds.js";
import { AncillaServer, type HostHandle } from "../src/server.js";
import { FakeConnection, send, start, waitFor } from "./harness.js";
import { busyError, deferred, newRun } from "./lifecycle-rig.js";
import { sleep } from "./research-rigs.js";

/** The outcome of a promise that must not stay pending: null when it did not settle within `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, sleep(ms).then(() => null)]);
}

/** Hosts whose close waits for the test, and the number of closes they were asked for. */
function holdingHosts(connection: FakeConnection) {
  const gate = deferred();
  const closes = { count: 0 };
  const factory = (): HostHandle => ({
    start: async () => ({ initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } }),
    connection: connection as never,
    close: async () => {
      closes.count += 1;
      await gate.promise;
      return { code: 0, signal: null };
    },
    onExit: () => undefined,
  });
  return { factory, closes, release: () => gate.resolve() };
}

/** Every method of the store, wrapped to list the ones called after `close`. */
function lateStoreCalls(store: AncillaStore): string[] {
  const late: string[] = [];
  let closed = false;
  const target = store as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(AncillaStore.prototype)) {
    const original = target[name];
    if (typeof original !== "function" || name === "constructor") continue;
    target[name] = (...args: unknown[]) => {
      if (closed) late.push(name);
      const result = (original as (...a: unknown[]) => unknown).apply(store, args);
      if (name === "close") closed = true;
      return result;
    };
  }
  return late;
}

describe("a server that is closing", () => {
  it("answers 503 to everything but its health check, and starts nothing", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const hosts = holdingHosts(connection);
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 50, closeMs: 60_000 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);
    assert.equal((await send(base, "/api/health", undefined, "GET")).json.closing, false, "a server that is not closing says so");

    const closing = server.close();
    await waitFor(() => hosts.closes.count === 1, "the close to reach the host");

    const research = await send(base, "/api/research", { commandId: "late", sessionId: "s1", question: "What is SQLite?" });
    assert.equal(research.status, 503);
    assert.equal(research.json.error, "Ancilla is shutting down.");
    assert.equal(server["store"].listRunningResearchRuns().length, 0, "a research row was left behind by a request made while closing");

    const created = await send(base, "/api/sessions", { cwd: "/work/ok" });
    assert.equal(created.status, 503, "a thread was started on a host that is closing");
    assert.equal(created.json.error, "Ancilla is shutting down.");
    assert.equal((await send(base, "/api/sessions", undefined, "GET")).status, 503);

    const health = await send(base, "/api/health", undefined, "GET");
    assert.equal(health.status, 200, "the health check has to keep answering while the server closes");
    assert.equal(health.json.closing, true, "the health check does not say that the server is closing");
    assert.equal(health.json.ok, true, "a closing server is still up and answering");

    hosts.release();
    assert.notEqual(await within(closing, 5000), null, "close() did not finish once the host did");
  });

  it("hands out no host once it is closing, not even one that is registered", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const hosts = holdingHosts(connection);
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 50, closeMs: 60_000 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);
    assert.equal(server["hosts"].size, 1);

    const closing = server.close();
    await waitFor(() => hosts.closes.count === 1, "the close to reach the host");
    assert.equal(server["hosts"].size, 1, "the host is still registered while it closes");
    await assert.rejects(
      server["hostFor"]("/work/ok"),
      (error: unknown) => (error as { status?: number }).status === 503 && /shutting down/.test((error as Error).message),
    );

    hosts.release();
    assert.notEqual(await within(closing, 5000), null);
  });

  it("waits on the starts still open and on the hosts at the same time, not one after the other", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const startGate = deferred();
    const closed: string[] = [];
    const factory = (target: { cwd: string }): HostHandle => ({
      start: async () => {
        if (target.cwd === "/work/wedged") await startGate.promise;
        return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
      },
      connection: connection as never,
      close: async () => {
        closed.push(target.cwd);
        return { code: 0, signal: null };
      },
      onExit: () => undefined,
    });
    const { server, base } = await start(connection, { hostFactory: factory as never, hostWaits: { startsMs: 60_000, closeMs: 60_000 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);
    const wedged = send(base, "/api/sessions", { cwd: "/work/wedged" }).then((reply) => reply.status, () => -1);
    await waitFor(() => server["starting"].size === 1, "the wedged start to be in flight");

    const closing = server.close();
    // The registered host is closed while the start is still open: nothing waits for the start first.
    await waitFor(() => closed.includes("/work/ok"), "the registered host to be closed while a start is still open");
    assert.equal(server["starting"].size, 1, "the start was already given up on when the host was closed");

    startGate.resolve();
    assert.notEqual(await within(closing, 5000), null, "close() did not finish once the start answered");
    await wedged;
  });

  it("waits on the title worker and on the hosts at the same time, not one after the other", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const hosts = holdingHosts(connection);
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 60_000, closeMs: 60_000 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);
    // A title worker that is held, and a note of the moment the close begins to wait on it.
    const titles = deferred();
    const worker = titles.promise.then(() => undefined);
    const realThen = worker.then.bind(worker);
    let waitedOn = false;
    worker.then = ((onFulfilled: never, onRejected: never) => {
      waitedOn = true;
      return realThen(onFulfilled, onRejected);
    }) as typeof worker.then;
    server["titleWorker"] = worker;

    const closing = server.close();
    await waitFor(() => hosts.closes.count === 1, "the close to reach the host");
    assert.equal(waitedOn, true, "the close had not begun to wait on the title worker while the host was still closing");
    assert.equal(await within(closing, 50), null, "the close ended while the host and the title worker were both held");

    hosts.release();
    titles.resolve();
    assert.notEqual(await within(closing, 5000), null, "close() did not finish once the host and the title worker did");
  });

  it("gives up on a title worker that never finishes once hostWaits.startsMs has passed", async () => {
    const connection = new FakeConnection();
    const { server } = await start(connection, { hostWaits: { startsMs: 50 } });
    // Never released: only the bound on the wait lets the close end.
    server["titleWorker"] = new Promise<void>(() => undefined);
    assert.notEqual(await within(server.close(), 5000), null, "close() waited on a title worker past startsMs");
  });

  it("drops the frames of a host that outlives its close, instead of writing them to a closed store", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const hosts = holdingHosts(connection);
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 50, closeMs: 100 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    const logs: string[] = [];
    server["log"] = (message: string) => void logs.push(message);
    const late = lateStoreCalls(server["store"]);

    assert.notEqual(await within(server.close(), 10_000), null, "close() waited for a host that never closes");
    assert.deepEqual(late, [], "the store was used after close() by something other than the close itself");
    const logged = logs.length;

    // The host is still there to speak: it never finished closing.
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    connection.notify("session/tokenUsage", { sessionId: "s1", usage: { inputTokens: 1 } });
    await sleep(50);

    assert.deepEqual(late, [], "a frame that arrived after close() reached the store");
    assert.equal(logs.length, logged, `a late frame was logged as a failure: ${logs.slice(logged).join(" | ")}`);
    assert.equal(server["forwardFailures"], 0, "a late frame was counted as a forward failure");
    hosts.release();
  });
});

describe("a `!` command that answers after the store is closed", () => {
  it("is not recorded, and the closed store is not called", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const answer = deferred<{ output: string; exitCode: number | null; truncated: boolean }>();
    const asked = deferred();
    const { server, base } = await start(connection, {
      shellRunner: () => {
        asked.resolve();
        return answer.promise;
      },
    });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);
    void send(base, "/api/sessions/s1/shell-proxy", { command: "make" }).catch(() => undefined);
    await asked.promise;
    const logs: string[] = [];
    server["log"] = (message: string) => void logs.push(message);
    const late = lateStoreCalls(server["store"]);

    await server.close();
    answer.resolve({ output: "done", exitCode: 0, truncated: false });
    await sleep(50);

    assert.deepEqual(late, [], "the answer of a command was written to a closed store");
    assert.deepEqual(logs, [], "the answer of a command after the close was logged as a failure");
  });
});

/** A server that is not started, over an in-memory store with `runs` research rows left in flight and every write refused as busy. */
async function lockedServer(retryMs: readonly number[], runs: number) {
  const home = await mkdtemp(join(tmpdir(), "ancilla-boot-sweep-"));
  const server = new AncillaServer({
    port: 0,
    dataDir: ":memory:",
    platform: "linux",
    musePath: "muse",
    home,
    exec: async () => ({ stdout: "", exitCode: 127 }),
    hostFactory: () => {
      throw new Error("no host is started here");
    },
    bootSweepRetryMs: retryMs,
  });
  after(async () => {
    await server.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  const store = server["store"];
  const project = store.upsertProject("/work/p");
  store.recordSession({ id: "s1", projectId: project.id });
  for (let index = 0; index < runs; index += 1) {
    newRun(store, `c${index}`, "running");
  }
  const calls = { list: 0, write: 0, turns: 0 };
  const target = store as unknown as Record<string, unknown>;
  const listed = store.listRunningResearchRuns.bind(store);
  target["listRunningResearchRuns"] = () => {
    calls.list += 1;
    return listed();
  };
  target["transaction"] = () => {
    calls.write += 1;
    throw busyError();
  };
  target["markRunningTurnsUnknown"] = () => {
    calls.turns += 1;
    throw busyError();
  };
  return { server, calls, home };
}

describe("the sweeps at boot with the database locked throughout", () => {
  it("cost the same however many rows are waiting", async () => {
    const waits = [1, 1, 1, 1];
    const few = await lockedServer(waits, 1);
    await few.server.listen();
    const many = await lockedServer(waits, 30);
    await many.server.listen();

    assert.deepEqual(few.calls, { list: 5, write: 5, turns: 5 }, "one row: one try per pass, for the first and the last pass");
    assert.deepEqual(many.calls, few.calls, "thirty rows were each tried on every pass: the wait grows with the row count");
  });

  it("stop when the server closes during a wait, call the store no more, and schedule nothing", async () => {
    const { server, calls } = await lockedServer([60_000], 3);
    const attempted = deferred();
    const target = server["store"] as unknown as Record<string, unknown>;
    const refuse = target["transaction"] as () => never;
    target["transaction"] = () => {
      attempted.resolve();
      return refuse();
    };
    const late = lateStoreCalls(server["store"]);

    const listening = server.listen();
    await attempted.promise;
    await server.close();
    const bound = await within(listening, 5000);

    assert.notEqual(bound, null, "listen() went on waiting after the server was closed");
    assert.deepEqual(late, [], "a sweep called the store after it was closed");
    assert.equal(calls.write, 1, "the sweep went on trying after the server was closed");
    assert.equal(calls.turns, 0, "the turn sweep ran for a server that was already closed");
    assert.equal(server["settleTimer"], null, "a closed server scheduled its settle sweep");
  });

  it("leave no timer behind when a wait is cut short", () => {
    const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const before = timers();
    const controller = new AbortController();
    const waiting = waitUnlessAborted(60_000, controller.signal);
    assert.equal(timers(), before + 1, "the wait armed no timer");
    controller.abort();
    assert.equal(timers(), before, "the aborted wait left its timer armed");
    return waiting.then((elapsed) => assert.equal(elapsed, false, "an aborted wait said its time ran out"));
  });

  it("report that the time ran out when nothing cut the wait short", async () => {
    assert.equal(await waitUnlessAborted(5, new AbortController().signal), true);
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await waitUnlessAborted(60_000, aborted.signal), false, "an aborted signal still waited");
  });
});
