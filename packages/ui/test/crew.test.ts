import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold, foldFromLoad, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, type AppState, type ThreadState } from "../src/model/store.js";
import { activityView, announcements, attentionOrder, completionView, costEstimate, headline, noUpdateThresholdMs, numberWord, pendingKey, phasesOf, pulseBins, readLaunchPolicy, readPlan, runCounts, sidebarCrewSummary, sigilGrid, sinceYouLeft, summaryLine, crewBusy, crewView, windowTitleCount, type AgentVM, type RunVM } from "../src/model/crew.js";
import type { MspItem, SessionSummary, TranscriptLoad, ViewEvent, WorkflowChild } from "../src/types.js";
import { S, T0, MIN, NOW, SESSION, SCRIPT, CALL, RUN_ID, launch, Feed, fold, lantern, APPROVAL, APPROVED, view, agentNamed } from "./fixtures/lantern.js";

const lookupAgent = (run: RunVM, name: string): AgentVM => agentNamed(run, name);

function createApprovalEvent(approvalId: string, at: number, itemId?: string): ViewEvent {
  return {
    method: "approval/requested",
    at,
    params: {
      approvalId,
      sessionId: "s1",
      itemId,
      currentRequirementId: null,
      availableChoices: [],
      subject: { kind: "shell", command: "npm test -- --run conflict" },
    },
  };
}

function createTaskEvent(revision: number, at: number, overrides: Partial<MspItem> = {}): ViewEvent {
  return {
    method: "item/updated",
    at,
    params: {
      item: {
        itemId: "task-e2e",
        kind: "toolCall",
        status: "inProgress",
        revision,
        tool: "bash",
        args: JSON.stringify({ command: "npm run test:e2e -- --grep sync" }),
        background: true,
        backgroundInitiator: "timeout",
        ...overrides,
      },
    },
  };
}

function createTaskDeltaEvent(at: number, delta: string): ViewEvent {
  return { method: "item/delta", at, params: { itemId: "task-e2e", field: "output", delta } };
}

function buildFinishedWorkflowRun(): RunVM {
  const feed = lantern();
  feed.finish("c-jc", S(42, 34), 1_040_000);
  feed.usage("c-jp", { reasoningTokens: 6_000, outputTokens: 10_000, inputTokens: 80_000 }, S(43, 48));
  feed.finish("c-jp", S(43, 50), 1_116_000);
  feed.retry("c-cf", 3, S(41, 52), "design:conflict-ledger");
  feed.set("c-cf", { status: "started" }, S(41, 53), 3);
  feed.usage("c-cf", { reasoningTokens: 6_000, outputTokens: 12_000, inputTokens: 100_000 }, S(44, 3), 3);
  feed.finish("c-cf", S(44, 4), 132_000, "completed", 3);
  feed.schedule("c-sr", "synthesize:report", S(44, 10));
  feed.set("c-sr", { status: "started" }, S(44, 11));
  feed.usage("c-sr", { reasoningTokens: 3_000, outputTokens: 8_000, inputTokens: 30_000 }, S(45, 9));
  feed.finish("c-sr", S(45, 10), 60_000);
  
  const reconciledPayload = {
    final_summary: {
      summary: "Recommend the CRDT ledger.\n\nIt resolved every case in the conflict corpus.\n\nThe op-log design is simpler.",
    },
    agents_activity: [],
    workspace_handoffs: [{ agent: "design:crdt-ledger", description: "ledger design doc" }],
  };
  feed.emit(S(45, 10), "completed", { message: `<workflow-launch-reconciled>${JSON.stringify(reconciledPayload)}</workflow-launch-reconciled>` });

  const resolutionEvents: ViewEvent[] = [
    { method: "approval/requested", at: S(39, 36), params: { approvalId: "ap1", sessionId: "s1", currentRequirementId: null, availableChoices: [], subject: { kind: "shell", command: "npm test" } } },
    { method: "approval/resolved", at: S(41, 16), params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" } },
  ];
  return view(feed, S(50, 0), {}, resolutionEvents).vm.runs[0] as RunVM;
}

function assembleAppState(threads: Record<string, ThreadState>, sessions: Record<string, SessionSummary>, route: AppState["route"] = { kind: "thread", sessionId: "s1" }): AppState {
  const initial = initialState(defaultPrefs("2026-09-26T00:00:00.000Z"));
  return {
    ...initial,
    connection: "open",
    route,
    sessions,
    threads,
    projects: [{ cwd: "/work/lantern", displayName: "lantern", pinned: true, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd: "/work/lantern", displayName: "lantern" }] }],
  };
}

function assembleThreadState(f: ThreadFold, extra: Partial<ThreadState> = {}): ThreadState {
  return { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: f, attachments: [], shellRuns: [], researchRuns: [], stalled: false, ...extra };
}

