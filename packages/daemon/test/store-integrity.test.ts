/**
 * The store's integrity: foreign keys and busy waits on the connection, the transaction helper, and a turn ledger
 * that is idempotent (replays change nothing, the counter moves once per turn) and atomic.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore, isStoreBusy } from "../src/store.js";

const dirsToRemove = new Set<string>();

/**
 * A database in a temp folder that is removed as the test process exits, not in an `after` hook: hooks run in the
 * order they were registered, the hook that closes the store comes after this one, and on Windows an open SQLite
 * file cannot be deleted. By the exit every hook has run; a folder that still cannot be removed is left.
 */
function tmpDb(): { path: string; open: () => DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "ancilla-store-integrity-"));
  if (dirsToRemove.size === 0) {
    process.once("exit", () => {
      for (const path of dirsToRemove) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    });
  }
  dirsToRemove.add(dir);
  const path = join(dir, "ancilla.db");
  return { path, open: () => new DatabaseSync(path) };
}

function seeded(path = ":memory:"): AncillaStore {
  const store = new AncillaStore(path);
  after(() => store.close());
  const project = store.upsertProject("/work/p");
  store.recordSession({ id: "s1", projectId: project.id });
  return store;
}

const count = (store: AncillaStore, sessionId = "s1"): number => store.getSession(sessionId)?.turnCount ?? -1;

function turnRows(open: () => DatabaseSync): { id: string; status: string }[] {
  const db = open();
  try {
    return (db.prepare("SELECT id, status FROM turns ORDER BY id").all() as { id: string; status: string }[]).map((row) => ({ id: String(row.id), status: String(row.status) }));
  } finally {
    db.close();
  }
}

describe("the turn ledger", () => {
  it("keeps one row and counts the turn once when it is finished twice", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    store.registerTurn("t1", "s1");
    store.finishTurn("t1", "s1", "completed");
    store.finishTurn("t1", "s1", "completed");
    assert.deepEqual(turnRows(open), [{ id: "t1", status: "completed" }]);
    assert.equal(count(store), 1);
  });

  it("counts a turn that was finished without ever being registered", () => {
    const store = seeded();
    store.finishTurn("t1", "s1", "completed");
    assert.equal(count(store), 1);
  });

  it("never reopens a finished turn when its start is replayed", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    store.finishTurn("t1", "s1", "completed");
    store.registerTurn("t1", "s1");
    assert.deepEqual(turnRows(open), [{ id: "t1", status: "completed" }]);
    assert.equal(count(store), 1);
  });

  it("raises a thread Muse reported at 50 turns to 53 after three completions", () => {
    const store = seeded();
    store.recordSession({ id: "s1", projectId: store.upsertProject("/work/p").id, turnCount: 50 });
    assert.equal(count(store), 50);
    for (const id of ["a", "b", "c"]) {
      store.registerTurn(id, "s1");
      store.finishTurn(id, "s1", "completed");
    }
    assert.equal(count(store), 53, "a count derived from the rows would have read 3 and then 50");
    store.finishTurn("c", "s1", "completed");
    assert.equal(count(store), 53);
  });

  it("lets the last status win and counts once when a failed turn is later completed", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    store.registerTurn("t1", "s1");
    store.finishTurn("t1", "s1", "failed");
    store.finishTurn("t1", "s1", "completed");
    assert.deepEqual(turnRows(open), [{ id: "t1", status: "completed" }]);
    assert.equal(count(store), 1);
  });

  it("counts a turn left unknown by a restart once, when it finishes later", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    store.registerTurn("t1", "s1");
    store.registerTurn("t2", "s1");
    store.finishTurn("t2", "s1", "completed");
    assert.equal(store.markRunningTurnsUnknown(), 1, "only the turn still running is swept");
    assert.deepEqual(turnRows(open), [{ id: "t1", status: "unknown" }, { id: "t2", status: "completed" }]);
    assert.equal(count(store), 1);
    store.finishTurn("t1", "s1", "completed");
    store.finishTurn("t1", "s1", "completed");
    assert.equal(count(store), 2);
    assert.equal(store.markRunningTurnsUnknown(), 0);
  });

  it("keeps recordTurn as a wrapper that counts a turn once", () => {
    const store = seeded();
    const first = store.recordTurn("t1", "s1");
    assert.equal(first.id, "t1");
    store.recordTurn("t1", "s1");
    store.updateTurnStatus("t1", "completed");
    assert.equal(count(store), 1);
  });

  it("leaves no turn row when the counter statement fails", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    const other = open();
    other.exec("CREATE TRIGGER fail_counter BEFORE UPDATE OF turn_count ON sessions BEGIN SELECT RAISE(ABORT, 'injected'); END");
    assert.throws(() => store.finishTurn("t1", "s1", "completed"), /injected/);
    assert.deepEqual(turnRows(open), [], "the insert was rolled back with the counter");
    assert.equal(count(store), 0);
    other.exec("DROP TRIGGER fail_counter");
    other.close();
    store.finishTurn("t1", "s1", "completed");
    assert.equal(count(store), 1, "the store is usable again after the failure");
  });

  it("refuses a turn of a session it does not know and writes nothing", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    assert.throws(() => store.finishTurn("t1", "unknown-session", "completed"), /FOREIGN KEY/i);
    assert.deepEqual(turnRows(open), []);
  });

  it("keeps a turn with the thread it was first seen on: another thread finishing the same id neither moves nor counts it", () => {
    const store = seeded();
    store.recordSession({ id: "s2", projectId: store.upsertProject("/work/p").id });
    store.finishTurn("shared", "s1", "completed");
    const answer = store.finishTurn("shared", "s2", "failed");
    assert.equal(answer.sessionId, "s1", "the row still belongs to the first thread");
    assert.equal(answer.status, "completed", "and says what it said");
    assert.deepEqual(store.listTurns("s1").map((turn) => turn.id), ["shared"]);
    assert.deepEqual(store.listTurns("s2"), []);
    assert.equal(count(store, "s1"), 1);
    assert.equal(count(store, "s2"), 0);
  });
});

