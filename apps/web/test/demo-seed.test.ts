import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  completionView,
  errorKind,
  foldFromLoad,
  sidebarSwarmSummary,
  summaryLine,
  swarmView,
  usageTotal,
  type AgentVM,
  type MspItem,
  type RunVM,
  type TranscriptLoad,
} from "@ancilla/ui";
import { DemoAncillaClient } from "../src/demo/client.js";
import { REPLAY_FAILURE, RESEARCH_RUNS, SCENARIOS, THREADS, seed, type Scenario, type SeedThread } from "../src/demo/seed.js";

/**
 * The demo seed builds every `?swarm=` scenario as the wire Muse would have sent, and the UI's own model
 * (`swarmView`, the same fold the app uses) reads the states the design's scenario calls for off it.
 */

const NOW = Date.UTC(2026, 8, 26, 14, 43, 16);
const MIN = 60_000;

/** The thread as the demo client serves it to the app. */
function loadOf(thread: SeedThread): TranscriptLoad {
  const live = thread.summary.live;
  return {
    session: thread.summary,
    msp: { status: live?.activeTurnId ? "running" : "idle", activeTurnId: live?.activeTurnId ?? null, modelId: thread.summary.modelId, approvalMode: "onRequest", workspaceRoot: thread.summary.cwd, turnCount: thread.summary.turnCount },
    events: [...thread.events],
    truncated: thread.truncated === true,
    attachments: [],
    shellRuns: [],
    pending: { approvals: [...thread.approvals], userInputs: [] },
    pendingComplete: true,
    readOnly: false,
    readOnlyReason: null,
  };
}

function viewOf(scenario: Scenario, now = NOW) {
  const seeded = seed(now, scenario);
  const thread = seeded.threads[0] as SeedThread;
  const fold = foldFromLoad(loadOf(thread));
  return { seeded, thread, fold, vm: swarmView(fold, thread.summary, now, { partialHistory: thread.truncated === true }) };
}

function runOf(scenario: Scenario, now = NOW): RunVM {
  const { vm } = viewOf(scenario, now);
  assert.equal(vm.runs.length, 1, `${scenario} has one run`);
  return vm.runs[0] as RunVM;
}

function agent(run: RunVM, name: string): AgentVM {
  const found = run.agents.find((candidate) => candidate.name === name);
  assert.ok(found, `no agent named ${name}`);
  return found;
}

function workflowEvents(thread: SeedThread): MspItem[] {
  return thread.events.map((event) => event.params["item"] as MspItem | undefined).filter((item): item is MspItem => item?.kind === "workflow");
}