describe("crewView: agent organization and phase aggregation", () => {
  it("groups agents into phases by their label prefix, in schedule order, with the plan's unscheduled agents last", () => {
    const { vm } = view(lantern());
    assert.strictEqual(vm.runs.length, 1);
    const run = vm.runs[0] as RunVM;
    assert.strictEqual(run.name, "offline-sync-research-design");
    assert.strictEqual(run.runId, RUN_ID);
    assert.strictEqual(run.status, "running");
    
    const phaseNamesAndAgents = run.phases.map((p) => [p.name, p.agents.map((a) => a.name)]);
    const expectedPhases: [string, string[]][] = [
      ["Research", ["research:field-notes", "research:crdt-survey", "research:prior-art", "research:constraints"]], ["Design", ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]],
      ["Judge", ["judge:correctness", "judge:perf"]], ["Synthesize", ["synthesize:report"]],
    ];
    for (let i = 0; i < expectedPhases.length; i++) {
      assert.deepStrictEqual(phaseNamesAndAgents[i], expectedPhases[i]);
    }
    assert.deepStrictEqual(run.phases.map((phase) => phase.state), ["done", "done-with-failures", "live", "planned"]);
    assert.strictEqual(run.plannedKnown, true);
    assert.strictEqual(lookupAgent(run, "synthesize:report").state, "planned");
    assert.deepStrictEqual(lookupAgent(run, "judge:perf").display, { prefix: "judge:", short: "perf" });
  });

  it("counts add up to the known total and the current phase is the first with a live agent", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    const expectedCounts = { total: 10, planned: 1, scheduled: 0, working: 0, finishing: 1, noUpdate: 1, waiting: 0, failed: 1, skipped: 0, done: 6, unknown: 0 };
    assert.deepStrictEqual(run.counts, expectedCounts);
    assert.deepStrictEqual(runCounts(run), expectedCounts);
    assert.strictEqual(run.currentPhase, "Judge");
    assert.strictEqual(summaryLine(run).progress, "Judge · 6 of 10");
    assert.strictEqual(run.startedAt, S(0, 4), "the first revision seen is the run's start");
    assert.strictEqual(run.elapsedMs, NOW - S(0, 4));
    assert.strictEqual(run.elapsedApprox, false);
    assert.strictEqual(summaryLine(run).elapsed, "41m 12s");
  });

  it("keeps the healthy majority out of the attention list and lists failed before no update", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.deepStrictEqual(run.attention.map((a) => [a.name, a.state]), [["design:conflict-ledger", "failed"], ["judge:perf", "no-update"]]);
    assert.deepStrictEqual(summaryLine(run).chips, [{ kind: "failed", count: 1, text: "1 failed" }], "one chip is calmer than two: no update stays in the card");
    const snapshotAt30 = view(lantern(), S(30, 0));
    assert.deepStrictEqual((snapshotAt30.vm.runs[0] as RunVM).attention.map((a) => a.name), ["design:conflict-ledger"]);
  });

  it("reads the plan, the slots and the task text from the launch tool call", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.deepStrictEqual(run.slots, { used: 2, max: 16 });
    assert.strictEqual(lookupAgent(run, "design:conflict-ledger").task?.text, "Design the conflict ledger: define how two devices reconcile.");
    assert.strictEqual(lookupAgent(run, "design:conflict-ledger").task?.source, "script");
    assert.strictEqual(lookupAgent(run, "synthesize:report").task?.text, "Write the report.");
    const unparsed = fold([launch(SCRIPT, null), ...lantern().events]);
    assert.strictEqual((crewView(unparsed, SESSION, NOW).runs[0] as RunVM).slots, null, "no launch output, no slots");
  });

  it("bins the run's revisions into ten minutes of pulse, oldest first", () => {
    const { fold: f, vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.strictEqual(run.pulse.length, 10);
    assert.strictEqual(run.pulse[8], 1, "the usage report at 40m 23s");
    assert.strictEqual(run.pulse[9], 0, "nothing in the current minute");
    assert.deepStrictEqual(pulseBins(f.crew.runs["wf"], S(25, 30)), [0, 0, 2, 0, 0, 2, 0, 0, 2, 4]);
    assert.deepStrictEqual(pulseBins(undefined, NOW), new Array(10).fill(0));
  });

  it("adds up the tokens Muse reported and estimates the cost at the session model's list price", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.deepStrictEqual(run.tokens, { total: 1_200_500, reported: 8, of: 9 });
    assert.strictEqual(lookupAgent(run, "judge:perf").tokens, null, "not reported yet");
    assert.strictEqual(run.cost?.model, "muse-spark-1.3");
    assert.ok(Math.abs((run.cost?.usd ?? 0) - 1.942825) < 1e-9);
    assert.strictEqual(costEstimate({ inputTokens: 1000 }, "no-such-model"), null);
    assert.strictEqual(costEstimate({ inputTokens: 1000 }, null), null);
  });

  it("carries the per-attempt lifecycle with the times the fold recorded", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    const conflict = lookupAgent(run, "design:conflict-ledger");
    assert.strictEqual(conflict.attempt, 2);
    assert.deepStrictEqual(conflict.attempts.map((a) => [a.attempt, a.outcome, a.startedAt, a.endedAt]), [[1, "failed", S(12, 12), S(14, 20)], [2, "failed", S(14, 22), S(18, 13)]]);
    assert.deepStrictEqual((conflict.attempts[1] as AgentVM["attempts"][number]).events.map((e) => e.kind), ["scheduled", "started", "usage", "failed"]);
    assert.strictEqual((conflict.attempts[1] as AgentVM["attempts"][number]).events[3]?.detail, "after 3m 51s");
    assert.strictEqual(conflict.durationMs, 231_000);
    assert.strictEqual(conflict.failure?.text, null, "Muse has not reported a reason yet");
    assert.strictEqual(conflict.failure?.at, S(18, 13));
    const perf = lookupAgent(run, "judge:perf");
    assert.strictEqual(perf.startedAt, S(25, 14));
    assert.strictEqual(perf.runningMs, NOW - S(25, 14));
    assert.strictEqual(perf.silenceMs, NOW - S(25, 14));
    assert.strictEqual(perf.shareOfLongest, (NOW - S(25, 14)) / 760_000);
  });

  it("reports the longest finished agent, the agent time, the peak and the retries", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.strictEqual(run.longestFinishedMs, 760_000);
    assert.deepStrictEqual(run.peakConcurrency, { n: 4, phase: "Research" });
    assert.strictEqual(run.retried, 1);
    assert.strictEqual(run.agentTimeMs, 242_000 + 330_000 + 495_000 + 720_000 + 231_000 + 552_000 + 760_000);
    assert.strictEqual(run.report, null, "nothing to report while it runs");
  });
});

describe("crewView: silence detection and no-update thresholds", () => {
  it("flags nothing before any agent has finished, and then only past the longest finished sibling", () => {
    const f = new Feed();
    for (const [id, label] of [["a", "research:a"], ["b", "research:b"], ["j", "judge:j"]]) {
      f.schedule(id, label, S(0, 0)).set(id, { status: "started" }, S(0, 2));
    }
    const ongoing = crewView(fold([launch(null), ...f.events]), SESSION, S(40, 0)).runs[0] as RunVM;
    assert.strictEqual(ongoing.longestFinishedMs, null);
    assert.strictEqual(noUpdateThresholdMs(ongoing), null);
    assert.ok(ongoing.agents.every((a) => a.state === "working"));
    assert.strictEqual(lookupAgent(ongoing, "judge:j").state, "working");
    assert.strictEqual(summaryLine(ongoing).chips.length, 0);

    f.finish("a", S(12, 4), 12 * MIN + 4000);
    f.finish("b", S(12, 30), 3 * MIN);
    const siblingThreshold = 12 * MIN + 4000;
    const viewAt = (timestamp: number) => crewView(fold([launch(null), ...f.events]), SESSION, timestamp).runs[0] as RunVM;
    assert.strictEqual(noUpdateThresholdMs(viewAt(S(13, 0))), siblingThreshold);
    assert.strictEqual(lookupAgent(viewAt(S(0, 2) + siblingThreshold - 1000), "judge:j").state, "working");
    assert.strictEqual(lookupAgent(viewAt(S(0, 2) + siblingThreshold + 1000), "judge:j").state, "no-update");
    assert.deepStrictEqual(lookupAgent(viewAt(S(0, 2) + siblingThreshold + 1000), "judge:j").quiet, { thresholdMs: siblingThreshold, longestFinishedMs: siblingThreshold });
    assert.strictEqual(summaryLine(viewAt(S(0, 2) + siblingThreshold + 1000)).chips[0]?.text, "1 no update");
  });

  it("uses the four-minute floor when every finished sibling was quicker", () => {
    const f = new Feed();
    f.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1)).finish("a", S(1, 0), 59_000);
    f.schedule("b", "b", S(1, 0)).set("b", { status: "started" }, S(1, 1));
    const queryAgentB = (t: number) => lookupAgent(crewView(fold([launch(null), ...f.events]), SESSION, t).runs[0] as RunVM, "b");
    assert.strictEqual(noUpdateThresholdMs(crewView(fold([launch(null), ...f.events]), SESSION, S(2, 0)).runs[0] as RunVM), 4 * MIN);
    assert.strictEqual(queryAgentB(S(4, 59)).state, "working");
    assert.strictEqual(queryAgentB(S(5, 2)).state, "no-update");
  });

  it("keeps a working agent's spinner word while finishing and never marks a queued one", () => {
    const f = new Feed();
    f.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1)).finish("a", S(5, 0), 299_000);
    f.schedule("b", "b", S(5, 0));
    f.schedule("c", "c", S(5, 0)).set("c", { status: "started" }, S(5, 1)).usage("c", { inputTokens: 10 }, S(5, 2));
    const r = crewView(fold([launch(null), ...f.events]), SESSION, S(20, 0)).runs[0] as RunVM;
    assert.strictEqual(lookupAgent(r, "b").state, "scheduled");
    assert.strictEqual(lookupAgent(r, "c").state, "no-update", "finishing is a sub-state of working, so it can go quiet too");
    assert.strictEqual(lookupAgent(r, "c").attempts[0]?.events.at(-1)?.kind, "usage");
  });
});

