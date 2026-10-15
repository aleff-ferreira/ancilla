import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore, type UsageCall } from "../src/store.js";

const TURN = "2026-09-26T20:18:16.732Z";

function call(over: Partial<UsageCall> & { key: string }): UsageCall {
  return {
    sessionId: "s1",
    turnId: "t1",
    modelId: "muse-spark-1.3",
    promptTokens: 1000,
    outputTokens: 200,
    inputTokens: 1000,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: 4179,
    at: TURN,
    ...over,
  };
}

function open(): AncillaStore {
  const store = new AncillaStore();
  after(() => store.close());
  return store;
}

/** The stored date and source of one row, read the way the usage page would. */
function stamp(store: AncillaStore, key: string): { at: string; source: string | null } {
  const row = store.listUsage().find((r) => r.key === key);
  assert.ok(row, `row ${key} is stored`);
  return { at: row.at, source: row.atSource };
}

describe("usage ledger store: one call under two cursors", () => {
  // The probe capture numbers the same call ':8' live and ':6' in the history page.
  it("keeps a call seen live and read back from history as one row, whichever arrives first", () => {
    const store = open();
    store.recordUsage(call({ key: "v:s:8", at: "2026-09-26T20:18:20.000Z", atSource: "live" }));
    store.recordUsage(call({ key: "v:s:6", at: TURN, atSource: "replay" }));
    assert.deepEqual(store.listUsage().map((r) => r.key), ["v:s:8"], "the replay is the same call");
    assert.deepEqual(stamp(store, "v:s:8"), { at: "2026-09-26T20:18:20.000Z", source: "live" }, "and never moves the live stamp");

    const reverse = open();
    reverse.recordUsage(call({ key: "v:s:6", at: TURN, atSource: "replay" }));
    reverse.recordUsage(call({ key: "v:s:8", at: "2026-09-26T20:18:20.000Z", atSource: "live" }));
    assert.deepEqual(reverse.listUsage().map((r) => r.key), ["v:s:6"]);
  });

  it("tells two calls apart by their tokens, duration, turn and thread", () => {
    const store = open();
    store.recordUsage(call({ key: "a" }));
    store.recordUsage(call({ key: "b", promptTokens: 1500 }));
    store.recordUsage(call({ key: "c", outputTokens: 201 }));
    store.recordUsage(call({ key: "d", durationMs: 4180 }));
    store.recordUsage(call({ key: "e", turnId: "t2" }));
    store.recordUsage(call({ key: "f", sessionId: "s2" }));
    assert.equal(store.listUsage().length, 6);
  });

  // An accepted trade-off: a call with no turn id and no duration (real events carry both) is told apart by its tokens
  // alone, so two such calls with equal tokens count once. The alternative is a cursor-less call counted afresh on
  // every reopen of its thread.
  it("takes equal tokens with no turn and no duration for one call, rather than counting it afresh on each reopen", () => {
    const store = open();
    store.recordUsage(call({ key: "a", turnId: null, durationMs: null }));
    store.recordUsage(call({ key: "b", turnId: null, durationMs: null }));
    assert.equal(store.listUsage().length, 1);
  });

  it("still counts a repeated key once", () => {
    const store = open();
    store.recordUsage(call({ key: "same", atSource: "live" }));
    store.recordUsage(call({ key: "same", atSource: "live", promptTokens: 9 }));
    assert.deepEqual(store.listUsage().map((r) => r.promptTokens), [1000]);
  });
});

