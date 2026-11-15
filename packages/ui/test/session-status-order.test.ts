/**
 * A session's live status as the stream reports it is newer than a list or a transcript read that was issued before
 * the stream said it: such an answer may describe the session as it was, and must not put a turn that ended back
 * into running. A read issued after the stream spoke, and a session the stream said nothing about, are believed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AncillaClient } from "../src/client.js";
import { AncillaController, type Platform } from "../src/model/controller.js";
import { emptyFold } from "../src/model/fold.js";
import type { ThreadState } from "../src/model/store.js";
import type { AncillaEvent, ModelCatalog, ProjectView, SessionSummary, TranscriptLoad } from "../src/types.js";

type Live = NonNullable<SessionSummary["live"]>;

const PROJECT: ProjectView = { cwd: "/work/app", displayName: "app", pinned: false, activityAt: "2026-09-11T00:00:00.000Z", defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] };
const CATALOG: ModelCatalog = { models: [], source: null, providerId: "meta", profileId: "default", hostVersion: "1.4.7" };

function live(over: Partial<Live> = {}): Live {
  return { activeTurnId: null, turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null, goal: null, ...over };
}
const running = (turnId = "t1"): Live => live({ activeTurnId: turnId, turnStartedAt: "2026-09-11T00:00:00.000Z" });
const finished = (): Live => live({ lastTerminal: "completed" });

function session(sessionId: string, status: Live | null): SessionSummary {
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
    live: status,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class Client {
  /** What the next list answers; a function lets a test hold the answer back. */
  list: () => Promise<SessionSummary[]> = async () => [];
  transcript: (sessionId: string) => Promise<TranscriptLoad> = async () => ({ session: null, msp: null, events: [], truncated: false, pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null });
  sent: string[] = [];
  async listProjects() {
    return [PROJECT];
  }
  async listSessions() {
    return this.list();
  }
  async loadTranscript(sessionId: string) {
    return this.transcript(sessionId);
  }
  async listModelCatalog() {
    return CATALOG;
  }
  async listModels() {
    return [];
  }
  async sendTurn(_sessionId: string, text: string) {
    this.sent.push(text);
    return { turnId: "t9", disposition: "started" };
  }
  assetUrl(path: string) {
    return path;
  }
  subscribe() {
    return () => {};
  }
}

function rig(statuses: Record<string, Live | null>, routed?: string) {
  const fake = new Client();
  const client = new Proxy(fake, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      return async () => {
        throw new Error(`the client was asked for ${String(property)}, which this test does not script`);
      };
    },
  }) as unknown as AncillaClient;
  const platform: Platform = {
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => "",
    writeHash: () => {},
    onHashChange: () => () => {},
    now: () => 5_000_000,
    schedule: () => ({}),
    cancel: () => {},
    focused: () => false,
  };
  const controller = new AncillaController(client, platform);
  const ids = Object.keys(statuses);
  const thread = (): ThreadState => ({ load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(), attachments: [], shellRuns: [], researchRuns: [], stalled: false });
  controller.store.set((s) => ({
    ...s,
    boot: "ready",
    sessionsLoaded: true,
    projects: [PROJECT],
    sessions: Object.fromEntries(ids.map((id) => [id, session(id, statuses[id] ?? null)])),
    threads: Object.fromEntries(ids.map((id) => [id, thread()])),
    route: routed ? { kind: "thread", sessionId: routed } : s.route,
  }));
  const emit = (event: AncillaEvent) => (controller as unknown as { onEvent(e: AncillaEvent): void }).onEvent(event);
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  };
  const liveOf = (id: string) => controller.store.get().sessions[id]?.live ?? null;
  return { controller, fake, emit, settle, liveOf };
}

describe("an older session list", () => {
  it("does not put a finished turn back into running", async () => {
    const t = rig({ s1: running() });
    const gate = deferred<SessionSummary[]>();
    t.fake.list = () => gate.promise;
    const reading = t.controller.refresh();
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    assert.equal(t.liveOf("s1")?.activeTurnId, null);
    gate.resolve([session("s1", running())]);
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, null, "the list was asked before the turn ended");
    assert.equal(t.liveOf("s1")?.lastTerminal, "completed");
    assert.deepEqual(t.fake.sent, []);
  });

  it("is believed for every session the stream said nothing about while it was out, and for a session it did not know", async () => {
    const t = rig({ s1: running(), s2: null });
    const gate = deferred<SessionSummary[]>();
    t.fake.list = () => gate.promise;
    const reading = t.controller.refresh();
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    gate.resolve([session("s1", running()), session("s2", running("t2")), session("s3", running("t3"))]);
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, null);
    assert.equal(t.liveOf("s2")?.activeTurnId, "t2", "a session whose status never moved takes the list's");
    assert.equal(t.liveOf("s3")?.activeTurnId, "t3", "and one that only the list knows");
  });

  it("takes everything else about a session from the list, whatever the stream said of its status", async () => {
    const t = rig({ s1: running() });
    const gate = deferred<SessionSummary[]>();
    t.fake.list = () => gate.promise;
    const reading = t.controller.refresh();
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    gate.resolve([{ ...session("s1", running()), title: "Renamed meanwhile", turnCount: 4 }]);
    await reading;
    const known = t.controller.store.get().sessions["s1"];
    assert.equal(known?.title, "Renamed meanwhile");
    assert.equal(known?.turnCount, 4);
    assert.equal(known?.live?.activeTurnId, null);
  });

  it("still tells what only it knows about a turn the stream also has running (regression guard)", async () => {
    const t = rig({ s1: running() });
    const gate = deferred<SessionSummary[]>();
    t.fake.list = () => gate.promise;
    const reading = t.controller.refresh();
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: running() });
    gate.resolve([session("s1", { ...running(), pendingApprovals: 1 })]);
    await reading;
    assert.equal(t.liveOf("s1")?.pendingApprovals, 1, "an approval the stream has not told of yet is not thrown away");
  });

  it("is believed again once it is asked for after the stream spoke", async () => {
    const t = rig({ s1: running() });
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    t.fake.list = async () => [session("s1", running("t2"))];
    await t.controller.refresh();
    assert.equal(t.liveOf("s1")?.activeTurnId, "t2", "a turn that began after it ended is a newer fact than the ending");
  });
});

