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

/**
 * The design's scenario for the panel tests: project lantern, run offline-sync-research-design, viewed 41m 16s in.
 * Mirrors the feed the model's own tests build, so the panel is checked against the numbers the model reports.
 */

/** The run started at 14:02:00 UTC; every time below is minutes and seconds into it. */
export const T0 = Date.UTC(2026, 8, 26, 14, 2, 0);
export const S = (m: number, s = 0): number => T0 + (m * 60 + s) * 1000;
export const MIN = 60_000;
export const NOW = S(41, 16);

export const SESSION: SessionSummary = {
  sessionId: "s1", cwd: "/work/lantern", title: "Design the offline sync engine", titleSource: "auto", turnCount: 3, modelId: "muse-spark-1.3",
  origin: "ancilla", archived: false, createdAt: "2026-09-26T13:00:00.000Z", activityAt: "2026-09-26T14:40:00.000Z", settled: false, settledAt: null,
  unsettledAt: null, sandboxDisabled: false, accountId: null, live: { activeTurnId: "t1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
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

/** The same run once everyone landed: the failed agent retried by hand and landed on attempt 3, the rest finished. */
export function lanternDone(): Feed {
  const feed = lantern();
  feed.retry("c-cf", 3, S(41, 50), "design:conflict-ledger");
  feed.set("c-cf", { status: "started" }, S(41, 52), 3);
  feed.finish("c-jc", S(42, 34), 1_040_000);
  feed.usage("c-jp", { inputTokens: 80_000, outputTokens: 12_000, reasoningTokens: 4_000 }, S(43, 48));
  feed.finish("c-jp", S(43, 50), 1_116_000);
  feed.usage("c-cf", { inputTokens: 100_000, outputTokens: 12_000, reasoningTokens: 6_000 }, S(44, 3), 3);
  feed.finish("c-cf", S(44, 4), 132_000, "completed", 3);
  feed.schedule("c-sr", "synthesize:report", S(44, 8));
  feed.set("c-sr", { status: "started" }, S(44, 10));
  feed.usage("c-sr", { inputTokens: 30_000, outputTokens: 9_000, reasoningTokens: 2_000 }, S(45, 8));
  feed.finish("c-sr", S(45, 10), 60_000);
  feed.emit(S(45, 10), "completed", {
    message: `<workflow-launch-reconciled>${JSON.stringify({ type: "workflow-launch-reconciled", call_id: CALL, final_summary: { status: "success", summary: "Recommend the CRDT ledger." }, agents_activity: [{ agent: "c-fn", duration_ms: 720_000, tool_calls: 41 }] })}</workflow-launch-reconciled>`,
  });
  return feed;
}

/** An approval raised at 39m 36s during Judge, the run-level request of the scenario. */
export function approvalAt(at: number): ViewEvent {
  return {
    method: "approval/requested",
    at,
    params: { approvalId: "ap-1", sessionId: "s1", availableChoices: [], currentRequirementId: null, subject: { kind: "shell", command: "npm test -- --run conflict" } },
  };
}

export function fold(events: ViewEvent[], now = NOW): ThreadFold {
  return applyEvents(emptyFold(), events.filter((event) => event.at === undefined || event.at <= now));
}

/** The lantern thread's fold as it stood at `now`. */
export function lanternFold(now = NOW, extra: ViewEvent[] = [], feed: Feed = lantern()): ThreadFold {
  return fold([launch(), ...feed.events, ...extra], now);
}

export function lanternRun(now = NOW, extra: ViewEvent[] = [], feed: Feed = lantern(), opts: CrewOptions = {}): RunVM {
  const run = crewView(lanternFold(now, extra, feed), SESSION, now, opts).runs[0];
  if (!run) throw new Error("no run");
  return run;
}

export function thread(extra: Partial<ThreadState> = {}): ThreadState {
  return { load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(), attachments: [], shellRuns: [], researchRuns: [], stalled: false, ...extra };
}

export interface PanelSetup {
  fold?: ThreadFold;
  thread?: Partial<ThreadState>;
  prefs?: Partial<Prefs>;
  panel?: Partial<CrewPanelState>;
  state?: Partial<AppState>;
  session?: Partial<SessionSummary> | null;
}

/** A store with the lantern thread open and the panel's prefs and state as given. */
export function panelStore(setup: PanelSetup = {}): Store<AppState> {
  const base = initialState(defaultPrefs("2026-09-26T00:00:00.000Z"));
  const session = setup.session === null ? undefined : { ...SESSION, ...(setup.session ?? {}) };
  const state: AppState = {
    ...base,
    connection: "open",
    sessions: session ? { s1: session } : {},
    threads: { s1: thread({ fold: setup.fold ?? lanternFold(), ...(setup.thread ?? {}) }) },
    prefs: { ...base.prefs, sidePanel: "crew", ...(setup.prefs ?? {}) },
    crew: { ...base.crew, panels: setup.panel ? { s1: { mode: "roster", inspectId: null, filter: "all", query: "", timelineOpen: true, openPhases: [], ...setup.panel } } : {} },
    ...(setup.state ?? {}),
  };
  return new Store<AppState>(state);
}

/** Runs `fn` with `Date.now()` pinned, so a live view reads its clocks at the scenario's moment. */
export function atNow<T>(now: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** Server-renders an element inside the providers the components expect, with a store-only controller. */
export function renderWith(store: Store<AppState>, element: ReactElement, calls: string[] = []): string {
  const controller = new Proxy({ store } as unknown as AncillaController, {
    get(target, key) {
      if (key in target) return (target as unknown as Record<string | symbol, unknown>)[key];
      return (...args: unknown[]) => calls.push(`${String(key)}(${args.map((arg) => (typeof arg === "object" ? "…" : String(arg))).join(", ")})`);
    },
  });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: element }) }));
}

/** The panel's markup for a setup, rendered at the scenario's clock. */
export function renderPanel(setup: PanelSetup = {}, now = NOW): string {
  return atNow(now, () => renderWith(panelStore(setup), createElement(CrewPanel, { sessionId: "s1" })));
}

const ODOMETER = /<span class="inline-flex tabular-nums[^"]*" aria-label="([^"]*)">(?:<span aria-hidden="true" class="whitespace-pre">[^<]*<\/span>)*<\/span>/g;

/** Markup as text: odometers read as their value, tags become spaces, entities are decoded, whitespace collapses. */
export function textOf(markup: string): string {
  return markup
    .replace(ODOMETER, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The values the odometer digits carry, in order: each `RollingDigits` labels itself with its whole value. */
export function digits(markup: string): string[] {
  return [...markup.matchAll(ODOMETER)].map((m) => m[1] as string);
}

/** A roster row's opening tag, by id. */
export function rowTag(markup: string, id: string): string {
  return new RegExp(`<div role="row" id="crew-row-${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`).exec(markup)?.[0] ?? "";
}

/** One KPI cell's markup by key. */
export function kpi(markup: string, key: string): string {
  const match = new RegExp(`<div role="listitem" data-kpi="${key}"[\\s\\S]*?</div></div>`).exec(markup);
  return match?.[0] ?? "";
}

/** Attribute values in document order. */
export function attrs(markup: string, name: string): string[] {
  return [...markup.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1] as string);
}
