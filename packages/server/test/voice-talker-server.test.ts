/**
 * A small model on this computer, as a server of its own sees it: what a call sends it (not to think, a few tools, a first read
 * of the prompt when the call opens), and that the work (browsing, a delegated task) is never done by it but by the model chosen
 * for the Assistant. The server is a real one on a port of this computer; only the model in it is made up.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeHost as ExecutiveFakeHost } from "../src/assistant/eval/fakeHost.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { forgetToolModes, OpenAiCompatibleProvider, type BrainProvider, type ToolSpec } from "../src/voice/brain.js";
import type { SherpaEngineSet } from "../src/voice/engines/index.js";
import { PROTOCOL_VERSION } from "../src/voice/protocol.js";
import { systemScheduler } from "../src/voice/scheduler.js";
import { VoiceService } from "../src/voice/service.js";
import { primeBrain } from "../src/voice/talker.js";
import { FakeAsr, FakeTts, FakeVad } from "../src/voice/testing.js";
import { FakeConnection, send, start, waitFor } from "./harness.js";

interface Seen {
  body: Record<string, any>;
}

/** An OpenAI-compatible server that says "Hi" to everything; `rejectKwargs` makes it turn down a request that has `chat_template_kwargs`, as a strict server does. */
async function fakeModelServer(options: { rejectKwargs?: boolean } = {}) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
      seen.push({ body });
      if (options.rejectKwargs && "chat_template_kwargs" in body) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unrecognized request argument supplied: chat_template_kwargs" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

async function say(brain: BrainProvider, text = "hello", tools: ToolSpec[] = []): Promise<string> {
  let out = "";
  for await (const event of brain.stream({ messages: [{ role: "user", content: text }], tools, signal: new AbortController().signal })) {
    if (event.type === "text") out += event.delta;
  }
  return out;
}

const tool = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object" } });

describe("what a call sends to a model on this computer", () => {
  it("tells it not to think first, and tells a hosted model nothing it does not know", async () => {
    forgetToolModes();
    const server = await fakeModelServer();
    const local = new OpenAiCompatibleProvider({ baseUrl: server.url, model: "qwen3.5-4b", local: true });
    assert.equal(await say(local), "Hi");
    assert.deepEqual(server.seen[0]?.body["chat_template_kwargs"], { enable_thinking: false });
    assert.equal(local.capabilities.prefixCache, true, "a server of this computer keeps what it has read of a prompt");
    const hosted = new OpenAiCompatibleProvider({ baseUrl: server.url, model: "gpt-x", apiKey: "k", local: false });
    await say(hosted);
    assert.equal("chat_template_kwargs" in (server.seen[1]?.body ?? {}), false);
    assert.equal(hosted.capabilities.prefixCache, undefined);
  });

  it("stops sending it to a server that turns it down, and remembers that, without losing the answer", async () => {
    forgetToolModes();
    const server = await fakeModelServer({ rejectKwargs: true });
    const provider = new OpenAiCompatibleProvider({ baseUrl: server.url, model: "strict", local: true });
    assert.equal(await say(provider), "Hi", "the turn goes through on the second try");
    assert.deepEqual(server.seen.map((s) => "chat_template_kwargs" in s.body), [true, false]);
    assert.equal(await say(provider), "Hi");
    assert.deepEqual(server.seen.map((s) => "chat_template_kwargs" in s.body), [true, false, false], "and is not asked the same again");
  });

  it("makes it read the system text and the tools once, as one word with one token to answer, and no other model", async () => {
    forgetToolModes();
    const server = await fakeModelServer();
    const local = new OpenAiCompatibleProvider({ baseUrl: server.url, model: "qwen3.5-4b", local: true });
    await primeBrain(local, () => ({ system: "You are Vesper.", tools: [tool("delegate_task"), tool("recall")] }));
    assert.equal(server.seen.length, 1);
    const body = server.seen[0]?.body ?? {};
    assert.equal(body["max_tokens"], 1);
    assert.equal(body["temperature"], 0);
    assert.deepEqual(body["messages"][0], { role: "system", content: "You are Vesper." });
    assert.equal(body["messages"].length, 2);
    assert.deepEqual(body["tools"].map((t: { function: { name: string } }) => t.function.name), ["delegate_task", "recall"]);
    assert.deepEqual(body["chat_template_kwargs"], { enable_thinking: false });
    const hosted = new OpenAiCompatibleProvider({ baseUrl: server.url, model: "gpt-x", apiKey: "k", local: false });
    await primeBrain(hosted, () => ({ system: "You are Vesper.", tools: [] }));
    assert.equal(server.seen.length, 1, "a model that keeps nothing is not made to read for nothing");
  });

  it("does not mind a server that is not there, or a host that cannot say what its prompt is", async () => {
    forgetToolModes();
    const gone = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "x", local: true });
    await primeBrain(gone, () => ({ system: "s", tools: [] }));
    await primeBrain(gone, () => {
      throw new Error("no persona yet");
    });
  });
});

