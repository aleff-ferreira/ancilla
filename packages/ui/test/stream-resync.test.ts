/**
 * What the app does when the event stream comes back after a drop: how hard it rereads, what it says about what
 * happened while it was away, and what it does with a listener that throws. Nothing here may send a prompt: every
 * path out of a lost stream only reads.
 */
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { AncillaClient } from "../src/client.js";
import { AncillaController, type Platform } from "../src/model/controller.js";
import { applyEvent, emptyFold } from "../src/model/fold.js";
import type { ThreadState } from "../src/model/store.js";
import type { AncillaEvent, ModelCatalog, ProjectView, SessionSummary, TranscriptLoad, ViewEvent } from "../src/types.js";

type Live = NonNullable<SessionSummary["live"]>;

function session(sessionId: string, live: Partial<Live> | null = null): SessionSummary {
  return {
    sessionId,
    cwd: "/work/app",
    title: `Thread ${sessionId}`,
    titleSource: "auto",
    turnCount: 3,
    modelId: "muse-spark-1.3",
    origin: "ancilla",
    archived: false,
    createdAt: "2026-09-11T00:00:00.000Z",
    activityAt: "2026-09-11T00:00:00.000Z",
    settled: false,
    settledAt: null,
    unsettledAt: null,
    sandboxDisabled: false,
    accountId: null,
    live: live === null ? null : { activeTurnId: null, turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null, goal: null, ...live },
  };
}

const running = (turnId = "t1"): Partial<Live> => ({ activeTurnId: turnId, turnStartedAt: "2026-09-11T00:00:00.000Z" });
const ended = (): Partial<Live> => ({ activeTurnId: null, lastTerminal: "completed" });

const PROJECT: ProjectView = { cwd: "/work/app", displayName: "app", pinned: false, activityAt: "2026-09-11T00:00:00.000Z", defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] };

const CATALOG: ModelCatalog = { models: [], source: null, providerId: "meta", profileId: "default", hostVersion: "1.4.7" };

/** A turn that is still running, as history shows it. */
const RUNNING_EVENTS: ViewEvent[] = [{ method: "turn/started", params: { turnId: "t1" } }];

class StreamClient {
  sessions: SessionSummary[] = [];
  listCalls = 0;
  reads: { sessionId: string; refresh: boolean }[] = [];
  sent: { sessionId: string; text: string }[] = [];
  events: ViewEvent[] = RUNNING_EVENTS;

  async listProjects() {
    return [PROJECT];
  }
  async listSessions() {
    this.listCalls += 1;
    return this.sessions;
  }
  async loadTranscript(sessionId: string, options?: { refresh?: boolean }): Promise<TranscriptLoad> {
    this.reads.push({ sessionId, refresh: options?.refresh === true });
    return {
      session: this.sessions.find((s) => s.sessionId === sessionId) ?? null,
      msp: null,
      events: this.events,
      truncated: false,
      pending: { approvals: [], userInputs: [] },
      readOnly: false,
      readOnlyReason: null,
    };
  }
  async listModelCatalog() {
    return CATALOG;
  }
  async listModels() {
    return [];
  }
  async sendTurn(sessionId: string, text: string) {
    this.sent.push({ sessionId, text });
    return { turnId: "t9", disposition: "started" };
  }
  subscribe() {
    return () => {};
  }
}

/** A client that fails loudly for anything the test did not script, so a stray call (a send above all) cannot pass unnoticed. */
function clientOf(fake: StreamClient): AncillaClient {
  return new Proxy(fake, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      return async () => {
        throw new Error(`the client was asked for ${String(property)}, which this test does not script`);
      };
    },
  }) as unknown as AncillaClient;
}

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

