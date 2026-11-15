// Demo seed and simulated runtime test suite
// Verifies that simulated session models generate compliant wire events,
// correct crew view folds across all scenarios, and expected mock client behaviors.
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { AgentVM, MspItem, RunVM, TranscriptLoad } from "@ancilla/ui";
import { completionView, errorKind, foldFromLoad, sidebarCrewSummary, summaryLine, crewView, usageTotal } from "@ancilla/ui";
import { BUILD_END_AT, BUILD_STEPS, BUILD_STEP_AT, BUILD_TOOLS } from "../src/demo/build.js";
import { DemoAncillaClient } from "../src/demo/client.js";
import { REPLAY_FAILURE, RESEARCH_RUNS, SCENARIOS, THREADS, seed, type Scenario, type SeedThread } from "../src/demo/seed.js";
// Test suite configuration constants
const BASELINE_EPOCH = Date.UTC(2026, 8, 26, 14, 43, 16);
const MINUTE_SPAN = 60_000;

function convertThreadToTranscriptLoad(demoThread: SeedThread): TranscriptLoad {
  const activeLive = demoThread.summary.live;
  const isTurnActive = Boolean(activeLive?.activeTurnId);
  // Construct transcript load payload
  const transcriptRecord: TranscriptLoad = {
    session: demoThread.summary,
    msp: {
      status: isTurnActive ? "running" : "idle",
      activeTurnId: activeLive?.activeTurnId ?? null,
      modelId: demoThread.summary.modelId,
      approvalMode: "onRequest",
      workspaceRoot: demoThread.summary.cwd,
      turnCount: demoThread.summary.turnCount,
    },
    events: [...demoThread.events],
    truncated: demoThread.truncated === true,
    attachments: [] as const,
    shellRuns: [] as const,
    pending: {
      approvals: [...demoThread.approvals],
      userInputs: [],
    },
    pendingComplete: true as const,
    readOnly: false as const,
    readOnlyReason: null as string | null,
  };
  return transcriptRecord;
}

function deriveCrewScenarioView(targetScenario: Scenario, timestamp = BASELINE_EPOCH) {
  const seedBundle = seed(timestamp, targetScenario);
  const primaryThread = seedBundle.threads[0] as SeedThread;
  const transcriptFold = foldFromLoad(convertThreadToTranscriptLoad(primaryThread));
  const crewViewModel = crewView(transcriptFold, primaryThread.summary, timestamp, {
    partialHistory: primaryThread.truncated === true,
  });
  // Package derived crew scenario view bundle
  const scenarioViewData = {
    seeded: seedBundle,
    thread: primaryThread,
    fold: transcriptFold,
    vm: crewViewModel,
  };
  return scenarioViewData;
}

function resolveFirstRun(scenarioKey: Scenario, timestamp = BASELINE_EPOCH): RunVM {
  const { vm } = deriveCrewScenarioView(scenarioKey, timestamp);
  assert.equal(vm.runs.length, 1, `Scenario '${scenarioKey}' must contain exactly one run`);
  const initialRun = vm.runs[0] as RunVM;
  return initialRun;
}

function locateAgent(parentRun: RunVM, targetName: string): AgentVM {
  const matched = parentRun.agents.find((candidate) => candidate.name === targetName);
  assert.ok(matched, `Expected agent '${targetName}' not found in run`);
  return matched;
}

function collectWorkflowItems(threadData: SeedThread): MspItem[] {
  return threadData.events
    .map((evt) => evt.params["item"] as MspItem | undefined)
    .filter((item): item is MspItem => item?.kind === "workflow");
}

