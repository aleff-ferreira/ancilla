import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { extractCandidates, stripSelfRepair } from "../src/assistant/extract.js";
import { LATEST_VERSION, migrate } from "../src/assistant/schema.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { FakeHost as ExecutiveFakeHost } from "../src/assistant/eval/fakeHost.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import { withTextTools, type BrainEvent, type BrainProvider, type BrainRequest } from "../src/voice/brain.js";
import { ConversationStore } from "../src/voice/conversations.js";
import type { AsrEngine, AsrResult, AsrStream } from "../src/voice/engines.js";
import type { SherpaEngineSet } from "../src/voice/engines/index.js";
import { groundUtterance } from "../src/voice/grounding.js";
import { MuseThreadBrain, type MuseBrainHost } from "../src/voice/muse-brain.js";
import { normalizeSpokenTechnical } from "../src/voice/normalize.js";
import { ProsodyTracker } from "../src/voice/prosody.js";
import { ManualScheduler, systemScheduler } from "../src/voice/scheduler.js";
import { VoiceService } from "../src/voice/service.js";
import { VoiceSession } from "../src/voice/session.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";
import { FakeAsr, FakeHost, FakeTts, FakeVad, makeRig, ScriptedBrain, SimClient, tone } from "../src/voice/testing.js";
import { VoiceSocketServer } from "../src/voice/ws.js";

const T0 = Date.UTC(2026, 10, 12, 15, 0, 0);

function humanGlideSpeech(startHz: number, endHz: number, ms: number, startAmp = 0.25, endAmp = 0.08): Float32Array {
  const rate = 16_000;
  const n = Math.round((ms / 1000) * rate);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const progress = i / Math.max(1, n - 1);
    const hz = startHz + (endHz - startHz) * progress;
    const amp = startAmp + (endAmp - startAmp) * progress;
    phase += (2 * Math.PI * hz) / rate;
    out[i] = amp * (0.75 * Math.sin(phase) + 0.25 * Math.sin(2 * phase));
  }
  return out;
}

class ProgrammableAsr implements AsrEngine {
  readonly id = "programmable-asr";
  nextPartial = "";
  nextResult: AsrResult = { text: "" };
  receivedVocab: readonly string[] = [];

  open(_lang: string | null, options?: { vocabulary?: readonly string[] }): AsrStream {
    this.receivedVocab = options?.vocabulary ?? [];
    const owner = this;
    return {
      accept() {},
      partial() {
        return { text: owner.nextPartial };
      },
      finish() {
        return { ...owner.nextResult };
      },
      dispose() {},
    };
  }
}