describe("the demo seed", () => {
  it("builds every scenario from the same nine threads", () => {
    for (const scenario of SCENARIOS) {
      const seeded = seed(NOW, scenario);
      assert.equal(seeded.threads.length, 9, scenario);
      assert.equal(seeded.threads[0]?.summary.sessionId, THREADS.audit, `${scenario} keeps the audit thread's id`);
      assert.equal(seeded.audit === null, scenario === "task", `${scenario} ${scenario === "task" ? "has no run" : "has a run"}`);
    }
  });

  it("carries a finished research run with its cited report and a running one on the research thread", () => {
    const seeded = seed(NOW);
    assert.equal(seeded.research.length, 2);
    const done = seeded.research.find((run) => run.runId === RESEARCH_RUNS.done);
    const running = seeded.research.find((run) => run.runId === RESEARCH_RUNS.running);
    assert.ok(done && running);
    assert.ok(seeded.threads.some((thread) => thread.summary.sessionId === THREADS.research), "the thread the runs belong to is seeded");
    assert.equal(done.sessionId, THREADS.research);
    assert.equal(done.status, "completed");
    assert.ok(done.reportAvailable && done.report && done.reportPath);
    // Every citation in the report names a source the report lists, and nothing is cited that is not listed.
    const cited = new Set([...done.report.replace(/## Sources[\s\S]*$/, "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const listed = new Set([...(/## Sources([\s\S]*)$/.exec(done.report)?.[1] ?? "").matchAll(/^\[(\d+)\] .+ \(https?:\/\/\S+\)$/gm)].map((m) => Number(m[1])));
    assert.ok(cited.size > 0 && listed.size > 0);
    assert.deepEqual([...cited].sort(), [...listed].sort());
    assert.ok(done.workers.every((worker) => worker.state === "completed"));
    assert.equal(running.status, "running");
    assert.equal(running.phase, "researching");
    assert.equal(running.round, 2);
    assert.ok(running.workers.some((worker) => worker.state === "working") && running.workers.some((worker) => worker.state === "failed"));
    assert.ok(Date.parse(running.createdAt) > Date.parse(done.endedAt as string), "the running one came after the finished one");
  });

  it("folds the research thread's runs into the Swarm view, a phase per round and an agent per worker", () => {
    const seeded = seed(NOW);
    const thread = seeded.threads.find((candidate) => candidate.summary.sessionId === THREADS.research) as SeedThread;
    const fold = foldFromLoad(loadOf(thread));
    const vm = swarmView(fold, thread.summary, NOW, { researchRuns: seeded.research });
    assert.deepEqual(vm.runs.map((run) => [run.kind, run.itemId, run.status]), [
      ["research", `research:${RESEARCH_RUNS.done}`, "finished"],
      ["research", `research:${RESEARCH_RUNS.running}`, "running"],
    ]);
    const [done, running] = vm.runs as [RunVM, RunVM];
    assert.deepEqual(running.phases.map((phase) => [phase.name, phase.agents.map((agent) => agent.state)]), [
      ["Round 1 of 12", ["done", "done", "failed"]],
      ["Round 2 of 12", ["working", "working", "scheduled"]],
    ]);
    assert.equal(summaryLine(running).progress, "Researching, round 2 of 12 · 2 done · 2 working");
    assert.deepEqual(running.attention.map((agent) => agent.name), ["A3 · Material 3 tonal palettes"]);
    assert.equal(running.tokens?.total, 91_420);
    assert.equal(completionView(done)?.headline, "All five landed.");
    assert.equal(completionView(done)?.excerpt, "14 sources · 11 verified · 4 curated\nThe report is in the transcript.");
    assert.equal(sidebarSwarmSummary(fold, thread.summary.live, NOW, { researchRuns: seeded.research })?.text, "2 done · 2 working");
  });

  it("sends labels only when an agent is scheduled and usage on exactly one revision, as Muse does", () => {
    const { thread } = viewOf("running");
    const revisions = workflowEvents(thread);
    assert.equal(revisions[0]?.status, "inProgress");
    const labelled = revisions.flatMap((item) => (item.children ?? []).filter((child) => child.label !== undefined).map((child) => `${child.label}#${child.attempt}`));
    assert.equal(new Set(labelled).size, labelled.length, "every attempt is labelled once");
    assert.ok(labelled.includes("verify:migration-replay#2"), "a retry is labelled when it is scheduled");
    const usages = revisions.flatMap((item) => (item.children ?? []).filter((child) => child.usage !== undefined).map((child) => `${child.childId}#${child.attempt}`));
    assert.equal(new Set(usages).size, usages.length, "usage rides one revision per attempt");
    assert.equal(usages.length, 8);
    for (const item of revisions.slice(0, -1)) {
      assert.equal(item.message, undefined, "the reconciliation payload travels only on the terminal revision");
    }
  });
});

describe("swarmView over the scenarios", () => {
  it("running: the design's run 41m 16s in, with one failed, one quiet, one finishing and one planned agent", () => {
    const { vm, seeded } = viewOf("running");
    const run = vm.runs[0] as RunVM;
    assert.equal(run.name, "v2-breaking-change-audit");
    assert.equal(run.runId, "workflow-run-model-tool-call_01a0f3c4e7b2");
    assert.equal(run.status, "running");
    assert.deepEqual(run.phases.map((phase) => [phase.name, phase.agents.map((a) => a.name)]), [
      ["Audit", ["audit:routes", "audit:schema", "audit:sdk", "audit:migrations"]],
      ["Verify", ["verify:sdk-examples", "verify:webhooks", "verify:migration-replay"]],
      ["Judge", ["judge:severity", "judge:compat"]],
      ["Report", ["report:release-notes"]],
    ]);
    assert.deepEqual(run.phases.map((phase) => phase.state), ["done", "done-with-failures", "live", "planned"]);
    assert.deepEqual(run.counts, { total: 10, planned: 1, scheduled: 0, working: 0, finishing: 1, noUpdate: 1, waiting: 0, failed: 1, skipped: 0, done: 6, unknown: 0 });
    assert.equal(run.currentPhase, "Judge");
    assert.equal(run.plannedKnown, true);
    assert.equal(run.elapsedApprox, false);
    assert.equal(run.elapsedMs, 41 * MIN + 16_000);
    const line = summaryLine(run);
    assert.equal(line.progress, "Judge · 6 of 10");
    assert.deepEqual(line.chips.map((chip) => chip.text), ["1 needs you", "1 failed"]);
    assert.equal(line.elapsed, "41m 16s");
    assert.deepEqual(run.attention.map((a) => [a.name, a.state]), [["verify:migration-replay", "failed"], ["judge:compat", "no-update"]]);
    assert.deepEqual(run.runNeeds.map((need) => [need.kind, need.command, need.phase]), [["approval", "npm test -- test/sdk-compat.test.ts", "Judge"]]);
    assert.deepEqual(run.slots, { used: 2, max: 16 });
    assert.deepEqual(run.tokens && { reported: run.tokens.reported, of: run.tokens.of }, { reported: 8, of: 9 });
    assert.ok(run.cost && run.cost.usd > 0, "a cost estimate at the session model's list price");
    assert.ok(run.pulse.some((bin) => bin > 0), "the pulse saw revisions in the last ten minutes");

    const replay = agent(run, "verify:migration-replay");
    assert.equal(replay.attempt, 2);
    assert.deepEqual(replay.attempts.map((attempt) => attempt.outcome), ["failed", "failed"]);
    assert.equal(replay.failure?.text, null, "no reason until the run ends");
    assert.equal(usageTotal(replay.tokens), 64_200);
    const compat = agent(run, "judge:compat");
    assert.deepEqual(compat.quiet, { thresholdMs: 760_000, longestFinishedMs: 760_000 }, "quiet past the longest finished sibling, verify:sdk-examples at 12m 40s");
    assert.equal(compat.silenceMs, 16 * MIN + 2_000);
    assert.equal(agent(run, "judge:severity").state, "finishing");
    assert.equal(usageTotal(agent(run, "judge:severity").tokens), 148_000);
    assert.equal(agent(run, "report:release-notes").state, "planned");
    assert.match(agent(run, "report:release-notes").task?.text ?? "", /^Write the breaking-changes section/);
    assert.equal(agent(run, "verify:migration-replay").task?.source, "script");

    assert.equal(vm.tasks.length, 1);
    const task = vm.tasks[0] as AgentVM;
    assert.equal(task.name, "npm run test:e2e -- --grep orders");
    assert.equal(task.state, "working");
    assert.equal(task.taskInfo?.initiator, "user");
    assert.equal(task.taskInfo?.tail, '12 passed · 3 pending · running "pages with a cursor under load"');
    assert.equal(task.runningMs, 83_000);
    assert.equal(task.silenceMs, 4_000);
    assert.equal(seeded.streams.length, 1, "the suite has lines left to print");
    assert.equal(seeded.streams[0]?.lines.length, 6);
  });

  it("stalled: only one agent silent past the threshold, so the line carries the no-update chip alone", () => {
    const run = runOf("stalled");
    assert.deepEqual(run.attention.map((a) => [a.name, a.state]), [["judge:compat", "no-update"]]);
    assert.deepEqual(summaryLine(run).chips, [{ kind: "no-update", count: 1, text: "1 no update" }]);
    assert.equal(summaryLine(run).progress, "Judge · 8 of 10");
    assert.deepEqual(run.runNeeds, []);
    assert.equal(run.counts.failed, 0);
    assert.equal(agent(run, "verify:migration-replay").state, "done");
    assert.equal(agent(run, "verify:migration-replay").attempt, 2);
    assert.equal(agent(run, "judge:compat").quiet?.longestFinishedMs, 760_000);
    assert.equal(viewOf("stalled").vm.tasks.length, 0);
  });

  it("failed: attempt 2 failed with no reason yet; the run's failure text arrives once it ends", () => {
    const run = runOf("failed");
    assert.deepEqual(run.attention.map((a) => [a.name, a.state]), [["verify:migration-replay", "failed"]]);
    assert.deepEqual(summaryLine(run).chips.map((chip) => chip.text), ["1 failed"]);
    assert.equal(run.counts.finishing, 2);
    assert.equal(run.counts.noUpdate, 0);
    const replay = agent(run, "verify:migration-replay");
    assert.equal(replay.attempts.length, 2);
    assert.equal(replay.failure?.text, null);
    assert.equal(run.report, null);
  });

  it("waiting: a request at run level that names no agent, and a task waiting on its own request", () => {
    const { vm, thread } = viewOf("waiting");
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.attention, []);
    assert.deepEqual(summaryLine(run).chips, [{ kind: "needs", count: 1, text: "1 needs you" }]);
    assert.equal(run.runNeeds.length, 1, "the lead's own request stays at run level");
    assert.equal(summaryLine(run).progress, "Judge · 7 of 10");
    assert.equal(thread.approvals.length, 2);
    const task = vm.tasks[0] as AgentVM;
    assert.equal(task.state, "waiting-on-you");
    assert.equal(task.needs?.kind, "approval");
    assert.equal(task.needs?.command, "https://cdn.playwright.dev:443");
    assert.equal(task.taskInfo?.approvalId, null, "the request names the task's item, not the other way round");
  });

  it("partial: the first revision was cut, so one agent has no name, the elapsed time is about, and the notice is due", () => {
    const { vm, thread } = viewOf("partial");
    const run = vm.runs[0] as RunVM;
    assert.equal(thread.truncated, true);
    assert.equal(run.partialHistory, true);
    assert.equal(run.elapsedApprox, true);
    assert.equal(summaryLine(run).elapsed, "about 41m");
    assert.deepEqual(run.agents.filter((a) => a.label === null).map((a) => a.name), ["Agent 1"]);
    // Nothing ties the unnamed agent to the plan's `audit:routes`, so that entry stays planned and the total
    // reads one more than it is: the count the notice says is from loaded history.
    assert.equal(summaryLine(run).progress, "Judge · 6 of 11");
    assert.equal(run.counts.planned, 2);
    assert.equal(run.counts.done, runOf("running").counts.done);
    assert.equal(workflowEvents(thread)[0]?.revision, 2);
  });

  it("reconnect: the run as in running; when the feed is stale every clock freezes and nothing is promoted", () => {
    const { fold, thread } = viewOf("reconnect");
    const live = swarmView(fold, thread.summary, NOW).runs[0] as RunVM;
    assert.equal(live.status, "running");
    assert.deepEqual(live.counts, runOf("running").counts);
    const stale = swarmView(fold, thread.summary, NOW + 10_000, { stale: true, staleAt: NOW + 4_000 }).runs[0] as RunVM;
    assert.equal(stale.stale, true);
    assert.equal(stale.elapsedMs, 41 * MIN + 20_000);
    assert.equal(stale.counts.noUpdate, 0);
    assert.equal(agent(stale, "judge:compat").state, "working");
    assert.deepEqual(summaryLine(stale).chips.map((chip) => chip.kind), ["stale"]);
    assert.match(summaryLine(stale).elapsed, /^41m 20s · at /);
  });

  it("done: everyone landed, one on its third attempt, and the report says so", () => {
    const { vm, fold } = viewOf("done");
    const run = vm.runs[0] as RunVM;
    assert.equal(run.status, "finished");
    assert.equal(run.counts.done, 10);
    assert.equal(run.counts.total, 10);
    assert.equal(run.retried, 1);
    assert.equal(run.elapsedMs, 45 * MIN + 10_000);
    assert.deepEqual(summaryLine(run), { progress: "Done · 10 of 10", chips: [], elapsed: "45m 10s" });
    const replay = agent(run, "verify:migration-replay");
    assert.equal(replay.attempt, 3);
    assert.deepEqual(replay.attempts.map((attempt) => attempt.outcome), ["failed", "failed", "done"]);
    assert.equal(replay.failure, null);
    assert.deepEqual(run.tokens && { reported: run.tokens.reported, of: run.tokens.of }, { reported: 10, of: 10 });
    assert.match(run.report?.summary ?? "", /^## Breaking changes since v1\.9\.0/);
    assert.equal(run.report?.failure, null);
    assert.equal(run.report?.handoffs.length, 1);
    assert.equal(run.waitedOnYouMs, 99_800);
    const completion = completionView(run);
    assert.ok(completion);
    assert.equal(completion.headline, "All ten landed.");
    assert.equal(completion.factLine, "Every phase reached its end · 1 agent needed 3 attempts");
    assert.equal(completion.sheen, true);
    assert.deepEqual(completion.stats.slice(0, 2), [{ value: "10", label: "agents" }, { value: "45m 10s", label: "wall clock" }]);
    assert.deepEqual(completion.highlights.map((highlight) => highlight.text), [
      "Longest agent judge:compat · 18m 36s",
      "Most tokens audit:routes · 288k",
      "Retried verify:migration-replay · landed on attempt 3",
      "Waited on you 1m 40s",
    ]);
    assert.ok(completion.excerpt);
    assert.equal(completion.fingerprint.lanes.length, 10);
    assert.equal(completion.fingerprint.partial, false);
    assert.equal(vm.tasks[0]?.state, "done");
    assert.deepEqual(Object.keys(fold.approvals), []);
  });

  it("big: two thousand agents in eight phases over 120 revisions, with a plan the script does not spell out", () => {
    const { vm, thread } = viewOf("big");
    const run = vm.runs[0] as RunVM;
    assert.equal(workflowEvents(thread).length, 120);
    assert.equal(run.name, "replay-recorded-traffic");
    assert.equal(run.counts.total, 2000);
    assert.equal(run.phases.length, 8);
    assert.ok(run.phases.every((phase) => phase.agents.length === 250), "each phase is past the strip's cell limit, so the card bins it");
    assert.deepEqual(
      { done: run.counts.done, failed: run.counts.failed, working: run.counts.working, scheduled: run.counts.scheduled, planned: run.counts.planned, noUpdate: run.counts.noUpdate },
      { done: 1892, failed: 4, working: 36, scheduled: 68, planned: 0, noUpdate: 0 },
    );
    assert.equal(run.plannedKnown, false);
    assert.equal(summaryLine(run).progress, "1892 done · 36 working · more may start");
    assert.deepEqual(run.slots, { used: 36, max: 36 });
    assert.equal(run.tokens?.reported, 1892);
    assert.equal(run.currentPhase, "Write", "rank's shards all landed in the first waves; write is the live phase");
    assert.deepEqual(run.phases.slice(-2).map((phase) => phase.state), ["done", "live"]);
  });

  it("task: no run, three background tasks printing, silent for four minutes, and failed", () => {
    const { vm, fold, seeded } = viewOf("task");
    assert.deepEqual(vm.runs, []);
    assert.deepEqual(vm.tasks.map((task) => [task.name, task.state]), [
      ["npm run docs:build", "no-update"],
      ["npm run test:e2e -- --grep orders", "working"],
      ["npx openapi-diff openapi/v1.9.0.yaml openapi/v2.yaml", "failed"],
    ]);
    const [docs, e2e, diff] = vm.tasks as [AgentVM, AgentVM, AgentVM];
    assert.equal(docs.taskInfo?.initiator, "timeout");
    assert.equal(docs.silenceMs, 4 * MIN + 10_000);
    assert.equal(docs.taskInfo?.tail, "[info] Resolving 212 declarations");
    assert.equal(e2e.taskInfo?.initiator, "user");
    assert.equal(diff.failure?.text, "openapi-diff exited with status 2");
    assert.ok(diff.durationMs && diff.durationMs > 0);
    assert.equal(sidebarSwarmSummary(fold, null, NOW)?.task, "npm run docs:build");
    assert.equal(seeded.streams.length, 1);
  });

  it("shows a native subagent surfaced as a spawn and wait pair, in the thread that used one", () => {
    const seeded = seed(NOW, "running");
    const thread = seeded.threads.find((candidate) => candidate.summary.sessionId === THREADS.lazyCharts) as SeedThread;
    const view = swarmView(foldFromLoad(loadOf(thread)), thread.summary, NOW);
    assert.deepEqual(view.runs, []);
    assert.equal(view.subagents.length, 1);
    const survey = view.subagents[0] as AgentVM;
    assert.equal(survey.name, "chart-imports-survey");
    assert.equal(survey.kind, "subagent");
    assert.equal(survey.state, "done");
    assert.match(survey.task?.text ?? "", /^Check every other page that imports/);
    assert.ok(survey.durationMs && survey.durationMs > 0);
  });
});

describe("the demo client", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  function clientFor(scenario: Scenario): { client: DemoAncillaClient; run: RunVM; runId: string } {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
    const client = new DemoAncillaClient(scenario);
    const run = runOf(scenario);
    return { client, run, runId: run.runId as string };
  }

  /**
   * Moves the clock on by one research step at a time. A timer set inside a mocked timer's callback lands after the
   * tick that ran it, so one step per tick is what the clock allows, and every step's delay is under this.
   */
  function researchSteps(steps: number) {
    for (let i = 0; i < steps; i += 1) mock.timers.tick(3_100);
  }

  async function reload(client: DemoAncillaClient, now = Date.now()) {
    const load = await client.loadTranscript(THREADS.audit);
    const fold = foldFromLoad(load);
    return { load, fold, vm: swarmView(fold, load.session, now, { partialHistory: load.truncated }) };
  }

  it("retries an agent as a new attempt on the same row, which lands within the minute", async () => {
    const { client, run, runId } = clientFor("running");
    const replay = agent(run, "verify:migration-replay");
    await client.workflow(THREADS.audit, "retry", runId, { childId: replay.id, attempt: 2 });
    let after = agent((await reload(client)).vm.runs[0] as RunVM, "verify:migration-replay");
    assert.equal(after.attempt, 3);
    assert.equal(after.state, "scheduled");
    assert.equal(after.attempts.length, 3);
    mock.timers.tick(2_000);
    after = agent((await reload(client)).vm.runs[0] as RunVM, "verify:migration-replay");
    assert.equal(after.state, "working");
    mock.timers.tick(47_000);
    after = agent((await reload(client)).vm.runs[0] as RunVM, "verify:migration-replay");
    assert.equal(after.state, "done");
    assert.deepEqual(after.attempts.map((attempt) => attempt.outcome), ["failed", "failed", "done"]);
    assert.equal(usageTotal(after.tokens), 118_000);
  });

  it("refuses a control that names an attempt the agent moved past, as Muse does", async () => {
    const { client, run, runId } = clientFor("running");
    const replay = agent(run, "verify:migration-replay");
    await assert.rejects(client.workflow(THREADS.audit, "retry", runId, { childId: replay.id, attempt: 1 }), (error) => errorKind(error) === "stale_attempt");
    await assert.rejects(client.workflow(THREADS.audit, "skip", runId, { childId: replay.id, attempt: 2 }), (error) => errorKind(error) === "stale_attempt");
  });

  it("skips a working agent and stops one background task or all of them", async () => {
    const { client, run, runId } = clientFor("running");
    const compat = agent(run, "judge:compat");
    await client.workflow(THREADS.audit, "skip", runId, { childId: compat.id, attempt: 1 });
    const { vm } = await reload(client);
    assert.equal(agent(vm.runs[0] as RunVM, "judge:compat").state, "skipped");
    const task = vm.tasks[0] as AgentVM;
    await client.task(THREADS.audit, "stop", task.id);
    assert.equal((await reload(client)).vm.tasks[0]?.state, "skipped");
    await assert.rejects(client.task(THREADS.audit, "stop", task.id), /not running/);

    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
    const tasks = new DemoAncillaClient("task");
    await tasks.task(THREADS.audit, "stopAll");
    // Nothing live is left, so the rows fall back to start order: the docs build, the diff, the suite.
    assert.deepEqual((await reload(tasks)).vm.tasks.map((candidate) => candidate.state), ["skipped", "failed", "skipped"]);
  });

  it("lets the run finish from where it stands, with the last failure's text on the terminal revision", async () => {
    const { client } = clientFor("failed");
    client.finishAudit();
    mock.timers.tick(6_000);
    const { vm, fold } = await reload(client);
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(Object.keys(fold.approvals), [], "the turn's end takes its open requests with it");
    assert.equal(run.status, "finished-with-failures");
    assert.equal(run.counts.total, 10);
    assert.equal(agent(run, "report:release-notes").state, "done");
    assert.equal(agent(run, "verify:migration-replay").failure?.text, REPLAY_FAILURE);
    assert.equal(run.report?.failure, REPLAY_FAILURE);
    assert.equal(completionView(run)?.headline, "Nine of ten landed, one failed.");
    const load = await client.loadTranscript(THREADS.audit);
    assert.equal(load.session?.live?.activeTurnId, null);
    assert.equal(load.pending.approvals.length, 0);

    // The scenario with a request open: finishing resolves it, so nothing waits on a turn that ended.
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: NOW });
    const waiting = new DemoAncillaClient("waiting");
    waiting.finishAudit();
    mock.timers.tick(6_000);
    const after = await reload(waiting);
    assert.deepEqual(Object.keys(after.fold.approvals), []);
    assert.equal(after.load.session?.live?.pendingApprovals, 0);
    assert.equal(after.vm.tasks[0]?.state, "working", "the background task outlives the turn and goes on printing");
  });

  it("serves the seeded research runs with the thread, carries the running one to its report, and stops one on request", async () => {
    const { client } = clientFor("running");
    const events: { sessionId: string; runId: string; status: string; phase: string; report: string | null }[] = [];
    client.subscribe((event) => {
      if (event.type === "research-run") events.push({ sessionId: event.sessionId, runId: event.run.runId, status: event.run.status, phase: event.run.phase, report: event.run.report });
    });
    const load = await client.loadTranscript(THREADS.research);
    assert.deepEqual((load.researchRuns ?? []).map((run) => [run.runId, run.status]), [[RESEARCH_RUNS.done, "completed"], [RESEARCH_RUNS.running, "running"]]);
    assert.equal(load.researchRuns?.[0]?.report, null, "the transcript load carries summaries; the report comes from getResearch");
    assert.match((await client.getResearch(RESEARCH_RUNS.done)).report ?? "", /^# What muted text has to meet in dark mode/);
    assert.deepEqual((await client.listResearch(THREADS.research)).map((run) => run.runId), [RESEARCH_RUNS.done, RESEARCH_RUNS.running]);
    // The seeded run only moves once the app has listed its threads, then on its own timers until it has written.
    await client.listSessions();
    await client.whenListed();
    await Promise.resolve();
    researchSteps(40);
    const final = await client.getResearch(RESEARCH_RUNS.running);
    assert.equal(final.status, "completed");
    assert.equal(final.phase, "done");
    assert.ok(final.workers.every((worker) => worker.state !== "working" && worker.state !== "queued"));
    assert.match(final.report ?? "", /## Sources/);
    assert.ok(events.some((event) => event.runId === RESEARCH_RUNS.running && event.phase === "writing"), "the writing phase was broadcast");
    assert.ok(events.every((event) => event.report === null), "the stream never carries the report");
    // A run started from the composer walks the same phases; a second one in the thread is refused; stopping keeps what it has.
    const started = await client.startResearch(THREADS.research, "What is the state of the art?", { maxParallel: 2 }, "cmd-1");
    assert.equal(started.status, "queued");
    assert.equal(started.config.maxParallel, 2);
    assert.equal((await client.startResearch(THREADS.research, "again", null, "cmd-1")).runId, started.runId, "the same commandId returns the same run");
    await assert.rejects(client.startResearch(THREADS.research, "another", null, "cmd-2"), /already has a research run/);
    researchSteps(10);
    const midway = await client.getResearch(started.runId);
    assert.equal(midway.status, "running");
    assert.equal(midway.phase, "researching");
    assert.ok(midway.sources.verified > 0, "workers have read pages by now");
    const stopped = await client.stopResearch(started.runId, true);
    assert.equal(stopped.status, "partial");
    assert.match((await client.getResearch(started.runId)).report ?? "", /stopped after/);
    researchSteps(20);
    assert.equal((await client.getResearch(started.runId)).status, "partial", "a stopped run stays stopped");
    const dropped = await client.startResearch(THREADS.research, "once more", null, "cmd-3");
    researchSteps(1);
    assert.equal((await client.getResearch(dropped.runId)).status, "running");
    assert.equal((await client.stopResearch(dropped.runId, false)).status, "cancelled");
    researchSteps(5);
    assert.equal((await client.getResearch(dropped.runId)).status, "cancelled");
  });

  it("stops the research timers with the rest when disposed", async () => {
    const { client } = clientFor("running");
    const phases: string[] = [];
    client.subscribe((event) => {
      if (event.type === "research-run") phases.push(event.run.phase);
    });
    await client.listSessions();
    await client.whenListed();
    await Promise.resolve();
    researchSteps(3);
    assert.ok(phases.length > 0, "the seeded run was moving");
    const seen = phases.length;
    const before = await client.getResearch(RESEARCH_RUNS.running);
    client.dispose();
    researchSteps(40);
    assert.equal(phases.length, seen, "nothing was broadcast after dispose");
    const after = await client.getResearch(RESEARCH_RUNS.running);
    assert.equal(after.status, before.status);
    assert.equal(after.phase, before.phase);
    assert.deepEqual(after.workers, before.workers, "the run stopped where it was");
  });

  it("keeps one heartbeat revision in history and streams the background task's output", async () => {
    const { client } = clientFor("running");
    const before = workflowEvents((await client.loadTranscript(THREADS.audit)) as unknown as SeedThread).length;
    const tailBefore = (await reload(client)).vm.tasks[0]?.taskInfo?.tail;
    client.subscribe(() => {});
    mock.timers.tick(6_000 * 3 + 1);
    const load = await client.loadTranscript(THREADS.audit);
    assert.equal(workflowEvents(load as unknown as SeedThread).length, before + 1, "three beats, one revision kept");
    const { vm } = await reload(client);
    assert.notEqual(vm.tasks[0]?.taskInfo?.tail, tailBefore, "the suite printed its next line");
    assert.equal(agent(vm.runs[0] as RunVM, "judge:compat").state, "no-update", "a beat changes no agent, so silence keeps counting");
  });
});
