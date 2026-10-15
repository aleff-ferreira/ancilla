/**
 * The server's side of a bounded host layer: a start that never answers is a 504 and frees its key, a flip or a
 * shutdown does not wait on one, a start that answers after it was given up on is closed and never registered, a host
 * whose connection ended while its process lived is forgotten and closed, and a host going away ends the research
 * turns on it at once. Hosts here are scripted; nothing starts a real Muse.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AncillaMspHost, DEFAULT_RESEARCH_CONFIG, type ResearchRunState, type ServeTarget, type WorkerBudgets, type WorkerResult, type WorkerTask } from "@ancilla/daemon";
import type { ResearchEngine } from "../src/research/index.js";
import type { HostHandle } from "../src/server.js";
import { FakeConnection, fakeFactory, get, send, start, waitFor, type FactoryProbe } from "./harness.js";
import { sleep } from "./research-rigs.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The outcome of a promise that must not stay pending: null when it did not settle within `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([work, sleep(ms).then(() => null)]);
}

interface MadeHost {
  target: ServeTarget;
  closes: number;
  /** Lets a wedged start answer. */
  open: () => void;
  startCalled: Promise<void>;
}

/**
 * Hosts whose start waits for the test when `wedged(target)` says so; every close is counted and answers at once,
 * or never with `closeNever`, as a child that ignores its end of input and SIGTERM does.
 */
function scriptedHosts(connection: FakeConnection, wedged: (target: ServeTarget) => boolean, options: { closeNever?: boolean } = {}) {
  const made: MadeHost[] = [];
  const closeGate = deferred();
  const factory = (target: ServeTarget): HostHandle => {
    const gate = deferred();
    const called = deferred();
    const record: MadeHost = { target, closes: 0, open: () => gate.resolve(), startCalled: called.promise };
    made.push(record);
    const stalls = wedged(target);
    return {
      start: async () => {
        called.resolve();
        if (stalls) {
          await gate.promise;
        }
        return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
      },
      connection: connection as never,
      close: async () => {
        record.closes += 1;
        if (options.closeNever) {
          await closeGate.promise;
        }
        return { code: 0, signal: null };
      },
      onExit: () => undefined,
    };
  };
  return {
    factory,
    made,
    ofCwd: (cwd: string) => made.find((host) => host.target.cwd === cwd),
    /** Lets every close that `closeNever` holds finish, so a failing test does not leave its server unable to close. */
    releaseCloses: () => closeGate.resolve(),
  };
}

function numberedSessions(connection: FakeConnection, prefix = "s"): void {
  let count = 0;
  connection.replies.set("session/start", () => ({ session: { sessionId: `${prefix}${(count += 1)}` } }));
}

describe("a flip while one workspace's host is wedged", () => {
  it("does not hold up another workspace, and the wedged start that answers late is closed, not registered", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const hosts = scriptedHosts(connection, (target) => target.cwd.endsWith("wedged"));
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 100, closeMs: 100 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);

    const wedgedRequest = send(base, "/api/sessions", { cwd: "/work/wedged" });
    await waitFor(() => hosts.ofCwd("/work/wedged") !== undefined, "the wedged host to be created");
    await hosts.ofCwd("/work/wedged")!.startCalled;
    assert.equal((await send(base, "/api/yolo-settings", { enabled: true }, "PATCH")).status, 200);

    // The restart behind the flip waits for the wedged start, but not for ever: another workspace is served after it.
    const other = await within(send(base, "/api/sessions", { cwd: "/work/other" }), 5000);
    assert.notEqual(other, null, "a wedged start held up every workspace after a flip");
    assert.equal(other?.status, 200);

    const key = server["hostKey"]("/work/wedged", null);
    assert.equal(server["starting"].has(key), false, "the start that was given up on no longer holds its key");
    const wedged = hosts.ofCwd("/work/wedged")!;
    assert.equal(wedged.closes, 1, "the start given up on is closed, not left to finish");
    wedged.open();
    await sleep(50);
    assert.equal(server["hosts"].has(key), false, "a start that answered late was registered as a host");
    assert.equal(wedged.closes >= 1, true);
    const answered = await within(wedgedRequest, 5000);
    assert.equal(answered?.status, 503, "the request that waited on the start is told the host was restarted under it");
  });
});