describe("usage ledger store: dating", () => {
  it("lets a replay with an earlier date replace a replay's", () => {
    const store = open();
    store.recordUsage(call({ key: "k", at: "2026-09-27T00:07:02.781Z", atSource: "replay" }));
    store.recordUsage(call({ key: "k", at: TURN, atSource: "replay" }));
    assert.deepEqual(stamp(store, "k"), { at: TURN, source: "replay" });
  });

  it("never lets a later date win", () => {
    const store = open();
    store.recordUsage(call({ key: "k", at: TURN, atSource: "replay" }));
    store.recordUsage(call({ key: "k", at: "2026-09-27T00:07:02.781Z", atSource: "replay" }));
    store.recordUsage(call({ key: "k", at: "2026-09-27T00:07:02.781Z", atSource: "live" }));
    assert.deepEqual(stamp(store, "k"), { at: TURN, source: "replay" });
  });

  it("never moves a live stamp, however much earlier the replay is", () => {
    const store = open();
    store.recordUsage(call({ key: "k", at: "2026-09-27T00:07:02.781Z", atSource: "live" }));
    store.recordUsage(call({ key: "k", at: "2026-01-01T00:00:00.000Z", atSource: "replay" }));
    assert.deepEqual(stamp(store, "k"), { at: "2026-09-27T00:07:02.781Z", source: "live" });
  });

  it("moves a row stored before sources were tracked only when it is more than six hours late", () => {
    const store = open();
    // The thread was opened days after its turn: the stored date is the opening, far later than the turn.
    store.recordUsage(call({ key: "opened-late", at: "2026-10-05T12:00:00.000Z" }));
    store.recordUsage(call({ key: "opened-late", at: TURN, atSource: "replay" }));
    assert.deepEqual(stamp(store, "opened-late"), { at: TURN, source: "replay" });

    // A 20 minute turn recorded live: the call really ran after the turn began. It stays where it is.
    store.recordUsage(call({ key: "long-turn", turnId: "t2", at: "2026-09-26T20:38:16.732Z" }));
    store.recordUsage(call({ key: "long-turn", turnId: "t2", at: TURN, atSource: "replay" }));
    assert.deepEqual(stamp(store, "long-turn"), { at: "2026-09-26T20:38:16.732Z", source: null });

    // Just inside and just outside the six hours.
    store.recordUsage(call({ key: "edge-in", turnId: "t3", at: "2026-09-27T02:18:16.000Z" }));
    store.recordUsage(call({ key: "edge-in", turnId: "t3", at: "2026-09-26T20:18:16.732Z", atSource: "replay" }));
    assert.equal(stamp(store, "edge-in").source, null, "just under six hours is not more than six");
    store.recordUsage(call({ key: "edge-out", turnId: "t4", at: "2026-09-27T02:19:16.000Z" }));
    store.recordUsage(call({ key: "edge-out", turnId: "t4", at: "2026-09-26T20:18:16.732Z", atSource: "replay" }));
    assert.equal(stamp(store, "edge-out").source, "replay", "six hours and a minute is");
  });

  it("lets an estimate seed a row but never move one", () => {
    const store = open();
    store.recordUsage(call({ key: "seeded", at: "2026-09-27T01:00:00.000Z", atSource: "estimate" }));
    assert.deepEqual(stamp(store, "seeded"), { at: "2026-09-27T01:00:00.000Z", source: "replay" }, "stored as a replay date");
    store.recordUsage(call({ key: "seeded", at: "2026-09-20T01:00:00.000Z", atSource: "estimate" }));
    assert.equal(stamp(store, "seeded").at, "2026-09-27T01:00:00.000Z", "an estimate never repairs a replay row");
    store.recordUsage(call({ key: "legacy", turnId: "t2", at: "2026-10-05T12:00:00.000Z" }));
    store.recordUsage(call({ key: "legacy", turnId: "t2", at: TURN, atSource: "estimate" }));
    assert.deepEqual(stamp(store, "legacy"), { at: "2026-10-05T12:00:00.000Z", source: null }, "nor a legacy one");
    store.recordUsage(call({ key: "seeded", at: TURN, atSource: "replay" }));
    assert.equal(stamp(store, "seeded").at, TURN, "a date from the turn itself does");
  });

  it("repairs the row a twin of the same call is stored under", () => {
    const store = open();
    store.recordUsage(call({ key: "v:s:6", at: "2026-10-05T12:00:00.000Z", atSource: "replay" }));
    store.recordUsage(call({ key: "v:s:8", at: TURN, atSource: "replay" }));
    assert.deepEqual(store.listUsage().map((r) => [r.key, r.at]), [["v:s:6", TURN]]);
  });

  it("reports a row's source as live, replay or none", () => {
    const store = open();
    store.recordUsage(call({ key: "a", atSource: "live" }));
    store.recordUsage(call({ key: "b", turnId: "t2", atSource: "replay" }));
    store.recordUsage(call({ key: "c", turnId: "t3" }));
    assert.deepEqual(store.listUsage().map((r) => [r.key, r.atSource]), [["a", "live"], ["b", "replay"], ["c", null]]);
  });
});

