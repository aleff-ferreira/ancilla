import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { CrewPanel } from "../src/components/crew/CrewPanel.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, Store, type AppState, type Prefs, type CrewPanelState, type ThreadState } from "../src/model/store.js";
import { crewView, type RunVM, type CrewOptions } from "../src/model/crew.js";
import type { MspItem, SessionSummary, ViewEvent, WorkflowChild } from "../src/types.js";

export const T0: number = Date.UTC(2026, 8, 26, 14, 2, 0);
export const S = (min: number, sec = 0): number => T0 + (min * 60 + sec) * 1000;
export const MIN: number = 60_000;
export const NOW: number = S(41, 16);

export const SESSION: SessionSummary = Object.freeze({
  sessionId: "s1",
  cwd: "/work/lantern",
  title: "Design the offline sync engine",
  titleSource: "auto",
  turnCount: 3,
  modelId: "muse-spark-1.3",
  origin: "ancilla",
  archived: false,
  createdAt: "2026-09-26T13:00:00.000Z",
  activityAt: "2026-09-26T14:40:00.000Z",
  settled: false,
  settledAt: null,
  unsettledAt: null,
  sandboxDisabled: false,
  accountId: null,
  live: {
    activeTurnId: "t1",
    turnStartedAt: null,
    pendingApprovals: 0,
    pendingInputs: 0,
    lastTerminal: null,
    lastError: null,
  },
});

function assembleScriptContent(): string {
  const parts: string[] = [
    "export default async function workflow(host) {",
    "  const research = await host.parallel([",
    "    {",
    '      label: "research:field-notes",',
    '      input: "Read the field notes and list every sync failure the users hit.",',
    "    },",
    "    {",
    '      label: "research:crdt-survey",',
    '      input: "Survey CRDT designs for note text.",',
    "    },",
    "    {",
    '      label: "research:prior-art",',
    '      input: "Find prior art in offline note apps.",',
    "    },",
    "    {",
    '      label: "research:constraints",',
    '      input: "List the device constraints.",',
    "    },",
    "  ]);",
    "  const design = await host.parallel([",
    "    {",
    '      label: "design:crdt-ledger",',
    '      input: "Design the CRDT ledger.",',
    "    },",
    "    {",
    '      label: "design:op-log",',
    '      input: "Design the op log.",',
    "    },",
    "    {",
    '      label: "design:conflict-ledger",',
    '      input: "Design the conflict ledger: define how two devices reconcile.",',
    "    },",
    "  ]);",
    "  const judge = await host.parallel([",
    "    {",
    '      label: "judge:correctness",',
    '      input: "Judge the two candidate designs for correctness.",',
    "    },",
    "    {",
    '      label: "judge:perf",',
    '      input: "Judge the two candidate designs for performance.",',
    "    },",
    "  ]);",
    "  return host.parallel([",
    "    {",
    '      label: "synthesize:report",',
    '      input: "Write the report.",',
    "    },",
    "  ]);",
    "}",
  ];
  return parts.join("\n");
}

export const SCRIPT: string = assembleScriptContent();
export const CALL = "call_01a08dd7";
export const RUN_ID = `workflow-run-model-tool-${CALL}`;

export function launch(
  script: string | null = SCRIPT,
  output: unknown = { maxParallelAgents: 16, policy: { childLimit: 16 }, tokenBudget: null },
): ViewEvent {
  const argsPayload = script === null
    ? { name: "offline-sync-research-design" }
    : { name: "offline-sync-research-design", script };

  const launchItem = {
    itemId: "launch",
    kind: "toolCall" as const,
    status: "completed" as const,
    revision: 1,
    turnId: "t1",
    tool: "workflow",
    callId: CALL,
    args: JSON.stringify(argsPayload),
    visibleOutput: output === null ? undefined : JSON.stringify(output),
  };

  const launchEvent: ViewEvent = {
    method: "item/completed",
    at: S(0, 0),
    params: { item: launchItem },
  };
  return launchEvent;
}

export class Feed {
  private revIndex = 0;
  private readonly activeChildren = new Map<string, WorkflowChild>();
  private readonly newArrivals = new Set<string>();
  readonly events: ViewEvent[] = [];

