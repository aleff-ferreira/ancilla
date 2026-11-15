import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeHost, flush } from "../src/assistant/eval/fakeHost.js";
import { MAX_PROPOSALS, PROPOSAL_TTL_MS } from "../src/assistant/executive.js";
import { handleAssistant } from "../src/assistant/routes.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { awaitsApproval } from "../src/assistant/tasks.js";
import { AssistantVoiceHost, noticeOf, TaskHub } from "../src/voice/assistant-host.js";
import { ConversationStore } from "../src/voice/conversations.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";
import { VOICE_TOOLS, VoiceTools } from "../src/voice/tools.js";

/**
 * A change the voice proposes: it waits, paused and never started, and nothing the voice has (a tool, a resume, a
 * restart, a pass of the executive) starts it. Only the user's approval on the screen does, and only while project
 * writes are on.
 */

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

function rig(opts: { writes?: boolean } = {}) {
  const clock = { t: T0 };
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true, policy: { allowProjectWrites: opts.writes ?? true } });
  const host = new FakeHost(clock);
  const hub = new TaskHub();
  const service = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, host });
  const tools = new VoiceTools({ assistant: service, project: () => "/work/atlas", lang: () => "en", conversationId: "cv_1" });
  const exec = service.executive;
  assert.ok(exec, "the rig has a host, so it has an executive");
  return { clock, store, host, hub, service, tools, exec };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c1", name, arguments: JSON.stringify(args) });

async function propose(r: ReturnType<typeof rig>, goal: string, title?: string) {
  const result = await r.tools.run(call("propose_change", { goal, ...(title ? { title } : {}) }));
  assert.equal(result.ok, true, result.text);
  const task = r.service.tasks.list("all", 1)[0];
  assert.ok(task);
  return { result, task };
}