describe("the connection", () => {
  it("has foreign keys on and a short steady wait", () => {
    const { path } = tmpDb();
    const store = seeded(path);
    const info = store.connectionInfo();
    assert.equal(info.foreignKeys, true);
    assert.ok(info.busyTimeoutMs >= 50 && info.busyTimeoutMs <= 250, `steady wait ${info.busyTimeoutMs} ms`);
    assert.equal(seeded().connectionInfo().foreignKeys, true);
  });

  it("reports a busy write after a short wait instead of hanging", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    const holder = open();
    holder.exec("BEGIN IMMEDIATE");
    const t0 = Date.now();
    let caught: unknown = null;
    try {
      store.updateSession("s1", { title: "x" });
    } catch (error) {
      caught = error;
    }
    const waited = Date.now() - t0;
    holder.exec("ROLLBACK");
    holder.close();
    assert.ok(isStoreBusy(caught), `a busy error, got ${String(caught)}`);
    assert.ok(waited >= 40, `the write waited ${waited} ms before giving up`);
    assert.ok(waited < 3000, `the write held the event loop for ${waited} ms`);
  });

  it("waits at construction for a writer that holds the database", async () => {
    const { path } = tmpDb();
    const first = new AncillaStore(path);
    first.close();
    const script = [
      'const { DatabaseSync } = require("node:sqlite");',
      "const db = new DatabaseSync(process.argv[1]);",
      'db.exec("PRAGMA busy_timeout = 5000");',
      'db.exec("BEGIN IMMEDIATE");',
      "db.exec(\"INSERT INTO settings (key, value) VALUES ('hold', '1')\");",
      'process.stdout.write("locked\\n");',
      'setTimeout(() => { db.exec("COMMIT"); db.close(); process.exit(0); }, 2000);',
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script, path], { stdio: ["ignore", "pipe", "inherit"] });
    after(() => child.kill());
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("locked")) resolve();
      });
      child.once("exit", () => reject(new Error("the lock holder exited before it held the lock")));
    });
    const t0 = Date.now();
    const store = new AncillaStore(path);
    const waited = Date.now() - t0;
    after(() => store.close());
    assert.ok(waited < 20_000, `boot waited ${waited} ms`);
    assert.equal(store.connectionInfo().foreignKeys, true);
    assert.equal(store.getSession("s1"), null, "and the store works once the writer let go");
  });
});