  constructor(private readonly baselineAttributes: Partial<MspItem> = {}) {}

  private keyOf(agentId: string, attemptNumber: number): string {
    return `${agentId}:${attemptNumber}`;
  }

  schedule(childId: string, label: string | null, at: number, attempt = 1): this {
    const compositeKey = this.keyOf(childId, attempt);
    const childRecord: WorkflowChild = {
      childId,
      attempt,
      status: "scheduled",
    };
    if (label) {
      childRecord.label = label;
    }
    this.activeChildren.set(compositeKey, childRecord);
    this.newArrivals.add(compositeKey);
    return this.emit(at);
  }

  set(childId: string, patch: Partial<WorkflowChild>, at: number, attempt = 1): this {
    const compositeKey = this.keyOf(childId, attempt);
    const existing = this.activeChildren.get(compositeKey);
    if (!existing) {
      throw new Error(`Child not found: ${compositeKey}`);
    }
    const updated = Object.assign({}, existing, patch);
    this.activeChildren.set(compositeKey, updated);
    return this.emit(at);
  }

  retry(childId: string, attempt: number, at: number, label: string | null = null): this {
    const prefix = `${childId}:`;
    for (const k of Array.from(this.activeChildren.keys())) {
      if (k.startsWith(prefix)) {
        this.activeChildren.delete(k);
      }
    }
    return this.schedule(childId, label, at, attempt);
  }

  emit(at: number, status = "inProgress", extra: Partial<MspItem> = {}): this {
    this.revIndex += 1;
    const currentRev = this.revIndex;
    const isFirstRev = currentRev === 1;
    const eventMethod = status === "inProgress"
      ? (isFirstRev ? "item/started" : "item/updated")
      : "item/completed";

    const snapshotChildren: WorkflowChild[] = [];
    for (const child of this.activeChildren.values()) {
      const childKey = this.keyOf(child.childId, child.attempt);
      const usageKey = `${childKey}:usage`;
      const itemClone: WorkflowChild = {
        childId: child.childId,
        attempt: child.attempt,
        status: child.status,
      };
      if (child.terminal !== undefined) itemClone.terminal = child.terminal;
      if (child.durationMs !== undefined) itemClone.durationMs = child.durationMs;
      if (child.label && this.newArrivals.has(childKey)) {
        itemClone.label = child.label;
      }
      if (child.usage && this.newArrivals.has(usageKey)) {
        itemClone.usage = child.usage;
      }
      snapshotChildren.push(itemClone);
    }
    this.newArrivals.clear();

    const isoTime = new Date(at).toISOString();
    const itemData: MspItem = {
      itemId: "wf",
      kind: "workflow",
      status,
      revision: currentRev,
      turnId: "t1",
      workflowRunId: RUN_ID,
      entryId: "offline-sync-research-design",
      scriptId: "generated.workflow.offline-sync-research-design",
      recordedAt: isoTime,
      children: snapshotChildren,
      ...this.baselineAttributes,
      ...extra,
    };

    this.events.push({
      method: eventMethod,
      at,
      params: { item: itemData },
    });
    return this;
  }

  usage(childId: string, usage: WorkflowChild["usage"], at: number, attempt = 1): this {
    const compositeKey = this.keyOf(childId, attempt);
    const existing = this.activeChildren.get(compositeKey);
    if (!existing) {
      throw new Error(`Child not found: ${compositeKey}`);
    }
    existing.status = "usage";
    existing.usage = usage;
    this.newArrivals.add(`${compositeKey}:usage`);
    return this.emit(at);
  }

  finish(childId: string, at: number, durationMs: number, terminal = "completed", attempt = 1): this {
    const terminationPatch: Partial<WorkflowChild> = {
      status: "terminal",
      terminal,
      durationMs,
    };
    return this.set(childId, terminationPatch, at, attempt);
  }
}

interface ScenarioStep {
  op: "sched" | "start" | "usage" | "done" | "retry";
  id: string;
  m: number;
  s: number;
  lbl?: string;
  att?: number;
  dur?: number;
  term?: string;
  tok?: [number, number, number];
}