describe("crewView: agent retry merging and failure states", () => {
  it("merges attempts on the durable id, keeps the row in place, and reads the run's failure text at the end", () => {
    const f = new Feed();
    f.schedule("x", "design:x", S(0, 0)).set("x", { status: "started" }, S(0, 1)).finish("x", S(2, 0), 119_000, "failed");
    f.schedule("y", "design:y", S(0, 0)).set("y", { status: "started" }, S(0, 1));
    const failedRun = crewView(fold([launch(null), ...f.events]), SESSION, S(3, 0)).runs[0] as RunVM;
    assert.strictEqual(lookupAgent(failedRun, "design:x").state, "failed");
    assert.strictEqual(lookupAgent(failedRun, "design:x").failure?.text, null);
    assert.deepStrictEqual(failedRun.agents.map((a) => a.name), ["design:x", "design:y"]);

    f.retry("x", 2, S(3, 0)).set("x", { status: "started" }, S(3, 1), 2);
    const retriedRun = crewView(fold([launch(null), ...f.events]), SESSION, S(4, 0)).runs[0] as RunVM;
    const agentX = lookupAgent(retriedRun, "design:x");
    assert.strictEqual(agentX.attempt, 2, "the label carried over the retry names the same row");
    assert.strictEqual(agentX.state, "working");
    assert.deepStrictEqual(retriedRun.agents.map((a) => a.name), ["design:x", "design:y"], "the row stays where it was");
    assert.deepStrictEqual(agentX.attempts.map((a) => [a.attempt, a.outcome]), [[1, "failed"], [2, null]]);

    f.finish("x", S(5, 0), 118_000, "failed", 2);
    f.finish("y", S(6, 0), 359_000);
    const reconciliationData = {
      latest_failure: "x: judge disagreed",
      agents_activity: [{ agent: "x", tool_calls: 12 }, { agent: "y", duration_ms: 359_000, tool_calls: 40 }],
      final_summary: { status: "completed", summary: "# Report\n\nOne of two landed." },
    };
    f.emit(S(6, 1), "completed", { message: `<workflow-launch-reconciled>${JSON.stringify(reconciliationData)}</workflow-launch-reconciled>` });
    const concludedRun = crewView(fold([launch(null), ...f.events]), SESSION, S(7, 0)).runs[0] as RunVM;
    assert.strictEqual(concludedRun.status, "finished-with-failures");
    assert.strictEqual(lookupAgent(concludedRun, "design:x").failure?.text, "x: judge disagreed");
    assert.strictEqual(lookupAgent(concludedRun, "design:x").toolCalls, 12);
    assert.strictEqual(lookupAgent(concludedRun, "design:y").toolCalls, 40);
    assert.strictEqual(concludedRun.report?.failure, "x: judge disagreed");
    assert.match(concludedRun.report?.summary ?? "", /One of two landed/);
  });

  it("shows a retry as pending until the next attempt appears, and a skip until the outcome does", () => {
    const f = new Feed();
    f.schedule("x", "x", S(0, 0)).set("x", { status: "started" }, S(0, 1)).finish("x", S(2, 0), 119_000, "failed");
    f.schedule("y", "y", S(0, 0)).set("y", { status: "started" }, S(0, 1));
    const pendingMap = { [pendingKey("s1", "x", 1)]: "retry" as const, [pendingKey("s1", "y", 1)]: "stop" as const };
    const runBefore = crewView(fold([launch(null), ...f.events]), SESSION, S(3, 0), { pending: pendingMap }).runs[0] as RunVM;
    assert.strictEqual(lookupAgent(runBefore, "x").pending, null, "a retry of a settled attempt is pending only on the row it will create");
    assert.strictEqual(lookupAgent(runBefore, "y").pending, "stop");
    f.retry("x", 2, S(3, 0), "x");
    f.finish("y", S(3, 1), 180_000, "cancelled");
    const runAfter = crewView(fold([launch(null), ...f.events]), SESSION, S(4, 0), { pending: pendingMap, skipped: [pendingKey("s1", "y", 1)] }).runs[0] as RunVM;
    assert.strictEqual(lookupAgent(runAfter, "x").pending, null, "attempt 2 is on the wire, so Muse confirmed the retry");
    assert.strictEqual(lookupAgent(runAfter, "x").state, "scheduled");
    assert.strictEqual(lookupAgent(runAfter, "y").pending, null);
    assert.strictEqual(lookupAgent(runAfter, "y").state, "skipped");
    assert.strictEqual(lookupAgent(runAfter, "y").skippedBy, "you");
    const activePending = { [pendingKey("s1", "x", 2)]: "retry" as const };
    assert.strictEqual(lookupAgent(crewView(fold([launch(null), ...f.events]), SESSION, S(4, 0), { pending: activePending }).runs[0] as RunVM, "x").pending, "retry");
  });

  it("says who skipped an agent: this client, the stopped run, or Muse", () => {
    const f = new Feed();
    f.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1)).finish("a", S(1, 0), 59_000, "cancelled");
    const museSkipped = lookupAgent(crewView(fold([launch(null), ...f.events]), SESSION, S(2, 0)).runs[0] as RunVM, "a");
    assert.strictEqual(museSkipped.skippedBy, "muse");
    f.schedule("b", "b", S(1, 0)).set("b", { status: "started" }, S(1, 1)).finish("b", S(2, 0), 59_000, "cancelled");
    f.emit(S(2, 1), "cancelled");
    const stoppedRun = crewView(fold([launch(null), ...f.events]), SESSION, S(3, 0)).runs[0] as RunVM;
    assert.strictEqual(stoppedRun.status, "stopped");
    assert.strictEqual(lookupAgent(stoppedRun, "b").skippedBy, "run");
    assert.strictEqual(summaryLine(stoppedRun).progress, "Stopped · 0 of 2 had landed");
  });

  it("marks a child the run ended without an outcome as unknown, never as still working", () => {
    const f = new Feed();
    f.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1));
    f.emit(S(1, 0), "failed", { failureReason: "the launcher died" });
    const abortedRun = crewView(fold([launch(null), ...f.events]), SESSION, S(2, 0)).runs[0] as RunVM;
    assert.strictEqual(abortedRun.status, "failed");
    assert.strictEqual(lookupAgent(abortedRun, "a").state, "unknown");
    assert.strictEqual(lookupAgent(abortedRun, "a").attempts[0]?.events.at(-1)?.kind, "unknown");
    assert.deepStrictEqual(summaryLine(abortedRun).chips, [{ kind: "run-failed", count: 1, text: "run failed" }]);
    assert.strictEqual(abortedRun.report?.failure, "the launcher died");
  });
});