function rig(options: { routed?: string; threads?: string[]; focused?: boolean } = {}) {
  let clock = 5_000_000;
  const timers: Timer[] = [];
  const platform: Platform = {
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => "",
    writeHash: () => {},
    onHashChange: () => () => {},
    now: () => clock,
    schedule: (fn, ms) => {
      const timer: Timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as Timer).cancelled = true;
    },
    focused: () => options.focused === true,
  };
  const fake = new StreamClient();
  const ids = options.threads ?? ["s1"];
  fake.sessions = ids.map((id) => session(id, running()));
  const controller = new AncillaController(clientOf(fake), platform);
  const loaded = (): ThreadState => ({
    load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false,
    fold: applyEvent(emptyFold(), RUNNING_EVENTS[0] as ViewEvent), attachments: [], shellRuns: [], researchRuns: [], stalled: false,
  });
  controller.store.set((s) => ({
    ...s,
    boot: "ready",
    sessionsLoaded: true,
    projects: [PROJECT],
    sessions: Object.fromEntries(fake.sessions.map((x) => [x.sessionId, x])),
    threads: Object.fromEntries(ids.map((id) => [id, loaded()])),
    route: options.routed ? { kind: "thread", sessionId: options.routed } : s.route,
  }));
  const shown: { title: string; body: string; tag: string }[] = [];
  controller.attachNotifier({
    permission: async () => "granted",
    request: async () => "granted",
    show: async (note) => {
      shown.push(note);
    },
  });
  controller.setPrefs({ notifications: true });
  const emit = (event: AncillaEvent) => (controller as unknown as { onEvent(e: AncillaEvent): void }).onEvent(event);
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  };
  /** The stream dropped and came back. */
  const reconnect = async () => {
    emit({ type: "connection", state: "lost" });
    emit({ type: "hello", version: "x" });
    await settle();
  };
  /** Runs every wait still pending, and whatever those schedule in turn, once. */
  const fireAll = async () => {
    for (let round = 0; round < 5; round += 1) {
      const due = timers.filter((t) => !t.cancelled && !t.fired);
      if (due.length === 0) break;
      for (const timer of due) {
        timer.fired = true;
        timer.fn();
      }
      await settle();
    }
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  const state = () => controller.store.get();
  const watchdog = async () => {
    (controller as unknown as { checkStaleThreads(): void }).checkStaleThreads();
    await settle();
  };
  const quiet = (id: string, ago: number) => (controller as unknown as { appliedAt: Map<string, number> }).appliedAt.set(id, clock - ago);
  return { controller, fake, timers, shown, emit, settle, reconnect, fireAll, advance, state, watchdog, quiet };
}

afterEach(() => {
  mock.restoreAll();
});

describe("the stream comes back after a drop", () => {
  it("rereads the open thread and the lists at once, and nothing is sent", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3"] });
    await t.reconnect();
    assert.deepEqual(t.fake.reads.map((r) => r.sessionId), ["s1"], "only the open thread, first");
    assert.equal(t.fake.listCalls, 1);
    assert.deepEqual(t.fake.sent, [], "a reload never sends a prompt");
  });

  it("does not run the whole reload again for a stream that keeps dropping, but does not forget it either", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2"] });
    await t.reconnect();
    assert.equal(t.fake.reads.length, 1);
    assert.equal(t.fake.listCalls, 1);

    // Dropped and back again two seconds later, and again: a slow client cycling.
    t.advance(2_000);
    await t.reconnect();
    t.advance(2_000);
    await t.reconnect();
    assert.equal(t.fake.reads.length, 1, "no second reread inside the gap");
    assert.equal(t.fake.listCalls, 1);

    // The reload that was held back runs once, when the gap is over.
    t.advance(60_000);
    await t.fireAll();
    assert.equal(t.fake.reads.length, 2, "one trailing reread for the two reconnects");
    assert.equal(t.fake.listCalls, 2);
    assert.deepEqual(t.fake.sent, []);
  });

  it("goes straight away again once the gap has passed", async () => {
    const t = rig({ routed: "s1" });
    await t.reconnect();
    t.advance(10 * 60_000);
    await t.reconnect();
    assert.equal(t.fake.reads.length, 2);
    assert.equal(t.fake.listCalls, 2);
  });

  it("is not held for hours by a clock that was set back, and a later reconnect is not blocked either", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2"] });
    await t.reconnect();
    assert.equal(t.fake.reads.length, 1);

    // NTP stepped the clock back an hour, or the machine woke with a stale one.
    t.advance(-60 * 60_000);
    await t.reconnect();
    const waits = t.timers.filter((timer) => !timer.cancelled && !timer.fired).map((timer) => timer.ms);
    assert.ok(waits.every((ms) => ms <= 15_000), `a reread was put off for ${Math.max(...waits)} ms`);
    t.advance(15_000);
    await t.fireAll();
    assert.equal(t.fake.reads.length, 2, "it did run, within the gap");
    assert.equal(t.fake.listCalls, 2);

    // And once it has, the stream dropping again is still read again.
    t.advance(60_000);
    await t.reconnect();
    assert.equal(t.fake.reads.length, 3);
    assert.deepEqual(t.fake.sent, []);
  });

  it("still marks the other threads as last known the moment it is back, even when the reread waits", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2"] });
    await t.reconnect();
    t.controller.store.set((s) => ({ ...s, threads: { ...s.threads, s2: { ...(s.threads["s2"] as ThreadState), stale: false } } }));
    t.advance(1_000);
    await t.reconnect();
    assert.equal(t.state().threads["s2"]?.stale, true);
    assert.equal(t.state().connection, "open");
  });

  it("does not reread when the stream says hello without having been lost", async () => {
    const t = rig({ routed: "s1" });
    t.emit({ type: "hello", version: "x" });
    await t.settle();
    assert.equal(t.fake.reads.length, 0);
    assert.equal(t.fake.listCalls, 0);
  });
});

