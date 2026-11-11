import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { FakeHost as ExecutiveFakeHost, flush } from "../src/assistant/eval/fakeHost.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { awaitsApproval } from "../src/assistant/tasks.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import type { BrainProvider, ChatMessage } from "../src/voice/brain.js";
import { ConversationStore } from "../src/voice/conversations.js";
import {
  AdaptiveEnergyVad,
  cleanWhisperTranscript,
  encodeWavPcm16,
  findWavDataOffset,
  HttpSpeechTts,
  HttpWhisperAsr,
} from "../src/voice/engines/index.js";
import { evaluateConversationChecks, type ScenarioCheck } from "../src/voice/eval.js";
import { AUDIO_IN, decodeAudioOut, PROTOCOL_VERSION, type TurnMetrics } from "../src/voice/protocol.js";
import { ManualScheduler, systemScheduler } from "../src/voice/scheduler.js";
import { VoiceService } from "../src/voice/service.js";
import { VoiceSession } from "../src/voice/session.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";
import { VoiceTools } from "../src/voice/tools.js";
import { FakeAsr, FakeTts, FakeVad, makeRig, ScriptedBrain, SimClient, tone, type Reply } from "../src/voice/testing.js";
import { VOICE_SOCKET_PATH, VoiceSocketServer } from "../src/voice/ws.js";

const T0 = Date.UTC(2026, 10, 11, 14, 0, 0);