describe("crewView: user interaction and pending approval tracking", () => {
  it("puts a session approval at run level and names no agent for it", () => {
    const approvalPayload = createApprovalEvent("ap1", S(39, 36));
    const { vm } = view(lantern(), NOW, {}, [approvalPayload]);
    const run = vm.runs[0] as RunVM;
    assert.deepStrictEqual(run.runNeeds, [{ kind: "approval", command: "npm test -- --run conflict", askedAt: S(39, 36), requestId: "ap1", phase: "Judge" }]);
    assert.strictEqual(run.counts.waiting, 0, "no agent is marked waiting without a wire link");
    assert.strictEqual(run.attention.some((a) => a.state === "waiting-on-you"), false);
    assert.deepStrictEqual(summaryLine(run).chips, [{ kind: "needs", count: 1, text: "1 needs you" }, { kind: "failed", count: 1, text: "1 failed" }]);
  });

  it("counts the time the run waited on you from the request to the decision", () => {
    const resolvedEvent: ViewEvent = { method: "approval/resolved", at: S(41, 16), params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" } };
    const { vm } = view(lantern(), S(42, 0), {}, [createApprovalEvent("ap1", S(39, 36)), resolvedEvent]);
    const run = vm.runs[0] as RunVM;
    assert.deepStrictEqual(run.runNeeds, []);
    assert.strictEqual(run.waitedOnYouMs, 100_000);
    const stillWaiting = view(lantern(), S(42, 0), {}, [createApprovalEvent("ap1", S(39, 36))]).vm.runs[0] as RunVM;
    assert.strictEqual(stillWaiting.waitedOnYouMs, S(42, 0) - S(39, 36), "an open request is still waiting");
  });

  it("gives a background task its own approval and leaves it off the run", () => {
    const taskItemEvent: ViewEvent = {
      method: "item/updated",
      at: S(30, 0),
      params: { item: { itemId: "task-1", kind: "toolCall", status: "inProgress", revision: 2, tool: "bash", args: JSON.stringify({ command: "npm run test:e2e" }), background: true, backgroundInitiator: "user", approvalId: "ap2" } },
    };
    const { vm } = view(lantern(), NOW, {}, [taskItemEvent, createApprovalEvent("ap2", S(31, 0), "task-1")]);
    const run = vm.runs[0] as RunVM;
    assert.deepStrictEqual(run.runNeeds, []);
    assert.strictEqual(vm.tasks.length, 1);
    const [taskRow] = vm.tasks;
    assert.strictEqual(taskRow?.state, "waiting-on-you");
    assert.strictEqual(taskRow?.needs?.command, "npm test -- --run conflict");
    assert.strictEqual(taskRow?.needs?.requestId, "ap2");
    assert.strictEqual(taskRow?.taskInfo?.initiator, "user");
  });
});

describe("crewView: background task lifecycle monitoring", () => {
  it("shows the command, the last output line, the initiator and the running time", () => {
    const foldState = fold([
      createTaskEvent(1, S(0, 0)),
      createTaskDeltaEvent(S(0, 30), "12 passed\n"),
      createTaskDeltaEvent(S(1, 0), "3 pending\nrunning \"merges concurrent edits\"\n"),
    ]);
    const [row] = crewView(foldState, SESSION, S(1, 23)).tasks;
    assert.ok(row);
    assert.strictEqual(row.kind, "task");
    assert.strictEqual(row.name, "npm run test:e2e -- --grep sync");
    assert.strictEqual(row.state, "working");
    assert.strictEqual(row.taskInfo?.tail, 'running "merges concurrent edits"');
    assert.strictEqual(row.taskInfo?.initiator, "timeout");
    assert.strictEqual(row.taskInfo?.lastOutputAt, S(1, 0));
    assert.strictEqual(row.startedAt, S(0, 0));
    assert.strictEqual(row.runningMs, 83_000);
    assert.strictEqual(crewBusy(foldState), true);
  });

  it("says no output past four minutes of silence, as a fact about its output", () => {
    const foldState = fold([createTaskEvent(1, S(0, 0)), createTaskDeltaEvent(S(0, 30), "12 passed\n")]);
    assert.strictEqual(crewView(foldState, SESSION, S(4, 29)).tasks[0]?.state, "working");
    const quietTask = crewView(foldState, SESSION, S(4, 41)).tasks[0];
    assert.strictEqual(quietTask?.state, "no-update");
    assert.strictEqual(quietTask?.silenceMs, 251_000);
    assert.deepStrictEqual(quietTask?.quiet, { thresholdMs: 4 * MIN, longestFinishedMs: null });
    assert.strictEqual(crewView(foldState, SESSION, S(4, 41), { stale: true, staleAt: S(2, 0) }).tasks[0]?.state, "working", "a stale feed promotes nothing");
  });

  it("ends as done without a failure kind, failed with one, and skipped when cancelled", () => {
    const doneTask = crewView(fold([createTaskEvent(1, S(0, 0)), createTaskEvent(2, S(4, 51), { status: "completed" })]), SESSION, S(5, 0)).tasks[0];
    assert.strictEqual(doneTask?.state, "done");
    assert.strictEqual(doneTask?.durationMs, 291_000);
    assert.strictEqual(doneTask?.failure, null);

    const failedTask = crewView(fold([createTaskEvent(1, S(0, 0)), createTaskEvent(2, S(4, 51), { status: "completed", failureKind: "tool_error" })]), SESSION, S(5, 0)).tasks[0];
    assert.strictEqual(failedTask?.state, "failed");
    assert.strictEqual(failedTask?.failure?.text, "tool_error");

    const cancelledTask = crewView(fold([createTaskEvent(1, S(0, 0)), createTaskEvent(2, S(1, 0), { status: "cancelled" })]), SESSION, S(5, 0), { skipped: [pendingKey("s1", "task-e2e", 1)] }).tasks[0];
    assert.strictEqual(cancelledTask?.state, "skipped");
    assert.strictEqual(cancelledTask?.skippedBy, "you");
    assert.strictEqual(crewBusy(fold([createTaskEvent(1, S(0, 0)), createTaskEvent(2, S(4, 51), { status: "completed" })])), false);
  });

  it("orders running tasks first and leaves ordinary tool calls out", () => {
    const combinedEvents: ViewEvent[] = [createTaskEvent(1, S(0, 0))];
    combinedEvents.push({ method: "item/updated", at: S(0, 10), params: { item: { itemId: "docs", kind: "toolCall", status: "inProgress", revision: 1, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true } } });
    combinedEvents.push({ method: "item/completed", at: S(0, 58), params: { item: { itemId: "docs", kind: "toolCall", status: "completed", revision: 2, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true } } });
    combinedEvents.push({ method: "item/completed", at: S(1, 0), params: { item: { itemId: "ls", kind: "toolCall", status: "completed", revision: 1, tool: "bash", args: JSON.stringify({ command: "ls" }) } } });
    const listedTasks = crewView(fold(combinedEvents), SESSION, S(2, 0)).tasks;
    assert.deepStrictEqual(listedTasks.map((t) => [t.name, t.state]), [["npm run test:e2e -- --grep sync", "working"], ["npm run docs:build", "done"]]);
  });
});

describe("crewView: partial history and disconnected streams", () => {
  it("numbers unnamed agents stably, flags the history as partial and reads the scheduling time off the id", () => {
    const uuidv7Id = "01a0dbae-727a-7543-b502-a584a609ad8b";
    const scheduledTimestamp = parseInt(uuidv7Id.slice(0, 8) + uuidv7Id.slice(9, 13), 16);
    const laterTime = scheduledTimestamp + 90_000;
    const partialEvents: ViewEvent[] = [
      { method: "item/updated", params: { item: { itemId: "wf", kind: "workflow", status: "inProgress", revision: 22, turnId: "t1", recordedAt: new Date(laterTime).toISOString(), children: [{ childId: uuidv7Id, attempt: 1, status: "started" }, { childId: "plain", attempt: 1, status: "started" }] } } },
      { method: "item/updated", params: { item: { itemId: "wf", kind: "workflow", status: "inProgress", revision: 23, turnId: "t1", recordedAt: new Date(laterTime + 60_000).toISOString(), children: [{ childId: uuidv7Id, attempt: 1, status: "terminal", terminal: "completed", durationMs: 100_000 }, { childId: "plain", attempt: 1, status: "started" }] } } },
    ];
    const agentNumberRegistry = new Map<string, number>();
    const partialRun = crewView(fold(partialEvents), SESSION, laterTime + 120_000, { partialHistory: true, numbers: agentNumberRegistry }).runs[0] as RunVM;
    assert.deepStrictEqual(partialRun.agents.map((a) => a.name), ["Agent 1", "Agent 2"]);
    assert.strictEqual(partialRun.partialHistory, true);
    assert.strictEqual(partialRun.elapsedApprox, true, "revision 22 was the first one loaded");
    assert.strictEqual(partialRun.plannedKnown, false);
    assert.strictEqual(summaryLine(partialRun).progress, "1 done · 1 working · more may start");
    assert.strictEqual(summaryLine(partialRun).elapsed, "about 2m", "from the first revision loaded, which is all that is known");

    const firstAgent = lookupAgent(partialRun, "Agent 1");
    assert.strictEqual(firstAgent.approx, true);
    assert.strictEqual(firstAgent.attempts[0]?.events[0]?.at, scheduledTimestamp, "the UUIDv7 time stands in for the scheduling revision");
    assert.strictEqual(firstAgent.attempts[0]?.events[0]?.detail, "about");
    assert.strictEqual(lookupAgent(partialRun, "Agent 2").attempts[0]?.events[0]?.at, null, "a plain id says nothing about when");

    const subsequentView = crewView(fold(partialEvents.slice(1)), SESSION, laterTime + 120_000, { numbers: agentNumberRegistry }).runs[0] as RunVM;
    assert.deepStrictEqual(subsequentView.agents.map((a) => a.name), ["Agent 1", "Agent 2"]);
  });

  it("falls back to scheduling bursts, then to one group, when labels carry no phase", () => {
    const burstFeed = new Feed();
    burstFeed.schedule("a", "alpha", S(0, 0)).schedule("b", "beta", S(0, 1));
    burstFeed.schedule("c", "gamma", S(5, 0));
    const wavesRun = crewView(fold(burstFeed.events), SESSION, S(6, 0)).runs[0] as RunVM;
    assert.deepStrictEqual(wavesRun.phases.map((p) => [p.name, p.agents.map((a) => a.name)]), [["Wave 1", ["alpha", "beta"]], ["Wave 2", ["gamma"]]]);

    const uniformFeed = new Feed();
    uniformFeed.schedule("a", "alpha", S(0, 0)).schedule("b", "beta", S(0, 1));
    assert.deepStrictEqual((crewView(fold(uniformFeed.events), SESSION, S(6, 0)).runs[0] as RunVM).phases.map((p) => p.name), ["Agents"]);

    const mixedFeed = new Feed();
    mixedFeed.schedule("a", "research:alpha", S(0, 0)).schedule("b", "beta", S(5, 0));
    assert.deepStrictEqual((crewView(fold(mixedFeed.events), SESSION, S(6, 0)).runs[0] as RunVM).phases.map((p) => p.name), ["Research", "Agents"]);

    const explicitPhaseFeed = new Feed();
    explicitPhaseFeed.schedule("a", "alpha", S(0, 0)).set("a", { phase: "Reading" }, S(0, 1));
    assert.deepStrictEqual((crewView(fold(explicitPhaseFeed.events), SESSION, S(6, 0)).runs[0] as RunVM).phases.map((p) => p.name), ["Reading"], "Muse's own phase word wins");
  });

  it("starts a run without children as starting, with no agents scheduled yet", () => {
    const startEvents: ViewEvent[] = [{ method: "item/started", at: S(0, 0), params: { item: { itemId: "wf", kind: "workflow", status: "inProgress", revision: 1, turnId: "t1", entryId: "tiny native diagnostic", children: [] } } }];
    const startingRun = crewView(fold([launch(null), ...startEvents]), SESSION, S(0, 4)).runs[0] as RunVM;
    assert.strictEqual(startingRun.status, "starting");
    assert.strictEqual(startingRun.name, "tiny native diagnostic");
    assert.deepStrictEqual(summaryLine(startingRun), { progress: "Starting · no agents scheduled yet", chips: [], elapsed: "4s" });
    assert.strictEqual(startingRun.currentPhase, null);
  });

  it("freezes every clock at the moment the feed went stale and promotes nothing", () => {
    const staleTime = S(41, 0);
    const { vm } = view(lantern(), S(55, 0), { stale: true, staleAt: staleTime });
    const staleRun = vm.runs[0] as RunVM;
    assert.strictEqual(staleRun.stale, true);
    assert.strictEqual(staleRun.elapsedMs, staleTime - S(0, 4));
    assert.strictEqual(staleRun.clockAt, staleTime);
    assert.strictEqual(lookupAgent(staleRun, "judge:perf").state, "working", "no verdict from a feed that may have missed the news");
    assert.strictEqual(lookupAgent(staleRun, "judge:perf").runningMs, staleTime - S(25, 14));
    const summary = summaryLine(staleRun);
    assert.deepStrictEqual(summary.chips, [{ kind: "stale", count: 1, text: "Last known" }]);
    assert.match(summary.elapsed, /^40m 56s · at /);
    assert.strictEqual(summary.progress, "Judge · 6 of 10");
  });

  it("falls back to the last event it saw when nobody says when the feed went stale", () => {
    const { vm } = view(lantern(), S(55, 0), { stale: true });
    assert.strictEqual((vm.runs[0] as RunVM).clockAt, S(40, 23));
  });
});

describe("crewView: usage latching and reconnect persistence", () => {
  it("keeps the tokens Muse sent once, across the revision that drops them and across a reload", () => {
    const f = new Feed();
    f.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1));
    f.usage("a", { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 }, S(3, 0));
    f.set("a", { status: "completed" }, S(3, 1));
    f.finish("a", S(3, 2), 181_000);
    const foldedThread = fold(f.events);
    assert.deepStrictEqual(foldedThread.crew.runs["wf"]?.children["a:1"]?.usage, { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 });

    const activeRun = crewView(foldedThread, SESSION, S(4, 0)).runs[0] as RunVM;
    assert.deepStrictEqual(lookupAgent(activeRun, "a").tokens, { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 });
    assert.deepStrictEqual(activeRun.tokens, { total: 52_337, reported: 1, of: 1 });

    const loadSnapshot: TranscriptLoad = {
      session: null,
      msp: null,
      truncated: true,
      readOnly: false,
      readOnlyReason: null,
      pending: { approvals: [], userInputs: [] },
      events: f.events.slice(-1).map((event) => ({ method: event.method, params: event.params })),
    };
    const rehydratedFold = foldFromLoad(loadSnapshot, foldedThread);
    assert.deepStrictEqual(lookupAgent(crewView(rehydratedFold, SESSION, S(4, 0)).runs[0] as RunVM, "a").tokens, { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 });
    assert.strictEqual((crewView(rehydratedFold, SESSION, S(4, 0)).runs[0] as RunVM).startedAt, S(0, 0), "the run's start from revision 1 survives the reload");
  });
});

