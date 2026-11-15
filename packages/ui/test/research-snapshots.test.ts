/**
 * What a thread keeps of what it already knows when a snapshot of it arrives late: a transcript read that was
 * in flight while the stream moved on, a read after a reconnect, the answer to a start. Runs, shell runs and files
 * are never taken away by an older picture, an ending is never undone, a report already read stays, and the heal
 * after a reconnect only ever reads the research list: it never loads a thread, sends a prompt or resumes a run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AncillaClient } from "../src/client.js";
import { AncillaController, type Platform } from "../src/model/controller.js";
import { emptyFold } from "../src/model/fold.js";
import type { ThreadState } from "../src/model/store.js";
import type { AncillaEvent, AttachmentView, ModelCatalog, ProjectView, ResearchRunView, SessionSummary, ShellRun, TranscriptLoad } from "../src/types.js";
import { sourcesLine } from "../src/model/research.js";
import { fakeResearchRun, fakeResearchWorker, fakeSourceCounts, type FakeSource } from "./fixtures/research.js";

const PROJECT: ProjectView = { cwd: "/work/app", displayName: "app", pinned: false, activityAt: "2026-09-11T00:00:00.000Z", defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] };
const CATALOG: ModelCatalog = { models: [], source: null, providerId: "meta", profileId: "default", hostVersion: "1.4.7" };

function session(sessionId: string): SessionSummary {
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
    live: null,
  };
}

function load(over: Partial<TranscriptLoad> = {}): TranscriptLoad {
  return { session: null, msp: null, events: [], truncated: false, pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null, ...over };
}

function deferred() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

class SnapshotClient {
  sessions: SessionSummary[] = [];
  reads: string[] = [];
  sent: { sessionId: string; text: string }[] = [];
  listed: string[] = [];
  /** What the research list answers per thread; an Error is thrown. */
  lists: Record<string, ResearchRunView[] | Error> = {};
  transcript: (sessionId: string) => Promise<TranscriptLoad> = async () => load();
  started: Promise<ResearchRunView> | null = null;

  async listProjects() {
    return [PROJECT];
  }
  async listSessions() {
    return this.sessions;
  }
  async loadTranscript(sessionId: string): Promise<TranscriptLoad> {
    this.reads.push(sessionId);
    return this.transcript(sessionId);
  }
  async listResearch(sessionId: string): Promise<ResearchRunView[]> {
    this.listed.push(sessionId);
    const answer = this.lists[sessionId] ?? [];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
  async startResearch(): Promise<ResearchRunView> {
    if (!this.started) {
      throw new Error("the test did not script a start");
    }
    return this.started;
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
  assetUrl(path: string) {
    return path;
  }
  subscribe() {
    return () => {};
  }
}

function clientOf(fake: SnapshotClient): AncillaClient {
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
  cancelled: boolean;
  fired: boolean;
}

function rig(options: { routed?: string; threads: Record<string, Partial<ThreadState>> }) {
  let clock = 5_000_000;
  const timers: Timer[] = [];
  const platform: Platform = {
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => "",
    writeHash: () => {},
    onHashChange: () => () => {},
    now: () => clock,
    schedule: (fn) => {
      const timer: Timer = { fn, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as Timer).cancelled = true;
    },
    focused: () => false,
  };
  const fake = new SnapshotClient();
  const ids = Object.keys(options.threads);
  fake.sessions = ids.map(session);
  const controller = new AncillaController(clientOf(fake), platform);
  const thread = (patch: Partial<ThreadState>): ThreadState => ({
    load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false,
    fold: emptyFold(), attachments: [], shellRuns: [], researchRuns: [], stalled: false, ...patch,
  });
  controller.store.set((s) => ({
    ...s,
    boot: "ready",
    sessionsLoaded: true,
    projects: [PROJECT],
    sessions: Object.fromEntries(fake.sessions.map((x) => [x.sessionId, x])),
    threads: Object.fromEntries(ids.map((id) => [id, thread(options.threads[id] ?? {})])),
    route: options.routed ? { kind: "thread", sessionId: options.routed } : s.route,
  }));
  const emit = (event: AncillaEvent) => (controller as unknown as { onEvent(e: AncillaEvent): void }).onEvent(event);
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  };
  const reconnect = async () => {
    emit({ type: "connection", state: "lost" });
    emit({ type: "hello", version: "x" });
    await settle();
  };
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
  const runs = (id: string) => state().threads[id]?.researchRuns ?? [];
  const emitRun = (run: ResearchRunView) => emit({ type: "research-run", sessionId: run.sessionId, run });
  return { controller, fake, emit, emitRun, settle, reconnect, fireAll, advance, state, runs };
}

