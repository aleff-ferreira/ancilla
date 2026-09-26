import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResearchFailure, runResearch, type ResearchEventType, type ResearchRunState } from "../src/research/index.js";
import {
  FakeClock,
  FakeModel,
  FakeWorker,
  INPUT,
  briefText,
  completedResult,
  decision,
  fetchCall,
  makeHarness,
  saved,
  searchCall,
  testConfig,
  verifiedWorkerScript,
} from "./research-fakes.js";

const REPORT = "# Report\n\nA claim [A1-S1]. Another [A2-S1].";

/** A model that scopes, delegates once per round for `rounds` rounds, then concludes and writes `report`. */
function scriptedModel(clock: FakeClock, rounds: number, report = REPORT, minutesPerCall = 2): FakeModel {
  const supervisor = Array.from({ length: rounds }, (_, i) => decision("CONTINUE_RESEARCH", [`Topic ${i + 1}`]));
  supervisor.push(decision("RESEARCH_COMPLETE", [], "Final denoise. VERDICT: READY_TO_CONCLUDE"));
  const model = new FakeModel({ brief: [briefText()], draft: ["# Draft\n\nOutline."], supervisor, writer: [report] });
  model.onCall = () => clock.advanceMinutes(minutesPerCall);
  return model;
}

describe("runResearch", () => {
  it("runs question to cited report and ends completed", async () => {
    const clock = new FakeClock();
    const model = scriptedModel(clock, 2);
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.failure, null);
    assert.equal(outcome.report, "# Report\n\nA claim [1]. Another [2].\n\n## Sources\n\n[1] Source A1 (https://example.org/a1)\n[2] Source A2 (https://example.org/a2)");
    assert.equal(outcome.state.phase, "done");
    assert.equal(outcome.state.brief, "Research brief for the question.");
    assert.equal(outcome.state.draft, null);
    assert.equal(model.counts.draft, 0);
    assert.equal(worker.tasks.length, 2);
    assert.match(model.calls.find((c) => c.role === "writer")?.prompt ?? "", /\[A1-S1\] Source A1 \(https:\/\/example.org\/a1\)/);
    assert.match(model.calls.find((c) => c.role === "writer")?.prompt ?? "", /Final denoise\. VERDICT: READY_TO_CONCLUDE/);
  });

  it("excludes a source the worker claimed but never fetched or found", async () => {
    const clock = new FakeClock();
    const model = scriptedModel(clock, 1, "# R\n\nSeen [A1-S1]. Claimed [A1-S2].");
    const worker = new FakeWorker(() =>
      completedResult("text", [saved("https://seen.org/p", "Seen"), saved("https://claimed.org/p", "Claimed")], [fetchCall("https://seen.org/p/")]),
    );
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.report, "# R\n\nSeen [1]. Claimed A1-S2.\n\n## Sources\n\n[1] Seen (https://seen.org/p)");
    assert.deepEqual(
      outcome.state.registry.map((e) => [e.code, e.verified]),
      [
        ["A1-S1", true],
        ["A1-S2", false],
      ],
    );
    const writerPrompt = model.calls.find((c) => c.role === "writer")?.prompt ?? "";
    const registryBlock = /^<SOURCE REGISTRY>\n([\s\S]*?)^<\/SOURCE REGISTRY>/m.exec(writerPrompt)?.[1] ?? "";
    assert.match(registryBlock, /\[A1-S1\] Seen \(https:\/\/seen.org\/p\)/);
    assert.doesNotMatch(registryBlock, /Claimed/);
    // The worker's note still names the source, flagged so the writer knows it cannot be cited.
    assert.match(writerPrompt, /\[A1-S2\] Claimed \(https:\/\/claimed.org\/p\) - UNVERIFIED/);
    const savedEvent = harness.events.find((e) => e.type === "source_saved");
    assert.deepEqual(savedEvent?.payload, { count: 2, verified: 1 });
  });

  it("writes the stop-and-write report early in the window, before an automatic salvage would", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({
      brief: [briefText()],
      supervisor: [decision("CONTINUE_RESEARCH", ["Early"]), decision("CONTINUE_RESEARCH", ["Later"])],
      writer: ["# Early stop\n\nClaim [A1-S1]."],
    });
    // Only a few seconds pass per call: far below the 60% of the window an automatic salvage needs.
    model.onCall = () => clock.advanceMinutes(0.05);
    const controller = new AbortController();
    const worker = new FakeWorker(verifiedWorkerScript());
    worker.onStart = (task) => {
      if (task.agentId === 2) controller.abort();
    };
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch({ ...INPUT, stopWritesReport: true }, testConfig({ windowMaxMinutes: 10, salvageFraction: 0.6 }), harness.deps, controller.signal);
    assert.equal(outcome.status, "partial");
    assert.equal(outcome.report, "# Early stop\n\nClaim [1].\n\n## Sources\n\n[1] Source A1 (https://example.org/a1)");
    // Without findings there is nothing to write from, whatever the user asked.
    const bare = new FakeModel({ brief: [briefText()], supervisor: [decision("CONTINUE_RESEARCH", ["Only"])], writer: ["unused"] });
    const bareController = new AbortController();
    const bareWorker = new FakeWorker(verifiedWorkerScript());
    bareWorker.onStart = () => bareController.abort();
    const bareOutcome = await runResearch({ ...INPUT, stopWritesReport: true }, testConfig({}), makeHarness(bare, bareWorker, new FakeClock()).deps, bareController.signal);
    assert.equal(bareOutcome.status, "cancelled");
    assert.equal(bareOutcome.report, null);
  });

  it("writes a salvage report on abort when stopWritesReport is set, and starts no more workers", async () => {
    const clock = new FakeClock();
    // Four topics: the decision cap is maxParallel * 2, and maxParallel is 2 below.
    const topics = ["T1", "T2", "T3", "T4"];
    const model = new FakeModel({
      brief: [briefText()],
      supervisor: [decision("CONTINUE_RESEARCH", ["Early"]), decision("CONTINUE_RESEARCH", topics)],
      writer: ["# Salvage\n\nClaim [A1-S1]."],
    });
    model.onCall = () => clock.advanceMinutes(3.5);
    const controller = new AbortController();
    const worker = new FakeWorker(verifiedWorkerScript());
    worker.onStart = (task) => {
      if (task.agentId === 2) controller.abort();
    };
    const harness = makeHarness(model, worker, clock);
    const input = { ...INPUT, stopWritesReport: true };
    const outcome = await runResearch(input, testConfig({ maxParallel: 2, windowMaxMinutes: 10, salvageFraction: 0.6 }), harness.deps, controller.signal);
    assert.equal(outcome.status, "partial");
    assert.match(outcome.failure ?? "", /cancelled/);
    assert.equal(outcome.report, "# Salvage\n\nClaim [1].\n\n## Sources\n\n[1] Source A1 (https://example.org/a1)");
    // Agents 1 and 2 held the two lanes when agent 2's start aborted the run; agents 3 to 5 were queued and never started.
    assert.deepEqual(
      worker.tasks.map((t) => t.agentId),
      [1, 2],
    );
    const round2 = outcome.state.rounds[1];
    assert.deepEqual(
      round2?.results.map((r) => r.status),
      ["cancelled", "cancelled", "cancelled", "cancelled"],
    );
    assert.equal(round2?.exit, "cancelled");
    const types = harness.events.map((e) => e.type);
    assert.ok(types.indexOf("run_cancelled") < types.indexOf("report_started"));
    assert.equal(types[types.length - 1], "run_completed");
    const writerCall = model.calls.find((c) => c.role === "writer");
    assert.equal(writerCall?.signal.aborted, false);
    assert.match(writerCall?.prompt ?? "", /Research was stopped before the supervisor concluded/);
  });

  it("returns cancelled with no report on abort without the flag", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ brief: [briefText()], supervisor: [decision("CONTINUE_RESEARCH", ["A", "B"])], writer: ["unused"] });
    model.onCall = () => clock.advanceMinutes(7);
    const controller = new AbortController();
    const worker = new FakeWorker(verifiedWorkerScript());
    worker.onStart = () => controller.abort();
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch(INPUT, testConfig({ maxParallel: 1 }), harness.deps, controller.signal);
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.report, null);
    assert.equal(model.counts.writer, 0);
    assert.equal(worker.tasks.length, 1);
    assert.equal(harness.events[harness.events.length - 1]?.type, "run_cancelled");
    assert.equal(outcome.state.phase, "done");
  });

  it("treats a dependency's cancelled failure like an aborted signal", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ brief: [new ResearchFailure("cancelled", "host shut down")] });
    const harness = makeHarness(model, new FakeWorker(), clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.report, null);
  });

  it("ends partial with a failure when the writer returns the draft verbatim twice", async () => {
    const clock = new FakeClock();
    const draft = "# Draft\n\nOutline only.";
    const model = new FakeModel({
      brief: [briefText()],
      draft: [draft],
      supervisor: [decision("CONTINUE_RESEARCH", ["A"]), decision("RESEARCH_COMPLETE", [])],
      writer: [draft, `\n${draft}\n`],
    });
    model.onCall = () => clock.advanceMinutes(2);
    const worker = new FakeWorker(verifiedWorkerScript());
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch(INPUT, testConfig({ draftFirst: true }), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "partial");
    assert.equal(outcome.report, null);
    assert.match(outcome.failure ?? "", /after two attempts: report is identical to the initial draft/);
    assert.match(outcome.failure ?? "", /Collected: a draft, 1 worker note\(s\), 1 verified source\(s\)/);
    assert.equal(model.counts.writer, 2);
    assert.equal(model.counts.draft, 1);
    assert.match(model.calls[model.calls.length - 1]?.prompt ?? "", /not a copy of the initial draft or outline/);
    assert.ok(harness.events.some((e) => e.type === "draft_started") && harness.events.some((e) => e.type === "draft_completed"));
    assert.equal(harness.events[harness.events.length - 1]?.type, "run_completed");
  });

  it("rejects a short refusal from the writer and fails outright when nothing was collected", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({
      brief: [briefText()],
      supervisor: [decision("RESEARCH_COMPLETE", []), decision("RESEARCH_COMPLETE", [])],
      writer: ["I cannot help with that.", ""],
    });
    const harness = makeHarness(model, new FakeWorker(), clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.failure ?? "", /empty report/);
    assert.equal(harness.events[harness.events.length - 1]?.type, "run_failed");
  });

  it("fails the run on a fatal auth failure from the supervisor", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ brief: [briefText()], supervisor: [new ResearchFailure("auth", "login expired")] });
    const harness = makeHarness(model, new FakeWorker(), clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failure, "auth: login expired");
    assert.equal(outcome.report, null);
    assert.equal(model.counts.supervisor, 1);
    const last = harness.events[harness.events.length - 1];
    assert.equal(last?.type, "run_failed");
    assert.equal(last?.payload.reason, "auth: login expired");
  });

  it("retries a transient supervisor failure once and goes on", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({
      brief: [briefText()],
      supervisor: [new ResearchFailure("unavailable", "503"), decision("CONTINUE_RESEARCH", ["A"]), decision("RESEARCH_COMPLETE", [])],
      writer: [REPORT],
    });
    model.onCall = () => clock.advanceMinutes(2);
    const harness = makeHarness(model, new FakeWorker(verifiedWorkerScript()), clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.state.rounds.length, 2);
  });

  it("falls back to the question as the brief after two unusable brief answers", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ brief: ["no json", "{not json"], supervisor: [decision("RESEARCH_COMPLETE", []), decision("RESEARCH_COMPLETE", [])], writer: ["# Report\n\nNothing cited."] });
    const harness = makeHarness(model, new FakeWorker(), clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.state.brief, INPUT.question);
    assert.equal(outcome.state.targetLanguage, "English");
    assert.equal(model.counts.brief, 2);
    assert.match(model.calls[1]?.prompt ?? "", /did not contain a valid fenced JSON object/);
    const scoped = harness.events.find((e) => e.type === "scope_completed");
    assert.equal(scoped?.payload.fallback, true);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.report, "# Report\n\nNothing cited.");
  });

  it("resumes from a checkpoint at the next round and emits run_resumed", async () => {
    const clock = new FakeClock();
    const model = scriptedModel(clock, 3);
    const controller = new AbortController();
    const worker = new FakeWorker(verifiedWorkerScript());
    worker.onStart = (task) => {
      if (task.agentId === 2) controller.abort();
    };
    const harness = makeHarness(model, worker, clock);
    const first = await runResearch(INPUT, testConfig(), harness.deps, controller.signal);
    assert.equal(first.status, "cancelled");
    // The last checkpoint before the abort holds one finished round and an unfinished second one.
    const checkpoint = harness.checkpoints.find((s) => s.rounds.length === 2 && s.rounds[1]?.endedAt === null) as ResearchRunState;
    assert.ok(checkpoint);
    const lastSeq = checkpoint.eventSeq;

    const model2 = new FakeModel({ supervisor: [decision("CONTINUE_RESEARCH", ["Resumed topic"]), decision("RESEARCH_COMPLETE", [])], writer: ["# R\n\n[A1-S1] and [A3-S1]."] });
    model2.onCall = () => clock.advanceMinutes(2);
    const worker2 = new FakeWorker(verifiedWorkerScript());
    const harness2 = makeHarness(model2, worker2, clock);
    const outcome = await runResearch(INPUT, testConfig({ maxRounds: 99 }), harness2.deps, new AbortController().signal, checkpoint);
    assert.equal(outcome.status, "completed");
    assert.equal(harness2.events[0]?.type, "run_resumed");
    assert.equal(harness2.events[0]?.seq, lastSeq + 1);
    assert.equal(harness2.events[0]?.payload.droppedRound, true);
    assert.equal(model2.counts.brief, 0);
    assert.deepEqual(
      outcome.state.rounds.map((r) => r.round),
      [1, 2, 3],
    );
    assert.equal(outcome.state.rounds[1]?.delegations[0]?.topic, "Resumed topic");
    assert.equal(outcome.state.rounds[1]?.delegations[0]?.agentId, 3);
    assert.equal(outcome.report, "# R\n\n[1] and [2].\n\n## Sources\n\n[1] Source A1 (https://example.org/a1)\n[2] Source A3 (https://example.org/a3)");
    assert.equal(outcome.state.config.maxRounds, testConfig().maxRounds);
  });

  it("emits every event with the run id and an increasing seq, in phase order", async () => {
    const clock = new FakeClock();
    const model = scriptedModel(clock, 1);
    const worker = new FakeWorker((task, _budgets, _signal, sink) => {
      sink.onToolCall(searchCall("q", [{ url: "https://example.org/a1", title: "A" }]));
      sink.onToolCall(fetchCall("https://example.org/a1"));
      sink.onProgress({ toolCalls: 2, searches: 1, reads: 1 });
      return completedResult(`(https://example.org/a${task.agentId})`, [saved("https://example.org/a1", "Source A1")], [searchCall("q", [{ url: "https://example.org/a1", title: "A" }])]);
    });
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch(INPUT, testConfig({ draftFirst: true }), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "completed");
    harness.events.forEach((event, index) => {
      assert.equal(event.runId, "run-1");
      assert.equal(event.seq, index + 1);
    });
    const types = harness.events.map((e) => e.type);
    const expected: ResearchEventType[] = [
      "run_started",
      "scope_started",
      "scope_completed",
      "draft_started",
      "draft_completed",
      "supervisor_iteration",
      "delegation_started",
      "subagent_started",
      "worker_tool_call",
      "source_found",
      "worker_tool_call",
      "source_read",
      "source_saved",
      "subagent_completed",
      "supervisor_iteration",
      "report_started",
      "citations_validated",
      "run_completed",
    ];
    assert.deepEqual(types, expected);
    const toolCall = harness.events.find((e) => e.type === "worker_tool_call");
    assert.deepEqual(toolCall?.payload, { tool: "web_search", kind: "search" });
    assert.equal(toolCall?.agentId, 1);
    assert.equal(toolCall?.round, 1);
    assert.equal(harness.events.find((e) => e.type === "source_found")?.payload.count, 1);
    assert.equal(harness.events.find((e) => e.type === "scope_started")?.phase, "scoping");
    assert.equal(harness.events.find((e) => e.type === "report_started")?.phase, "writing");
    assert.equal(outcome.state.eventSeq, harness.events.length);
  });

  it("sums model and worker usage and never reads the host clock", async () => {
    const clock = new FakeClock();
    const model = scriptedModel(clock, 2);
    model.usagePerCall = 10;
    const harness = makeHarness(model, new FakeWorker(verifiedWorkerScript()), clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    // brief + 3 supervisor + writer = 5 model calls at 10, plus 2 workers at 50.
    assert.equal(outcome.state.usage.totalTokens, 150);
    assert.equal(outcome.state.startedAt, "2026-09-26T12:00:00.000Z");
    assert.equal(outcome.state.researchDeadlineAt, "2026-09-26T12:10:00.000Z");
    for (const event of harness.events) assert.ok(event.at >= "2026-09-26T12:00:00.000Z" && event.at < "2026-09-26T13:00:00.000Z");
  });

  it("marks the run failed when the loop trips the breaker", async () => {
    const clock = new FakeClock();
    const model = new FakeModel({ brief: [briefText()], supervisor: [decision("CONTINUE_RESEARCH", ["A"])] });
    const worker = new FakeWorker(() => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "rate_limited: 429" }));
    const harness = makeHarness(model, worker, clock);
    const outcome = await runResearch(INPUT, testConfig(), harness.deps, new AbortController().signal);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.failure ?? "", /rate-limit/);
    assert.equal(model.counts.writer, 0);
    assert.equal(harness.events[harness.events.length - 1]?.type, "run_failed");
  });
});
