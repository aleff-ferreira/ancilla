import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold, foldFromLoad, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, type AppState, type ThreadState } from "../src/model/store.js";
import {
  activityView,
  announcements,
  attentionOrder,
  completionView,
  costEstimate,
  headline,
  noUpdateThresholdMs,
  numberWord,
  pendingKey,
  phasesOf,
  pulseBins,
  readLaunchPolicy,
  readPlan,
  runCounts,
  sidebarSwarmSummary,
  sigilGrid,
  sinceYouLeft,
  summaryLine,
  swarmBusy,
  swarmView,
  windowTitleCount,
  type AgentVM,
  type RunVM,
} from "../src/model/swarm.js";
import type { MspItem, SessionSummary, TranscriptLoad, ViewEvent, WorkflowChild } from "../src/types.js";

/** The run started at 14:02:00; every time below is minutes and seconds into it, as the design's scenario counts. */
const T0 = Date.UTC(2026, 8, 26, 14, 2, 0);
const S = (m: number, s = 0): number => T0 + (m * 60 + s) * 1000;
const MIN = 60_000;

const SESSION: SessionSummary = {
  sessionId: "s1", cwd: "/work/lantern", title: "Design the offline sync engine", titleSource: "auto", turnCount: 3, modelId: "muse-spark-1.3",
  origin: "ancilla", archived: false, createdAt: "2026-09-26T13:00:00.000Z", activityAt: "2026-09-26T14:40:00.000Z", settled: false, settledAt: null,
  unsettledAt: null, sandboxDisabled: false, accountId: null, live: null,
};

const SCRIPT = `export default async function workflow(host) {
  // Research first, four agents at once.
  const research = await host.parallel([
    { label: "research:field-notes", input: "Read the field notes and list every sync failure the users hit." },
    { label: "research:crdt-survey", input: 'Survey CRDT designs for note text.' },
    { label: "research:prior-art", input: \`Find prior art in offline note apps.\` },
    { label: "research:constraints", input: "List the device constraints." },
  ]);
  const design = await host.parallel([
    { label: "design:crdt-ledger", input: "Design the CRDT ledger." },
    { label: "design:op-log", input: "Design the op log." },
    { label: "design:conflict-ledger", input: "Design the conflict ledger: define how two devices reconcile." },
  ]);
  const judge = await host.parallel([
    { label: "judge:correctness", input: "Judge the two candidate designs for correctness." },
    { label: "judge:perf", input: "Judge the two candidate designs for performance." },
  ]);
  return host.parallel([{ label: "synthesize:report", input: "Write the report." }]);
}`;

const CALL = "call_01a08dd7";
const RUN_ID = `workflow-run-model-tool-${CALL}`;

function launch(script: string | null = SCRIPT, output: unknown = { maxParallelAgents: 16, policy: { childLimit: 16 }, tokenBudget: null }): ViewEvent {
  return {
    method: "item/completed",
    at: S(0, 0),
    params: {
      item: {
        itemId: "launch", kind: "toolCall", status: "completed", revision: 1, turnId: "t1", tool: "workflow", callId: CALL,
        args: JSON.stringify(script === null ? { name: "offline-sync-research-design" } : { name: "offline-sync-research-design", script }),
        visibleOutput: output === null ? undefined : JSON.stringify(output),
      },
    },
  };
}

/** One workflow item revised as it goes, the way Muse sends it: every child every time, labels only when scheduled. */
class Feed {
  private revision = 0;
  private readonly children = new Map<string, WorkflowChild>();
  private readonly fresh = new Set<string>();
  readonly events: ViewEvent[] = [];
  constructor(private readonly extra: Partial<MspItem> = {}) {}

  schedule(childId: string, label: string | null, at: number, attempt = 1): this {
    const key = `${childId}:${attempt}`;
    this.children.set(key, { childId, attempt, status: "scheduled", ...(label ? { label } : {}) });
    this.fresh.add(key);
    return this.emit(at);
  }

  set(childId: string, patch: Partial<WorkflowChild>, at: number, attempt = 1): this {
    const key = `${childId}:${attempt}`;
    const current = this.children.get(key);
    if (!current) throw new Error(`no child ${key}`);
    this.children.set(key, { ...current, ...patch });
    return this.emit(at);
  }

  /** A retry drops the earlier attempt from the item, as Muse does, and schedules the next one. */
  retry(childId: string, attempt: number, at: number, label: string | null = null): this {
    for (const key of [...this.children.keys()]) {
      if (key.startsWith(`${childId}:`)) this.children.delete(key);
    }
    return this.schedule(childId, label, at, attempt);
  }

  emit(at: number, status = "inProgress", extra: Partial<MspItem> = {}): this {
    this.revision += 1;
    const children = [...this.children.values()].map((child) => {
      const key = `${child.childId}:${child.attempt}`;
      const { label, usage, ...rest } = child;
      const shown: WorkflowChild = { ...rest };
      if (label && this.fresh.has(key)) shown.label = label;
      if (usage && this.fresh.has(`${key}:usage`)) shown.usage = usage;
      return shown;
    });
    this.fresh.clear();
    this.events.push({
      method: status === "inProgress" && this.revision === 1 ? "item/started" : status === "inProgress" ? "item/updated" : "item/completed",
      at,
      params: {
        item: {
          itemId: "wf", kind: "workflow", status, revision: this.revision, turnId: "t1", workflowRunId: RUN_ID, entryId: "offline-sync-research-design",
          scriptId: "generated.workflow.offline-sync-research-design", recordedAt: new Date(at).toISOString(), children, ...this.extra, ...extra,
        },
      },
    });
    return this;
  }

  /** Muse sends usage on exactly one revision. */
  usage(childId: string, usage: WorkflowChild["usage"], at: number, attempt = 1): this {
    const key = `${childId}:${attempt}`;
    const current = this.children.get(key);
    if (!current) throw new Error(`no child ${key}`);
    this.children.set(key, { ...current, status: "usage", usage });
    this.fresh.add(`${key}:usage`);
    return this.emit(at);
  }

  finish(childId: string, at: number, durationMs: number, terminal = "completed", attempt = 1): this {
    return this.set(childId, { status: "terminal", terminal, durationMs }, at, attempt);
  }
}

function fold(events: ViewEvent[]): ThreadFold {
  return applyEvents(emptyFold(), events);
}

