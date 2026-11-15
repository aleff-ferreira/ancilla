import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AncillaStore } from "@ancilla/daemon";
import { uuidv7 } from "../src/research/index.js";
import { resolveZone, usageWindow } from "../src/usageWindow.js";
import { FakeConnection, get, send, start } from "./harness.js";

const MODEL = "muse-spark-1.3";
const DAY = 86_400_000;

/**
 * The `since` a window asked for between two clock readings can have: the server reads the clock itself, and a
 * midnight between the readings moves it by a day, so either end's is right and nothing else is.
 */
function sinces(days: number, tz: string, from: number, to: number): string[] {
  return [...new Set([usageWindow(days, tz, from).since, usageWindow(days, tz, to).since])];
}

/** One `session/tokenUsage` as Muse sends it (the shape of the probe capture), with the pieces a test varies. */
function tokenUsage(over: { sessionId?: string; turnId: string; cursor: string; prompt?: number; output?: number; cumulative?: number; durationMs?: number; modelId?: string }) {
  const prompt = over.prompt ?? 1000;
  const output = over.output ?? 200;
  return {
    cumulative: { outputTokens: output, promptTokens: over.cumulative ?? prompt, totalTokens: (over.cumulative ?? prompt) + output },
    durationMs: over.durationMs ?? 4179,
    modelId: over.modelId ?? MODEL,
    promptTokens: prompt,
    sessionId: over.sessionId ?? "s1",
    totalTokens: prompt + output,
    turnId: over.turnId,
    usage: { cacheReadTokens: 0, cacheWriteTokens: 0, cachedTokens: 0, inputTokens: prompt, outputTokens: output, reasoningTokens: 8 },
    viewCursor: over.cursor,
  };
}

type Usage = ReturnType<typeof tokenUsage>;

/** An error reply the way Muse's client raises one: a message and the protocol's error kind. */
class KindError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

async function thread(sessionId = "s1") {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId } });
  connection.replies.set("view/page", { events: [], nextCursor: null });
  const { server, base } = await start(connection);
  await send(base, "/api/sessions", { cwd: "/work/ledger" });
  return { connection, server, base, store: server["store"] as AncillaStore };
}

function history(connection: FakeConnection, ...events: (Usage | { method: string; params: Record<string, unknown> })[]): void {
  connection.replies.set("view/page", {
    events: events.map((event) => ("method" in event ? event : { method: "session/tokenUsage", params: event })),
    nextCursor: null,
  });
}

const open = (base: string, id = "s1") => send(base, `/api/sessions/${id}/resume`, { refresh: true });
const callsOf = (report: any): number => report.buckets.reduce((sum: number, bucket: any) => sum + bucket.calls, 0);

/** A call written straight into the ledger, for the report tests that need rows at chosen instants. */
function seed(store: AncillaStore, sessionId: string, at: string, over: { key?: string; prompt?: number; output?: number; modelId?: string } = {}): void {
  const key = over.key ?? `${sessionId}:${at}:${over.prompt ?? 1000}`;
  store.recordUsage({
    key,
    sessionId,
    turnId: key,
    modelId: over.modelId ?? MODEL,
    promptTokens: over.prompt ?? 1000,
    outputTokens: over.output ?? 200,
    inputTokens: over.prompt ?? 1000,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: null,
    at,
    atSource: "live",
  });
}