describe("the watchdog after a long sleep", () => {
  it("rereads a few busy threads per tick instead of all of them at once, the open one first", async () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const t = rig({ routed: "s5", threads: ids });
    // The laptop slept: every running turn looks quiet for much longer than the watchdog's patience.
    for (const id of ids) t.quiet(id, 300_000);

    await t.watchdog();
    const first = t.fake.reads.map((r) => r.sessionId);
    assert.equal(first[0], "s5", "the thread on screen goes first");
    assert.ok(first.length >= 1 && first.length <= 3, `${first.length} threads reread in one tick`);

    // Five more ticks is 75 s: less than a quiet turn is given, so a thread already read is not due again.
    for (let tick = 0; tick < 5; tick += 1) {
      t.advance(15_000);
      await t.watchdog();
    }
    const all = t.fake.reads.map((r) => r.sessionId);
    assert.deepEqual([...new Set(all)].sort(), [...ids].sort(), "every thread is reread within a few ticks");
    assert.equal(all.length, ids.length, "and each one once, since a reread resets its clock");
    assert.deepEqual(t.fake.sent, []);
  });
});

describe("what the app says about what happened while the stream was down", () => {
  const status = (fake: StreamClient, changes: Record<string, Partial<Live>>) => {
    fake.sessions = fake.sessions.map((s) => (changes[s.sessionId] ? session(s.sessionId, changes[s.sessionId]) : s));
  };

  /** Holds the list read back until the returned function is called, and answers it with whatever the server says then. */
  const hold = (fake: StreamClient): (() => void) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listed = fake.listSessions.bind(fake);
    fake.listSessions = async () => {
      await gate;
      return listed();
    };
    return release;
  };

  it("announces an approval and a question that arrived while it was away", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3"] });
    status(t.fake, { s2: { pendingApprovals: 1 }, s3: { pendingInputs: 1 } });
    await t.reconnect();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["approval:s2", "question:s3"]);
    assert.ok(t.shown.every((n) => /Thread s[23]/.test(n.body)));
  });

  it("announces one turn that ended while it was away by name", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2"] });
    status(t.fake, { s2: ended() });
    await t.reconnect();
    assert.deepEqual(t.shown.map((n) => n.tag), ["finished:s2"]);
    assert.match(t.shown[0]?.body ?? "", /Thread s2/);
  });

  it("gives one summary, not one note each, when several turns ended", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3", "s4", "s5"] });
    status(t.fake, { s1: ended(), s2: ended(), s3: { ...ended(), lastError: "boom" }, s4: ended() });
    await t.reconnect();
    assert.equal(t.shown.length, 1, `${t.shown.length} notifications for four ended turns`);
    assert.ok(!t.shown[0]?.tag.startsWith("finished:"), "not a per-thread note");
    assert.match(t.shown[0]?.body ?? "", /4/, "it says how many");
    assert.match(t.shown[0]?.body ?? "", /1/, "and that one failed");
  });

  it("summarises the turns that ended but still names each approval and question", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3", "s4"] });
    status(t.fake, { s1: ended(), s2: ended(), s3: { pendingApprovals: 1 } });
    await t.reconnect();
    const tags = t.shown.map((n) => n.tag).sort();
    assert.equal(tags.length, 2);
    assert.ok(tags.includes("approval:s3"));
    assert.ok(!tags.some((tag) => tag.startsWith("finished:")));
  });

  it("says nothing about threads whose state did not change, a request that was already waiting included", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3"] });
    // s2 was waiting on the user before the stream dropped, and still is; s3 simply carries on.
    const waiting = session("s2", { pendingApprovals: 1, pendingInputs: 1, goal: { status: "paused" } as never });
    t.controller.store.set((s) => ({ ...s, sessions: { ...s.sessions, s2: waiting } }));
    t.fake.sessions = t.fake.sessions.map((x) => (x.sessionId === "s2" ? waiting : x));
    await t.reconnect();
    assert.equal(t.state().sessions["s2"]?.live?.pendingApprovals, 1);
    assert.deepEqual(t.shown, []);
  });

  it("says nothing when notifications are off", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2"] });
    t.controller.setPrefs({ notifications: false });
    status(t.fake, { s2: { pendingApprovals: 1 } });
    await t.reconnect();
    assert.deepEqual(t.shown, []);
  });

  it("says nothing to a window that has the user's attention, which sees it all anyway", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2"], focused: true });
    status(t.fake, { s2: { pendingApprovals: 1 } });
    await t.reconnect();
    assert.deepEqual(t.shown, []);
    assert.equal(t.state().sessions["s2"]?.live?.pendingApprovals, 1, "the list did take it in");
  });

  it("does not say again in a summary what the live status already said once the stream was back", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3", "s4"] });
    await t.reconnect();
    // Dropped again inside the gap: the reread is held back, and the base for what it says is what is known now.
    t.advance(2_000);
    await t.reconnect();
    // Three turns end with the stream up, and each is heard as it happens.
    for (const id of ["s2", "s3", "s4"]) {
      t.emit({ type: "session-status", sessionId: id, live: session(id, ended()).live });
    }
    await t.settle();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["finished:s2", "finished:s3", "finished:s4"]);
    status(t.fake, { s2: ended(), s3: ended(), s4: ended() });
    t.advance(60_000);
    await t.fireAll();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["finished:s2", "finished:s3", "finished:s4"], "the reread adds nothing, in particular no summary");
  });

  it("does not say twice what the live status said while the list was being read", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3", "s4"] });
    const release = hold(t.fake);
    t.emit({ type: "connection", state: "lost" });
    t.emit({ type: "hello", version: "x" });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    // The read has started and has not answered; three turns end and are heard live in the meantime.
    for (const id of ["s2", "s3", "s4"]) {
      t.emit({ type: "session-status", sessionId: id, live: session(id, ended()).live });
    }
    status(t.fake, { s2: ended(), s3: ended(), s4: ended() });
    release();
    await t.settle();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["finished:s2", "finished:s3", "finished:s4"]);
  });

  it("does not say again, at the reread held back by a second drop, what the list read already said", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3"] });
    const release = hold(t.fake);
    await t.reconnect();
    // The stream drops and returns a second time while the first list read has not answered, so the reread that
    // follows is held back and its base was taken from what the app still showed before the first drop.
    t.advance(2_000);
    await t.reconnect();
    status(t.fake, { s2: { pendingApprovals: 1 }, s3: ended() });
    release();
    await t.settle();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["approval:s2", "finished:s3"], "said once, by the first read");
    // Long after the repeat window of the notifications themselves, so nothing but the base can hold it back.
    t.advance(30_000);
    await t.fireAll();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["approval:s2", "finished:s3"], "and not again by the held reread");
    assert.deepEqual(t.fake.sent, []);
  });

  it("still says what the held reread finds that the first list read did not", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3"] });
    const release = hold(t.fake);
    await t.reconnect();
    t.advance(2_000);
    await t.reconnect();
    status(t.fake, { s2: { pendingApprovals: 1 } });
    release();
    await t.settle();
    assert.deepEqual(t.shown.map((n) => n.tag), ["approval:s2"]);
    // Something that happened after the first read answered, while the stream was down for the second time.
    status(t.fake, { s2: { pendingApprovals: 1 }, s3: ended() });
    t.advance(30_000);
    await t.fireAll();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["approval:s2", "finished:s3"], "s3 is new, s2 is not repeated");
  });

  it("still says what the first reconnect owed, once, when its list read failed and a live status for another thread came before the next read", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3"] });
    const listed = t.fake.listSessions.bind(t.fake);
    let failures = 1;
    t.fake.listSessions = async () => {
      if (failures-- > 0) throw new Error("the list read failed");
      return listed();
    };
    // While the stream was down the open thread asked for an approval. Its own reread, which the failed list read
    // does not stop, takes that into the lists without saying a word: only the catch-up can announce it.
    status(t.fake, { s1: { ...running(), pendingApprovals: 1 } });
    await t.reconnect();
    assert.equal(failures, 0, "the first list read was the one that failed");
    assert.equal(t.state().sessions["s1"]?.live?.pendingApprovals, 1, "the thread read put the approval into the lists");
    assert.equal(t.shown.length, 0, "nothing was said by a read that failed");

    // Another thread's turn ends and is heard live; then the stream drops again and the list is read for good.
    t.emit({ type: "session-status", sessionId: "s3", live: session("s3", ended()).live });
    status(t.fake, { s3: ended() });
    await t.settle();
    assert.deepEqual(t.shown.map((n) => n.tag), ["finished:s3"]);
    t.advance(60_000);
    await t.reconnect();
    assert.equal(t.fake.listCalls, 1, "the second list read is the one that answered");
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["approval:s1", "finished:s3"], "the owed approval is said once, and s3 is not said again");
    assert.deepEqual(t.fake.sent, []);
  });

  it("still says what happened after a status that changed nothing", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2", "s3"] });
    // The server's answer is what the list read finds; the stream is back and says one thing, which is no news.
    const release = hold(t.fake);
    t.emit({ type: "connection", state: "lost" });
    t.emit({ type: "hello", version: "x" });
    t.emit({ type: "session-status", sessionId: "s2", live: session("s2", running()).live });
    status(t.fake, { s2: { ...running(), pendingApprovals: 1 }, s3: ended() });
    release();
    await t.settle();
    assert.deepEqual(t.shown.map((n) => n.tag).sort(), ["approval:s2", "finished:s3"]);
  });

  it("never repeats itself when a later status says the same thing", async () => {
    const t = rig({ routed: "s1", threads: ["s1", "s2"] });
    status(t.fake, { s2: { pendingApprovals: 1 } });
    await t.reconnect();
    assert.deepEqual(t.shown.map((n) => n.tag), ["approval:s2"]);
    t.emit({ type: "session-status", sessionId: "s2", live: session("s2", { pendingApprovals: 1 }).live });
    await t.settle();
    assert.equal(t.shown.length, 1, "the live status that follows is not a new request");
    assert.deepEqual(t.fake.sent, []);
  });
});