describe("a start that a flip gave up on", () => {
  it("never spawns a host when the flip came while the serve target was still being worked out", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const hosts = scriptedHosts(connection, () => false);
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 50, closeMs: 100 } });
    const entered = deferred();
    const release = deferred();
    const original = server["serveTargetFor"].bind(server);
    server["serveTargetFor"] = async (cwd, accountId) => {
      entered.resolve();
      await release.promise;
      return original(cwd, accountId);
    };

    const request = send(base, "/api/sessions", { cwd: "/work/flip" });
    await entered.promise;
    const token = server["startTokens"].get(server["hostKey"]("/work/flip", null));
    assert.ok(token, "the start is open");
    assert.equal((await send(base, "/api/yolo-settings", { enabled: true }, "PATCH")).status, 200);
    await waitFor(() => token.abandoned, "the flip to give up on the start");

    release.resolve();
    const answered = await within(request, 5000);
    assert.equal(answered?.status, 503, "the start is told the host was restarted under it");
    assert.equal(hosts.made.length, 0, "a host was spawned for a start nobody wanted any more");
    assert.equal(server["hosts"].size, 0);
  });

  it("leaves a newer start of the same workspace in place when the abandoned one answers late", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const hosts = scriptedHosts(connection, () => true);
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 50, closeMs: 100 } });
    const key = server["hostKey"]("/work/p", null);

    const first = send(base, "/api/sessions", { cwd: "/work/p" });
    await waitFor(() => hosts.made.length === 1, "the first host to be created");
    await hosts.made[0]!.startCalled;
    assert.equal((await send(base, "/api/yolo-settings", { enabled: true }, "PATCH")).status, 200);
    await waitFor(() => server["starting"].size === 0, "the flip to give up on the first start");

    const second = send(base, "/api/sessions", { cwd: "/work/p" });
    await waitFor(() => hosts.made.length === 2, "the second host to be created");
    await hosts.made[1]!.startCalled;
    const newerStart = server["starting"].get(key);
    const newerToken = server["startTokens"].get(key);
    assert.ok(newerStart && newerToken, "the second start is open");

    hosts.made[0]!.open();
    assert.equal((await within(first, 5000))?.status, 503, "the abandoned start is refused");
    assert.equal(server["starting"].get(key), newerStart, "the abandoned start's end took the newer start's entry with it");
    assert.equal(server["startTokens"].get(key), newerToken, "and its token");
    assert.equal(server["hosts"].size, 0, "the late answer registered a host");
    assert.equal(hosts.made[0]!.closes, 1, "the abandoned host is closed once");
    assert.equal(hosts.made[1]!.closes, 0, "the newer one is left alone");

    hosts.made[1]!.open();
    assert.equal((await within(second, 5000))?.status, 200);
    assert.equal(server["hosts"].size, 1, "exactly one host is registered");
    assert.ok(server["hosts"].get(key), "and it is the newer start's");
    assert.equal(hosts.made.length, 2, "no third host was started");
    assert.equal(hosts.made[0]!.closes, 1);
    assert.equal(hosts.made[1]!.closes, 0);
    assert.equal(server["starting"].size, 0);
    assert.equal(server["startTokens"].size, 0);
  });
});

describe("a host that never finishes closing", () => {
  it("does not hold a restart longer than the per-host close limit", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const hosts = scriptedHosts(connection, () => false, { closeNever: true });
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 100, closeMs: 100 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/a" })).status, 200);
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/b" })).status, 200);
    assert.equal(server["hosts"].size, 2);

    try {
      const restarted = await within(server["restartHosts"](), 5000);
      assert.notEqual(restarted, null, "a restart waited for a close that never ends");
      assert.equal(server["hosts"].size, 0, "the hosts are dropped all the same");
      assert.deepEqual(hosts.made.map((host) => host.closes), [1, 1]);

      // The next use starts a host of its own.
      assert.equal((await send(base, "/api/sessions", { cwd: "/work/a" })).status, 200);
      assert.equal(hosts.made.length, 3);
    } finally {
      hosts.releaseCloses();
    }
  });

  it("does not hold the shutdown longer than the per-host close limit", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const hosts = scriptedHosts(connection, () => false, { closeNever: true });
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 100, closeMs: 100 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/a" })).status, 200);

    try {
      const closed = await within(server.close(), 5000);
      assert.notEqual(closed, null, "close() waited for a host that never finishes closing");
      assert.equal(hosts.made[0]!.closes, 1);
      assert.equal(server["hosts"].size, 0);
    } finally {
      hosts.releaseCloses();
    }
  });
});