describe("usage ledger: one model call seen live and read back from history", () => {
  // The probe capture numbers the same call ':8' live (streamed deltas take cursors) and ':6' in history.
  // Characterization: before the store matched a call by its tokens too, this counted 2.
  it("counts the call once when it was recorded live under one cursor and replayed under another", async () => {
    const { connection, base } = await thread();
    const turnId = uuidv7();
    connection.notify("session/tokenUsage", tokenUsage({ turnId, cursor: "v:s1:8" }));
    history(connection, tokenUsage({ turnId, cursor: "v:s1:6" }));
    const reply = await open(base);
    assert.equal(reply.status, 200);
    const report = await get(base, "/api/usage?days=7");
    assert.equal(callsOf(report), 1, "one call, not one per cursor");
    assert.equal(report.threads[0].calls, 1);
    assert.equal(report.threads[0].promptTokens, 1000);
    await open(base);
    assert.equal(callsOf(await get(base, "/api/usage?days=7")), 1, "and reopening adds nothing");
  });

  it("counts the call once when history was read first and the live notification arrives after", async () => {
    const { connection, base } = await thread();
    const turnId = uuidv7();
    history(connection, tokenUsage({ turnId, cursor: "v:s1:6" }));
    await open(base);
    connection.notify("session/tokenUsage", tokenUsage({ turnId, cursor: "v:s1:8" }));
    assert.equal(callsOf(await get(base, "/api/usage?days=7")), 1);
  });

  it("counts a call that carries no cursor once, however often the thread is read", async () => {
    const { connection, base } = await thread();
    const { viewCursor: _cursor, ...bare } = tokenUsage({ turnId: uuidv7(), cursor: "unused" });
    history(connection, bare as Usage);
    await open(base);
    await open(base);
    assert.equal(callsOf(await get(base, "/api/usage?days=7")), 1, "its key is random, so the tokens are what identify it");
  });

  it("counts two real calls of one turn as two", async () => {
    const { connection, base } = await thread();
    const turnId = uuidv7();
    history(connection, tokenUsage({ turnId, cursor: "v:s1:6", prompt: 1000 }), tokenUsage({ turnId, cursor: "v:s1:9", prompt: 1400, cumulative: 2400 }));
    await open(base);
    assert.equal(callsOf(await get(base, "/api/usage?days=7")), 2);
  });
});