describe("store.transaction", () => {
  it("commits the outermost and rolls an inner failure back on its own", () => {
    const store = seeded();
    store.transaction(() => {
      store.updateSession("s1", { title: "outer" });
      assert.throws(() =>
        store.transaction(() => {
          store.updateSession("s1", { title: "inner" });
          throw new Error("inner failed");
        }),
      /inner failed/);
      assert.equal(store.getSession("s1")?.title, "outer", "the inner write is gone, the outer one stands");
    });
    assert.equal(store.getSession("s1")?.title, "outer");
  });

  it("rolls everything back, nested successes included, when the outermost throws", () => {
    const store = seeded();
    assert.throws(() =>
      store.transaction(() => {
        store.transaction(() => store.updateSession("s1", { title: "inner ok" }));
        store.updateSession("s1", { title: "outer" });
        throw new Error("outer failed");
      }),
    /outer failed/);
    assert.notEqual(store.getSession("s1")?.title, "inner ok");
    assert.notEqual(store.getSession("s1")?.title, "outer");
    store.transaction(() => store.updateSession("s1", { title: "after" }));
    assert.equal(store.getSession("s1")?.title, "after", "no transaction was left open");
  });

  it("returns what the function returns", () => {
    const store = seeded();
    assert.equal(store.transaction(() => 42), 42);
  });

  it("rolls back and rethrows when the commit itself fails, leaving the store usable", () => {
    const { path, open } = tmpDb();
    const store = seeded(path);
    const reader = open();
    // A reader mid-transaction holds a shared lock, which a rollback-journal commit cannot get past.
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM sessions").all();
    let caught: unknown = null;
    try {
      store.transaction(() => store.updateSession("s1", { title: "never committed" }));
    } catch (error) {
      caught = error;
    }
    assert.ok(isStoreBusy(caught), `the commit failed busy, got ${String(caught)}`);
    reader.exec("ROLLBACK");
    reader.close();
    assert.notEqual(store.getSession("s1")?.title, "never committed");
    store.transaction(() => store.updateSession("s1", { title: "second try" }));
    assert.equal(store.getSession("s1")?.title, "second try");
  });

  it("refuses an async function and rolls its writes back", async () => {
    const store = seeded();
    assert.throws(
      () =>
        store.transaction((() => {
          store.updateSession("s1", { title: "async write" });
          return Promise.reject(new Error("late"));
        }) as unknown as () => void),
      /synchronous/i,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(store.getSession("s1")?.title, "async write");
    store.transaction(() => store.updateSession("s1", { title: "still works" }));
    assert.equal(store.getSession("s1")?.title, "still works");
  });
});

describe("isStoreBusy", () => {
  it("recognises SQLITE_BUSY and SQLITE_LOCKED and nothing else", () => {
    assert.equal(isStoreBusy(Object.assign(new Error("database is locked"), { errcode: 5 })), true);
    assert.equal(isStoreBusy(Object.assign(new Error("database table is locked"), { errcode: 6 })), true);
    assert.equal(isStoreBusy(Object.assign(new Error("busy"), { errcode: 261 })), true, "an extended busy code");
    assert.equal(isStoreBusy(Object.assign(new Error("constraint failed"), { errcode: 19 })), false);
    assert.equal(isStoreBusy(new Error("boom")), false);
    assert.equal(isStoreBusy(null), false);
  });
});

describe("research rows the lifecycle writes", () => {
  const config = { windowMinMinutes: 1 } as never;
  function withRun(): { store: AncillaStore; runId: string } {
    const store = seeded();
    const run = store.createResearchRun({ id: "r1", sessionId: "s1", commandId: "c1", question: "q", config });
    store.updateResearchRun(run.id, { status: "running" });
    return { store, runId: run.id };
  }

  it("changes a run's row only when its status is one of the expected ones", () => {
    const { store, runId } = withRun();
    const done = store.updateResearchRunIf(runId, ["queued", "running"], { status: "interrupted", endedAt: "2026-10-13T10:00:00.000Z" });
    assert.equal(done?.status, "interrupted");
    const again = store.updateResearchRunIf(runId, ["queued", "running"], { status: "failed", failure: "late" });
    assert.equal(again, null, "a run that already ended is left as it is");
    assert.equal(store.getResearchRun(runId)?.status, "interrupted");
    assert.equal(store.getResearchRun(runId)?.failure, null);
  });

  it("closes only the worker rows still working", () => {
    const { store, runId } = withRun();
    store.addResearchWorker({ runId, workerSessionId: "w1", round: 1, agentId: 1, status: "working" });
    store.addResearchWorker({ runId, workerSessionId: "w2", round: 1, agentId: 2, status: "completed" });
    assert.equal(store.closeResearchWorkers(runId), 1);
    assert.deepEqual(store.listResearchWorkers(runId).map((w) => [w.agentId, w.status]), [[1, "cancelled"], [2, "completed"]]);
  });

  it("dates the last event the engine wrote, not one the host added", () => {
    const { store, runId } = withRun();
    const event = (seq: number, type: "run_started" | "supervisor_iteration" | "run_interrupted", at: string) =>
      store.appendResearchEvent({ type, runId, seq, at, phase: null, round: null, agentId: null, payload: {} });
    assert.equal(store.lastResearchEventAt(runId, ["run_interrupted"]), null);
    event(1, "run_started", "2026-10-13T10:00:00.000Z");
    event(2, "supervisor_iteration", "2026-10-13T10:05:00.000Z");
    event(3, "run_interrupted", "2026-10-13T12:00:00.000Z");
    assert.equal(store.lastResearchEventAt(runId, ["run_interrupted"]), "2026-10-13T10:05:00.000Z");
    assert.equal(store.lastResearchEventAt(runId, []), "2026-10-13T12:00:00.000Z");
  });
});
