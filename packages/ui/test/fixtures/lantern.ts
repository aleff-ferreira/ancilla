import { applyEvents, emptyFold, type ThreadFold } from "../../src/model/fold.js";
import {
  attentionOrder,
  phasesOf,
  runCounts,
  crewView,
  type AgentState,
  type AgentVM,
  type RunVM,
  type CrewOptions,
  type CrewVM,
} from "../../src/model/crew.js";
import type { MspItem, SessionSummary, ViewEvent, WorkflowChild } from "../../src/types.js";

export const T0 = Date.UTC(2026, 8, 26, 14, 2, 0);
export const S = (m: number, s = 0): number => T0 + (m * 60 + s) * 1000;
export const MIN = 60_000;
export const NOW = S(41, 16);

export const SESSION: SessionSummary = {
  sessionId: "s1", cwd: "/work/lantern", title: "Design the offline sync engine",
  titleSource: "auto", turnCount: 3, modelId: "muse-spark-1.3", origin: "ancilla",
  archived: false, createdAt: "2026-09-26T13:00:00.000Z", activityAt: "2026-09-26T14:40:00.000Z",
  settled: false, settledAt: null, unsettledAt: null, sandboxDisabled: false,
  accountId: null, live: null,
};

function assembleWorkflowScript(): string {
  const lines = [
    "export default async function workflow(host) {",
    "  const research = await host.parallel([",
    '    { label: "research:field-notes",',
    '      input: "Read the field notes and list every sync failure the users hit." },',
    '    { label: "research:crdt-survey",',
    '      input: \'Survey CRDT designs for note text.\' },',
    '    { label: "research:prior-art",',
    '      input: `Find prior art in offline note apps.` },',
    '    { label: "research:constraints",',
    '      input: "List the device constraints." },',
    "  ]);",
    "  const design = await host.parallel([",
    '    { label: "design:crdt-ledger",',
    '      input: "Design the CRDT ledger." },',
    '    { label: "design:op-log",',
    '      input: "Design the op log." },',
    '    { label: "design:conflict-ledger",',
    '      input: "Design the conflict ledger: define how two devices reconcile." },',
    "  ]);",
    "  const judge = await host.parallel([",
    '    { label: "judge:correctness",',
    '      input: "Judge the two candidate designs for correctness." },',
    '    { label: "judge:perf",',
    '      input: "Judge the two candidate designs for performance." },',
    "  ]);",
    "  return host.parallel([",
    '    { label: "synthesize:report",',
    '      input: "Write the report." },',
    "  ]);",
    "}",
  ];
  return lines.join("\n");
}

export const SCRIPT = assembleWorkflowScript();
export const CALL = "call_01a08dd7";
export const RUN_ID = `workflow-run-model-tool-${CALL}`;

export function launch(
  script: string | null = SCRIPT,
  output: unknown = { maxParallelAgents: 16, policy: { childLimit: 16 }, tokenBudget: null },
): ViewEvent {
  const argsObject = script === null
    ? { name: "offline-sync-research-design" }
    : { name: "offline-sync-research-design", script };

  const launchItem: MspItem = {
    itemId: "launch", kind: "toolCall", status: "completed", revision: 1, turnId: "t1",
    tool: "workflow", callId: CALL, args: JSON.stringify(argsObject),
    ...(output !== null ? { visibleOutput: JSON.stringify(output) } : {}),
  };

  return {
    method: "item/completed",
    at: S(0, 0),
    params: { item: launchItem },
  };
}

export class Feed {
  readonly events: ViewEvent[] = [];
  private readonly fresh = new Set<string>();
  private readonly children = new Map<string, WorkflowChild>();
  private revision = 0;
  private readonly extra: Partial<MspItem>;

  constructor(extraConfig: Partial<MspItem> = {}) {
    this.extra = extraConfig;
  }

  private keyOf(childId: string, attempt: number): string {
    return `${childId}:${attempt}`;
  }

  schedule(childId: string, label: string | null, at: number, attempt = 1): this {
    const idKey = this.keyOf(childId, attempt);
    const childRecord: WorkflowChild = { childId, attempt, status: "scheduled" };
    if (label) childRecord.label = label;
    this.children.set(idKey, childRecord);
    this.fresh.add(idKey);
    return this.emit(at);
  }