describe("crewView: summary line rows", () => {
  it("covers the finished, stopped and plan-unknown rows of the table", () => {
    const f = lantern();
    f.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000);
    f.retry("c-cf", 3, S(41, 52), "design:conflict-ledger").set("c-cf", { status: "started" }, S(41, 53), 3).finish("c-cf", S(44, 4), 132_000, "completed", 3);
    f.schedule("c-sr", "synthesize:report", S(44, 10)).set("c-sr", { status: "started" }, S(44, 11)).finish("c-sr", S(45, 10), 60_000);
    const summaryPayload = { final_summary: { summary: "Recommend the CRDT ledger.\n\nIt resolved every case." }, agents_activity: [] };
    f.emit(S(45, 10), "completed", { message: `<workflow-launch-reconciled>${JSON.stringify(summaryPayload)}</workflow-launch-reconciled>` });

    const finishedRun = view(f, S(50, 0)).vm.runs[0] as RunVM;
    assert.strictEqual(finishedRun.status, "finished");
    assert.deepStrictEqual(summaryLine(finishedRun), { progress: "Done · 10 of 10", chips: [], elapsed: "45m 06s" });
    assert.strictEqual(finishedRun.counts.planned, 0, "once the run is over, the plan's unscheduled agents never existed");
    assert.strictEqual(finishedRun.endedAt, S(45, 10));

    const skippedFeed = lantern();
    skippedFeed.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000);
    skippedFeed.emit(S(43, 52), "completed");
    const partialRun = view(skippedFeed, S(50, 0), { skipped: [pendingKey("s1", "c-cf", 2)] }).vm.runs[0] as RunVM;
    assert.strictEqual(partialRun.status, "finished-with-failures");
    assert.deepStrictEqual(summaryLine(partialRun), { progress: "Finished · 8 of 9", chips: [{ kind: "failed", count: 1, text: "1 failed" }], elapsed: "43m 48s" });
  });
});