/** The lantern run up to 41m 16s in: research landed, design landed with one failure, judge under way, synthesize planned. */
function lantern(): Feed {
  const feed = new Feed();
  feed.schedule("c-fn", "research:field-notes", S(0, 4));
  feed.schedule("c-cs", "research:crdt-survey", S(0, 4));
  feed.schedule("c-pa", "research:prior-art", S(0, 5));
  feed.schedule("c-co", "research:constraints", S(0, 5));
  for (const id of ["c-fn", "c-cs", "c-pa", "c-co"]) feed.set(id, { status: "started" }, S(0, 6));
  feed.usage("c-co", { inputTokens: 80_000, outputTokens: 10_000, reasoningTokens: 6_000 }, S(4, 5));
  feed.finish("c-co", S(4, 7), 242_000);
  feed.usage("c-pa", { inputTokens: 90_000, outputTokens: 14_000, reasoningTokens: 8_000 }, S(5, 33));
  feed.finish("c-pa", S(5, 35), 330_000);
  feed.usage("c-cs", { inputTokens: 130_000, outputTokens: 24_000, reasoningTokens: 10_000 }, S(8, 17));
  feed.finish("c-cs", S(8, 19), 495_000);
  feed.usage("c-fn", { inputTokens: 240_000, outputTokens: 30_000, reasoningTokens: 18_000 }, S(12, 2));
  feed.finish("c-fn", S(12, 4), 720_000);
  feed.schedule("c-cl", "design:crdt-ledger", S(12, 10));
  feed.schedule("c-ol", "design:op-log", S(12, 10));
  feed.schedule("c-cf", "design:conflict-ledger", S(12, 10));
  for (const id of ["c-cl", "c-ol", "c-cf"]) feed.set(id, { status: "started" }, S(12, 12));
  feed.finish("c-cf", S(14, 20), 128_000, "failed");
  feed.retry("c-cf", 2, S(14, 21), "design:conflict-ledger");
  feed.set("c-cf", { status: "started" }, S(14, 22), 2);
  feed.usage("c-cf", { inputTokens: 52_100, outputTokens: 6_400, reasoningTokens: 5_700 }, S(18, 12), 2);
  feed.finish("c-cf", S(18, 13), 231_000, "failed", 2);
  feed.usage("c-ol", { inputTokens: 140_000, outputTokens: 20_000, reasoningTokens: 8_000 }, S(21, 22));
  feed.finish("c-ol", S(21, 24), 552_000);
  feed.usage("c-cl", { inputTokens: 200_000, outputTokens: 26_000, reasoningTokens: 10_000 }, S(24, 50));
  feed.finish("c-cl", S(24, 52), 760_000);
  feed.schedule("c-jc", "judge:correctness", S(25, 12));
  feed.schedule("c-jp", "judge:perf", S(25, 12));
  for (const id of ["c-jc", "c-jp"]) feed.set(id, { status: "started" }, S(25, 14));
  feed.usage("c-jc", { inputTokens: 121_000, outputTokens: 17_000, reasoningTokens: 10_000 }, S(40, 23));
  return feed;
}

const NOW = S(41, 16);

/** The thread as it stood at `now`: the launch and every event up to then, viewed then. */
function view(feed: Feed, now = NOW, extra: Parameters<typeof swarmView>[3] = {}, events: ViewEvent[] = []) {
  const f = fold([launch(), ...feed.events, ...events].filter((event) => event.at === undefined || event.at <= now));
  return { fold: f, vm: swarmView(f, SESSION, now, extra) };
}

function agent(run: RunVM, name: string): AgentVM {
  const found = run.agents.find((candidate) => candidate.name === name);
  assert.ok(found, `no agent named ${name}`);
  return found;
}

describe("swarmView on a running workflow", () => {
  it("groups agents into phases by their label prefix, in schedule order, with the plan's unscheduled agents last", () => {
    const { vm } = view(lantern());
    assert.equal(vm.runs.length, 1);
    const run = vm.runs[0] as RunVM;
    assert.equal(run.name, "offline-sync-research-design");
    assert.equal(run.runId, RUN_ID);
    assert.equal(run.status, "running");
    assert.deepEqual(run.phases.map((phase) => [phase.name, phase.agents.map((a) => a.name)]), [
      ["Research", ["research:field-notes", "research:crdt-survey", "research:prior-art", "research:constraints"]],
      ["Design", ["design:crdt-ledger", "design:op-log", "design:conflict-ledger"]],
      ["Judge", ["judge:correctness", "judge:perf"]],
      ["Synthesize", ["synthesize:report"]],
    ]);
    assert.deepEqual(run.phases.map((phase) => phase.state), ["done", "done-with-failures", "live", "planned"]);
    assert.equal(run.plannedKnown, true);
    assert.equal(agent(run, "synthesize:report").state, "planned");
    assert.deepEqual(agent(run, "judge:perf").display, { prefix: "judge:", short: "perf" });
  });

  it("counts add up to the known total and the current phase is the first with a live agent", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.counts, { total: 10, planned: 1, scheduled: 0, working: 0, finishing: 1, noUpdate: 1, waiting: 0, failed: 1, skipped: 0, done: 6, unknown: 0 });
    assert.deepEqual(runCounts(run), run.counts);
    assert.equal(run.currentPhase, "Judge");
    assert.equal(summaryLine(run).progress, "Judge · 6 of 10");
    assert.equal(run.startedAt, S(0, 4), "the first revision seen is the run's start");
    assert.equal(run.elapsedMs, NOW - S(0, 4));
    assert.equal(run.elapsedApprox, false);
    assert.equal(summaryLine(run).elapsed, "41m 12s");
  });

  it("keeps the healthy majority out of the attention list and lists failed before no update", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.attention.map((a) => [a.name, a.state]), [["design:conflict-ledger", "failed"], ["judge:perf", "no-update"]]);
    assert.deepEqual(summaryLine(run).chips, [{ kind: "failed", count: 1, text: "1 failed" }], "one chip is calmer than two: no update stays in the card");
    const early = view(lantern(), S(30, 0));
    assert.deepEqual((early.vm.runs[0] as RunVM).attention.map((a) => a.name), ["design:conflict-ledger"]);
  });

  it("reads the plan, the slots and the task text from the launch tool call", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.slots, { used: 2, max: 16 });
    assert.equal(agent(run, "design:conflict-ledger").task?.text, "Design the conflict ledger: define how two devices reconcile.");
    assert.equal(agent(run, "design:conflict-ledger").task?.source, "script");
    assert.equal(agent(run, "synthesize:report").task?.text, "Write the report.");
    const bare = fold([launch(SCRIPT, null), ...lantern().events]);
    assert.equal((swarmView(bare, SESSION, NOW).runs[0] as RunVM).slots, null, "no launch output, no slots");
  });

  it("bins the run's revisions into ten minutes of pulse, oldest first", () => {
    const { fold: f, vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.equal(run.pulse.length, 10);
    // The last bin is minute 41 (a usage at 40:23 falls in the bin before it); the design finishes sit earlier.
    assert.equal(run.pulse[8], 1, "the usage report at 40m 23s");
    assert.equal(run.pulse[9], 0, "nothing in the current minute");
    // Minutes 16 to 25: the design finishes and their usage reports, then the judge phase's four scheduling revisions.
    assert.deepEqual(pulseBins(f.swarm.runs["wf"], S(25, 30)), [0, 0, 2, 0, 0, 2, 0, 0, 2, 4]);
    assert.deepEqual(pulseBins(undefined, NOW), new Array(10).fill(0));
  });

  it("adds up the tokens Muse reported and estimates the cost at the session model's list price", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.tokens, { total: 1_276_200, reported: 8, of: 9 });
    assert.equal(agent(run, "judge:perf").tokens, null, "not reported yet");
    assert.equal(run.cost?.model, "muse-spark-1.3");
    const expected = costEstimate({ inputTokens: 1_053_100, outputTokens: 147_400, reasoningTokens: 75_700 }, "muse-spark-1.3");
    assert.ok(expected !== null && Math.abs((run.cost?.usd ?? 0) - expected) < 1e-9);
    assert.equal(costEstimate({ inputTokens: 1000 }, "no-such-model"), null);
    assert.equal(costEstimate({ inputTokens: 1000 }, null), null);
  });

  it("carries the per-attempt lifecycle with the times the fold recorded", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    const conflict = agent(run, "design:conflict-ledger");
    assert.equal(conflict.attempt, 2);
    assert.deepEqual(conflict.attempts.map((a) => [a.attempt, a.outcome, a.startedAt, a.endedAt]), [[1, "failed", S(12, 12), S(14, 20)], [2, "failed", S(14, 22), S(18, 13)]]);
    assert.deepEqual((conflict.attempts[1] as AgentVM["attempts"][number]).events.map((e) => e.kind), ["scheduled", "started", "usage", "failed"]);
    assert.equal((conflict.attempts[1] as AgentVM["attempts"][number]).events[3]?.detail, "after 3m 51s");
    assert.equal(conflict.durationMs, 231_000);
    assert.equal(conflict.failure?.text, null, "Muse has not reported a reason yet");
    assert.equal(conflict.failure?.at, S(18, 13));
    const perf = agent(run, "judge:perf");
    assert.equal(perf.startedAt, S(25, 14));
    assert.equal(perf.runningMs, NOW - S(25, 14));
    assert.equal(perf.silenceMs, NOW - S(25, 14));
    assert.equal(perf.shareOfLongest, (NOW - S(25, 14)) / 760_000);
  });

  it("reports the longest finished agent, the agent time, the peak and the retries", () => {
    const { vm } = view(lantern());
    const run = vm.runs[0] as RunVM;
    assert.equal(run.longestFinishedMs, 760_000);
    assert.deepEqual(run.peakConcurrency, { n: 4, phase: "Research" });
    assert.equal(run.retried, 1);
    assert.equal(run.agentTimeMs, 242_000 + 330_000 + 495_000 + 720_000 + 231_000 + 552_000 + 760_000);
    assert.equal(run.report, null, "nothing to report while it runs");
  });
});

