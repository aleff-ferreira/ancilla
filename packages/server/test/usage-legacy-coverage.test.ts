import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AncillaStore } from "@ancilla/daemon";
import { FakeConnection, get, send, start } from "./harness.js";

const DAY = 86_400_000;

describe("the usage page's coverage for threads from before activity_at", () => {
  it("does not count a thread dormant for months as 'not read yet' after a discovery sync", async () => {
    const dormantSince = new Date(Date.now() - 120 * DAY).toISOString();
    const madeAt = new Date(Date.now() - 200 * DAY).toISOString();
    const connection = new FakeConnection();
    connection.replies.set("session/list", {
      sessions: [{ sessionId: "tui-old", workspaceRoot: "/work/proj", turnCount: 3, modelId: "muse-spark-1.3", createdAt: madeAt, updatedAt: dormantSince }],
      nextCursor: null,
    });
    const { server, base } = await start(connection);
    const store = server["store"] as AncillaStore;
    await send(base, "/api/discover", {});
    assert.equal(store.getSession("tui-old")?.turnCount, 3);

    // The row as an install from before the column has it: no activity date, a later one bumped by every sync.
    store["db"].exec("UPDATE sessions SET activity_at = NULL WHERE id = 'tui-old'");
    await send(base, "/api/discover", {});

    const report = await get(base, "/api/usage?days=30");
    assert.deepEqual(report.coverage, { countedThreads: 0, partialThreads: 0, uncountedThreads: 0 }, "it was last active 120 days ago, outside 30");
    assert.equal(store.getSession("tui-old")?.activityAt, dormantSince, "the sync wrote Muse's own date");

    const wide = await get(base, "/api/usage?days=365");
    assert.equal(wide.coverage.uncountedThreads, 1, "a window that covers its day does count it");
  });
});