function assistantRig() {
  const clock = { t: Date.UTC(2026, 10, 17, 12, 0, 0) };
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true, name: "Vesper" });
  const host = new ExecutiveFakeHost(clock);
  const service = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, host });
  return { clock, store, service };
}

function fakeEngineSet(): SherpaEngineSet {
  const asr = new FakeAsr({}, systemScheduler, 0);
  const tts = new FakeTts(systemScheduler, { msPerChar: 5, latencyMs: 5 });
  return { engines: { vad: new FakeVad(), asr, tts }, asr, tts, report: { runtime: true, vad: true, streaming: true, refine: false, tts: true, ready: true, missing: [] }, dispose: async () => undefined } as unknown as SherpaEngineSet;
}

const HELLO = { type: "hello", v: PROTOCOL_VERSION, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null } as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const limit = Date.now() + ms;
  while (!condition() && Date.now() < limit) await sleep(10);
  assert.ok(condition(), "timed out");
}

describe("a call that opens with a model on this computer", () => {
  async function open(local: boolean) {
    forgetToolModes();
    const server = await fakeModelServer();
    const r = assistantRig();
    const service = new VoiceService({ dataDir: ":memory:", assistant: () => r.service, log: () => undefined, engineFactory: () => fakeEngineSet(), lastProject: () => "/work/atlas", scheduler: systemScheduler, idleUnloadMs: 50 });
    after(() => service.close());
    service.updateSettings({ brain: { kind: "openai", baseUrl: server.url, model: "qwen3.5-4b", local, apiKeyEnv: local ? null : "ANCILLA_TEST_KEY" } });
    const handle = await service.attach({ sendText: () => undefined, sendBinary: () => undefined, close: () => undefined }, HELLO);
    return { server, handle };
  }

  it("reads the start of its prompt before anyone speaks: the persona's system text and the talker's tools", async () => {
    const { server, handle } = await open(true);
    await until(() => server.seen.length >= 1);
    const body = server.seen[0]?.body ?? {};
    assert.equal(body["max_tokens"], 1);
    assert.match(body["messages"][0].content, /^You are Vesper, a personal assistant speaking with its user in a live voice call\./);
    assert.doesNotMatch(body["messages"][0].content, /local time/, "nothing in it moves");
    const offered = body["tools"].map((t: { function: { name: string } }) => t.function.name);
    assert.deepEqual(offered, ["delegate_task", "propose_change", "list_tasks", "task_status", "cancel_task", "recall"], "pause and resume are not among them, and there is no browser or account here");
    assert.ok(offered.length <= 8);
    await sleep(100);
    assert.equal(server.seen.length, 1, "once");
    await handle.close("test");
  });

  it("reads nothing ahead when the model is not on this computer", async () => {
    process.env["ANCILLA_TEST_KEY"] = "k";
    after(() => {
      delete process.env["ANCILLA_TEST_KEY"];
    });
    const { server, handle } = await open(false);
    await sleep(250);
    assert.equal(server.seen.length, 0);
    await handle.close("test");
  });
});