describe("the no-update rule", () => {
  it("flags nothing before any agent has finished, and then only past the longest finished sibling", () => {
    const feed = new Feed();
    feed.schedule("a", "research:a", S(0, 0));
    feed.schedule("b", "research:b", S(0, 0));
    feed.schedule("j", "judge:j", S(0, 0));
    for (const id of ["a", "b", "j"]) feed.set(id, { status: "started" }, S(0, 2));
    const running = swarmView(fold([launch(null), ...feed.events]), SESSION, S(30, 0)).runs[0] as RunVM;
    assert.equal(running.longestFinishedMs, null);
    assert.equal(noUpdateThresholdMs(running), null);
    assert.ok(running.agents.every((a) => a.state === "working"), "nothing to compare with, so nothing is remarkable");
    assert.equal(agent(running, "judge:j").silenceMs, S(30, 0) - S(0, 2), "the fact is still there for the inspector");

    feed.finish("a", S(12, 4), 12 * MIN + 4000);
    feed.finish("b", S(12, 30), 3 * MIN);
    const withFinish = (now: number) => swarmView(fold([launch(null), ...feed.events]), SESSION, now).runs[0] as RunVM;
    const threshold = 12 * MIN + 4000;
    assert.equal(noUpdateThresholdMs(withFinish(S(13, 0))), threshold, "the longest finished agent, above the four-minute floor");
    assert.equal(agent(withFinish(S(0, 2) + threshold - 1000), "judge:j").state, "working");
    const quiet = agent(withFinish(S(0, 2) + threshold + 1000), "judge:j");
    assert.equal(quiet.state, "no-update");
    assert.deepEqual(quiet.quiet, { thresholdMs: threshold, longestFinishedMs: threshold });
    assert.equal(summaryLine(withFinish(S(0, 2) + threshold + 1000)).chips[0]?.text, "1 no update");
  });

  it("uses the four-minute floor when every finished sibling was quicker", () => {
    const feed = new Feed();
    feed.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1)).finish("a", S(1, 0), 59_000);
    feed.schedule("b", "b", S(1, 0)).set("b", { status: "started" }, S(1, 1));
    const at = (now: number) => agent(swarmView(fold([launch(null), ...feed.events]), SESSION, now).runs[0] as RunVM, "b");
    assert.equal(noUpdateThresholdMs(swarmView(fold([launch(null), ...feed.events]), SESSION, S(2, 0)).runs[0] as RunVM), 4 * MIN);
    assert.equal(at(S(4, 59)).state, "working");
    assert.equal(at(S(5, 2)).state, "no-update");
  });

  it("keeps a working agent's spinner word while finishing and never marks a queued one", () => {
    const feed = new Feed();
    feed.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1)).finish("a", S(5, 0), 299_000);
    feed.schedule("b", "b", S(5, 0));
    feed.schedule("c", "c", S(5, 0)).set("c", { status: "started" }, S(5, 1)).usage("c", { inputTokens: 10 }, S(5, 2));
    const run = swarmView(fold([launch(null), ...feed.events]), SESSION, S(20, 0)).runs[0] as RunVM;
    assert.equal(agent(run, "b").state, "scheduled");
    assert.equal(agent(run, "c").state, "no-update", "finishing is a sub-state of working, so it can go quiet too");
    assert.equal(agent(run, "c").attempts[0]?.events.at(-1)?.kind, "usage");
  });
});