describe("synthetic demo seed generation", () => {
  it("builds every scenario from the same nine threads", () => {
    for (const scenario of [...SCENARIOS]) {
      const generated = seed(BASELINE_EPOCH, scenario);
      assert.equal(generated.threads.length, 9, `Scenario ${scenario} should have 9 threads`);
      assert.equal(
        generated.threads[0]?.summary.sessionId,
        THREADS.audit,
        `${scenario} preserves audit session ID`,
      );
      const isWorkflowFree = scenario === "task" || scenario === "turn";
      assert.equal(
        generated.audit === null,
        isWorkflowFree,
        `Expected audit run nullness mismatch for ${scenario}`,
      );
    }
  });
  it("plays the turn scenario's prompt inside its own length, with one call that fails", () => {
    assert.equal(BUILD_STEPS.length, BUILD_STEP_AT.length, "Each step must align with its timestamp");
    assert.ok(
      BUILD_STEP_AT.every((val, idx) => idx === 0 || val > (BUILD_STEP_AT[idx - 1] as number)),
      "Step timestamps must be strictly monotonic",
    );
    assert.ok(
      (BUILD_STEP_AT[BUILD_STEP_AT.length - 1] as number) < BUILD_END_AT - 5_000,
      "Final step must precede turn completion boundary",
    );

    for (const toolSpec of BUILD_TOOLS) {
      assert.ok(
        toolSpec.at > 0 && toolSpec.at + toolSpec.ms < BUILD_END_AT - 3_000,
        `Tool call '${toolSpec.tool}' must finish before agent response starts`,
      );
    }
    // Validate failed tool calls
    const failedToolCalls = BUILD_TOOLS.filter((t) => t.fail !== undefined);
    assert.equal(failedToolCalls.length, 1, "Exactly one tool call failure is required for card UI testing");
    // Validate concurrent tool calls
    const hasOverlappingCalls = BUILD_TOOLS.some(
      (t, i) => i > 0 && t.at < (BUILD_TOOLS[i - 1] as (typeof BUILD_TOOLS)[number]).at + (BUILD_TOOLS[i - 1] as (typeof BUILD_TOOLS)[number]).ms,
    );
    assert.ok(hasOverlappingCalls, "Concurrent tool calls must exist to test stacked UI rendering");
    // Turn scenario view model assertions
    const turnModel = deriveCrewScenarioView("turn").vm;
    assert.equal(turnModel.runs.length, 1, "Turn scenario starts with a single settled turn");
    assert.equal(turnModel.runs[0]?.kind, "turn");
    assert.equal(turnModel.runs[0]?.status, "finished");
  });
  it("carries a finished research run with its cited report and a running one on the research thread", () => {
    const bundle = seed(BASELINE_EPOCH);
    assert.equal(bundle.research.length, 2, "Must seed completed and active research runs");

    const completedRun = bundle.research.find((r) => r.runId === RESEARCH_RUNS.done);
    const inProgressRun = bundle.research.find((r) => r.runId === RESEARCH_RUNS.running);
    assert.ok(completedRun && inProgressRun, "Both research runs must be present");

    const hasResearchThread = bundle.threads.some((t) => t.summary.sessionId === THREADS.research);
    assert.ok(hasResearchThread, "Research session thread must be registered in the thread list");
    // Completed research session checks
    assert.equal(completedRun.sessionId, THREADS.research);
    assert.equal(completedRun.status, "completed");
    assert.ok(completedRun.reportAvailable && completedRun.report && completedRun.reportPath);
    // Bibliography validation
    // Verify all inline citations match entries in the markdown bibliography
    const citedNumbers = new Set(
      [...completedRun.report.replace(/## Sources[\s\S]*$/, "").matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])),
    );
    const listedNumbers = new Set(
      [...(/## Sources([\s\S]*)$/.exec(completedRun.report)?.[1] ?? "").matchAll(/^\[\^(\d+)\]: \[.+\]\(https?:\/\/\S+\)$/gm)].map((m) => Number(m[1])),
    );
    assert.ok(citedNumbers.size > 0 && listedNumbers.size > 0);
    assert.deepEqual([...citedNumbers].sort(), [...listedNumbers].sort());
    // Running research session checks
    assert.ok(completedRun.workers.every((w) => w.state === "completed"));
    assert.equal(inProgressRun.status, "running");
    assert.equal(inProgressRun.phase, "researching");
    assert.equal(inProgressRun.round, 2);
    // Worker distribution
    const hasWorkingWorker = inProgressRun.workers.some((w) => w.state === "working");
    const hasFailedWorker = inProgressRun.workers.some((w) => w.state === "failed");
    assert.ok(hasWorkingWorker && hasFailedWorker, "Running research must display mixed worker statuses");
    // Chronological ordering check
    assert.ok(
      Date.parse(inProgressRun.createdAt) > Date.parse(completedRun.endedAt as string),
      "Active research run must have been initiated chronologically after the completed run",
    );
  });
  it("folds the research thread's runs into the Crew view, a phase per round and an agent per worker", () => {
    const bundle = seed(BASELINE_EPOCH);
    const researchThread = bundle.threads.find((t) => t.summary.sessionId === THREADS.research) as SeedThread;
    const threadFold = foldFromLoad(convertThreadToTranscriptLoad(researchThread));
    const crewModel = crewView(threadFold, researchThread.summary, BASELINE_EPOCH, { researchRuns: bundle.research });
    // Check research run items in crew view
    assert.deepEqual(
      crewModel.runs.map((r) => [r.kind, r.itemId, r.status]),
      [
        ["research", `research:${RESEARCH_RUNS.done}`, "finished"],
        ["research", `research:${RESEARCH_RUNS.running}`, "running"],
      ],
    );
    // Unpack active and done research runs
    const [doneRun, activeRun] = crewModel.runs as [RunVM, RunVM];
    assert.deepEqual(
      activeRun.phases.map((p) => [p.name, p.agents.map((a) => a.state)]),
      [
        ["Round 1 of 12", ["done", "done", "failed"]],
        ["Round 2 of 12", ["working", "working", "scheduled"]],
      ],
    );
    // Validate summary line and attention list
    assert.equal(summaryLine(activeRun).progress, "Researching, round 2 of 12 · 2 done · 2 working");
    assert.deepEqual(activeRun.attention.map((a) => a.name), ["A3 · Material 3 tonal palettes"]);
    assert.equal(activeRun.tokens?.total, 91_420);
    assert.equal(completionView(doneRun)?.headline, "All five landed.");
    assert.equal(
      completionView(doneRun)?.excerpt,
      "14 sources · 9 opened · 2 search only · 1 fetch failed or cut off · 11 citable · 4 curated\nThe report is in the transcript.",
    );
    assert.equal(
      sidebarCrewSummary(threadFold, researchThread.summary.live, BASELINE_EPOCH, { researchRuns: bundle.research })?.text,
      "2 done · 2 working",
    );
  });
  it("sends labels only when an agent is scheduled and usage on exactly one revision", () => {
    const { thread } = deriveCrewScenarioView("running");
    const itemRevisions = collectWorkflowItems(thread);
    assert.equal(itemRevisions[0]?.status, "inProgress");
    // Aggregate all emitted labels
    const labelsEmitted = itemRevisions.flatMap((rev) =>
      (rev.children ?? []).filter((c) => c.label !== undefined).map((c) => `${c.label}#${c.attempt}`),
    );
    assert.equal(new Set(labelsEmitted).size, labelsEmitted.length, "Each child agent attempt is labelled exactly once");
    assert.ok(labelsEmitted.includes("verify:migration-replay#2"), "A retry attempt receives label upon scheduling");
    // Aggregate all emitted usage items
    const usagesEmitted = itemRevisions.flatMap((rev) =>
      (rev.children ?? []).filter((c) => c.usage !== undefined).map((c) => `${c.childId}#${c.attempt}`),
    );
    assert.equal(new Set(usagesEmitted).size, usagesEmitted.length, "Usage data is reported on a single revision per attempt");
    assert.equal(usagesEmitted.length, 8);
    // Non-terminal revision checks
    for (const nonTerminalRev of itemRevisions.slice(0, -1)) {
      assert.equal(nonTerminalRev.message, undefined, "Terminal reconciliation payload must not appear on intermediate revisions");
    }
  });
});

describe("crewView over the scenarios", () => {
  it("running scenario: run 41m 16s in, with one failed, one quiet, one finishing and one planned agent", () => {
    const { vm, seeded } = deriveCrewScenarioView("running");
    const activeRun = vm.runs[0] as RunVM;
    // Inspect active run metadata
    assert.equal(activeRun.name, "v2-breaking-change-audit");
    assert.equal(activeRun.runId, "workflow-run-model-tool-call_01a0f3c4e7b2");
    assert.equal(activeRun.status, "running");
    assert.deepEqual(
      activeRun.phases.map((p) => [p.name, p.agents.map((a) => a.name)]),
      [
        ["Audit", ["audit:routes", "audit:schema", "audit:sdk", "audit:migrations"]],
        ["Verify", ["verify:sdk-examples", "verify:webhooks", "verify:migration-replay"]],
        ["Judge", ["judge:severity", "judge:compat"]],
        ["Report", ["report:release-notes"]],
      ],
    );
    // Verify run phase states and counts
    assert.deepEqual(activeRun.phases.map((p) => p.state), ["done", "done-with-failures", "live", "planned"]);
    assert.deepEqual(activeRun.counts, {
      total: 10,
      planned: 1,
      scheduled: 0,
      working: 0,
      finishing: 1,
      noUpdate: 1,
      waiting: 0,
      failed: 1,
      skipped: 0,
      done: 6,
      unknown: 0,
    });
    // Verify current phase and elapsed metrics
    assert.equal(activeRun.currentPhase, "Judge");
    assert.equal(activeRun.plannedKnown, true);
    assert.equal(activeRun.elapsedApprox, false);
    assert.equal(activeRun.elapsedMs, 41 * MINUTE_SPAN + 16_000);
    // Summary line verification
    const summary = summaryLine(activeRun);
    assert.equal(summary.progress, "Judge · 6 of 10");
    assert.deepEqual(summary.chips.map((c) => c.text), ["1 needs you", "1 failed"]);
    assert.equal(summary.elapsed, "41m 16s");
    // Verify attention list items
    assert.deepEqual(
      activeRun.attention.map((a) => [a.name, a.state]),
      [
        ["verify:migration-replay", "failed"],
        ["judge:compat", "no-update"],
      ],
    );
    // Needs and slot allocations
    assert.deepEqual(
      activeRun.runNeeds.map((n) => [n.kind, n.command, n.phase]),
      [["approval", "npm test -- test/sdk-compat.test.ts", "Judge"]],
    );
    // Verify slot allocation counts
    assert.deepEqual(activeRun.slots, { used: 2, max: 16 });
    assert.deepEqual(activeRun.tokens && { reported: activeRun.tokens.reported, of: activeRun.tokens.of }, { reported: 8, of: 9 });
    assert.ok(activeRun.cost && activeRun.cost.usd > 0, "Cost computation must reflect list pricing");
    assert.ok(activeRun.pulse.some((bin) => bin > 0), "Activity pulse must have registered recent traffic");

    const migrationAgent = locateAgent(activeRun, "verify:migration-replay");
    assert.equal(migrationAgent.attempt, 2);
    assert.deepEqual(migrationAgent.attempts.map((a) => a.outcome), ["failed", "failed"]);
    assert.equal(migrationAgent.failure?.text, null, "Failure diagnosis suppressed until terminal workflow state");
    assert.equal(usageTotal(migrationAgent.tokens), 58_500);

    const compatAgent = locateAgent(activeRun, "judge:compat");
    assert.deepEqual(compatAgent.quiet, { thresholdMs: 760_000, longestFinishedMs: 760_000 });
    assert.equal(compatAgent.silenceMs, 16 * MINUTE_SPAN + 2_000);

    assert.equal(locateAgent(activeRun, "judge:severity").state, "finishing");
    assert.equal(usageTotal(locateAgent(activeRun, "judge:severity").tokens), 148_000);
    assert.equal(locateAgent(activeRun, "report:release-notes").state, "planned");
    assert.match(locateAgent(activeRun, "report:release-notes").task?.text ?? "", /^Write the breaking-changes section/);
    assert.equal(locateAgent(activeRun, "verify:migration-replay").task?.source, "script");
    // Background task validation
    assert.equal(vm.tasks.length, 1, "Expected single background task");
    const bgTask = vm.tasks[0] as AgentVM;
    assert.equal(bgTask.name, "npm run test:e2e -- --grep orders");
    assert.equal(bgTask.state, "working");
    assert.equal(bgTask.taskInfo?.initiator, "user");
    assert.equal(bgTask.taskInfo?.tail, '12 passed · 3 pending · running "pages with a cursor under load"');
    assert.equal(bgTask.runningMs, 83_000);
    assert.equal(bgTask.silenceMs, 4_000);
    assert.equal(seeded.streams.length, 1);
    assert.equal(seeded.streams[0]?.lines.length, 6);
  });

  it("stalled scenario: only one agent silent past threshold, line carries no-update chip alone", () => {
    const stalledRun = resolveFirstRun("stalled");
    assert.deepEqual(stalledRun.attention.map((a) => [a.name, a.state]), [["judge:compat", "no-update"]]);
    assert.deepEqual(summaryLine(stalledRun).chips, [{ kind: "no-update", count: 1, text: "1 no update" }]);
    assert.equal(summaryLine(stalledRun).progress, "Judge · 8 of 10");
    assert.deepEqual(stalledRun.runNeeds, []);
    assert.equal(stalledRun.counts.failed, 0);
    assert.equal(locateAgent(stalledRun, "verify:migration-replay").state, "done");
    assert.equal(locateAgent(stalledRun, "verify:migration-replay").attempt, 2);
    assert.equal(locateAgent(stalledRun, "judge:compat").quiet?.longestFinishedMs, 760_000);
    assert.equal(deriveCrewScenarioView("stalled").vm.tasks.length, 0);
  });

  it("failed scenario: attempt 2 failed without reason; failure text arrives on termination", () => {
    const failedRun = resolveFirstRun("failed");
    assert.deepEqual(failedRun.attention.map((a) => [a.name, a.state]), [["verify:migration-replay", "failed"]]);
    assert.deepEqual(summaryLine(failedRun).chips.map((c) => c.text), ["1 failed"]);
    assert.equal(failedRun.counts.finishing, 2);
    assert.equal(failedRun.counts.noUpdate, 0);

    const replayChild = locateAgent(failedRun, "verify:migration-replay");
    assert.equal(replayChild.attempts.length, 2);
    assert.equal(replayChild.failure?.text, null);
    assert.equal(failedRun.report, null);
  });

  it("waiting scenario: run-level request naming no agent, task waiting on own request", () => {
    const { vm, thread } = deriveCrewScenarioView("waiting");
    const waitingRun = vm.runs[0] as RunVM;

    assert.deepEqual(waitingRun.attention, []);
    assert.deepEqual(summaryLine(waitingRun).chips, [{ kind: "needs", count: 1, text: "1 needs you" }]);
    assert.equal(waitingRun.runNeeds.length, 1);
    assert.equal(summaryLine(waitingRun).progress, "Judge · 7 of 10");
    assert.equal(thread.approvals.length, 2);

    const blockedTask = vm.tasks[0] as AgentVM;
    assert.equal(blockedTask.state, "waiting-on-you");
    assert.equal(blockedTask.needs?.kind, "approval");
    assert.equal(blockedTask.needs?.command, "https://cdn.playwright.dev:443");
    assert.equal(blockedTask.taskInfo?.approvalId, null);
  });

  it("partial scenario: first revision cut, unnamed agent, approximate elapsed time", () => {
    const { vm, thread } = deriveCrewScenarioView("partial");
    const partialRun = vm.runs[0] as RunVM;

    assert.equal(thread.truncated, true);
    assert.equal(partialRun.partialHistory, true);
    assert.equal(partialRun.elapsedApprox, true);
    assert.equal(summaryLine(partialRun).elapsed, "about 41m");
    assert.deepEqual(partialRun.agents.filter((a) => a.label === null).map((a) => a.name), ["Agent 1"]);
    assert.equal(summaryLine(partialRun).progress, "Judge · 6 of 11");
    assert.equal(partialRun.counts.planned, 2);
    assert.equal(partialRun.counts.done, resolveFirstRun("running").counts.done);
    assert.equal(collectWorkflowItems(thread)[0]?.revision, 2);
  });

  it("reconnect scenario: feed stale freezes clocks and suppresses promotions", () => {
    const { fold, thread } = deriveCrewScenarioView("reconnect");
    const liveModel = crewView(fold, thread.summary, BASELINE_EPOCH).runs[0] as RunVM;
    assert.equal(liveModel.status, "running");
    assert.deepEqual(liveModel.counts, resolveFirstRun("running").counts);

    const staleModel = crewView(fold, thread.summary, BASELINE_EPOCH + 10_000, {
      stale: true,
      staleAt: BASELINE_EPOCH + 4_000,
    }).runs[0] as RunVM;
    assert.equal(staleModel.stale, true);
    assert.equal(staleModel.elapsedMs, 41 * MINUTE_SPAN + 20_000);
    assert.equal(staleModel.counts.noUpdate, 0);
    assert.equal(locateAgent(staleModel, "judge:compat").state, "working");
    assert.deepEqual(summaryLine(staleModel).chips.map((c) => c.kind), ["stale"]);
    assert.match(summaryLine(staleModel).elapsed, /^41m 20s · at /);
  });

  it("done scenario: all agents landed, one retried twice, terminal report verified", () => {
    const { vm, fold } = deriveCrewScenarioView("done");
    const completedRun = vm.runs[0] as RunVM;

    assert.equal(completedRun.status, "finished");
    assert.equal(completedRun.counts.done, 10);
    assert.equal(completedRun.counts.total, 10);
    assert.equal(completedRun.retried, 1);
    assert.equal(completedRun.elapsedMs, 45 * MINUTE_SPAN + 10_000);
    assert.deepEqual(summaryLine(completedRun), { progress: "Done · 10 of 10", chips: [], elapsed: "45m 10s" });

    const retriedAgent = locateAgent(completedRun, "verify:migration-replay");
    assert.equal(retriedAgent.attempt, 3);
    assert.deepEqual(retriedAgent.attempts.map((a) => a.outcome), ["failed", "failed", "done"]);
    assert.equal(retriedAgent.failure, null);
    assert.deepEqual(completedRun.tokens && { reported: completedRun.tokens.reported, of: completedRun.tokens.of }, { reported: 10, of: 10 });
    assert.match(completedRun.report?.summary ?? "", /^## Breaking changes since v1\.9\.0/);
    assert.equal(completedRun.report?.failure, null);
    assert.equal(completedRun.report?.handoffs.length, 1);
    assert.equal(completedRun.waitedOnYouMs, 99_800);

    const finishSummary = completionView(completedRun);
    assert.ok(finishSummary);
    assert.equal(finishSummary.headline, "All ten landed.");
    assert.equal(finishSummary.factLine, "Every phase reached its end · 1 agent needed 3 attempts");
    assert.equal(finishSummary.sheen, true);
    assert.deepEqual(finishSummary.stats.slice(0, 2), [
      { value: "10", label: "agents" },
      { value: "45m 10s", label: "wall clock" },
    ]);
    assert.deepEqual(finishSummary.highlights.map((h) => h.text), [
      ["Longest agent judge:compat", "18m 36s"].join(" · "),
      ["Most tokens audit:routes", "288k"].join(" · "),
      ["Retried verify:migration-replay", "landed on attempt 3"].join(" · "),
      ["Waited on you", "1m 40s"].join(" "),
    ]);
    assert.ok(finishSummary.excerpt);
    assert.equal(finishSummary.fingerprint.lanes.length, 10);
    assert.equal(finishSummary.fingerprint.partial, false);
    assert.equal(vm.tasks[0]?.state, "done", "Background task must reach done state");
    assert.deepEqual(Object.keys(fold.approvals), [] as string[]);
  });

  it("big scenario: two thousand agents across 8 phases and 120 revisions", () => {
    const { vm, thread } = deriveCrewScenarioView("big");
    const massiveRun = vm.runs[0] as RunVM;

    assert.equal(collectWorkflowItems(thread).length, 120);
    assert.equal(massiveRun.name, "replay-recorded-traffic");
    assert.equal(massiveRun.counts.total, 2000);
    assert.equal(massiveRun.phases.length, 8);
    assert.ok(massiveRun.phases.every((p) => p.agents.length === 250));
    assert.deepEqual(
      {
        done: massiveRun.counts.done,
        failed: massiveRun.counts.failed,
        working: massiveRun.counts.working,
        scheduled: massiveRun.counts.scheduled,
        planned: massiveRun.counts.planned,
        noUpdate: massiveRun.counts.noUpdate,
      },
      { done: 1892, failed: 4, working: 36, scheduled: 68, planned: 0, noUpdate: 0 },
    );
    assert.equal(massiveRun.plannedKnown, false);
    assert.equal(summaryLine(massiveRun).progress, "1892 done · 36 working · more may start");
    assert.deepEqual(massiveRun.slots, { used: 36, max: 36 });
    assert.equal(massiveRun.tokens?.reported, 1892);
    assert.equal(massiveRun.currentPhase, "Write");
    assert.deepEqual(massiveRun.phases.slice(-2).map((p) => p.state), ["done", "live"]);
  });

  it("task: the ordinary turn stays visible alongside three background tasks printing, quiet and failed", () => {
    const { vm, fold, seeded } = deriveCrewScenarioView("task");
    assert.equal(vm.runs.length, 1);
    // Verify main turn status
    const taskTurn = vm.runs[0] as RunVM;
    assert.equal(taskTurn.kind, "turn");
    assert.equal(taskTurn.status, "running");
    assert.deepEqual(
      taskTurn.agents.filter((a) => a.kind === "lead").map((a) => [a.name, a.state]),
      [["Muse", "working"]],
    );
    // Verify background task statuses
    assert.deepEqual(
      vm.tasks.map((t) => [t.name, t.state]),
      [
        ["npm run docs:build", "no-update"],
        ["npm run test:e2e -- --grep orders", "working"],
        ["npx openapi-diff openapi/v1.9.0.yaml openapi/v2.yaml", "failed"],
      ],
    );
    // Examine individual background jobs
    const [docsJob, e2eJob, diffJob] = vm.tasks as [AgentVM, AgentVM, AgentVM];
    assert.equal(docsJob.taskInfo?.initiator, "timeout");
    assert.equal(docsJob.silenceMs, 4 * MINUTE_SPAN + 10_000);
    assert.equal(docsJob.taskInfo?.tail, "[info] Resolving 212 declarations");
    assert.equal(e2eJob.taskInfo?.initiator, "user");
    assert.equal(diffJob.failure?.text, "openapi-diff exited with status 2");
    assert.ok(diffJob.durationMs && diffJob.durationMs > 0);
    assert.equal(sidebarCrewSummary(fold, null, BASELINE_EPOCH)?.task, "npm run docs:build");
    assert.equal(seeded.streams.length, 1, "Expected single output stream");
  });

  it("subagent scenario: native subagent surfaced as spawn and wait pair", () => {
    const seeded = seed(BASELINE_EPOCH, "running");
    const chartThread = seeded.threads.find((t) => t.summary.sessionId === THREADS.lazyCharts) as SeedThread;
    const view = crewView(foldFromLoad(convertThreadToTranscriptLoad(chartThread)), chartThread.summary, BASELINE_EPOCH);
    // Verify lead agent status
    assert.equal(view.runs.length, 1);
    const chartRun = view.runs[0] as RunVM;
    assert.equal(chartRun.kind, "turn");
    assert.equal(chartRun.status, "finished");
    assert.deepEqual(
      chartRun.agents.filter((a) => a.kind === "lead").map((a) => [a.name, a.state]),
      [["Muse", "done"]],
    );
    // Subagent result check
    assert.equal(view.subagents.length, 1, "Expected single subagent view");
    const subSurvey = view.subagents[0] as AgentVM;
    assert.equal(subSurvey.name, "chart-imports-survey");
    assert.equal(subSurvey.kind, "subagent");
    assert.equal(subSurvey.state, "done");
    assert.match(subSurvey.task?.text ?? "", /^Check every other page that imports/);
    assert.ok(subSurvey.durationMs && subSurvey.durationMs > 0);
  });
});

describe("mock demo client runtime simulation", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  // Setup demo harness
  function setupDemoHarness(scenarioKey: Scenario): { client: DemoAncillaClient; run: RunVM; runId: string } {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASELINE_EPOCH });
    const demoClientInstance = new DemoAncillaClient(scenarioKey);
    const scenarioRun = resolveFirstRun(scenarioKey);
    return { client: demoClientInstance, run: scenarioRun, runId: scenarioRun.runId as string };
  }

  // Advance research helper
  function advanceResearchSteps(totalSteps: number) {
    for (let stepIdx = 0; stepIdx < totalSteps; stepIdx += 1) {
      mock.timers.tick(3_100);
    }
  }

  // Fetch updated crew view helper
  async function fetchUpdatedCrewView(client: DemoAncillaClient, targetTime = Date.now()) {
    const rawTranscript = await client.loadTranscript(THREADS.audit);
    const transcriptFold = foldFromLoad(rawTranscript);
    return {
      load: rawTranscript,
      fold: transcriptFold,
      vm: crewView(transcriptFold, rawTranscript.session, targetTime, { partialHistory: rawTranscript.truncated }),
    };
  }

  it("retries agent as new attempt on same row, landing within the minute", async () => {
    const { client, run, runId } = setupDemoHarness("running");
    const migrationChild = locateAgent(run, "verify:migration-replay");

    await client.workflow(THREADS.audit, "retry", runId, { childId: migrationChild.id, attempt: 2 });
    let updatedAgent = locateAgent((await fetchUpdatedCrewView(client)).vm.runs[0] as RunVM, "verify:migration-replay");
    assert.equal(updatedAgent.attempt, 3);
    assert.equal(updatedAgent.state, "scheduled");
    assert.equal(updatedAgent.attempts.length, 3);

    mock.timers.tick(2_000);
    updatedAgent = locateAgent((await fetchUpdatedCrewView(client)).vm.runs[0] as RunVM, "verify:migration-replay");
    assert.equal(updatedAgent.state, "working");

    mock.timers.tick(47_000);
    updatedAgent = locateAgent((await fetchUpdatedCrewView(client)).vm.runs[0] as RunVM, "verify:migration-replay");
    assert.equal(updatedAgent.state, "done");
    assert.deepEqual(updatedAgent.attempts.map((a) => a.outcome), ["failed", "failed", "done"]);
    assert.equal(usageTotal(updatedAgent.tokens), 118_000);
  });

  it("lists Wonder at the published price, each model with the reasoning levels it offers", async () => {
    const { client } = setupDemoHarness("running");
    const modelList = await client.listModels();
    const wonderEntry = modelList.find((m) => m.modelId === "muse-wonder-1.0");
    // Verify pricing structure
    assert.deepEqual(
      wonderEntry?.cost,
      { input: 4, output: 20, cached: 0.2, currency: "USD" },
      "Published table pricing must fallback properly",
    );
    assert.equal(wonderEntry?.contextLimit, 1_048_576);
    assert.equal(wonderEntry?.efforts?.at(-1), "max");
    assert.ok(!wonderEntry?.efforts?.includes("none"));

    const queryEfforts = (modelName: string) => modelList.find((m) => m.modelId === modelName)?.efforts;
    assert.deepEqual(queryEfforts("muse-spark-1.2"), ["minimal", "low", "medium", "high", "xhigh"]);
    assert.equal(queryEfforts("muse-spark-1.3")?.at(-1), "max");
    assert.deepEqual(modelList.filter((m) => m.isDefault).map((m) => m.modelId), ["muse-spark-1.3"]);
    assert.equal(modelList[0]?.modelId, "muse-wonder-1.0");
  });
  it("says where its model list came from, like a live host does", async () => {
    const { client } = setupDemoHarness("running");
    const catalogInfo = await client.listModelCatalog();
    assert.equal(catalogInfo.source, "providerCatalog");
    assert.ok(catalogInfo.hostVersion);
    assert.deepEqual(catalogInfo.models.map((m) => m.modelId), (await client.listModels()).map((m) => m.modelId));
  });
  it("puts Wonder in its usage, so the page prices a second model", async () => {
    const { client } = setupDemoHarness("running");
    const reportSummary = await client.usage(30);
    const wonderUsage = reportSummary.buckets.filter((b) => b.modelId === "muse-wonder-1.0");
    assert.ok(wonderUsage.length > 0 && wonderUsage.length <= 14);
    assert.ok(wonderUsage.every((b) => b.calls > 0 && b.promptTokens > 0));
    assert.ok(reportSummary.buckets.some((b) => b.modelId !== "muse-wonder-1.0"));
  });
  it("refuses control naming attempt agent already moved past", async () => {
    const { client, run, runId } = setupDemoHarness("running");
    const migrationChild = locateAgent(run, "verify:migration-replay");
    // Verify rejected workflow actions
    await assert.rejects(
      client.workflow(THREADS.audit, "retry", runId, { childId: migrationChild.id, attempt: 1 }),
      (err) => errorKind(err) === "stale_attempt",
    );
    await assert.rejects(
      client.workflow(THREADS.audit, "skip", runId, { childId: migrationChild.id, attempt: 2 }),
      (err) => errorKind(err) === "stale_attempt",
    );
  });

  it("skips working agent and stops individual or all background tasks", async () => {
    const { client, run, runId } = setupDemoHarness("running");
    const compatChild = locateAgent(run, "judge:compat");

    await client.workflow(THREADS.audit, "skip", runId, { childId: compatChild.id, attempt: 1 });
    const { vm } = await fetchUpdatedCrewView(client);
    assert.equal(locateAgent(vm.runs[0] as RunVM, "judge:compat").state, "skipped");

    const backgroundTask = vm.tasks[0] as AgentVM;
    await client.task(THREADS.audit, "stop", backgroundTask.id);
    assert.equal((await fetchUpdatedCrewView(client)).vm.tasks[0]?.state, "skipped");
    await assert.rejects(client.task(THREADS.audit, "stop", backgroundTask.id), /not running/);

    // Multi-task stopping verification
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASELINE_EPOCH });
    const multiTaskClient = new DemoAncillaClient("task");
    await multiTaskClient.task(THREADS.audit, "stopAll");
    assert.deepEqual(
      (await fetchUpdatedCrewView(multiTaskClient)).vm.tasks.map((t) => t.state),
      ["skipped", "failed", "skipped"],
    );
  });

  it("allows run to finish in place with terminal failure attribution", async () => {
    const { client } = setupDemoHarness("failed");
    client.finishAudit();
    mock.timers.tick(6_000);

    const { vm, fold } = await fetchUpdatedCrewView(client);
    const finishedRun = vm.runs[0] as RunVM;
    assert.deepEqual(Object.keys(fold.approvals), [], "Terminated turn must clear pending approval requests");
    assert.equal(finishedRun.status, "finished-with-failures");
    assert.equal(finishedRun.counts.total, 10);
    assert.equal(locateAgent(finishedRun, "report:release-notes").state, "done");
    assert.equal(locateAgent(finishedRun, "verify:migration-replay").failure?.text, REPLAY_FAILURE);
    assert.equal(finishedRun.report?.failure, REPLAY_FAILURE);
    assert.equal(completionView(finishedRun)?.headline, "Nine of ten landed, one failed.");

    const rawTranscript = await client.loadTranscript(THREADS.audit);
    assert.equal(rawTranscript.session?.live?.activeTurnId, null);
    assert.equal(rawTranscript.pending.approvals.length, 0);

    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: BASELINE_EPOCH });
    const waitingClient = new DemoAncillaClient("waiting");
    waitingClient.finishAudit();
    mock.timers.tick(6_000);

    const postWaitView = await fetchUpdatedCrewView(waitingClient);
    assert.deepEqual(Object.keys(postWaitView.fold.approvals), []);
    assert.equal(postWaitView.load.session?.live?.pendingApprovals, 0);
    assert.equal(postWaitView.vm.tasks[0]?.state, "working");
  });

  it("serves the seeded research runs with the thread, carries the running one to its report, and stops one on request", async () => {
    const { client } = setupDemoHarness("running");
    const broadcastEvents: { sessionId: string; runId: string; status: string; phase: string; report: string | null }[] = [];

    client.subscribe((evt) => {
      if (evt.type === "research-run") {
        broadcastEvents.push({
          sessionId: evt.sessionId,
          runId: evt.run.runId,
          status: evt.run.status,
          phase: evt.run.phase,
          report: evt.run.report,
        });
      }
    });
    // Check initial research thread transcript load
    const initialLoad = await client.loadTranscript(THREADS.research);
    assert.deepEqual(
      (initialLoad.researchRuns ?? []).map((r) => [r.runId, r.status]),
      [
        [RESEARCH_RUNS.done, "completed"],
        [RESEARCH_RUNS.running, "running"],
      ],
    );
    assert.equal(initialLoad.researchRuns?.[0]?.report, null);
    assert.match(
      (await client.getResearch(RESEARCH_RUNS.done)).report ?? "",
      /^# What muted text has to meet in dark mode/,
    );
    assert.deepEqual(
      (await client.listResearch(THREADS.research)).map((r) => r.runId),
      [RESEARCH_RUNS.done, RESEARCH_RUNS.running],
    );
    // Listing synchronization
    await client.listSessions();
    await client.whenListed();
    await Promise.resolve();
    // Advance simulation timer to finish active run
    advanceResearchSteps(40);

    const finishedActiveRun = await client.getResearch(RESEARCH_RUNS.running);
    assert.equal(finishedActiveRun.status, "completed");
    assert.equal(finishedActiveRun.phase, "done");
    assert.ok(finishedActiveRun.workers.every((w) => w.state !== "working" && w.state !== "queued"));
    assert.match(finishedActiveRun.report ?? "", /## Sources/);
    assert.doesNotMatch(finishedActiveRun.report ?? "", /actually opened|read and verified/);
    assert.match(finishedActiveRun.report ?? "", /opened or found in its search results/);
    assert.ok(
      (finishedActiveRun.sources.opened ?? 0) > 5 &&
        (finishedActiveRun.sources.opened ?? 0) <= finishedActiveRun.sources.verified,
    );
    assert.ok(broadcastEvents.some((e) => e.runId === RESEARCH_RUNS.running && e.phase === "writing"));
    assert.ok(broadcastEvents.every((e) => e.report === null));

    const newlyStartedRun = await client.startResearch(
      THREADS.research,
      "What is the state of the art?",
      { maxParallel: 2 },
      "cmd-1",
    );
    assert.equal(newlyStartedRun.status, "queued");
    assert.equal(newlyStartedRun.config.maxParallel, 2);
    assert.equal(
      (await client.startResearch(THREADS.research, "again", null, "cmd-1")).runId,
      newlyStartedRun.runId,
    );

    await assert.rejects(
      client.startResearch(THREADS.research, "another", null, "cmd-2"),
      /already has a research run/,
    );

    advanceResearchSteps(10);
    const midwaySnapshot = await client.getResearch(newlyStartedRun.runId);
    assert.equal(midwaySnapshot.status, "running");
    assert.equal(midwaySnapshot.phase, "researching");
    assert.ok(midwaySnapshot.sources.verified > 0);

    const stoppedRun = await client.stopResearch(newlyStartedRun.runId, true);
    assert.equal(stoppedRun.status, "partial");
    assert.match((await client.getResearch(newlyStartedRun.runId)).report ?? "", /stopped after/);
    // Advance steps while stopped
    advanceResearchSteps(20);
    assert.equal((await client.getResearch(newlyStartedRun.runId)).status, "partial");
    // Cancelled research run scenario
    const canceledRun = await client.startResearch(THREADS.research, "once more", null, "cmd-3");
    advanceResearchSteps(1);
    assert.equal((await client.getResearch(canceledRun.runId)).status, "running");
    assert.equal((await client.stopResearch(canceledRun.runId, false)).status, "cancelled");
    // Additional steps check cancellation stability
    advanceResearchSteps(5);
    assert.equal((await client.getResearch(canceledRun.runId)).status, "cancelled");
  });

  it("stops the research timers with the rest when disposed", async () => {
    const { client } = setupDemoHarness("running");
    const broadcastPhases: string[] = [];

    client.subscribe((evt) => {
      if (evt.type === "research-run") {
        broadcastPhases.push(evt.run.phase);
      }
    });

    await client.listSessions();
    await client.whenListed();
    await Promise.resolve();

    advanceResearchSteps(3);
    assert.ok(broadcastPhases.length > 0);

    const totalBroadcastBeforeDispose = broadcastPhases.length;
    const preDisposeRun = await client.getResearch(RESEARCH_RUNS.running);

    client.dispose();
    advanceResearchSteps(40);

    assert.equal(broadcastPhases.length, totalBroadcastBeforeDispose);
    const postDisposeRun = await client.getResearch(RESEARCH_RUNS.running);
    assert.equal(postDisposeRun.status, preDisposeRun.status);
    assert.equal(postDisposeRun.phase, preDisposeRun.phase);
    assert.deepEqual(postDisposeRun.workers, preDisposeRun.workers);
  });

  it("maintains single heartbeat revision in history and streams task output", async () => {
    const { client } = setupDemoHarness("running");
    const priorWorkflowCount = collectWorkflowItems(
      (await client.loadTranscript(THREADS.audit)) as unknown as SeedThread,
    ).length;
    const initialTailOutput = (await fetchUpdatedCrewView(client)).vm.tasks[0]?.taskInfo?.tail;

    client.subscribe(() => { /* listener */ });
    mock.timers.tick(18_001);

    const refreshedTranscript = await client.loadTranscript(THREADS.audit);
    assert.equal(
      collectWorkflowItems(refreshedTranscript as unknown as SeedThread).length,
      priorWorkflowCount + 1,
    );

    const refreshedView = await fetchUpdatedCrewView(client);
    assert.notEqual(refreshedView.vm.tasks[0]?.taskInfo?.tail, initialTailOutput);
    assert.equal(locateAgent(refreshedView.vm.runs[0] as RunVM, "judge:compat").state, "no-update");
  });
});
