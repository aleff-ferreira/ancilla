import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AmbiguousStartError, Executive, type ExecutiveHost } from "../src/assistant/executive.js";
import { FakeHost, flush } from "../src/assistant/eval/fakeHost.js";
import { nextRun, validZone, zonedToUtc, type ScheduleRule } from "../src/assistant/schedule.js";
import { MemoryStore, ValidationError } from "../src/assistant/store.js";
import { dismissSuggestion, startAutonomous, suggest } from "../src/assistant/suggest.js";
import { TaskStore, parseScheduleSpec, parseTaskSpec, runVerifier, type FileRead, type NewTask } from "../src/assistant/tasks.js";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;


function rig(policy: Record<string, unknown> = {}) {
  const clock = { t: T0 };
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true, policy: { allowProjectWrites: true, ...policy } });
  const tasks = new TaskStore(store, () => clock.t);
  const host = new FakeHost(clock);
  const changed: (string | null)[] = [];
  const memory: ConstructorParameters<typeof Executive>[2]["memory"] = (input) => {
    const out = store.retrieve({ text: input.text, project: input.project, ...(input.sessionId ? { thread: input.sessionId } : {}), now: clock.t });
    return out.memories.length > 0 ? out.text : null;
  };
  const make = (h: ExecutiveHost = host) => new Executive(tasks, h, { profile: () => store.getProfile(), memory, changed: (id) => changed.push(id) });
  return { clock, store, tasks, host, changed, exec: make(), make };
}

const spec = (r: ReturnType<typeof rig>, extra: Record<string, unknown> = {}): NewTask => parseTaskSpec({ goal: "Summarise the open issues in the tracker", cwd: "/work/atlas", ...extra }, r.store.getProfile(), (c) => c);