  set(childId: string, patch: Partial<WorkflowChild>, at: number, attempt = 1): this {
    const idKey = this.keyOf(childId, attempt);
    const existing = this.children.get(idKey);
    if (!existing) {
      throw new Error(`no child ${idKey}`);
    }
    this.children.set(idKey, { ...existing, ...patch });
    return this.emit(at);
  }

  retry(childId: string, attempt: number, at: number, label: string | null = null): this {
    const prefix = `${childId}:`;
    for (const key of Array.from(this.children.keys())) {
      if (key.startsWith(prefix)) this.children.delete(key);
    }
    return this.schedule(childId, label, at, attempt);
  }

  emit(at: number, status = "inProgress", extra: Partial<MspItem> = {}): this {
    this.revision += 1;
    const presentedChildren: WorkflowChild[] = [];
    for (const child of this.children.values()) {
      const idKey = this.keyOf(child.childId, child.attempt);
      const { label, usage, ...rest } = child;
      const row: WorkflowChild = { ...rest };
      if (label && this.fresh.has(idKey)) row.label = label;
      if (usage && this.fresh.has(`${idKey}:usage`)) row.usage = usage;
      presentedChildren.push(row);
    }
    this.fresh.clear();

    const eventKind = status === "inProgress" && this.revision === 1
      ? "item/started"
      : status === "inProgress"
        ? "item/updated"
        : "item/completed";

    this.events.push({
      method: eventKind,
      at,
      params: {
        item: {
          itemId: "wf", kind: "workflow", status, revision: this.revision, turnId: "t1",
          workflowRunId: RUN_ID, entryId: "offline-sync-research-design",
          scriptId: "generated.workflow.offline-sync-research-design",
          recordedAt: new Date(at).toISOString(), children: presentedChildren,
          ...this.extra, ...extra,
        },
      },
    });
    return this;
  }

  usage(childId: string, usage: WorkflowChild["usage"], at: number, attempt = 1): this {
    const idKey = this.keyOf(childId, attempt);
    const existing = this.children.get(idKey);
    if (!existing) throw new Error(`no child ${idKey}`);
    this.children.set(idKey, { ...existing, status: "usage", usage });
    this.fresh.add(`${idKey}:usage`);
    return this.emit(at);
  }

  finish(childId: string, at: number, durationMs: number, terminal = "completed", attempt = 1): this {
    const termPatch: Partial<WorkflowChild> = { status: "terminal", terminal, durationMs };
    return this.set(childId, termPatch, at, attempt);
  }
}

export function fold(events: ViewEvent[]): ThreadFold {
  const initialThreadState = emptyFold();
  return applyEvents(initialThreadState, events);
}

type TimelineInstruction =
  | { op: "sched"; id: string; tag: string; m: number; s: number; tryNum?: number }
  | { op: "patch"; id: string; diff: Partial<WorkflowChild>; m: number; s: number; tryNum?: number }
  | { op: "use"; id: string; tokens: WorkflowChild["usage"]; m: number; s: number; tryNum?: number }
  | { op: "done"; id: string; m: number; s: number; lenMs: number; term?: string; tryNum?: number }
  | { op: "re"; id: string; tryNum: number; m: number; s: number; tag?: string | null };

