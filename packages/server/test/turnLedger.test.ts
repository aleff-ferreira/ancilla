/**
 * The turn ledger as the server keeps it from the host's notifications and from the acknowledgement of a prompt: a
 * turn is registered when it starts, finished once, and a late, replayed or retired-host frame cannot corrupt a
 * thread's live state.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpDir } from "./lifecycle-rig.js";
import { FakeConnection, fakeFactory, get, send, start, waitFor, type FactoryProbe } from "./harness.js";

interface TurnRow {
  id: string;
  status: string;
}

interface StoreLike {
  listTurns(sessionId: string): TurnRow[];
  finishTurn(id: string, sessionId: string, status: string): unknown;
}

const RANGE = { startCursor: "c0", endCursor: "c1" };

async function rig(options: { dataDir?: string; probe?: FactoryProbe } = {}) {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const cwd = await mkdtemp(join(tmpdir(), "ancilla-ledger-"));
  const logs: string[] = [];
  const { server, base } = await start(connection, {
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.probe ? { hostFactory: fakeFactory(connection, options.probe) } : {}),
  });
  (server as unknown as { log: (line: string) => void }).log = (line) => {
    logs.push(line);
  };
  assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
  const store = (server as unknown as { store: StoreLike }).store;
  const live = async () => (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
  const rows = () => store.listTurns("s1").map((t) => [t.id, t.status]);
  return { connection, base, cwd, server, store, logs, live, rows };
}

describe("the turn ledger from notifications", () => {
  it("registers a turn as running when it starts and finishes it once however often it is replayed", async () => {
    const { connection, live, rows } = await rig();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1", sourceRange: RANGE });
    assert.deepEqual(rows(), [["t1", "running"]]);
    assert.equal((await live()).turnCount, 0, "a turn that has not finished is not counted");

    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    assert.deepEqual(rows(), [["t1", "completed"]]);
    assert.equal((await live()).turnCount, 1);
  });

  it("does not let a late completion of another turn mark the running turn failed", async () => {
    const { connection, live, rows } = await rig();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t2" });
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "failed", error: { message: "old trouble" } });
    const during = (await live()).live;
    assert.equal(during.activeTurnId, "t2", "the running turn is still running");
    assert.equal(during.lastTerminal, null);
    assert.equal(during.lastError, null);
    assert.deepEqual(rows(), [["t1", "failed"], ["t2", "running"]], "the straggler is still a turn that finished");

    connection.notify("turn/completed", { sessionId: "s1", turnId: "t2", terminal: "completed" });
    const after = (await live()).live;
    assert.equal(after.activeTurnId, null);
    assert.equal(after.lastTerminal, "completed");
  });

  it("does not reopen a finished turn when its start is replayed", async () => {
    const { connection, live, rows } = await rig();
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    assert.equal((await live()).live.activeTurnId, null, "nothing is running");
    assert.deepEqual(rows(), [["t1", "completed"]]);
    assert.equal((await live()).turnCount, 1);
  });

  it("does not bind a turn from a host that was retired", async () => {
    const { connection, base, server, live } = await rig();
    const retired = connection.handler;
    assert.ok(retired, "the host's handler was captured");
    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await waitFor(async () => (await get(base, "/api/health")).hosts.length === 0, "the host to be retired");

    retired({ method: "turn/started", params: { sessionId: "s1", turnId: "zombie" } });
    assert.equal((await live()).live.activeTurnId, null, "a turn from a dead host never became the thread's");
    assert.equal((server as unknown as { sessionHosts: Map<string, string> }).sessionHosts.has("s1"), false, "and the session was not bound to it");
  });

  it("does not bind a turn from a retired host once its replacement runs under the same key", async () => {
    const { connection, base, cwd, live } = await rig();
    const retired = connection.handler;
    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await waitFor(async () => (await get(base, "/api/health")).hosts.length === 0, "the host to be retired");
    connection.replies.set("session/start", { session: { sessionId: "s2" } });
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    assert.equal((await get(base, "/api/health")).hosts.length, 1, "a new host started");

    retired!({ method: "turn/started", params: { sessionId: "s1", turnId: "zombie" } });
    assert.equal((await live()).live.activeTurnId, null);
  });

  it("keeps the turn and the requests of a session that runs on the replacement when a retired host reports it closed", async () => {
    const { connection, base, cwd, server } = await rig();
    const retired = connection.handler;
    assert.ok(retired, "the first host's handler was captured");
    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await waitFor(async () => (await get(base, "/api/health")).hosts.length === 0, "the host to be retired");
    connection.replies.set("session/start", { session: { sessionId: "s2" } });
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    assert.equal((await get(base, "/api/health")).hosts.length, 1, "a new host started");

    // The session now runs on the replacement: its turn and a request waiting on the user came from there.
    connection.notify("turn/started", { sessionId: "s1", turnId: "t3" });
    connection.notify("approval/requested", { sessionId: "s1", approvalId: "a1" });
    const live = () => server["live"].get("s1");
    assert.equal(live()?.activeTurnId, "t3");
    assert.equal(live()?.pendingApprovals.size, 1);
    const key = server["sessionHosts"].get("s1");
    assert.ok(key, "the session is bound to the replacement");
    const told: string[] = [];
    const stop = server["onSessionNotification"]("s1", (method: string) => void told.push(method));

    // The old host was still draining when it was given up on, and says so late.
    retired({ method: "session/closed", params: { sessionId: "s1", reason: "hostShutdown" } });
    assert.equal(live()?.activeTurnId, "t3", "the old host's close ended the turn running on the new one");
    assert.equal(live()?.pendingApprovals.size, 1, "and its pending request");
    assert.equal(server["sessionHosts"].get("s1"), key, "and unbound the session");
    assert.deepEqual(told, ["session/closed"], "listeners are still told what the old host reported");

    // The registered host closing the session is still the end of it.
    connection.notify("session/closed", { sessionId: "s1", reason: "hostShutdown" });
    assert.equal(live()?.activeTurnId, null);
    assert.equal(live()?.pendingApprovals.size, 0);
    assert.equal(server["sessionHosts"].has("s1"), false);
    stop();
  });

  it("stays silent about a session it does not track and writes nothing for it", async () => {
    const { connection, logs, base, rows } = await rig();
    for (let i = 0; i < 5; i += 1) {
      connection.notify("turn/started", { sessionId: "ghost", turnId: `g${i}` });
      connection.notify("turn/completed", { sessionId: "ghost", turnId: `g${i}`, terminal: "completed" });
    }
    assert.deepEqual(logs.filter((line) => /turn/i.test(line)), [], "no log line per frame");
    assert.equal((await get(base, "/api/health")).diagnostics.forwardFailures, 0);
    assert.deepEqual(rows(), []);
  });

  it("logs a ledger failure and goes on, with the live state still right", async () => {
    const { connection, store, logs, live, base } = await rig();
    store.finishTurn = () => {
      throw new Error("disk I/O error");
    };
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    assert.ok(logs.some((line) => /t1/.test(line) && /disk I\/O error/.test(line)), `the failure is logged: ${logs.join(" | ")}`);
    assert.equal((await live()).live.activeTurnId, null);
    assert.equal((await live()).live.lastTerminal, "completed");
    assert.equal((await get(base, "/api/health")).diagnostics.forwardFailures, 0, "forward itself did not throw");
  });
});

describe("the turn ledger when a host goes away", () => {
  /** Counts what is written to the ledger for one turn, and passes it on. */
  function countFinishes(store: StoreLike, turnId: string): () => string[] {
    const real = store.finishTurn.bind(store);
    const written: string[] = [];
    store.finishTurn = (id, sessionId, status) => {
      if (id === turnId) written.push(status);
      return real(id, sessionId, status);
    };
    return () => written;
  }

  it("records the turn a restart killed as failed, once, and a late real completion neither reopens nor recounts it", async () => {
    const { connection, base, cwd, store, live, rows } = await rig();
    const retired = connection.handler;
    const written = countFinishes(store, "t1");
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    assert.deepEqual(rows(), [["t1", "running"]]);

    await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH");
    await waitFor(async () => (await get(base, "/api/health")).hosts.length === 0, "the host to be restarted");
    assert.equal((await live()).live.lastTerminal, "failed", "the live state already said so");
    assert.deepEqual(rows(), [["t1", "failed"]], "the ledger says the turn is over, not running");
    assert.deepEqual(written(), ["failed"], "written once");
    assert.equal((await live()).turnCount, 1, "a turn that was lost with its host happened");

    // The old host's own word, late: heard, and no second turn.
    retired!({ method: "turn/completed", params: { sessionId: "s1", turnId: "t1", terminal: "completed" } });
    assert.deepEqual(rows(), [["t1", "completed"]], "the last word on a turn is the one kept");
    assert.equal((await live()).turnCount, 1, "and it is not counted twice");

    // A replay of its start on the host that replaced the old one finds the turn over.
    connection.replies.set("session/start", { session: { sessionId: "s2" } });
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    assert.equal((await live()).live.activeTurnId, null, "the finished turn was not reopened");
    assert.deepEqual(rows(), [["t1", "completed"]]);
  });

  it("records it as failed when the host's connection ended too", async () => {
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { connection, server, store, live, rows } = await rig({ probe });
    const written = countFinishes(store, "t1");
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    assert.deepEqual(rows(), [["t1", "running"]]);

    probe.exits[0]!({ code: null, signal: null, reason: "connection-ended" });
    assert.equal(server["hosts"].size, 0, "the host is forgotten");
    assert.deepEqual(rows(), [["t1", "failed"]]);
    assert.deepEqual(written(), ["failed"]);
    assert.match((await live()).live.lastError, /connection to the Muse host ended/);

    probe.exits[0]!({ code: 1, signal: null });
    assert.deepEqual(written(), ["failed"], "a second report of the same host's end writes nothing more");
  });

  it("writes nothing for a session that had no turn running", async () => {
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { connection, store, rows } = await rig({ probe });
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    const written = countFinishes(store, "t1");
    probe.exits[0]!({ code: 1, signal: null });
    assert.deepEqual(written(), [], "a finished turn is not finished again");
    assert.deepEqual(rows(), [["t1", "completed"]]);
  });

  it("logs a ledger failure and still forgets the host and ends the turn in the live state", async () => {
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { connection, server, store, logs, live } = await rig({ probe });
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    store.finishTurn = () => {
      throw new Error("disk I/O error");
    };
    const told: string[] = [];
    const stop = server["onSessionNotification"]("s1", (method: string) => void told.push(method));
    probe.exits[0]!({ code: 1, signal: null });
    assert.ok(logs.some((line) => /t1/.test(line) && /disk I\/O error/.test(line)), `the failure is logged: ${logs.join(" | ")}`);
    assert.equal(server["hosts"].size, 0);
    assert.equal((await live()).live.activeTurnId, null);
    assert.equal((await live()).live.lastTerminal, "failed");
    assert.deepEqual(told, ["session/closed"], "the listeners were told after the ledger failed");
    stop();
  });
});