describe("a task, start to finish", () => {
  it("runs as a turn in a thread of its own, with the user's notes in front, and finishes as unverified when nothing could check it", async () => {
    const r = rig();
    r.store.remember({ text: "never use emojis in commit messages" });
    const task = r.exec.create(spec(r));
    await flush();
    assert.equal(r.host.sessions.length, 1);
    assert.equal(r.host.sessions[0]?.title, "Task: Summarise the open issues in the tracker");
    const sent = r.host.last();
    assert.match(sent.text, /^<assistant-memory>/);
    assert.match(sent.text, /never use emojis in commit messages/);
    assert.match(sent.text, /Goal: Summarise the open issues in the tracker/);
    assert.match(sent.text, /Do not change anything/, "a task that may not write says so to the model");
    assert.equal(sent.displayText, "Task: Summarise the open issues in the tracker\nStep 1 of 1: Summarise the open issues in the tracker");
    assert.equal(r.tasks.require(task.id).status, "running");
    r.host.finish(sent.turnId);
    await flush();
    const done = r.tasks.require(task.id);
    assert.equal(done.status, "unverified");
    assert.match(done.reason, /nothing checked the result/);
    assert.equal(done.turnsUsed, 1);
    assert.deepEqual(done.progress, { done: 1, total: 1 });
    assert.equal(r.tasks.steps(task.id)[0]?.verified, false);
  });

  it("is completed only when a check it can read passes, and stops with the reason when the check fails", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { steps: [{ title: "Write the notes", verifier: { type: "file_exists", path: "docs/NOTES.md" } }] }));
    await flush();
    r.host.finish(r.host.last().turnId);
    await flush();
    const blocked = r.tasks.require(task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason, /finished but the check failed: docs\/NOTES\.md was not found/);
    assert.equal(r.tasks.steps(task.id)[0]?.status, "failed");

    r.host.files.set("docs/NOTES.md", "# Notes\nbody");
    r.exec.retry(task.id);
    await flush();
    r.host.finish(r.host.last().turnId);
    await flush();
    const done = r.tasks.require(task.id);
    assert.equal(done.status, "completed");
    assert.match(done.result, /docs\/NOTES\.md exists \(12 bytes\)/);
    assert.equal(r.tasks.attempts(task.id).length, 2);
    assert.deepEqual(r.tasks.attempts(task.id).map((a) => a.fence), [1, 2]);
  });

  it("starts each step only when the one before it is done, and gives a later step the notes as they are by then", async () => {
    const r = rig();
    r.store.remember({ text: "the release notes go in docs/NOTES.md" });
    const task = r.exec.create(spec(r, { goal: "Prepare the release notes for the next release", steps: [{ title: "Collect the changes" }, { title: "Write the release notes", verifier: { type: "file_contains", path: "CHANGELOG.md", text: "## 0.23.0" } }] }));
    await flush();
    assert.equal(r.host.turns.length, 1);
    assert.match(r.host.last().text, /docs\/NOTES\.md/);
    // The user corrects the rule while the first step runs.
    r.store.capture({ message: "Actually, the release notes go in CHANGELOG.md instead of docs/NOTES.md", ctx: { role: "user", observedAt: T0 + 2 * MIN, offsetMinutes: 0, thread: "elsewhere" } });
    r.clock.t = T0 + 3 * MIN;
    r.host.finish(r.host.last().turnId);
    await flush();
    assert.equal(r.host.turns.length, 2, "the second step started after the first finished");
    const second = r.host.last().text;
    assert.match(second, /Step 2 of 2: Write the release notes/);
    assert.match(second, /CHANGELOG\.md instead of docs\/NOTES\.md/, "the correction made while the first step ran is in the second step's notes");
    assert.doesNotMatch(second, /the release notes go in docs\/NOTES\.md \(/, "and the replaced rule is not repeated beside it");
    r.host.files.set("CHANGELOG.md", "## 0.23.0\n- the assistant");
    r.host.finish(r.host.last().turnId);
    await flush();
    assert.equal(r.tasks.require(task.id).status, "completed");
  });

  it("refuses to run when the assistant is off, and refuses a limit beyond what the settings allow", () => {
    const r = rig({ maxTurnsPerTask: 4, maxMinutesPerTask: 10 });
    assert.throws(() => spec(r, { maxTurns: 9 }), /allow at most 4 turns/);
    assert.throws(() => spec(r, { maxMinutes: 60 }), /allow at most 10 minutes/);
    const noWrites = rig({ allowProjectWrites: false });
    assert.throws(() => spec(noWrites, { allowWrites: true }), /project writes are off/);
    assert.throws(() => spec(r, { goal: "use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), ValidationError);
    for (const path of ["../outside.txt", "/etc/passwd", "C:\\x.txt", "a//b", "docs\\x.md"]) {
      assert.throws(() => spec(r, { steps: [{ title: "x", verifier: { type: "file_exists", path } }] }), ValidationError, path);
    }
    r.store.saveProfile({ enabled: false });
    assert.throws(() => r.exec.create(spec(r)), /switched off/);
  });
});

describe("limits", () => {
  it("stops at the turn budget with the reason, and goes on when it is extended", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { maxTurns: 1, steps: [{ title: "one" }, { title: "two" }] }));
    await flush();
    r.host.finish(r.host.last().turnId);
    await flush();
    const stopped = r.tasks.require(task.id);
    assert.equal(stopped.status, "blocked");
    assert.match(stopped.reason, /turn budget is used up \(1 of 1\)/);
    assert.equal(r.host.turns.length, 1);
    r.exec.extend(task.id, 1, 0);
    await flush();
    assert.equal(r.host.turns.length, 2);
    r.host.finish(r.host.last().turnId);
    await flush();
    assert.equal(r.tasks.require(task.id).status, "unverified");
    assert.throws(() => r.exec.extend(task.id, 1, 0), /finished/);
  });

  it("stops a turn at the time budget and says so, but does not charge the time spent waiting for the user", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { maxMinutes: 5, allowWrites: true, steps: [{ title: "write it", effect: "write" }] }));
    await flush();
    const turn = r.host.last();
    r.host.needs.add(turn.sessionId);
    r.clock.t = T0 + 20 * MIN;
    await r.exec.tick();
    assert.equal(r.tasks.require(task.id).status, "running", "waiting for an approval is not the task's time");
    r.host.needs.clear();
    await r.exec.tick();
    const stopped = r.tasks.require(task.id);
    assert.equal(stopped.status, "blocked");
    assert.match(stopped.reason, /time budget is used up \(5 minutes\)/);
    assert.match(stopped.reason, /Check the thread, then say whether the step ran/);
    assert.deepEqual(r.host.interrupts, [{ sessionId: turn.sessionId, turnId: turn.turnId }]);
    assert.equal(r.tasks.steps(task.id)[0]?.status, "unknown");
  });

  it("starts as many tasks at once as the settings allow, and as many a day", async () => {
    const r = rig({ maxConcurrent: 1, maxTasksPerDay: 2 });
    const a = r.exec.create(spec(r, { title: "a" }));
    const b = r.exec.create(spec(r, { title: "b" }));
    const c = r.exec.create(spec(r, { title: "c" }));
    await flush();
    assert.equal(r.tasks.require(a.id).status, "running", r.host.logs.join(" | "));
    assert.match(r.tasks.require(b.id).reason, /Waiting for a free slot: 1 task is running, which is the limit/);
    r.host.finish(r.host.last().turnId);
    await flush();
    await r.exec.tick();
    const seen = (): string => JSON.stringify(r.tasks.list().map((t) => [t.title, t.status, t.reason])) + r.host.logs.join(" | ");
    assert.equal(r.tasks.require(b.id).status, "running", seen());
    r.host.finish(r.host.last().turnId);
    await flush();
    await r.exec.tick();
    assert.equal(r.tasks.require(c.id).status, "queued");
    assert.match(r.tasks.require(c.id).reason, /2 tasks have started in the last day/);
    r.clock.t += DAY + MIN;
    await r.exec.tick();
    assert.equal(r.tasks.require(c.id).status, "running");
  });
});