const LANTERN_EVENTS: readonly TimelineInstruction[] = [
  { op: "sched", id: "c-fn", tag: "research:field-notes", m: 0, s: 4 },
  { op: "sched", id: "c-cs", tag: "research:crdt-survey", m: 0, s: 4 },
  { op: "sched", id: "c-pa", tag: "research:prior-art", m: 0, s: 5 },
  { op: "sched", id: "c-co", tag: "research:constraints", m: 0, s: 5 },
  { op: "patch", id: "c-fn", diff: { status: "started" }, m: 0, s: 6 },
  { op: "patch", id: "c-cs", diff: { status: "started" }, m: 0, s: 6 },
  { op: "patch", id: "c-pa", diff: { status: "started" }, m: 0, s: 6 },
  { op: "patch", id: "c-co", diff: { status: "started" }, m: 0, s: 6 },
  { op: "use", id: "c-co", tokens: { inputTokens: 80_000, outputTokens: 10_000, reasoningTokens: 6_000 }, m: 4, s: 5 },
  { op: "done", id: "c-co", m: 4, s: 7, lenMs: 242_000 },
  { op: "use", id: "c-pa", tokens: { inputTokens: 90_000, outputTokens: 14_000, reasoningTokens: 8_000 }, m: 5, s: 33 },
  { op: "done", id: "c-pa", m: 5, s: 35, lenMs: 330_000 },
  { op: "use", id: "c-cs", tokens: { inputTokens: 130_000, outputTokens: 24_000, reasoningTokens: 10_000 }, m: 8, s: 17 },
  { op: "done", id: "c-cs", m: 8, s: 19, lenMs: 495_000 },
  { op: "use", id: "c-fn", tokens: { inputTokens: 240_000, outputTokens: 30_000, reasoningTokens: 18_000 }, m: 12, s: 2 },
  { op: "done", id: "c-fn", m: 12, s: 4, lenMs: 720_000 },
  { op: "sched", id: "c-cl", tag: "design:crdt-ledger", m: 12, s: 10 },
  { op: "sched", id: "c-ol", tag: "design:op-log", m: 12, s: 10 },
  { op: "sched", id: "c-cf", tag: "design:conflict-ledger", m: 12, s: 10 },
  { op: "patch", id: "c-cl", diff: { status: "started" }, m: 12, s: 12 },
  { op: "patch", id: "c-ol", diff: { status: "started" }, m: 12, s: 12 },
  { op: "patch", id: "c-cf", diff: { status: "started" }, m: 12, s: 12 },
  { op: "done", id: "c-cf", m: 14, s: 20, lenMs: 128_000, term: "failed" },
  { op: "re", id: "c-cf", tryNum: 2, m: 14, s: 21, tag: "design:conflict-ledger" },
  { op: "patch", id: "c-cf", diff: { status: "started" }, m: 14, s: 22, tryNum: 2 },
  { op: "use", id: "c-cf", tokens: { inputTokens: 52_100, outputTokens: 6_400, reasoningTokens: 5_700 }, m: 18, s: 12, tryNum: 2 },
  { op: "done", id: "c-cf", m: 18, s: 13, lenMs: 231_000, term: "failed", tryNum: 2 },
  { op: "use", id: "c-ol", tokens: { inputTokens: 140_000, outputTokens: 20_000, reasoningTokens: 8_000 }, m: 21, s: 22 },
  { op: "done", id: "c-ol", m: 21, s: 24, lenMs: 552_000 },
  { op: "use", id: "c-cl", tokens: { inputTokens: 200_000, outputTokens: 26_000, reasoningTokens: 10_000 }, m: 24, s: 50 },
  { op: "done", id: "c-cl", m: 24, s: 52, lenMs: 760_000 },
  { op: "sched", id: "c-jc", tag: "judge:correctness", m: 25, s: 12 },
  { op: "sched", id: "c-jp", tag: "judge:perf", m: 25, s: 12 },
  { op: "patch", id: "c-jc", diff: { status: "started" }, m: 25, s: 14 },
  { op: "patch", id: "c-jp", diff: { status: "started" }, m: 25, s: 14 },
  { op: "use", id: "c-jc", tokens: { inputTokens: 121_000, outputTokens: 17_000, reasoningTokens: 10_000 }, m: 40, s: 23 },
];