describe("crewView: completion headlines, sheen, and recaps", () => {
  it("writes the headline in words, the fact line, the stats and the sheen for a run where everyone landed", () => {
    const run = buildFinishedWorkflowRun();
    const report = completionView(run);
    assert.ok(report);
    assert.strictEqual(report.headline, "All ten landed.");
    assert.strictEqual(report.factLine, "Every phase reached its end · 1 agent needed 3 attempts");
    assert.deepStrictEqual(report.stats.map((stat) => stat.label), ["agents", "wall clock", "tokens, reported by Muse · latest attempt of each agent", "estimate at list price"]);
    assert.strictEqual(report.stats[0]?.value, "10");
    assert.strictEqual(report.stats[1]?.value, "45m 06s");
    assert.strictEqual(report.stats[2]?.value, "1.4M");
    assert.strictEqual(report.sheen, true);
    assert.strictEqual(report.excerpt, "Recommend the CRDT ledger.\nIt resolved every case in the conflict corpus.\nThe op-log design is simpler.");
    assert.deepStrictEqual(run.report?.handoffs, [{ agent: "design:crdt-ledger", description: "ledger design doc" }]);
    assert.strictEqual(completionView(view(lantern()).vm.runs[0] as RunVM), null, "no report while it runs");
  });

  it("chooses at most four highlights by priority, with the asides", () => {
    const report = completionView(buildFinishedWorkflowRun());
    assert.ok(report);
    assert.deepStrictEqual(report.highlights.map((h) => [h.icon, h.text, h.aside]), [
      ["Timer", "Longest agent judge:perf · 18m 36s", null],
      ["Database", "Most tokens research:field-notes · 270k", "20% of the run"],
      ["ArrowCounterClockwise", "Retried design:conflict-ledger · landed on attempt 3", "after 2 failed attempts"],
      ["ShieldWarning", "Waited on you 1m 40s", null],
    ]);
    assert.strictEqual(report.highlights[0]?.strong, "judge:perf");
  });

  it("puts what did not land first and drops the lowest priority past four", () => {
    const f = lantern();
    f.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000);
    f.emit(S(43, 52), "completed");
    const partialRun = view(f, S(50, 0), { skipped: [pendingKey("s1", "c-cf", 2)] }).vm.runs[0] as RunVM;
    const report = completionView(partialRun);
    assert.ok(report);
    assert.strictEqual(report.headline, "Eight of nine landed, one failed.");
    assert.strictEqual(report.factLine, "design:conflict-ledger failed after 2 attempts");
    assert.strictEqual(report.sheen, false);
    assert.deepStrictEqual(report.highlights.map((h) => h.text), [
      "1 agent failed design:conflict-ledger",
      "Longest agent judge:perf · 18m 36s",
      "Most tokens research:field-notes · 270k",
      "Peak concurrency 4 agents",
    ]);
    assert.strictEqual(report.highlights[0]?.aside, "after 2 attempts");
    assert.strictEqual(report.highlights[3]?.aside, "during Research");
  });

  it("spells the headline for every ending", () => {
    const makeCounts = (done: number, total: number, extra: Partial<ReturnType<typeof runCounts>> = {}) => ({ ...runCounts({ phases: [] }), total, done, ...extra });
    const cases = [
      { c: makeCounts(10, 10), status: "finished" as const, ms: 0, interrupted: false, expected: "All ten landed." },
      { c: makeCounts(9, 10, { skipped: 1 }), status: "finished-with-failures" as const, ms: 0, interrupted: false, expected: "Nine of ten landed, one skipped." },
      { c: makeCounts(8, 10, { failed: 2 }), status: "finished-with-failures" as const, ms: 0, interrupted: false, expected: "Eight of ten landed, two failed." },
      { c: makeCounts(7, 10, { skipped: 1, failed: 2 }), status: "finished-with-failures" as const, ms: 0, interrupted: false, expected: "Seven of ten landed, one skipped, two failed." },
      { c: makeCounts(4, 10, { unknown: 6 }), status: "stopped" as const, ms: 12 * MIN + 10_000, interrupted: false, expected: "Stopped by you after 12m; four of ten had landed." },
      { c: makeCounts(4, 10, { unknown: 6 }), status: "stopped" as const, ms: 12 * MIN + 10_000, interrupted: true, expected: "Interrupted after 12m; four of ten had landed." },
      { c: makeCounts(2, 10, { unknown: 8 }), status: "failed" as const, ms: 3 * MIN, interrupted: false, expected: "The run failed after 3m; two of ten had landed." },
      { c: makeCounts(198, 240, { failed: 4, unknown: 38 }), status: "finished-with-failures" as const, ms: 0, interrupted: false, expected: "198 of 240 landed, four failed, 38 not reported." },
      { c: makeCounts(1, 1), status: "finished" as const, ms: 0, interrupted: false, expected: "The agent landed." },
    ];
    for (const testCase of cases) {
      assert.strictEqual(headline(testCase.c, testCase.status, testCase.ms, testCase.interrupted), testCase.expected);
    }
    assert.strictEqual(numberWord(12), "twelve");
    assert.strictEqual(numberWord(13), "13");
  });

  it("draws the fingerprint with one span per attempt and the phases' bands", () => {
    const report = completionView(buildFinishedWorkflowRun());
    assert.ok(report);
    const { fingerprint } = report;
    assert.strictEqual(fingerprint.totalMs, S(45, 10) - S(0, 4));
    assert.strictEqual(fingerprint.partial, false);
    assert.deepStrictEqual(fingerprint.phases.map((p) => p.name), ["Research", "Design", "Judge", "Synthesize"]);
    const conflictLane = fingerprint.lanes.find((lane) => lane.name === "design:conflict-ledger");
    const deltaT = (m: number, s: number) => S(m, s) - S(0, 4);
    assert.deepStrictEqual(conflictLane?.spans.map((span) => [span.startMs, span.endMs, span.failed]), [
      [deltaT(12, 12), deltaT(14, 20), true],
      [deltaT(14, 22), deltaT(18, 13), true],
      [deltaT(41, 53), deltaT(44, 4), false],
    ]);
    assert.strictEqual(fingerprint.lanes.length, 10);
  });

  it("recaps what happened since the user left, once they were away five minutes", () => {
    const concludedRun = buildFinishedWorkflowRun();
    assert.strictEqual(sinceYouLeft(concludedRun, S(46, 0), S(50, 0)), null, "back within five minutes");
    assert.strictEqual(sinceYouLeft(concludedRun, S(46, 0), S(52, 0)), null, "nothing moved after the run ended");
    assert.deepStrictEqual(sinceYouLeft(concludedRun, S(29, 0), S(50, 0)), { leftAt: S(29, 0), finished: 4, failed: 0, phasesStarted: ["Synthesize"], runFinishedAt: S(45, 10) });

    const failedRun = view(lantern(), NOW).vm.runs[0] as RunVM;
    assert.deepStrictEqual(sinceYouLeft(failedRun, S(13, 0), NOW), { leftAt: S(13, 0), finished: 2, failed: 1, phasesStarted: ["Judge"], runFinishedAt: null });
  });
});