describe("cancelling, pausing and being interrupted", () => {
  it("cancels a running task, stops its turn, and refuses what the turn reports afterwards", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { steps: [{ title: "one" }, { title: "two" }] }));
    await flush();
    const turn = r.host.last();
    await r.exec.cancel(task.id);
    const cancelled = r.tasks.require(task.id);
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(r.host.interrupts, [{ sessionId: turn.sessionId, turnId: turn.turnId }]);
    assert.deepEqual(r.tasks.steps(task.id).map((s) => s.status), ["cancelled", "cancelled"]);
    r.host.finish(turn.turnId);
    await flush();
    const events = r.tasks.events(task.id).map((e) => e.kind);
    assert.ok(events.includes("stale-completion-refused"), events.join(","));
    assert.equal(r.tasks.require(task.id).status, "cancelled", "a late completion does not bring it back");
    assert.equal(r.host.turns.length, 1, "and nothing was started after it");
  });

  it("says when it could not confirm the interrupt, instead of claiming the turn stopped", async () => {
    const r = rig();
    const task = r.exec.create(spec(r));
    await flush();
    r.host.interruptError = new Error("the host is gone");
    await r.exec.cancel(task.id);
    const note = r.tasks.events(task.id).find((e) => e.kind === "interrupt-not-confirmed");
    assert.match(note?.detail ?? "", /the host is gone/);
    assert.equal(r.tasks.require(task.id).status, "cancelled");
  });

  it("pauses between turns, not in the middle of one, and goes on when resumed", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { steps: [{ title: "one" }, { title: "two" }] }));
    await flush();
    r.exec.pause(task.id);
    assert.match(r.tasks.require(task.id).reason, /turn in progress will finish first/);
    r.host.finish(r.host.last().turnId);
    await flush();
    assert.equal(r.tasks.require(task.id).status, "paused");
    assert.equal(r.host.turns.length, 1, "the next step did not start");
    assert.equal(r.tasks.steps(task.id)[0]?.status, "done", "the result of the turn that was running was kept");
    r.exec.resume(task.id);
    await flush();
    assert.equal(r.host.turns.length, 2);
  });

  it("pauses when the user speaks in the task's thread, and not for the task's own turns", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { steps: [{ title: "one" }, { title: "two" }] }));
    await flush();
    const turn = r.host.last();
    r.host.fire(turn.sessionId, "turn/started", { turnId: turn.turnId });
    assert.equal(r.tasks.require(task.id).status, "running", "its own turn starting is not a takeover");
    r.host.fire(turn.sessionId, "turn/started", { turnId: "typed-by-the-user" });
    const paused = r.tasks.require(task.id);
    assert.equal(paused.status, "paused");
    assert.match(paused.reason, /You sent a message in this task's thread/);
    assert.ok(r.tasks.events(task.id).some((e) => e.kind === "takeover"));
  });

  it("pauses and asks when a turn was interrupted from outside, and runs a read-only step again on resume", async () => {
    const r = rig();
    const task = r.exec.create(spec(r));
    await flush();
    r.host.finish(r.host.last().turnId, "interrupted");
    await flush();
    const paused = r.tasks.require(task.id);
    assert.equal(paused.status, "paused");
    assert.match(paused.reason, /The turn was interrupted/);
    assert.equal(r.tasks.steps(task.id)[0]?.status, "pending");
    r.exec.resume(task.id);
    await flush();
    assert.equal(r.host.turns.length, 2);
  });
});