const live = (over: Partial<ResearchRunView> = {}): ResearchRunView => fakeResearchRun({ runId: "r1", status: "running", phase: "researching", round: 2, ...over });
const done = (over: Partial<ResearchRunView> = {}): ResearchRunView => fakeResearchRun({ runId: "r1", status: "completed", phase: "done", round: 2, reportAvailable: true, endedAt: "2026-09-26T00:05:00.000Z", ...over });
const stopped = (over: Partial<ResearchRunView> = {}): ResearchRunView => done({ status: "interrupted", phase: "researching", reportAvailable: false, failure: "interrupted: the server stopped while the run was in flight.", ...over });

describe("a transcript read that lands after the stream moved on", () => {
  it("cannot bring an ended run back to running", async () => {
    const t = rig({ routed: "s1", threads: { s1: { researchRuns: [live()] } } });
    const gate = deferred();
    t.fake.transcript = async () => {
      await gate.promise;
      return load({ researchRuns: [live()] });
    };
    const reading = t.controller.loadThread("s1");
    await t.settle();
    t.emitRun(done());
    gate.open();
    await reading;
    assert.equal(t.runs("s1")[0]?.status, "completed");
    assert.equal(t.controller.researchTriggerEnabled(), true, "and the composer is not left blocked by a run that is over");
  });

  it("does not drop a run it predates, and keeps the composer's Research button off while that run goes", async () => {
    const t = rig({ routed: "s1", threads: { s1: {} } });
    const gate = deferred();
    t.fake.transcript = async () => {
      await gate.promise;
      return load({ researchRuns: [] });
    };
    const reading = t.controller.loadThread("s1");
    await t.settle();
    t.emitRun(live());
    gate.open();
    await reading;
    assert.deepEqual(t.runs("s1").map((r) => r.runId), ["r1"]);
    assert.equal(t.controller.researchTriggerEnabled(), false);
  });

  it("keeps a report already read through a reload and through the reload after a reconnect", async () => {
    const t = rig({ routed: "s1", threads: { s1: { researchRuns: [done({ report: "# Report\n\nRead." })] } } });
    t.fake.transcript = async () => load({ researchRuns: [done({ report: null })] });
    await t.controller.loadThread("s1");
    assert.equal(t.runs("s1")[0]?.report, "# Report\n\nRead.");
    await t.reconnect();
    assert.deepEqual(t.fake.reads, ["s1", "s1"]);
    assert.equal(t.runs("s1")[0]?.report, "# Report\n\nRead.");
  });

  it("keeps the order the thread already shows its runs in, and appends the runs the reload brings that it did not know", async () => {
    const t = rig({ routed: "s1", threads: { s1: { researchRuns: [done({ runId: "r-b", createdAt: "2026-09-26T00:02:00.000Z" }), done({ runId: "r-a", createdAt: "2026-09-26T00:01:00.000Z" })] } } });
    t.fake.transcript = async () =>
      load({
        researchRuns: [
          done({ runId: "r-a", createdAt: "2026-09-26T00:01:00.000Z" }),
          done({ runId: "r-c", createdAt: "2026-09-26T00:03:00.000Z" }),
          done({ runId: "r-b", createdAt: "2026-09-26T00:02:00.000Z" }),
        ],
      });
    await t.controller.loadThread("s1");
    assert.deepEqual(t.runs("s1").map((r) => r.runId), ["r-b", "r-a", "r-c"], "the snapshot's order does not reorder what is shown");
  });

  it("keeps the shell runs and the files the stream delivered meanwhile", async () => {
    const shell = (id: string): ShellRun => ({ id, sessionId: "s1", command: `echo ${id}`, exitCode: 0, output: id, truncated: false, durationMs: 1, at: "2026-09-26T00:00:00.000Z" });
    const file = (id: string): AttachmentView => ({ id, turnId: "t1", name: `${id}.txt`, mediaType: "text/plain", kind: "file", width: null, height: null, url: `/files/${id}` });
    const t = rig({ routed: "s1", threads: { s1: { shellRuns: [shell("sh1")], attachments: [file("a1")] } } });
    t.fake.transcript = async () => load({ shellRuns: [], attachments: [] });
    await t.controller.loadThread("s1");
    assert.deepEqual(t.state().threads["s1"]?.shellRuns.map((r) => r.id), ["sh1"]);
    assert.deepEqual(t.state().threads["s1"]?.attachments.map((f) => f.id), ["a1"]);
    t.fake.transcript = async () => load({ shellRuns: [shell("sh1"), shell("sh2")], attachments: [file("a1"), file("a2")] });
    await t.controller.loadThread("s1");
    assert.deepEqual(t.state().threads["s1"]?.shellRuns.map((r) => r.id), ["sh1", "sh2"], "what the snapshot adds is added");
    assert.deepEqual(t.state().threads["s1"]?.attachments.map((f) => f.id), ["a1", "a2"]);
  });

  it("settles a stop its run's ending answers, whichever way the ending arrives", async () => {
    const t = rig({ routed: "s1", threads: { s1: { researchRuns: [live()] } } });
    t.controller.store.set((s) => ({ ...s, researchStopping: { r1: "now" } }));
    t.fake.transcript = async () => load({ researchRuns: [done({ status: "cancelled" })] });
    await t.controller.loadThread("s1");
    assert.equal(t.state().researchStopping["r1"], undefined);
    assert.equal(t.runs("s1")[0]?.status, "cancelled");
  });
});

