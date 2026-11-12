import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";
import { FakeHost as ExecutiveFakeHost } from "../src/assistant/eval/fakeHost.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import type { SherpaEngineSet } from "../src/voice/engines/index.js";
import type { MuseBrainHost } from "../src/voice/muse-brain.js";
import { PROTOCOL_VERSION, decodeAudioOut } from "../src/voice/protocol.js";
import { systemScheduler } from "../src/voice/scheduler.js";
import { VoiceService } from "../src/voice/service.js";
import { FakeAsr, FakeTts, FakeVad } from "../src/voice/testing.js";
import { VOICE_SOCKET_PATH, VoiceSocketServer } from "../src/voice/ws.js";
import { FakeConnection, get, send, start } from "./harness.js";

function fakeEngineSet(): SherpaEngineSet {
  const asr = new FakeAsr({}, systemScheduler, 0);
  const tts = new FakeTts(systemScheduler, { msPerChar: 5, latencyMs: 5 });
  const set = {
    engines: { vad: new FakeVad(), asr, tts },
    asr,
    tts,
    report: { runtime: true, vad: true, streaming: true, refine: false, tts: true, ready: true, missing: [] },
    dispose: async () => undefined,
  };
  return set as unknown as SherpaEngineSet;
}

interface WsClient {
  ws: WebSocket;
  texts: Array<Record<string, any>>;
  waitFor(predicate: (message: Record<string, any>) => boolean, ms?: number): Promise<Record<string, any>>;
}