describe("usage ledger store: listUsage carries what the report folds on", () => {
  it("returns the thread's origin, archived flag and account", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    store.recordSession({ id: "plain", projectId: project.id });
    store.recordSession({ id: "work", projectId: project.id, accountId: "work" });
    store.recordSession({ id: "worker", projectId: project.id, origin: "research-worker", accountId: "work" });
    store.updateSession("worker", { archived: true });
    for (const [index, id] of ["plain", "work", "worker", "gone"].entries()) {
      store.recordUsage(call({ key: `k${index}`, sessionId: id, turnId: `t${index}` }));
    }
    const rows = new Map(store.listUsage().map((r) => [r.sessionId, r]));
    assert.deepEqual([rows.get("plain")?.origin, rows.get("plain")?.archived, rows.get("plain")?.accountId], ["ancilla", false, null]);
    assert.deepEqual([rows.get("work")?.origin, rows.get("work")?.archived, rows.get("work")?.accountId], ["ancilla", false, "work"]);
    assert.deepEqual([rows.get("worker")?.origin, rows.get("worker")?.archived, rows.get("worker")?.accountId], ["research-worker", true, "work"]);
    assert.deepEqual([rows.get("gone")?.origin, rows.get("gone")?.archived, rows.get("gone")?.accountId], [null, false, null], "a row whose session is gone still lists");
  });
});

