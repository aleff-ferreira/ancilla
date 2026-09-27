// The design's fictional run, "offline-sync-research-design" in project lantern, as the model test builds it:
// a workflow item revised the way Muse sends it, so component tests render the view-models the app would.
import { applyEvents, emptyFold, type ThreadFold } from "../../src/model/fold.js";
import { attentionOrder, phasesOf, runCounts, crewView, type AgentState, type AgentVM, type RunVM, type CrewOptions, type CrewVM } from "../../src/model/crew.js";
import type { MspItem, SessionSummary, ViewEvent, WorkflowChild } from "../../src/types.js";

/** The run started at 14:02:00; every time below is minutes and seconds into it. */
export const T0 = Date.UTC(2026, 8, 26, 14, 2, 0);
export const S = (m: number, s = 0): number => T0 + (m * 60 + s) * 1000;
export const MIN = 60_000;
export const NOW = S(41, 16);

export const SESSION: SessionSummary = {
  sessionId: "s1", cwd: "/work/lantern", title: "Design the offline sync engine", titleSource: "auto", turnCount: 3, modelId: "muse-spark-1.3",
  origin: "ancilla", archived: false, createdAt: "2026-09-26T13:00:00.000Z", activityAt: "2026-09-26T14:40:00.000Z", settled: false, settledAt: null,
  unsettledAt: null, sandboxDisabled: false, accountId: null, live: null,
};

export const SCRIPT = `export default async function workflow(host) {
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

export const CALL = "call_01a08dd7";
export const RUN_ID = `workflow-run-model-tool-${CALL}`;

export function launch(script: string | null = SCRIPT, output: unknown = { maxParallelAgents: 16, policy: { childLimit: 16 }, tokenBudget: null }): ViewEvent {
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
export class Feed {
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

export function fold(events: ViewEvent[]): ThreadFold {
  return applyEvents(emptyFold(), events);
}

/** The lantern run up to 41m 16s in: research landed, design landed with one failure, judge under way, synthesize planned. */
export function lantern(): Feed {
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

/** The approval Muse raised during Judge, and its answer two minutes later. */
export const APPROVAL: ViewEvent = {
  method: "approval/requested",
  at: S(39, 36),
  params: { approvalId: "ap1", sessionId: "s1", currentRequirementId: null, availableChoices: [{ choiceId: "allow", label: "Allow once", decision: "approved" }], subject: { kind: "shell", command: "npm test -- --run conflict" } },
};
export const APPROVED: ViewEvent = { method: "approval/resolved", at: S(41, 16), params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" } };

/** The thread as it stood at `now`: the launch and every event up to then, viewed then. */
export function view(feed: Feed, now = NOW, extra: CrewOptions = {}, events: ViewEvent[] = []): { fold: ThreadFold; vm: CrewVM } {
  const f = fold([launch(), ...feed.events, ...events].filter((event) => event.at === undefined || event.at <= now));
  return { fold: f, vm: crewView(f, SESSION, now, extra) };
}

/** The run finished at 45m 10s: everyone landed, conflict-ledger on attempt 3 after the user's retry. */
export function finishedFeed(): Feed {
  const feed = lantern();
  feed.finish("c-jc", S(42, 34), 1_040_000);
  feed.usage("c-jp", { inputTokens: 80_000, outputTokens: 10_000, reasoningTokens: 6_000 }, S(43, 48)).finish("c-jp", S(43, 50), 1_116_000);
  feed.retry("c-cf", 3, S(41, 52), "design:conflict-ledger").set("c-cf", { status: "started" }, S(41, 53), 3);
  feed.usage("c-cf", { inputTokens: 100_000, outputTokens: 12_000, reasoningTokens: 6_000 }, S(44, 3), 3).finish("c-cf", S(44, 4), 132_000, "completed", 3);
  feed.schedule("c-sr", "synthesize:report", S(44, 10)).set("c-sr", { status: "started" }, S(44, 11));
  feed.usage("c-sr", { inputTokens: 30_000, outputTokens: 8_000, reasoningTokens: 3_000 }, S(45, 9)).finish("c-sr", S(45, 10), 60_000);
  feed.emit(S(45, 10), "completed", { message: `<workflow-launch-reconciled>${JSON.stringify({ final_summary: { summary: "Recommend the **CRDT ledger** (design:crdt-ledger).\n\nIt resolved every case in the conflict corpus.\n\nThe op-log design is simpler." }, agents_activity: [], workspace_handoffs: [{ agent: "design:crdt-ledger", description: "ledger design doc" }] })}</workflow-launch-reconciled>` });
  return feed;
}

export function finishedRun(now = S(50, 0)): RunVM {
  return view(finishedFeed(), now, {}, [APPROVAL, APPROVED]).vm.runs[0] as RunVM;
}

export function runningRun(extra: CrewOptions = {}, events: ViewEvent[] = []): RunVM {
  return view(lantern(), NOW, extra, events).vm.runs[0] as RunVM;
}

export function agentNamed(run: RunVM, name: string): AgentVM {
  const found = run.agents.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no agent named ${name}`);
  return found;
}