function lastUserMessage(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

describe("portable zero-download speech engines", () => {
  it("detects speech vs. ambient noise cleanly in pure JavaScript with AdaptiveEnergyVad", () => {
    const vad = new AdaptiveEnergyVad();
    const silence = new Float32Array(512);
    for (let i = 0; i < 10; i++) {
      assert.equal(vad.process(silence), 0);
    }
    // Simulated low-level background hum settles into the noise floor without triggering speech.
    const hum = new Float32Array(512);
    for (let i = 0; i < hum.length; i++) hum[i] = 0.002 * Math.sin((2 * Math.PI * 60 * i) / 16_000);
    for (let i = 0; i < 8; i++) assert.ok(vad.process(hum) < 0.25);

    // Voiced speech signal rises swiftly above TurnTaker's 0.5 start threshold.
    const voiced = new Float32Array(512);
    for (let i = 0; i < voiced.length; i++) {
      voiced[i] = 0.22 * Math.sin((2 * Math.PI * 420 * i) / 16_000) + 0.08 * Math.sin((2 * Math.PI * 1260 * i) / 16_000);
    }
    let peak = 0;
    for (let i = 0; i < 5; i++) peak = Math.max(peak, vad.process(voiced));
    assert.ok(peak >= 0.7, `expected speech probability >= 0.7, got ${peak}`);
    vad.reset();
    assert.equal(vad.process(silence), 0);
  });

  it("encodes 16 kHz WAV for HttpWhisperAsr, reuses flushed transcripts without duplicate HTTP calls, and strips WAV headers in HttpSpeechTts", async () => {
    let sttCalls = 0;
    let receivedAuth = "";
    let ttsVoice = "";

    const pcmSamples = tone(440, 120, 0.25, 24_000);
    const wavReply = encodeWavPcm16(
      [Float32Array.from(pcmSamples, (v) => v / 32768)],
      24_000,
    );
    assert.equal(findWavDataOffset(wavReply), 44);
    assert.equal(cleanWhisperTranscript("[BLANK_AUDIO]  Hello from local whisper! (music)"), "Hello from local whisper!");

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      receivedAuth = headers.get("authorization") ?? "";
      if (url.endsWith("/audio/transcriptions")) {
        sttCalls++;
        return new Response(JSON.stringify({ text: "[BLANK_AUDIO] Check staging logs." }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/audio/speech")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { voice?: string };
        ttsVoice = body.voice ?? "";
        // Stream the WAV response in odd-sized chunks to verify header stripping + 2-byte PCM alignment.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(wavReply.subarray(0, 19));
            controller.enqueue(wavReply.subarray(19, 77));
            controller.enqueue(wavReply.subarray(77));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "audio/wav" } });
      }
      return new Response("not found", { status: 404 });
    };

    const asr = new HttpWhisperAsr({
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "faster-whisper-small",
      apiKey: () => "sk-speech-test",
      fetchImpl: mockFetch,
    });
    const stream = asr.open("en-US");
    stream.accept(Float32Array.from(tone(650, 400, 0.3), (v) => v / 32768));
    await stream.flush?.();
    const final = await stream.finish();
    stream.dispose();

    assert.equal(final.text, "Check staging logs.");
    assert.equal(sttCalls, 1, "flush() pre-transcribed the audio so finish() made zero extra HTTP requests");
    assert.equal(receivedAuth, "Bearer sk-speech-test");

    const tts = new HttpSpeechTts({
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "kokoro-v1",
      apiKey: () => "sk-speech-test",
      fetchImpl: mockFetch,
    });
    const abort = new AbortController();
    let outSamples = 0;
    for await (const chunk of tts.synthesize("Checking staging now.", { voice: "en:nova", speed: 1, signal: abort.signal })) {
      outSamples += chunk.length;
    }
    assert.equal(ttsVoice, "nova", "language prefix stripped for HTTP TTS provider compatibility");
    assert.equal(outSamples, pcmSamples.length, "44-byte RIFF WAV header was stripped cleanly and odd chunk boundaries aligned");
  });

  it("runs a live WebSocket voice call with zero local pack installed when speech.kind is http", async () => {
    const clock = { t: T0 };
    const store = MemoryStore.open(":memory:", { now: () => clock.t });
    store.saveProfile({ enabled: true });
    const execHost = new ExecutiveFakeHost(clock);
    const assistant = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, host: execHost });

    const speechReplyPcm = tone(320, 200, 0.25, 24_000);
    const speechReplyBytes = Buffer.alloc(speechReplyPcm.length * 2);
    for (let i = 0; i < speechReplyPcm.length; i++) speechReplyBytes.writeInt16LE(speechReplyPcm[i] as number, i * 2);

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "What branch do we deploy from?" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/audio/speech")) {
        return new Response(speechReplyBytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return new Response("not found", { status: 404 });
    };

    const service = new VoiceService({
      dataDir: ":memory:",
      assistant: () => assistant,
      log: () => undefined,
      museBrain: () => new ScriptedBrain(systemScheduler, () => ({ text: "You deploy from main.", ttftMs: 15 })),
      fetchImpl: mockFetch,
      scheduler: systemScheduler,
    });

    assert.equal(service.status().available, false, "local pack is not installed in :memory:");
    service.updateSettings({
      speech: { kind: "http", baseUrl: "http://127.0.0.1:8000/v1", sttModel: "whisper-1", ttsModel: "kokoro", local: true, apiKeyEnv: null },
    });
    assert.equal(service.status().available, true, "HTTP speech server makes voice available with zero pack download");
    assert.ok(service.status().voices.some((v) => v.id === "en:nova" && v.lang === "en"));
    assert.ok(service.status().voices.some((v) => v.id === "pt:nova" && v.lang === "pt"));

    const sockets = new VoiceSocketServer(() => service, () => undefined);
    const http: Server = createServer();
    http.on("upgrade", (req, sock, head) => sockets.handleUpgrade(req, sock, head));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    after(async () => {
      sockets.close();
      await service.close();
      http.closeAllConnections?.();
      http.close();
    });

    const port = (http.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${VOICE_SOCKET_PATH}`);
    const messages: Array<Record<string, unknown>> = [];
    let audioFrames = 0;
    let playedSamples = 0;

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const decoded = decodeAudioOut(data as Buffer);
        if (decoded) {
          audioFrames++;
          playedSamples += decoded.pcm.length;
          ws.send(JSON.stringify({ type: "playback", utterance: decoded.utterance, samples: playedSamples }));
        }
        return;
      }
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, mode: "hands-free", lang: "en-US", echoCancelled: true, resume: null, thread: null }));

    const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const hit = messages.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting; saw ${JSON.stringify(messages.map((m) => m["type"]))}`);
    };

    const ready = await waitFor((m) => m["type"] === "ready");
    assert.equal(ready["sampleRate"], 24_000);

    // Send 960 ms of voiced audio followed by 1100 ms of silence.
    const voiced = tone(520, 960, 0.3);
    for (let i = 0; i + 512 <= voiced.length; i += 512) {
      const slice = voiced.subarray(i, i + 512);
      const pkt = Buffer.alloc(1 + slice.length * 2);
      pkt[0] = AUDIO_IN;
      for (let k = 0; k < slice.length; k++) pkt.writeInt16LE(slice[k] as number, 1 + k * 2);
      ws.send(pkt, { binary: true });
      await new Promise((r) => setTimeout(r, 15));
    }
    const quietPkt = Buffer.alloc(1 + 512 * 2);
    quietPkt[0] = AUDIO_IN;
    for (let i = 0; i < 36; i++) {
      ws.send(quietPkt, { binary: true });
      await new Promise((r) => setTimeout(r, 15));
    }

    const userMsg = await waitFor((m) => m["type"] === "user");
    assert.equal(userMsg["text"], "What branch do we deploy from?");
    const assistantMsg = await waitFor((m) => m["type"] === "assistant" && m["done"] === true);
    assert.equal(assistantMsg["text"], "You deploy from main.");
    await waitFor((m) => m["type"] === "speak_end");
    assert.ok(audioFrames > 0);
    ws.send(JSON.stringify({ type: "end" }));
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });
});