const LANTERN_BASE_ACTIONS: readonly ScenarioStep[] = [
  { op: "sched", id: "c-fn", lbl: "research:field-notes", m: 0, s: 4 },
  { op: "sched", id: "c-cs", lbl: "research:crdt-survey", m: 0, s: 4 },
  { op: "sched", id: "c-pa", lbl: "research:prior-art", m: 0, s: 5 },
  { op: "sched", id: "c-co", lbl: "research:constraints", m: 0, s: 5 },
  { op: "start", id: "c-fn", m: 0, s: 6 },
  { op: "start", id: "c-cs", m: 0, s: 6 },
  { op: "start", id: "c-pa", m: 0, s: 6 },
  { op: "start", id: "c-co", m: 0, s: 6 },
  { op: "usage", id: "c-co", m: 4, s: 5, tok: [80_000, 10_000, 6_000] },
  { op: "done", id: "c-co", m: 4, s: 7, dur: 242_000 },
  { op: "usage", id: "c-pa", m: 5, s: 33, tok: [90_000, 14_000, 8_000] },
  { op: "done", id: "c-pa", m: 5, s: 35, dur: 330_000 },
  { op: "usage", id: "c-cs", m: 8, s: 17, tok: [130_000, 24_000, 10_000] },
  { op: "done", id: "c-cs", m: 8, s: 19, dur: 495_000 },
  { op: "usage", id: "c-fn", m: 12, s: 2, tok: [240_000, 30_000, 18_000] },
  { op: "done", id: "c-fn", m: 12, s: 4, dur: 720_000 },
  { op: "sched", id: "c-cl", lbl: "design:crdt-ledger", m: 12, s: 10 },
  { op: "sched", id: "c-ol", lbl: "design:op-log", m: 12, s: 10 },
  { op: "sched", id: "c-cf", lbl: "design:conflict-ledger", m: 12, s: 10 },
  { op: "start", id: "c-cl", m: 12, s: 12 },
  { op: "start", id: "c-ol", m: 12, s: 12 },
  { op: "start", id: "c-cf", m: 12, s: 12 },
  { op: "done", id: "c-cf", m: 14, s: 20, dur: 128_000, term: "failed" },
  { op: "retry", id: "c-cf", att: 2, m: 14, s: 21, lbl: "design:conflict-ledger" },
  { op: "start", id: "c-cf", att: 2, m: 14, s: 22 },
  { op: "usage", id: "c-cf", att: 2, m: 18, s: 12, tok: [52_100, 6_400, 5_700] },
  { op: "done", id: "c-cf", att: 2, m: 18, s: 13, dur: 231_000, term: "failed" },
  { op: "usage", id: "c-ol", m: 21, s: 22, tok: [140_000, 20_000, 8_000] },
  { op: "done", id: "c-ol", m: 21, s: 24, dur: 552_000 },
  { op: "usage", id: "c-cl", m: 24, s: 50, tok: [200_000, 26_000, 10_000] },
  { op: "done", id: "c-cl", m: 24, s: 52, dur: 760_000 },
  { op: "sched", id: "c-jc", lbl: "judge:correctness", m: 25, s: 12 },
  { op: "sched", id: "c-jp", lbl: "judge:perf", m: 25, s: 12 },
  { op: "start", id: "c-jc", m: 25, s: 14 },
  { op: "start", id: "c-jp", m: 25, s: 14 },
  { op: "usage", id: "c-jc", m: 40, s: 23, tok: [121_000, 17_000, 10_000] },
];

function executeScenario(feed: Feed, steps: readonly ScenarioStep[]): Feed {
  for (const step of steps) {
    const timestamp = S(step.m, step.s);
    const attempt = step.att ?? 1;
    if (step.op === "sched") {
      feed.schedule(step.id, step.lbl ?? null, timestamp, attempt);
    } else if (step.op === "start") {
      feed.set(step.id, { status: "started" }, timestamp, attempt);
    } else if (step.op === "usage") {
      const [inputTokens, outputTokens, reasoningTokens] = step.tok!;
      feed.usage(step.id, { inputTokens, outputTokens, reasoningTokens }, timestamp, attempt);
    } else if (step.op === "done") {
      feed.finish(step.id, timestamp, step.dur ?? 0, step.term ?? "completed", attempt);
    } else if (step.op === "retry") {
      feed.retry(step.id, attempt, timestamp, step.lbl ?? null);
    }
  }
  return feed;
}