describe("usage ledger: dating calls read back from history", () => {
  it("dates a replayed call from its turn, not from the moment the thread was opened", async () => {
    const { connection, base } = await thread();
    const minted = Date.now() - 10 * DAY;
    const turnId = uuidv7(minted);
    history(connection, tokenUsage({ turnId, cursor: "v:s1:1" }));
    await open(base);
    const report = await get(base, "/api/usage?days=30");
    const day = new Date(minted).toISOString().slice(0, 10);
    assert.deepEqual(report.buckets.map((bucket: any) => bucket.day), [day]);
    assert.equal(report.threads[0].lastAt, new Date(minted).toISOString());
    await open(base);
    const again = await get(base, "/api/usage?days=30");
    assert.equal(callsOf(again), 1, "reopening finds the same call");
    assert.equal(again.threads[0].lastAt, report.threads[0].lastAt, "and leaves its date alone");
  });

  it("prefers the time an item of the turn was recorded over the turn id's", async () => {
    const { connection, base } = await thread();
    const turnId = uuidv7(Date.now() - 10 * DAY);
    const recordedAt = new Date(Date.now() - 4 * DAY).toISOString().replace("Z", "123Z");
    const item = { itemId: "u1", kind: "userMessage", status: "completed", revision: 1, text: "hello", turnId, recordedAt };
    history(connection, { method: "item/completed", params: { sessionId: "s1", viewCursor: "v:s1:1", item } }, tokenUsage({ turnId, cursor: "v:s1:2" }));
    await open(base);
    const report = await get(base, "/api/usage?days=30");
    assert.equal(report.threads[0].lastAt, new Date(recordedAt).toISOString());
    assert.deepEqual(report.buckets.map((bucket: any) => bucket.day), [new Date(recordedAt).toISOString().slice(0, 10)]);
  });

  it("dates a call whose turn says nothing from the thread's own dates, never from the moment it was opened", async () => {
    const { connection, base, store } = await thread();
    const project = store.getProject("/work/ledger");
    assert.ok(project);
    // A thread last active twelve days ago, whose turn id carries no time and whose items carry none either.
    const createdAt = new Date(Date.now() - 14 * DAY).toISOString();
    const activityAt = new Date(Date.now() - 12 * DAY).toISOString();
    store.recordSession({ id: "old", projectId: project.id, origin: "muse", turnCount: 1, createdAt, activityAt });
    history(connection, tokenUsage({ sessionId: "old", turnId: "t1", cursor: "v:o:1" }));
    await open(base, "old");
    const report = await get(base, "/api/usage?days=30");
    assert.equal(report.threads.find((row: any) => row.sessionId === "old").lastAt, activityAt, "its last activity, not now");
    assert.deepEqual(report.buckets.map((row: any) => row.day), [activityAt.slice(0, 10)]);
  });

  it("lets a later read that can date the call from its turn move a call first dated from the thread", async () => {
    const { connection, base, store } = await thread();
    const project = store.getProject("/work/ledger");
    assert.ok(project);
    const activityAt = new Date(Date.now() - 12 * DAY).toISOString();
    store.recordSession({ id: "old", projectId: project.id, origin: "muse", turnCount: 1, createdAt: new Date(Date.now() - 14 * DAY).toISOString(), activityAt });
    history(connection, tokenUsage({ sessionId: "old", turnId: "t1", cursor: "v:o:1" }));
    await open(base, "old");
    assert.equal(store.listUsage().find((row) => row.sessionId === "old")?.at, activityAt, "seeded from the thread's dates");

    // The next read carries the turn's own first item: that is a verified date, and it is earlier.
    const recordedAt = new Date(Date.now() - 13 * DAY).toISOString();
    const item = { itemId: "u1", kind: "userMessage", status: "completed", revision: 1, text: "hello", turnId: "t1", recordedAt };
    history(
      connection,
      { method: "item/completed", params: { sessionId: "old", viewCursor: "v:o:0", item } },
      tokenUsage({ sessionId: "old", turnId: "t1", cursor: "v:o:1" }),
    );
    await open(base, "old");
    const moved = store.listUsage().find((row) => row.sessionId === "old");
    assert.equal(moved?.at, recordedAt);
    assert.equal(moved?.atSource, "replay");
    assert.equal(store.listUsage().filter((row) => row.sessionId === "old").length, 1, "still one call");

    // And a read that again knows only the thread's dates leaves the verified date where it is.
    history(connection, tokenUsage({ sessionId: "old", turnId: "t1", cursor: "v:o:1" }));
    await open(base, "old");
    assert.equal(store.listUsage().find((row) => row.sessionId === "old")?.at, recordedAt);
  });

  it("still dates a live call by when it arrived, even one that follows a replayed load", async () => {
    const { connection, base } = await thread();
    const minted = Date.now() - 10 * DAY;
    history(connection, tokenUsage({ turnId: uuidv7(minted), cursor: "v:s1:1" }));
    await open(base);
    connection.notify("session/tokenUsage", tokenUsage({ turnId: uuidv7(), cursor: "v:s1:20", prompt: 2000, cumulative: 3000 }));
    const report = await get(base, "/api/usage?days=30");
    assert.equal(callsOf(report), 2);
    assert.equal(report.buckets.length, 2, "two days: the replayed turn's and today");
    assert.ok(Date.now() - Date.parse(report.threads[0].lastAt) < 60_000, "the live call is dated now");
  });

  it("never moves a live stamp, even when the turn it belongs to began long before", async () => {
    const { connection, base } = await thread();
    const turnId = uuidv7(Date.now() - 3 * DAY);
    connection.notify("session/tokenUsage", tokenUsage({ turnId, cursor: "v:s1:8" }));
    history(connection, tokenUsage({ turnId, cursor: "v:s1:6" }));
    await open(base);
    const report = await get(base, "/api/usage?days=7");
    assert.equal(callsOf(report), 1);
    assert.ok(Date.now() - Date.parse(report.threads[0].lastAt) < 60_000, "still dated when it arrived");
  });

  it("repairs a row stored before dates were tracked when it is days late, and leaves a long turn alone", async () => {
    const { connection, base, store } = await thread();
    const minted = Date.now() - 10 * DAY;
    const openedAt = new Date().toISOString();
    // Two legacy rows, stored with no source: one stamped when the thread was opened long after its turn, the
    // other a call made 20 minutes into its turn.
    const late = uuidv7(minted);
    const longTurn = uuidv7(minted + DAY);
    for (const [key, turnId, at] of [["v:s1:1", late, openedAt], ["v:s1:2", longTurn, new Date(minted + DAY + 20 * 60_000).toISOString()]] as const) {
      store.recordUsage({
        key, sessionId: "s1", turnId, modelId: MODEL, promptTokens: key === "v:s1:1" ? 1000 : 1700, outputTokens: 200, inputTokens: 1000, cachedTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, durationMs: 4179, at,
      });
    }
    history(
      connection,
      tokenUsage({ turnId: late, cursor: "v:s1:1", prompt: 1000 }),
      tokenUsage({ turnId: longTurn, cursor: "v:s1:2", prompt: 1700, cumulative: 2700 }),
    );
    await open(base);
    const rows = Object.fromEntries(store.listUsage().map((row) => [row.key, row]));
    assert.equal(rows["v:s1:1"]?.at, new Date(minted).toISOString(), "moved back to its turn");
    assert.equal(rows["v:s1:1"]?.atSource, "replay");
    assert.equal(rows["v:s1:2"]?.at, new Date(minted + DAY + 20 * 60_000).toISOString(), "twenty minutes into its turn is where it ran");
    assert.equal(rows["v:s1:2"]?.atSource, null);
  });
});