describe("usage ledger store: coverage", () => {
  const SINCE = "2026-09-20T00:00:00.000Z";
  const IN_WINDOW = "2026-09-26T10:00:00.000Z";

  it("round-trips a verdict and sums the prompt tokens recorded for a thread", () => {
    const store = open();
    assert.equal(store.getUsageCoverage("s1"), null);
    store.setUsageCoverage("s1", false, "2026-09-26T10:00:00.000Z");
    assert.deepEqual(store.getUsageCoverage("s1"), { complete: false, checkedAt: "2026-09-26T10:00:00.000Z" });
    store.setUsageCoverage("s1", true, "2026-09-27T10:00:00.000Z");
    assert.deepEqual(store.getUsageCoverage("s1"), { complete: true, checkedAt: "2026-09-27T10:00:00.000Z" });
    assert.equal(store.sumUsagePrompt("s1"), 0);
    store.recordUsage(call({ key: "a", promptTokens: 1000 }));
    store.recordUsage(call({ key: "b", turnId: "t2", promptTokens: 2500 }));
    store.recordUsage(call({ key: "c", sessionId: "other", promptTokens: 77 }));
    assert.equal(store.sumUsagePrompt("s1"), 3500);
  });

  it("counts a call an older install stored under both cursors once, and leaves both rows", async () => {
    // Before the twin rule a call seen live and read back from history was stored twice. Those rows stay (nothing is
    // deleted), but they must not make a thread read only in part look complete.
    const dir = await mkdtemp(join(tmpdir(), "ancilla-usage-"));
    const path = join(dir, "doubled.db");
    const first = new AncillaStore(path);
    first.recordUsage(call({ key: "v:s:8", atSource: "live" }));
    first.recordUsage(call({ key: "v:s:9", turnId: "t2", promptTokens: 500, atSource: "live" }));
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO usage (key, session_id, turn_id, model_id, prompt_tokens, output_tokens, duration_ms, at)
      VALUES ('v:s:6', 's1', 't1', 'muse-spark-1.3', 1000, 200, 4179, '2026-09-26T20:18:16.732Z')`);
    raw.close();

    const store = new AncillaStore(path);
    after(() => store.close());
    assert.equal(store.listUsage().filter((r) => r.turnId === "t1").length, 2, "the doubled rows are kept");
    assert.equal(store.sumUsagePrompt("s1"), 1500, "but the call counts once: 1000 + 500, not 2500");
    // A genuinely different call with the same tokens and a different duration is not a twin of it.
    store.recordUsage(call({ key: "v:s:10", durationMs: 9999 }));
    assert.equal(store.sumUsagePrompt("s1"), 2500);
  });

  it("counts threads with calls in the window and the ones read back only in part", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    for (const id of ["whole", "partial", "worker", "old"]) {
      store.recordSession({ id, projectId: project.id, turnCount: 2, activityAt: IN_WINDOW, ...(id === "worker" ? { origin: "research-worker" } : {}) });
    }
    store.recordUsage(call({ key: "w", sessionId: "whole", at: IN_WINDOW }));
    store.recordUsage(call({ key: "p", sessionId: "partial", at: IN_WINDOW }));
    store.recordUsage(call({ key: "r", sessionId: "worker", at: IN_WINDOW }));
    store.recordUsage(call({ key: "o", sessionId: "old", at: "2026-08-01T00:00:00.000Z" }));
    store.setUsageCoverage("whole", true);
    store.setUsageCoverage("partial", false);
    store.setUsageCoverage("worker", false);
    store.setUsageCoverage("old", false);
    const coverage = store.usageCoverage(SINCE);
    assert.equal(coverage.countedThreads, 2, "whole and partial; the worker is not a thread and old has nothing in the window");
    assert.equal(coverage.partialThreads, 1, "only partial");
    assert.equal(coverage.uncountedThreads, 0);
  });

  it("counts a thread nothing here has read, and ignores the ones that cannot be counted", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    const session = (id: string, over: { turnCount?: number; activityAt?: string; origin?: string } = {}) =>
      store.recordSession({ id, projectId: project.id, turnCount: 2, activityAt: IN_WINDOW, ...over });
    session("unread");
    session("archived");
    store.updateSession("archived", { archived: true });
    session("worker", { origin: "research-worker" });
    session("no-turns", { turnCount: 0 });
    session("stale", { activityAt: "2026-08-01T00:00:00.000Z" });
    session("has-calls");
    session("calls-before-window");
    session("read-in-full");
    session("read-in-part");
    store.recordUsage(call({ key: "a", sessionId: "has-calls", at: IN_WINDOW }));
    store.recordUsage(call({ key: "b", sessionId: "calls-before-window", at: "2026-08-01T00:00:00.000Z" }));
    store.setUsageCoverage("read-in-full", true);
    store.setUsageCoverage("read-in-part", false);
    const coverage = store.usageCoverage(SINCE);
    assert.equal(coverage.uncountedThreads, 2, "unread, and read-in-part whose page held no call");
    assert.equal(coverage.countedThreads, 1);
    assert.equal(coverage.partialThreads, 0);
  });
});

describe("usage ledger store: opening a database made before this release", () => {
  it("adds the date source and coverage table, keeps the rows and opens again cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-usage-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE usage (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        model_id TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        at TEXT NOT NULL
      );
      INSERT INTO usage (key, session_id, turn_id, model_id, prompt_tokens, output_tokens, duration_ms, at)
        VALUES ('v:old:1', 'old', 't1', 'muse-spark-1.3', 4000, 300, 2500, '2026-09-27T00:07:02.781Z');
    `);
    old.close();

    const first = new AncillaStore(path);
    const rows = first.listUsage();
    assert.deepEqual(rows.map((r) => [r.key, r.promptTokens, r.at, r.atSource]), [["v:old:1", 4000, "2026-09-27T00:07:02.781Z", null]], "the old row survives with no source");
    assert.equal(first.getUsageCoverage("old"), null);
    first.setUsageCoverage("old", false);
    // The old row is a legacy one: a replay more than six hours earlier repairs it, a closer one (this row is
    // 3h49m past its turn, like a live call of a long turn could be) is left alone.
    first.recordUsage(call({ key: "v:old:1", sessionId: "old", at: "2026-09-26T20:18:16.732Z", atSource: "replay" }));
    assert.equal(stamp(first, "v:old:1").at, "2026-09-27T00:07:02.781Z");
    first.recordUsage(call({ key: "v:old:1", sessionId: "old", at: "2026-09-26T10:00:00.000Z", atSource: "replay" }));
    assert.deepEqual(stamp(first, "v:old:1"), { at: "2026-09-26T10:00:00.000Z", source: "replay" });
    first.close();

    const second = new AncillaStore(path);
    after(() => second.close());
    assert.deepEqual(second.listUsage().map((r) => [r.key, r.at, r.atSource]), [["v:old:1", "2026-09-26T10:00:00.000Z", "replay"]]);
    assert.equal(second.getUsageCoverage("old")?.complete, false);
    const check = new DatabaseSync(path);
    const columns = (check.prepare("PRAGMA table_info(usage)").all() as { name: string }[]).filter((c) => c.name === "at_source");
    check.close();
    assert.equal(columns.length, 1, "the column is added once");
  });
});