describe("an older list that says the session is idle", () => {
  it("does not take a turn the stream began after the list was asked for", async () => {
    const t = rig({ s1: null });
    const gate = deferred<SessionSummary[]>();
    t.fake.list = () => gate.promise;
    const reading = t.controller.refresh();
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: running("t2") });
    assert.equal(t.liveOf("s1")?.activeTurnId, "t2");
    gate.resolve([session("s1", null)]);
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, "t2", "the list was asked before the turn began");
    assert.deepEqual(t.fake.sent, []);
  });

  it("does not take a finished turn's idle for the turn the stream says is running now", async () => {
    const t = rig({ s1: running("t1") });
    const gate = deferred<SessionSummary[]>();
    t.fake.list = () => gate.promise;
    const reading = t.controller.refresh();
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    t.emit({ type: "session-status", sessionId: "s1", live: running("t2") });
    gate.resolve([session("s1", finished())]);
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, "t2");
  });

  it("is believed when the stream also says idle, with what only it knows about the ending", async () => {
    const t = rig({ s1: running() });
    const gate = deferred<SessionSummary[]>();
    t.fake.list = () => gate.promise;
    const reading = t.controller.refresh();
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    gate.resolve([session("s1", live({ lastTerminal: "failed", lastError: "boom" }))]);
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, null);
    assert.equal(t.liveOf("s1")?.lastError, "boom", "no turn is in question, so the list's account of the ending stands (regression guard)");
  });

  it("is believed when it is asked for after the stream said running (regression guard)", async () => {
    const t = rig({ s1: null });
    t.emit({ type: "session-status", sessionId: "s1", live: running("t2") });
    t.fake.list = async () => [session("s1", finished())];
    await t.controller.refresh();
    assert.equal(t.liveOf("s1")?.activeTurnId, null, "the turn ended after the stream last said so");
  });

  it("lets go of what it counted for a session that left the list", async () => {
    const t = rig({ s1: running(), s2: null });
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    const heard = () => (t.controller as unknown as { statusHeard: Map<string, number> }).statusHeard;
    assert.equal(heard().has("s1"), true);
    t.fake.list = async () => [session("s2", null)];
    await t.controller.refresh();
    assert.equal(heard().has("s1"), false);
  });
});

describe("an older transcript read that says the session is idle", () => {
  it("does not take a turn the stream began after the read was asked for", async () => {
    const t = rig({ s1: null }, "s1");
    const gate = deferred<void>();
    t.fake.transcript = async () => {
      await gate.promise;
      return { session: session("s1", null), msp: null, events: [], truncated: false, pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null };
    };
    const reading = t.controller.loadThread("s1");
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: running("t2") });
    gate.resolve();
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, "t2");
    assert.deepEqual(t.fake.sent, []);
  });
});

describe("an older transcript read", () => {
  it("does not put a finished turn back into running", async () => {
    const t = rig({ s1: running() }, "s1");
    const gate = deferred<void>();
    t.fake.transcript = async () => {
      await gate.promise;
      return { session: session("s1", running()), msp: null, events: [], truncated: false, pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null };
    };
    const reading = t.controller.loadThread("s1");
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s1", live: finished() });
    gate.resolve();
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, null);
    assert.equal(t.liveOf("s1")?.lastTerminal, "completed");
  });

  it("is believed when the stream said nothing of the session meanwhile, and for another session's events", async () => {
    const t = rig({ s1: null, s2: running() }, "s1");
    const gate = deferred<void>();
    t.fake.transcript = async () => {
      await gate.promise;
      return { session: session("s1", running("t5")), msp: null, events: [], truncated: false, pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null };
    };
    const reading = t.controller.loadThread("s1");
    await t.settle();
    t.emit({ type: "session-status", sessionId: "s2", live: finished() });
    gate.resolve();
    await reading;
    assert.equal(t.liveOf("s1")?.activeTurnId, "t5");
    assert.equal(t.liveOf("s2")?.activeTurnId, null);
  });
});
