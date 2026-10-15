/**
 * What bounds a Muse host's life as Ancilla sees it: a start that never answers is given up on at a ceiling, the
 * handshake is closed on every failure and while a start is still open, and a connection that ends while the child
 * lives takes the child with it. The clock is a fake, so no test waits for a real deadline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as mspHost from "../src/mspHost.js";
import { AncillaMspHost, DEFAULT_CONNECTION_GRACE_MS, type ServeExit } from "../src/mspHost.js";

/** The typed error of a start that ran past its ceiling, recognised by name so a missing class fails the test, not the import. */
const isTimeout = (error: unknown): error is Error & { timeoutMs: number } => error instanceof Error && error.name === "HostStartTimeoutError";

type SpawnArg = ConstructorParameters<typeof AncillaMspHost>[1];
type HostOptions = ConstructorParameters<typeof AncillaMspHost>[3];

const TARGET = { command: "muse", args: ["serve"], cwd: "/tmp" };

/** Timers that move only when the test says so. */
class FakeTimers {
  now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; run: () => void }>();
  setTimeout(run: () => void, ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, run });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  get armed(): number {
    return this.pending.size;
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending]) {
      if (timer.at <= this.now && this.pending.delete(id)) {
        timer.run();
      }
    }
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A promise that must settle soon: a start that never gives up fails the test instead of ending the run's event loop. */
function soon<T>(work: Promise<T>, ms = 1500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("still pending after a fake-clock deadline had passed")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Lets every promise reaction already queued run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Rig {
  host: AncillaMspHost;
  timers: FakeTimers;
  /** Calls to the handshake's close, and to the connected session's close. */
  handshakeCloses: () => number;
  sessionCloses: () => number;
  spawned: () => number;
  /** Answers the handshake's `initialize`, once the test wants it answered. */
  answer: (extra?: Record<string, unknown>) => void;
  /** Ends the connection (the SDK's `closed` promise) without the process exiting. */
  endConnection: () => void;
  /** The process exits. */
  exitProcess: (exit: ServeExit) => void;
  exits: ServeExit[];
}

/**
 * A scripted `spawnMspConnection`: the handshake answers `initialize` when told, and neither close ever settles, as
 * with a child that ignores EOF and SIGTERM, so a test that awaited a close would hang rather than pass.
 */
function rig(options: HostOptions = {}, script: { initializeRejects?: Error; stderr?: string; brokenSession?: boolean } = {}): Rig {
  const timers = new FakeTimers();
  let handshakeCloses = 0;
  let sessionCloses = 0;
  let spawned = 0;
  const initialized = deferred<Record<string, unknown>>();
  const closed = deferred<void>();
  const exited = deferred<ServeExit>();
  const exits: ServeExit[] = [];
  const connection = { command: async () => ({}), onNotification: () => undefined, closed: closed.promise };
  const spawn = ((opts: { onStderr?: (chunk: string) => void }) => {
    spawned += 1;
    if (script.stderr) {
      opts.onStderr?.(script.stderr);
    }
    return {
      initialize: async () => {
        if (script.initializeRejects) {
          throw script.initializeRejects;
        }
        return initialized.promise;
      },
      close: () => {
        handshakeCloses += 1;
        return new Promise<ServeExit>(() => undefined);
      },
    };
  }) as unknown as SpawnArg;
  const host = new AncillaMspHost(TARGET, spawn, undefined, { timers, ...options });
  host.onExit((exit) => exits.push(exit));
  return {
    host,
    timers,
    handshakeCloses: () => handshakeCloses,
    sessionCloses: () => sessionCloses,
    spawned: () => spawned,
    answer: (extra = {}) => {
      const session: Record<string, unknown> = {
        initializeResult: { serverInfo: { name: "muse-test" } },
        fingerprintWarning: null,
        connection,
        exited: exited.promise,
        close: () => {
          sessionCloses += 1;
          return new Promise<ServeExit>(() => undefined);
        },
        ...extra,
      };
      if (script.brokenSession) {
        Object.defineProperty(session, "initializeResult", {
          get() {
            throw new Error("the initialize result is unreadable");
          },
        });
      }
      initialized.resolve(session);
    },
    endConnection: () => closed.resolve(),
    exitProcess: (exit) => exited.resolve(exit),
    exits,
  };
}

describe("the start ceiling", () => {
  it("defaults to five minutes", () => {
    assert.equal((mspHost as Record<string, unknown>)["DEFAULT_HOST_START_TIMEOUT_MS"], 300_000);
  });

  it("rejects at the ceiling with a typed error, and closes the handshake without waiting for it", async () => {
    const r = rig({ startTimeoutMs: 5000 });
    let outcome: unknown = "pending";
    void r.host.start("1.0.0").then(
      () => (outcome = "started"),
      (error) => (outcome = error),
    );
    await flush();
    r.timers.advance(4999);
    await flush();
    assert.equal(outcome, "pending", "one millisecond short of the ceiling");
    assert.equal(r.handshakeCloses(), 0);
    r.timers.advance(1);
    await flush();
    // The handshake's close never settles in this rig: a start that waited for it would still be pending here.
    assert.ok(isTimeout(outcome), `rejected with ${String(outcome)}`);
    assert.equal(outcome.timeoutMs, 5000);
    assert.match((outcome as Error).message, /5 s/);
    assert.equal(r.handshakeCloses(), 1, "the wedged child is closed, in the background");
    assert.equal(r.timers.armed, 0, "the ceiling timer is gone");
  });

  it("clears its timer once the host has started", async () => {
    const r = rig({ startTimeoutMs: 5000 });
    const started = r.host.start("1.0.0");
    await flush();
    assert.equal(r.timers.armed, 1);
    r.answer();
    await started;
    assert.equal(r.timers.armed, 0);
    r.timers.advance(10_000);
    await flush();
    assert.equal(r.handshakeCloses() + r.sessionCloses(), 0, "a host that answered in time is left alone");
  });

  it("arms nothing when the ceiling is 0", async () => {
    const r = rig({ startTimeoutMs: 0 });
    const started = r.host.start("1.0.0");
    await flush();
    assert.equal(r.timers.armed, 0);
    r.timers.advance(24 * 3600_000);
    await flush();
    r.answer();
    assert.deepEqual((await started).fingerprintWarning, null);
  });

  it("drops a start that answers after the ceiling: the host stays closed and nothing is reported", async () => {
    const r = rig({ startTimeoutMs: 1000 });
    const started = r.host.start("1.0.0");
    const settled = started.then(
      () => null,
      (error: unknown) => error,
    );
    await flush();
    r.timers.advance(1000);
    assert.ok(isTimeout(await soon(settled)));
    r.answer();
    await flush();
    assert.throws(() => r.host.connection, /start\(\)/);
    assert.deepEqual(r.exits, []);
    r.endConnection();
    await flush();
    r.timers.advance(60_000);
    await flush();
    assert.deepEqual(r.exits, [], "a host given up on does not announce its own end");
  });
});

describe("closing a host", () => {
  it("while its start is open aborts the start and closes the handshake", async () => {
    const r = rig({ startTimeoutMs: 5000 });
    const started = r.host.start("1.0.0");
    const settled = started.then(
      () => null,
      (error: unknown) => error,
    );
    await flush();
    // The handshake's close never settles, so this returns only because an abort does not wait for the child.
    const closing = r.host.close();
    const error = await soon(settled);
    assert.ok(error instanceof Error && /closed/i.test(error.message), `start rejected with ${String(error)}`);
    assert.ok(!isTimeout(error), "an abort is not a timeout");
    assert.equal(r.handshakeCloses(), 1);
    assert.equal(r.timers.armed, 0, "the ceiling timer is gone");
    // close() itself reports what the handshake close reports, which is a later matter.
    void closing.catch(() => undefined);
  });

  it("twice shares one close", async () => {
    const r = rig();
    void r.host.start("1.0.0").catch(() => undefined);
    await flush();
    void r.host.close().catch(() => undefined);
    void r.host.close().catch(() => undefined);
    await flush();
    assert.equal(r.handshakeCloses(), 1);
  });

  it("after a start that failed does not throw", async () => {
    const r = rig({}, { initializeRejects: new Error("no fingerprint") });
    await assert.rejects(() => r.host.start("1.0.0"), /no fingerprint/);
    void r.host.close().catch(() => undefined);
    await flush();
    assert.equal(r.handshakeCloses(), 1, "closed once, by the failure; the later close joins it");
  });

  it("before start still refuses, as the host always has", async () => {
    const r = rig();
    await assert.rejects(() => r.host.close(), /start\(\)/);
    assert.equal(r.spawned(), 0);
  });
});

describe("a start that fails", () => {
  it("closes the handshake when initialize rejects, and keeps the stderr tail in the error", async () => {
    const r = rig({}, { initializeRejects: new Error("the host went away"), stderr: "not logged in\n" });
    await assert.rejects(
      () => r.host.start("1.0.0"),
      (error: Error) => /the host went away/.test(error.message) && /not logged in/.test(error.message),
    );
    assert.equal(r.handshakeCloses(), 1);
    assert.equal(r.timers.armed, 0);
  });

  it("closes the session when a step after initialize throws", async () => {
    const r = rig({ startTimeoutMs: 5000 }, { brokenSession: true });
    const started = r.host.start("1.0.0");
    const settled = started.then(
      () => null,
      (error: unknown) => error,
    );
    await flush();
    r.answer();
    const error = await soon(settled);
    assert.ok(error instanceof Error && /unreadable/.test(error.message), `start rejected with ${String(error)}`);
    assert.equal(r.handshakeCloses() + r.sessionCloses(), 1, "the child that did answer is not left running");
    assert.equal(r.timers.armed, 0);
    assert.deepEqual(r.exits, []);
  });
});

describe("a connection that ends while the process lives", () => {
  async function started(options: HostOptions = {}): Promise<Rig> {
    const r = rig({ startTimeoutMs: 0, connectionGraceMs: 2000, ...options });
    const pending = r.host.start("1.0.0");
    await flush();
    r.answer();
    await pending;
    return r;
  }

  it("is reported as the host ending and the child is closed", async () => {
    const r = await started();
    r.endConnection();
    await flush();
    assert.deepEqual(r.exits, [], "the process gets its grace to report an exit of its own");
    r.timers.advance(2000);
    await flush();
    assert.deepEqual(r.exits, [{ code: null, signal: null, reason: "connection-ended" }]);
    assert.equal(r.sessionCloses(), 1, "the live child is closed, or every dead connection would leave a muse serve behind");
  });

  it("reports the real exit when the process goes with the connection, and closes nothing", async () => {
    const r = await started();
    r.endConnection();
    r.exitProcess({ code: 5, signal: null });
    await flush();
    assert.deepEqual(r.exits, [{ code: 5, signal: null }]);
    assert.equal(r.sessionCloses(), 0, "nothing is left to close");
    assert.equal(r.timers.armed, 0, "the grace timer is gone");
    r.timers.advance(10_000);
    await flush();
    assert.equal(r.exits.length, 1, "told once");
  });

  it("is nothing to report when this side closed the host", async () => {
    const r = await started();
    void r.host.close().catch(() => undefined);
    r.endConnection();
    await flush();
    r.timers.advance(10_000);
    await flush();
    assert.deepEqual(r.exits, []);
    assert.equal(r.sessionCloses(), 1, "closed once, by the close that was asked for");
  });

  it("waits the default grace to the millisecond when none is given", async () => {
    assert.equal(DEFAULT_CONNECTION_GRACE_MS, 2000);
    const r = rig({ startTimeoutMs: 0 });
    const pending = r.host.start("1.0.0");
    await flush();
    r.answer();
    await pending;
    r.endConnection();
    await flush();
    r.timers.advance(DEFAULT_CONNECTION_GRACE_MS - 1);
    await flush();
    assert.deepEqual(r.exits, [], "one millisecond short of the grace");
    assert.equal(r.sessionCloses(), 0);
    r.timers.advance(1);
    await flush();
    assert.deepEqual(r.exits, [{ code: null, signal: null, reason: "connection-ended" }]);
    assert.equal(r.sessionCloses(), 1);
  });
});

/** A host whose handshake answers at once with the given session fields, so a test can shape what `watch()` sees. */
async function startedHost(session: Record<string, unknown>, options: HostOptions = {}) {
  const timers = new FakeTimers();
  const closes = { session: 0 };
  const lines: string[] = [];
  const spawn = (() => ({
    initialize: async () => ({
      initializeResult: { serverInfo: { name: "muse-test" } },
      fingerprintWarning: null,
      connection: { command: async () => ({}), onNotification: () => undefined },
      close: () => {
        closes.session += 1;
        return new Promise<ServeExit>(() => undefined);
      },
      ...session,
    }),
    close: () => new Promise<ServeExit>(() => undefined),
  })) as unknown as SpawnArg;
  const host = new AncillaMspHost(TARGET, spawn, undefined, { timers, startTimeoutMs: 0, log: (line) => lines.push(line), ...options });
  await host.start("1.0.0");
  return { host, timers, closes, lines };
}

describe("an exit handler that throws", () => {
  const BOOM = new Error("handler boom");

  it("does not stop the child being closed, escape the grace timer, or skip the handlers after it", async () => {
    const connectionEnded = deferred<void>();
    const { host, timers, closes, lines } = await startedHost({
      connection: { command: async () => ({}), onNotification: () => undefined, closed: connectionEnded.promise },
    });
    const told: string[] = [];
    host.onExit(() => told.push("first"));
    host.onExit(() => {
      throw BOOM;
    });
    host.onExit(() => told.push("third"));
    connectionEnded.resolve();
    await flush();
    // The fake clock runs the timer inside this call, so a handler's throw that escaped it would surface here, where
    // a real timer would have made it an uncaught exception.
    assert.doesNotThrow(() => timers.advance(DEFAULT_CONNECTION_GRACE_MS));
    await flush();
    assert.equal(closes.session, 1, "the child is closed even though a handler threw");
    assert.deepEqual(told, ["first", "third"], "a handler that throws does not skip the ones after it");
    assert.equal(lines.length, 1, "the failure is logged once");
    assert.match(lines[0]!, /handler boom/);
  });

  it("does not become an unhandled rejection when the process itself exits", async () => {
    const exited = deferred<ServeExit>();
    const { host, lines } = await startedHost({ exited: exited.promise });
    const told: ServeExit[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      host.onExit(() => {
        throw BOOM;
      });
      host.onExit((exit) => told.push(exit));
      exited.resolve({ code: 3, signal: null });
      await flush();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
    assert.deepEqual(told, [{ code: 3, signal: null }]);
    assert.equal(lines.length, 1);
  });

  it("writes its line to stderr when no log is given", async () => {
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const exited = deferred<ServeExit>();
      const { host } = await startedHost({ exited: exited.promise }, { log: undefined });
      host.onExit(() => {
        throw BOOM;
      });
      exited.resolve({ code: 1, signal: null });
      await flush();
    } finally {
      process.stderr.write = original;
    }
    assert.ok(written.some((line) => /^\[ancilla\] \S+ .*handler boom/.test(line)), `stderr got: ${JSON.stringify(written)}`);
  });
});

describe("an exit that was settled before any handler was registered", () => {
  it("is replayed once to a handler registered later, and to each one after it", async () => {
    const { host } = await startedHost({ exited: Promise.resolve({ code: 5, signal: null }) });
    await flush();
    const first: ServeExit[] = [];
    host.onExit((exit) => first.push(exit));
    assert.deepEqual(first, [], "the replay is a microtask, not a call from inside onExit");
    await flush();
    assert.deepEqual(first, [{ code: 5, signal: null }]);
    const second: ServeExit[] = [];
    host.onExit((exit) => second.push(exit));
    await flush();
    assert.deepEqual(second, [{ code: 5, signal: null }]);
    assert.equal(first.length, 1, "told once, not again for a later handler");
  });

  it("tells a handler registered before it exactly once, with no second replay", async () => {
    const exited = deferred<ServeExit>();
    const { host } = await startedHost({ exited: exited.promise });
    const told: ServeExit[] = [];
    host.onExit((exit) => told.push(exit));
    exited.resolve({ code: 2, signal: null });
    await flush();
    await flush();
    assert.deepEqual(told, [{ code: 2, signal: null }]);
  });

  it("tells a handler registered from inside another handler once, not once for the loop and once for the replay", async () => {
    const exited = deferred<ServeExit>();
    const { host } = await startedHost({ exited: exited.promise });
    const late: ServeExit[] = [];
    host.onExit(() => host.onExit((exit) => late.push(exit)));
    exited.resolve({ code: 4, signal: null });
    await flush();
    assert.deepEqual(late, [{ code: 4, signal: null }]);
  });

  it("still closes a live child whose connection ended with nobody listening, and tells a handler that comes later", async () => {
    const connectionEnded = deferred<void>();
    const { host, timers, closes } = await startedHost({
      connection: { command: async () => ({}), onNotification: () => undefined, closed: connectionEnded.promise },
    });
    connectionEnded.resolve();
    await flush();
    timers.advance(DEFAULT_CONNECTION_GRACE_MS);
    await flush();
    assert.equal(closes.session, 1, "the connection-ended fallback ran with no handler to hear it");
    const told: ServeExit[] = [];
    host.onExit((exit) => told.push(exit));
    await flush();
    assert.deepEqual(told, [{ code: null, signal: null, reason: "connection-ended" }]);
  });

  it("is not replayed for a host this side closed", async () => {
    const exited = deferred<ServeExit>();
    const { host } = await startedHost({ exited: exited.promise });
    void host.close().catch(() => undefined);
    exited.resolve({ code: 0, signal: null });
    await flush();
    const told: ServeExit[] = [];
    host.onExit((exit) => told.push(exit));
    await flush();
    assert.deepEqual(told, [], "our own close is not an exit");
  });
});
