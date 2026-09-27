import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyFold } from "../src/model/fold.js";
import {
  activityView,
  completionView,
  researchAgentId,
  researchCounters,
  researchItemId,
  researchRunIdOf,
  runLive,
  sidebarSwarmSummary,
  summaryLine,
  swarmBusy,
  swarmView,
  type AgentVM,
  type RunStatus,
  type RunVM,
  type SwarmOptions,
} from "../src/model/swarm.js";
import type { ResearchRunView, ResearchStatus } from "../src/types.js";
import { RESEARCH_NOW as NOW, fakeResearchWorker, iso, rs, runningResearch } from "./fixtures/research.js";
import { appState, session, thread } from "./swarm-fixtures.js";

/**
 * A thread's DeepResearch runs through the Swarm model: the daemon sends each run whole, and the view reads the
 * rounds as phases, the workers as agents and the run's own usage as the tokens.
 */

const SESSION = session("s1", "Muted text in dark mode", { modelId: "muse-spark-1.3" });

function viewOf(runs: ResearchRunView[], now = NOW, opts: SwarmOptions = {}) {
  return swarmView(emptyFold(), SESSION, now, { researchRuns: runs, ...opts });
}

function runOf(run: ResearchRunView, now = NOW): RunVM {
  const view = viewOf([run], now);
  assert.equal(view.runs.length, 1, "one run per research run");
  return view.runs[0] as RunVM;
}

function agent(run: RunVM, id: string): AgentVM {
  const found = run.agents.find((candidate) => candidate.id === id);
  assert.ok(found, `no agent ${id}`);
  return found;
}

const A1 = "research:run-1:A1";
const A2 = "research:run-1:A2";
const A3 = "research:run-1:A3";