describe("the turn ledger from the acknowledgement of a prompt", () => {
  const sendPrompt = (base: string) => send(base, "/api/turns", { sessionId: "s1", text: "go" });

  it("registers a started turn", async () => {
    const { connection, base, rows } = await rig();
    connection.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "started" });
    assert.equal((await sendPrompt(base)).status, 200);
    assert.deepEqual(rows(), [["t1", "running"]]);
  });

  it("registers nothing for a queued or a steered prompt", async () => {
    const { connection, base, rows } = await rig();
    connection.replies.set("turn/start", { turnId: "q1", status: "accepted", disposition: "queued" });
    assert.equal((await sendPrompt(base)).status, 200);
    connection.replies.set("turn/start", { turnId: "t1", status: "accepted", disposition: "steered" });
    assert.equal((await sendPrompt(base)).status, 200);
    assert.deepEqual(rows(), []);
  });

  it("does not reopen a turn that already finished before its acknowledgement was handled", async () => {
    const { connection, base, rows } = await rig();
    connection.replies.set("turn/start", () => {
      connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
      connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
      return { turnId: "t1", status: "accepted", disposition: "started" };
    });
    assert.equal((await sendPrompt(base)).status, 200);
    assert.deepEqual(rows(), [["t1", "completed"]]);
  });
});

describe("the turn ledger at boot", () => {
  it("marks a turn the previous process left running as unknown, once the new server is listening", async () => {
    const dataDir = tmpDir("ancilla-ledger-data-");
    const first = await rig({ dataDir });
    first.connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    first.connection.notify("turn/started", { sessionId: "s1", turnId: "t2" });
    first.connection.notify("turn/completed", { sessionId: "s1", turnId: "t2", terminal: "completed" });
    assert.deepEqual(first.rows(), [["t1", "running"], ["t2", "completed"]]);
    await first.server.close();

    const second = await start(new FakeConnection(), { dataDir });
    const store = (second.server as unknown as { store: StoreLike }).store;
    assert.deepEqual(store.listTurns("s1").map((t) => [t.id, t.status]), [["t1", "unknown"], ["t2", "completed"]]);
  });
});