export function lantern(): Feed {
  const feed = new Feed();
  return executeScenario(feed, LANTERN_BASE_ACTIONS);
}

const LANTERN_COMPLETION_ACTIONS: readonly ScenarioStep[] = [
  { op: "retry", id: "c-cf", att: 3, m: 41, s: 50, lbl: "design:conflict-ledger" },
  { op: "start", id: "c-cf", att: 3, m: 41, s: 52 },
  { op: "done", id: "c-jc", m: 42, s: 34, dur: 1_040_000 },
  { op: "usage", id: "c-jp", m: 43, s: 48, tok: [80_000, 12_000, 4_000] },
  { op: "done", id: "c-jp", m: 43, s: 50, dur: 1_116_000 },
  { op: "usage", id: "c-cf", att: 3, m: 44, s: 3, tok: [100_000, 12_000, 6_000] },
  { op: "done", id: "c-cf", att: 3, m: 44, s: 4, dur: 132_000, term: "completed" },
  { op: "sched", id: "c-sr", lbl: "synthesize:report", m: 44, s: 8 },
  { op: "start", id: "c-sr", m: 44, s: 10 },
  { op: "usage", id: "c-sr", m: 45, s: 8, tok: [30_000, 9_000, 2_000] },
  { op: "done", id: "c-sr", m: 45, s: 10, dur: 60_000 },
];

export function lanternDone(): Feed {
  const feed = lantern();
  executeScenario(feed, LANTERN_COMPLETION_ACTIONS);

  const completionPayload = {
    type: "workflow-launch-reconciled",
    call_id: CALL,
    final_summary: { status: "success", summary: "Recommend the CRDT ledger." },
    agents_activity: [{ agent: "c-fn", duration_ms: 720_000, tool_calls: 41 }],
  };
  const messageXml = `<workflow-launch-reconciled>${JSON.stringify(completionPayload)}</workflow-launch-reconciled>`;

  feed.emit(S(45, 10), "completed", {
    message: messageXml,
  });
  return feed;
}

export function approvalAt(at: number): ViewEvent {
  const commandSubject = { kind: "shell" as const, command: "npm test -- --run conflict" };
  const eventPayload: ViewEvent = {
    method: "approval/requested",
    at,
    params: {
      approvalId: "ap-1",
      sessionId: "s1",
      availableChoices: [],
      currentRequirementId: null,
      subject: commandSubject,
    },
  };
  return eventPayload;
}

export function fold(events: ViewEvent[], now = NOW): ThreadFold {
  const filteredEvents = events.filter((ev) => ev.at === undefined || ev.at <= now);
  return applyEvents(emptyFold(), filteredEvents);
}

export function lanternFold(now = NOW, extra: ViewEvent[] = [], feed: Feed = lantern()): ThreadFold {
  const stream: ViewEvent[] = [launch(), ...feed.events, ...extra];
  return fold(stream, now);
}

export function lanternRun(now = NOW, extra: ViewEvent[] = [], feed: Feed = lantern(), opts: CrewOptions = {}): RunVM {
  const foldedThread = lanternFold(now, extra, feed);
  const evaluation = crewView(foldedThread, SESSION, now, opts);
  const primaryRun = evaluation.runs[0];
  if (!primaryRun) {
    throw new Error("no run");
  }
  return primaryRun;
}

export function thread(extra: Partial<ThreadState> = {}): ThreadState {
  const baselineThread: ThreadState = {
    load: "ready",
    error: null,
    readOnly: false,
    readOnlyReason: null,
    truncated: false,
    fold: emptyFold(),
    attachments: [],
    shellRuns: [],
    researchRuns: [],
    stalled: false,
  };
  return Object.assign(baselineThread, extra);
}

export interface PanelSetup {
  fold?: ThreadFold;
  thread?: Partial<ThreadState>;
  prefs?: Partial<Prefs>;
  panel?: Partial<CrewPanelState>;
  state?: Partial<AppState>;
  session?: Partial<SessionSummary> | null;
}