describe("voice forensic replay regressions", () => {
  it("keeps thinking fillers out of history and SpokenLedger, reverts agent to thinking when the filler drains, and captures 170ms 'Yes' and 'Sim' 100ms after a question", async () => {
    const sentences: Record<number, string> = { 1: "Check the roadmap?", [-6]: "Yes", [-7]: "Sim" };
    let callCount = 0;
    const rig = await makeRig({
      sentences,
      script: () => {
        callCount++;
        if (callCount === 1) {
          return { ttftMs: 3200, text: "Should I open the roadmap?" };
        }
        if (callCount === 2) {
          return { ttftMs: 120, text: "Devo abrir o arquivo agora?" };
        }
        return { ttftMs: 120, text: "Abrindo agora." };
      },
    });

    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    // Advance past fillerAfterMs (1500ms) + filler TTS playback (+80ms drain fallback), well before 3200ms TTFT.
    await rig.client.until(() => rig.tts.said.length >= 1, 4000);
    await rig.client.until(() => !rig.client.playbackActive && rig.session.snapshot().agent === "thinking", 1500);
    // Once the filler finishes playing and LLM tokens still haven't arrived, agent state reverts to thinking.
    assert.equal(rig.session.snapshot().agent, "thinking");

    await rig.client.until(() => rig.client.of("speak_end").length >= 2 && rig.session.snapshot().agent === "idle", 10_000);
    assert.equal(
      rig.session.snapshot().history[1]?.content,
      "Should I open the roadmap?",
      "thinking filler never pollutes conversation history",
    );

    // Wait just 100ms after the assistant finished asking its question (echoCancelled = true -> 80ms grace)
    // and utter a crisp 170ms affirmative "Yes".
    await rig.client.quiet(100);
    await rig.client.speak(-6, 170);
    await rig.client.quiet(500);
    await rig.client.until(() => rig.session.snapshot().turns === 2 && rig.session.snapshot().agent === "idle", 10_000);

    // Wait 100ms after the Portuguese question and utter a crisp 170ms "Sim".
    await rig.client.quiet(100);
    await rig.client.speak(-7, 170);
    await rig.client.quiet(500);
    await rig.client.until(() => rig.session.snapshot().turns === 3 && rig.session.snapshot().agent === "idle", 10_000);

    const users = rig.client.of("user");
    assert.equal(users.length, 3);
    assert.equal(users[1]?.msg.text, "Yes");
    assert.equal(users[2]?.msg.text, "Sim");
    await rig.session.close("done");
  });

  it("detects prosodic turn finality on falling pitch/energy while ignoring constant-pitch synthetic test tones", () => {
    const tracker = new ProsodyTracker();
    const falling = humanGlideSpeech(195, 125, 640, 0.28, 0.07);
    for (let off = 0; off + 512 <= falling.length; off += 512) {
      tracker.observeVoicedFrame(falling.subarray(off, off + 512));
    }
    const prob = tracker.estimateEndProbability();
    assert.ok(prob !== null && prob >= 0.72, `expected high prosodic finality, got ${prob}`);

    tracker.reset();
    const flatTone = Float32Array.from(tone(220, 640, 0.25), (v) => v / 32768);
    for (let off = 0; off + 512 <= flatTone.length; off += 512) {
      tracker.observeVoicedFrame(flatTone.subarray(off, off + 512));
    }
    assert.equal(tracker.estimateEndProbability(), null, "constant-pitch synthetic tone yields null");
  });

  it("never writes SQLite rows or mutates lastQuery on aborted end_candidate, and hits the prewarmed cache on turn_end", async () => {
    const sched = new ManualScheduler(T0);
    const store = MemoryStore.open(":memory:", { now: () => sched.now() });
    store.saveProfile({ enabled: true, name: "GlaDOS" });
    store.remember({ text: "the staging port is 8080" });
    const initialItems = store.list({ status: "all" }).total;

    const clock = { t: T0 };
    const execHost = new ExecutiveFakeHost(clock);
    const assistant = new AssistantService(store, {
      log: () => undefined,
      emit: () => undefined,
      now: () => sched.now(),
      host: execHost,
    });
    const conversations = new ConversationStore(store, () => sched.now());
    const conversationId = conversations.create("/work/ancilla");
    const hub = new TaskHub();
    const host = new AssistantVoiceHost({
      assistant,
      conversations,
      conversationId,
      settings: () => DEFAULT_VOICE_SETTINGS,
      hub,
      project: () => "/work/ancilla",
      log: () => undefined,
    });

    const asr = new ProgrammableAsr();
    const vad = new FakeVad();
    const tts = new FakeTts(sched, { msPerChar: 40, latencyMs: 0 });
    const brain = new ScriptedBrain(sched, () => ({ ttftMs: 80, text: "Got it." }));
    let session!: VoiceSession;
    const client = new SimClient(sched, () => session);
    session = new VoiceSession({
      engines: { vad, asr, tts },
      brain,
      host,
      scheduler: sched,
      send: client.receive,
      sendAudio: client.receiveAudio,
      log: () => undefined,
    });
    await session.start({ type: "hello", v: 1, mode: "hands-free", lang: "en-US", echoCancelled: true, resume: null, thread: null });

    // Speak a memory-triggering sentence, pause 300ms (triggers end_candidate), then resume and abort as empty turn.
    asr.nextPartial = "Remember that my deploy token port is 9090.";
    asr.nextResult = { text: "" };
    await client.speak(1, 420, 0.3);
    await client.quiet(300);
    assert.equal(
      store.list({ status: "all" }).total,
      initialItems,
      "end_candidate speculative preview must write 0 rows to MemoryStore",
    );
    assert.equal(
      (assistant as unknown as { lastQuery: Map<string, string> }).lastQuery.has(conversationId),
      false,
      "end_candidate speculative preview must not mutate lastQuery",
    );

    // Finish empty turn, then run a real confirmed query and verify cache hit on TurnMetrics.
    await client.quiet(400);
    asr.nextPartial = "What is the staging port?";
    asr.nextResult = { text: "What is the staging port?" };
    await client.speak(1, 450, 0.3);
    await client.quiet(600);
    await client.until(() => session.snapshot().turns === 1 && session.snapshot().agent === "idle", 5000);

    const metrics = client.of("metrics").at(-1)?.msg.metrics;
    assert.equal(metrics?.contextCacheHit, true, "confirmed turn_end reused the speculative preview cache");
    await session.close("done");
    assistant.close();
  });

  it("caps pendingMerge at 2 merges and never glues a standalone 'Stop.' onto the previous pending turn", async () => {
    const sentences = {
      1: "First part.",
      2: "Second part.",
      3: "Third part.",
      4: "Fourth part.",
      5: "Stop.",
    };
    const rig = await makeRig({
      sentences,
      script: () => ({ ttftMs: 1400, text: "Understood." }),
    });

    // Speak 4 rapid fragments inside mergeWindowMs before the 1400ms TTFT reply speaks.
    await rig.client.speak(1, 500);
    await rig.client.quiet(600);
    await rig.client.speak(2, 500);
    await rig.client.quiet(600);
    await rig.client.speak(3, 500);
    await rig.client.quiet(600);
    await rig.client.speak(4, 500);
    await rig.client.quiet(200);
    await rig.client.until(() => rig.client.of("user").length >= 4 && rig.session.snapshot().agent === "idle", 10_000);

    const userMsgs = rig.client.of("user");
    assert.equal(userMsgs[2]?.msg.text, "First part. Second part. Third part.");
    assert.equal(userMsgs[2]?.msg.turn, 1);
    assert.equal(userMsgs[3]?.msg.text, "Fourth part.", "4th fragment started a fresh turn instead of unbounded merge");
    assert.equal(userMsgs[3]?.msg.turn, 2);

    // Now start another slow turn and say "Stop." inside mergeWindowMs: "Stop." must not merge into "First part. Stop."
    await rig.client.speak(1, 500);
    await rig.client.quiet(600);
    await rig.client.speak(5, 350);
    await rig.client.quiet(200);
    await rig.client.until(() => rig.client.of("user").length >= 6 && rig.session.snapshot().agent === "idle", 10_000);
    assert.equal(rig.client.of("user").at(-1)?.msg.text, "Stop.");
  });

  it("suppresses idle ambient backchannels, shields low-SNR bystander speech unless addressed by persona name, and auto-pauses >40s broadcast audio", async () => {
    const sched = new ManualScheduler(T0);
    const asr = new ProgrammableAsr();
    const vad = new FakeVad();
    const tts = new FakeTts(sched, { msPerChar: 40, latencyMs: 0 });
    const host = new FakeHost();
    host.persona$.name = "Ancilla";
    const brain = new ScriptedBrain(sched, () => ({ ttftMs: 80, text: "Here I am." }));
    let session!: VoiceSession;
    const client = new SimClient(sched, () => session);
    session = new VoiceSession({
      engines: { vad, asr, tts },
      brain,
      host,
      scheduler: sched,
      send: client.receive,
      sendAudio: client.receiveAudio,
      log: () => undefined,
    });
    await session.start({ type: "hello", v: 1, mode: "hands-free", lang: "en-US", echoCancelled: true, resume: null, thread: null });

    // 1. Standalone idle "Yeah." (< 750ms, no question asked) is ignored.
    asr.nextPartial = "Yeah.";
    asr.nextResult = { text: "Yeah." };
    await client.speak(1, 320, 0.25);
    await client.quiet(600);
    assert.equal(session.snapshot().turns, 0, "idle ambient backchannel did not trigger a turn");

    // 2. Establish foreground speaker RMS (~0.21) on a real turn.
    asr.nextPartial = "Hello Ancilla.";
    asr.nextResult = { text: "Hello Ancilla.", tokenLogProbs: [-0.1, -0.1] };
    await client.speak(1, 500, 0.3);
    await client.quiet(600);
    await client.until(() => session.snapshot().turns === 1 && session.snapshot().agent === "idle", 5000);

    // 3. Distant low-SNR bystander chatter (amp 0.055 -> RMS ~0.039 < 0.28 * 0.21, low ASR confidence) is rejected.
    asr.nextPartial = "did someone leave coffee in the kitchen";
    asr.nextResult = {
      text: "did someone leave coffee in the kitchen",
      tokenLogProbs: [-1.45, -1.5, -1.35, -1.4],
    };
    await client.speak(1, 500, 0.055);
    await client.quiet(900);
    assert.equal(session.snapshot().turns, 1, "low-SNR bystander speech was shielded");

    // 4. Same quiet speaker addressing "Ancilla" directly IS accepted.
    asr.nextPartial = "Ancilla check the time.";
    asr.nextResult = {
      text: "Ancilla check the time.",
      tokenLogProbs: [-1.45, -1.5, -1.35, -1.4],
    };
    await client.speak(1, 500, 0.055);
    await client.quiet(600);
    await client.until(() => session.snapshot().turns === 2 && session.snapshot().agent === "idle", 5000);

    // 5. Continuous >40s background TV/podcast stream (>= 35 words) auto-pauses mic; resume_mic restores it.
    asr.nextPartial = new Array(40).fill("broadcast").join(" ");
    await client.speak(1, 40_500, 0.2);
    await client.quiet(50);
    const pausedMsg = client.of("mic_paused").at(-1)?.msg;
    assert.equal(pausedMsg?.paused, true);

    client.send({ type: "resume_mic" });
    await client.quiet(50);
    assert.equal(client.of("mic_paused").at(-1)?.msg.paused, false);
    await session.close("done");
  });

  it("dispatches [[tool_name {...}]] immediately before stream end, preserves non-tool brackets, and settles Muse turns 100ms after agentMessage", async () => {
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((r) => {
      releaseTail = r;
    });
    const slowStreamBrain: BrainProvider = {
      id: "slow-tail",
      label: "Slow Tail",
      capabilities: { tools: false, speculative: false, local: true },
      async *stream(_req: BrainRequest): AsyncGenerator<BrainEvent> {
        yield { type: "text", delta: 'Checking [[note]] now. [[inspect_project {"action":"summary"}]]' };
        await tailGate;
        yield { type: "done", reason: "stop" };
      },
    };
    const wrapped = withTextTools(slowStreamBrain);
    const iter = wrapped.stream({
      messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "Check it." }],
      tools: [{ name: "inspect_project", description: "Inspect", parameters: { type: "object" } }],
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();

    const first = await iter.next();
    assert.deepEqual(first.value, { type: "text", delta: "Checking [[note]] now. " });
    const second = await iter.next();
    assert.equal(second.value?.type, "tool", "tool emitted immediately at 0ms without waiting for tailGate");
    if (second.value?.type === "tool") {
      assert.equal(second.value.call.name, "inspect_project");
    }
    releaseTail();
    await iter.next();

    // Verify MuseThreadBrain early settlement when turn/completed stalls on eot_gate.
    const watchers = new Set<(method: string, params: Record<string, unknown>) => void>();
    const emitMuse = (method: string, params: Record<string, unknown>): void => {
      for (const fn of [...watchers]) fn(method, params);
    };
    let savedReported = -1;
    const museHost: MuseBrainHost = {
      async startSession() {
        return { sessionId: "s_voice_1", modelId: "muse-spark" };
      },
      async startTurn() {
        setTimeout(() => {
          emitMuse("item/started", { item: { id: "msg_1", kind: "agentMessage" } });
          emitMuse("item/delta", { itemId: "msg_1", delta: "All green." });
          emitMuse("item/completed", { item: { id: "msg_1", kind: "agentMessage", text: "All green." } });
        }, 10);
        return { turnId: "turn_1" };
      },
      async interruptTurn() {},
      needsUser: () => false,
      watch(_sid, fn) {
        watchers.add(fn);
        return () => {
          watchers.delete(fn);
        };
      },
      log: () => undefined,
    };
    const museBrain = new MuseThreadBrain({
      host: museHost,
      cwd: "/work/ancilla",
      title: "Voice",
      earlySettleGraceMs: 40,
      onEarlySettle: (ms) => {
        savedReported = ms;
      },
    });
    const startedAt = Date.now();
    const events: BrainEvent[] = [];
    for await (const ev of museBrain.stream({
      messages: [{ role: "user", content: "Status?" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 500, `settled in ${elapsed}ms without waiting 90s for turn/completed`);
    assert.ok(events.some((e) => e.type === "text" && e.delta === "All green."));
    await new Promise((r) => setTimeout(r, 65));
    emitMuse("turn/completed", { turnId: "turn_1", terminal: "completed" });
    assert.ok(savedReported >= 45, `recorded early-settle eot_gate savings (${savedReported}ms)`);
  });

  it("grounds active vocabulary across Tiers A/B/C, normalizes spoken technical identifiers, and fast-repeats garbled short ASR", async () => {
    const vocab = ["GlaDOS", "Ancilla", "muse-wonder-full", "muse-wonder-full-1.0", "voice-session.test.ts"];

    // Spoken ITN
    assert.equal(
      normalizeSpokenTechnical("open packages slash server slash session dot ts on localhost fifty one seventy three"),
      "open packages/server/session.ts on localhost:5173",
    );
    assert.equal(
      normalizeSpokenTechnical("pass dash dash disable shell to camel case user profile id version one point zero"),
      "pass --disable-shell to userProfileId version 1.0",
    );

    // Tier A: streaming saw exact "GlaDOS", offline refine turned it into "Gladys"
    const tierA = groundUtterance({
      text: "Hey Gladys what is running?",
      streamingText: "Hey GlaDOS what is running?",
      vocabulary: vocab,
    });
    assert.equal(tierA.text, "Hey GlaDOS what is running?");

    // Tier B: phonetic multi-word / proper-noun grounding
    assert.equal(groundUtterance({ text: "Hey Glad us switch to News Wonderful", vocabulary: vocab }).text, "Hey GlaDOS switch to muse-wonder-full");
    assert.equal(groundUtterance({ text: "check ancila status", vocabulary: vocab }).text, "check Ancilla status");

    // Ordinary prose safety: "Glad we had wonderful news" must NOT be rewritten
    assert.equal(
      groundUtterance({ text: "Glad we had wonderful news today.", vocabulary: vocab }).text,
      "Glad we had wonderful news today.",
    );

    // Tier C: severe distortion ("movie on the food") surfaces candidateNote without destructive rewrite
    const tierC = groundUtterance({
      text: "switch to movie on the food",
      vocabulary: vocab,
    });
    assert.equal(tierC.text, "switch to movie on the food");
    assert.match(tierC.candidateNote ?? "", /muse-wonder-full/);

    // Garbled < 3-word utterance triggers fast repeat without calling BrainProvider
    const garbled = groundUtterance({
      text: "blarg snorf",
      tokens: ["blarg", "snorf"],
      tokenLogProbs: [-2.4, -2.6],
      vocabulary: vocab,
    });
    assert.equal(garbled.garbled, true);
  });

  it("extracts lowercase EN/PT-BR/ES voice memories, strips spoken self-repairs, migrates porter FTS5 indexes, and blocks un-echo-cancelled spoken approvals", async () => {
    const ctx = { role: "user" as const, observedAt: T0, now: T0, offsetMinutes: -180, project: "/work/ancilla", thread: "t1" };

    // Spoken self-repair
    assert.equal(stripSelfRepair("use spark, no wait, wonder full"), "use wonder full");
    const repaired = extractCandidates("remember that we use spark, no wait, wonder full", ctx);
    assert.equal(repaired[0]?.text, "we use wonder full");

    // Lowercase ASR in EN, PT-BR, and ES
    assert.equal(extractCandidates("my name is aleff ferreira", ctx)[0]?.slot, "user.name");
    assert.equal(extractCandidates("meu nome é aleff", ctx)[0]?.slot, "user.name");
    assert.equal(extractCandidates("mi nombre es aleff", ctx)[0]?.slot, "user.name");
    assert.equal(extractCandidates("lembra que a porta é 3000, quer dizer, 8080", ctx)[0]?.text, "a porta é 8080");
    assert.equal(extractCandidates("recuerda que mi puerto es 3000, mejor dicho, 8080", ctx)[0]?.text, "mi puerto es 8080");

    // Legacy porter -> unicode61 automatic FTS5 rebuild with LATEST_VERSION === 6 preserved
    assert.equal(LATEST_VERSION, 6);
    const dir = mkdtempSync(join(tmpdir(), "ancilla-fts-mig-"));
    const dbPath = join(dir, "assistant.db");
    try {
      const rawDb = new DatabaseSync(dbPath);
      migrate(rawDb);
      rawDb.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(ref UNINDEXED, text, tokenize = 'porter unicode61 remove_diacritics 2')");
      rawDb.close();

      const store = MemoryStore.open(dbPath, { now: () => T0 });
      store.saveProfile({ enabled: true });
      store.capture({
        message: "lembra que a configuração principal usa porta 8080",
        ctx: { role: "user", observedAt: T0, offsetMinutes: -180 },
      });
      const retrieved = store.retrieve({ text: "quais são as configurações principais?", now: T0 + 1000 });
      assert.ok(
        retrieved.memories.some((m) => m.item.text.includes("8080")),
        "PT-BR plural/accented query recalled singular memory through migrated unicode61 FTS5 index",
      );
      store.close();

      const verifyDb = new DatabaseSync(dbPath);
      const ftsRow = verifyDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'").get() as { sql?: string };
      assert.ok(ftsRow.sql && !/\bporter\b/i.test(ftsRow.sql), `expected porter removed, got ${ftsRow.sql}`);
      verifyDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Consequential safety gate: spoken "allow" with echoCancelled === false is strictly blocked
    const rig = await makeRig({
      sentences: { 1: "yes go ahead" },
      open: false,
      script: () => ({ ttftMs: 80, text: "Please click Launch on your screen." }),
    });
    let decided = false;
    rig.host.pendingApproval = () => ({
      id: "auth_live_1",
      kind: "launch",
      title: "Run deploy script",
      detail: "./deploy.sh",
      allowLabel: "Launch",
      denyLabel: "Cancel",
      createdAt: rig.sched.now(),
      createdTurn: 0,
    });
    rig.host.decideApproval = async () => {
      decided = true;
      return { ok: true, message: "launched" };
    };
    await rig.session.start({ type: "hello", v: 1, mode: "hands-free", lang: "en-US", echoCancelled: false, resume: null, thread: null });
    await rig.client.quiet(300);
    await rig.client.speak(1, 500);
    await rig.client.quiet(500);
    await rig.client.until(() => rig.session.snapshot().turns === 1 && rig.session.snapshot().agent === "idle", 5000);
    assert.equal(decided, false, "spoken approval with echoCancelled=false must never execute");
    assert.ok(rig.client.of("notice").some((n) => /Echo cancellation is off/i.test(n.msg.text)));
    await rig.session.close("done");
  });

  it("ignores post-statement idle continuers ('Okay.', 'Entendi.'), preserves ']]' inside JSON tool args and tool-free greetings, enables TCP_NODELAY, and heals stale voice.json model pins", async () => {
    // 1. Post-statement idle continuers (< 750ms) when no question/approval is open do not trigger empty replies.
    const rig = await makeRig({
      sentences: { 1: "Tell me the status.", 2: "Okay.", 3: "Entendi." },
      script: () => ({ ttftMs: 80, text: "All services are healthy." }),
    });
    await rig.client.speak(1, 900);
    await rig.client.quiet(100);
    await rig.client.until(() => rig.session.snapshot().turns === 1 && rig.session.snapshot().agent === "idle", 8000);
    await rig.client.quiet(200);
    await rig.client.speak(2, 420);
    await rig.client.quiet(800);
    await rig.client.speak(3, 460);
    await rig.client.quiet(800);
    assert.equal(rig.session.snapshot().turns, 1, "post-statement 'Okay.' and 'Entendi.' continuers ignored when no question was asked");
    await rig.session.close("done");

    // 2. withTextTools handles ']]' inside JSON string arguments and preserves '[[' on tool-free greeting turns.
    const inner: BrainProvider = {
      id: "raw-text",
      label: "Raw Text",
      capabilities: { tools: false, speculative: false, local: false },
      async *stream(req: BrainRequest): AsyncGenerator<BrainEvent> {
        if (req.tools.length === 0 && req.messages.at(-1)?.content === "hello") {
          yield { type: "text", delta: "Hi! Check [[wiki]] and array [[0" };
          yield { type: "done", reason: "stop" };
          return;
        }
        yield {
          type: "text",
          delta: 'Sure. [[propose_change {"title":"Fix parser","goal":"Handle matrix[[0]] and \\"quoted ]]\\" indexing"}]]',
        };
        yield { type: "done", reason: "stop" };
      },
    };
    const wrapped = withTextTools(inner);
    const toolEvents: BrainEvent[] = [];
    for await (const ev of wrapped.stream({
      messages: [{ role: "system", content: "Sys" }, { role: "user", content: "fix it" }],
      tools: [{ name: "propose_change", description: "Propose change", parameters: { type: "object" } }],
      signal: new AbortController().signal,
    })) {
      toolEvents.push(ev);
    }
    const spokenWithTool = toolEvents.filter((e) => e.type === "text").map((e) => e.delta).join("");
    assert.equal(spokenWithTool, "Sure. ", "no trailing JSON fragment leaked into spoken text");
    const toolCall = toolEvents.find((e) => e.type === "tool");
    assert.equal(toolCall?.type, "tool");
    assert.deepEqual(JSON.parse(toolCall.call.arguments), {
      title: "Fix parser",
      goal: 'Handle matrix[[0]] and "quoted ]]" indexing',
    });

    const greetingEvents: BrainEvent[] = [];
    for await (const ev of wrapped.stream({
      messages: [{ role: "system", content: "Sys" }, { role: "user", content: "hello" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      greetingEvents.push(ev);
    }
    const greetingSpoken = greetingEvents.filter((e) => e.type === "text").map((e) => e.delta).join("");
    assert.equal(greetingSpoken, "Hi! Check [[wiki]] and array [[0", "tool-free turn never mutes unclosed '[['");

    // 3. VoiceSocketServer enables TCP_NODELAY on upgrade sockets.
    let noDelaySet: boolean | undefined;
    const wss = new VoiceSocketServer(() => null, () => undefined);
    // Verify setNoDelay hook before ws.handleUpgrade touches the mock socket.
    const fakeDuplex = {
      setNoDelay(v = true) {
        noDelaySet = v;
        throw new Error("stop-after-nodelay");
      },
    };
    assert.throws(() => wss.handleUpgrade({} as never, fakeDuplex as never, Buffer.alloc(0)), /stop-after-nodelay/);
    assert.equal(noDelaySet, true);
    wss.close();

    // 4. VoiceService heals a stale Muse model pin in voice.json when setModel rejects on an existing session.
    const dir = mkdtempSync(join(tmpdir(), "ancilla-voice-heal-"));
    try {
      const store = MemoryStore.open(":memory:", { now: () => T0 });
      store.saveProfile({
        enabled: true,
        model: { providerId: "muse", accountId: null, modelId: "muse-wonder-full-1.0" },
      });
      const assistant = new AssistantService(store, { log: () => undefined, emit: () => undefined, now: () => T0 });
      const existingConv = new ConversationStore(store, () => T0).create("/work/ancilla");
      new ConversationStore(store, () => T0).setMuseSession(existingConv, "sess-heal-1");

      const museHost: MuseBrainHost = {
        openSession: async () => ({ ok: true, modelId: "muse-wonder-full-1.0" }),
        startSession: async () => ({ sessionId: "sess-heal-1", modelId: "muse-wonder-full-1.0" }),
        setModel: async () => {
          throw new Error("unsupported_route");
        },
        startTurn: async () => ({ turnId: "t1" }),
        interruptTurn: async () => undefined,
        needsUser: () => false,
        watch: () => () => undefined,
        log: () => undefined,
      };
      const fakeSet = {
        engines: { vad: new FakeVad(), asr: new FakeAsr({}, systemScheduler, 0), tts: new FakeTts(systemScheduler, { msPerChar: 5, latencyMs: 5 }) },
        asr: new FakeAsr({}, systemScheduler, 0),
        tts: new FakeTts(systemScheduler, { msPerChar: 5, latencyMs: 5 }),
        report: { runtime: true, vad: true, streaming: true, refine: false, tts: true, ready: true, missing: [] },
        dispose: async () => undefined,
      } as unknown as SherpaEngineSet;

      const service = new VoiceService({
        dataDir: dir,
        assistant: () => assistant,
        log: () => undefined,
        museHost,
        museCatalogModels: () => ["muse-spark-1.3", "muse-wonder-full-1.0"],
        engineFactory: () => fakeSet,
        lastProject: () => "/work/ancilla",
        scheduler: systemScheduler,
        idleUnloadMs: 50,
      });
      service.updateSettings({ brain: { kind: "muse", model: "muse-spark-1.3" } });
      const b0 = service.settings.get().brain;
      assert.equal(b0.kind === "muse" && b0.model, "muse-spark-1.3");

      const handle = await service.attach(
        { sendText: () => undefined, sendBinary: () => undefined, close: () => undefined },
        { type: "hello", v: 1, mode: "hands-free", lang: "en-US", echoCancelled: true, resume: null, thread: existingConv },
      );
      // Wait briefly for warm() -> MuseThreadBrain.session() -> setModel failure -> onModelResolved heal.
      await new Promise((r) => setTimeout(r, 40));
      const healed = service.settings.get().brain;
      assert.equal(healed.kind, "muse");
      if (healed.kind === "muse") {
        assert.equal(healed.model, "muse-wonder-full-1.0", "voice.json healed to actual thread model");
      }
      await handle.close("done");
      await service.close();
      assistant.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