describe("failed agents and retries", () => {
  it("merges attempts on the durable id, keeps the row in place, and reads the run's failure text at the end", () => {
    const feed = new Feed();
    feed.schedule("x", "design:x", S(0, 0)).set("x", { status: "started" }, S(0, 1)).finish("x", S(2, 0), 119_000, "failed");
    feed.schedule("y", "design:y", S(0, 0)).set("y", { status: "started" }, S(0, 1));
    const failed = swarmView(fold([launch(null), ...feed.events]), SESSION, S(3, 0)).runs[0] as RunVM;
    assert.equal(agent(failed, "design:x").state, "failed");
    assert.equal(agent(failed, "design:x").failure?.text, null);
    assert.deepEqual(failed.agents.map((a) => a.name), ["design:x", "design:y"]);

    feed.retry("x", 2, S(3, 0)).set("x", { status: "started" }, S(3, 1), 2);
    const retried = swarmView(fold([launch(null), ...feed.events]), SESSION, S(4, 0)).runs[0] as RunVM;
    const x = agent(retried, "design:x");
    assert.equal(x.attempt, 2, "the label carried over the retry names the same row");
    assert.equal(x.state, "working");
    assert.deepEqual(retried.agents.map((a) => a.name), ["design:x", "design:y"], "the row stays where it was");
    assert.deepEqual(x.attempts.map((a) => [a.attempt, a.outcome]), [[1, "failed"], [2, null]]);

    feed.finish("x", S(5, 0), 118_000, "failed", 2);
    feed.finish("y", S(6, 0), 359_000);
    feed.emit(S(6, 1), "completed", { message: `<workflow-launch-reconciled>${JSON.stringify({ latest_failure: "x: judge disagreed", agents_activity: [{ agent: "x", tool_calls: 12 }, { agent: "y", duration_ms: 359_000, tool_calls: 40 }], final_summary: { status: "completed", summary: "# Report\n\nOne of two landed." } })}</workflow-launch-reconciled>` });
    const ended = swarmView(fold([launch(null), ...feed.events]), SESSION, S(7, 0)).runs[0] as RunVM;
    assert.equal(ended.status, "finished-with-failures");
    assert.equal(agent(ended, "design:x").failure?.text, "x: judge disagreed");
    assert.equal(agent(ended, "design:x").toolCalls, 12);
    assert.equal(agent(ended, "design:y").toolCalls, 40);
    assert.equal(ended.report?.failure, "x: judge disagreed");
    assert.match(ended.report?.summary ?? "", /One of two landed/);
  });

  it("shows a retry as pending until the next attempt appears, and a skip until the outcome does", () => {
    const feed = new Feed();
    feed.schedule("x", "x", S(0, 0)).set("x", { status: "started" }, S(0, 1)).finish("x", S(2, 0), 119_000, "failed");
    feed.schedule("y", "y", S(0, 0)).set("y", { status: "started" }, S(0, 1));
    const pending = { [pendingKey("s1", "x", 1)]: "retry" as const, [pendingKey("s1", "y", 1)]: "stop" as const };
    const before = swarmView(fold([launch(null), ...feed.events]), SESSION, S(3, 0), { pending }).runs[0] as RunVM;
    assert.equal(agent(before, "x").pending, null, "a retry of a settled attempt is pending only on the row it will create");
    assert.equal(agent(before, "y").pending, "stop");
    feed.retry("x", 2, S(3, 0), "x");
    feed.finish("y", S(3, 1), 180_000, "cancelled");
    const after = swarmView(fold([launch(null), ...feed.events]), SESSION, S(4, 0), { pending, skipped: [pendingKey("s1", "y", 1)] }).runs[0] as RunVM;
    assert.equal(agent(after, "x").pending, null, "attempt 2 is on the wire, so Muse confirmed the retry");
    assert.equal(agent(after, "x").state, "scheduled");
    assert.equal(agent(after, "y").pending, null);
    assert.equal(agent(after, "y").state, "skipped");
    assert.equal(agent(after, "y").skippedBy, "you");
    const live = { [pendingKey("s1", "x", 2)]: "retry" as const };
    assert.equal(agent(swarmView(fold([launch(null), ...feed.events]), SESSION, S(4, 0), { pending: live }).runs[0] as RunVM, "x").pending, "retry");
  });

  it("says who skipped an agent: this client, the stopped run, or Muse", () => {
    const feed = new Feed();
    feed.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1)).finish("a", S(1, 0), 59_000, "cancelled");
    const muse = agent(swarmView(fold([launch(null), ...feed.events]), SESSION, S(2, 0)).runs[0] as RunVM, "a");
    assert.equal(muse.skippedBy, "muse");
    feed.schedule("b", "b", S(1, 0)).set("b", { status: "started" }, S(1, 1)).finish("b", S(2, 0), 59_000, "cancelled");
    feed.emit(S(2, 1), "cancelled");
    const stopped = swarmView(fold([launch(null), ...feed.events]), SESSION, S(3, 0)).runs[0] as RunVM;
    assert.equal(stopped.status, "stopped");
    assert.equal(agent(stopped, "b").skippedBy, "run");
    assert.equal(summaryLine(stopped).progress, "Stopped · 0 of 2 had landed");
  });

  it("marks a child the run ended without an outcome as unknown, never as still working", () => {
    const feed = new Feed();
    feed.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1));
    feed.emit(S(1, 0), "failed", { failureReason: "the launcher died" });
    const run = swarmView(fold([launch(null), ...feed.events]), SESSION, S(2, 0)).runs[0] as RunVM;
    assert.equal(run.status, "failed");
    assert.equal(agent(run, "a").state, "unknown");
    assert.equal(agent(run, "a").attempts[0]?.events.at(-1)?.kind, "unknown");
    assert.deepEqual(summaryLine(run).chips, [{ kind: "run-failed", count: 1, text: "run failed" }]);
    assert.equal(run.report?.failure, "the launcher died");
  });
});

describe("requests during a run", () => {
  const approval = (id: string, at: number, itemId?: string): ViewEvent => ({
    method: "approval/requested", at,
    params: { approvalId: id, sessionId: "s1", itemId, currentRequirementId: null, availableChoices: [], subject: { kind: "shell", command: "npm test -- --run conflict" } },
  });

  it("puts a session approval at run level and names no agent for it", () => {
    const { vm } = view(lantern(), NOW, {}, [approval("ap1", S(39, 36))]);
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.runNeeds, [{ kind: "approval", command: "npm test -- --run conflict", askedAt: S(39, 36), requestId: "ap1", phase: "Judge" }]);
    assert.equal(run.counts.waiting, 0, "no agent is marked waiting without a wire link");
    assert.equal(run.attention.some((a) => a.state === "waiting-on-you"), false);
    assert.deepEqual(summaryLine(run).chips, [{ kind: "needs", count: 1, text: "1 needs you" }, { kind: "failed", count: 1, text: "1 failed" }]);
  });

  it("counts the time the run waited on you from the request to the decision", () => {
    const decided: ViewEvent = { method: "approval/resolved", at: S(41, 16), params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" } };
    const { vm } = view(lantern(), S(42, 0), {}, [approval("ap1", S(39, 36)), decided]);
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.runNeeds, []);
    assert.equal(run.waitedOnYouMs, 100_000);
    const open = (view(lantern(), S(42, 0), {}, [approval("ap1", S(39, 36))]).vm.runs[0] as RunVM);
    assert.equal(open.waitedOnYouMs, S(42, 0) - S(39, 36), "an open request is still waiting");
  });

  it("gives a background task its own approval and leaves it off the run", () => {
    const task: ViewEvent = { method: "item/updated", at: S(30, 0), params: { item: { itemId: "task-1", kind: "toolCall", status: "inProgress", revision: 2, tool: "bash", args: JSON.stringify({ command: "npm run test:e2e" }), background: true, backgroundInitiator: "user", approvalId: "ap2" } } };
    const { vm } = view(lantern(), NOW, {}, [task, approval("ap2", S(31, 0), "task-1")]);
    const run = vm.runs[0] as RunVM;
    assert.deepEqual(run.runNeeds, []);
    assert.equal(vm.tasks.length, 1);
    const [row] = vm.tasks;
    assert.equal(row?.state, "waiting-on-you");
    assert.equal(row?.needs?.command, "npm test -- --run conflict");
    assert.equal(row?.needs?.requestId, "ap2");
    assert.equal(row?.taskInfo?.initiator, "user");
  });
});