describe("usage ledger: what the totals do not cover", () => {
  /** A history that never ends: every page holds one call and has another behind it, so the four-page limit cuts it short. */
  function endlessHistory(connection: FakeConnection, call: (page: number) => Record<string, unknown>): void {
    let page = 0;
    connection.replies.set("view/page", () => {
      page += 1;
      return { events: [{ method: "session/tokenUsage", params: call(page) }], nextCursor: `c${page}` };
    });
  }

  it("marks a thread partly counted when the history ran past the pages read and the calls read fall short of the total", async () => {
    const { connection, base } = await thread();
    // The newest call says the session had used 90000 prompt tokens; the four pages read hold about 4000 of them.
    endlessHistory(connection, (page) => tokenUsage({ turnId: uuidv7(), cursor: `v:s1:${page}`, prompt: 1000 + page, cumulative: 90_000 }));
    const reply = await open(base);
    assert.equal(reply.json.truncated, true);
    const report = await get(base, "/api/usage?days=7");
    assert.deepEqual(report.coverage, { countedThreads: 1, partialThreads: 1, uncountedThreads: 0 });
  });

  it("marks a cut-short history partly counted when nothing says what the total is", async () => {
    const { connection, base } = await thread();
    // No session total and no `cumulative` on the calls: the page limit is all there is to go by.
    endlessHistory(connection, (page) => {
      const { cumulative: _cumulative, ...bare } = tokenUsage({ turnId: uuidv7(), cursor: `v:s1:${page}`, prompt: 1000 + page });
      return bare;
    });
    const reply = await open(base);
    assert.equal(reply.json.truncated, true);
    assert.deepEqual((await get(base, "/api/usage?days=7")).coverage, { countedThreads: 1, partialThreads: 1, uncountedThreads: 0 });
  });

  it("does not call a long thread partly counted when every call in it was recorded live", async () => {
    const { connection, base } = await thread();
    const turnId = uuidv7();
    // Three calls seen as they ran: 1000 + 1100 + 1200 = 3300 prompt tokens, which is what the session says it used.
    connection.notify("session/tokenUsage", tokenUsage({ turnId, cursor: "v:s1:3", prompt: 1000, cumulative: 1000 }));
    connection.notify("session/tokenUsage", tokenUsage({ turnId, cursor: "v:s1:5", prompt: 1100, cumulative: 2100, durationMs: 4100 }));
    connection.notify("session/tokenUsage", tokenUsage({ turnId, cursor: "v:s1:7", prompt: 1200, cumulative: 3300, durationMs: 4200 }));
    // The thread's history is longer than the pages read, and the pages hold only its newest call.
    endlessHistory(connection, () => tokenUsage({ turnId, cursor: "v:s1:7", prompt: 1200, cumulative: 3300, durationMs: 4200 }));
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 9, tokenUsage: { promptTokens: 3300, outputTokens: 600, totalTokens: 3900 } },
    });
    const reply = await open(base);
    assert.equal(reply.json.truncated, true, "the page limit was hit");
    const report = await get(base, "/api/usage?days=7");
    assert.equal(report.threads[0].calls, 3);
    assert.equal(report.threads[0].promptTokens, 3300);
    assert.deepEqual(report.coverage, { countedThreads: 1, partialThreads: 0, uncountedThreads: 0 }, "nothing is missing, so nothing is said to be");
  });

  it("calls a thread complete when what it recorded reaches the session's own running total", async () => {
    const { connection, base } = await thread();
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1, tokenUsage: { promptTokens: 1500, outputTokens: 400, totalTokens: 1900 } },
    });
    const turnId = uuidv7();
    history(connection, tokenUsage({ turnId, cursor: "v:s1:1", prompt: 1000 }), tokenUsage({ turnId, cursor: "v:s1:2", prompt: 500, cumulative: 1500 }));
    await open(base);
    assert.deepEqual((await get(base, "/api/usage?days=7")).coverage, { countedThreads: 1, partialThreads: 0, uncountedThreads: 0 });
  });

  it("marks a thread partly counted when the session reports more than the history held", async () => {
    const { connection, base } = await thread();
    connection.replies.set("session/read", {
      session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 3, tokenUsage: { promptTokens: 9000, outputTokens: 900, totalTokens: 9900 } },
    });
    history(connection, tokenUsage({ turnId: uuidv7(), cursor: "v:s1:1", prompt: 1500 }));
    await open(base);
    assert.equal((await get(base, "/api/usage?days=7")).coverage.partialThreads, 1);
  });

  it("reads the running total off the newest call when the session reports none", async () => {
    const { connection, base } = await thread();
    // The call says the session had used 5000 prompt tokens by then; the page held only this one call of 1000.
    history(connection, tokenUsage({ turnId: uuidv7(), cursor: "v:s1:9", prompt: 1000, cumulative: 5000 }));
    await open(base);
    assert.equal((await get(base, "/api/usage?days=7")).coverage.partialThreads, 1);
  });

  // A session can state what it has used in more than one place; each one that is read must count.
  const idle = { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 3 };
  const totals: [string, Record<string, unknown>][] = [
    ["the session's tokenUsage", { session: { ...idle, tokenUsage: { promptTokens: 9000, outputTokens: 900, totalTokens: 9900 } } }],
    ["the session's cumulative tokenUsage", { session: { ...idle, tokenUsage: { cumulative: { promptTokens: 9000, outputTokens: 900, totalTokens: 9900 } } } }],
    ["the history snapshot's state", { session: idle, history: { mode: "snapshot", snapshot: { state: { items: [], tokenUsage: { promptTokens: 9000 } } } } }],
  ];
  for (const [place, reply] of totals) {
    it(`reads the running total off ${place}`, async () => {
      const { connection, base } = await thread();
      connection.replies.set("session/read", reply);
      // The one call read has 1500 prompt tokens (and says 1500 of its own), so only the stated 9000 shows what is missing.
      history(connection, tokenUsage({ turnId: uuidv7(), cursor: "v:s1:1", prompt: 1500 }));
      await open(base);
      assert.equal((await get(base, "/api/usage?days=7")).coverage.partialThreads, 1);
    });
  }

  it("leaves a thread complete when none of those places says more than was recorded", async () => {
    const { connection, base } = await thread();
    connection.replies.set("session/read", { session: { ...idle, tokenUsage: { promptTokens: 1500 } } });
    history(connection, tokenUsage({ turnId: uuidv7(), cursor: "v:s1:1", prompt: 1500 }));
    await open(base);
    assert.equal((await get(base, "/api/usage?days=7")).coverage.partialThreads, 0);
  });

  it("leaves an earlier verdict alone when the history could not be paged at all", async () => {
    for (const kind of ["sessionInUse", "sessionNotLoaded"]) {
      const { connection, base } = await thread();
      // The one call read says the session had used 5000 prompt tokens by then; only 1500 of them are here.
      history(connection, tokenUsage({ turnId: uuidv7(), cursor: "v:s1:1", prompt: 1500, cumulative: 5000 }));
      await open(base);
      assert.equal((await get(base, "/api/usage?days=7")).coverage.partialThreads, 1, "read in part to begin with");
      // Another client now holds the thread, or this host has not loaded it: view/page answers with an error, and
      // with no calls and no session total the unread history would otherwise look like a complete one.
      connection.replies.set("view/page", new KindError("held elsewhere", kind));
      const again = await open(base);
      assert.equal(again.status, 200, kind);
      const report = await get(base, "/api/usage?days=7");
      assert.equal(report.coverage.partialThreads, 1, `${kind}: nothing was read, so it is still partly counted`);
      assert.equal(report.threads[0].calls, 1, "and its calls are untouched");
    }
  });

  it("keeps a thread nobody has read counted as unread when its history cannot be paged", async () => {
    const { connection, base, store } = await thread();
    const project = store.getProject("/work/ledger");
    assert.ok(project);
    store.recordSession({ id: "muse-only", projectId: project.id, origin: "muse", turnCount: 2 });
    connection.replies.set("view/page", new KindError("held by the TUI", "sessionInUse"));
    const reply = await open(base, "muse-only");
    assert.equal(reply.status, 200);
    assert.equal((await get(base, "/api/usage?days=7")).coverage.uncountedThreads, 1, "a failed read counts nothing, so it clears nothing");
    // Once its history can be read, the thread is counted.
    history(connection, tokenUsage({ sessionId: "muse-only", turnId: uuidv7(), cursor: "v:m:1" }));
    await open(base, "muse-only");
    assert.deepEqual((await get(base, "/api/usage?days=7")).coverage, { countedThreads: 1, partialThreads: 0, uncountedThreads: 0 });
  });

  it("forgets the verdict once a later read finds everything", async () => {
    const { connection, base } = await thread();
    const turnId = uuidv7();
    history(connection, tokenUsage({ turnId, cursor: "v:s1:9", prompt: 1000, cumulative: 1500 }));
    await open(base);
    assert.equal((await get(base, "/api/usage?days=7")).coverage.partialThreads, 1);
    history(connection, tokenUsage({ turnId, cursor: "v:s1:8", prompt: 500, cumulative: 500 }), tokenUsage({ turnId, cursor: "v:s1:9", prompt: 1000, cumulative: 1500 }));
    await open(base);
    assert.equal((await get(base, "/api/usage?days=7")).coverage.partialThreads, 0);
  });

  it("counts a thread nothing here has read, until it is opened", async () => {
    const { connection, base, store } = await thread();
    const project = store.getProject("/work/ledger");
    assert.ok(project);
    store.recordSession({ id: "muse-only", projectId: project.id, origin: "muse", turnCount: 2 });
    store.recordSession({ id: "archived-one", projectId: project.id, origin: "muse", turnCount: 2 });
    store.updateSession("archived-one", { archived: true });
    store.recordSession({ id: "worker", projectId: project.id, origin: "research-worker", turnCount: 4 });
    store.recordSession({ id: "empty", projectId: project.id, origin: "muse", turnCount: 0 });
    const before = (await get(base, "/api/usage?days=7")).coverage;
    assert.deepEqual(before, { countedThreads: 0, partialThreads: 0, uncountedThreads: 1 });

    history(connection, tokenUsage({ sessionId: "muse-only", turnId: uuidv7(), cursor: "v:m:1" }));
    await open(base, "muse-only");
    assert.deepEqual((await get(base, "/api/usage?days=7")).coverage, { countedThreads: 1, partialThreads: 0, uncountedThreads: 0 });
  });

  it("does not call a thread uncounted when it was read in full and held no calls", async () => {
    const { base, store } = await thread();
    const project = store.getProject("/work/ledger");
    assert.ok(project);
    store.recordSession({ id: "quiet", projectId: project.id, origin: "muse", turnCount: 1 });
    assert.equal((await get(base, "/api/usage?days=7")).coverage.uncountedThreads, 1);
    await open(base, "quiet");
    assert.equal((await get(base, "/api/usage?days=7")).coverage.uncountedThreads, 0);
  });
});