describe("a host whose process had already exited when it was registered", () => {
  it("is forgotten like any other host that exits, not left registered for good", async () => {
    const connection = new FakeConnection();
    let spawns = 0;
    // The SDK's `exited` promise is settled before the server has registered anything on the host.
    const exited = Promise.resolve({ code: 5, signal: null });
    const spawn = (() => {
      spawns += 1;
      return {
        initialize: async () => ({
          initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } },
          fingerprintWarning: null,
          connection,
          exited,
          close: async () => ({ code: 5, signal: null }),
        }),
        close: async () => ({ code: 5, signal: null }),
      };
    }) as unknown as ConstructorParameters<typeof AncillaMspHost>[1];
    const { server } = await start(connection, {
      hostFactory: (target) => new AncillaMspHost(target, spawn, undefined, { startTimeoutMs: 0 }),
    });

    await server["hostFor"]("/work/z");
    await waitFor(() => server["hosts"].size === 0, "the dead host to be forgotten", 2000);
    assert.equal(server["hostExits"], 1, "its exit is counted once");
    assert.match(server["lastHostError"] ?? "", /exited \(5\)/);

    await server["hostFor"]("/work/z");
    assert.equal(spawns, 2, "the next use starts a host instead of reusing a dead one");
  });
});

describe("closing the server", () => {
  it("is not held by a wedged start or a title worker waiting on one", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const hosts = scriptedHosts(connection, (target) => target.cwd !== "/work/ok");
    const { server, base } = await start(connection, { hostFactory: hosts.factory, hostWaits: { startsMs: 100, closeMs: 100 } });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/ok" })).status, 200);

    // A thread being opened on a host that never comes up, and a title that needs the listing host, which does not either.
    // Closing the server ends the connection of a request still waiting, so that request may fail rather than answer.
    const wedgedRequest = send(base, "/api/sessions", { cwd: "/work/wedged" }).then((reply) => reply.status, () => -1);
    const project = server["store"].upsertProject("/work/ok");
    server["store"].recordSession({ id: "untitled", projectId: project.id, origin: "tui", title: "New thread", titleSource: "placeholder" });
    server["queueTitle"]("untitled");
    await waitFor(() => hosts.made.filter((host) => host.target.cwd !== "/work/ok").length === 2, "both wedged hosts to be asked to start");
    assert.ok(server["titleWorker"], "the title worker is waiting on its host");

    const closed = await within(server.close(), 5000);
    assert.notEqual(closed, null, "close() waited on a start that never answers");
    assert.equal(hosts.ofCwd("/work/ok")!.closes, 1, "the running host is closed");
    for (const host of hosts.made.filter((made) => made.target.cwd !== "/work/ok")) {
      assert.equal(host.closes >= 1, true, `the wedged host for ${host.target.cwd} is closed too`);
    }
    hosts.made.forEach((host) => host.open());
    const answered = await within(wedgedRequest, 5000);
    assert.notEqual(answered, null, "the request that waited on the start never ended");
    for (const key of ["hosts", "starting"] as const) {
      assert.equal(server[key].size, 0, `${key} is empty after close()`);
    }
  });
});