describe("background tasks", () => {
  const task = (revision: number, at: number, patch: Partial<MspItem> = {}): ViewEvent => ({
    method: "item/updated", at,
    params: { item: { itemId: "task-e2e", kind: "toolCall", status: "inProgress", revision, tool: "bash", args: JSON.stringify({ command: "npm run test:e2e -- --grep sync" }), background: true, backgroundInitiator: "timeout", ...patch } },
  });
  const output = (at: number, delta: string): ViewEvent => ({ method: "item/delta", at, params: { itemId: "task-e2e", field: "output", delta } });

  it("shows the command, the last output line, the initiator and the running time", () => {
    const f = fold([task(1, S(0, 0)), output(S(0, 30), "12 passed\n"), output(S(1, 0), "3 pending\nrunning \"merges concurrent edits\"\n")]);
    const [row] = swarmView(f, SESSION, S(1, 23)).tasks;
    assert.ok(row);
    assert.equal(row.kind, "task");
    assert.equal(row.name, "npm run test:e2e -- --grep sync");
    assert.equal(row.state, "working");
    assert.equal(row.taskInfo?.tail, 'running "merges concurrent edits"');
    assert.equal(row.taskInfo?.initiator, "timeout");
    assert.equal(row.taskInfo?.lastOutputAt, S(1, 0));
    assert.equal(row.startedAt, S(0, 0));
    assert.equal(row.runningMs, 83_000);
    assert.equal(swarmBusy(f), true);
  });

  it("says no output past four minutes of silence, as a fact about its output", () => {
    const f = fold([task(1, S(0, 0)), output(S(0, 30), "12 passed\n")]);
    assert.equal(swarmView(f, SESSION, S(4, 29)).tasks[0]?.state, "working");
    const quiet = swarmView(f, SESSION, S(4, 41)).tasks[0];
    assert.equal(quiet?.state, "no-update");
    assert.equal(quiet?.silenceMs, 251_000);
    assert.deepEqual(quiet?.quiet, { thresholdMs: 4 * MIN, longestFinishedMs: null });
    assert.equal(swarmView(f, SESSION, S(4, 41), { stale: true, staleAt: S(2, 0) }).tasks[0]?.state, "working", "a stale feed promotes nothing");
  });

  it("ends as done without a failure kind, failed with one, and skipped when cancelled", () => {
    const done = swarmView(fold([task(1, S(0, 0)), task(2, S(4, 51), { status: "completed" })]), SESSION, S(5, 0)).tasks[0];
    assert.equal(done?.state, "done");
    assert.equal(done?.durationMs, 291_000);
    assert.equal(done?.failure, null);
    const failed = swarmView(fold([task(1, S(0, 0)), task(2, S(4, 51), { status: "completed", failureKind: "tool_error" })]), SESSION, S(5, 0)).tasks[0];
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.failure?.text, "tool_error");
    const stopped = swarmView(fold([task(1, S(0, 0)), task(2, S(1, 0), { status: "cancelled" })]), SESSION, S(5, 0), { skipped: [pendingKey("s1", "task-e2e", 1)] }).tasks[0];
    assert.equal(stopped?.state, "skipped");
    assert.equal(stopped?.skippedBy, "you");
    assert.equal(swarmBusy(fold([task(1, S(0, 0)), task(2, S(4, 51), { status: "completed" })])), false);
  });

  it("orders running tasks first and leaves ordinary tool calls out", () => {
    const f = fold([
      task(1, S(0, 0)),
      { method: "item/updated", at: S(0, 10), params: { item: { itemId: "docs", kind: "toolCall", status: "inProgress", revision: 1, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true } } },
      { method: "item/completed", at: S(0, 58), params: { item: { itemId: "docs", kind: "toolCall", status: "completed", revision: 2, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true } } },
      { method: "item/completed", at: S(1, 0), params: { item: { itemId: "ls", kind: "toolCall", status: "completed", revision: 1, tool: "bash", args: JSON.stringify({ command: "ls" }) } } },
    ]);
    assert.deepEqual(swarmView(f, SESSION, S(2, 0)).tasks.map((t) => [t.name, t.state]), [["npm run test:e2e -- --grep sync", "working"], ["npm run docs:build", "done"]]);
  });
});

describe("partial history", () => {
  it("numbers unnamed agents stably, flags the history as partial and reads the scheduling time off the id", () => {
    const id = "01a0dbae-727a-7543-b502-a584a609ad8b";
    const scheduled = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    const later = scheduled + 90_000;
    const events: ViewEvent[] = [
      { method: "item/updated", params: { item: { itemId: "wf", kind: "workflow", status: "inProgress", revision: 22, turnId: "t1", recordedAt: new Date(later).toISOString(), children: [{ childId: id, attempt: 1, status: "started" }, { childId: "plain", attempt: 1, status: "started" }] } } },
      { method: "item/updated", params: { item: { itemId: "wf", kind: "workflow", status: "inProgress", revision: 23, turnId: "t1", recordedAt: new Date(later + 60_000).toISOString(), children: [{ childId: id, attempt: 1, status: "terminal", terminal: "completed", durationMs: 100_000 }, { childId: "plain", attempt: 1, status: "started" }] } } },
    ];
    const numbers = new Map<string, number>();
    const run = swarmView(fold(events), SESSION, later + 120_000, { partialHistory: true, numbers }).runs[0] as RunVM;
    assert.deepEqual(run.agents.map((a) => a.name), ["Agent 1", "Agent 2"]);
    assert.equal(run.partialHistory, true);
    assert.equal(run.elapsedApprox, true, "revision 22 was the first one loaded");
    assert.equal(run.plannedKnown, false);
    assert.equal(summaryLine(run).progress, "1 done · 1 working · more may start");
    assert.equal(summaryLine(run).elapsed, "about 2m", "from the first revision loaded, which is all that is known");
    const numbered = agent(run, "Agent 1");
    assert.equal(numbered.approx, true);
    assert.equal(numbered.attempts[0]?.events[0]?.at, scheduled, "the UUIDv7 time stands in for the scheduling revision");
    assert.equal(numbered.attempts[0]?.events[0]?.detail, "about");
    assert.equal(agent(run, "Agent 2").attempts[0]?.events[0]?.at, null, "a plain id says nothing about when");
    // The same thread numbers the same agents the same way on the next view, whatever it holds by then.
    const again = swarmView(fold(events.slice(1)), SESSION, later + 120_000, { numbers }).runs[0] as RunVM;
    assert.deepEqual(again.agents.map((a) => a.name), ["Agent 1", "Agent 2"]);
  });

  it("falls back to scheduling bursts, then to one group, when labels carry no phase", () => {
    const feed = new Feed();
    feed.schedule("a", "alpha", S(0, 0)).schedule("b", "beta", S(0, 1));
    feed.schedule("c", "gamma", S(5, 0));
    const waves = swarmView(fold(feed.events), SESSION, S(6, 0)).runs[0] as RunVM;
    assert.deepEqual(waves.phases.map((p) => [p.name, p.agents.map((a) => a.name)]), [["Wave 1", ["alpha", "beta"]], ["Wave 2", ["gamma"]]]);
    const single = new Feed();
    single.schedule("a", "alpha", S(0, 0)).schedule("b", "beta", S(0, 1));
    assert.deepEqual((swarmView(fold(single.events), SESSION, S(6, 0)).runs[0] as RunVM).phases.map((p) => p.name), ["Agents"]);
    const mixed = new Feed();
    mixed.schedule("a", "research:alpha", S(0, 0)).schedule("b", "beta", S(5, 0));
    assert.deepEqual((swarmView(fold(mixed.events), SESSION, S(6, 0)).runs[0] as RunVM).phases.map((p) => p.name), ["Research", "Agents"]);
    const own = new Feed();
    own.schedule("a", "alpha", S(0, 0)).set("a", { phase: "Reading" }, S(0, 1));
    assert.deepEqual((swarmView(fold(own.events), SESSION, S(6, 0)).runs[0] as RunVM).phases.map((p) => p.name), ["Reading"], "Muse's own phase word wins");
  });

  it("starts a run without children as starting, with no agents scheduled yet", () => {
    const events: ViewEvent[] = [{ method: "item/started", at: S(0, 0), params: { item: { itemId: "wf", kind: "workflow", status: "inProgress", revision: 1, turnId: "t1", entryId: "tiny native diagnostic", children: [] } } }];
    const run = swarmView(fold([launch(null), ...events]), SESSION, S(0, 4)).runs[0] as RunVM;
    assert.equal(run.status, "starting");
    assert.equal(run.name, "tiny native diagnostic");
    assert.deepEqual(summaryLine(run), { progress: "Starting · no agents scheduled yet", chips: [], elapsed: "4s" });
    assert.equal(run.currentPhase, null);
  });
});

