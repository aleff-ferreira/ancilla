import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import { ConversationStore } from "../src/voice/conversations.js";
import { ambientDigest, HARNESS_TOOLS, HarnessTools, type HarnessMessage, type HarnessReader, type HarnessThread, type HarnessUsage } from "../src/voice/harness.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";

/** The call's read-only view of the harness, against a fake reader: what each tool says, how it clips, how it fails. */

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const MIN = 60_000;

function thread(id: string, title: string, over: Partial<HarnessThread> = {}): HarnessThread {
  return { id, title, project: "atlas", state: "idle", activityAt: NOW - 5 * MIN, ...over };
}

function fake(over: { threads?: HarnessThread[]; usage?: HarnessUsage | null; messages?: HarnessMessage[]; fail?: boolean } = {}): HarnessReader & { asked: { id: string; count: number }[] } {
  const asked: { id: string; count: number }[] = [];
  const usage = over.usage === undefined ? { tier: "Ultra", windowPercent: 12, weeklyPercent: 68, weeklyResetsAt: NOW + 48 * 3_600_000 } : over.usage;
  return {
    asked,
    threads: () => over.threads ?? [],
    messages: async (id, count) => {
      asked.push({ id, count });
      if (over.fail) throw new Error("Muse is not reachable.");
      return over.messages ?? [];
    },
    cachedUsage: () => usage,
    usage: async () => usage,
    projects: () => [{ name: "atlas", threads: 3 }, { name: "notes", threads: 1 }],
    currentProject: () => "atlas",
  };
}