describe("a host that never answers its start", () => {
  /** A scripted SDK handshake: with `wedgeFirst` the first start never answers, later ones do. `connection.closed` ends on demand. */
  function sdkLikeSpawn(connection: FakeConnection, wedgeFirst: boolean) {
    const state = { spawns: 0, handshakeCloses: 0, sessionCloses: 0, ended: deferred(), exited: deferred<{ code: number | null; signal: string | null }>() };
    const spawn = (() => {
      state.spawns += 1;
      // Each host has a connection of its own, so ending one does not end the next.
      state.ended = deferred();
      (connection as unknown as { closed: Promise<void> }).closed = state.ended.promise;
      const wedged = wedgeFirst && state.spawns === 1;
      return {
        initialize: async () => {
          if (wedged) {
            return new Promise(() => undefined);
          }
          return {
            initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } },
            fingerprintWarning: null,
            connection,
            exited: state.exited.promise,
            close: async () => {
              state.sessionCloses += 1;
              return { code: null, signal: "SIGTERM" };
            },
          };
        },
        close: async () => {
          state.handshakeCloses += 1;
          return { code: null, signal: "SIGKILL" };
        },
      };
    }) as unknown as ConstructorParameters<typeof AncillaMspHost>[1];
    return { state, spawn };
  }

  it("answers 504 at the ceiling, frees its key, and lets the next request start a host straight away", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const { state, spawn } = sdkLikeSpawn(connection, true);
    const { server, base } = await start(connection, {
      hostFactory: (target) => new AncillaMspHost(target, spawn, undefined, { startTimeoutMs: 80 }),
    });
    const first = await within(send(base, "/api/sessions", { cwd: "/work/p" }), 5000);
    assert.notEqual(first, null, "the start never gave up");
    assert.equal(first?.status, 504);
    assert.match(first?.json.error, /did not finish starting/);
    assert.match(first?.json.error, /ANCILLA_HOST_START_TIMEOUT_MS/, "the answer names the setting that moves the limit");
    assert.equal(server["starting"].size, 0);
    await waitFor(() => state.handshakeCloses === 1, "the wedged child to be closed");

    // No cooldown: the engine's immediate retry is a real attempt, not a refusal remembered from the first.
    const retry = await within(send(base, "/api/sessions", { cwd: "/work/p" }), 5000);
    assert.equal(retry?.status, 200);
    assert.equal(state.spawns, 2);
  });

  it("is forgotten and closed when its connection ends while its process lives", async () => {
    const connection = new FakeConnection();
    numberedSessions(connection);
    const { state, spawn } = sdkLikeSpawn(connection, false);
    const { server, base } = await start(connection, {
      hostFactory: (target) => new AncillaMspHost(target, spawn, undefined, { startTimeoutMs: 0, connectionGraceMs: 20 }),
    });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/p" })).status, 200);
    assert.equal(server["hosts"].size, 1);
    const seen: string[] = [];
    server["emit"] = ((type: string, data: { state?: string }) => void seen.push(`${type}:${data.state ?? ""}`)) as never;

    state.ended.resolve();
    await waitFor(() => server["hosts"].size === 0, "the host to be forgotten");
    assert.equal(state.sessionCloses, 1, "the child of a dead connection is closed, not left running");
    assert.ok(seen.includes("ancilla:exited"), "the exit is announced");
    assert.match(server["lastHostError"] ?? "", /connection/i);

    assert.equal((await send(base, "/api/sessions", { cwd: "/work/p" })).status, 200, "the next use starts a new host");
    assert.equal(state.spawns, 2);
  });
});

/* ---- research turns on a host that goes away ---- */

function stateFor(runId: string, question: string): ResearchRunState {
  return {
    version: 1,
    runId,
    eventSeq: 0,
    question,
    config: DEFAULT_RESEARCH_CONFIG,
    phase: "researching",
    brief: "A brief",
    inputLanguage: "en",
    targetLanguage: "en",
    draft: null,
    rounds: [],
    registry: [],
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z",
    nextAgentId: 1,
  };
}

const BUDGETS: WorkerBudgets = { maxToolCalls: 25, maxSearches: 3, maxReads: 10, maxSaves: 10, wallTimeMs: 600_000 };
const noSink = { onToolCall: () => undefined, onProgress: () => undefined };
const task = (runId: string): WorkerTask => ({ runId, round: 1, agentId: 1, topic: "topic", discovery: false, instructions: "go", maxReads: null });