describe("a stale feed", () => {
  it("freezes every clock at the moment the feed went stale and promotes nothing", () => {
    const staleAt = S(41, 0);
    const { vm } = view(lantern(), S(55, 0), { stale: true, staleAt });
    const run = vm.runs[0] as RunVM;
    assert.equal(run.stale, true);
    assert.equal(run.elapsedMs, staleAt - S(0, 4));
    assert.equal(run.clockAt, staleAt);
    assert.equal(agent(run, "judge:perf").state, "working", "no verdict from a feed that may have missed the news");
    assert.equal(agent(run, "judge:perf").runningMs, staleAt - S(25, 14));
    const line = summaryLine(run);
    assert.deepEqual(line.chips, [{ kind: "stale", count: 1, text: "Last known" }]);
    assert.match(line.elapsed, /^40m 56s · at /);
    assert.equal(line.progress, "Judge · 6 of 10");
  });

  it("falls back to the last event it saw when nobody says when the feed went stale", () => {
    const { vm } = view(lantern(), S(55, 0), { stale: true });
    assert.equal((vm.runs[0] as RunVM).clockAt, S(40, 23));
  });
});

describe("usage latch and reconnect", () => {
  it("keeps the tokens Muse sent once, across the revision that drops them and across a reload", () => {
    const feed = new Feed();
    feed.schedule("a", "a", S(0, 0)).set("a", { status: "started" }, S(0, 1));
    feed.usage("a", { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 }, S(3, 0));
    feed.set("a", { status: "completed" }, S(3, 1));
    feed.finish("a", S(3, 2), 181_000);
    const live = fold(feed.events);
    assert.deepEqual(live.swarm.runs["wf"]?.children["a:1"]?.usage, { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 });
    const run = swarmView(live, SESSION, S(4, 0)).runs[0] as RunVM;
    assert.deepEqual(agent(run, "a").tokens, { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 });
    assert.deepEqual(run.tokens, { total: 55_746, reported: 1, of: 1 });
    // A capped page that starts after the usage revision still shows the tokens the live stream latched.
    const load: TranscriptLoad = {
      session: null, msp: null, truncated: true, readOnly: false, readOnlyReason: null, pending: { approvals: [], userInputs: [] },
      events: feed.events.slice(-1).map((event) => ({ method: event.method, params: event.params })),
    };
    const reloaded = foldFromLoad(load, live);
    assert.deepEqual(agent(swarmView(reloaded, SESSION, S(4, 0)).runs[0] as RunVM, "a").tokens, { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 });
    assert.equal((swarmView(reloaded, SESSION, S(4, 0)).runs[0] as RunVM).startedAt, S(0, 0), "the run's start from revision 1 survives the reload");
  });
});

describe("summary line rows", () => {
  it("covers the finished, stopped and plan-unknown rows of the table", () => {
    const feed = lantern();
    feed.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000);
    feed.retry("c-cf", 3, S(41, 52), "design:conflict-ledger").set("c-cf", { status: "started" }, S(41, 53), 3).finish("c-cf", S(44, 4), 132_000, "completed", 3);
    feed.schedule("c-sr", "synthesize:report", S(44, 10)).set("c-sr", { status: "started" }, S(44, 11)).finish("c-sr", S(45, 10), 60_000);
    feed.emit(S(45, 10), "completed", { message: `<workflow-launch-reconciled>${JSON.stringify({ final_summary: { summary: "Recommend the CRDT ledger.\n\nIt resolved every case." }, agents_activity: [] })}</workflow-launch-reconciled>` });
    const done = view(feed, S(50, 0)).vm.runs[0] as RunVM;
    assert.equal(done.status, "finished");
    assert.deepEqual(summaryLine(done), { progress: "Done · 10 of 10", chips: [], elapsed: "45m 06s" });
    assert.equal(done.counts.planned, 0, "once the run is over, the plan's unscheduled agents never existed");
    assert.equal(done.endedAt, S(45, 10));

    const skipped = lantern();
    skipped.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000);
    skipped.emit(S(43, 52), "completed");
    const partial = view(skipped, S(50, 0), { skipped: [pendingKey("s1", "c-cf", 2)] }).vm.runs[0] as RunVM;
    assert.equal(partial.status, "finished-with-failures");
    assert.deepEqual(summaryLine(partial), { progress: "Finished · 8 of 9", chips: [{ kind: "failed", count: 1, text: "1 failed" }], elapsed: "43m 48s" });
  });
});

