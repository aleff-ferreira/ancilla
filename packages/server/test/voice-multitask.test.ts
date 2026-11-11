import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { FakeHost, flush } from "../src/assistant/eval/fakeHost.js";
import { AssistantService } from "../src/assistant/service.js";
import { migrate } from "../src/assistant/schema.js";
import { MemoryStore } from "../src/assistant/store.js";
import { parseTaskSpec } from "../src/assistant/tasks.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import { withTextTools, type ChatMessage } from "../src/voice/brain.js";
import { ConversationStore } from "../src/voice/conversations.js";
import { MuseThreadBrain } from "../src/voice/muse-brain.js";
import { ManualScheduler } from "../src/voice/scheduler.js";
import { VoiceSession } from "../src/voice/session.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";
import { FakeAsr, FakeTts, FakeVad, ScriptedBrain, SimClient, type Reply } from "../src/voice/testing.js";

const T0 = Date.UTC(2026, 10, 11, 20, 0, 0);

function lastUserLine(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      return m.content.split("\n").pop() ?? m.content;
    }
  }
  return "";
}

describe("simultaneous voice conversation and background task management", () => {
  it("runs multiple tasks concurrently, never stops running tasks when the user speaks, and reports milestones and results", async () => {
    const sched = new ManualScheduler(T0);
    const clock = {
      get t(): number {
        return sched.now();
      },
      set t(_v: number) {
        /* driven by ManualScheduler */
      },
    };
    const store = MemoryStore.open(":memory:", { now: () => sched.now() });
    // Keep allowProjectWrites at its default false to verify YOLO pre-authorization permits background write tasks.
    store.saveProfile({ name: "GLaDOS", enabled: true });
    assert.equal(store.getProfile().policy.maxConcurrent, 3);
    assert.equal(store.getProfile().policy.allowProjectWrites, false);

    const execHost = new FakeHost(clock);
    const hub = new TaskHub();
    const assistant = new AssistantService(store, {
      log: () => undefined,
      emit: (ev) => {
        if (ev.reason === "task" && ev.taskId) hub.emit({ taskId: ev.taskId });
      },
      now: () => sched.now(),
      host: execHost,
      isPreAuthorized: () => true,
    });

    const conversations = new ConversationStore(store, () => sched.now());
    const conversationId = conversations.create("/work/river");
    const voiceHost = new AssistantVoiceHost({
      assistant,
      conversations,
      conversationId,
      settings: () => ({ ...DEFAULT_VOICE_SETTINGS, proactive: true }),
      hub,
      project: () => "/work/river",
      isPreAuthorized: () => true,
      log: () => undefined,
    });

    const sentences: Record<number, string> = {
      1: "Upgrade the scene with realistic trees.",
      2: "Meanwhile, why is the managed browser dropping?",
      3: "Also audit the shader memory footprint.",
    };

    const seenContexts: string[] = [];
    const tts = new FakeTts(sched, { msPerChar: 25, latencyMs: 25 });
    const brain = new ScriptedBrain(sched, (messages): Reply => {
      const last = messages[messages.length - 1];
      if (last?.role === "tool") {
        if (last.name === "propose_change") {
          return { ttftMs: 50, text: "Your realistic trees upgrade is underway in the background." };
        }
        if (last.name === "delegate_task") {
          return { ttftMs: 50, text: "Started the shader memory audit alongside it." };
        }
      }
      const fullUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      seenContexts.push(fullUser);
      const utterance = lastUserLine(messages);
      if (utterance.includes("realistic trees")) {
        return {
          ttftMs: 60,
          tool: {
            name: "propose_change",
            args: {
              title: "Realistic trees",
              goal: "Add layered crowns, procedural bark normals, and canopy light scattering.",
            },
          },
        };
      }
      if (utterance.includes("managed browser dropping")) {
        return {
          ttftMs: 60,
          text: "The scene is heavy for software rendering, while Realistic trees keeps running.",
        };
      }
      if (utterance.includes("shader memory footprint")) {
        return {
          ttftMs: 60,
          tool: {
            name: "delegate_task",
            args: {
              title: "Shader memory audit",
              goal: "Measure texture and buffer allocations across river shaders.",
            },
          },
        };
      }
      return { ttftMs: 50, text: "Understood." };
    });

    let session!: VoiceSession;
    const client = new SimClient(sched, () => session);
    session = new VoiceSession({
      engines: { vad: new FakeVad(), asr: new FakeAsr(sentences, sched, 15), tts },
      brain,
      host: voiceHost,
      scheduler: sched,
      send: (m) => client.receive(m),
      sendAudio: (b) => client.receiveAudio(b),
      log: () => undefined,
    });

    await session.start({
      type: "hello",
      v: 1,
      mode: "hands-free",
      lang: null,
      echoCancelled: true,
      resume: null,
      thread: conversationId,
    });

    // 1. User assigns Task 1 ("Realistic trees").
    await client.speak(1, 1000);
    await client.quiet(100);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && client.of("speak_end").length >= 1, 20_000));
    await flush();

    const activeAfterFirst = assistant.tasks.list("active", 10);
    assert.equal(activeAfterFirst.length, 1);
    const treesTask = activeAfterFirst[0]!;
    assert.equal(treesTask.title, "Realistic trees");
    assert.equal(treesTask.status, "running", "YOLO pre-authorized task immediately runs");
    assert.equal(execHost.sessions.length, 1);

    // Call card must have transitioned from paused -> running (not stuck on paused!).
    const treeTaskEvents = client.of("task").filter((e) => e.msg.id === treesTask.id);
    assert.equal(treeTaskEvents.at(-1)?.msg.status, "running");

    // 2. While Task 1 is running, user speaks to ask a question.
    await client.speak(2, 1000);
    await client.quiet(100);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && client.of("speak_end").length >= 2, 20_000));
    await flush();

    assert.equal(assistant.tasks.require(treesTask.id).status, "running", "speaking never stops the running task");
    assert.equal(execHost.interrupts.length, 0, "no background task turn was interrupted");
    assert.match(seenContexts.at(-1) ?? "", /Background tasks:[\s\S]*Realistic trees.*\[running\]/, "live task state injected into turn context");

    // 3. User speaks again to assign Task 2 ("Shader memory audit") while Task 1 is still running.
    await client.speak(3, 1000);
    await client.quiet(100);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && client.of("speak_end").length >= 3, 20_000));
    await flush();

    const runningBoth = assistant.tasks.byStatus(["running"]);
    assert.equal(runningBoth.length, 2, "both tasks run simultaneously in parallel");
    assert.equal(execHost.sessions.length, 2, "each task runs in its own dedicated session");
    assert.equal(execHost.interrupts.length, 0);
    const auditTask = runningBoth.find((t) => t.id !== treesTask.id)!;
    assert.equal(auditTask.title, "Shader memory audit");

    // 4. Task 1 reports a significant intermediate milestone (60% via session/goalChanged).
    const treesTurn = execHost.turns.find((t) => t.sessionId === assistant.tasks.require(treesTask.id).sessionId)!;
    execHost.fire(treesTurn.sessionId, "session/goalChanged", {
      goal: {
        objective: "Upgrade scene trees",
        status: "active",
        percentComplete: 60,
        currentWork: "Adding canopy light scattering",
      },
    });
    const milestoneCard = client.of("task").filter((e) => e.msg.id === treesTask.id).at(-1)?.msg;
    assert.equal(milestoneCard?.status, "running");
    assert.match(milestoneCard?.note ?? "", /60% — Adding canopy light scattering/);

    // Wait for a quiet lull -> assistant proactively speaks the halfway milestone!
    const saidBeforeMilestone = tts.said.length;
    await client.quiet(3000);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && tts.said.length > saidBeforeMilestone, 10_000));
    const milestoneSpoken = tts.said.slice(saidBeforeMilestone).map((s) => s.text).join(" ");
    assert.match(milestoneSpoken, /Update on Realistic trees: about 60 percent done\. Adding canopy light scattering\./);

    // 5. Task 1 streams its final summary message and finishes while Task 2 also finishes.
    execHost.fire(treesTurn.sessionId, "item/started", {
      item: { itemId: "msg-trees", turnId: treesTurn.turnId, kind: "agentMessage", text: "" },
    });
    execHost.fire(treesTurn.sessionId, "item/delta", {
      itemId: "msg-trees",
      delta: "Added layered crowns, procedural bark normals, and canopy light scattering.",
    });
    execHost.finish(treesTurn.turnId, "completed");
    await flush();

    const finishedTrees = assistant.tasks.require(treesTask.id);
    assert.equal(finishedTrees.status, "unverified");
    assert.match(finishedTrees.result, /Added layered crowns, procedural bark normals, and canopy light scattering\./);
    assert.equal(assistant.tasks.require(auditTask.id).status, "running", "second task continues unaffected");

    const saidBeforeDone = tts.said.length;
    await client.quiet(3000);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && tts.said.length > saidBeforeDone, 10_000));
    const doneSpoken = tts.said.slice(saidBeforeDone).map((s) => s.text).join(" ");
    assert.match(doneSpoken, /Realistic trees finished: Added layered crowns, procedural bark normals, and canopy light scattering\./);

    // 6. Task 2 hits a runtime approval request, notifies the call card, resolves, and finishes.
    const auditTurn = execHost.turns.find((t) => t.sessionId === assistant.tasks.require(auditTask.id).sessionId)!;
    execHost.needs.add(auditTurn.sessionId);
    execHost.fire(auditTurn.sessionId, "approval/requested", { approvalId: "ap_1", turnId: auditTurn.turnId });
    assert.equal(client.of("task").filter((e) => e.msg.id === auditTask.id).at(-1)?.msg.status, "paused");

    const saidBeforeApproval = tts.said.length;
    await client.quiet(3000);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && tts.said.length > saidBeforeApproval, 10_000));
    assert.match(tts.said.slice(saidBeforeApproval).map((s) => s.text).join(" "), /Shader memory audit needs your approval/);

    execHost.needs.delete(auditTurn.sessionId);
    execHost.fire(auditTurn.sessionId, "approval/resolved", { approvalId: "ap_1", turnId: auditTurn.turnId });
    assert.equal(client.of("task").filter((e) => e.msg.id === auditTask.id).at(-1)?.msg.status, "running");

    execHost.fire(auditTurn.sessionId, "item/completed", {
      item: {
        itemId: "msg-audit",
        turnId: auditTurn.turnId,
        kind: "agentMessage",
        text: "Peak shader memory is 48 megabytes with no leaked buffers.",
      },
    });
    execHost.finish(auditTurn.turnId, "completed");
    await flush();

    const saidBeforeAuditDone = tts.said.length;
    await client.quiet(3000);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && tts.said.length > saidBeforeAuditDone, 10_000));
    assert.match(
      tts.said.slice(saidBeforeAuditDone).map((s) => s.text).join(" "),
      /Shader memory audit finished: Peak shader memory is 48 megabytes with no leaked buffers\./,
    );

    await session.close("done");
    assistant.close();
  });

  it("deduplicates queued updates for the same task while the user is speaking and seeds active tasks on call start", async () => {
    const sched = new ManualScheduler(T0);
    const clock = {
      get t(): number {
        return sched.now();
      },
      set t(_v: number) {
        /* driven by ManualScheduler */
      },
    };
    const store = MemoryStore.open(":memory:", { now: () => sched.now() });
    store.saveProfile({ enabled: true });
    const execHost = new FakeHost(clock);
    const hub = new TaskHub();
    const assistant = new AssistantService(store, {
      log: () => undefined,
      emit: (ev) => {
        if (ev.reason === "task" && ev.taskId) hub.emit({ taskId: ev.taskId });
      },
      now: () => sched.now(),
      host: execHost,
    });

    // Start a two-step task BEFORE the call opens.
    const multi = assistant.executive!.create(
      parseTaskSpec(
        {
          title: "Release pipeline",
          goal: "Check tests and bundle sizes",
          cwd: "/work/river",
          steps: [{ title: "Check unit tests" }, { title: "Measure bundle sizes" }],
        },
        store.getProfile(),
        (c) => c,
      ),
    );
    await flush();
    assert.equal(assistant.tasks.require(multi.id).status, "running");

    const conversations = new ConversationStore(store, () => sched.now());
    const conversationId = conversations.create("/work/river");
    const voiceHost = new AssistantVoiceHost({
      assistant,
      conversations,
      conversationId,
      settings: () => ({ ...DEFAULT_VOICE_SETTINGS, proactive: true }),
      hub,
      project: () => "/work/river",
      log: () => undefined,
    });

    const tts = new FakeTts(sched, { msPerChar: 25, latencyMs: 25 });
    let session!: VoiceSession;
    const client = new SimClient(sched, () => session);
    session = new VoiceSession({
      engines: { vad: new FakeVad(), asr: new FakeAsr({ 1: "How are things?" }, sched, 15), tts },
      brain: new ScriptedBrain(sched, () => ({ ttftMs: 50, text: "All good." })),
      host: voiceHost,
      scheduler: sched,
      send: (m) => client.receive(m),
      sendAudio: (b) => client.receiveAudio(b),
      log: () => undefined,
    });

    await session.start({
      type: "hello",
      v: 1,
      mode: "hands-free",
      lang: null,
      echoCancelled: true,
      resume: null,
      thread: conversationId,
    });

    // Active task was seeded immediately on call start!
    assert.equal(client.of("task")[0]?.msg.id, multi.id);
    assert.equal(client.of("task")[0]?.msg.status, "running");

    // While the user is speaking, Step 1 finishes (queuing a step milestone) AND Step 2 finishes right after!
    await client.speak(1, 500);
    const step1Turn = execHost.last();
    execHost.finish(step1Turn.turnId, "completed");
    await flush();
    const step2Turn = execHost.last();
    execHost.fire(step2Turn.sessionId, "item/completed", {
      item: { itemId: "m2", turnId: step2Turn.turnId, kind: "agentMessage", text: "Tests passed and bundle is 140 kilobytes." },
    });
    execHost.finish(step2Turn.turnId, "completed");
    await flush();

    // Finish user's turn and wait for the proactive lull.
    await client.speak(1, 600);
    await client.quiet(100);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && client.of("speak_end").length >= 1, 20_000));

    const beforeLull = tts.said.length;
    await client.quiet(3200);
    assert.ok(await client.until(() => session.snapshot().agent === "idle" && tts.said.length > beforeLull, 10_000));
    const lullText = tts.said.slice(beforeLull).map((s) => s.text).join(" ");
    assert.doesNotMatch(lullText, /step 1 of 2 is done/i, "stale step milestone was superseded by completion");
    assert.match(lullText, /Release pipeline finished: Tests passed and bundle is 140 kilobytes\./);

    await session.close("done");
    assistant.close();
  });

  it("tells the voice Muse thread to end its turn once a background task tool starts", async () => {
    const prompts: string[] = [];
    let emit: (method: string, params: Record<string, unknown>) => void = () => undefined;
    const raw = new MuseThreadBrain({
      cwd: "/work/river",
      title: "Voice with GLaDOS",
      model: "muse-spark-1.3",
      host: {
        startSession: async () => ({ sessionId: "voice-s1" }),
        startTurn: async ({ text }) => {
          prompts.push(text);
          const turnId = `vt-${prompts.length}`;
          queueMicrotask(() => {
            if (prompts.length === 1) {
              emit("item/completed", {
                item: { itemId: "i1", turnId, kind: "agentMessage", text: '[[propose_change {"title":"Realistic trees","goal":"Upgrade trees"}]]' },
              });
            } else {
              emit("item/completed", {
                item: { itemId: "i2", turnId, kind: "agentMessage", text: "Started your realistic trees upgrade." },
              });
            }
            emit("turn/completed", { turnId, terminal: "completed" });
          });
          return { turnId };
        },
        interruptTurn: async () => undefined,
        needsUser: () => false,
        watch: (_sid, h) => {
          emit = h;
          return () => undefined;
        },
        log: () => undefined,
      },
    });
    const brain = withTextTools(raw);
    const ctrl = new AbortController();
    const tools = [{ name: "propose_change", description: "Propose a write task", parameters: { type: "object" } }];

    const round1 = [];
    for await (const ev of brain.stream({
      messages: [
        { role: "system", content: "You are GLaDOS." },
        { role: "user", content: "Upgrade the trees." },
      ],
      tools,
      signal: ctrl.signal,
    })) {
      round1.push(ev);
    }
    assert.ok(round1.some((e) => e.type === "tool" && e.call.name === "propose_change"));
    assert.match(prompts[0] ?? "", /multi-tasking voice coordinator/);
    assert.match(prompts[0] ?? "", /workspace tools/);

    const round2 = [];
    for await (const ev of brain.stream({
      messages: [
        { role: "system", content: "You are GLaDOS." },
        { role: "user", content: "Upgrade the trees." },
        { role: "assistant", content: "", toolCalls: [{ id: "tc_1", name: "propose_change", arguments: '{"title":"Realistic trees","goal":"Upgrade trees"}' }] },
        { role: "tool", toolCallId: "tc_1", name: "propose_change", content: 'Started task t_1, "Realistic trees".' },
      ],
      tools,
      signal: ctrl.signal,
    })) {
      round2.push(ev);
    }
    assert.match(prompts[1] ?? "", /managed independently in its own session/);
    assert.match(prompts[1] ?? "", /finish this turn immediately/);
  });

  it("upgrades legacy maxConcurrent=1 profile rows once while respecting explicit user changes afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-multitask-"));
    try {
      const dbPath = join(dir, "assistant.db");
      const rawDb = new DatabaseSync(dbPath);
      migrate(rawDb);
      rawDb.prepare("INSERT INTO assistant_meta (key, value) VALUES ('salt', '00112233445566778899aabbccddeeff'), ('epoch', '0')").run();
      rawDb.prepare("INSERT INTO assistant_profile (id, json, updated_at) VALUES ('default', ?, 100)").run(
        JSON.stringify({
          id: "default",
          enabled: true,
          name: "GLaDOS",
          policy: { allowReadOnly: true, allowProjectWrites: true, maxConcurrent: 1, maxTurnsPerTask: 12, maxMinutesPerTask: 30, maxTasksPerDay: 10 },
        }),
      );
      rawDb.close();

      const store1 = MemoryStore.open(dbPath);
      assert.equal(store1.getProfile().policy.maxConcurrent, 3, "legacy single-slot profile upgraded to concurrent default");
      store1.saveProfile({ policy: { maxConcurrent: 1 } });
      assert.equal(store1.getProfile().policy.maxConcurrent, 1);
      store1.close();

      const store2 = MemoryStore.open(dbPath);
      assert.equal(store2.getProfile().policy.maxConcurrent, 1, "explicit user choice of 1 is preserved across reopen");
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