describe("swarmView with a research run", () => {
  it("makes one run per research run, a phase per round and an agent per worker", () => {
    const run = runOf(runningResearch());
    assert.equal(run.itemId, "research:run-1");
    assert.equal(run.runId, "run-1");
    assert.equal(run.kind, "research");
    assert.equal(run.status, "running");
    assert.equal(run.name.length, 72, "the question, cut to a line");
    assert.ok(run.name.endsWith("…"));
    assert.deepEqual(run.phases.map((phase) => [phase.name, phase.state, phase.agents.map((candidate) => candidate.id)]), [
      ["Round 1 of 12", "done-with-failures", [A1, A2]],
      ["Round 2 of 12", "live", [A3]],
    ]);
    assert.equal(run.currentPhase, "Round 2 of 12");
    assert.deepEqual(run.counts, { total: 3, planned: 0, scheduled: 0, working: 1, finishing: 0, noUpdate: 0, waiting: 0, failed: 1, skipped: 0, done: 1, unknown: 0 });
    assert.equal(run.plannedKnown, false, "the daemon plans rounds as it goes");
    assert.equal(run.startedAt, rs(0, 1));
    assert.equal(run.endedAt, null);
    assert.equal(run.elapsedMs, NOW - rs(0, 1));
    assert.equal(run.elapsedApprox, false);
    assert.equal(run.research?.round, 2);
    assert.equal(run.research?.deadlineAt, rs(10, 1));
    assert.deepEqual(run.runNeeds, [], "nothing about a research run waits on you");
    assert.equal(run.report, null);
    assert.deepEqual(run.attention.map((candidate) => candidate.id), [A2], "the failed worker is listed for attention");
    assert.equal(run.longestFinishedMs, 110_000);
    assert.equal(run.agentTimeMs, 150_000, "the done and the failed worker's durations");
    assert.deepEqual(run.peakConcurrency, { n: 2, phase: "Round 1 of 12" });
    assert.ok(run.pulse.some((bin) => bin > 0), "the workers' starts and ends are the pulse");
  });

  it("carries each worker's counters, topic and times as an agent, with no update rule and no pending flag", () => {
    const run = runOf(runningResearch());
    const done = agent(run, A1);
    assert.equal(done.kind, "research");
    assert.equal(done.name, "A1 · Radix Colors dark scales");
    assert.deepEqual(done.display, { prefix: null, short: done.name }, "a topic's colon never splits the name");
    assert.equal(done.state, "done");
    assert.equal(done.startedAt, rs(0, 20));
    assert.equal(done.endedAt, rs(2, 10));
    assert.equal(done.durationMs, 110_000);
    assert.equal(done.runningMs, null);
    assert.equal(done.toolCalls, 6);
    assert.equal(done.tokens, null, "workers report no tokens of their own");
    assert.deepEqual(done.research, { agentId: 1, round: 1, searches: 2, reads: 3, saved: 1, discovery: false, model: "muse-spark-1.3", wireState: "completed" });
    assert.deepEqual(done.task, { text: "Radix Colors dark scales", source: "objective" });
    assert.equal(done.shareOfLongest, 1);
    assert.equal(done.runItemId, "research:run-1");
    assert.deepEqual(done.attempts.map((attempt) => attempt.events.map((event) => event.kind)), [["scheduled", "started", "completed"]]);
    assert.equal(done.attempts[0]?.outcome, "done");

    const failed = agent(run, A2);
    assert.equal(failed.state, "failed");
    assert.deepEqual(failed.failure, { text: null, at: rs(1, 0) }, "the daemon reports no reason for a plain failure");
    assert.equal(failed.durationMs, 40_000);

    const working = agent(run, A3);
    assert.equal(working.state, "working");
    assert.equal(working.endedAt, null);
    assert.equal(working.runningMs, 180_000);
    assert.equal(working.quiet, null, "no update is never inferred for a worker");
    assert.equal(working.pending, null);
    assert.equal(working.shareOfLongest, 180_000 / 110_000);
    assert.deepEqual(working.attempts.map((attempt) => attempt.events.map((event) => event.kind)), [["scheduled", "started"]]);

    assert.equal(researchCounters(done.research as NonNullable<AgentVM["research"]>), "2 searches · 3 reads · 1 saved");
    assert.equal(researchCounters({ searches: 1, reads: 1, saved: 0 }), "1 search · 1 read");
    assert.equal(researchCounters({ searches: 0, reads: 0, saved: 0 }), "no calls yet");
  });

  it("takes the tokens from the run's usage, prices them at the worker model's list price, and sums the run up", () => {
    const run = runOf(runningResearch());
    assert.deepEqual(run.tokens, { total: 91_420, reported: 0, of: 3 });
    assert.equal(run.cost?.model, "muse-spark-1.3");
    assert.ok((run.cost?.usd ?? 0) > 0);
    assert.deepEqual(run.slots, { used: 1, max: 3 });
    const base = runningResearch();
    const unpriced = runOf(runningResearch({ config: { ...base.config, models: { supervisor: null, worker: null, writer: null } } }));
    assert.equal(unpriced.cost, null, "no model named in the config, no estimate");
    assert.equal(unpriced.tokens?.total, 91_420);
    assert.equal(runOf(runningResearch({ usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 } })).tokens, null);
    assert.deepEqual(summaryLine(run), {
      progress: "Researching, round 2 of 12 · 1 done · 1 working",
      chips: [{ kind: "failed", count: 1, text: "1 failed" }],
      elapsed: "5m 59s",
    });
  });

  it("maps a queued worker to scheduled, a timed-out one to failed with the reason, and a cancelled one to skipped by the run", () => {
    const run = runOf(runningResearch({
      workers: [
        fakeResearchWorker({ agentId: 1, round: 1, topic: "queued", state: "queued", startedAt: iso(rs(0, 20)) }),
        fakeResearchWorker({ agentId: 2, round: 1, topic: "slow", state: "timed_out", searches: 3, startedAt: iso(rs(0, 20)), endedAt: iso(rs(5, 20)) }),
        fakeResearchWorker({ agentId: 3, round: 1, topic: "cut", state: "cancelled", startedAt: iso(rs(0, 20)), endedAt: iso(rs(1, 20)) }),
      ],
    }));
    const queued = agent(run, A1);
    assert.equal(queued.state, "scheduled");
    assert.equal(queued.startedAt, null, "a queued worker has not started, whatever the row carries");
    assert.deepEqual(queued.attempts.map((attempt) => attempt.events.map((event) => event.kind)), [["scheduled"]]);
    const timedOut = agent(run, A2);
    assert.equal(timedOut.state, "failed");
    assert.deepEqual(timedOut.failure, { text: "Timed out after 10 minutes", at: rs(5, 20) });
    assert.equal(timedOut.research?.wireState, "timed_out");
    assert.equal(timedOut.attempts[0]?.events.at(-1)?.detail, "timed out");
    const cancelled = agent(run, A3);
    assert.equal(cancelled.state, "skipped");
    assert.equal(cancelled.skippedBy, "run");
    assert.deepEqual(run.counts, { total: 3, planned: 0, scheduled: 1, working: 0, finishing: 0, noUpdate: 0, waiting: 0, failed: 1, skipped: 1, done: 0, unknown: 0 });
    assert.equal(run.longestFinishedMs, null, "nothing landed, so there is nothing to compare with");
  });

  it("maps every ending the daemon reports onto a run status", () => {
    const cases: [ResearchStatus, RunStatus][] = [
      ["queued", "starting"],
      ["running", "running"],
      ["completed", "finished"],
      ["partial", "finished-with-failures"],
      ["failed", "failed"],
      ["cancelled", "stopped"],
      ["interrupted", "stopped"],
    ];
    for (const [status, expected] of cases) {
      const live = status === "queued" || status === "running";
      const run = runOf(runningResearch({ status, phase: live ? "researching" : "done", endedAt: live ? null : iso(rs(5, 0)) }));
      assert.equal(run.status, expected, status);
      assert.equal(runLive(run), live, status);
      assert.equal(run.endedAt, live ? null : rs(5, 0), status);
      assert.equal(run.report === null, live, `${status} carries a report once ended`);
    }
    const scoping = runOf(runningResearch({ status: "running", phase: "scoping", round: 0, workers: [] }));
    assert.equal(scoping.status, "starting", "no worker out yet");
    assert.equal(summaryLine(scoping).progress, "Starting · no agents scheduled yet");
    const queued = runOf(runningResearch({ status: "queued", phase: "scoping", startedAt: null, workers: [] }));
    assert.equal(queued.startedAt, rs(0, 0), "a queued run counts from when it was asked for");
    const ended = runOf(runningResearch({ status: "completed", phase: "done", endedAt: iso(rs(5, 0)) }));
    assert.equal(ended.elapsedMs, rs(5, 0) - rs(0, 1));
    assert.equal(ended.research?.deadlineAt, null);
  });

  it("writes the completion report for a partial run with the failure and the sources, and a sheen only when everyone landed", () => {
    const base = runningResearch();
    const partial = runningResearch({
      status: "partial",
      phase: "done",
      endedAt: iso(rs(5, 0)),
      failure: "The window closed before round 3",
      reportAvailable: true,
      workers: [
        base.workers[0] as ResearchRunView["workers"][number],
        base.workers[1] as ResearchRunView["workers"][number],
        fakeResearchWorker({ agentId: 3, round: 2, topic: "Material 3 tonal palettes", state: "cancelled", searches: 2, reads: 1, startedAt: iso(rs(3, 0)), endedAt: iso(rs(5, 0)) }),
      ],
    });
    const run = runOf(partial);
    assert.equal(run.status, "finished-with-failures");
    assert.deepEqual(run.report, { summary: "9 sources · 7 verified\nThe report is in the transcript.", failure: "The window closed before round 3", handoffs: [] });
    const completion = completionView(run);
    assert.ok(completion);
    assert.equal(completion.headline, "One of three landed, one skipped, one failed.");
    assert.match(completion.factLine, /^The window closed before round 3 · A3 · Material 3 tonal palettes was stopped with the run · A2 · Primer's functional colour roles failed after 1 attempt$/);
    assert.equal(completion.excerpt, "9 sources · 7 verified\nThe report is in the transcript.");
    assert.equal(completion.sheen, false);
    assert.deepEqual(completion.stats.map((stat) => stat.label), ["agents", "wall clock", "tokens, the run's own count", "estimate at list price"]);
    assert.equal(completion.fingerprint.lanes.length, 3);
    assert.equal(completion.fingerprint.partial, false);

    const done = runOf(runningResearch({
      status: "completed",
      phase: "done",
      endedAt: iso(rs(5, 0)),
      reportAvailable: true,
      workers: [base.workers[0] as ResearchRunView["workers"][number], fakeResearchWorker({ agentId: 2, round: 1, topic: "Primer", state: "completed", startedAt: iso(rs(0, 20)), endedAt: iso(rs(1, 0)) })],
    }));
    const landed = completionView(done);
    assert.equal(landed?.headline, "All two landed.");
    assert.equal(landed?.factLine, "Every round reached its end");
    assert.equal(landed?.sheen, true);

    const dropped = runOf(runningResearch({ status: "cancelled", phase: "done", endedAt: iso(rs(5, 0)), reportAvailable: false, sources: { registry: 0, verified: 0, curated: 0 } }));
    assert.equal(dropped.report?.summary, "No sources were saved\nNo report was written.");
    assert.match(completionView(dropped)?.headline ?? "", /^Stopped by you after 5m; one of three had landed\.$/);
  });

  it("says the thread is busy while a run is out, and lists it in the sidebar row and the Activity drawer", () => {
    assert.equal(swarmBusy(emptyFold(), [runningResearch()]), true);
    assert.equal(swarmBusy(emptyFold(), [runningResearch({ status: "completed" })]), false);
    assert.equal(swarmBusy(emptyFold()), false);

    const summary = sidebarSwarmSummary(emptyFold(), null, NOW, { sessionId: "s1", researchRuns: [runningResearch()] });
    assert.ok(summary);
    assert.deepEqual(summary.groups, [["done", "failed"], ["working"]]);
    assert.equal(summary.text, "1 done · 1 working");
    assert.equal(summary.failed, 1);
    assert.equal(summary.live, true);
    assert.equal(sidebarSwarmSummary(emptyFold(), null, NOW, { sessionId: "s1", researchRuns: [] }), null);

    const earlier = runningResearch({ runId: "run-0", status: "completed", phase: "done", createdAt: iso(rs(-40, 0)), startedAt: iso(rs(-40, 0)), endedAt: iso(rs(-20, 0)) });
    const state = appState({
      route: { kind: "thread", sessionId: "s1" },
      sessions: { s1: SESSION },
      threads: { s1: thread(emptyFold(), { researchRuns: [earlier, runningResearch()] }) },
    });
    const activity = activityView(state, NOW);
    assert.deepEqual(activity.working.map((item) => [item.kind, item.itemId, item.text.length, item.sub, item.state]), [
      ["run", "research:run-1", 72, "Researching, round 2 of 12 · 1 done · 1 working", "failed"],
    ]);
    assert.deepEqual(activity.finishedToday.map((item) => [item.kind, item.itemId, item.state, item.endedAt]), [["run", "research:run-0", "done", rs(-20, 0)]]);
    assert.deepEqual(activity.stopAll, { runs: 1, tasks: 0 }, "Stop everything reaches the live research run");
    assert.match(activity.foot, /^1 running in 1 thread · [\d.]+k tokens today$/);
    assert.equal(activity.note, null);
  });

  it("freezes a research run's clocks when the feed is stale", () => {
    const view = viewOf([runningResearch()], NOW + 60_000, { stale: true, staleAt: NOW });
    const run = view.runs[0] as RunVM;
    assert.equal(run.stale, true);
    assert.equal(run.staleAt, NOW);
    assert.equal(run.clockAt, NOW);
    assert.equal(run.elapsedMs, NOW - rs(0, 1));
    assert.equal(agent(run, A3).runningMs, 180_000);
    assert.deepEqual(summaryLine(run).chips, [{ kind: "stale", count: 1, text: "Last known" }]);
  });

  it("sits beside a thread's workflow runs, and keeps a worker's row identity across recomputes", () => {
    const first = runOf(runningResearch());
    const second = runOf(runningResearch());
    assert.equal(agent(first, A1), agent(second, A1), "an unchanged worker keeps its object");
    assert.equal(agent(first, A3), agent(second, A3), "at the same clock, so does a working one");
    const later = runOf(runningResearch(), NOW + 15_000);
    assert.notEqual(agent(first, A3), agent(later, A3), "its running time moved");
    assert.equal(agent(first, A1), agent(later, A1));
    const moved = runOf(runningResearch({ workers: runningResearch().workers.map((worker) => (worker.agentId === 3 ? { ...worker, searches: 3 } : worker)) }));
    assert.equal(agent(moved, A3).research?.searches, 3, "a counter that moved is read off the new row");
  });

  it("names research items by prefix so the controls can tell them from workflow items", () => {
    assert.equal(researchItemId("run-1"), "research:run-1");
    assert.equal(researchRunIdOf("research:run-1"), "run-1");
    assert.equal(researchRunIdOf("wf"), null);
    assert.equal(researchAgentId("run-1", 3), "research:run-1:A3");
  });
});