describe("realistic multi-turn conversational evaluation", () => {
  it("meets comprehension, intent preservation, speculative latency, barge-in recovery, ambiguity discipline, and task reliability targets", async () => {
    const sched = new ManualScheduler(T0);
    const store = MemoryStore.open(":memory:", { now: () => sched.now() });
    store.saveProfile({ name: "Ancilla", enabled: true, policy: { allowProjectWrites: true } });
    // Persistent facts stored in memory so pronoun/shorthand references can be resolved without unnecessary clarification.
    store.remember({
      kind: "fact",
      text: "The staging cluster for the Atlas project is atlas-eu-staging and deploys from the release-candidate branch.",
    });

    const execHost = new ExecutiveFakeHost({ t: T0 });
    execHost.duringStart = (turnId) => {
      queueMicrotask(() => {
        execHost.finish(turnId, "completed");
      });
    };
    const assistant = new AssistantService(store, {
      log: () => undefined,
      emit: () => undefined,
      now: () => sched.now(),
      host: execHost,
    });

    const conversations = new ConversationStore(store, () => sched.now());
    const conversationId = conversations.create("/work/atlas");
    const hub = new TaskHub();
    const baseHost = new AssistantVoiceHost({
      assistant,
      conversations,
      conversationId,
      settings: () => DEFAULT_VOICE_SETTINGS,
      hub,
      project: () => "/work/atlas",
      log: () => undefined,
    });

    // Simulate realistic 180ms async memory/embedding retrieval latency to verify speculative `end_candidate` pre-warming.
    let contextCalls = 0;
    const timedHost: typeof baseHost = Object.create(baseHost);
    timedHost.context = async (text: string, source: "voice" | "text") => {
      contextCalls++;
      if (source === "voice") {
        await new Promise<void>((resolve) => sched.after(180, resolve));
      }
      return baseHost.context(text, source);
    };

    const SENTENCES: Record<number, string> = {
      // 1a + 1b: Mid-utterance self-correction across a natural pause ("deploy to prod wait no" -> incomplete -> "to staging instead.")
      1: "Check which branch we deploy to prod wait no",
      2: "to our staging cluster instead.",
      // 3: Casual thinking aloud (must NOT trigger a tool call!)
      3: "Hmm, I was just wondering why Mondays always feel so busy.",
      // 4: Bilingual EN <-> PT-BR code-switched actionable read task
      4: "Pode checar how token expiry works no módulo de autenticação?",
      // 5: Consequential write request (must create screen-gated proposal, NEVER execute directly)
      5: "Change the token expiry in session.ts to thirty minutes.",
      // 6: Barge-in mid-explanation with stop + correction
      6: "Wait, actually make that forty-five minutes instead.",
      // 7: Genuine ambiguity when two proposals/tasks exist ("cancel that proposal" without naming which)
      7: "Cancel the proposal please.",
    };

    const asr = new FakeAsr(SENTENCES, sched, 20);
    const tts = new FakeTts(sched, { msPerChar: 38, latencyMs: 35 });
    const vad = new FakeVad();

    let toolCallsExecuted: string[] = [];
    const brain: BrainProvider = new ScriptedBrain(sched, (messages): Reply => {
      const last = messages[messages.length - 1];
      if (last?.role === "tool") {
        if (last.name === "delegate_task") {
          return { ttftMs: 90, text: "Vou verificar isso em segundo plano e te aviso." };
        }
        if (last.name === "propose_change") {
          return { ttftMs: 90, text: "I placed that change on your screen for your approval." };
        }
        if (last.name === "list_tasks") {
          return { ttftMs: 90, text: "There are two open proposals: thirty minutes and forty-five minutes. Which one should I cancel?" };
        }
      }

      const userTurn = lastUserMessage(messages);
      const systemPrompt = messages[0]?.content ?? "";
      assert.match(systemPrompt, /corrects themselves mid-sentence/i);

      if (userTurn.includes("staging cluster instead")) {
        // Memory context must have resolved atlas-eu-staging + release-candidate without asking for clarification!
        const hasMemory = userTurn.includes("atlas-eu-staging") && userTurn.includes("release-candidate");
        return {
          ttftMs: 120,
          text: hasMemory
            ? "Your staging cluster is atlas-eu-staging, and it deploys from the release-candidate branch. Let me also explain the rollout steps in detail across several environments so you have the full picture when planning the release window tomorrow afternoon."
            : "Which staging cluster do you mean?",
        };
      }
      if (userTurn.includes("Mondays always feel so busy")) {
        return { ttftMs: 100, text: "Start-of-week context switching always piles up fast." };
      }
      if (userTurn.includes("módulo de autenticação")) {
        assert.match(systemPrompt, /mixed English and Portuguese/i);
        return {
          ttftMs: 110,
          tool: { name: "delegate_task", args: { goal: "Check how token expiry works in auth/session.ts", title: "Auth token expiry" } },
        };
      }
      if (userTurn.includes("thirty minutes")) {
        return {
          ttftMs: 110,
          tool: { name: "propose_change", args: { goal: "Set token expiry in session.ts to 30 minutes", title: "Expiry 30m" } },
        };
      }
      if (userTurn.includes("forty-five minutes")) {
        return {
          ttftMs: 110,
          tool: { name: "propose_change", args: { goal: "Set token expiry in session.ts to 45 minutes", title: "Expiry 45m" } },
        };
      }
      if (userTurn.includes("Yes, approve it right now")) {
        // Voice cannot approve proposals; assistant explains screen approval requirement.
        return {
          ttftMs: 90,
          text: "I cannot approve changes by voice. Please click Approve on the card on your screen.",
        };
      }
      if (userTurn.includes("Cancel the proposal please")) {
        return {
          ttftMs: 90,
          tool: { name: "list_tasks", args: { filter: "active" } },
        };
      }
      return { ttftMs: 100, text: "Understood." };
    });

    const origRunTool = timedHost.runTool.bind(timedHost);
    timedHost.runTool = async (call, ctx) => {
      toolCallsExecuted.push(call.name);
      return origRunTool(call, ctx);
    };

    let session!: VoiceSession;
    const client = new SimClient(sched, () => session);
    const collectedMetrics: TurnMetrics[] = [];
    session = new VoiceSession({
      engines: { vad, asr, tts },
      brain,
      host: timedHost,
      scheduler: sched,
      send: (m) => {
        if (m.type === "metrics") collectedMetrics.push(m.metrics);
        client.receive(m);
      },
      sendAudio: (b) => client.receiveAudio(b),
      log: () => undefined,
    });

    await session.start({ type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: conversationId });

    const doneAssistants = () => client.of("assistant").filter((a) => a.msg.done);

    const waitIdle = async (speakEnds: number) => {
      const ok = await client.until(() => client.of("speak_end").length >= speakEnds && session.snapshot().agent === "idle", 25_000);
      assert.equal(ok, true, `expected idle after ${speakEnds} speak_ends`);
    };

    const checks: ScenarioCheck[] = [];

    // Scenario 1: Spontaneous speech with mid-utterance self-correction ("...to prod wait no" [900ms pause] "to our staging cluster instead.") + memory disambiguation.
    const callsBefore1 = contextCalls;
    await client.speak(1, 1300);
    await client.quiet(900); // Held open because "wait no" is recognized as a self-correction pivot!
    assert.equal(client.of("user").length, 0, "speaker was NOT cut off mid-repair on 'wait no'");
    await client.speak(2, 1200);
    await client.quiet(100);
    await waitIdle(1);
    const turn1User = client.of("user")[0]?.msg.text ?? "";
    const turn1Reply = doneAssistants()[0]?.msg.text ?? "";
    assert.equal(contextCalls - callsBefore1, 1, "speculative end_candidate pre-warm ran context lookup once, never duplicated");
    checks.push({
      id: "self-correction-and-memory-disambiguation",
      comprehended: turn1User.includes("wait no to our staging cluster instead") && turn1Reply.includes("atlas-eu-staging") && !turn1Reply.includes("prod"),
      intentPreserved: toolCallsExecuted.length === 0,
      clarificationExpected: false,
      clarificationAsked: turn1Reply.includes("?"),
    });

    // Scenario 2: Thinking aloud / casual remark — must NOT invoke any tool.
    toolCallsExecuted = [];
    await client.speak(3, 1200);
    await client.quiet(100);
    await waitIdle(2);
    const turn2Reply = doneAssistants()[1]?.msg.text ?? "";
    checks.push({
      id: "casual-remark-vs-instruction",
      comprehended: turn2Reply.includes("Start-of-week"),
      intentPreserved: toolCallsExecuted.length === 0,
      clarificationExpected: false,
      clarificationAsked: turn2Reply.includes("?"),
    });

    // Scenario 3: Bilingual EN/PT-BR code-switching + background read-only task delegation + completion reliability.
    toolCallsExecuted = [];
    await client.speak(4, 1400);
    await client.quiet(100);
    await waitIdle(3);
    await flush();
    const readTasks = assistant.tasks.list("all").filter((t) => t.title === "Auth token expiry");
    const delegatedTask = readTasks[0];
    assert.ok(delegatedTask, "delegated read task created");
    assert.equal(delegatedTask.allowWrites, false, "voice-delegated task is strictly read-only");
    assert.equal(tts.said.at(-1)?.voice, "pt-1", "replied in Portuguese voice matching dominant code-switched language");
    checks.push({
      id: "code-switched-read-task-delegation",
      comprehended: delegatedTask.goal.includes("auth/session.ts"),
      intentPreserved: toolCallsExecuted.includes("delegate_task") && !delegatedTask.allowWrites,
      clarificationExpected: false,
      clarificationAsked: false,
      taskCompleted: delegatedTask.status === "completed" || delegatedTask.status === "unverified",
    });

    // Scenario 4: Consequential write request -> screen-gated proposal, followed by barge-in correction + typed voice-approval refusal!
    toolCallsExecuted = [];
    await client.speak(5, 1300);
    await client.quiet(100);
    // Wait until assistant starts speaking the proposal confirmation, then interrupt mid-speech with a correction!
    assert.ok(await client.until(() => client.playbackActive, 8000));
    await client.quiet(220);
    const bargeStart = sched.now();
    await client.speak(6, 1300); // "Wait, actually make that forty-five minutes instead."
    const interrupted = client.of("interrupted")[0];
    assert.ok(interrupted, "assistant stopped immediately when interrupted");
    const stopLatency = interrupted.at - bargeStart;
    await client.quiet(100);
    await client.until(() => session.snapshot().agent === "idle" && doneAssistants().length >= 5, 25_000);

    const proposals = assistant.tasks.list("all").filter((t) => awaitsApproval(t));
    assert.equal(proposals.length, 2, "both proposals wait paused on screen for explicit user click");

    // Seamless transition to typed input mid-call trying to approve verbally/textually inside call: still cannot bypass screen click!
    client.send({ type: "text", text: "Yes, approve it right now." });
    await client.quiet(200);
    await client.until(() => session.snapshot().agent === "idle" && doneAssistants().length >= 6, 25_000);
    assert.equal(
      assistant.tasks.list("all").filter((t) => awaitsApproval(t)).length,
      2,
      "neither voice nor call text can approve a write proposal without clicking Approve on the screen card",
    );

    checks.push({
      id: "barge-in-correction-and-write-gate",
      comprehended: proposals.some((p) => p.title === "Expiry 45m"),
      intentPreserved: proposals.every((p) => p.status === "paused" && p.allowWrites === true),
      interruptionRecovered: stopLatency <= 450 && session.snapshot().history.some((m) => m.role === "assistant" && m.content.includes("[the user interrupted")),
      clarificationExpected: false,
      clarificationAsked: false,
    });

    // Scenario 5: Genuine ambiguity (two open proposals exist; user says "Cancel the proposal please") -> concise single clarification instead of guessing!
    toolCallsExecuted = [];
    await client.speak(7, 1200);
    await client.quiet(100);
    await client.until(() => session.snapshot().agent === "idle" && doneAssistants().length >= 7, 25_000);
    const finalReply = doneAssistants().at(-1)?.msg.text ?? "";
    const cancelledAny = assistant.tasks.list("all").some((t) => t.status === "cancelled");
    checks.push({
      id: "honest-clarification-when-genuinely-ambiguous",
      comprehended: finalReply.includes("thirty minutes") && finalReply.includes("forty-five minutes"),
      intentPreserved: !cancelledAny && !toolCallsExecuted.includes("cancel_task"),
      clarificationExpected: true,
      clarificationAsked: finalReply.includes("Which one should I cancel?"),
    });

    await session.close("eval complete");

    const report = evaluateConversationChecks(checks, collectedMetrics);
    assert.equal(report.comprehensionAccuracy, 1);
    assert.equal(report.intentPreservationRate, 1);
    assert.equal(report.interruptionRecoveryRate, 1);
    assert.equal(report.unnecessaryClarificationRate, 0);
    assert.equal(report.appropriateClarificationRate, 1);
    assert.equal(report.taskCompletionReliability, 1);
    assert.ok(report.latency.endpointP50Ms !== null && report.latency.endpointP50Ms <= 600, `endpoint p50 ${report.latency.endpointP50Ms}ms`);
    assert.ok(report.latency.firstAudioP50Ms !== null && report.latency.firstAudioP50Ms <= 950, `firstAudio p50 ${report.latency.firstAudioP50Ms}ms (even with 180ms async context lookup!)`);
  });

  it("prevents duplicate tasks or proposals across interruptions/retries, keeps spoken status consistent with execution, and suppresses short 1-2 word speaker echo", async () => {
    const clock = { t: T0 };
    const store = MemoryStore.open(":memory:", { now: () => clock.t });
    store.saveProfile({ name: "Ancilla", enabled: true, policy: { allowProjectWrites: true } });
    const execHost = new ExecutiveFakeHost(clock);
    const assistant = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => clock.t, host: execHost });
    const tools = new VoiceTools({
      assistant,
      project: () => "/work/atlas",
      lang: () => "en",
      conversationId: "cv_dedupe",
      browse: { available: async () => ({ ok: true }) },
    });

    // 1. Duplicate delegate_task calls (even with varied casing and trailing punctuation) reuse the active task instead of spawning duplicates.
    const firstRead = await tools.run({
      id: "t1",
      name: "delegate_task",
      arguments: JSON.stringify({ goal: "Audit dependency licenses across packages", title: "License audit" }),
    });
    assert.equal(firstRead.ok, true);
    assert.ok(firstRead.narration, "initial delegation speaks narration");

    const retryRead = await tools.run({
      id: "t2",
      name: "delegate_task",
      arguments: JSON.stringify({ goal: "  audit dependency licenses across packages!  ", title: "License audit retry" }),
    });
    assert.equal(retryRead.ok, true);
    assert.equal(retryRead.narration, undefined, "idempotent retry does not re-play starting narration");
    assert.match(retryRead.text, /already (queued|running) for that goal/);
    assert.equal(assistant.tasks.list("all").filter((t) => !t.allowWrites).length, 1, "zero duplicate read tasks created");

    // 2. Propose change -> retry while paused -> screen approval -> retry after approval reports actual running status without creating a second proposal.
    const firstProp = await tools.run({
      id: "p1",
      name: "propose_change",
      arguments: JSON.stringify({ goal: "Update retry backoff in client.ts", title: "Retry backoff" }),
    });
    assert.equal(firstProp.ok, true);
    const propTask = assistant.tasks.list("all").find((t) => t.allowWrites);
    assert.ok(propTask);
    assert.equal(awaitsApproval(propTask), true);

    const retryPausedProp = await tools.run({
      id: "p2",
      name: "propose_change",
      arguments: JSON.stringify({ goal: "update retry backoff in client.ts.", title: "Retry backoff" }),
    });
    assert.equal(retryPausedProp.ok, true);
    assert.match(retryPausedProp.text, /already waiting on the user's screen/);
    assert.equal(assistant.tasks.list("all").filter((t) => t.allowWrites).length, 1);

    // Cancel the first task so the approved proposal immediately advances to running.
    const firstTaskId = assistant.tasks.list("all").find((t) => !t.allowWrites)?.id;
    assert.ok(firstTaskId);
    await assistant.executive!.cancel(firstTaskId, "done");
    assistant.executive!.approve(propTask.id);
    await flush();
    assert.equal(assistant.tasks.require(propTask.id).status, "running");

    const retryApprovedProp = await tools.run({
      id: "p3",
      name: "propose_change",
      arguments: JSON.stringify({ goal: "Update retry backoff in client.ts", title: "Retry backoff" }),
    });
    assert.equal(retryApprovedProp.ok, true);
    assert.match(retryApprovedProp.text, /already approved and is currently running/);
    assert.equal(assistant.tasks.list("all").filter((t) => t.allowWrites).length, 1, "zero duplicate proposals after approval");

    // 3. Interrupted tool turn in VoiceSession preserves completed tool ledger in history, and short 2-word speaker echo is suppressed while 1-word 'Espera' interrupts immediately.
    const ECHO_SENTENCES: Record<number, string> = {
      1: "Start checking the build logs.",
      2: "Actually tell me if that check started.",
      3: "Checking your",
      4: "Espera",
    };
    let roundCount = 0;
    const rig = await makeRig({
      sentences: ECHO_SENTENCES,
      script: (messages) => {
        roundCount++;
        const last = messages[messages.length - 1];
        if (last?.role === "tool") {
          return {
            ttftMs: 80,
            text: "Checking your build logs in the background across every workspace package right now so you get the full report.",
          };
        }
        const userText = lastUserMessage(messages);
        if (userText.includes("Start checking")) {
          return { ttftMs: 80, tool: { name: "delegate_task", args: { goal: "check build logs" } } };
        }
        if (userText.includes("if that check started")) {
          const sawCompletedLedger = messages.some(
            (m) => m.role === "assistant" && m.content.includes("[completed before interruption: delegate_task -> done]"),
          );
          return {
            ttftMs: 80,
            text: sawCompletedLedger
              ? "Checking your build logs is already running in the background while we keep talking about the release."
              : "I am not sure whether it started.",
          };
        }
        return { ttftMs: 80, text: "Pronto, parei." };
      },
    });
    rig.host.toolList = [{ name: "delegate_task", description: "Start work in the background.", parameters: { type: "object" } }];

    // Turn 1: runs delegate_task, starts speaking, then user barges in mid-sentence.
    await rig.client.speak(1, 1100);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.client.playbackActive, 6000));
    await rig.client.quiet(350);
    await rig.client.speak(2, 1300); // Barge-in asking if the check already started!
    assert.equal(rig.client.of("interrupted").length, 1, "first turn interrupted cleanly");
    await rig.client.quiet(100);

    // Wait until Turn 2 starts speaking ("Checking your build logs is already running...").
    assert.ok(await rig.client.until(() => rig.client.playbackActive && rig.tts.said.some((s) => s.text.startsWith("Checking your build logs is already")), 8000));
    assert.equal(rig.host.toolCalls.length, 1, "tool was NOT duplicated on the post-interruption turn");
    await rig.client.quiet(150);

    // Simulate 2-word speaker echo ("Checking your") leaking back into the mic while speaking: must be dismissed as echo!
    const interruptsBeforeEcho = rig.client.of("interrupted").length;
    await rig.client.speak(3, 520);
    await rig.client.quiet(320);
    assert.equal(rig.client.of("interrupted").length, interruptsBeforeEcho, "2-word speaker bleed ('Checking your') was suppressed without false interruption");
    assert.equal(rig.client.playbackActive, true, "assistant kept speaking smoothly through short echo");

    // Genuine 1-word Portuguese barge-in ("Espera") interrupts immediately!
    const stopBefore = rig.client.sched.now();
    await rig.client.speak(4, 480);
    assert.equal(rig.client.of("interrupted").length, interruptsBeforeEcho + 1, "1-word 'Espera' interrupted immediately");
    const cutAt = rig.client.of("interrupted").at(-1)!.at;
    assert.ok(cutAt - stopBefore <= 420, `stopped in ${cutAt - stopBefore}ms`);
    await rig.client.quiet(100);
    assert.ok(await rig.client.until(() => rig.session.snapshot().agent === "idle", 15_000));
    assert.ok(roundCount >= 3);
    await rig.session.close("done");
  });
});