describe("starting a run", () => {
  it("shows one row when the stream brings the run before the answer to the start does", async () => {
    const t = rig({ routed: "s1", threads: { s1: {} } });
    const gate = deferred();
    const real = live({ runId: "run-1-abcd" });
    t.fake.started = gate.promise.then(() => real);
    const starting = t.controller.startResearch("s1", "How is geothermal energy developing?");
    await t.settle();
    assert.match(t.runs("s1")[0]?.runId ?? "", /^pending:/);
    t.emitRun(real);
    assert.deepEqual(t.runs("s1").map((r) => r.runId), ["run-1-abcd"], "the real run replaces the placeholder at once");
    gate.open();
    assert.equal(await starting, true);
    assert.deepEqual(t.runs("s1").map((r) => r.runId), ["run-1-abcd"]);
  });

  it("swaps the placeholder for the answer even when the run it names has already ended", async () => {
    const t = rig({ routed: "s1", threads: { s1: {} } });
    t.fake.started = Promise.resolve(done({ runId: "run-1-abcd" }));
    assert.equal(await t.controller.startResearch("s1", "A question that is answered at once"), true);
    assert.deepEqual(t.runs("s1").map((r) => r.runId), ["run-1-abcd"]);
    assert.equal(t.runs("s1")[0]?.status, "completed");
  });

  it("shows one row when a reload already holds the run while the start is still out (regression guard)", async () => {
    const t = rig({ routed: "s1", threads: { s1: {} } });
    const gate = deferred();
    const real = live({ runId: "run-1-abcd" });
    t.fake.started = gate.promise.then(() => real);
    const starting = t.controller.startResearch("s1", "How is geothermal energy developing?");
    await t.settle();
    t.fake.transcript = async () => load({ researchRuns: [real] });
    await t.controller.loadThread("s1");
    assert.deepEqual(t.runs("s1").map((r) => r.runId), ["run-1-abcd"]);
    gate.open();
    await starting;
    assert.deepEqual(t.runs("s1").map((r) => r.runId), ["run-1-abcd"]);
  });
});

