import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task, TaskStatus } from "../src/assistant/tasks.js";
import { MAX_WAITING, waitingCause, waitingTasks } from "../src/assistant/waiting.js";
import type { QuestionView } from "../src/browser/sites.js";
import { noticeOf } from "../src/voice/assistant-host.js";

/**
 * Whether a task has stopped for the person, and why: what the status names, what a notification says, what the call counts.
 * Only what a task cannot go on without counts; what the person did themselves, or what is only running or over, does not.
 */

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t_1", title: "Look at A", goal: "g", goalId: null, status: "running", reason: "", origin: "user", scheduleId: null,
    cwd: "/work/atlas", project: "/work/atlas", account: null, sessionId: null, allowWrites: false, maxTurns: 10, maxMinutes: 30,
    turnsUsed: 0, fence: 0, retryAt: null, failures: 0, startedAt: 1, finishedAt: null, result: "", createdAt: 1, updatedAt: 1,
    progress: { done: 0, total: 1 },
    ...patch,
  };
}

const SITE: QuestionView = { type: "site", origin: "https://a.example", kind: "public" };
const ACTION: QuestionView = { type: "action", origin: "https://a.example", kind: "public", page: "Shop", what: "Click “Place order”", fields: [] };
const DOWNLOAD: QuestionView = { ...ACTION, what: "Save a.pdf", download: { id: "d1", name: "a.pdf", size: 10, folder: "/home/x/Downloads", warning: null } };

describe("a task that waits on the person", () => {
  it("says why a web task asks: a site, an action, a file, or a question that is no longer known", () => {
    const asking = task({ origin: "browse", status: "paused", reason: "Waiting for your approval to open https://a.example." });
    assert.equal(waitingCause(asking, SITE), "site");
    assert.equal(waitingCause(asking, ACTION), "action");
    assert.equal(waitingCause(asking, DOWNLOAD), "download");
    assert.equal(waitingCause(asking, null), "question");
  });

  it("says a task on a connected account waits when it holds a change for the person, and at no other time", () => {
    const holding = task({ origin: "connector", status: "paused", reason: "Waiting for your approval: Merge a pull request (o/r #3) on GitHub." });
    assert.equal(waitingCause(holding, null), "change");
    assert.equal(waitingCause(holding, SITE), "change", "a connector task has no web question to look at");
    for (const status of ["queued", "running", "waiting", "completed", "unverified", "failed", "cancelled"] as TaskStatus[]) {
      assert.equal(waitingCause(task({ origin: "connector", status }), null), null, status);
    }
    const asked: string[] = [];
    const out = waitingTasks([holding], (id) => {
      asked.push(id);
      return SITE;
    });
    assert.deepEqual(out, [{ id: "t_1", title: "Look at A", cause: "change", reason: holding.reason }], "the notification names it and says why");
    assert.deepEqual(asked, [], "and no question is asked about it");
    assert.equal(noticeOf(holding), "needs", "the call counts it too");
  });

  it("counts a proposal nobody approved yet, and a task that stopped and asks what to do", () => {
    assert.equal(waitingCause(task({ origin: "voice", status: "paused", startedAt: null }), null), "approval");
    assert.equal(waitingCause(task({ status: "blocked" }), null), "blocked");
    assert.equal(waitingCause(task({ origin: "schedule", status: "blocked" }), null), "blocked");
  });

  it("does not count what the person did themselves, nor what only runs, waits for a time, or is over", () => {
    assert.equal(waitingCause(task({ status: "paused", reason: "Paused by you." }), null), null, "paused by the person");
    assert.equal(waitingCause(task({ origin: "schedule", status: "paused", reason: "The assistant was switched off." }), null), null, "paused with the assistant");
    assert.equal(waitingCause(task({ origin: "voice", status: "paused", startedAt: 5 }), null), null, "a change that was approved and started once, then paused");
    for (const status of ["queued", "running", "waiting", "completed", "unverified", "failed", "cancelled"] as TaskStatus[]) {
      assert.equal(waitingCause(task({ origin: "browse", status }), SITE), null, status);
    }
  });

  it("names the tasks that wait, asks for a web task's question only for a web task, and stops at a few", () => {
    const asked: string[] = [];
    const blocked = Array.from({ length: MAX_WAITING + 4 }, (_, i) => task({ id: `b_${i}`, title: `Task ${i}`, status: "blocked", reason: `why ${i}` }));
    const out = waitingTasks(
      [task({ id: "w", origin: "browse", status: "paused", reason: "ask" }), task({ id: "p", status: "paused", reason: "Paused by you." }), ...blocked],
      (id) => {
        asked.push(id);
        return SITE;
      },
    );
    assert.deepEqual(out[0], { id: "w", title: "Look at A", cause: "site", reason: "ask" });
    assert.deepEqual(out[1], { id: "b_0", title: "Task 0", cause: "blocked", reason: "why 0" });
    assert.equal(out.length, MAX_WAITING);
    assert.ok(!out.some((item) => item.id === "p"), "a task the person paused is not named");
    assert.deepEqual(asked, ["w"], "only a web task has a question to ask about");
  });

  it("is what the call counts as waiting on the person, too: one answer for both", () => {
    assert.equal(noticeOf(task({ origin: "voice", status: "paused", startedAt: null })), "needs");
    assert.equal(noticeOf(task({ origin: "browse", status: "paused" })), "needs");
    assert.equal(noticeOf(task({ status: "blocked" })), "needs");
    assert.equal(noticeOf(task({ status: "paused", reason: "Paused by you." })), null);
    assert.equal(noticeOf(task({ status: "completed" })), "done");
    assert.equal(noticeOf(task({ status: "unverified" })), "unverified");
    assert.equal(noticeOf(task({ status: "running" })), null);
  });
});