describe("crewView: workflow script plan extraction and sigil matrix", () => {
  it("reads the labels and inputs out of the parallel literals without running the script", () => {
    const workflowPlan = readPlan(SCRIPT);
    assert.ok(workflowPlan);
    assert.strictEqual(workflowPlan.labels.length, 10);
    assert.deepStrictEqual(workflowPlan.labels.slice(0, 4), ["research:field-notes", "research:crdt-survey", "research:prior-art", "research:constraints"]);
    assert.strictEqual(workflowPlan.inputs["research:prior-art"], "Find prior art in offline note apps.");
    assert.strictEqual(workflowPlan.inputs["research:crdt-survey"], "Survey CRDT designs for note text.");
    assert.strictEqual(workflowPlan.complete, true);
  });

  it("gives nothing for a script without literals and never throws on broken JavaScript", () => {
    assert.strictEqual(readPlan(undefined), null);
    assert.strictEqual(readPlan("export default async function workflow(host) { return host.parallel(agentsFromSomewhere); }"), null);
    assert.strictEqual(readPlan("const label = 'x';"), null, "a label outside a host call is not a plan");
    assert.doesNotThrow(() => readPlan("host.parallel([{ label: \"unterminated, input: `also"));
    assert.doesNotThrow(() => readPlan("host.parallel([{ label: 'a' }, { label: 'b', input: 'x' } /* unclosed comment"));
    const dynamicPlan = readPlan("for (const f of files) host.parallel([{ label: `read:${f}`, input: f }]);");
    assert.strictEqual(dynamicPlan?.complete, false, "a template label means the plan is not knowable here");
    assert.strictEqual(readPlan('host.agent({ label: "one", input: "do it" })')?.labels[0], "one");
  });

  it("reads the launch policy out of the tool's output", () => {
    assert.deepStrictEqual(readLaunchPolicy(JSON.stringify({ maxParallelAgents: 16, policy: { childLimit: 16 }, tokenBudget: null })), { maxParallelAgents: 16, childLimit: 16, tokenBudget: null });
    assert.strictEqual(readLaunchPolicy("not json"), null);
    assert.strictEqual(readLaunchPolicy(undefined), null);
  });

  it("says more may start when the script gives no plan", () => {
    const f = lantern();
    const unplannedRun = crewView(fold([launch(null), ...f.events]), SESSION, NOW).runs[0] as RunVM;
    assert.strictEqual(unplannedRun.plannedKnown, false);
    assert.strictEqual(unplannedRun.counts.total, 9);
    assert.strictEqual(summaryLine(unplannedRun).progress, "6 done · 2 working · more may start");
  });

  it("is deterministic, mirrored, and lights nine to fifteen cells", () => {
    for (const token of ["judge:perf", "research:field-notes", "design:conflict-ledger", "Agent 1", "", "x"]) {
      const grid = sigilGrid(token);
      assert.strictEqual(sigilGrid(token), grid, "cached");
      assert.deepStrictEqual(sigilGrid(`${token}`), grid);
      assert.strictEqual(grid.length, 5);
      let litCount = 0;
      for (const row of grid) {
        assert.strictEqual(row.length, 5);
        assert.strictEqual(row[0], row[4]);
        assert.strictEqual(row[1], row[3]);
        litCount += row.filter(Boolean).length;
      }
      assert.ok(litCount >= 9 && litCount <= 15, `${token}: ${litCount} lit`);
      assert.ok(grid.filter((row) => row.some(Boolean)).length >= 4);
      assert.ok((grid[2] as boolean[]).some(Boolean));
    }
    assert.notDeepStrictEqual(sigilGrid("judge:perf"), sigilGrid("judge:correctness"));
  });
});