describe("correlation and stale results", () => {
  it("matches a completion to its attempt by session and turn, and records the rest as not its own", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { steps: [{ title: "one" }, { title: "two" }] }));
    await flush();
    const first = r.host.last();
    assert.equal(first.commandId, `task:${task.id}:1`);
    r.host.fire(first.sessionId, "turn/completed", { turnId: "someone-elses-turn", terminal: "completed" });
    await flush();
    assert.equal(r.tasks.require(task.id).status, "running", "a turn that is not an attempt's changes nothing");
    r.host.finish(first.turnId);
    await flush();
    assert.equal(r.tasks.steps(task.id)[0]?.status, "done");
    // The first turn reports again, late and twice: the attempt is closed, so it is refused and recorded.
    r.host.finish(first.turnId, "failed", "late failure");
    r.host.finish(first.turnId);
    await flush();
    assert.equal(r.tasks.steps(task.id)[0]?.status, "done");
    assert.equal(r.tasks.events(task.id).filter((e) => e.kind === "stale-completion-refused").length, 2);
    assert.deepEqual(r.tasks.attempts(task.id).map((a) => a.fence), [1, 2]);
    assert.notEqual(r.tasks.attempts(task.id)[0]?.commandId, r.tasks.attempts(task.id)[1]?.commandId);
  });

  it("keeps a completion that beats the answer to the start, and applies it once the turn is known", async () => {
    const r = rig();
    r.host.duringStart = (turnId) => r.host.finish(turnId);
    const task = r.exec.create(spec(r));
    await flush();
    assert.equal(r.tasks.require(task.id).status, "unverified");
    assert.equal(r.tasks.attempts(task.id)[0]?.outcome, "succeeded");
  });
});

describe("when Muse is not there", () => {
  it("shows the task as waiting for the host, with the reason, backs off, and starts when the host is back", async () => {
    const r = rig();
    r.host.reachable = { ok: false, reason: "Muse is not installed in WSL" };
    const task = r.exec.create(spec(r));
    await flush();
    const waiting = r.tasks.require(task.id);
    assert.equal(waiting.status, "waiting");
    assert.match(waiting.reason, /Muse is not reachable: Muse is not installed in WSL/);
    assert.equal(waiting.retryAt, T0 + 30_000);
    r.clock.t = T0 + 31_000;
    await r.exec.tick();
    const again = r.tasks.require(task.id);
    assert.equal(again.status, "waiting");
    assert.equal(again.retryAt, T0 + 31_000 + 60_000, "the wait doubles");
    r.host.reachable = { ok: true };
    r.clock.t += 61_000;
    await r.exec.tick();
    assert.equal(r.tasks.require(task.id).status, "running");
    assert.equal(r.host.turns.length, 1);
    assert.equal(r.tasks.require(task.id).turnsUsed, 1, "the waiting cost no turn");
  });

  it("does not charge a turn Muse refused, and asks after five refusals", async () => {
    const r = rig();
    r.host.startError = new Error("session is locked by another client");
    const task = r.exec.create(spec(r));
    await flush();
    let now = r.tasks.require(task.id);
    assert.equal(now.status, "waiting");
    assert.equal(now.turnsUsed, 0);
    assert.equal(r.tasks.steps(task.id)[0]?.status, "pending");
    for (let i = 0; i < 4; i += 1) {
      r.clock.t += 11 * MIN;
      await r.exec.tick();
    }
    now = r.tasks.require(task.id);
    assert.equal(now.status, "blocked");
    assert.match(now.reason, /refused the step five times/);
  });

  it("does not run a step that may have started a second time: a read-only step is asked again, a writing one asks the user", async () => {
    const reading = rig();
    reading.host.startError = new AmbiguousStartError("the answer to the start never came");
    const a = reading.exec.create(spec(reading));
    await flush();
    assert.equal(reading.tasks.require(a.id).status, "waiting");
    assert.equal(reading.tasks.attempts(a.id)[0]?.outcome, "unknown");
    assert.equal(reading.tasks.steps(a.id)[0]?.status, "pending");

    const writing = rig();
    writing.host.startError = new AmbiguousStartError("the answer to the start never came");
    const b = writing.exec.create(spec(writing, { allowWrites: true }));
    await flush();
    const blocked = writing.tasks.require(b.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason, /may have started/);
    assert.equal(writing.tasks.steps(b.id)[0]?.status, "unknown");
    writing.host.startError = null;
    const step = writing.tasks.steps(b.id)[0];
    assert.ok(step);
    writing.exec.resolve(b.id, step.id, "done");
    await flush();
    assert.equal(writing.tasks.require(b.id).status, "unverified");
    assert.equal(writing.host.turns.length, 0, "it was never run again");
  });
});