describe("the stream comes back while research runs are live", () => {
  const threads = () => ({
    s1: {},
    s2: { researchRuns: [live({ runId: "r2", sessionId: "s2" })] },
    s3: { researchRuns: [stopped({ runId: "r3", sessionId: "s3" })] },
    s4: { researchRuns: [done({ runId: "r4", sessionId: "s4" })] },
    s5: {},
  });

  it("reads the research list of each other thread with a live or interrupted run, and nothing else", async () => {
    const t = rig({ routed: "s1", threads: threads() });
    t.fake.lists["s2"] = [done({ runId: "r2", sessionId: "s2" })];
    t.fake.lists["s3"] = [live({ runId: "r3", sessionId: "s3", resumes: 1, round: 1, phase: "drafting" })];
    await t.reconnect();
    assert.deepEqual([...t.fake.listed].sort(), ["s2", "s3"], "no request for an idle thread or one whose run ended with its report");
    assert.deepEqual(t.fake.reads, ["s1"], "no thread is loaded but the open one");
    assert.deepEqual(t.fake.sent, [], "nothing is sent");
    assert.equal(t.runs("s2")[0]?.status, "completed", "the run that ended while the stream was away shows how");
    assert.equal(t.runs("s3")[0]?.status, "running", "a run resumed elsewhere shows live");
    assert.equal(t.runs("s3")[0]?.resumes, 1);
    assert.equal(t.state().threads["s4"]?.researchRuns[0]?.status, "completed");
  });

  it("leaves the open thread to its own transcript read, even with a live run in it", async () => {
    const t = rig({ routed: "s1", threads: { s1: { researchRuns: [live({ runId: "r1" })] }, s2: { researchRuns: [live({ runId: "r2", sessionId: "s2" })] } } });
    t.fake.transcript = async () => load({ researchRuns: [done({ runId: "r1" })] });
    await t.reconnect();
    assert.deepEqual(t.fake.listed, ["s2"]);
    assert.deepEqual(t.fake.reads, ["s1"]);
    assert.equal(t.runs("s1")[0]?.status, "completed", "the transcript read heals it");
  });

  it("does not let an older answer undo a resumed run", async () => {
    const t = rig({ routed: "s1", threads: { s1: {}, s2: { researchRuns: [live({ runId: "r2", sessionId: "s2", resumes: 1 })] } } });
    t.fake.lists["s2"] = [stopped({ runId: "r2", sessionId: "s2", resumes: 0 })];
    await t.reconnect();
    assert.deepEqual(t.fake.listed, ["s2"]);
    assert.equal(t.runs("s2")[0]?.status, "running");
  });

  it("reads them all when no thread is open, and loads none", async () => {
    const t = rig({ threads: threads() });
    await t.reconnect();
    assert.deepEqual([...t.fake.listed].sort(), ["s2", "s3"]);
    assert.deepEqual(t.fake.reads, []);
    assert.deepEqual(t.fake.sent, []);
  });

  it("swallows a failed read, tells nobody, and still heals the others", async () => {
    const t = rig({ routed: "s1", threads: threads() });
    t.fake.lists["s2"] = new Error("the server went away");
    t.fake.lists["s3"] = [live({ runId: "r3", sessionId: "s3", resumes: 1 })];
    await t.reconnect();
    assert.equal(t.runs("s2")[0]?.status, "running", "what it knew stays");
    assert.equal(t.runs("s3")[0]?.status, "running");
    assert.equal(t.state().toasts.length, 0);
  });

  it("does nothing for a hello that follows no loss", async () => {
    const t = rig({ routed: "s1", threads: threads() });
    t.emit({ type: "hello", version: "x" });
    await t.settle();
    assert.deepEqual(t.fake.listed, []);
    assert.deepEqual(t.fake.reads, []);
  });

  it("reads once for a stream that keeps dropping, and once more when the held-back reread runs", async () => {
    const t = rig({ routed: "s1", threads: threads() });
    await t.reconnect();
    assert.equal(t.fake.listed.length, 2);
    t.advance(2_000);
    await t.reconnect();
    t.advance(2_000);
    await t.reconnect();
    assert.equal(t.fake.listed.length, 2, "no second round inside the gap");
    t.advance(60_000);
    await t.fireAll();
    assert.equal(t.fake.listed.length, 4, "one trailing round for the reconnects held back");
    assert.deepEqual(t.fake.sent, []);
  });
});