// ---------------------------------------------------------------- reading markup

/**
 * Markup with the rolling digits folded back into their number and an agent's prefix rejoined to its name, so a
 * regex over it reads the words a person would.
 */
export function flatten(markup: string): string {
  return markup
    .replace(/<span class="inline-flex tabular-nums" aria-label="([^"]*)">(?:<span aria-hidden="true" class="whitespace-pre">[^<]*<\/span>)*<\/span>/g, "$1")
    .replace(/<span class="pre">([^<]*)<\/span>/g, "$1")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The markup as words, one space between elements and none before punctuation. */
export function textOf(markup: string): string {
  return flatten(markup)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

// ---------------------------------------------------------------- hand-built view-models

const LIVE: ReadonlySet<AgentState> = new Set(["scheduled", "working", "finishing", "no-update", "waiting-on-you"]);

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** An agent as the model would shape it, with only what a test cares about filled in. */
export function mkAgent(name: string, state: AgentState, extra: Partial<AgentVM> = {}): AgentVM {
  const colon = name.indexOf(":");
  return {
    id: name,
    attempt: 1,
    name,
    label: name,
    display: colon > 0 ? { prefix: name.slice(0, colon + 1), short: name.slice(colon + 1) } : { prefix: null, short: name },
    phase: colon > 0 ? capitalize(name.slice(0, colon)) : "Agents",
    kind: "workflow",
    state,
    pending: null,
    skippedBy: state === "skipped" ? "muse" : null,
    startedAt: null,
    endedAt: null,
    lastEventAt: null,
    silenceMs: null,
    runningMs: null,
    durationMs: null,
    approx: false,
    tokens: null,
    toolCalls: null,
    attempts: [],
    failure: null,
    task: null,
    shareOfLongest: null,
    quiet: null,
    needs: null,
    runItemId: "wf",
    workflowRunId: RUN_ID,
    ...extra,
  };
}

/** A background task row. */
export function mkTask(command: string, state: AgentState, extra: Partial<AgentVM> = {}, info: Partial<NonNullable<AgentVM["taskInfo"]>> = {}): AgentVM {
  const live = LIVE.has(state);
  return {
    ...mkAgent(command, state, { id: `task:${command}`, kind: "task", phase: "Background", display: { prefix: null, short: command }, runItemId: null, workflowRunId: null }),
    startedAt: S(39, 53),
    runningMs: live ? 83_000 : null,
    durationMs: live ? null : 291_000,
    endedAt: live ? null : S(44, 44),
    lastEventAt: S(41, 10),
    taskInfo: { command, tail: "12 passed · 3 pending · running \"merges concurrent edits\"", lastOutputAt: S(41, 10), initiator: "user", approvalId: null, ...info },
    ...extra,
  };
}

/** The reference run's ten agents at 41m 16s, as states: research landed, one design failed, judge under way, synthesize planned. */
export function referenceAgents(): AgentVM[] {
  return [
    mkAgent("research:field-notes", "done", { durationMs: 720_000, tokens: { inputTokens: 240_000, outputTokens: 30_000, reasoningTokens: 18_000 }, startedAt: S(0, 6), endedAt: S(12, 4), shareOfLongest: 0.95 }),
    mkAgent("research:crdt-survey", "done", { durationMs: 495_000, startedAt: S(0, 6), endedAt: S(8, 19), shareOfLongest: 0.65 }),
    mkAgent("research:prior-art", "done", { durationMs: 330_000, startedAt: S(0, 6), endedAt: S(5, 35), shareOfLongest: 0.43 }),
    mkAgent("research:constraints", "done", { durationMs: 242_000, startedAt: S(0, 6), endedAt: S(4, 7), shareOfLongest: 0.32 }),
    mkAgent("design:crdt-ledger", "done", { durationMs: 760_000, startedAt: S(12, 12), endedAt: S(24, 52), shareOfLongest: 1, tokens: { inputTokens: 200_000, outputTokens: 26_000, reasoningTokens: 10_000 } }),
    mkAgent("design:op-log", "done", { durationMs: 552_000, startedAt: S(12, 12), endedAt: S(21, 24), shareOfLongest: 0.73, tokens: { inputTokens: 140_000, outputTokens: 20_000, reasoningTokens: 8_000 } }),
    mkAgent("design:conflict-ledger", "failed", { attempt: 2, durationMs: 361_000, startedAt: S(14, 22), endedAt: S(18, 13), shareOfLongest: 0.47, failure: { text: null, at: S(18, 13) }, tokens: { inputTokens: 52_100, outputTokens: 6_400, reasoningTokens: 5_700 } }),
    mkAgent("judge:correctness", "finishing", { startedAt: S(25, 14), runningMs: NOW - S(25, 14), silenceMs: 53_000, lastEventAt: S(40, 23), shareOfLongest: 1.27, tokens: { inputTokens: 121_000, outputTokens: 17_000, reasoningTokens: 10_000 } }),
    mkAgent("judge:perf", "no-update", { startedAt: S(25, 14), runningMs: NOW - S(25, 14), silenceMs: NOW - S(25, 14), lastEventAt: S(25, 14), shareOfLongest: 1.27, quiet: { thresholdMs: 760_000, longestFinishedMs: 760_000 } }),
    mkAgent("synthesize:report", "planned", { id: "planned:synthesize:report", attempt: 0 }),
  ];
}

/** A run around hand-built agents; the derived fields come from the model's own helpers. */
export function mkRun(agents: AgentVM[], extra: Partial<RunVM> = {}): RunVM {
  const phases = phasesOf(agents);
  const counts = runCounts({ phases });
  const current = phases.find((phase) => phase.agents.some((agent) => LIVE.has(agent.state))) ?? phases.find((phase) => phase.agents.some((agent) => agent.state === "planned")) ?? null;
  return {
    itemId: "wf",
    runId: RUN_ID,
    name: "offline-sync-research-design",
    kind: "workflow",
    research: null,
    status: "running",
    revision: 40,
    startedAt: S(0, 0),
    endedAt: null,
    elapsedMs: NOW - S(0, 0),
    elapsedApprox: false,
    partialHistory: false,
    phases,
    agents,
    counts,
    attention: attentionOrder(agents),
    runNeeds: [],
    currentPhase: current?.name ?? null,
    plannedKnown: true,
    tokens: null,
    cost: null,
    slots: null,
    pulse: new Array<number>(10).fill(0),
    longestFinishedMs: 760_000,
    agentTimeMs: null,
    peakConcurrency: null,
    waitedOnYouMs: null,
    retried: 0,
    report: null,
    stale: false,
    staleAt: null,
    clockAt: NOW,
    ...extra,
  };
}