describe("failures", () => {
  it("tries a failed read-only step once more, and stops a failed writing step at once", async () => {
    const r = rig();
    const task = r.exec.create(spec(r));
    await flush();
    r.host.finish(r.host.last().turnId, "failed", "the model service is down");
    await flush();
    const waiting = r.tasks.require(task.id);
    assert.equal(waiting.status, "waiting");
    assert.match(waiting.reason, /only reads, so it will be tried once more/);
    r.clock.t += MIN;
    await r.exec.tick();
    r.host.finish(r.host.last().turnId, "failed", "still down");
    await flush();
    const failed = r.tasks.require(task.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.reason, /Step 1 failed: still down/);

    const w = rig();
    const t = w.exec.create(spec(w, { allowWrites: true }));
    await flush();
    w.host.finish(w.host.last().turnId, "failed", "boom");
    await flush();
    assert.equal(w.tasks.require(t.id).status, "failed");
    assert.equal(w.host.turns.length, 1, "a writing step is not run again on its own");
    w.exec.retry(t.id);
    await flush();
    assert.equal(w.host.turns.length, 2, "the user asked for it");
  });
});

describe("after a restart", () => {
  async function started(allowWrites: boolean) {
    const r = rig();
    const task = r.exec.create(spec(r, { allowWrites, steps: [{ title: "work", verifier: { type: "file_exists", path: "out.txt" } }] }));
    await flush();
    const turn = r.host.last();
    r.exec.close();
    const host2 = new FakeHost(r.clock, "b-");
    const exec2 = r.make(host2);
    return { ...r, task, turn, host2, exec2 };
  }

  it("never runs a step that may have changed something again on a guess, and asks", async () => {
    const x = await started(true);
    x.host2.ledger.set(`${x.turn.sessionId}:${x.turn.turnId}`, "unknown");
    const summary = await x.exec2.recover();
    assert.deepEqual(summary, { resumed: 0, reconciled: 1, blocked: 1 });
    await flush();
    const blocked = x.tasks.require(x.task.id);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reason, /not known whether it finished\. It was not run again/);
    assert.equal(x.host2.turns.length, 0);
    assert.equal(x.tasks.attempts(x.task.id)[0]?.outcome, "unknown");
    // The user looked at the thread and says it ran, and the check reads the file.
    x.host2.files.set("out.txt", "done");
    const step = x.tasks.steps(x.task.id)[0];
    assert.ok(step);
    x.exec2.resolve(x.task.id, step.id, "retry");
    await flush();
    assert.equal(x.host2.turns.length, 1, "run again because the user said to");
    assert.equal(x.tasks.attempts(x.task.id)[1]?.fence, 2);
    x.host2.finish(x.host2.last().turnId);
    await flush();
    assert.equal(x.tasks.require(x.task.id).status, "completed");
  });

  it("runs a step that only reads again, with a new fence, and refuses the old turn's late report", async () => {
    const x = await started(false);
    x.host2.ledger.set(`${x.turn.sessionId}:${x.turn.turnId}`, "unknown");
    const summary = await x.exec2.recover();
    assert.deepEqual(summary, { resumed: 1, reconciled: 1, blocked: 0 });
    await flush();
    assert.equal(x.host2.turns.length, 1);
    assert.deepEqual(x.tasks.attempts(x.task.id).map((a) => [a.fence, a.outcome]), [[1, "unknown"], [2, "running"]]);
    x.host2.fire(x.turn.sessionId, "turn/completed", { turnId: x.turn.turnId, terminal: "completed" });
    await flush();
    assert.ok(x.tasks.events(x.task.id).some((e) => e.kind === "stale-completion-refused"));
    assert.equal(x.tasks.require(x.task.id).status, "running");
  });

  it("records a turn the ledger knows finished, and checks it, instead of guessing", async () => {
    const x = await started(true);
    x.host2.ledger.set(`${x.turn.sessionId}:${x.turn.turnId}`, "completed");
    x.host2.files.set("out.txt", "done");
    await x.exec2.recover();
    await flush();
    const done = x.tasks.require(x.task.id);
    assert.equal(done.status, "completed");
    assert.equal(x.host2.turns.length, 0);
    assert.equal(x.tasks.attempts(x.task.id)[0]?.outcome, "succeeded");
  });

  it("hears the end of a turn that was still running through the thread's feed", async () => {
    const x = await started(true);
    x.host2.ledger.set(`${x.turn.sessionId}:${x.turn.turnId}`, "running");
    await x.exec2.recover();
    assert.equal(x.tasks.require(x.task.id).status, "running");
    x.host2.files.set("out.txt", "done");
    x.host2.fire(x.turn.sessionId, "turn/completed", { turnId: x.turn.turnId, terminal: "completed" });
    await flush();
    assert.equal(x.tasks.require(x.task.id).status, "completed");
  });

  it("closes an attempt whose start was cut off, and finds the queue as it was", async () => {
    const r = rig();
    const task = r.exec.create(spec(r, { allowWrites: true }));
    // The process died after the attempt was recorded and before Muse answered.
    r.exec.close();
    const step = r.tasks.steps(task.id)[0];
    assert.ok(step);
    r.tasks.setStatus(task.id, "running", "mid start");
    r.tasks.startAttempt(task.id, step.id);
    const host2 = new FakeHost(r.clock);
    const exec2 = r.make(host2);
    const summary = await exec2.recover();
    assert.equal(summary.blocked, 1);
    assert.equal(r.tasks.attempts(task.id)[0]?.outcome, "unknown");
    assert.equal(r.tasks.require(task.id).status, "blocked");
    assert.equal(host2.turns.length, 0);
  });
});