describe("usage ledger: days in the viewer's zone", () => {
  it("echoes the zone and starts the window at a local midnight, counting today as the first of the days", async () => {
    const { base } = await thread();
    // The server reads the clock for each request, so one clock reading before and one after are the two answers
    // either can be (a midnight in between moves a window by a day); nothing here compares two requests with each other.
    const before = Date.now();
    const week = await get(base, "/api/usage?days=7&tz=Asia/Kolkata");
    const today = await get(base, "/api/usage?days=1&tz=Asia/Kolkata");
    const after = Date.now();
    assert.equal(week.tz, resolveZone("Asia/Kolkata"), "the zone as Intl spells it");
    assert.equal(week.days, 7);
    assert.match(week.since, /T18:30:00\.000Z$/, "Kolkata midnight is 18:30 UTC");
    assert.ok(sinces(7, "Asia/Kolkata", before, after).includes(week.since), `${week.since} is a 7 day window`);
    assert.ok(sinces(1, "Asia/Kolkata", before, after).includes(today.since), `${today.since} is a 1 day window`);
    assert.equal((Date.parse(usageWindow(1, "Asia/Kolkata", before).since) - Date.parse(usageWindow(7, "Asia/Kolkata", before).since)) / DAY, 6, "seven days is today and the six before");
    assert.ok(Date.parse(today.since) <= after && before - Date.parse(today.since) < DAY, "today began within the last 24 hours");
  });

  it("uses UTC days with no zone or one that is not known, and says so", async () => {
    const { base } = await thread();
    for (const query of ["days=7", "days=7&tz=", "days=7&tz=Mars/Olympus"]) {
      const report = await get(base, `/api/usage?${query}`);
      assert.equal(report.tz, "UTC", query);
      assert.match(report.since, /T00:00:00\.000Z$/, query);
    }
    const before = Date.now();
    const sixAgo = (await get(base, "/api/usage?days=7")).since;
    const after = Date.now();
    assert.ok(sinces(7, "UTC", before, after).includes(sixAgo), "7 days starts six midnights back");
    assert.equal((await get(base, "/api/usage")).days, 30, "30 days when none is asked for");
  });

  it("books an evening call on the day it was made", async () => {
    const { base, store } = await thread();
    const day = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
    seed(store, "s1", `${day}T02:30:00.000Z`, { prompt: 1001 });
    seed(store, "s1", `${day}T23:30:00.000Z`, { prompt: 1002 });
    const before = new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
    const after = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    const days = async (tz?: string) =>
      (await get(base, `/api/usage?days=30${tz ? `&tz=${tz}` : ""}`)).buckets.map((bucket: any) => [bucket.day, bucket.calls]);
    assert.deepEqual(await days(), [[day, 2]], "UTC: both on the UTC day");
    assert.deepEqual(await days("America/Panama"), [[before, 1], [day, 1]], "UTC-5: 02:30Z is the evening before");
    assert.deepEqual(await days("Asia/Kolkata"), [[day, 1], [after, 1]], "UTC+5:30: 23:30Z is the next morning");
  });

  it("keeps a call just before the window out and one just after its first midnight in", async (t) => {
    const { base, store } = await thread();
    const first = Date.parse((await get(base, "/api/usage?days=7&tz=America/Panama")).since);
    seed(store, "s1", new Date(first - 60_000).toISOString(), { prompt: 1001 });
    seed(store, "s1", new Date(first + 60_000).toISOString(), { prompt: 1002 });
    seed(store, "s1", new Date(first + DAY - 60_000).toISOString(), { prompt: 1003 });
    seed(store, "s1", new Date(first + DAY + 60_000).toISOString(), { prompt: 1004 });
    const report = await get(base, "/api/usage?days=7&tz=America/Panama");
    if (Date.parse(report.since) !== first) {
      // The server reads the clock for each request, and a local midnight fell between the two: the window moved by a
      // day, so the edges seeded around the first one are not this one's. Nothing to check on such a run.
      t.skip("a local midnight fell between the two requests");
      return;
    }
    assert.equal(callsOf(report), 3);
    assert.equal(report.buckets.length, 2);
    assert.deepEqual(report.buckets.map((bucket: any) => bucket.calls), [2, 1], "two on the first local day, one on the next");
  });
});