describe("a listener that throws", () => {
  type Deliver = (event: AncillaEvent) => void;

  /** A controller that is started, with the handler it gave the client to hear events through. */
  async function listening() {
    const t = rig({ routed: "s1" });
    let handler: Deliver | null = null;
    t.fake.subscribe = ((h: Deliver) => {
      handler = h;
      return () => {};
    }) as never;
    (t.fake as unknown as { probeEnvironment(): Promise<unknown> }).probeEnvironment = async () => ({
      platform: "win32", wslAvailable: false, defaultDistro: null, museFound: false, musePath: null, version: "0", persistent: true,
    });
    const stop = t.controller.start();
    await t.settle();
    assert.ok(handler, "the controller subscribed");
    const deliver: Deliver = (event) => (handler as unknown as Deliver)(event);
    return { t, deliver, stop };
  }

  it("is logged and shown once, and the next event still lands", async () => {
    const logged = mock.method(console, "error", () => undefined);
    const { t, deliver, stop } = await listening();
    const target = t.controller as unknown as { onEvent(e: AncillaEvent): void };
    const real = target.onEvent.bind(t.controller);
    let broken = true;
    target.onEvent = (event) => {
      if (broken) throw new Error("fold exploded");
      real(event);
    };
    const toastsBefore = t.state().toasts.length;
    for (let i = 0; i < 21; i += 1) {
      assert.doesNotThrow(() => deliver({ type: "sessions-changed" }));
    }
    assert.ok(logged.mock.calls.length >= 1, "logged to the console");
    assert.match(logged.mock.calls.map((call) => call.arguments.join(" ")).join("\n"), /fold exploded/);
    const toasts = t.state().toasts.slice(toastsBefore);
    assert.equal(toasts.length, 1, "one toast, not one per event");
    assert.equal(toasts[0]?.tone, "error");

    broken = false;
    deliver({ type: "connection", state: "lost" });
    assert.equal(t.state().connection, "lost", "the stream carries on");
    stop();
  });

  it("shows the error again once enough time has passed", async () => {
    mock.method(console, "error", () => undefined);
    const { t, deliver, stop } = await listening();
    (t.controller as unknown as { onEvent(e: AncillaEvent): void }).onEvent = () => {
      throw new Error("again");
    };
    const before = t.state().toasts.length;
    deliver({ type: "sessions-changed" });
    t.advance(10 * 60_000);
    deliver({ type: "sessions-changed" });
    assert.equal(t.state().toasts.length - before, 2);
    stop();
  });
});