/** A thread with a research run whose one worker turn is accepted and then never ends on its own. */
async function runWithHangingWorker() {
  const connection = new FakeConnection();
  const probe: FactoryProbe = { targets: [], exits: [] };
  const results: WorkerResult[] = [];
  const engine: ResearchEngine = async (input, _config, deps, signal) => {
    results.push(await deps.worker.run(task(input.runId), BUDGETS, signal, noSink));
    return { status: "completed", report: null, state: stateFor(input.runId, input.question), failure: null };
  };
  let sessions = 0;
  connection.replies.set("session/start", () => ({ session: { sessionId: sessions++ === 0 ? "s1" : "w1" } }));
  connection.replies.set("turn/start", () => ({ turnId: "wt1", status: "accepted" }));
  const started = await start(connection, { researchEngine: engine, hostFactory: fakeFactory(connection, probe), researchStartupMs: 60_000 });
  assert.equal((await send(started.base, "/api/sessions", { cwd: "/work/p" })).status, 200);
  const run = await send(started.base, "/api/research", { commandId: "cmd-hang", sessionId: "s1", question: "q" });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  await waitFor(() => connection.of("turn/start").length === 1, "the worker's turn to start");
  return { ...started, connection, probe, results, runId: run.json.run.runId as string };
}

describe("a host that goes away under a research turn", () => {
  it("ends the turn at once, not at its wall time", async () => {
    const { connection, probe, results } = await runWithHangingWorker();
    assert.equal(results.length, 0);
    probe.exits[0]!({ code: 1, signal: null });
    await waitFor(() => results.length === 1, "the worker to end", 3000);
    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.error ?? "", /^unavailable: .*session closed/);
    assert.equal(connection.of("turn/cancel").length, 0, "nothing is sent to a host that is gone");
  });

  it("ends it too when a flip restarts the hosts", async () => {
    const { base, results } = await runWithHangingWorker();
    assert.equal((await send(base, "/api/sandbox-settings", { disabled: true }, "PATCH")).status, 200);
    await waitFor(() => results.length === 1, "the worker to end", 3000);
    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.error ?? "", /session closed/);
  });

  it("is told once: a real session/closed before or after the synthetic one changes nothing", async () => {
    const { connection, probe, results, base, runId } = await runWithHangingWorker();
    // The host's own graceful shutdown reports the close first, as real Muse does.
    connection.notify("session/closed", { sessionId: "w1", reason: "hostShutdown" });
    await waitFor(() => results.length === 1, "the real close to end the worker", 3000);
    probe.exits[0]!({ code: 0, signal: null });
    connection.notify("session/closed", { sessionId: "w1", reason: "hostShutdown" });
    await sleep(60);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, "failed");
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "the run to finish", 3000);
  });

  it("tells the listeners after the live state is updated, and a listener that throws does not stop the others", async () => {
    const connection = new FakeConnection();
    const probe: FactoryProbe = { targets: [], exits: [] };
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { server, base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });
    assert.equal((await send(base, "/api/sessions", { cwd: "/work/p" })).status, 200);
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });
    await waitFor(() => server["live"].get("s1")?.activeTurnId === "t1", "the turn to show as running");

    const seen: { method: string; activeTurnId: string | null | undefined; lastTerminal: string | null | undefined }[] = [];
    const quiet = server["onSessionNotification"]("s1", (method: string) => {
      const live = server["live"].get("s1");
      seen.push({ method, activeTurnId: live?.activeTurnId, lastTerminal: live?.lastTerminal });
    });
    const throwing = server["onSessionNotification"]("s1", () => {
      throw new Error("a listener that fails");
    });
    probe.exits[0]!({ code: 1, signal: null });
    assert.equal(server["hosts"].size, 0, "the host is forgotten even though a listener threw");
    assert.deepEqual(seen, [{ method: "session/closed", activeTurnId: null, lastTerminal: "failed" }]);
    quiet();
    throwing();
  });
});

describe("the host the server makes by itself", () => {
  it("writes its own lines to the server's log, not to a writer of its own", async () => {
    // No factory is given, so the server's default one makes the host; nothing is started.
    const { server } = await start(new FakeConnection(), { hostFactory: undefined });
    const logs: string[] = [];
    server["log"] = (line: string) => void logs.push(line);
    const host = server["options"].hostFactory({ command: "muse", args: [], cwd: "/work/p" });
    host.onExit?.(() => {
      throw new Error("handler boom");
    });
    (host as unknown as { notifyExit(exit: { code: number | null; signal: string | null }): void }).notifyExit({ code: 1, signal: null });
    assert.deepEqual(logs, ["the Muse host's exit handler threw: handler boom"]);
  });
});
