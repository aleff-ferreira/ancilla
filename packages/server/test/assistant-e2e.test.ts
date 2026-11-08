/**
 * The demonstration: remember a constraint, apply a later correction, survive a restart in the middle of a step,
 * and verify the result against a file. Everything runs through the real server over HTTP, with a scripted Muse
 * (no model is called, and the test says so: it checks what Ancilla does with what a model would do).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeConnection, send, start, waitFor } from "./harness.js";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function museConnection(sessionPrefix: string, turnPrefix: string): FakeConnection {
  const connection = new FakeConnection();
  let sessions = 0;
  let turns = 0;
  connection.replies.set("session/start", () => ({ session: { sessionId: `${sessionPrefix}${++sessions}` } }));
  connection.replies.set("turn/start", () => ({ turnId: `${turnPrefix}${++turns}`, status: "accepted", disposition: "started" }));
  return connection;
}

const promptOf = (connection: FakeConnection, index: number): { text: string; display: unknown } => {
  const call = connection.of("turn/start")[index];
  assert.ok(call, `turn ${index} was not sent`);
  return { text: (call.params?.["input"] as { text?: string }[])[0]?.text ?? "", display: call.params?.["displayText"] };
};

describe("remember, correct, restart, verify", () => {
  it("carries a rule into a task, applies a later correction to the next step, does not rerun a step after a restart, and checks the result in the file", async () => {
    const dataDir = await temp("ancilla-e2e-data-");
    const project = await temp("ancilla-e2e-project-");
    const one = museConnection("s", "t");
    const first = await start(one, { dataDir });

    // 1. The assistant is switched on, and allowed to change files in projects (it is off by default).
    assert.equal((await send(first.base, "/api/assistant/profile", { enabled: true, policy: { allowProjectWrites: true } }, "PATCH")).status, 200);

    // 2. The user states a rule in a chat thread.
    const chat = (await send(first.base, "/api/sessions", { cwd: project })).json.session.sessionId as string;
    const said = await send(first.base, "/api/turns", { sessionId: chat, text: "Remember that the release notes go in docs/NOTES.md" });
    assert.equal(said.status, 200);
    one.notify("turn/completed", { sessionId: chat, turnId: said.json.turnId, terminal: "completed" });
    assert.equal((await send(first.base, "/api/assistant/memories", undefined, "GET")).json.total, 1);

    // 3. A task of two steps, with a check on the result. Step 1 starts at once, in a thread of its own.
    const made = await send(first.base, "/api/assistant/tasks", {
      goal: "Prepare the release notes for 0.23.0",
      cwd: project,
      allowWrites: true,
      steps: [
        { title: "Collect the changes since 0.22.0", effect: "write" },
        { title: "Write the release notes", effect: "write", verifier: { type: "file_contains", path: "CHANGELOG.md", text: "## 0.23.0" } },
      ],
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const taskId = made.json.task.id as string;
    await waitFor(() => one.of("turn/start").length === 2, "the first step to be sent");
    const detail = (await send(first.base, `/api/assistant/tasks/${taskId}`, undefined, "GET")).json;
    const taskThread = detail.task.sessionId as string;
    assert.notEqual(taskThread, chat, "a task runs in a thread of its own, which the user can open");
    const step1 = promptOf(one, 1);
    assert.match(step1.text, /^<assistant-memory>/);
    assert.match(step1.text, /the release notes go in docs\/NOTES\.md/, "the rule the user stated reaches the task");
    assert.match(step1.text, /Step 1 of 2: Collect the changes since 0\.22\.0/);
    assert.equal(step1.display, "Task: Prepare the release notes for 0.23.0\nStep 1 of 2: Collect the changes since 0.22.0", "the thread shows the step, not the whole prompt");

    // 4. While step 1 runs, the user corrects the rule in the chat.
    const fix = await send(first.base, "/api/turns", { sessionId: chat, text: "Actually, the release notes go in CHANGELOG.md instead of docs/NOTES.md." });
    assert.equal(fix.status, 200);
    one.notify("turn/completed", { sessionId: chat, turnId: fix.json.turnId, terminal: "completed" });
    const memories = (await send(first.base, "/api/assistant/memories", undefined, "GET")).json;
    assert.equal(memories.total, 1, "one current belief");
    assert.equal(memories.items[0].text, "the release notes go in CHANGELOG.md instead of docs/NOTES.md");
    assert.equal((await send(first.base, "/api/assistant/memories?status=history", undefined, "GET")).json.total, 1, "and the old one kept as history");

    // 5. Step 1 finishes; step 2 starts, and is told the corrected rule.
    const turn1 = detail.attempts[0].turnId as string;
    one.notify("turn/completed", { sessionId: taskThread, turnId: turn1, terminal: "completed" });
    // (Turns sent so far: the rule, step 1, the correction, and now step 2.)
    await waitFor(() => one.of("turn/start").length === 4, "the second step to be sent");
    const step2 = promptOf(one, 3);
    assert.match(step2.text, /CHANGELOG\.md instead of docs\/NOTES\.md/, "the correction made during step 1 is in step 2");
    assert.doesNotMatch(step2.text, /the release notes go in docs\/NOTES\.md \(/, "and the old rule is not");
    assert.match(step2.text, /Step 2 of 2: Write the release notes/);

    // 6. The server stops while step 2 is running (a crash: nothing is closed politely first).
    await first.server.close();

    // 7. A new server on the same folder. Step 2 may have changed files, so it is NOT run again on a guess.
    const two = museConnection("r", "u");
    const second = await start(two, { dataDir });
    await waitFor(async () => (await send(second.base, `/api/assistant/tasks/${taskId}`, undefined, "GET")).json.task.status === "blocked", "the task to wait for the user");
    const blocked = (await send(second.base, `/api/assistant/tasks/${taskId}`, undefined, "GET")).json;
    assert.match(blocked.task.reason, /not known whether it finished\. It was not run again/);
    assert.equal(two.of("turn/start").length, 0, "no turn was started after the restart");
    assert.deepEqual(blocked.attempts.map((a: { outcome: string }) => a.outcome), ["succeeded", "unknown"]);
    assert.deepEqual(blocked.steps.map((s: { status: string }) => s.status), ["done", "unknown"]);
    const needsYou = (await send(second.base, "/api/assistant/suggestions", undefined, "GET")).json.suggestions;
    assert.ok(needsYou.some((s: { kind: string }) => s.kind === "task-needs-you"), "and it is among what is waiting on the user");

    // 8. The user looks at the thread and asks for the step again. The memory is still there, after the restart.
    const stepId = blocked.steps[1].id as string;
    assert.equal((await send(second.base, `/api/assistant/tasks/${taskId}/resolve`, { stepId, resolution: "retry" })).status, 200);
    await waitFor(() => two.of("turn/start").length === 1, "the step to be sent again");
    const again = promptOf(two, 0);
    assert.match(again.text, /CHANGELOG\.md instead of docs\/NOTES\.md/, "the correction survived the restart");
    const afterRetry = (await send(second.base, `/api/assistant/tasks/${taskId}`, undefined, "GET")).json;
    assert.deepEqual(afterRetry.attempts.map((a: { fence: number }) => a.fence), [1, 2, 3], "a new fence for the new attempt");

    // 9. The old turn reports in late: it is not the current attempt's, so it changes nothing.
    two.notify("turn/completed", { sessionId: taskThread, turnId: blocked.attempts[1].turnId, terminal: "completed" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await send(second.base, `/api/assistant/tasks/${taskId}`, undefined, "GET")).json.task.status, "running");

    // 10. The step's work happens (the scripted Muse writes the file), the new turn ends, and the result is checked.
    await writeFile(join(project, "CHANGELOG.md"), "# Changelog\n\n## 0.23.0\n- the personal assistant\n", "utf8");
    two.notify("turn/completed", { sessionId: taskThread, turnId: "u1", terminal: "completed" });
    await waitFor(async () => (await send(second.base, `/api/assistant/tasks/${taskId}`, undefined, "GET")).json.task.status === "completed", "the task to be verified");
    const done = (await send(second.base, `/api/assistant/tasks/${taskId}`, undefined, "GET")).json;
    assert.match(done.task.result, /CHANGELOG\.md contains "## 0\.23\.0"/);
    assert.equal(done.steps[1].verified, true);
    assert.ok(done.events.some((e: { kind: string }) => e.kind === "stale-completion-refused"), "the late report was recorded as refused");
  });
});