describe("schedules", () => {
  const profile = () => MemoryStore.open(":memory:").getProfile();

  it("must name a time zone and an end, and may not run more often than every quarter hour", () => {
    const p = profile();
    const base = { goal: "Check the build", cwd: "/work/atlas", kind: "daily", atMinute: 540, tz: "America/Sao_Paulo", endAt: T0 + 30 * DAY };
    assert.doesNotThrow(() => parseScheduleSpec(base, p, (c) => c, T0));
    assert.throws(() => parseScheduleSpec({ ...base, tz: undefined }, p, (c) => c, T0), /time zone/);
    assert.throws(() => parseScheduleSpec({ ...base, tz: "Mars/Olympus" }, p, (c) => c, T0), /time zone/);
    assert.throws(() => parseScheduleSpec({ ...base, endAt: undefined }, p, (c) => c, T0), /end date/);
    assert.throws(() => parseScheduleSpec({ ...base, endAt: T0 + 900 * DAY }, p, (c) => c, T0), /at most 366 days/);
    assert.throws(() => parseScheduleSpec({ goal: "x y z", cwd: "/w", kind: "interval", everyMinutes: 5, tz: "UTC", maxRuns: 3 }, p, (c) => c, T0), ValidationError);
    assert.doesNotThrow(() => parseScheduleSpec({ goal: "x y z", cwd: "/w", kind: "interval", everyMinutes: 15, tz: "UTC", maxRuns: 3 }, p, (c) => c, T0));
  });

  it("makes a task at each due time, stops after its last run, skips what was missed, and does not pile up", async () => {
    const r = rig();
    const sch = r.tasks.createSchedule(parseScheduleSpec({ goal: "Check the build", cwd: "/work/atlas", kind: "interval", everyMinutes: 60, tz: "UTC", maxRuns: 2 }, r.store.getProfile(), (c) => c, T0), T0);
    assert.equal(sch.nextRunAt, T0 + HOUR);
    await r.exec.tick();
    assert.equal(r.tasks.list().length, 0, "not due yet");
    r.clock.t = T0 + HOUR + MIN;
    await r.exec.tick();
    await flush();
    assert.equal(r.tasks.list().length, 1);
    assert.equal(r.tasks.list()[0]?.origin, "schedule");
    r.host.finish(r.host.last().turnId);
    await flush();
    r.clock.t = T0 + 2 * HOUR + MIN;
    await r.exec.tick();
    await flush();
    assert.equal(r.tasks.list().length, 2);
    const after = r.tasks.schedule(sch.id);
    assert.equal(after?.runs, 2);
    assert.equal(after?.enabled, false);
    assert.match(after?.note ?? "", /ran as many times as it was allowed to/);
    r.host.finish(r.host.last().turnId);
    await flush();

    // Missed while closed, with the default of skipping: no task, and the schedule moves on.
    const r2 = rig();
    const s2 = r2.tasks.createSchedule(parseScheduleSpec({ goal: "Check the build", cwd: "/work/atlas", kind: "interval", everyMinutes: 60, tz: "UTC", maxRuns: 5 }, r2.store.getProfile(), (c) => c, T0), T0);
    r2.clock.t = T0 + 5 * HOUR;
    await r2.exec.tick();
    assert.equal(r2.tasks.list().length, 0);
    assert.ok((r2.tasks.schedule(s2.id)?.nextRunAt ?? 0) > r2.clock.t);

    // The last run still going: the next occurrence is skipped instead of piling up.
    const r3 = rig();
    r3.tasks.createSchedule(parseScheduleSpec({ goal: "Check the build", cwd: "/work/atlas", kind: "interval", everyMinutes: 15, tz: "UTC", maxRuns: 9 }, r3.store.getProfile(), (c) => c, T0), T0);
    r3.clock.t = T0 + 16 * MIN;
    await r3.exec.tick();
    await flush();
    r3.clock.t = T0 + 31 * MIN;
    await r3.exec.tick();
    await flush();
    assert.equal(r3.tasks.list().length, 1, "the first run has not finished, so the second was skipped");
  });
});