describe("the heal after the stream comes back, under adverse reads", () => {
  const two = () => ({
    s1: {},
    s2: { researchRuns: [live({ runId: "r2", sessionId: "s2" })] },
    s3: { researchRuns: [live({ runId: "r3", sessionId: "s3" })] },
  });

  it("still heals the others when a read throws before it returns a promise", async () => {
    const t = rig({ routed: "s1", threads: two() });
    t.fake.listResearch = ((sessionId: string) => {
      if (sessionId === "s2") {
        throw new Error("thrown at once");
      }
      t.fake.listed.push(sessionId);
      return Promise.resolve([done({ runId: "r3", sessionId: "s3" })]);
    }) as typeof t.fake.listResearch;
    await t.reconnect();
    assert.equal(t.runs("s2")[0]?.status, "running", "what it knew stays");
    assert.equal(t.runs("s3")[0]?.status, "completed");
    assert.equal(t.state().toasts.length, 0);
  });

  it("swallows an answer that is not a list, and tells nobody", async () => {
    const t = rig({ routed: "s1", threads: two() });
    t.fake.listResearch = (async () => undefined) as unknown as typeof t.fake.listResearch;
    await t.reconnect();
    assert.equal(t.runs("s2")[0]?.status, "running");
    assert.equal(t.state().toasts.length, 0);
  });

  it("does not read the research of a thread that was archived", async () => {
    const t = rig({ routed: "s1", threads: two() });
    t.fake.sessions = t.fake.sessions.map((s) => (s.sessionId === "s2" ? { ...s, archived: true } : s));
    t.controller.store.set((s) => ({ ...s, sessions: Object.fromEntries(t.fake.sessions.map((x) => [x.sessionId, x])) }));
    await t.reconnect();
    assert.deepEqual(t.fake.listed, ["s3"]);
  });

  it("changes nothing when the controller is gone before the answer lands", async () => {
    const t = rig({ routed: "s1", threads: two() });
    const gate = deferred();
    t.fake.listResearch = (async (sessionId: string) => {
      t.fake.listed.push(sessionId);
      await gate.promise;
      return [done({ runId: sessionId === "s2" ? "r2" : "r3", sessionId })];
    }) as typeof t.fake.listResearch;
    await t.reconnect();
    assert.deepEqual([...t.fake.listed].sort(), ["s2", "s3"]);
    t.controller.dispose();
    const before = t.runs("s2");
    gate.open();
    await t.settle();
    assert.equal(t.runs("s2"), before, "the thread is untouched");
    assert.equal(t.runs("s2")[0]?.status, "running");
  });

  it("does not let an answer that is older than an ending undo it", async () => {
    const t = rig({ routed: "s1", threads: two() });
    const gate = deferred();
    t.fake.listResearch = (async (sessionId: string) => {
      t.fake.listed.push(sessionId);
      await gate.promise;
      return [live({ runId: sessionId === "s2" ? "r2" : "r3", sessionId })];
    }) as typeof t.fake.listResearch;
    await t.reconnect();
    t.emitRun(done({ runId: "r2", sessionId: "s2" }));
    gate.open();
    await t.settle();
    assert.equal(t.runs("s2")[0]?.status, "completed");
    assert.equal(t.runs("s3")[0]?.status, "running");
  });

  it("reads the open thread's research too when its own transcript read was already out and may predate the loss", async () => {
    const t = rig({ routed: "s1", threads: { s1: { researchRuns: [live({ runId: "r1" })] }, s2: { researchRuns: [live({ runId: "r2", sessionId: "s2" })] } } });
    const gate = deferred();
    t.fake.transcript = async () => {
      await gate.promise;
      return load({ researchRuns: [live({ runId: "r1" })] });
    };
    t.fake.lists["s1"] = [done({ runId: "r1" })];
    const older = t.controller.loadThread("s1");
    await t.settle();
    await t.reconnect();
    assert.deepEqual(t.fake.reads, ["s1"], "the reconnect's read joined the one in flight");
    assert.deepEqual([...t.fake.listed].sort(), ["s1", "s2"]);
    assert.equal(t.runs("s1")[0]?.status, "completed", "the ending that happened while the stream was down shows without waiting for the older read");
    gate.open();
    await older;
    assert.equal(t.runs("s1")[0]?.status, "completed", "and the older read does not bring it back");
    assert.deepEqual(t.fake.sent, []);
  });
});