const FINISHED_EXTENSION: readonly TimelineInstruction[] = [
  { op: "done", id: "c-jc", m: 42, s: 34, lenMs: 1_040_000 },
  { op: "use", id: "c-jp", tokens: { inputTokens: 80_000, outputTokens: 10_000, reasoningTokens: 6_000 }, m: 43, s: 48 },
  { op: "done", id: "c-jp", m: 43, s: 50, lenMs: 1_116_000 },
  { op: "re", id: "c-cf", tryNum: 3, m: 41, s: 52, tag: "design:conflict-ledger" },
  { op: "patch", id: "c-cf", diff: { status: "started" }, m: 41, s: 53, tryNum: 3 },
  { op: "use", id: "c-cf", tokens: { inputTokens: 100_000, outputTokens: 12_000, reasoningTokens: 6_000 }, m: 44, s: 3, tryNum: 3 },
  { op: "done", id: "c-cf", m: 44, s: 4, lenMs: 132_000, term: "completed", tryNum: 3 },
  { op: "sched", id: "c-sr", tag: "synthesize:report", m: 44, s: 10 },
  { op: "patch", id: "c-sr", diff: { status: "started" }, m: 44, s: 11 },
  { op: "use", id: "c-sr", tokens: { inputTokens: 30_000, outputTokens: 8_000, reasoningTokens: 3_000 }, m: 45, s: 9 },
  { op: "done", id: "c-sr", m: 45, s: 10, lenMs: 60_000 },
];

function playTimeline(feed: Feed, steps: readonly TimelineInstruction[]): Feed {
  for (const step of steps) {
    const timestamp = S(step.m, step.s);
    const attempt = step.tryNum ?? 1;
    switch (step.op) {
      case "sched":
        feed.schedule(step.id, step.tag, timestamp, attempt);
        break;
      case "patch":
        feed.set(step.id, step.diff, timestamp, attempt);
        break;
      case "use":
        feed.usage(step.id, step.tokens, timestamp, attempt);
        break;
      case "done":
        feed.finish(step.id, timestamp, step.lenMs, step.term ?? "completed", attempt);
        break;
      case "re":
        feed.retry(step.id, step.tryNum, timestamp, step.tag ?? null);
        break;
    }
  }
  return feed;
}

export function lantern(): Feed {
  return playTimeline(new Feed(), LANTERN_EVENTS);
}

export const APPROVAL: ViewEvent = {
  method: "approval/requested",
  at: S(39, 36),
  params: {
    approvalId: "ap1", sessionId: "s1", currentRequirementId: null,
    availableChoices: [{ choiceId: "allow", label: "Allow once", decision: "approved" }],
    subject: { kind: "shell", command: "npm test -- --run conflict" },
  },
};

export const APPROVED: ViewEvent = {
  method: "approval/resolved",
  at: S(41, 16),
  params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" },
};

export function view(
  feed: Feed,
  now = NOW,
  extra: CrewOptions = {},
  events: ViewEvent[] = [],
): { fold: ThreadFold; vm: CrewVM } {
  const combined = [launch(), ...feed.events, ...events].filter(
    (ev) => ev.at === undefined || ev.at <= now,
  );
  const threadFold = fold(combined);
  return { fold: threadFold, vm: crewView(threadFold, SESSION, now, extra) };
}

export function finishedFeed(): Feed {
  const feed = lantern();
  playTimeline(feed, FINISHED_EXTENSION);
  const completionMessage = `<workflow-launch-reconciled>${JSON.stringify({
    final_summary: {
      summary: "Recommend the **CRDT ledger** (design:crdt-ledger).\n\nIt resolved every case in the conflict corpus.\n\nThe op-log design is simpler.",
    },
    agents_activity: [],
    workspace_handoffs: [{ agent: "design:crdt-ledger", description: "ledger design doc" }],
  })}</workflow-launch-reconciled>`;
  feed.emit(S(45, 10), "completed", { message: completionMessage });
  return feed;
}

export function finishedRun(now = S(50, 0)): RunVM {
  return view(finishedFeed(), now, {}, [APPROVAL, APPROVED]).vm.runs[0] as RunVM;
}

export function runningRun(extra: CrewOptions = {}, events: ViewEvent[] = []): RunVM {
  return view(lantern(), NOW, extra, events).vm.runs[0] as RunVM;
}

export function agentNamed(run: RunVM, name: string): AgentVM {
  const match = run.agents.find((item) => item.name === name);
  if (!match) throw new Error(`no agent named ${name}`);
  return match;
}

const HTML_REPLACEMENTS: readonly [RegExp, string][] = [
  [/<span class="inline-flex tabular-nums" aria-label="([^"]*)">(?:<span aria-hidden="true" class="whitespace-pre">[^<]*<\/span>)*<\/span>/g, "$1"],
  [/<span class="pre">([^<]*)<\/span>/g, "$1"],
  [/&#x27;/g, "'"],
  [/&amp;/g, "&"],
];