describe("the time arithmetic of a schedule", () => {
  const rule = (extra: Partial<ScheduleRule>): ScheduleRule => ({ kind: "daily", everyMinutes: null, atMinute: 540, tz: "UTC", startAt: null, endAt: null, lastRunAt: null, ...extra });

  it("keeps a daily hour on the wall clock across a change of clocks", () => {
    const summer = nextRun(rule({ tz: "America/New_York" }), Date.UTC(2026, 6, 1, 0, 0));
    const winter = nextRun(rule({ tz: "America/New_York" }), Date.UTC(2026, 11, 1, 0, 0));
    assert.equal(new Date(summer as number).toISOString(), "2026-07-01T13:00:00.000Z", "09:00 in July is 13:00 UTC");
    assert.equal(new Date(winter as number).toISOString(), "2026-12-01T14:00:00.000Z", "09:00 in December is 14:00 UTC");
    assert.equal(new Date(zonedToUtc(2026, 3, 8, 150, "America/New_York")).toISOString(), "2026-03-08T07:30:00.000Z", "a time the clock skips lands after the gap");
  });

  it("moves to the next day when today's time has gone, ends on its end date, and runs a one-time schedule once", () => {
    const after = Date.UTC(2026, 9, 1, 10, 0);
    assert.equal(new Date(nextRun(rule({}), after) as number).toISOString(), "2026-10-02T09:00:00.000Z");
    assert.equal(new Date(nextRun(rule({}), Date.UTC(2026, 9, 1, 8, 0)) as number).toISOString(), "2026-10-01T09:00:00.000Z");
    assert.equal(nextRun(rule({ endAt: Date.UTC(2026, 9, 1, 12, 0) }), after), null);
    const once = rule({ kind: "once", startAt: after + HOUR });
    assert.equal(nextRun(once, after), after + HOUR);
    assert.equal(nextRun({ ...once, lastRunAt: after + HOUR }, after + 2 * HOUR), null);
    assert.equal(nextRun(rule({ kind: "interval", everyMinutes: 30, startAt: after }), after + 61 * MIN), after + 90 * MIN);
    assert.ok(validZone("Europe/Lisbon") && !validZone("Nowhere/Land") && !validZone(""));
  });
});