describe("usage ledger: DeepResearch workers and accounts in the report", () => {
  it("folds a project's worker sessions into one row and keeps the totals reconciled", async () => {
    const { base, store } = await thread();
    const project = store.getProject("/work/ledger");
    assert.ok(project);
    const now = Date.now();
    for (let index = 0; index < 12; index += 1) {
      store.recordSession({ id: `t${index}`, projectId: project.id, title: `Thread ${index}`, turnCount: 1 });
      seed(store, `t${index}`, new Date(now - index * 60_000).toISOString(), { prompt: 1000 + index });
    }
    store.recordSession({ id: "w1", projectId: project.id, title: "Research worker A1", origin: "research-worker", turnCount: 1 });
    store.recordSession({ id: "w2", projectId: project.id, title: "Research worker A2", origin: "research-worker", turnCount: 1 });
    store.updateSession("w1", { archived: true });
    store.updateSession("w2", { archived: true });
    seed(store, "w1", new Date(now - 30_000).toISOString(), { prompt: 5000, output: 400 });
    seed(store, "w2", new Date(now - 20_000).toISOString(), { prompt: 7000, output: 600 });

    const report = await get(base, "/api/usage?days=7");
    assert.equal(report.threads.length, 13, "12 threads and one folded row");
    const research = report.threads.filter((thread: any) => thread.kind === "research");
    assert.equal(research.length, 1);
    assert.equal(research[0].title, "DeepResearch workers");
    assert.equal(research[0].cwd, "/work/ledger");
    assert.equal(research[0].calls, 2);
    assert.equal(research[0].promptTokens, 12_000);
    assert.equal(research[0].outputTokens, 1000);
    assert.ok(!report.threads.some((thread: any) => ["w1", "w2"].includes(thread.sessionId)), "no worker session is a row of its own");
    assert.ok(research[0].sessionId.startsWith("research-workers:"), "its id cannot be a thread's");
    assert.equal(report.threads.filter((thread: any) => thread.kind === undefined).length, 12);
    const sum = (rows: any[], field: string) => rows.reduce((total, row) => total + row[field], 0);
    for (const field of ["calls", "promptTokens", "outputTokens"]) {
      assert.equal(sum(report.threads, field), sum(report.buckets, field), `threads and buckets agree on ${field}`);
    }
    assert.equal(report.coverage.countedThreads, 12, "workers are no threads");
  });

  it("carries the login a thread runs under, and folds workers of different logins apart", async () => {
    const { base, store } = await thread();
    const project = store.getProject("/work/ledger");
    assert.ok(project);
    const at = new Date().toISOString();
    store.recordSession({ id: "named", projectId: project.id, title: "On the work login", accountId: "work", turnCount: 1 });
    store.recordSession({ id: "wd", projectId: project.id, origin: "research-worker", turnCount: 1 });
    store.recordSession({ id: "ww", projectId: project.id, origin: "research-worker", accountId: "work", turnCount: 1 });
    seed(store, "s1", at, { prompt: 1001 });
    seed(store, "named", at, { prompt: 1002 });
    seed(store, "wd", at, { prompt: 1003 });
    seed(store, "ww", at, { prompt: 1004 });
    const report = await get(base, "/api/usage?days=7");
    const byTitle = (title: string) => report.threads.filter((thread: any) => thread.title === title);
    assert.equal(byTitle("On the work login")[0].accountId, "work");
    assert.equal(report.threads.find((thread: any) => thread.sessionId === "s1").accountId, null, "the default login is null");
    const research = byTitle("DeepResearch workers");
    assert.deepEqual(research.map((thread: any) => thread.accountId).sort(), [null, "work"].sort(), "one row per login, never a row that mixes two");
    assert.equal(new Set(research.map((thread: any) => thread.sessionId)).size, 2);
  });
});