export function panelStore(setup: PanelSetup = {}): Store<AppState> {
  const baseConfig = initialState(defaultPrefs("2026-09-26T00:00:00.000Z"));
  const configuredSession = setup.session === null
    ? undefined
    : Object.assign({}, SESSION, setup.session ?? {});

  const currentFold = setup.fold ?? lanternFold();
  const threadState = thread(Object.assign({ fold: currentFold }, setup.thread ?? {}));

  const panelOptions: CrewPanelState = Object.assign(
    {
      mode: "roster",
      inspectId: null,
      filter: "all",
      query: "",
      timelineOpen: true,
      openPhases: [],
    },
    setup.panel ?? {},
  );

  const completeState: AppState = {
    ...baseConfig,
    connection: "open",
    sessions: configuredSession ? { s1: configuredSession } : {},
    threads: { s1: threadState },
    prefs: { ...baseConfig.prefs, sidePanel: "crew", ...(setup.prefs ?? {}) },
    crew: {
      ...baseConfig.crew,
      panels: setup.panel ? { s1: panelOptions } : {},
    },
    ...(setup.state ?? {}),
  };

  return new Store<AppState>(completeState);
}

export function atNow<T>(pinnedClock: number, task: () => T): T {
  const nativeClock = Date.now;
  const mockClock = (): number => pinnedClock;
  Date.now = mockClock;
  let computationResult: T;
  try {
    computationResult = task();
  } finally {
    Date.now = nativeClock;
  }
  return computationResult;
}

export function renderWith(store: Store<AppState>, element: ReactElement, calls: string[] = []): string {
  const mockController = new Proxy({ store } as unknown as AncillaController, {
    get(target, propKey) {
      if (propKey in target) {
        return (target as unknown as Record<string | symbol, unknown>)[propKey];
      }
      return (...args: unknown[]) => {
        const repr = args.map((arg) => (typeof arg === "object" ? "…" : String(arg))).join(", ");
        calls.push(`${String(propKey)}(${repr})`);
      };
    },
  });

  const wrapped = createElement(ControllerProvider, {
    controller: mockController,
    children: createElement(TooltipProvider, { children: element }),
  });
  return renderToStaticMarkup(wrapped);
}

export function renderPanel(setup: PanelSetup = {}, now = NOW): string {
  return atNow(now, () => {
    const store = panelStore(setup);
    const comp = createElement(CrewPanel, { sessionId: "s1" });
    return renderWith(store, comp);
  });
}

const ODOMETER_PATTERN = /<span class="inline-flex tabular-nums[^"]*" aria-label="([^"]*)">(?:<span aria-hidden="true" class="whitespace-pre">[^<]*<\/span>)*<\/span>/g;

const HTML_ENTITY_LOOKUP: Record<string, string> = {
  "&#x27;": "'",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

export function textOf(markup: string): string {
  const flattened = markup.replace(ODOMETER_PATTERN, "$1").replace(/<[^>]+>/g, " ");
  const decoded = flattened.replace(/&(?:#x27|quot|lt|gt|amp);/g, (tag) => HTML_ENTITY_LOOKUP[tag] || tag);
  return decoded.replace(/\s+/g, " ").trim();
}

export function digits(markup: string): string[] {
  const extracted: string[] = [];
  for (const m of markup.matchAll(ODOMETER_PATTERN)) {
    extracted.push(m[1] as string);
  }
  return extracted;
}

export function rowTag(markup: string, id: string): string {
  const safeId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<div role="row" id="crew-row-${safeId}"[^>]*>`);
  const match = pattern.exec(markup);
  return match ? match[0] : "";
}

export function kpi(markup: string, key: string): string {
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<div role="listitem" data-kpi="${safeKey}"[\\s\\S]*?</div></div>`);
  const match = pattern.exec(markup);
  return match ? match[0] : "";
}

export function attrs(markup: string, name: string): string[] {
  const pattern = new RegExp(`${name}="([^"]*)"`, "g");
  const values: string[] = [];
  for (const m of markup.matchAll(pattern)) {
    values.push(m[1] as string);
  }
  return values;
}