describe("crewView: announcement event filters", () => {
  it("announces only a request, a failure, a phase end, the run's end and a stale feed", () => {
    const stateAt13 = view(lantern(), S(13, 0)).vm;
    const stateAt21 = view(lantern(), S(21, 30)).vm;
    assert.deepStrictEqual(announcements(stateAt13, stateAt21), ["design:conflict-ledger failed, attempt 2 of 2."]);
    assert.deepStrictEqual(announcements(view(lantern(), S(21, 30)).vm, view(lantern(), S(25, 0)).vm), ["Design phase finished, 2 of 3."]);
    assert.deepStrictEqual(announcements(null, stateAt21), [], "nothing on first sight");
    assert.deepStrictEqual(announcements(stateAt21, stateAt21), []);

    const testRequest = createApprovalEvent("ap1", S(39, 36));
    assert.deepStrictEqual(announcements(view(lantern(), NOW).vm, view(lantern(), NOW, {}, [testRequest]).vm), ["A request needs you."]);
    assert.deepStrictEqual(announcements(view(lantern(), NOW).vm, view(lantern(), NOW, { stale: true, staleAt: NOW }).vm), ["Connection stale; showing last known state."]);

    const completedFeed = lantern();
    completedFeed.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000).emit(S(43, 52), "completed");
    assert.deepStrictEqual(announcements(view(lantern(), S(42, 0)).vm, view(completedFeed, S(44, 0)).vm), ["Judge phase finished, 2 of 2.", "Eight of nine landed, one failed."]);

    const buildTaskEvent = (status: string, failureKind?: string): ViewEvent => ({
      method: "item/updated",
      at: S(1, 0),
      params: { item: { itemId: "docs", kind: "toolCall", status, revision: status === "inProgress" ? 1 : 2, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true, failureKind } },
    });
    assert.deepStrictEqual(
      announcements(crewView(fold([buildTaskEvent("inProgress")]), SESSION, S(2, 0)), crewView(fold([buildTaskEvent("inProgress"), buildTaskEvent("completed", "tool_error")]), SESSION, S(2, 0))),
      ["Background task npm run docs:build failed."]
    );
  });
});

describe("crewView: attention ordering and phases helpers", () => {
  it("orders attention rows by class and keeps each class stable", () => {
    const run = view(lantern()).vm.runs[0] as RunVM;
    const perfAgent = lookupAgent(run, "judge:perf");
    const conflictAgent = lookupAgent(run, "design:conflict-ledger");
    const waitingAgent: AgentVM = { ...perfAgent, id: "w", name: "w", state: "waiting-on-you" };
    assert.deepStrictEqual(attentionOrder([perfAgent, conflictAgent, waitingAgent, lookupAgent(run, "judge:correctness")]).map((a) => a.name), ["w", "design:conflict-ledger", "judge:perf"]);
    assert.deepStrictEqual(phasesOf([waitingAgent, perfAgent]).map((p) => [p.name, p.counts.total]), [["Judge", 2]]);
  });
});

describe("crewView: sidebar summaries and activity counters", () => {
  it("summarizes the open thread's run for the sidebar row", () => {
    const { fold: f } = view(lantern());
    const summary = sidebarCrewSummary(f, null, NOW, { sessionId: "s1" });
    assert.ok(summary);
    assert.strictEqual(summary.text, "Judge · 6/10");
    assert.deepStrictEqual(summary.groups.map((g) => g.length), [4, 3, 2, 1]);
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.noUpdate, 1);
    assert.strictEqual(summary.needs, 0);
    assert.strictEqual(summary.live, true);
    assert.strictEqual(sidebarCrewSummary(null, null, NOW), null);
    assert.strictEqual(sidebarCrewSummary(emptyFold(), null, NOW), null);

    const staleSummary = sidebarCrewSummary(f, null, S(55, 0), { sessionId: "s1", stale: true, staleAt: S(43, 0) });
    assert.strictEqual(staleSummary?.text, "Last known 12m");
    assert.strictEqual(staleSummary?.stale, true);
  });

  it("lists requests everywhere but runs and tasks only where this client folds them, with the v1 note", () => {
    const { fold: f } = view(lantern());
    const passkeySession: SessionSummary = {
      ...SESSION,
      sessionId: "s2",
      title: "Migrate auth to passkeys",
      live: { activeTurnId: "t", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 1, lastTerminal: null, lastError: null },
    };
    const appState = assembleAppState({ s1: assembleThreadState(f) }, { s1: SESSION, s2: passkeySession });
    const activity = activityView(appState, NOW);
    assert.deepStrictEqual(activity.needsYou.map((item) => [item.thread, item.text, item.stale]), [["Migrate auth to passkeys", "1 request waiting", true]]);
    assert.deepStrictEqual(activity.working.map((item) => [item.kind, item.text, item.sub]), [["run", "offline-sync-research-design", "Judge · 6 of 10"]]);
    assert.deepStrictEqual(activity.stopAll, { runs: 1, tasks: 0 });
    assert.strictEqual(activity.note, "Open a thread to load its agent activity. Disconnected threads show their last known state.");
    assert.strictEqual(activity.foot, "1 running in 1 thread · 1.2M tokens in current runs");
    assert.strictEqual(windowTitleCount(appState), 1);

    const emptyState = assembleAppState({}, {});
    const quietActivity = activityView(emptyState, NOW);
    assert.strictEqual(quietActivity.empty, true);
    assert.strictEqual(quietActivity.foot, "Nothing runs and nothing waits for you.");
    assert.strictEqual(quietActivity.note, null);
    assert.strictEqual(windowTitleCount(emptyState), 0);
  });

  it("counts the fold's requests for a live thread and the server's for the rest", () => {
    const shellApproval: ViewEvent = {
      method: "approval/requested",
      at: S(1, 0),
      params: { approvalId: "ap1", sessionId: "s1", currentRequirementId: null, availableChoices: [], subject: { kind: "shell", command: "rm -rf dist" } },
    };
    const f = fold([shellApproval]);
    const liveSession = {
      ...SESSION,
      live: { activeTurnId: null, turnStartedAt: null, pendingApprovals: 3, pendingInputs: 0, lastTerminal: null, lastError: null },
    };
    assert.strictEqual(windowTitleCount(assembleAppState({ s1: assembleThreadState(f) }, { s1: liveSession })), 1, "the fold knows better than a stale count");
    assert.strictEqual(windowTitleCount(assembleAppState({ s1: assembleThreadState(f, { stale: true }) }, { s1: liveSession })), 3, "a stale fold defers to the server");
    const activity = activityView(assembleAppState({ s1: assembleThreadState(f) }, { s1: liveSession }), NOW);
    assert.deepStrictEqual(activity.needsYou.map((item) => [item.text, item.sub]), [["Run a shell command", "rm -rf dist"]]);
  });
});