describe("the model that does the work", () => {
  function rigFor(profileModel: { providerId: string; accountId: string | null; modelId: string | null } | null, options: { muse: boolean; account?: boolean }) {
    const r = assistantRig();
    if (profileModel) r.store.saveProfile({ model: profileModel });
    const service = new VoiceService({
      dataDir: ":memory:",
      assistant: () => r.service,
      log: () => undefined,
      engineFactory: () => fakeEngineSet(),
      scheduler: systemScheduler,
      museExec: options.muse ? (async () => ({ exitCode: 0, stdout: "", stderr: "", aborted: false, timedOut: false })) as never : null,
      ...(options.account ? { resolveApiAccount: () => ({ apiKind: "openai" as const, baseUrl: "https://api.example/v1", apiKey: "k", defaultModelId: null, label: "Example", local: false }) } : {}),
    });
    after(() => service.close());
    // The voice itself is a small model on this computer.
    service.updateSettings({ brain: { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3.5-4b", local: true } });
    return service;
  }

  it("is the Assistant's, never the voice's: browsing goes to the model chosen for the Assistant", () => {
    const service = rigFor({ providerId: "muse", accountId: null, modelId: "muse-wonder-full-1.0" }, { muse: true });
    assert.equal(service.status().brain.local, true, "the voice is the local model");
    const browsing = service.browseBrain();
    assert.equal(browsing.problem, null);
    assert.equal(browsing.brain.label, "Muse (muse-wonder-full-1.0)");
    assert.equal(browsing.brain.capabilities.local, false, "a page written by a stranger never reaches the model that only talks");
    assert.deepEqual(service.assistantBrain(), { kind: "muse", model: "muse-wonder-full-1.0" });
  });

  it("follows an API account chosen for the Assistant too", () => {
    const service = rigFor({ providerId: "api", accountId: "acct", modelId: "gpt-x" }, { muse: false, account: true });
    assert.equal(service.browseBrain().brain.label, "Example (gpt-x)");
  });

  it("does not browse with the voice's model when the Assistant has none and Muse is out of reach: it says so", () => {
    const service = rigFor(null, { muse: false });
    const browsing = service.browseBrain();
    assert.match(browsing.problem ?? "", /Muse is not available here/);
    assert.match(browsing.problem ?? "", /Assistant/);
    assert.notEqual(browsing.brain.label, "qwen3.5-4b");
  });
});

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("a task the voice delegates", () => {
  it("runs in a Muse thread on the model chosen for the Assistant, whatever the voice runs on", async () => {
    // The task's folder goes through the credential check, which reads a 28-character run that is not a path as a
    // secret when it looks random. On Windows the last folder name is such a run, so the prefix stays short.
    const project = await mkdtemp(join(tmpdir(), "talker-"));
    dirs.push(project);
    const connection = new FakeConnection();
    let sessions = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${++sessions}` } }));
    connection.replies.set("turn/start", () => ({ turnId: "t1", status: "accepted", disposition: "started" }));
    const { base } = await start(connection);
    // The voice is a small model on this computer; the Assistant is on a Muse model.
    assert.equal((await send(base, "/api/voice/settings", { brain: { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3.5-4b", local: true } }, "PATCH")).status, 200);
    assert.equal((await send(base, "/api/assistant/profile", { enabled: true, model: { providerId: "muse", accountId: null, modelId: "muse-wonder-full-1.0" } }, "PATCH")).status, 200);
    const made = await send(base, "/api/assistant/tasks", { goal: "Read the changelog and list the breaking changes", cwd: project, steps: [{ title: "Read the changelog", effect: "read" }] });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    await waitFor(() => connection.of("session/start").length >= 1, "the task's thread to be started");
    const started = connection.of("session/start")[0]?.params ?? {};
    assert.equal(started["modelId"], "muse-wonder-full-1.0");
    assert.doesNotMatch(JSON.stringify(started), /qwen/);
  });
});