describe("the sources line when two snapshots of a live round are level", () => {
  // The round-end window: the last worker has made its final call, and the registry the checkpoint stores moves some
  // sources from "search only" and "fetch failed" to "opened" while the round, the phase and the tool calls stay put.
  const R: FakeSource = { verified: true, provenance: "retrieved" };
  const S: FakeSource = { verified: true, provenance: "search_only" };
  const A: FakeSource = { verified: true, provenance: "attempted" };
  const before = fakeSourceCounts([R, S, S, S, A, A], 5);
  const after = fakeSourceCounts([R, R, S, S, A, R], 5);
  const workers = () => [fakeResearchWorker({ agentId: 1, round: 2, state: "completed", toolCalls: 6 })];
  const first = () => live({ workers: workers(), sources: before });
  const second = () => live({ workers: workers(), sources: after });
  const line = (t: ReturnType<typeof rig>) => sourcesLine(t.runs("s1")[0]?.sources as ResearchRunView["sources"]);

  it("ends on the later snapshot's line when the stream delivers both in order", () => {
    const t = rig({ routed: "s1", threads: { s1: {} } });
    t.emitRun(first());
    t.emitRun(second());
    assert.equal(line(t), sourcesLine(after));
    assert.equal(line(t), "6 sources · 3 opened · 2 search only · 1 fetch failed or cut off · 6 citable · 5 curated");
  });

  it("ends on the later snapshot's line when a transcript read that answers the earlier one lands last", async () => {
    const t = rig({ routed: "s1", threads: { s1: {} } });
    t.emitRun(second());
    const gate = deferred();
    t.fake.transcript = async () => {
      await gate.promise;
      return load({ researchRuns: [first()] });
    };
    const reading = t.controller.loadThread("s1");
    await t.settle();
    gate.open();
    await reading;
    assert.equal(line(t), sourcesLine(after));
  });

  it("ends on the later snapshot's line after a reload that answers it, however the earlier one came", async () => {
    const t = rig({ routed: "s1", threads: { s1: {} } });
    t.emitRun(first());
    t.emitRun(second());
    t.fake.transcript = async () => load({ researchRuns: [second()] });
    await t.controller.loadThread("s1");
    assert.equal(line(t), sourcesLine(after));
  });
});

describe("a worker row that only grew", () => {
  it("is not put back by the snapshot that lands second (the controller's tie)", async () => {
    const worker = (state: "working" | "completed") => fakeResearchWorker({ agentId: 1, state, toolCalls: 3 });
    const t = rig({ routed: "s1", threads: { s1: {} } });
    t.emitRun(live({ workers: [worker("completed")], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 9000 } }));
    t.emitRun(live({ workers: [worker("working")], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2000 } }));
    assert.equal(t.runs("s1")[0]?.workers[0]?.state, "completed");
    assert.equal(t.runs("s1")[0]?.usage.totalTokens, 9000);
  });
});