async function connect(url: string): Promise<WsClient> {
  const ws = new WebSocket(url);
  const texts: Array<Record<string, any>> = [];
  const played = new Map<number, number>();
  const waiters: Array<{ predicate: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }> = [];

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const decoded = decodeAudioOut(data as Buffer);
      if (!decoded) return;
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

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  return {
    ws,
    texts,
    waitFor: (predicate, ms = 8000) => {
      const seen = texts.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting on call socket; saw ${JSON.stringify(texts.map((t) => t.type))}`)),
          ms,
        );
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

describe("assistant model unified sync and live mid-call switching", () => {
  it("syncs PATCH /api/assistant/profile model changes to VoiceService status while keeping chat threads separate", async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "ancilla-voice-sync-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const conn = new FakeConnection();
    conn.replies.set("session/list", { sessions: [], nextCursor: null });
    conn.replies.set("session/start", {
      session: {
        sessionId: "chat-sess-1",
        workspaceRoot: workspace,
        modelId: "muse-wonder-1.0",
        status: "idle",
      },
    });
    const { base } = await start(conn);
    await send(base, "/api/projects", { cwd: workspace });

    // Start a separate Chat thread on muse-wonder-1.0.
    const chatCreated = await send(base, "/api/sessions", { cwd: workspace, modelId: "muse-wonder-1.0" });
    assert.equal(chatCreated.status, 200);
    assert.equal(chatCreated.json.session.modelId, "muse-wonder-1.0");

    // Pin voice initially to muse-spark-1.3 to simulate a stale prior voice setting.
    const voicePatch = await send(
      base,
      "/api/voice/settings",
      { brain: { kind: "muse", model: "muse-spark-1.3" } },
      "PATCH",
    );
    assert.equal(voicePatch.status, 200);

    const beforeStatus = await get(base, "/api/voice");
    assert.equal(beforeStatus.brain.label, "Muse Code (muse-spark-1.3)");

    // Now select muse-wonder-full-1.0 on the Assistant profile.
    const profileBefore = await get(base, "/api/assistant");
    const updated = await send(
      base,
      "/api/assistant/profile",
      {
        model: { providerId: "muse", accountId: null, modelId: "muse-wonder-full-1.0" },
        expectedUpdatedAt: profileBefore.profile.updatedAt,
      },
      "PATCH",
    );
    assert.equal(updated.status, 200);

    const afterStatus = await get(base, "/api/voice");
    assert.equal(afterStatus.settings.brain.kind, "assistant");
    assert.equal(afterStatus.brain.label, "Muse Code (muse-wonder-full-1.0)");

    // Verify the Chat thread's model stayed untouched on muse-wonder-1.0.
    const sessions = await get(base, "/api/sessions");
    const chatRow = sessions.sessions.find((s: { sessionId: string }) => s.sessionId === "chat-sess-1");
    assert.equal(chatRow?.modelId, "muse-wonder-1.0");
  });

  it("switches models live mid-call on the very next turn without hanging up (same-provider and cross-provider)", async () => {
    const clock = { t: Date.UTC(2026, 10, 12, 12, 0, 0) };
    const memStore = MemoryStore.open(":memory:", { now: () => clock.t });
    memStore.saveProfile({
      enabled: true,
      name: "GLaDOS",
      model: { providerId: "muse", accountId: null, modelId: "muse-spark-1.3" },
    });
    const execHost = new ExecutiveFakeHost(clock);
    const assistant = new AssistantService(memStore, {
      log: () => undefined,
      emit: () => undefined,
      now: () => clock.t,
      host: execHost,
    });

    const startedSessions: Array<{ sessionId: string; providerId: string; modelId: string | null }> = [];
    const setModelCalls: Array<{ sessionId: string; modelId: string }> = [];
    const startedTurns: Array<{ sessionId: string; text: string }> = [];
    const watchers = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
    let sessionSeq = 0;
    let turnSeq = 0;

    const museHost: MuseBrainHost = {
      startSession: async ({ providerId, modelId }) => {
        const sessionId = `voice-sess-${++sessionSeq}`;
        startedSessions.push({
          sessionId,
          providerId: providerId ?? "muse",
          modelId: modelId ?? null,
        });
        return { sessionId };
      },
      openSession: async () => true,
      setModel: async (sessionId, modelId) => {
        setModelCalls.push({ sessionId, modelId });
      },
      startTurn: async ({ sessionId, text }) => {
        const turnId = `turn-${++turnSeq}`;
        startedTurns.push({ sessionId, text });
        const replyText =
          turnSeq === 1
            ? "I am currently running on Muse Spark."
            : turnSeq === 2
              ? "Confirmed, I am now running on Muse Wonder Full."
              : "Confirmed, I switched providers live.";
        queueMicrotask(() => {
          const listeners = watchers.get(sessionId);
          if (!listeners) return;
          for (const fn of listeners) {
            fn("item/completed", {
              turnId,
              item: { id: `msg-${turnId}`, kind: "agentMessage", text: replyText },
            });
            fn("turn/completed", { turnId, terminal: "completed" });
          }
        });
        return { turnId };
      },
      interruptTurn: async () => undefined,
      needsUser: () => false,
      watch: (sessionId, handler) => {
        let set = watchers.get(sessionId);
        if (!set) {
          set = new Set();
          watchers.set(sessionId, set);
        }
        set.add(handler);
        return () => {
          set?.delete(handler);
        };
      },
      log: () => undefined,
    };

    const voice = new VoiceService({
      dataDir: ":memory:",
      assistant: () => assistant,
      log: () => undefined,
      museHost,
      providerName: (pid) => (pid === "muse" ? "Meta Muse" : pid === "codex" ? "Codex CLI" : pid),
      engineFactory: () => fakeEngineSet(),
      lastProject: () => "/work/ancilla",
      scheduler: systemScheduler,
      idleUnloadMs: 50,
    });
    voice.updateSettings({ brain: { kind: "assistant" } });

    const sockets = new VoiceSocketServer(() => voice, () => undefined);
    const http: Server = createServer();
    http.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    after(async () => {
      sockets.close();
      await voice.close();
      http.closeAllConnections?.();
      http.close();
    });

    const port = (http.address() as AddressInfo).port;
    const client = await connect(`ws://127.0.0.1:${port}${VOICE_SOCKET_PATH}`);
    client.ws.send(
      JSON.stringify({
        type: "hello",
        v: PROTOCOL_VERSION,
        mode: "hands-free",
        lang: null,
        echoCancelled: true,
        resume: null,
        thread: null,
      }),
    );
    await client.waitFor((m) => m.type === "ready");

    // Turn 1: starts on muse-spark-1.3
    client.ws.send(JSON.stringify({ type: "text", text: "Which model are you using?" }));
    const a1 = await client.waitFor((m) => m.type === "assistant" && m.done === true && /Muse Spark/.test(m.text));
    assert.ok(a1);
    await client.waitFor((m) => m.type === "speak_end");
    client.texts.length = 0;
    assert.equal(startedSessions.length, 1);
    assert.deepEqual(startedSessions[0], {
      sessionId: "voice-sess-1",
      providerId: "muse",
      modelId: "muse-spark-1.3",
    });
    assert.match(startedTurns[0]?.text ?? "", /Active model: Meta Muse \(muse-spark-1\.3\)/);

    // Mid-call switch #1 (same CLI provider: muse-spark-1.3 -> muse-wonder-full-1.0)
    memStore.saveProfile({
      model: { providerId: "muse", accountId: null, modelId: "muse-wonder-full-1.0" },
    });

    client.ws.send(JSON.stringify({ type: "text", text: "Are you sure? I just set you to muse-wonder-full-1.0." }));
    const a2 = await client.waitFor(
      (m) => m.type === "assistant" && m.done === true && /Muse Wonder Full/.test(m.text),
    );
    assert.ok(a2);
    await client.waitFor((m) => m.type === "speak_end");
    client.texts.length = 0;
    assert.equal(startedSessions.length, 1, "reuses the open Muse session when switching Muse models mid-call");
    assert.deepEqual(setModelCalls, [{ sessionId: "voice-sess-1", modelId: "muse-wonder-full-1.0" }]);
    assert.match(
      startedTurns[1]?.text ?? "",
      /System note: The user just switched your active model for this conversation to Meta Muse \(muse-wonder-full-1\.0\)/,
    );
    assert.match(startedTurns[1]?.text ?? "", /Active model: Meta Muse \(muse-wonder-full-1\.0\)/);

    // Mid-call switch #2 (cross-provider: Meta Muse -> Codex CLI)
    memStore.saveProfile({
      model: { providerId: "codex", accountId: null, modelId: "o3-mini" },
    });

    client.ws.send(JSON.stringify({ type: "text", text: "And what about now?" }));
    const a3 = await client.waitFor(
      (m) => m.type === "assistant" && m.done === true && /switched providers live/.test(m.text),
    );
    assert.ok(a3);
    assert.equal(startedSessions.length, 2, "opens a new provider session when switching CLI providers mid-call");
    assert.deepEqual(startedSessions[1], {
      sessionId: "voice-sess-2",
      providerId: "codex",
      modelId: "o3-mini",
    });
    assert.match(startedTurns[2]?.text ?? "", /Earlier in this conversation:/);
    assert.match(
      startedTurns[2]?.text ?? "",
      /System note: The user just switched your active model for this conversation to Codex CLI \(o3-mini\)/,
    );

    client.ws.send(JSON.stringify({ type: "end" }));
  });
});