describe("a change the voice proposes", () => {
  it("waits, paused and never started, and a pass of the executive or a restart leaves it alone", async () => {
    const r = rig();
    const { result, task } = await propose(r, "Fix the login redirect so it keeps the page the person came from", "Login redirect");
    assert.match(result.text, /waits on the user's screen/);
    assert.equal(result.narration, "I've put that on your screen. It waits for your approval, and only you can give it.");
    assert.equal(task.status, "paused");
    assert.equal(task.origin, "voice");
    assert.equal(task.allowWrites, true);
    assert.equal(task.startedAt, null);
    assert.match(task.reason, /Waiting for your approval to change files in atlas/);
    assert.equal(awaitsApproval(task), true);
    assert.equal(noticeOf(task), "needs", "the call counts it as something that waits on the user");
    assert.deepEqual(r.service.taskSummary().waiting.map((w) => [w.id, w.cause, w.title]), [[task.id, "approval", "Login redirect"]], "and the status names it, for a notification");

    r.exec.kick();
    await flush();
    const summary = await r.exec.recover();
    await flush();
    assert.deepEqual(summary, { resumed: 0, reconciled: 0, blocked: 0 });
    assert.equal(r.service.tasks.require(task.id).status, "paused");
    assert.equal(r.host.sessions.length, 0, "no thread was opened");
    assert.equal(r.host.turns.length, 0, "and no turn was sent");
  });

  it("cannot be started by anything the voice has: no tool approves, and a resume is refused", async () => {
    const r = rig();
    const { task } = await propose(r, "Rename the config key", "Rename key");
    assert.deepEqual(
      VOICE_TOOLS.map((t) => t.name),
      ["delegate_task", "propose_change", "browse", "use_connector", "list_tasks", "task_status", "pause_task", "resume_task", "cancel_task", "recall"],
      "a tool added here must be thought through: none of these approves (browse opens only the sites the person allows, on the screen; use_connector only reads an account)",
    );
    for (const id of [task.id, "last"]) {
      const resumed = await r.tools.run(call("resume_task", { id }));
      assert.equal(resumed.ok, false, id);
      assert.match(resumed.text, /waits for the user's approval on the screen/);
    }
    assert.throws(() => r.exec.resume(task.id), /approval/);
    assert.throws(() => r.exec.retry(task.id), /failed or blocked/);
    assert.throws(() => r.exec.confirm(task.id), /nothing here to confirm/);
    r.exec.extend(task.id, 1, 0);
    r.exec.pause(task.id);
    await flush();
    const after = r.service.tasks.require(task.id);
    assert.equal(after.status, "paused");
    assert.equal(awaitsApproval(after), true);
    assert.equal(r.host.turns.length, 0);
  });

  it("starts only when the user approves it, as a task that may change files, and only once", async () => {
    const r = rig();
    const { task } = await propose(r, "Fix the login redirect", "Login redirect");
    const approved = r.exec.approve(task.id);
    assert.equal(approved.status, "queued");
    await flush();
    assert.equal(r.host.sessions.length, 1, "a thread was opened for it");
    assert.match(r.host.last().text, /Goal: Fix the login redirect/);
    assert.doesNotMatch(r.host.last().text, /Do not change anything/, "it is told it may change files");
    const running = r.service.tasks.require(task.id);
    assert.equal(running.status, "running");
    assert.equal(awaitsApproval(running), false);
    assert.ok(r.service.tasks.detail(task.id).events.some((e) => e.kind === "approved"));
    assert.throws(() => r.exec.approve(task.id), /nothing here to approve/);
  });

  it("is declined by cancelling it, and a declined proposal cannot be approved", async () => {
    const r = rig();
    const { task } = await propose(r, "Delete the old build scripts", "Old scripts");
    const declined = await r.tools.run(call("cancel_task", { id: task.id }));
    assert.equal(declined.ok, true, declined.text);
    assert.equal(r.service.tasks.require(task.id).status, "cancelled");
    assert.throws(() => r.exec.approve(task.id), /nothing here to approve/);
    assert.equal(r.host.turns.length, 0);
  });

  it("is not proposed when project writes are off, and approving checks again", async () => {
    const off = rig({ writes: false });
    const refused = await off.tools.run(call("propose_change", { goal: "Fix the login redirect" }));
    assert.equal(refused.ok, false);
    assert.match(refused.text, /project writes are off/);
    assert.equal(off.service.tasks.list("all").length, 0);

    const r = rig();
    const { task } = await propose(r, "Fix the login redirect");
    r.store.saveProfile({ enabled: true, policy: { allowProjectWrites: false } });
    assert.throws(() => r.exec.approve(task.id), /Project writes are off/);
    assert.equal(r.service.tasks.require(task.id).status, "paused");
    assert.equal(r.host.turns.length, 0);
  });

  it("keeps at most three waiting, and the same proposal twice is one", async () => {
    const r = rig();
    const goals = ["Fix the login redirect", "Rename the config key", "Remove the dead exports"];
    for (const goal of goals) await propose(r, goal);
    const again = await r.tools.run(call("propose_change", { goal: goals[0] }));
    assert.equal(again.ok, true, "the same proposal is the one already waiting");
    assert.equal(r.service.tasks.list("all").length, goals.length);
    const more = await r.tools.run(call("propose_change", { goal: "Bump every dependency" }));
    assert.equal(more.ok, false);
    assert.match(more.text, new RegExp(`${MAX_PROPOSALS} proposals already wait`));
    assert.equal(r.service.tasks.list("all").length, goals.length);
  });

  it("is dropped when nobody answers it within a day", async () => {
    const r = rig();
    const { task } = await propose(r, "Fix the login redirect");
    r.clock.t += PROPOSAL_TTL_MS - 1;
    await r.exec.tick();
    assert.equal(r.service.tasks.require(task.id).status, "paused", "still waiting just before the day is out");
    r.clock.t += 1;
    await r.exec.tick();
    const dropped = r.service.tasks.require(task.id);
    assert.equal(dropped.status, "cancelled");
    assert.match(dropped.reason, /within a day/);
    assert.equal(r.host.turns.length, 0);
  });

  it("is approved from the screen through the route, and the plain resume route refuses it", async () => {
    const r = rig();
    const { task } = await propose(r, "Fix the login redirect");
    const post = async (path: string) => {
      const url = new URL(path, "http://localhost");
      return handleAssistant({ get: () => r.service, unavailable: () => null }, { method: "POST", path: url.pathname, query: url.searchParams, body: async () => ({}) });
    };
    assert.equal((await post(`/api/assistant/tasks/${task.id}/resume`))?.status, 409);
    assert.equal(r.service.tasks.require(task.id).status, "paused");
    assert.equal((await post(`/api/assistant/tasks/${task.id}/approve`))?.status, 200);
    await flush();
    assert.equal(r.service.tasks.require(task.id).status, "running");
  });

  it("tells the call it waits on the user, without saying again what the tool already said", async () => {
    const r = rig();
    const conversations = new ConversationStore(r.store, () => r.clock.t);
    const voice = new AssistantVoiceHost({ assistant: r.service, conversations, conversationId: conversations.create(null), settings: () => ({ ...DEFAULT_VOICE_SETTINGS, proactive: true }), hub: r.hub, project: () => "/work/atlas", log: () => undefined });
    const heard: { say: string | null; needsUser: boolean }[] = [];
    voice.subscribe((event) => {
      if (event.kind === "task") heard.push({ say: event.say, needsUser: event.needsUser });
    });
    const { task } = await propose(r, "Fix the login redirect", "Login redirect");
    r.hub.emit({ taskId: task.id });
    assert.deepEqual(heard, [{ say: null, needsUser: true }]);
  });
});