function tools(reader: HarnessReader, taskCounts = { active: 0, waiting: 0 }): HarnessTools {
  return new HarnessTools({ reader, taskCounts: () => taskCounts, now: () => NOW });
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c1", name, arguments: JSON.stringify(args) });

describe("harness tools", () => {
  it("offers at most five small tools", () => {
    assert.ok(HARNESS_TOOLS.length <= 5);
    for (const t of HARNESS_TOOLS) assert.ok(t.description.length < 140, `${t.name} description is short`);
  });

  it("gives one overview: project, running, waiting, tasks, usage", async () => {
    const reader = fake({ threads: [thread("t1", "Fix the login", { state: "running" }), thread("t2", "Ship 0.26", { state: "waiting" }), thread("t3", "Old chat")] });
    const r = await tools(reader, { active: 2, waiting: 1 }).run(call("harness_overview"));
    assert.equal(r.ok, true);
    assert.match(r.text, /Project: atlas\./);
    assert.match(r.text, /Running \(1\): Fix the login/);
    assert.match(r.text, /Waiting on the user \(1\): Ship 0\.26/);
    assert.match(r.text, /Tasks: 2 active, 1 waiting/);
    assert.match(r.text, /68% of the weekly limit, resets in 48 h/);
    assert.doesNotMatch(r.text, /Old chat/);
  });

  it("says plainly when it is quiet and when no usage was read", async () => {
    const r = await tools(fake({ usage: null })).run(call("harness_overview"));
    assert.match(r.text, /Nothing is running\./);
    assert.match(r.text, /Nothing waits on the user\./);
    assert.match(r.text, /No plan usage has been read yet\./);
  });

  it("lists threads with a short id, a state and a time, filtered and limited", async () => {
    const reader = fake({ threads: [thread("aaaaaaaa-1111", "One", { state: "running" }), thread("bbbbbbbb-2222", "Two", { project: "notes" }), thread("cccccccc-3333", "Three")] });
    const all = await tools(reader).run(call("list_threads"));
    assert.match(all.text, /^aaaaaaaa \| One \| atlas \| running \| 5 min ago$/m);
    assert.equal(all.text.split("\n").length, 3);
    assert.equal((await tools(reader).run(call("list_threads", { filter: "running" }))).text.split("\n").length, 1);
    assert.match((await tools(reader).run(call("list_threads", { project: "NOTES" }))).text, /Two/);
    assert.equal((await tools(reader).run(call("list_threads", { limit: 1 }))).text.split("\n").length, 1);
    assert.equal((await tools(reader).run(call("list_threads", { limit: -5 }))).text.split("\n").length, 1, "a limit below one is one");
    assert.equal((await tools(fake()).run(call("list_threads"))).text, "No threads fit that.");
  });

  it("clips long titles and long messages, and asks for a bounded number of messages", async () => {
    const long = "word ".repeat(200);
    const reader = fake({ threads: [thread("t1", long)], messages: [{ role: "user", text: "Hi" }, { role: "assistant", text: long }] });
    const list = await tools(reader).run(call("list_threads"));
    assert.ok(list.text.length < 160, `list line is short (${list.text.length})`);
    const read = await tools(reader).run(call("read_thread", { thread: "latest", count: 500 }));
    assert.deepEqual(reader.asked, [{ id: "t1", count: 10 }], "the count is capped");
    assert.match(read.text, /User: Hi/);
    const assistantLine = read.text.split("\n").find((l) => l.startsWith("Assistant:")) ?? "";
    assert.ok(assistantLine.length <= 520, `message clipped (${assistantLine.length})`);
    assert.match(assistantLine, /\.\.\.$/);
  });

  it("finds a thread by id prefix, by title, or as latest, and refuses an unclear one", async () => {
    const reader = fake({ threads: [thread("abc123", "Fix login"), thread("abd456", "Fix logout")], messages: [{ role: "user", text: "x" }] });
    const t = tools(reader);
    assert.equal((await t.run(call("read_thread", { thread: "abc" }))).ok, true);
    assert.equal((await t.run(call("read_thread", { thread: "logout" }))).ok, true);
    assert.deepEqual(reader.asked.map((a) => a.id), ["abc123", "abd456"]);
    const two = await t.run(call("read_thread", { thread: "fix" }));
    assert.equal(two.ok, false);
    assert.match(two.text, /More than one/);
    const none = await t.run(call("read_thread", { thread: "zzz" }));
    assert.equal(none.ok, false);
    assert.equal((await tools(fake()).run(call("read_thread", { thread: "latest" }))).ok, false);
  });

  it("turns a failing reader into a spoken error, not a throw", async () => {
    const reader = fake({ threads: [thread("t1", "A")], fail: true });
    const r = await tools(reader).run(call("read_thread", { thread: "t1" }));
    assert.equal(r.ok, false);
    assert.match(r.text, /Muse is not reachable/);
    assert.equal((await tools(reader).run(call("nope"))).ok, false);
  });

  it("reports usage and projects, and tolerates broken arguments", async () => {
    const t = tools(fake());
    assert.match((await t.run(call("usage"))).text, /Plan Ultra: 12% of the five-hour limit; 68% of the weekly limit/);
    assert.equal((await t.run(call("list_projects"))).text, "atlas: 3 threads\nnotes: 1 thread");
    assert.equal((await t.run({ id: "c", name: "list_threads", arguments: "{not json" })).ok, true);
  });
});

describe("the right-now block", () => {
  it("is null when nothing is going on and usage is low", () => {
    assert.equal(ambientDigest(fake({ threads: [thread("t1", "Idle")] }), { active: 1, waiting: 0 }, NOW), null);
  });

  it("names what runs and what waits, in at most a few short lines", () => {
    const threads = [1, 2, 3, 4, 5].map((n) => thread(`r${n}`, `Run ${n}`, { state: "running" })).concat(thread("w", "Needs approval", { state: "waiting" }));
    const text = ambientDigest(fake({ threads }), { active: 2, waiting: 2 }, NOW) ?? "";
    assert.match(text, /^Right now in Ancilla:/);
    assert.match(text, /Running now: Run 1; Run 2; Run 3 and 2 more\./);
    assert.match(text, /Waiting on the user: Needs approval\./);
    assert.match(text, /2 background tasks wait on the user\./);
    assert.ok(text.split("\n").length <= 6);
    assert.doesNotMatch(text, /weekly/, "usage below 80% is left out");
  });

  it("adds usage only at 80% or more", () => {
    const high = ambientDigest(fake({ usage: { tier: "Ultra", windowPercent: 5, weeklyPercent: 83, weeklyResetsAt: null } }), { active: 0, waiting: 0 }, NOW) ?? "";
    assert.match(high, /83% of the weekly limit/);
  });
});

describe("the call host with a harness", () => {
  function host(harness: HarnessReader | null) {
    const store = MemoryStore.open(":memory:");
    store.saveProfile({ enabled: true });
    const assistant = new AssistantService(store, { log: () => undefined, emit: () => undefined });
    const conversations = new ConversationStore(store);
    return new AssistantVoiceHost({ assistant, conversations, conversationId: conversations.create(null), settings: () => ({ ...DEFAULT_VOICE_SETTINGS }), hub: new TaskHub(), project: () => null, harness, log: () => undefined });
  }

  it("puts the block in the turn's context and the tools in its list, only with a harness", async () => {
    const busy = host(fake({ threads: [thread("t1", "Fix login", { state: "running" })] }));
    assert.match((await busy.context("what is going on?", "voice")) ?? "", /Running now: Fix login/);
    assert.ok(busy.tools().some((t) => t.name === "harness_overview"));
    const plain = host(null);
    assert.doesNotMatch((await plain.context("what is going on?", "voice")) ?? "", /Right now/);
    assert.ok(!plain.tools().some((t) => t.name === "harness_overview"));
  });

  it("runs a harness tool and still runs a task tool", async () => {
    const h = host(fake());
    assert.match((await h.runTool(call("usage"), { turn: 1, signal: new AbortController().signal })).text, /Plan Ultra/);
    assert.equal((await h.runTool(call("list_tasks"), { turn: 1, signal: new AbortController().signal })).ok, true);
  });

  it("does not let a broken reader break the turn", async () => {
    const reader = fake();
    reader.threads = () => {
      throw new Error("store closed");
    };
    assert.doesNotMatch((await host(reader).context("hello", "voice")) ?? "", /Right now/);
  });
});
