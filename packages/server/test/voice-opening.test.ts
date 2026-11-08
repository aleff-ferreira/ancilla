import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { parseTaskSpec, type TaskStatus } from "../src/assistant/tasks.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import { ConversationStore } from "../src/voice/conversations.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";

/**
 * What a call opens with: the work that finished, failed or waits on the person since they last talked, said once, so that
 * a call goes on from where the work stands and not only from what was said. These are the host's half (what is news, in
 * what order, in which language); the session's half (when it is said, and not over the person) is in voice-session.
 */

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;

function rig(options: { proactive?: boolean; resume?: boolean } = {}) {
  const clock = { t: T0 };
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true });
  const assistant = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t });
  const conversations = new ConversationStore(store, () => clock.t);
  const earlier = conversations.create(null);
  const call = options.resume ? earlier : conversations.create(null);
  const host = new AssistantVoiceHost({
    assistant,
    conversations,
    conversationId: call,
    settings: () => ({ ...DEFAULT_VOICE_SETTINGS, proactive: options.proactive ?? true }),
    hub: new TaskHub(),
    project: () => null,
    log: () => undefined,
  });
  return {
    host,
    clock,
    /** They talked, in the earlier conversation, and the clock moves on. */
    talk(text = "Hello there.") {
      clock.t += MIN;
      conversations.append(earlier, { turn: 1, role: "user", text, source: "voice", at: clock.t });
      clock.t += MIN;
    },
    /** A task that reaches a state at the current time. */
    task(title: string, status: TaskStatus, reason = "") {
      const made = assistant.tasks.create(parseTaskSpec({ goal: title, cwd: "/work/atlas", title }, store.getProfile(), (c) => c));
      return assistant.tasks.setStatus(made.id, status, reason, status === "completed" || status === "unverified" ? { result: "ok" } : {});
    },
  };
}

describe("what a call opens with", () => {
  it("says nothing when nothing changed", () => {
    const r = rig();
    r.talk();
    assert.equal(r.host.opening(), null);
    r.task("Index the notes", "running");
    assert.equal(r.host.opening(), null, "work that is still going on is not news");
  });

  it("says what finished since they last talked, and not what was done before", () => {
    const r = rig();
    r.task("Old report", "completed");
    r.talk();
    r.task("Weekly report", "completed");
    const said = r.host.opening();
    assert.match(said ?? "", /^While you were away: Weekly report is done\.$/);
    assert.ok(!(said ?? "").includes("Old report"));
  });

  it("puts what waits on them first, names two, and counts the rest", () => {
    const r = rig();
    r.talk();
    r.task("Report one", "completed");
    r.task("Report two", "completed");
    r.task("Build check", "failed");
    r.task("Release notes", "blocked", "needs approval");
    assert.equal(r.host.opening(), "While you were away: Release notes needs your approval. Build check did not go through. And 2 more.");
  });

  it("leaves out what they cancelled themselves", () => {
    const r = rig();
    r.talk();
    r.task("Backup", "cancelled");
    assert.equal(r.host.opening(), null);
  });

  it("says only what waits on them when they have never talked", () => {
    const r = rig();
    r.task("Report", "completed");
    r.task("Release notes", "blocked", "needs approval");
    assert.equal(r.host.opening(), "While you were away: Release notes needs your approval.");
  });

  it("says nothing when they asked for nothing unprompted", () => {
    const r = rig({ proactive: false });
    r.talk();
    r.task("Weekly report", "completed");
    assert.equal(r.host.opening(), null);
  });

  it("goes on in the language the conversation was in", () => {
    const r = rig({ resume: true });
    r.talk("Que horas são agora, por favor?");
    r.task("Relatório semanal", "completed");
    // The earlier turns are loaded as the call opens, and that is what tells it which language they were in.
    r.host.history(null);
    assert.equal(r.host.opening(), "Enquanto você esteve fora: Relatório semanal está pronto.");
  });
});
