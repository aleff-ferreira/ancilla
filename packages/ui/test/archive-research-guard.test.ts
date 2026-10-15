/**
 * Archiving a thread while a research run is in flight on it. The server refuses (the run's job lives in the
 * server, and archiving does not stop it), and the thread must not disappear from the sidebar first: the check is
 * made on what the thread already shows, before the optimistic removal.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AncillaError, type AncillaClient } from "../src/client.js";
import { AncillaController, type Platform } from "../src/model/controller.js";
import { emptyFold } from "../src/model/fold.js";
import type { ThreadState } from "../src/model/store.js";
import type { ResearchRunView, SessionSummary } from "../src/types.js";
import { fakeResearchRun } from "./fixtures/research.js";

const SESSION: SessionSummary = {
  sessionId: "s1",
  cwd: "/work/app",
  title: "Probe",
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

class ArchiveClient {
  updates: { sessionId: string; patch: Record<string, unknown> }[] = [];
  failWith: Error | null = null;
  async updateSession(sessionId: string, patch: Record<string, unknown>) {
    this.updates.push({ sessionId, patch });
    if (this.failWith) {
      throw this.failWith;
    }
    return null;
  }
  subscribe() {
    return () => {};
  }
}

function clientOf(fake: ArchiveClient): AncillaClient {
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

function rig(runs: ResearchRunView[]) {
  const platform: Platform = {
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => "",
    writeHash: () => {},
    onHashChange: () => () => {},
    now: () => Date.now(),
    schedule: () => ({}),
    cancel: () => {},
    focused: () => false,
  };
  const fake = new ArchiveClient();
  const controller = new AncillaController(clientOf(fake), platform);
  const thread: ThreadState = {
    load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(),
    attachments: [], shellRuns: [], researchRuns: runs, stalled: false,
  };
  controller.store.set((s) => ({ ...s, sessions: { s1: SESSION }, threads: { ...s.threads, s1: thread } }));
  const state = () => controller.store.get();
  return { controller, fake, state };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("archiving a thread with research in progress", () => {
  for (const status of ["running", "queued"] as const) {
    it(`keeps a thread with a ${status} run, says why, and does not ask the server`, async () => {
      const t = rig([fakeResearchRun({ status })]);
      await t.controller.archive("s1");
      assert.ok(t.state().sessions["s1"], "the thread is still in the sidebar");
      assert.ok(t.state().threads["s1"], "and its state was not forgotten");
      assert.deepEqual(t.fake.updates, [], "nothing was sent");
      const toast = t.state().toasts.at(-1);
      assert.equal(toast?.tone, "error");
      assert.match(toast?.title ?? "", /archive/i);
      assert.match(toast?.detail ?? "", /research/i);
      assert.match(toast?.detail ?? "", /stop/i);
    });
  }

  for (const status of ["completed", "partial", "failed", "cancelled", "interrupted"] as const) {
    it(`archives a thread whose last run is ${status}`, async () => {
      const t = rig([fakeResearchRun({ status, endedAt: "2026-09-26T00:05:00.000Z" })]);
      await t.controller.archive("s1");
      assert.deepEqual(t.fake.updates, [{ sessionId: "s1", patch: { archived: true } }]);
      assert.equal(t.state().sessions["s1"], undefined, "the thread left the sidebar");
    });
  }

  it("shows the server's own reason when a run it knows of blocks the archive, and puts the thread back", async () => {
    const t = rig([]);
    t.fake.failWith = new AncillaError("This thread has a research run in progress. Stop it, or wait for it to finish, before archiving.", 409);
    await t.controller.archive("s1");
    assert.deepEqual(t.fake.updates.length, 1);
    assert.ok(t.state().sessions["s1"], "the thread is back");
    const toast = t.state().toasts.at(-1);
    assert.match(toast?.detail ?? "", /research run in progress/);
  });
});

describe("settling a thread with research in progress", () => {
  for (const status of ["running", "queued"] as const) {
    it(`keeps a thread with a ${status} run out of Settled, says why, and does not ask the server`, async () => {
      const t = rig([fakeResearchRun({ status })]);
      await t.controller.setSettled("s1", true);
      assert.equal(t.state().sessions["s1"]?.settled, false, "the thread was not shelved, not even for a moment");
      assert.deepEqual(t.fake.updates, [], "nothing was sent");
      const toast = t.state().toasts.at(-1);
      assert.equal(toast?.tone, "error");
      assert.match(toast?.title ?? "", /settle/i);
      assert.match(toast?.detail ?? "", /research/i);
    });
  }

  it("settles a thread whose last run has ended, and brings a settled thread back whatever runs it has", async () => {
    const ended = rig([fakeResearchRun({ status: "completed", endedAt: "2026-09-26T00:05:00.000Z" })]);
    await ended.controller.setSettled("s1", true);
    assert.deepEqual(ended.fake.updates, [{ sessionId: "s1", patch: { settled: true } }]);
    assert.equal(ended.state().sessions["s1"]?.settled, true);

    const back = rig([fakeResearchRun({ status: "running" })]);
    back.controller.store.set((s) => ({ ...s, sessions: { s1: { ...SESSION, settled: true, settledAt: "2026-09-11T00:00:00.000Z" } } }));
    await back.controller.setSettled("s1", false);
    assert.deepEqual(back.fake.updates, [{ sessionId: "s1", patch: { settled: false } }]);
  });
});