describe("completion", () => {
  function finished(): RunVM {
    const feed = lantern();
    feed.finish("c-jc", S(42, 34), 1_040_000);
    feed.usage("c-jp", { inputTokens: 80_000, outputTokens: 10_000, reasoningTokens: 6_000 }, S(43, 48)).finish("c-jp", S(43, 50), 1_116_000);
    feed.retry("c-cf", 3, S(41, 52), "design:conflict-ledger").set("c-cf", { status: "started" }, S(41, 53), 3);
    feed.usage("c-cf", { inputTokens: 100_000, outputTokens: 12_000, reasoningTokens: 6_000 }, S(44, 3), 3).finish("c-cf", S(44, 4), 132_000, "completed", 3);
    feed.schedule("c-sr", "synthesize:report", S(44, 10)).set("c-sr", { status: "started" }, S(44, 11));
    feed.usage("c-sr", { inputTokens: 30_000, outputTokens: 8_000, reasoningTokens: 3_000 }, S(45, 9)).finish("c-sr", S(45, 10), 60_000);
    feed.emit(S(45, 10), "completed", { message: `<workflow-launch-reconciled>${JSON.stringify({ final_summary: { summary: "Recommend the CRDT ledger.\n\nIt resolved every case in the conflict corpus.\n\nThe op-log design is simpler." }, agents_activity: [], workspace_handoffs: [{ agent: "design:crdt-ledger", description: "ledger design doc" }] })}</workflow-launch-reconciled>` });
    const approvals: ViewEvent[] = [
      { method: "approval/requested", at: S(39, 36), params: { approvalId: "ap1", sessionId: "s1", currentRequirementId: null, availableChoices: [], subject: { kind: "shell", command: "npm test" } } },
      { method: "approval/resolved", at: S(41, 16), params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" } },
    ];
    return view(feed, S(50, 0), {}, approvals).vm.runs[0] as RunVM;
  }

  it("writes the headline in words, the fact line, the stats and the sheen for a run where everyone landed", () => {
    const run = finished();
    const report = completionView(run);
    assert.ok(report);
    assert.equal(report.headline, "All ten landed.");
    assert.equal(report.factLine, "Every phase reached its end · 1 agent needed 3 attempts");
    assert.deepEqual(report.stats.map((stat) => stat.label), ["agents", "wall clock", "tokens, reported by Muse", "estimate at list price"]);
    assert.equal(report.stats[0]?.value, "10");
    assert.equal(report.stats[1]?.value, "45m 06s");
    assert.equal(report.stats[2]?.value, "1.5M");
    assert.equal(report.sheen, true);
    assert.equal(report.excerpt, "Recommend the CRDT ledger.\nIt resolved every case in the conflict corpus.\nThe op-log design is simpler.");
    assert.deepEqual(run.report?.handoffs, [{ agent: "design:crdt-ledger", description: "ledger design doc" }]);
    assert.equal(completionView(view(lantern()).vm.runs[0] as RunVM), null, "no report while it runs");
  });

  it("chooses at most four highlights by priority, with the asides", () => {
    const report = completionView(finished());
    assert.ok(report);
    assert.deepEqual(report.highlights.map((h) => [h.icon, h.text, h.aside]), [
      ["Timer", "Longest agent judge:perf · 18m 36s", null],
      // The retried agent counts its newest report only, so the run holds 1.47M and not 1.53M.
      ["Database", "Most tokens research:field-notes · 288k", "20% of the run"],
      ["ArrowCounterClockwise", "Retried design:conflict-ledger · landed on attempt 3", "after 2 failed attempts"],
      ["ShieldWarning", "Waited on you 1m 40s", null],
    ]);
    assert.equal(report.highlights[0]?.strong, "judge:perf");
  });

  it("puts what did not land first and drops the lowest priority past four", () => {
    const feed = lantern();
    feed.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000);
    feed.emit(S(43, 52), "completed");
    const run = view(feed, S(50, 0), { skipped: [pendingKey("s1", "c-cf", 2)] }).vm.runs[0] as RunVM;
    const report = completionView(run);
    assert.ok(report);
    assert.equal(report.headline, "Eight of nine landed, one failed.");
    assert.equal(report.factLine, "design:conflict-ledger failed after 2 attempts");
    assert.equal(report.sheen, false);
    assert.deepEqual(report.highlights.map((h) => h.text), [
      "1 agent failed design:conflict-ledger",
      "Longest agent judge:perf · 18m 36s",
      "Most tokens research:field-notes · 288k",
      "Peak concurrency 4 agents",
    ]);
    assert.equal(report.highlights[0]?.aside, "after 2 attempts");
    assert.equal(report.highlights[3]?.aside, "during Research");
  });

  it("spells the headline for every ending", () => {
    const counts = (done: number, total: number, extra: Partial<ReturnType<typeof runCounts>> = {}) => ({ ...runCounts({ phases: [] }), total, done, ...extra });
    assert.equal(headline(counts(10, 10), "finished", 0), "All ten landed.");
    assert.equal(headline(counts(9, 10, { skipped: 1 }), "finished-with-failures", 0), "Nine of ten landed, one skipped.");
    assert.equal(headline(counts(8, 10, { failed: 2 }), "finished-with-failures", 0), "Eight of ten landed, two failed.");
    assert.equal(headline(counts(7, 10, { skipped: 1, failed: 2 }), "finished-with-failures", 0), "Seven of ten landed, one skipped, two failed.");
    assert.equal(headline(counts(4, 10, { unknown: 6 }), "stopped", 12 * MIN + 10_000), "Stopped by you after 12m; four of ten had landed.");
    assert.equal(headline(counts(2, 10, { unknown: 8 }), "failed", 3 * MIN), "The run failed after 3m; two of ten had landed.");
    assert.equal(headline(counts(198, 240, { failed: 4, unknown: 38 }), "finished-with-failures", 0), "198 of 240 landed, four failed, 38 not reported.");
    assert.equal(headline(counts(1, 1), "finished", 0), "The agent landed.");
    assert.equal(numberWord(12), "twelve");
    assert.equal(numberWord(13), "13");
  });

  it("draws the fingerprint with one span per attempt and the phases' bands", () => {
    const report = completionView(finished());
    assert.ok(report);
    const { fingerprint } = report;
    assert.equal(fingerprint.totalMs, S(45, 10) - S(0, 4));
    assert.equal(fingerprint.partial, false);
    assert.deepEqual(fingerprint.phases.map((p) => p.name), ["Research", "Design", "Judge", "Synthesize"]);
    const conflict = fingerprint.lanes.find((lane) => lane.name === "design:conflict-ledger");
    assert.deepEqual(conflict?.spans.map((span) => [span.startMs, span.endMs, span.failed]), [
      [S(12, 12) - S(0, 4), S(14, 20) - S(0, 4), true],
      [S(14, 22) - S(0, 4), S(18, 13) - S(0, 4), true],
      [S(41, 53) - S(0, 4), S(44, 4) - S(0, 4), false],
    ]);
    assert.equal(fingerprint.lanes.length, 10);
  });

  it("recaps what happened since the user left, once they were away five minutes", () => {
    const run = finished();
    assert.equal(sinceYouLeft(run, S(46, 0), S(50, 0)), null, "back within five minutes");
    assert.equal(sinceYouLeft(run, S(46, 0), S(52, 0)), null, "nothing moved after the run ended");
    assert.deepEqual(sinceYouLeft(run, S(29, 0), S(50, 0)), { leftAt: S(29, 0), finished: 4, failed: 0, phasesStarted: ["Synthesize"], runFinishedAt: S(45, 10) });
    const failed = view(lantern(), NOW).vm.runs[0] as RunVM;
    assert.deepEqual(sinceYouLeft(failed, S(13, 0), NOW), { leftAt: S(13, 0), finished: 2, failed: 1, phasesStarted: ["Judge"], runFinishedAt: null });
  });
});

describe("readPlan", () => {
  it("reads the labels and inputs out of the parallel literals without running the script", () => {
    const plan = readPlan(SCRIPT);
    assert.ok(plan);
    assert.equal(plan.labels.length, 10);
    assert.deepEqual(plan.labels.slice(0, 4), ["research:field-notes", "research:crdt-survey", "research:prior-art", "research:constraints"]);
    assert.equal(plan.inputs["research:prior-art"], "Find prior art in offline note apps.");
    assert.equal(plan.inputs["research:crdt-survey"], "Survey CRDT designs for note text.");
    assert.equal(plan.complete, true);
  });

  it("gives nothing for a script without literals and never throws on broken JavaScript", () => {
    assert.equal(readPlan(undefined), null);
    assert.equal(readPlan("export default async function workflow(host) { return host.parallel(agentsFromSomewhere); }"), null);
    assert.equal(readPlan("const label = 'x';"), null, "a label outside a host call is not a plan");
    assert.doesNotThrow(() => readPlan("host.parallel([{ label: \"unterminated, input: `also"));
    assert.doesNotThrow(() => readPlan("host.parallel([{ label: 'a' }, { label: 'b', input: 'x' } /* unclosed comment"));
    const dynamic = readPlan("for (const f of files) host.parallel([{ label: `read:${f}`, input: f }]);");
    assert.equal(dynamic?.complete, false, "a template label means the plan is not knowable here");
    assert.equal(readPlan('host.agent({ label: "one", input: "do it" })')?.labels[0], "one");
  });

  it("reads the launch policy out of the tool's output", () => {
    assert.deepEqual(readLaunchPolicy(JSON.stringify({ maxParallelAgents: 16, policy: { childLimit: 16 }, tokenBudget: null })), { maxParallelAgents: 16, childLimit: 16, tokenBudget: null });
    assert.equal(readLaunchPolicy("not json"), null);
    assert.equal(readLaunchPolicy(undefined), null);
  });

  it("says more may start when the script gives no plan", () => {
    const feed = lantern();
    const run = swarmView(fold([launch(null), ...feed.events]), SESSION, NOW).runs[0] as RunVM;
    assert.equal(run.plannedKnown, false);
    assert.equal(run.counts.total, 9);
    assert.equal(summaryLine(run).progress, "6 done · 2 working · more may start");
  });
});

