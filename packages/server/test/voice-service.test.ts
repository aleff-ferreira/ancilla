/**
 * The voice around the call: what is kept of a conversation, the settings and the key that is never sent back, the tools
 * that start and steer tasks, and a whole call over a real WebSocket with the models replaced by doubles. The last group
 * is the front door of the socket: a page of another site, a request with no token and a host that is not ours are all
 * refused before the handshake.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { FakeHost as ExecutiveFakeHost, flush } from "../src/assistant/eval/fakeHost.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import type { BrainProvider } from "../src/voice/brain.js";
import { ConversationStore } from "../src/voice/conversations.js";
import type { SherpaEngineSet } from "../src/voice/engines/index.js";
import { AUDIO_IN, PROTOCOL_VERSION, decodeAudioOut } from "../src/voice/protocol.js";
import { handleVoice } from "../src/voice/routes.js";
import { systemScheduler } from "../src/voice/scheduler.js";
import { VoiceService } from "../src/voice/service.js";
import { applySettingsPatch, DEFAULT_VOICE_SETTINGS, VoiceSettingsStore } from "../src/voice/settings.js";
import { FakeAsr, FakeTts, FakeVad, ScriptedBrain, pitchOf, tone, type Reply } from "../src/voice/testing.js";
import { VoiceTools } from "../src/voice/tools.js";
import { VOICE_SOCKET_PATH, VoiceSocketServer } from "../src/voice/ws.js";
import { FakeConnection, rawRequest, start } from "./harness.js";

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

function assistantRig() {
  const clock = { t: T0 };
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true });
  const host = new ExecutiveFakeHost(clock);
  const service = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, host });
  return { clock, store, host, service };
}

describe("the conversations that are kept", () => {
  it("keeps what was said, names the conversation after the first thing the person said, and gives a model what was heard", () => {
    const { store, clock } = assistantRig();
    const conversations = new ConversationStore(store, () => clock.t);
    const id = conversations.create("/work/atlas");
    conversations.append(id, { turn: 1, role: "user", text: "What did we decide about the invoices database", source: "voice", at: clock.t });
    conversations.append(id, { turn: 1, role: "assistant", text: "You chose the Frankfurt region. It is cheaper and closer.", source: "voice", at: clock.t, heard: "You chose the Frankfurt region.", interrupted: true });
    conversations.append(id, { turn: 2, role: "user", text: "ok", source: "text", at: clock.t });
    const summary = conversations.get(id);
    assert.equal(summary?.title, "What did we decide about the invoices database");
    assert.equal(summary?.turns, 2);
    const history = conversations.history(id);
    assert.deepEqual(history[0], { role: "user", content: "What did we decide about the invoices database" });
    assert.deepEqual(history[1], { role: "assistant", content: "You chose the Frankfurt region. [the user interrupted here]" }, "only what was heard goes back to the model, marked as cut off");
    assert.equal(history.length, 3);
  });

  it("goes on from the last conversation, renames, deletes one, and purges all of them", () => {
    const { store, clock } = assistantRig();
    const conversations = new ConversationStore(store, () => clock.t);
    const a = conversations.create(null);
    clock.t += 1000;
    const b = conversations.create(null);
    conversations.append(a, { turn: 1, role: "user", text: "first", source: "voice", at: clock.t });
    clock.t += 1000;
    conversations.append(b, { turn: 1, role: "user", text: "second", source: "voice", at: clock.t });
    assert.equal(conversations.latest()?.id, b);
    assert.equal(conversations.rename(a, "Budget talk"), true);
    assert.equal(conversations.get(a)?.title, "Budget talk");
    assert.equal(conversations.remove(a), true);
    assert.equal(conversations.get(a), null);
    assert.equal(conversations.utterances(a).length, 0, "its lines went with it");
    assert.equal(conversations.purge(null), 1);
    assert.equal(conversations.list().length, 0);
  });

  it("deletes only the conversations older than a date when asked to", () => {
    const { store, clock } = assistantRig();
    const conversations = new ConversationStore(store, () => clock.t);
    const old = conversations.create(null);
    conversations.append(old, { turn: 1, role: "user", text: "long ago", source: "voice", at: clock.t });
    clock.t += 10 * 86_400_000;
    const fresh = conversations.create(null);
    conversations.append(fresh, { turn: 1, role: "user", text: "today", source: "voice", at: clock.t });
    assert.equal(conversations.purge(clock.t - 5 * 86_400_000), 1);
    assert.deepEqual(conversations.list().map((c) => c.id), [fresh]);
  });
});

describe("the voice settings", () => {
  it("checks every field and keeps what it was not told about", () => {
    const next = applySettingsPatch(DEFAULT_VOICE_SETTINGS, { speed: 1.2, voice: "pt:F2", brain: { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen", local: true } });
    assert.equal(next.speed, 1.2);
    assert.equal(next.voice, "pt:F2");
    assert.equal(next.brain.kind, "openai");
    assert.equal(next.refine, true, "untouched");
    for (const bad of [{ speed: 9 }, { voice: "F2" }, { brain: { kind: "openai", baseUrl: "file:///etc/passwd", model: "x" } }, { brain: { kind: "wizard" } }, { surprise: 1 }, { ttsSteps: 50 }, { mode: "shouting" }]) {
      assert.throws(() => applySettingsPatch(DEFAULT_VOICE_SETTINGS, bad), /./, JSON.stringify(bad));
    }
  });

  it("saves a key apart, owner-only, and never hands it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-voice-settings-"));
    after(() => rm(dir, { recursive: true, force: true }));
    const store = new VoiceSettingsStore(dir);
    const view = store.update({ brain: { kind: "openai", baseUrl: "https://api.example.com/v1", model: "fast-1", local: false }, apiKey: "sk-secret-123" });
    assert.equal(view.hasKey, true);
    assert.equal(JSON.stringify(view).includes("sk-secret-123"), false, "the page never sees the key");
    const settingsText = await readFile(join(dir, "voice.json"), "utf8");
    assert.equal(settingsText.includes("sk-secret-123"), false, "the settings file does not hold it either");
    const secrets = await readFile(join(dir, "voice-secrets.json"), "utf8");
    assert.match(secrets, /sk-secret-123/);
    if (process.platform !== "win32") assert.equal((await stat(join(dir, "voice-secrets.json"))).mode & 0o077, 0, "only the owner can read the keys file");
    // A new store reads both back.
    const again = new VoiceSettingsStore(dir);
    assert.equal(again.get().brain.kind, "openai");
    assert.equal(again.keyFor(again.get().brain), "sk-secret-123");
    // The key follows the model: another model has none.
    again.update({ brain: { kind: "openai", baseUrl: "https://api.example.com/v1", model: "other", local: false } });
    assert.equal(again.view().hasKey, false);
    // And an environment variable can stand in for a saved key.
    process.env.ANCILLA_TEST_VOICE_KEY = "from-env";
    after(() => {
      delete process.env.ANCILLA_TEST_VOICE_KEY;
    });
    again.update({ brain: { kind: "openai", baseUrl: "https://api.example.com/v1", model: "other", local: false, apiKeyEnv: "ANCILLA_TEST_VOICE_KEY" } });
    assert.equal(again.keyFor(again.get().brain), "from-env");
  });

  it("does not let the page choose the folders the server loads native code from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-voice-folders-"));
    after(() => rm(dir, { recursive: true, force: true }));
    const store = new VoiceSettingsStore(dir);
    assert.throws(() => store.update({ runtimeDir: "/tmp/anywhere" }), /not from the page/);
    assert.throws(() => store.update({ modelsDir: "/tmp/anywhere", speed: 1.1 }), /not from the page/);
    assert.equal(store.get().speed, 1, "nothing was applied");
    // The file is the way: whoever can edit it can already run code as the user.
    await writeFile(join(dir, "voice.json"), JSON.stringify({ runtimeDir: "/opt/voice/runtime", modelsDir: "/opt/voice/models" }));
    const fromFile = new VoiceSettingsStore(dir);
    assert.equal(fromFile.get().runtimeDir, "/opt/voice/runtime");
    assert.equal(fromFile.get().modelsDir, "/opt/voice/models");
  });

  it("falls back to the defaults when the file is broken, and says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-voice-broken-"));
    after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "voice.json"), "{ not json");
    const lines: string[] = [];
    const store = new VoiceSettingsStore(dir, (l) => lines.push(l));
    assert.deepEqual(store.get(), DEFAULT_VOICE_SETTINGS);
    assert.match(lines.join("\n"), /settings file could not be read/);
  });
});

describe("what the voice can do with tasks", () => {
  it("starts a task that only reads, in the project it was told, and says so to the model", async () => {
    const r = assistantRig();
    const tools = new VoiceTools({ assistant: r.service, project: () => "/work/atlas", lang: () => "en", conversationId: "cv_1" });
    const result = await tools.run({ id: "c1", name: "delegate_task", arguments: JSON.stringify({ goal: "Summarise the open issues in the tracker", title: "Open issues" }) });
    assert.equal(result.ok, true);
    assert.match(result.text, /cannot change files/);
    assert.equal(result.narration, "I've started that in the background.");
    await flush();
    const [task] = r.service.tasks.list("all");
    assert.equal(task?.title, "Open issues");
    assert.equal(task?.allowWrites, false, "a task started by voice never may write");
    assert.equal(task?.cwd, "/work/atlas");
    assert.equal(task?.origin, "user");
  });

  it("refuses to start one without a project, or without a goal, and offers only what can run", async () => {
    const r = assistantRig();
    const noProject = new VoiceTools({ assistant: r.service, project: () => null, lang: () => "en", conversationId: "cv_1" });
    assert.equal((await noProject.run({ id: "c", name: "delegate_task", arguments: JSON.stringify({ goal: "Look into it" }) })).ok, false);
    const tools = new VoiceTools({ assistant: r.service, project: () => "/work/atlas", lang: () => "pt", conversationId: "cv_1" });
    assert.equal((await tools.run({ id: "c", name: "delegate_task", arguments: "{}" })).ok, false);
    assert.equal((await tools.run({ id: "c", name: "delegate_task", arguments: "not json" })).ok, false);
    const unknown = await tools.run({ id: "c", name: "launch_missiles", arguments: "{}" });
    assert.equal(unknown.ok, false);
    assert.equal(r.service.tasks.list("all").length, 0, "nothing was started by any of those");
    const memoryOnly = new AssistantService(MemoryStore.open(":memory:"), { log: () => undefined, emit: () => undefined });
    const bare = new VoiceTools({ assistant: memoryOnly, project: () => "/work/atlas", lang: () => "en", conversationId: "cv_2" });
    assert.deepEqual(bare.specs().map((s) => s.name), ["recall"], "no host to run tasks on: the model is not offered tasks");
    const portuguese = await tools.run({ id: "c", name: "delegate_task", arguments: JSON.stringify({ goal: "Resumir as issues abertas" }) });
    assert.equal(portuguese.narration, "Já comecei isso em segundo plano.");
  });

  it("lists, pauses, resumes and cancels tasks by id, a prefix or the word last", async () => {
    const r = assistantRig();
    const tools = new VoiceTools({ assistant: r.service, project: () => "/work/atlas", lang: () => "en", conversationId: "cv_1" });
    await tools.run({ id: "1", name: "delegate_task", arguments: JSON.stringify({ goal: "Read the changelog and list breaking changes", title: "Breaking changes" }) });
    await flush();
    const listed = await tools.run({ id: "2", name: "list_tasks", arguments: "{}" });
    assert.match(listed.text, /Breaking changes/);
    const paused = await tools.run({ id: "3", name: "pause_task", arguments: JSON.stringify({ id: "last" }) });
    assert.equal(paused.ok, true, paused.text);
    assert.match(paused.text, /paused/);
    const resumed = await tools.run({ id: "4", name: "resume_task", arguments: JSON.stringify({ id: "last" }) });
    assert.equal(resumed.ok, true, resumed.text);
    const [task] = r.service.tasks.list("all");
    const cancelled = await tools.run({ id: "5", name: "cancel_task", arguments: JSON.stringify({ id: (task?.id ?? "").slice(0, 6) }) });
    assert.equal(cancelled.ok, true, cancelled.text);
    assert.equal(r.service.tasks.get(task?.id ?? "")?.status, "cancelled");
    const again = await tools.run({ id: "6", name: "pause_task", arguments: JSON.stringify({ id: "last" }) });
    assert.equal(again.ok, false, "a finished task cannot be paused, and the model is told why");
    const missing = await tools.run({ id: "7", name: "task_status", arguments: JSON.stringify({ id: "nothing-like-it" }) });
    assert.equal(missing.ok, false);
  });
});

// -----------------------------------------------------------------------------------------------------------------------
// A call over a real socket

const SENTENCES = { 1: "What time is it", 2: "Remind me to call Marcos tomorrow" };

function fakeEngineSet(): SherpaEngineSet {
  const asr = new FakeAsr(SENTENCES, systemScheduler, 0);
  const tts = new FakeTts(systemScheduler, { msPerChar: 15, latencyMs: 10 });
  const set = { engines: { vad: new FakeVad(), asr, tts }, asr, tts, report: { runtime: true, vad: true, streaming: true, refine: false, tts: true, ready: true, missing: [] }, dispose: async () => undefined };
  return set as unknown as SherpaEngineSet;
}

function frame(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(1 + pcm.length * 2);
  out[0] = AUDIO_IN;
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i] as number, 1 + i * 2);
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function callRig(brainScript?: (messages: Parameters<ConstructorParameters<typeof ScriptedBrain>[1]>[0], call: number) => Reply) {
  const r = assistantRig();
  const script = brainScript ?? (() => ({ text: "Sure. It is noon.", ttftMs: 30, pieceMs: 5 }));
  const museBrain = (): BrainProvider => new ScriptedBrain(systemScheduler, script);
  const service = new VoiceService({
    dataDir: ":memory:",
    assistant: () => r.service,
    log: () => undefined,
    museBrain,
    engineFactory: () => fakeEngineSet(),
    lastProject: () => "/work/atlas",
    scheduler: systemScheduler,
    idleUnloadMs: 50,
  });
  const sockets = new VoiceSocketServer(() => service, () => undefined);
  const http: Server = createServer();
  http.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  after(async () => {
    sockets.close();
    await service.close();
    http.closeAllConnections?.();
    http.close();
  });
  const port = (http.address() as AddressInfo).port;
  return { clock: r.clock, store: r.store, assistant: r.service, voice: service, url: `ws://127.0.0.1:${port}${VOICE_SOCKET_PATH}` };
}

interface Client {
  ws: WebSocket;
  texts: Array<Record<string, any>>;
  audio: Array<{ utterance: number; samples: number }>;
  closed: Promise<{ code: number; reason: string }>;
  waitFor(predicate: (message: Record<string, any>) => boolean, ms?: number): Promise<Record<string, any>>;
}

/** A browser's side of a call: it plays what it is sent as fast as it comes, and says so. */
async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(url, { headers });
  const texts: Client["texts"] = [];
  const audio: Client["audio"] = [];
  const played = new Map<number, number>();
  const waiters: Array<{ predicate: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const decoded = decodeAudioOut(data as Buffer);
      if (!decoded) return;
      audio.push({ utterance: decoded.utterance, samples: decoded.pcm.length });
      const total = (played.get(decoded.utterance) ?? 0) + decoded.pcm.length;
      played.set(decoded.utterance, total);
      ws.send(JSON.stringify({ type: "playback", utterance: decoded.utterance, samples: total }));
      return;
    }
    const message = JSON.parse(String(data)) as Record<string, any>;
    texts.push(message);
    for (const w of [...waiters]) {
      if (w.predicate(message)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(message);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`refused with ${res.statusCode}`), { status: res.statusCode })));
  });
  return {
    ws,
    texts,
    audio,
    closed,
    waitFor: (predicate, ms = 8000) => {
      const seen = texts.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(texts.map((t) => t.type))}`)), ms);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
}

function hello(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null, ...extra });
}

/** Speaks into the socket at the pace of a microphone. */
async function speak(client: Client, code: number, ms: number): Promise<void> {
  const samples = 512;
  const frames = Math.round((ms * 16) / samples);
  const sound = tone(pitchOf(code), (frames * samples) / 16, 0.3);
  for (let i = 0; i < frames; i++) {
    client.ws.send(frame(sound.subarray(i * samples, (i + 1) * samples)), { binary: true });
    await sleep(32);
  }
}

async function quiet(client: Client, ms: number): Promise<void> {
  const silence = new Int16Array(512);
  for (let t = 0; t < ms; t += 32) {
    client.ws.send(frame(silence), { binary: true });
    await sleep(32);
  }
}

describe("a call over a socket", () => {
  it("opens, hears a sentence, answers aloud, keeps the conversation and ends when the person hangs up", async () => {
    const rig = await callRig();
    const client = await connect(rig.url);
    client.ws.send(hello());
    const ready = await client.waitFor((m) => m.type === "ready");
    assert.equal(ready.sampleRate, 16000);
    await speak(client, 1, 1300);
    await quiet(client, 1700);
    const user = await client.waitFor((m) => m.type === "user");
    assert.equal(user.text, "What time is it");
    const answer = await client.waitFor((m) => m.type === "assistant" && m.done === true);
    assert.match(answer.text, /It is noon/);
    await client.waitFor((m) => m.type === "metrics");
    await client.waitFor((m) => m.type === "speak_end");
    assert.ok(client.audio.length > 0, "the reply came as audio");
    // The turn is in the conversation, as words only.
    const conversations = new ConversationStore(rig.store);
    const [conversation] = conversations.list();
    const lines = conversations.utterances(conversation?.id ?? "");
    assert.equal(lines[0]?.role, "user");
    assert.equal(lines[0]?.text, "What time is it");
    assert.equal(lines[1]?.role, "assistant");
    assert.match(lines[1]?.text ?? "", /It is noon/);
    assert.equal(rig.voice.status().call.active, true);
    client.ws.send(JSON.stringify({ type: "end" }));
    const closed = await client.closed;
    assert.equal(closed.code, 1000);
    assert.equal(rig.voice.status().call.active, false);
  });

  it("goes on from the earlier conversation when a call opens again, and lets a second window take the call over", async () => {
    const rig = await callRig();
    const first = await connect(rig.url);
    first.ws.send(hello());
    await first.waitFor((m) => m.type === "ready");
    await speak(first, 2, 1400);
    await quiet(first, 1700);
    await first.waitFor((m) => m.type === "speak_end");
    const conversations = new ConversationStore(rig.store);
    const original = conversations.list()[0]?.id;
    assert.ok(original);
    const second = await connect(rig.url);
    second.ws.send(hello());
    const ready = await second.waitFor((m) => m.type === "ready");
    assert.equal(ready.resumed, true, "the earlier turns were loaded");
    const closed = await first.closed;
    assert.match(closed.reason, /took the call over/);
    assert.equal(conversations.list().length, 1, "the same conversation, not a new one");
    assert.equal(conversations.list()[0]?.id, original);
    second.ws.send(JSON.stringify({ type: "end" }));
    await second.closed;
  });

  it("refuses a first message that is not a hello and a wrong version, and shrugs off garbage", async () => {
    const rig = await callRig();
    const wrongFirst = await connect(rig.url);
    wrongFirst.ws.send(JSON.stringify({ type: "mute", on: true }));
    assert.equal((await wrongFirst.closed).code, 4002);
    const oldPage = await connect(rig.url);
    oldPage.ws.send(hello({ v: 99 }));
    assert.equal((await oldPage.waitFor((m) => m.type === "error")).code, "version");
    assert.equal((await oldPage.closed).code, 4003);
    const garbage = await connect(rig.url);
    garbage.ws.send("}{ not json");
    garbage.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    garbage.ws.send(hello());
    await garbage.waitFor((m) => m.type === "ready");
    garbage.ws.send(JSON.stringify({ type: "end" }));
    await garbage.closed;
  });

  it("starts a spoken task when the model asks for one, as a task that cannot change anything", async () => {
    const rig = await callRig((messages, call) => {
      const last = messages[messages.length - 1];
      if (last && last.role === "tool") return { text: "On it. I will tell you when it is done.", ttftMs: 20 };
      return call === 1 ? { tool: { name: "delegate_task", args: { goal: "Read the changelog and list the breaking changes", title: "Breaking changes" } }, ttftMs: 20 } : { text: "ok", ttftMs: 10 };
    });
    const client = await connect(rig.url);
    client.ws.send(hello());
    await client.waitFor((m) => m.type === "ready");
    await speak(client, 2, 1500);
    await quiet(client, 1800);
    await client.waitFor((m) => m.type === "assistant" && m.done === true, 10_000);
    await flush();
    const [task] = rig.assistant.tasks.list("all");
    assert.equal(task?.title, "Breaking changes");
    assert.equal(task?.allowWrites, false);
    assert.equal(task?.cwd, "/work/atlas", "in the project the server last knew");
    client.ws.send(JSON.stringify({ type: "end" }));
    await client.closed;
  });

  it("lets go of the models a while after the last call", async () => {
    const rig = await callRig();
    const client = await connect(rig.url);
    client.ws.send(hello());
    await client.waitFor((m) => m.type === "ready");
    assert.equal(rig.voice.status().engines.loaded, true);
    client.ws.send(JSON.stringify({ type: "end" }));
    await client.closed;
    await sleep(250);
    assert.equal(rig.voice.status().engines.loaded, false);
  });
});

describe("the routes of the voice", () => {
  it("reports what is installed, saves settings and never returns a key", async () => {
    const r = assistantRig();
    const service = new VoiceService({ dataDir: ":memory:", assistant: () => r.service, log: () => undefined, engineFactory: () => fakeEngineSet() });
    const noBody = async () => ({}) as Record<string, unknown>;
    const status = await handleVoice(service, { method: "GET", path: "/api/voice", query: new URLSearchParams(), body: noBody });
    assert.equal(status.status, 200);
    assert.equal((status.body as { available: boolean }).available, false, "nothing is installed in an empty folder");
    const saved = await handleVoice(service, { method: "PATCH", path: "/api/voice/settings", query: new URLSearchParams(), body: async () => ({ brain: { kind: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "m", local: true }, apiKey: "k-123" }) });
    assert.equal(saved.status, 200);
    assert.equal(JSON.stringify(saved.body).includes("k-123"), false);
    const invalid = await handleVoice(service, { method: "PATCH", path: "/api/voice/settings", query: new URLSearchParams(), body: async () => ({ speed: 99 }) });
    assert.equal(invalid.status, 400);
    const conversations = await handleVoice(service, { method: "GET", path: "/api/voice/conversations", query: new URLSearchParams(), body: noBody });
    assert.equal(conversations.status, 200);
    const missing = await handleVoice(service, { method: "GET", path: "/api/voice/conversations/cv_nope", query: new URLSearchParams(), body: noBody });
    assert.equal(missing.status, 404);
    const refused = await handleVoice(service, { method: "DELETE", path: "/api/voice/conversations", query: new URLSearchParams(), body: noBody });
    assert.equal(refused.status, 400, "deleting everything takes an explicit all=1");
    await service.close();
  });
});

describe("the front door of the call's socket", () => {
  it("refuses a page of another site, a request with no token and a host that is not ours, and lets the right one through", async () => {
    const { base } = await start(new FakeConnection(), { token: "s3cret", allowOrigins: ["https://listed.example"] });
    const url = `${base.replace("http", "ws")}${VOICE_SOCKET_PATH}`;
    const port = new URL(base).port;
    const attempt = async (headers: Record<string, string>) => {
      try {
        const client = await connect(url, headers);
        client.ws.close();
        return 101;
      } catch (error) {
        return (error as { status?: number }).status ?? 0;
      }
    };
    assert.equal(await attempt({}), 401, "no token");
    assert.equal(await attempt({ authorization: "Bearer wrong" }), 401, "a wrong token");
    assert.equal(await attempt({ authorization: "Bearer s3cret", origin: "https://evil.example" }), 403, "a page of an unlisted site, token or not");
    assert.equal(await attempt({ cookie: "ancilla_token=s3cret", origin: "https://evil.example" }), 403, "its cookie does not help it");
    assert.equal(await attempt({ authorization: "Bearer s3cret", host: "evil.example" }), 101, "a valid bearer token skips the host check, as for the rest of the API");
    assert.equal(await attempt({ cookie: "ancilla_token=s3cret", host: "evil.example" }), 403, "a cookie does not: it is the browser that decides when it is sent");
    assert.equal(await attempt({ cookie: "ancilla_token=s3cret", origin: `http://127.0.0.1:${port}` }), 101, "the page served from here, with its cookie");
    assert.equal(await attempt({ cookie: "ancilla_token=s3cret", origin: "https://listed.example" }), 101, "a listed origin with the cookie");
    const wrongPath = await rawRequest(base, "/api/voice/not-the-socket", { headers: { connection: "Upgrade", upgrade: "websocket" } });
    assert.ok(wrongPath.status === 401 || wrongPath.status === 404);
  });

  it("answers a call that cannot start with a plain explanation, not a crash", async () => {
    const { base } = await start(new FakeConnection());
    const client = await connect(`${base.replace("http", "ws")}${VOICE_SOCKET_PATH}`);
    client.ws.send(hello());
    const error = await client.waitFor((m) => m.type === "error");
    assert.match(error.message, /not installed|memory|could not start/i);
    await client.closed;
  });
});