describe("what the assistant would do next", () => {
  function seeded(autonomy: "ask" | "suggest" | "act") {
    const r = rig({ allowReadOnly: true });
    r.store.saveProfile({ autonomy });
    r.store.remember({ text: "remind me to renew the domain by 2026-10-03", scope: { kind: "project", key: "/work/atlas" } });
    r.store.remember({ text: "the current version is 2.3.1" });
    r.store.addGoal({ text: "Ship the personal agent" });
    r.clock.t = T0 + 20 * DAY;
    return r;
  }
  const deps = (r: ReturnType<typeof rig>) => ({ memory: r.store, tasks: r.tasks, profile: r.store.getProfile(), now: r.clock.t });

  it("only says what is waiting on the user under 'ask', lists the work it could do under 'suggest', with the evidence", () => {
    const ask = seeded("ask");
    assert.deepEqual(suggest(deps(ask)), []);
    const blocked = ask.exec.create(spec(ask));
    ask.tasks.setStatus(blocked.id, "blocked", "Step 1 failed");
    assert.deepEqual(suggest(deps(ask)).map((s) => s.kind), ["task-needs-you"]);

    const sug = seeded("suggest");
    const list = suggest(deps(sug));
    assert.deepEqual(list.map((s) => s.kind).sort(), ["due-commitment", "goal-idle", "stale-memory"]);
    const due = list.find((s) => s.kind === "due-commitment");
    assert.match(due?.why ?? "", /You said on 2026-10-01: "remind me to renew the domain/);
    assert.match(due?.title ?? "", /overdue/);
    assert.equal(due?.autonomous, true);
    dismissSuggestion(sug.store, due?.id as string, sug.clock.t);
    assert.ok(!suggest(deps(sug)).some((s) => s.id === due?.id), "a dismissed suggestion stays dismissed");
  });

  it("starts, under 'act', only what reads and rests on what the user said in a project, once, and a couple a day at most", () => {
    const r = seeded("act");
    const started: string[] = [];
    const first = startAutonomous({ ...deps(r), start: (s) => {
      started.push(s.id);
      assert.equal(s.action.type, "task");
      return r.exec.create(parseTaskSpec({ goal: (s.action as { goal: string }).goal, cwd: (s.action as { project: string }).project }, r.store.getProfile(), (c) => c));
    } });
    assert.equal(first.length, 1);
    assert.match(first[0] ?? "", /^due-commitment:/);
    assert.equal(r.tasks.list()[0]?.origin, "user", "created through the same door; the origin is set by the caller");
    assert.equal(r.tasks.list()[0]?.allowWrites, false, "it only reads");
    const again = startAutonomous({ ...deps(r), start: (s) => { started.push(s.id); throw new Error("not twice"); } });
    assert.deepEqual(again, [], "the same suggestion is never started twice");
    r.store.saveProfile({ policy: { allowReadOnly: false } });
    assert.deepEqual(startAutonomous({ ...deps(r), start: () => { throw new Error("no"); } }), []);
    const suggestOnly = seeded("suggest");
    assert.deepEqual(startAutonomous({ ...deps(suggestOnly), start: () => { throw new Error("no"); } }), []);
  });
});

describe("a check reads the project and nothing else", () => {
  it("finds a file, reads what is in it, and reports exactly what it found", async () => {
    const files = new Map([["a.txt", "hello world"]]);
    const read = async (p: string): Promise<FileRead> => (files.has(p) ? { exists: true, text: files.get(p) as string, size: 11 } : { exists: false, text: null, size: 0 });
    assert.deepEqual(await runVerifier({ type: "file_exists", path: "a.txt" }, read), { ok: true, manual: false, evidence: "a.txt exists (11 bytes)." });
    assert.equal((await runVerifier({ type: "file_exists", path: "b.txt" }, read)).ok, false);
    assert.equal((await runVerifier({ type: "file_contains", path: "a.txt", text: "world" }, read)).ok, true);
    assert.match((await runVerifier({ type: "file_contains", path: "a.txt", text: "mars" }, read)).evidence, /does not contain "mars"/);
    assert.equal((await runVerifier({ type: "manual" }, read)).manual, true);
    const broken = await runVerifier({ type: "file_exists", path: "a.txt" }, async () => { throw new Error("denied"); });
    assert.match(broken.evidence, /could not be read: denied/);
  });
});