describe("sigilGrid", () => {
  it("is deterministic, mirrored, and lights nine to fifteen cells", () => {
    for (const name of ["judge:perf", "research:field-notes", "design:conflict-ledger", "Agent 1", "", "x"]) {
      const grid = sigilGrid(name);
      assert.equal(sigilGrid(name), grid, "cached");
      assert.deepEqual(sigilGrid(`${name}`), grid);
      assert.equal(grid.length, 5);
      let lit = 0;
      for (const row of grid) {
        assert.equal(row.length, 5);
        assert.equal(row[0], row[4]);
        assert.equal(row[1], row[3]);
        lit += row.filter(Boolean).length;
      }
      assert.ok(lit >= 9 && lit <= 15, `${name}: ${lit} lit`);
      assert.ok(grid.filter((row) => row.some(Boolean)).length >= 4);
      assert.ok((grid[2] as boolean[]).some(Boolean));
    }
    assert.notDeepEqual(sigilGrid("judge:perf"), sigilGrid("judge:correctness"));
  });
});

describe("announcements", () => {
  it("announces only a request, a failure, a phase end, the run's end and a stale feed", () => {
    const before = view(lantern(), S(13, 0)).vm;
    const after = view(lantern(), S(21, 30)).vm;
    assert.deepEqual(announcements(before, after), ["design:conflict-ledger failed, attempt 2 of 2."]);
    assert.deepEqual(announcements(view(lantern(), S(21, 30)).vm, view(lantern(), S(25, 0)).vm), ["Design phase finished, 2 of 3."]);
    assert.deepEqual(announcements(null, after), [], "nothing on first sight");
    assert.deepEqual(announcements(after, after), []);
    const request: ViewEvent = { method: "approval/requested", at: S(39, 36), params: { approvalId: "ap1", sessionId: "s1", currentRequirementId: null, availableChoices: [], subject: { kind: "shell", command: "npm test" } } };
    assert.deepEqual(announcements(view(lantern(), NOW).vm, view(lantern(), NOW, {}, [request]).vm), ["A request needs you."]);
    assert.deepEqual(announcements(view(lantern(), NOW).vm, view(lantern(), NOW, { stale: true, staleAt: NOW }).vm), ["Connection stale; showing last known state."]);
    const feed = lantern();
    feed.finish("c-jc", S(42, 34), 1_040_000).finish("c-jp", S(43, 50), 1_116_000).emit(S(43, 52), "completed");
    assert.deepEqual(announcements(view(lantern(), S(42, 0)).vm, view(feed, S(44, 0)).vm), ["Judge phase finished, 2 of 2.", "Eight of nine landed, one failed."]);
    const task = (status: string, failureKind?: string): ViewEvent => ({ method: "item/updated", at: S(1, 0), params: { item: { itemId: "docs", kind: "toolCall", status, revision: status === "inProgress" ? 1 : 2, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true, failureKind } } });
    assert.deepEqual(announcements(swarmView(fold([task("inProgress")]), SESSION, S(2, 0)), swarmView(fold([task("inProgress"), task("completed", "tool_error")]), SESSION, S(2, 0))), ["Background task npm run docs:build failed."]);
  });
});

describe("attention and phases helpers", () => {
  it("orders attention rows by class and keeps each class stable", () => {
    const run = view(lantern()).vm.runs[0] as RunVM;
    const perf = agent(run, "judge:perf");
    const conflict = agent(run, "design:conflict-ledger");
    const waiting: AgentVM = { ...perf, id: "w", name: "w", state: "waiting-on-you" };
    assert.deepEqual(attentionOrder([perf, conflict, waiting, agent(run, "judge:correctness")]).map((a) => a.name), ["w", "design:conflict-ledger", "judge:perf"]);
    assert.deepEqual(phasesOf([waiting, perf]).map((p) => [p.name, p.counts.total]), [["Judge", 2]]);
  });
});

describe("sidebar, activity and the window title", () => {
  function state(threads: Record<string, ThreadState>, sessions: Record<string, SessionSummary>, route: AppState["route"] = { kind: "thread", sessionId: "s1" }): AppState {
    const base = initialState(defaultPrefs("2026-09-26T00:00:00.000Z"));
    return { ...base, connection: "open", route, sessions, threads, projects: [{ cwd: "/work/lantern", displayName: "lantern", pinned: true, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd: "/work/lantern", displayName: "lantern" }] }] };
  }
  function thread(f: ThreadFold, extra: Partial<ThreadState> = {}): ThreadState {
    return { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: f, attachments: [], shellRuns: [], researchRuns: [], stalled: false, ...extra };
  }

  it("summarizes the open thread's run for the sidebar row", () => {
    const { fold: f } = view(lantern());
    const summary = sidebarSwarmSummary(f, null, NOW, { sessionId: "s1" });
    assert.ok(summary);
    assert.equal(summary.text, "Judge · 6/10");
    assert.deepEqual(summary.groups.map((g) => g.length), [4, 3, 2, 1]);
    assert.equal(summary.failed, 1);
    assert.equal(summary.noUpdate, 1);
    assert.equal(summary.needs, 0);
    assert.equal(summary.live, true);
    assert.equal(sidebarSwarmSummary(null, null, NOW), null);
    assert.equal(sidebarSwarmSummary(emptyFold(), null, NOW), null);
    const stale = sidebarSwarmSummary(f, null, S(55, 0), { sessionId: "s1", stale: true, staleAt: S(43, 0) });
    assert.equal(stale?.text, "Last known 12m");
    assert.equal(stale?.stale, true);
  });

  it("lists requests everywhere but runs and tasks only where this client folds them, with the v1 note", () => {
    const { fold: f } = view(lantern());
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Migrate auth to passkeys", live: { activeTurnId: "t", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 1, lastTerminal: null, lastError: null } };
    const s = state({ s1: thread(f) }, { s1: SESSION, s2: other });
    const activity = activityView(s, NOW);
    assert.deepEqual(activity.needsYou.map((item) => [item.thread, item.text, item.stale]), [["Migrate auth to passkeys", "1 request waiting", true]]);
    assert.deepEqual(activity.working.map((item) => [item.kind, item.text, item.sub]), [["run", "offline-sync-research-design", "Judge · 6 of 10"]]);
    assert.deepEqual(activity.stopAll, { runs: 1, tasks: 0 });
    assert.equal(activity.note, "Other threads appear here once Ancilla tracks them (coming in 1.1)");
    assert.equal(activity.foot, "1 running in 1 thread · 1.3M tokens today");
    assert.equal(windowTitleCount(s), 1);
    const quiet = activityView(state({}, {}), NOW);
    assert.equal(quiet.empty, true);
    assert.equal(quiet.foot, "Nothing runs and nothing waits for you.");
    assert.equal(quiet.note, null);
    assert.equal(windowTitleCount(quiet.empty ? state({}, {}) : s), 0);
  });

  it("counts the fold's requests for a live thread and the server's for the rest", () => {
    const request: ViewEvent = { method: "approval/requested", at: S(1, 0), params: { approvalId: "ap1", sessionId: "s1", currentRequirementId: null, availableChoices: [], subject: { kind: "shell", command: "rm -rf dist" } } };
    const f = fold([request]);
    const live = { ...SESSION, live: { activeTurnId: null, turnStartedAt: null, pendingApprovals: 3, pendingInputs: 0, lastTerminal: null, lastError: null } };
    assert.equal(windowTitleCount(state({ s1: thread(f) }, { s1: live })), 1, "the fold knows better than a stale count");
    assert.equal(windowTitleCount(state({ s1: thread(f, { stale: true }) }, { s1: live })), 3, "a stale fold defers to the server");
    const activity = activityView(state({ s1: thread(f) }, { s1: live }), NOW);
    assert.deepEqual(activity.needsYou.map((item) => [item.text, item.sub]), [["Run a shell command", "rm -rf dist"]]);
  });
});