export function flatten(markup: string): string {
  let result = markup;
  for (const [re, sub] of HTML_REPLACEMENTS) {
    result = result.replace(re, sub);
  }
  return result;
}

const TEXT_CLEANUP_RULES: readonly [RegExp, string][] = [
  [/<[^>]+>/g, " "],
  [/&quot;/g, '"'],
  [/\s+/g, " "],
  [/\s+([,.;:)!?])/g, "$1"],
  [/\(\s+/g, "("],
];

export function textOf(markup: string): string {
  const flat = flatten(markup);
  let sanitized = flat;
  for (const [re, rep] of TEXT_CLEANUP_RULES) {
    sanitized = sanitized.replace(re, rep);
  }
  return sanitized.trim();
}

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set([
  "scheduled", "working", "finishing", "no-update", "waiting-on-you",
]);

function titleCase(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

export function mkAgent(name: string, state: AgentState, extra: Partial<AgentVM> = {}): AgentVM {
  const delim = name.indexOf(":");
  const hasPrefix = delim > 0;
  const blankAgent: AgentVM = {
    id: name,
    name,
    label: name,
    attempt: 1,
    phase: hasPrefix ? titleCase(name.slice(0, delim)) : "Agents",
    display: {
      prefix: hasPrefix ? name.slice(0, delim + 1) : null,
      short: hasPrefix ? name.slice(delim + 1) : name,
    },
    state,
    pending: null,
    kind: "workflow",
    skippedBy: state === "skipped" ? "muse" : null,
    startedAt: null, endedAt: null, lastEventAt: null, silenceMs: null,
    runningMs: null, durationMs: null, approx: false, tokens: null,
    toolCalls: null, attempts: [], failure: null, task: null,
    shareOfLongest: null, quiet: null, needs: null, runItemId: "wf",
    workflowRunId: RUN_ID,
    ...extra,
  };
  return blankAgent;
}

export function mkTask(
  command: string,
  state: AgentState,
  extra: Partial<AgentVM> = {},
  info: Partial<NonNullable<AgentVM["taskInfo"]>> = {},
): AgentVM {
  const isLive = ACTIVE_AGENT_STATES.has(state);
  const base = mkAgent(command, state, {
    id: `task:${command}`,
    kind: "task",
    phase: "Background",
    display: { prefix: null, short: command },
    runItemId: null,
    workflowRunId: null,
  });

  const timingProps: Partial<AgentVM> = isLive
    ? { runningMs: 83_000, durationMs: null, endedAt: null }
    : { runningMs: null, durationMs: 291_000, endedAt: S(44, 44) };

  const taskPayload: NonNullable<AgentVM["taskInfo"]> = {
    command,
    tail: '12 passed · 3 pending · running "merges concurrent edits"',
    lastOutputAt: S(41, 10),
    initiator: "user",
    approvalId: null,
    ...info,
  };

  return {
    ...base,
    startedAt: S(39, 53),
    lastEventAt: S(41, 10),
    taskInfo: taskPayload,
    ...timingProps,
    ...extra,
  };
}

interface AgentSpec {
  name: string;
  state: AgentState;
  attempt?: number;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  share?: number;
  tokens?: WorkflowChild["usage"];
  runningMs?: number;
  silenceMs?: number;
  lastEventAt?: number;
  failure?: { text: null; at: number };
  quiet?: { thresholdMs: number; longestFinishedMs: number };
  id?: string;
}

const REFERENCE_AGENT_SPECS: readonly AgentSpec[] = [
  { name: "research:field-notes", state: "done", durationMs: 720_000, tokens: { inputTokens: 240_000, outputTokens: 30_000, reasoningTokens: 18_000 }, startedAt: S(0, 6), endedAt: S(12, 4), share: 0.95 },
  { name: "research:crdt-survey", state: "done", durationMs: 495_000, startedAt: S(0, 6), endedAt: S(8, 19), share: 0.65 },
  { name: "research:prior-art", state: "done", durationMs: 330_000, startedAt: S(0, 6), endedAt: S(5, 35), share: 0.43 },
  { name: "research:constraints", state: "done", durationMs: 242_000, startedAt: S(0, 6), endedAt: S(4, 7), share: 0.32 },
  { name: "design:crdt-ledger", state: "done", durationMs: 760_000, startedAt: S(12, 12), endedAt: S(24, 52), share: 1, tokens: { inputTokens: 200_000, outputTokens: 26_000, reasoningTokens: 10_000 } },
  { name: "design:op-log", state: "done", durationMs: 552_000, startedAt: S(12, 12), endedAt: S(21, 24), share: 0.73, tokens: { inputTokens: 140_000, outputTokens: 20_000, reasoningTokens: 8_000 } },
  { name: "design:conflict-ledger", state: "failed", attempt: 2, durationMs: 361_000, startedAt: S(14, 22), endedAt: S(18, 13), share: 0.47, failure: { text: null, at: S(18, 13) }, tokens: { inputTokens: 52_100, outputTokens: 6_400, reasoningTokens: 5_700 } },
  { name: "judge:correctness", state: "finishing", startedAt: S(25, 14), runningMs: NOW - S(25, 14), silenceMs: 53_000, lastEventAt: S(40, 23), share: 1.27, tokens: { inputTokens: 121_000, outputTokens: 17_000, reasoningTokens: 10_000 } },
  { name: "judge:perf", state: "no-update", startedAt: S(25, 14), runningMs: NOW - S(25, 14), silenceMs: NOW - S(25, 14), lastEventAt: S(25, 14), share: 1.27, quiet: { thresholdMs: 760_000, longestFinishedMs: 760_000 } },
  { name: "synthesize:report", state: "planned", id: "planned:synthesize:report", attempt: 0 },
];

export function referenceAgents(): AgentVM[] {
  return REFERENCE_AGENT_SPECS.map((spec) => {
    const extra: Partial<AgentVM> = {};
    if (spec.id !== undefined) extra.id = spec.id;
    if (spec.attempt !== undefined) extra.attempt = spec.attempt;
    if (spec.durationMs !== undefined) extra.durationMs = spec.durationMs;
    if (spec.startedAt !== undefined) extra.startedAt = spec.startedAt;
    if (spec.endedAt !== undefined) extra.endedAt = spec.endedAt;
    if (spec.share !== undefined) extra.shareOfLongest = spec.share;
    if (spec.tokens !== undefined) extra.tokens = spec.tokens;
    if (spec.runningMs !== undefined) extra.runningMs = spec.runningMs;
    if (spec.silenceMs !== undefined) extra.silenceMs = spec.silenceMs;
    if (spec.lastEventAt !== undefined) extra.lastEventAt = spec.lastEventAt;
    if (spec.failure !== undefined) extra.failure = spec.failure;
    if (spec.quiet !== undefined) extra.quiet = spec.quiet;
    return mkAgent(spec.name, spec.state, extra);
  });
}

export function mkRun(agents: AgentVM[], extra: Partial<RunVM> = {}): RunVM {
  const phases = phasesOf(agents);
  const counts = runCounts({ phases });
  const activePhase = phases.find((p) => p.agents.some((a) => ACTIVE_AGENT_STATES.has(a.state)))
    ?? phases.find((p) => p.agents.some((a) => a.state === "planned"))
    ?? null;

  const runItem: RunVM = {
    itemId: "wf", runId: RUN_ID, name: "offline-sync-research-design", kind: "workflow",
    status: "running", revision: 40, agents, phases, counts, startedAt: S(0, 0),
    elapsedMs: NOW - S(0, 0), runNeeds: [], attention: attentionOrder(agents),
    elapsedApprox: false, partialHistory: false, currentPhase: activePhase?.name ?? null,
    pulse: new Array<number>(10).fill(0), plannedKnown: true, longestFinishedMs: 760_000,
    retried: 0, clockAt: NOW, stale: false, research: null, endedAt: null, tokens: null,
    cost: null, slots: null, agentTimeMs: null, peakConcurrency: null, waitedOnYouMs: null,
    report: null, staleAt: null,
    ...extra,
  };
  return runItem;
}
