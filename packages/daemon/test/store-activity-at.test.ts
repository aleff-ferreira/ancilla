import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore } from "../src/store.js";

const CREATED = "2026-01-01T09:00:00.000Z";
const LAST_ACTIVE = "2026-01-02T18:30:00.000Z";
/** A window that opens long after both, so a thread last active in January is not active in it. */
const SINCE = "2026-10-01T00:00:00.000Z";

function open(): AncillaStore {
  const store = new AncillaStore();
  after(() => store.close());
  return store;
}

/** The stored column itself, which the record hides behind `updated_at` when it is NULL. */
function rawActivity(store: AncillaStore, id: string): string | null {
  const row = (store["db"] as DatabaseSync).prepare("SELECT activity_at FROM sessions WHERE id = ?").get(id) as { activity_at: string | null };
  return row.activity_at;
}

/** A thread as an install from before `activity_at` has it: a date it was made, a later one a sync bumped, none for activity. */
function makeLegacy(store: AncillaStore, id: string, over: { updatedAt?: string } = {}): void {
  (store["db"] as DatabaseSync)
    .prepare("UPDATE sessions SET activity_at = NULL, updated_at = ? WHERE id = ?")
    .run(over.updatedAt ?? "2026-10-12T08:00:00.000Z", id);
}

describe("threads from before activity_at on the usage page's coverage", () => {
  it("does not call a thread dormant since January 'not read yet' in an October window", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    store.recordSession({ id: "old", projectId: project.id, turnCount: 3, createdAt: CREATED, activityAt: LAST_ACTIVE });
    makeLegacy(store, "old");
    assert.equal(store.usageCoverage(SINCE).uncountedThreads, 0, "its updated_at is a sync's, not its activity");
    assert.equal(store.usageCoverage("2026-01-01T00:00:00.000Z").uncountedThreads, 1, "it is still counted for a window that covers its day");
  });

  it("writes the date Muse gives when a legacy thread is synced once, and stays out of the window", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    store.recordSession({ id: "old", projectId: project.id, turnCount: 3, createdAt: CREATED, activityAt: LAST_ACTIVE });
    makeLegacy(store, "old");

    // A discovery sync: it carries the model, which makes it a write that bumps updated_at to now.
    store.recordSession({ id: "old", projectId: project.id, modelId: "muse-spark-1.3", activityAt: LAST_ACTIVE });
    assert.equal(rawActivity(store, "old"), LAST_ACTIVE, "the column holds Muse's own date now");
    assert.equal(store.usageCoverage(SINCE).uncountedThreads, 0, "so a window after its activity does not count it");
    assert.equal(store.getSession("old")?.activityAt, LAST_ACTIVE);
  });

  it("still counts a legacy thread that was active in the window, once a sync says so", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    store.recordSession({ id: "old", projectId: project.id, turnCount: 3, createdAt: CREATED, activityAt: LAST_ACTIVE });
    makeLegacy(store, "old");
    assert.equal(store.usageCoverage(SINCE).uncountedThreads, 0);
    store.recordSession({ id: "old", projectId: project.id, modelId: "muse-spark-1.3", activityAt: "2026-10-05T10:00:00.000Z" });
    assert.equal(store.usageCoverage(SINCE).uncountedThreads, 1, "it did run in October and nothing here has read it");
  });

  it("falls back to the day the thread was made when a sync has no date to give", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    store.recordSession({ id: "old", projectId: project.id, turnCount: 3, createdAt: CREATED, activityAt: LAST_ACTIVE });
    makeLegacy(store, "old");
    store.recordSession({ id: "old", projectId: project.id, modelId: "muse-spark-1.3" });
    assert.equal(rawActivity(store, "old"), CREATED);
  });

  it("leaves a thread that has an activity date alone, and an older date from Muse never moves it back", () => {
    const store = open();
    const project = store.upsertProject("/work/app");
    store.recordSession({ id: "new", projectId: project.id, turnCount: 3, createdAt: CREATED, activityAt: LAST_ACTIVE });
    store.recordSession({ id: "new", projectId: project.id, modelId: "muse-spark-1.3", activityAt: "2026-01-01T12:00:00.000Z" });
    assert.equal(rawActivity(store, "new"), LAST_ACTIVE);
    store.recordSession({ id: "new", projectId: project.id, modelId: "muse-spark-1.3", activityAt: "2026-02-01T12:00:00.000Z" });
    assert.equal(rawActivity(store, "new"), "2026-02-01T12:00:00.000Z", "a later one moves it forward");
  });
});

describe("opening a database made before activity_at existed", () => {
  it("adds the column, gives the old threads the day they were made, keeps the rows and opens again cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-activity-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    // The tables as the first release made them: a thread has no activity_at, and a sync has bumped its updated_at.
    old.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cwd TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL DEFAULT 'New session',
        status TEXT NOT NULL DEFAULT 'active',
        turn_count INTEGER NOT NULL DEFAULT 0,
        model_id TEXT,
        origin TEXT NOT NULL DEFAULT 'ancilla',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects (cwd, display_name, created_at, updated_at)
        VALUES ('/work/old', 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO sessions (id, project_id, title, turn_count, model_id, origin, created_at, updated_at)
        VALUES ('legacy', 1, 'An old thread', 4, 'muse-spark-1.2', 'tui', '${CREATED}', '2026-10-12T08:00:00.000Z');
      INSERT INTO sessions (id, project_id, title, turn_count, origin, created_at, updated_at)
        VALUES ('legacy-2', 1, 'Another one', 1, 'ancilla', '2026-03-03T10:00:00.000Z', '2026-10-12T08:00:00.000Z');
    `);
    assert.equal((old.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).some((c) => c.name === "activity_at"), false);
    old.close();

    const first = new AncillaStore(path);
    const legacy = first.getSession("legacy");
    assert.equal(legacy?.title, "An old thread", "the rows are kept");
    assert.equal(legacy?.turnCount, 4);
    assert.equal(legacy?.modelId, "muse-spark-1.2");
    assert.equal(legacy?.origin, "tui");
    assert.equal(rawActivity(first, "legacy"), CREATED, "the thread has the day it was made, not the day a sync bumped");
    assert.equal(rawActivity(first, "legacy-2"), "2026-03-03T10:00:00.000Z");
    assert.equal(first.usageCoverage(SINCE).uncountedThreads, 0, "so neither is 'not read yet' for a window long after");
    assert.equal(first.usageCoverage("2026-01-01T00:00:00.000Z").uncountedThreads, 2);
    // A sync that sees newer activity moves it forward, and that is what a later open must not undo.
    first.recordSession({ id: "legacy", projectId: 1, modelId: "muse-spark-1.3", activityAt: "2026-10-05T10:00:00.000Z" });
    assert.equal(rawActivity(first, "legacy"), "2026-10-05T10:00:00.000Z");
    first.close();

    const second = new AncillaStore(path);
    after(() => second.close());
    assert.equal(rawActivity(second, "legacy"), "2026-10-05T10:00:00.000Z", "opening again leaves what a sync wrote");
    assert.equal(rawActivity(second, "legacy-2"), "2026-03-03T10:00:00.000Z");
    assert.equal(second.getSession("legacy")?.title, "An old thread");
    const check = new DatabaseSync(path);
    const columns = (check.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).filter((c) => c.name === "activity_at");
    check.close();
    assert.equal(columns.length, 1, "the column is added once");
  });
});
