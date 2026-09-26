/**
 * The demo's fictional workspace: three sample projects under /home/demo and the threads in them.
 * Every name, path, file and number here is made up. Times are relative to when the page loads, so
 * the sidebar always reads "just now", "2 hours ago" and so on.
 *
 * The audit thread plays the agents scenario `?swarm=` names: a native workflow of ten agents in four
 * phases (or two thousand in eight, or none and three background tasks), written out as the revisions
 * Muse sends, so the Swarm card, panel and drawer read the same wire here as against a real run.
 */
import type { ApprovalRequest, LiveView, MspItem, ResearchConfig, ResearchRunView, SessionSummary, TokenUsage, ViewEvent, WorkflowChild } from "@ancilla/ui";
import { DAY, HOUR, MIN, MODEL, Script, iso, sampleId } from "./script.js";

export const HOME = "/home/demo";

export const PROJECTS = {
  atlas: `${HOME}/code/atlas-api`,
  lumen: `${HOME}/code/lumen-web`,
  /** A second folder of the lumen-web project, so the demo shows a project with several folders. */
  lumenSite: `${HOME}/code/lumen-site`,
  orbit: `${HOME}/code/orbit-cli`,
} as const;

/** Thread ids, fixed so a `#/t/<id>` link keeps working across reloads. */
export const THREADS = {
  audit: "01a0f3c4-6d2e-7b1a-8c3f-5e9d2a7b4c10",
  pagination: "01a0f2b8-1c4d-7e2f-9a3b-6c8d4e2f1a07",
  contrast: "01a0f3d1-8e5a-7c2b-b4d6-2f9e1a3c5b88",
  lazyCharts: "01a0f3b9-2a7c-7d4e-8f1b-9c3e5a7d2b46",
  statusJson: "01a0f2e0-5b3d-7a9c-a2e4-1d6f8b3c7e21",
  syncHang: "01a0ef41-9d2c-7b5e-8a3f-4c1e7b9d2a63",
  rateLimit: "01a0ed12-3f8b-7c1d-9e4a-6b2d8f1c3a95",
  vite: "01a0e8a7-7c1e-7f3b-b5d2-8e4a1c6f9b30",
  research: "01a0f3e2-4b7d-7a1c-9e5f-3d8b6c2a4f19",
} as const;

/** The two research runs the research thread carries: the finished one and the one still out. */
export const RESEARCH_RUNS = {
  done: "01a0f3e3-1c2d-7e4f-8a6b-5d9c3e7f1b28",
  running: "01a0f3e5-6d8e-7f1a-9b2c-7e4d1f8a3c56",
} as const;

/** The second account the settings page lists; orbit-cli's threads run under it. */
export const SIDE_ACCOUNT = "side";

/**
 * What the audit thread shows of its agents. `running` is the design's scenario, 41m 16s into a run of ten
 * agents in four phases; the others isolate one condition each, so every state the card, the panel and
 * the drawer can show has a page to load.
 */
export const SCENARIOS = ["running", "stalled", "failed", "waiting", "partial", "reconnect", "done", "big", "task"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: string | null | undefined): value is Scenario {
  return typeof value === "string" && (SCENARIOS as readonly string[]).includes(value);
}

export interface SeedThread {
  summary: SessionSummary;
  events: ViewEvent[];
  /** The view cursor's sequence so far; live events continue it. */
  seq: number;
  approvals: ApprovalRequest[];
  /** The history was cut by the page cap, so its earliest revisions are missing. */
  truncated?: boolean;
}

/** One try of a workflow agent: the moments Muse reported, each absent until it happened. */
export interface AuditAttempt {
  attempt: number;
  scheduledAt: number;
  startedAt?: number;
  /** Muse reports the agent's tokens once, on the revision before it ends. */
  usageAt?: number;
  usage?: TokenUsage;
  endedAt?: number;
  terminal?: "completed" | "failed" | "cancelled";
  /** Muse's own figure for how long the attempt ran, sent with its end. */
  durationMs?: number;
}

export interface AuditChild {
  childId: string;
  label: string;
  /** Oldest first; the last is the attempt the agent is on. */
  attempts: AuditAttempt[];
  /** Tool calls, which Muse reports for workflow agents only when the run ends. */
  toolCalls: number;
}

export interface PlannedAgent {
  label: string;
  input: string;
}

/** The native Muse workflow running in the audit thread, as the one item Muse revises as it goes. */
export interface AuditRun {
  sessionId: string;
  turnId: string;
  itemId: string;
  callId: string;
  runId: string;
  /** The launch's `name`, which Muse echoes as the item's `entryId`. */
  name: string;
  scriptId: string;
  /** The agents the launch script names, in order, with the input each is given. */
  plan: PlannedAgent[];
  startedAt: number;
  endedAt: number | null;
  status: "inProgress" | "completed" | "cancelled";
  /** The newest revision's number and time; the live client continues from here. */
  revision: number;
  revisedAt: number;
  children: AuditChild[];
  /** The report on the wire once the run has ended, and the one it attaches when it does. */
  summary: string | null;
  report: string;
  /** What Muse says of the last failure when the run ends with an agent still failed. */
  failure: string;
  /** Files the run hands back, named on the terminal revision. */
  handoffs: { agent: string; description: string }[];
  /** What the lead says when the run is stopped. */
  stoppedReply: string;
}

/** Output a running background task still has to print; the live client streams it. */
export interface TaskStream {
  sessionId: string;
  itemId: string;
  lines: string[];
}

export interface Seed {
  threads: SeedThread[];
  audit: AuditRun | null;
  streams: TaskStream[];
  /** DeepResearch runs the demo client serves and, for the one still running, carries on. */
  research: ResearchRunView[];
}

interface Timed {
  at: number;
  method: string;
  params: Record<string, unknown>;
}

function live(patch: Partial<LiveView> = {}): LiveView {
  return {
    activeTurnId: null,
    turnStartedAt: null,
    pendingApprovals: 0,
    pendingInputs: 0,
    lastTerminal: "completed",
    lastError: null,
    ...patch,
  };
}

function thread(
  script: Script,
  title: string,
  turnCount: number,
  extra: Partial<SessionSummary> = {},
  approvals: ApprovalRequest[] = [],
): SeedThread {
  const first = script.events[0]?.at ?? script.at;
  return {
    summary: {
      sessionId: script.sessionId,
      cwd: script.cwd,
      title,
      titleSource: "auto",
      turnCount,
      modelId: MODEL,
      origin: "ancilla",
      archived: false,
      createdAt: iso(first),
      activityAt: iso(script.at),
      settled: false,
      settledAt: null,
      unsettledAt: null,
      sandboxDisabled: false,
      accountId: null,
      live: live(),
      ...extra,
    },
    events: script.events,
    seq: script.seq,
    approvals,
  };
}

/** Milliseconds into the run, as the design's scenario counts its moments. */
function into(minutes: number, seconds = 0): number {
  return Math.round((minutes * 60 + seconds) * 1000);
}

/** A token count split the way Muse reports an agent's usage: mostly prompt, part of that cached. */
export function tokensOf(total: number): TokenUsage {
  const inputTokens = Math.round(total * 0.81);
  const outputTokens = Math.round(total * 0.12);
  const cached = Math.round(inputTokens * 0.6);
  return { inputTokens, outputTokens, reasoningTokens: total - inputTokens - outputTokens, cachedTokens: cached, cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/** A workflow agent's id: a UUIDv7 whose first 48 bits carry its scheduling time, as Muse's child ids do. */
export function childIdFor(sessionId: string, label: string, scheduledAt: number): string {
  const time = Math.max(0, Math.floor(scheduledAt)).toString(16).padStart(12, "0").slice(-12);
  return `${time.slice(0, 8)}-${time.slice(8)}-${sampleId(`${sessionId}:agent:${label}`).slice(14)}`;
}

function reconciledMessage(body: Record<string, unknown>): string {
  return `<workflow-launch-reconciled>${JSON.stringify(body)}</workflow-launch-reconciled>`;
}

/** What each agent got on the previous revision: its entry, reused when nothing changed, and whether its usage went out. */
export type ChildCache = Map<string, { key: string; child: WorkflowChild; usageSent: boolean }>;

/**
 * The run's agents as Muse lists them at `at`: one entry per agent for the attempt it is on, with the
 * status its moments give it. The label rides only on the first revision that lists the attempt and the
 * usage only on the first that could report it, as on the wire. The cache remembers what went out, so
 * two revisions in the same instant still say each thing once; without one, `since` (the previous
 * revision's time) decides. An entry that reads as it did last time keeps its object, so a big run's
 * history shares most of its children.
 */
export function childrenAt(run: AuditRun, at: number, since: number, cache?: ChildCache): WorkflowChild[] {
  const children: WorkflowChild[] = [];
  for (const child of run.children) {
    let current: AuditAttempt | null = null;
    for (const attempt of child.attempts) {
      if (attempt.scheduledAt <= at) {
        current = attempt;
      }
    }
    if (!current) {
      continue;
    }
    const kept = cache?.get(child.childId);
    const fresh = cache ? kept === undefined || kept.child.attempt !== current.attempt : since < current.scheduledAt;
    const next: WorkflowChild = { childId: child.childId, attempt: current.attempt, status: "scheduled" };
    if (fresh) {
      next.label = child.label;
    }
    if (current.endedAt !== undefined && current.endedAt <= at) {
      next.status = "terminal";
      next.terminal = current.terminal;
      if (current.durationMs !== undefined) {
        next.durationMs = current.durationMs;
      }
    } else if (current.usageAt !== undefined && current.usageAt <= at) {
      next.status = "usage";
    } else if (current.startedAt !== undefined && current.startedAt <= at) {
      next.status = "started";
    }
    const reportable = current.usage !== undefined && current.usageAt !== undefined && current.usageAt <= at;
    const usageSent = !fresh && kept !== undefined && kept.usageSent;
    if (reportable && (cache ? !usageSent : since < (current.usageAt as number))) {
      next.usage = current.usage;
    }
    const key = `${next.attempt}|${next.status}|${next.terminal ?? ""}|${next.durationMs ?? ""}|${next.label ? 1 : 0}|${next.usage ? 1 : 0}`;
    if (kept && kept.key === key) {
      children.push(kept.child);
    } else {
      cache?.set(child.childId, { key, child: next, usageSent: usageSent || next.usage !== undefined });
      children.push(next);
    }
  }
  return children;
}

/** The workflow item at one revision: what the fold folds and the Swarm surfaces read. */
export function auditItem(run: AuditRun, at: number, since: number, revision: number, cache?: ChildCache): MspItem {
  const ended = run.endedAt !== null && at >= run.endedAt;
  const item: MspItem = {
    itemId: run.itemId,
    kind: "workflow",
    status: ended ? run.status : "inProgress",
    revision,
    turnId: run.turnId,
    recordedAt: iso(at),
    entryId: run.name,
    scriptId: run.scriptId,
    triggerSource: "guidanceAuto",
    workflowRunId: run.runId,
    fallbackText: `Workflow: ${run.name}`,
    children: childrenAt(run, at, since, cache),
  };
  if (ended) {
    // Run-level facts travel only on the terminal revision: per-agent totals, the report and the last failure.
    const failed = run.children.some((child) => child.attempts[child.attempts.length - 1]?.terminal === "failed");
    item.message = reconciledMessage({
      type: "workflow-launch-reconciled",
      call_id: run.callId,
      route: "guidance",
      launch_admitted: true,
      deferred_to_background: false,
      agents_activity: run.children.map((child) => {
        const last = child.attempts[child.attempts.length - 1];
        return { agent: child.childId, duration_ms: last?.durationMs ?? 0, tool_calls: child.toolCalls };
      }),
      final_summary: run.summary ? { status: "success", summary: run.summary } : null,
      latest_failure: failed ? run.failure : null,
      workspace_handoffs: run.summary ? run.handoffs : [],
    });
  }
  return item;
}

/** Every revision of the run up to `until`: one per moment an agent or the run itself changed, as Muse sent them. */
export function auditHistory(run: AuditRun, until: number): { at: number; method: string; item: MspItem }[] {
  const moments = new Set<number>([run.startedAt]);
  for (const child of run.children) {
    for (const attempt of child.attempts) {
      for (const at of [attempt.scheduledAt, attempt.startedAt, attempt.usageAt, attempt.endedAt]) {
        if (at !== undefined) {
          moments.add(at);
        }
      }
    }
  }
  if (run.endedAt !== null) {
    moments.add(run.endedAt);
  }
  const cache: ChildCache = new Map();
  let since = Number.NEGATIVE_INFINITY;
  return [...moments]
    .filter((at) => at <= until)
    .sort((a, b) => a - b)
    .map((at, index) => {
      const item = auditItem(run, at, since, index + 1, cache);
      since = at;
      return { at, method: index === 0 ? "item/started" : "item/updated", item };
    });
}

interface PlannedPhase {
  comment: string;
  agents: PlannedAgent[];
}

/** The generated script Muse ran, as it reads on the wire: one `host.parallel` literal per phase. Never evaluated here. */
function workflowScript(phases: PlannedPhase[]): string {
  const names = ["findings", "checks", "verdicts"];
  const lines = ["export default async function workflow(host) {"];
  phases.forEach((phase, index) => {
    const carry = index > 0 ? `, { ${names[index - 1] ?? `step${index - 1}`} }` : "";
    const last = index === phases.length - 1;
    lines.push(`  // ${phase.comment}`);
    lines.push(`  ${last ? "return" : `const ${names[index] ?? `step${index}`} =`} await host.parallel([`);
    for (const agent of phase.agents) {
      lines.push(`    { label: ${JSON.stringify(agent.label)}, input: ${JSON.stringify(agent.input)} },`);
    }
    lines.push(`  ]${carry});`);
  });
  lines.push("}");
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------- the audit run

const RUN_NAME = "v2-breaking-change-audit";
const LAUNCH_CALL = "call_01a0f3c4e7b2";

const AUDIT_PLAN: PlannedPhase[] = [
  {
    comment: "Four auditors read the diff side by side, one area each.",
    agents: [
      { label: "audit:routes", input: "Read every route handler that changed since v1.9.0 and list what a v1 client would notice: removed routes, renamed fields, new required parameters." },
      { label: "audit:schema", input: "Diff openapi/v2.yaml against v1.9.0 and list removed or renamed paths, parameters and properties, and any enum whose values changed." },
      { label: "audit:sdk", input: "Type-check the v1.9 SDK examples against sdk/typescript and list the calls that no longer compile or whose result shape changed." },
      { label: "audit:migrations", input: "Read migrations 0042 and 0043 and list every table, column or constraint a v1.9.0 deployment loses." },
    ],
  },
  {
    comment: "Each suspected break is then reproduced.",
    agents: [
      { label: "verify:sdk-examples", input: "Run the v1.9 SDK examples against a v2 server and record which calls fail and how." },
      { label: "verify:webhooks", input: "Replay the recorded webhook payloads through the v2 handlers and diff the responses against v1.9.0." },
      { label: "verify:migration-replay", input: "Replay migrations 0042 and 0043 on a v1.9.0 database snapshot and check that every row survives with the same values." },
    ],
  },
  {
    comment: "Two judges weigh what was confirmed.",
    agents: [
      { label: "judge:severity", input: "Rate each confirmed change as breaking, behavioural or additive, with the evidence behind each rating." },
      { label: "judge:compat", input: "For each breaking change, say whether a compatibility shim could keep v1 clients working and what it would cost." },
    ],
  },
  {
    comment: "One agent writes it up.",
    agents: [
      { label: "report:release-notes", input: "Write the breaking-changes section of the v2.0 release notes from the verdicts: one entry per change, with the migration step." },
    ],
  },
];

/** The report the last agent writes, once the run is allowed to finish. */
export const AUDIT_SUMMARY = [
  "## Breaking changes since v1.9.0",
  "",
  "1. **`GET /v1/orders` pages with a cursor.** `page` is ignored; clients must follow `nextCursor`.",
  "2. **`Order.total` is an object** (`{ amount, currency }`) instead of a number of cents.",
  "3. **`DELETE /v1/tokens/legacy` is gone**, along with the `legacy_tokens` table.",
  "",
  "Webhook payloads and every other route are unchanged.",
].join("\n");

/** What Muse reports of the last failure when the run ends with the migration replay still failed. */
export const REPLAY_FAILURE = "verify:migration-replay: pg_restore exited with status 1: could not open input file fixtures/db/atlas-v1.9.0.dump";

const AUDIT_HANDOFFS = [{ agent: "report:release-notes", description: "docs/releases/v2.0.md: the breaking-changes section, ready to paste" }];

const AUDIT_STOPPED =
  "Stopped the audit. The four audits and two of the three checks had finished: `DELETE /v1/tokens/legacy` is gone, `Order.total` became `{ amount, currency }` and `GET /v1/orders` pages with a cursor. The judges did not complete, so the report is not final.";

const AUDIT_PROMPT =
  "We're about to tag v2.0. Audit everything that changed since v1.9.0 for breaking changes: route handlers, the OpenAPI schema, the TypeScript SDK and the database migrations. Run the checks in parallel and give me one report I can paste into the release notes.";

/** The moments of the design's run, in milliseconds into it, with what each scenario changes. */
function auditChildren(sessionId: string, t0: number, scenario: Scenario): AuditChild[] {
  const replayUsage: TokenUsage = { inputTokens: 52_100, outputTokens: 6_400, reasoningTokens: 5_700, cachedTokens: 31_300, cacheReadTokens: 31_300, cacheWriteTokens: 0 };
  const landed = (attempt: number, scheduled: number, started: number, ended: number, tokens: number, usageAt = ended - 2000): AuditAttempt => ({
    attempt, scheduledAt: scheduled, startedAt: started, usageAt, usage: tokensOf(tokens), endedAt: ended, terminal: "completed", durationMs: ended - started,
  });
  const failed = (attempt: number, scheduled: number, started: number, ended: number, usage?: TokenUsage): AuditAttempt => ({
    attempt, scheduledAt: scheduled, startedAt: started, ...(usage ? { usageAt: ended - 1000, usage } : {}), endedAt: ended, terminal: "failed", durationMs: ended - started,
  });
  const working = (scheduled: number, started: number, usage?: { at: number; tokens: number }): AuditAttempt => ({
    attempt: 1, scheduledAt: scheduled, startedAt: started, ...(usage ? { usageAt: usage.at, usage: tokensOf(usage.tokens) } : {}),
  });
  // The migration replay failed twice: once on its own, once after Muse's own retry, with usage reported for both.
  const replayTries = [failed(1, into(12, 10), into(12, 12), into(14, 20)), failed(2, into(14, 21), into(14, 22), into(18, 13), replayUsage)];
  const replayLanded = [replayTries[0] as AuditAttempt, { ...landed(2, into(14, 21), into(14, 22), into(18, 13), 64_200, into(18, 12)), usage: replayUsage }];
  const severityFinishing = working(into(25, 12), into(25, 14), { at: into(40, 23), tokens: 148_000 });
  const compatSilent = working(into(25, 12), into(25, 14));
  const compatFinishing = working(into(25, 12), into(25, 14), { at: into(40, 58), tokens: 96_000 });
  let replay = replayTries;
  let severity = severityFinishing;
  let compat = compatSilent;
  let report: AuditAttempt[] = [];
  switch (scenario) {
    case "stalled":
      replay = replayLanded;
      severity = landed(1, into(25, 12), into(25, 14), into(36, 30), 148_000);
      break;
    case "failed":
      compat = compatFinishing;
      break;
    case "waiting":
      replay = replayLanded;
      compat = compatFinishing;
      break;
    case "done":
      // You retried the replay at 41m 52s and it landed on attempt 3; everyone else landed on their own.
      replay = [...replayTries, landed(3, into(41, 52), into(41, 54), into(44, 4), 118_000)];
      severity = landed(1, into(25, 12), into(25, 14), into(42, 34), 148_000, into(40, 23));
      compat = landed(1, into(25, 12), into(25, 14), into(43, 50), 96_000);
      report = [landed(1, into(44, 8), into(44, 10), into(45, 10), 41_000)];
      break;
    default:
      break;
  }
  const specs: [string, number, AuditAttempt[]][] = [
    ["audit:routes", 41, [landed(1, into(0), into(0, 4), into(12, 4), 288_000)]],
    ["audit:schema", 27, [landed(1, into(0, 0.4), into(0, 4), into(8, 19), 164_000)]],
    ["audit:sdk", 19, [landed(1, into(0, 0.4), into(0, 5), into(5, 35), 112_000)]],
    ["audit:migrations", 14, [landed(1, into(0, 0.4), into(0, 5), into(4, 7), 96_000)]],
    ["verify:sdk-examples", 84, [landed(1, into(12, 10), into(12, 12), into(24, 52), 236_000)]],
    ["verify:webhooks", 33, [landed(1, into(12, 10), into(12, 12), into(21, 24), 168_000)]],
    ["verify:migration-replay", 22, replay],
    ["judge:severity", 58, [severity]],
    ["judge:compat", 47, [compat]],
  ];
  if (report.length > 0) {
    specs.push(["report:release-notes", 9, report]);
  }
  return materialize(sessionId, t0, specs);
}

/** Agents written in milliseconds into the run, placed at the run's real start. */
function materialize(sessionId: string, t0: number, specs: [string, number, AuditAttempt[]][]): AuditChild[] {
  return specs.map(([label, toolCalls, attempts]) => ({
    childId: childIdFor(sessionId, label, t0 + (attempts[0] as AuditAttempt).scheduledAt),
    label,
    toolCalls,
    attempts: attempts.map((attempt) => {
      const moved: AuditAttempt = { ...attempt, scheduledAt: attempt.scheduledAt + t0 };
      if (attempt.startedAt !== undefined) moved.startedAt = attempt.startedAt + t0;
      if (attempt.usageAt !== undefined) moved.usageAt = attempt.usageAt + t0;
      if (attempt.endedAt !== undefined) moved.endedAt = attempt.endedAt + t0;
      return moved;
    }),
  }));
}

// ------------------------------------------------------------------------------- background tasks

const E2E_COMMAND = "npm run test:e2e -- --grep orders";
const E2E_CALL = "call_01a0f3c4e2e0";
const E2E_HEAD = "> atlas-api@2.0.0-rc.1 test:e2e\n> playwright test --grep orders\n\nRunning 15 tests using 2 workers\n\n";
const E2E_TESTS: [string, string][] = [
  ["lists the newest orders first", "1.9s"],
  ["returns the first page with a next cursor", "1.2s"],
  ["follows the cursor without repeating rows", "2.8s"],
  ["caps limit at 200", "1.1s"],
  ["rejects a malformed cursor", "0.6s"],
  ["keeps page working as the first page", "0.9s"],
  ["returns totals as amount and currency", "1.4s"],
  ["filters by status", "1.7s"],
  ["sorts ties by id", "1.3s"],
  ["answers 401 without an API key", "0.4s"],
  ["answers 403 for another tenant's order", "0.8s"],
  ["paginates 1,000 orders without gaps", "6.2s"],
  ["pages with a cursor under load", "2.4s"],
  ["survives a cursor from the previous deploy", "2.8s"],
  ["rate-limits bursts of list calls", "3.1s"],
];

/** The suite's output after its header, one chunk at a time: a line per test, and past twelve a progress line after each. */
const E2E_CHUNKS: string[] = E2E_TESTS.flatMap(([name, took], index) => {
  const n = index + 1;
  const line = `  ✓  ${n} orders.spec.ts:${9 + n * 7}:3 › ${name} (${took})\n`;
  if (n < 12) {
    return [line];
  }
  const next = E2E_TESTS[n]?.[0];
  return [line, next ? `${n} passed · ${E2E_TESTS.length - n} pending · running "${next}"\n` : `\n  ${n} passed (4.1m)\n`];
});

/** What a task's output reads once its first `printed` chunks are out. */
function e2eOutput(printed: number): string {
  return E2E_HEAD + E2E_CHUNKS.slice(0, printed).join("");
}

interface TaskShape {
  itemId: string;
  command: string;
  description: string;
  callId: string;
  turnId: string;
}

/** A background task's events: started, output as it printed, sent to the background, and its end if it had one. */
function taskEvents(
  shape: TaskShape,
  moments: { startedAt: number; outputs: { at: number; text: string }[]; backgroundedAt?: number; initiator?: "user" | "timeout"; endedAt?: number; ending?: Partial<MspItem> },
): Timed[] {
  const base = { itemId: shape.itemId, kind: "toolCall", tool: "bash", callId: shape.callId, args: JSON.stringify({ command: shape.command, description: shape.description }), turnId: shape.turnId };
  const timed: Timed[] = [{ at: moments.startedAt, method: "item/started", params: { item: { ...base, status: "inProgress", revision: 1, recordedAt: iso(moments.startedAt) } } }];
  let output = "";
  let backgrounded = moments.backgroundedAt === undefined;
  for (const chunk of moments.outputs) {
    if (!backgrounded && moments.backgroundedAt !== undefined && chunk.at >= moments.backgroundedAt) {
      backgrounded = true;
      timed.push({
        at: moments.backgroundedAt,
        method: "item/updated",
        params: { item: { ...base, status: "inProgress", revision: 2, background: true, backgroundInitiator: moments.initiator ?? "user", visibleOutput: output, recordedAt: iso(moments.backgroundedAt) } },
      });
    }
    output += chunk.text;
    timed.push({ at: chunk.at, method: "item/delta", params: { itemId: shape.itemId, field: "output", delta: chunk.text, turnId: shape.turnId } });
  }
  if (!backgrounded && moments.backgroundedAt !== undefined) {
    timed.push({
      at: moments.backgroundedAt,
      method: "item/updated",
      params: { item: { ...base, status: "inProgress", revision: 2, background: true, backgroundInitiator: moments.initiator ?? "user", visibleOutput: output, recordedAt: iso(moments.backgroundedAt) } },
    });
  }
  if (moments.endedAt !== undefined) {
    const background = moments.backgroundedAt !== undefined ? { background: true, backgroundInitiator: moments.initiator ?? "user" } : {};
    timed.push({
      at: moments.endedAt,
      method: "item/completed",
      params: { item: { ...base, status: "completed", revision: 3, ...background, visibleOutput: output, recordedAt: iso(moments.endedAt), ...moments.ending } },
    });
  }
  return timed;
}

function shellApproval(sessionId: string, seedKey: string, itemId: string, turnId: string, callId: string, command: string, rulePreview: string): ApprovalRequest {
  return {
    approvalId: sampleId(`${sessionId}:approval:${seedKey}`),
    sessionId,
    itemId,
    turnId,
    toolName: "bash",
    toolCallId: callId,
    currentRequirementId: "req-1",
    subject: { kind: "shell", command, workspaceRoot: PROJECTS.atlas },
    availableChoices: [
      { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview },
      { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
      { choiceId: "reject", label: "Reject", decision: "denied", scope: "once", acceptsFeedback: true },
    ],
  };
}

// ------------------------------------------------------------------------------------------ threads

/**
 * The audit thread: the prompt, the scoping, the launch, then the run's revisions as they came, with the
 * request Muse raised and the task you backgrounded while it ran. `done` is the same run seen after it landed.
 */
function auditThread(now: number, scenario: Scenario): { thread: SeedThread; run: AuditRun; streams: TaskStream[] } {
  const finished = scenario === "done";
  const t0 = now - (finished ? into(45, 50) : into(41, 16));
  const s = new Script(THREADS.audit, PROJECTS.atlas, t0 - 11_400, { branch: "release/v2.0" });
  const turnId = s.begin(AUDIT_PROMPT);
  s.think(
    "**Splitting the audit**\n\nThe four areas are independent, so they can run side by side: routes, schema, SDK and migrations. Each finding then gets reproduced, two judges weigh what held up, and a last agent writes the release-note wording.",
    2600,
  );
  s.todos([
    { text: "Scope the diff since v1.9.0", status: "inProgress", activeForm: "Scoping the diff since v1.9.0" },
    { text: "Audit routes, schema, SDK and migrations in parallel", status: "pending" },
    { text: "Merge the findings into release-note wording", status: "pending" },
  ]);
  s.tool(
    "bash",
    { command: "git diff --stat v1.9.0..HEAD -- src openapi sdk migrations", description: "See what changed since v1.9.0" },
    [
      " migrations/0042_orders_currency.sql    |  18 +++",
      " migrations/0043_drop_legacy_tokens.sql |   9 ++",
      " openapi/v2.yaml                        | 214 ++++++++++++-------",
      " sdk/typescript/src/client.ts           |  23 +--",
      " sdk/typescript/src/orders.ts           |  61 +++---",
      " src/routes/orders.ts                   |  74 ++++---",
      " src/routes/tokens.ts                   |  41 ++---",
      " src/routes/webhooks.ts                 |  36 +++-",
      " 8 files changed, 311 insertions(+), 165 deletions(-)",
      "",
    ].join("\n"),
    3100,
  );
  s.bill(38_400, 610);
  s.todos([
    { text: "Scope the diff since v1.9.0", status: "completed" },
    { text: "Audit routes, schema, SDK and migrations in parallel", status: "inProgress", activeForm: "Auditing routes, schema, SDK and migrations in parallel" },
    { text: "Merge the findings into release-note wording", status: "pending" },
  ]);
  const script = workflowScript(AUDIT_PLAN);
  s.tool(
    "workflow",
    { name: RUN_NAME, script },
    JSON.stringify({
      status: "admitted",
      maxParallelAgents: 16,
      policy: { childLimit: 16, tokenBudget: null },
      scriptPath: `${PROJECTS.atlas}/.muse/workflows/scripts/generated.workflow.${RUN_NAME}.js`,
      scriptBytes: script.length,
      hostApiVersion: 3,
    }),
    4200,
    { callId: LAUNCH_CALL },
  );
  s.bill(41_900, 1_240);

  const run: AuditRun = {
    sessionId: THREADS.audit,
    turnId,
    itemId: s.id("workflow"),
    callId: LAUNCH_CALL,
    runId: `workflow-run-model-tool-${LAUNCH_CALL}`,
    name: RUN_NAME,
    scriptId: `generated.workflow.${RUN_NAME}`,
    plan: AUDIT_PLAN.flatMap((phase) => phase.agents),
    startedAt: t0,
    endedAt: finished ? t0 + into(45, 10) : null,
    status: finished ? "completed" : "inProgress",
    revision: 0,
    revisedAt: t0,
    children: auditChildren(THREADS.audit, t0, scenario),
    summary: finished ? AUDIT_SUMMARY : null,
    report: AUDIT_SUMMARY,
    failure: REPLAY_FAILURE,
    handoffs: AUDIT_HANDOFFS,
    stoppedReply: AUDIT_STOPPED,
  };
  const timed: Timed[] = [];
  const history = auditHistory(run, now);
  for (const revision of history) {
    timed.push({ at: revision.at, method: revision.method, params: { item: revision.item } });
  }
  run.revision = history.length;
  run.revisedAt = history[history.length - 1]?.at ?? t0;

  // Muse asked to run the compatibility tests during Judge; no wire field says which agent wanted them.
  const pending: ApprovalRequest[] = [];
  const withRequest = scenario !== "stalled" && scenario !== "failed";
  if (withRequest) {
    const compatId = s.id("toolCall");
    const compatCall = "call_01a0f3c4c0a7";
    const compatCommand = "npm test -- test/sdk-compat.test.ts";
    const args = JSON.stringify({ command: compatCommand, description: "Run the v1 SDK compatibility tests" });
    const askedAt = t0 + into(39, 36);
    const approval = shellApproval(THREADS.audit, "compat", compatId, turnId, compatCall, compatCommand, "npm test *");
    timed.push({ at: askedAt, method: "item/started", params: { item: { itemId: compatId, kind: "toolCall", tool: "bash", callId: compatCall, args, status: "inProgress", revision: 1, turnId, recordedAt: iso(askedAt) } } });
    timed.push({ at: askedAt + 200, method: "approval/requested", params: approval as unknown as Record<string, unknown> });
    if (finished) {
      // Allowed 1m 40s later; the tests passed.
      const decidedAt = t0 + into(41, 16);
      timed.push({ at: decidedAt, method: "approval/resolved", params: { approvalId: approval.approvalId, decision: "approved", resolvedBy: "user" } });
      timed.push({
        at: t0 + into(41, 21),
        method: "item/completed",
        params: {
          item: {
            itemId: compatId, kind: "toolCall", tool: "bash", callId: compatCall, args, status: "completed", revision: 2, turnId, recordedAt: iso(t0 + into(41, 21)),
            visibleOutput: "\n> atlas-api@2.0.0-rc.1 test\n> vitest run test/sdk-compat.test.ts\n\n ✓ test/sdk-compat.test.ts (6 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n",
          },
        },
      });
    } else {
      pending.push(approval);
    }
  }

  // While the run went on you asked for the e2e suite, then sent it to the background.
  const streams: TaskStream[] = [];
  const withTask = withRequest;
  if (withTask) {
    const e2eId = s.id("toolCall");
    const steerAt = t0 + into(39, 45);
    timed.push({
      at: steerAt,
      method: "item/completed",
      params: { item: { itemId: s.id("userMessage"), kind: "userMessage", status: "completed", revision: 1, text: "While that runs, kick off the e2e suite for orders in the background so we know the RC still passes.", steered: true, turnId, recordedAt: iso(steerAt) } },
    });
    timed.push({
      at: t0 + into(39, 51),
      method: "item/completed",
      params: { item: { itemId: s.id("agentMessage"), kind: "agentMessage", status: "completed", revision: 1, text: "Starting the orders e2e suite; the audit carries on meanwhile.", turnId, recordedAt: iso(t0 + into(39, 51)) } },
    });
    // Twelve tests and a progress line by 41m 12s; in `waiting` the suite stopped at seven to ask for the network.
    const printed = scenario === "waiting" ? 7 : finished ? E2E_CHUNKS.length : 13;
    const outputs: { at: number; text: string }[] = [{ at: t0 + into(39, 55), text: E2E_HEAD }];
    E2E_CHUNKS.slice(0, printed).forEach((chunk, index) => {
      const at = index < 12 ? t0 + into(39, 58) + index * 6_000 : index === 12 ? t0 + into(41, 12) : t0 + into(41, 12) + (index - 12) * 20_000;
      outputs.push({ at, text: chunk });
    });
    const e2e: TaskShape = { itemId: e2eId, command: E2E_COMMAND, description: "Run the orders e2e suite", callId: E2E_CALL, turnId };
    timed.push(...taskEvents(e2e, { startedAt: t0 + into(39, 53), outputs, backgroundedAt: t0 + into(40, 20), initiator: "user", ...(finished ? { endedAt: t0 + into(43, 12) } : {}) }));
    if (scenario === "waiting") {
      const askedAt = t0 + into(40, 41);
      const network: ApprovalRequest = {
        approvalId: sampleId(`${THREADS.audit}:approval:e2e-network`),
        sessionId: THREADS.audit,
        itemId: e2eId,
        turnId,
        toolName: "bash",
        toolCallId: E2E_CALL,
        currentRequirementId: "req-net-1",
        subject: { kind: "network", host: "cdn.playwright.dev", port: 443, protocol: "https" },
        availableChoices: [
          { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
          { choiceId: "reject", label: "Reject", decision: "denied", scope: "once", acceptsFeedback: true },
        ],
      };
      timed.push({ at: askedAt, method: "approval/requested", params: network as unknown as Record<string, unknown> });
      pending.push(network);
    }
    if (!finished) {
      streams.push({ sessionId: THREADS.audit, itemId: e2eId, lines: E2E_CHUNKS.slice(printed) });
    }
  }

  if (finished) {
    const endedAt = run.endedAt as number;
    timed.push({
      at: endedAt + 1_000,
      method: "session/todoListChanged",
      params: {
        items: [
          { text: "Scope the diff since v1.9.0", status: "completed" },
          { text: "Audit routes, schema, SDK and migrations in parallel", status: "completed" },
          { text: "Merge the findings into release-note wording", status: "completed" },
        ],
      },
    });
    timed.push({ at: endedAt + 2_000, method: "item/completed", params: { item: { itemId: s.id("agentMessage"), kind: "agentMessage", status: "completed", revision: 1, text: AUDIT_SUMMARY, turnId, recordedAt: iso(endedAt + 2_000) } } });
    timed.push({ at: endedAt + 3_000, method: "turn/completed", params: { turnId, terminal: "completed", durationMs: endedAt + 3_000 - (t0 - 10_800), timeToFirstTokenMs: 1600 } });
  }

  timed.sort((a, b) => a.at - b.at);
  for (const event of timed) {
    s.pushAt(event.at, event.method, event.params);
  }
  const built = thread(
    s,
    "Audit the v2 API for breaking changes",
    1,
    { live: finished ? live() : live({ activeTurnId: turnId, turnStartedAt: iso(t0 - 10_800), pendingApprovals: pending.length, lastTerminal: null }) },
    pending,
  );
  if (scenario === "partial") {
    // The page cap cut the run's first revision, the only one that named audit:routes: the narrowest cut that
    // still shows every partial-history fallback, with the launch (and so the plan) still loaded.
    const index = built.events.findIndex((event) => (event.params["item"] as MspItem | undefined)?.itemId === run.itemId);
    if (index >= 0) {
      built.events.splice(index, 1);
    }
    built.truncated = true;
  }
  return { thread: built, run, streams };
}

const DOCS_COMMAND = "npm run docs:build";
const DIFF_COMMAND = "npx openapi-diff openapi/v1.9.0.yaml openapi/v2.yaml";

/** A thread with no workflow, only the release checks you asked for: three background tasks in three states. */
function tasksThread(now: number): { thread: SeedThread; streams: TaskStream[] } {
  const s = new Script(THREADS.audit, PROJECTS.atlas, now - 6 * MIN, { branch: "release/v2.0" });
  const turnId = s.begin(
    "Before we tag v2.0, run the docs build, the OpenAPI diff against v1.9.0 and the e2e suite for orders. Send anything slow to the background and tell me what finished.",
  );
  s.think("**Three checks that do not need each other**\n\nThe docs build and the e2e suite take minutes and the diff is quick, so the slow ones go first.", 2200);
  s.bill(21_300, 410);
  const ago = (minutes: number, seconds = 0) => now - into(minutes, seconds);
  const timed: Timed[] = [];
  // The docs build printed twice, was backgrounded when Muse stopped waiting for it, and has printed nothing since.
  const docsId = s.id("toolCall");
  timed.push(
    ...taskEvents(
      { itemId: docsId, command: DOCS_COMMAND, description: "Build the API reference", callId: "call_01a0f3c4d0c5", turnId },
      {
        startedAt: ago(5, 40),
        outputs: [
          { at: ago(5, 38), text: "> atlas-api@2.0.0-rc.1 docs:build\n> typedoc --out docs/api-ref src\n\n" },
          { at: ago(4, 52), text: "[info] Loading entry points\n" },
          { at: ago(4, 10), text: "[info] Resolving 212 declarations\n" },
        ],
        backgroundedAt: ago(5, 10),
        initiator: "timeout",
      },
    ),
  );
  // The diff exits non-zero when it finds breaking changes, which it did.
  const diffId = s.id("toolCall");
  timed.push(
    ...taskEvents(
      { itemId: diffId, command: DIFF_COMMAND, description: "Diff the OpenAPI schema against v1.9.0", callId: "call_01a0f3c4d1ff", turnId },
      {
        startedAt: ago(4, 50),
        outputs: [
          { at: ago(4, 48), text: "openapi-diff 3.2.0 · comparing openapi/v1.9.0.yaml → openapi/v2.yaml\n" },
          { at: ago(4, 5), text: "3 breaking changes\n  - removed: DELETE /v1/tokens/legacy\n  - changed: GET /v1/orders response.data[].total number → object\n  - removed: GET /v1/orders query.page\n" },
        ],
        backgroundedAt: ago(4, 30),
        initiator: "user",
        endedAt: ago(3, 40),
        ending: { status: "failed", failureKind: "tool_error", failureReason: "openapi-diff exited with status 2" },
      },
    ),
  );
  timed.push({
    at: ago(3, 30),
    method: "item/completed",
    params: {
      item: {
        itemId: s.id("agentMessage"), kind: "agentMessage", status: "completed", revision: 1, turnId, recordedAt: iso(ago(3, 30)),
        text: "The OpenAPI diff found three breaking changes and exits non-zero when it does, so that task shows as failed; the list is in its output. The docs build and the orders e2e suite are still running in the background.",
      },
    },
  });
  // The e2e suite is twelve tests in, with a progress line four seconds old.
  const e2eId = s.id("toolCall");
  const outputs: { at: number; text: string }[] = [{ at: ago(1, 21), text: E2E_HEAD }];
  E2E_CHUNKS.slice(0, 13).forEach((chunk, index) => {
    outputs.push({ at: index < 12 ? ago(1, 18) + index * 5_800 : ago(0, 4), text: chunk });
  });
  timed.push(
    ...taskEvents(
      { itemId: e2eId, command: E2E_COMMAND, description: "Run the orders e2e suite", callId: E2E_CALL, turnId },
      { startedAt: ago(1, 23), outputs, backgroundedAt: ago(1, 0), initiator: "user" },
    ),
  );
  timed.sort((a, b) => a.at - b.at);
  for (const event of timed) {
    s.pushAt(event.at, event.method, event.params);
  }
  const built = thread(s, "Run the release checks for v2.0", 1, {
    live: live({ activeTurnId: turnId, turnStartedAt: iso(now - 6 * MIN + 600), lastTerminal: null }),
  });
  return { thread: built, streams: [{ sessionId: THREADS.audit, itemId: e2eId, lines: E2E_CHUNKS.slice(13) }] };
}

// ------------------------------------------------------------------------------------- the big run

const BIG_NAME = "replay-recorded-traffic";
const BIG_CALL = "call_01a0f3c4b1a9";
const BIG_STAGES = ["load", "replay", "diff", "classify", "cluster", "verify", "rank", "write"] as const;
const BIG_SHARDS = 250;
/** Agents at once, which the launch policy also states; a wave of them runs for a minute and a half. */
const BIG_SLOTS = 36;
const BIG_WAVE_MS = 90_000;
/** Shards that failed to replay, by label. */
const BIG_FAILED: ReadonlySet<string> = new Set(["replay:shard-087", "classify:shard-140", "verify:shard-012", "verify:shard-201"]);

/** A script that loops over its shards, so the plan is not knowable from literals and the run says more may start. */
const BIG_SCRIPT = [
  "export default async function workflow(host) {",
  "  // 250 shards of recorded v1 traffic, one stage at a time; rank and write share the verified set and run together.",
  '  const shards = Array.from({ length: 250 }, (_, i) => String(i + 1).padStart(3, "0"));',
  "  const jobs = (stage, carry) => shards.map((shard) => ({ label: `${stage}:shard-${shard}`, input: `${stage} shard ${shard} against the v2 build`, carry }));",
  "  let carry = null;",
  '  for (const stage of ["load", "replay", "diff", "classify", "cluster", "verify"]) {',
  "    carry = await host.parallel(jobs(stage, carry));",
  "  }",
  '  const [ranked, written] = await Promise.all([host.parallel(jobs("rank", carry)), host.parallel(jobs("write", carry))]);',
  "  return { ranked, written };",
  "}",
].join("\n");

export const BIG_SUMMARY = [
  "## Replay of recorded v1 traffic against v2",
  "",
  "2,000 shard runs across eight stages. Four shards failed to replay and are listed in `fixtures/traffic/out/failed.jsonl`.",
  "",
  "- 1,412 responses unchanged",
  "- 583 changed by the cursor pagination or the `total` object, all expected",
  "- 5 changed for no reason the diff could name; see `fixtures/traffic/out/unexplained.jsonl`",
].join("\n");

/**
 * Two thousand agents in eight stages of 250, admitted 36 at a time: six stages landed wave by wave, the last
 * two were scheduled together and are eleven waves in. Every moment is in milliseconds into the run.
 */
function bigChildren(): { specs: [string, number, AuditAttempt[]][]; now: number } {
  const groups: number[][] = [[0], [1], [2], [3], [4], [5], [6, 7]];
  const specs: [string, number, AuditAttempt[]][] = [];
  let clock = 0;
  let now = 0;
  groups.forEach((group, g) => {
    const scheduledAt = clock;
    const firstWave = scheduledAt + 1_000;
    const last = g === groups.length - 1;
    const members = group.flatMap((stage) => Array.from({ length: BIG_SHARDS }, (_, i) => ({ stage, i })));
    const wavesDone = last ? 11 : Number.POSITIVE_INFINITY;
    members.forEach((member, index) => {
      const wave = Math.floor(index / BIG_SLOTS);
      const label = `${BIG_STAGES[member.stage]}:shard-${String(member.i + 1).padStart(3, "0")}`;
      const attempt: AuditAttempt = { attempt: 1, scheduledAt };
      const startedAt = firstWave + wave * BIG_WAVE_MS;
      if (wave < wavesDone) {
        attempt.startedAt = startedAt;
        attempt.endedAt = startedAt + BIG_WAVE_MS;
        attempt.durationMs = BIG_WAVE_MS;
        if (BIG_FAILED.has(label)) {
          attempt.terminal = "failed";
        } else {
          attempt.terminal = "completed";
          attempt.usageAt = attempt.endedAt - 2_000;
          attempt.usage = tokensOf(18_000 + ((member.i * 7_919 + member.stage * 104_729) % 26_000));
        }
      } else if (wave === wavesDone) {
        attempt.startedAt = startedAt;
      }
      specs.push([label, 4 + ((member.i * 31 + member.stage * 7) % 15), [attempt]]);
    });
    if (last) {
      now = firstWave + wavesDone * BIG_WAVE_MS + 40_000;
    } else {
      clock = firstWave + Math.ceil(members.length / BIG_SLOTS) * BIG_WAVE_MS + 2_000;
    }
  });
  return { specs, now };
}

/** The audit thread replaced by a replay of two thousand shards: the benchmark, the bins and the virtualized roster. */
function bigThread(now: number): { thread: SeedThread; run: AuditRun; streams: TaskStream[] } {
  const generated = bigChildren();
  const t0 = now - generated.now;
  const s = new Script(THREADS.audit, PROJECTS.atlas, t0 - 9_000, { branch: "release/v2.0" });
  const turnId = s.begin("Replay the recorded v1 traffic under fixtures/traffic against the v2 build, shard by shard, and classify every response that changed.");
  s.think(
    "**Two hundred and fifty shards, eight stages**\n\nEvery stage is independent across shards, so each can fan out; the last two read the same verified set, so they can run together.",
    2200,
  );
  s.tool("bash", { command: "ls fixtures/traffic | wc -l", description: "Count the traffic shards" }, "250\n", 1900);
  s.bill(24_600, 520);
  s.tool(
    "workflow",
    { name: BIG_NAME, script: BIG_SCRIPT },
    JSON.stringify({
      status: "admitted",
      maxParallelAgents: BIG_SLOTS,
      policy: { childLimit: BIG_SLOTS, tokenBudget: null },
      scriptPath: `${PROJECTS.atlas}/.muse/workflows/scripts/generated.workflow.${BIG_NAME}.js`,
      scriptBytes: BIG_SCRIPT.length,
      hostApiVersion: 3,
    }),
    3600,
    { callId: BIG_CALL },
  );
  s.bill(26_100, 980);
  const run: AuditRun = {
    sessionId: THREADS.audit,
    turnId,
    itemId: s.id("workflow"),
    callId: BIG_CALL,
    runId: `workflow-run-model-tool-${BIG_CALL}`,
    name: BIG_NAME,
    scriptId: `generated.workflow.${BIG_NAME}`,
    plan: [],
    startedAt: t0,
    endedAt: null,
    status: "inProgress",
    revision: 0,
    revisedAt: t0,
    children: materialize(THREADS.audit, t0, generated.specs),
    summary: null,
    report: BIG_SUMMARY,
    failure: "verify:shard-201: the v2 build answered 502 for every request in the shard",
    handoffs: [{ agent: "write:shard-250", description: "fixtures/traffic/out/: one classified file per shard" }],
    stoppedReply: "Stopped the replay. Six stages had finished across all 250 shards; rank and write were partway through. What was classified so far is under fixtures/traffic/out/.",
  };
  const history = auditHistory(run, now);
  for (const revision of history) {
    s.pushAt(revision.at, revision.method, { item: revision.item });
  }
  run.revision = history.length;
  run.revisedAt = history[history.length - 1]?.at ?? t0;
  const built = thread(s, "Replay recorded traffic against v2", 1, {
    live: live({ activeTurnId: turnId, turnStartedAt: iso(t0 - 8_400), lastTerminal: null }),
  });
  return { thread: built, run, streams: [] };
}

/** Finished: cursor pagination, with edits across three files and passing tests. */
function paginationThread(now: number): SeedThread {
  const s = new Script(THREADS.pagination, PROJECTS.atlas, now - 74 * MIN, { branch: "feat/orders-cursor" });
  s.begin(
    "GET /v1/orders still uses offset pagination and gets slow past page 200. Switch it to cursor pagination (keep `limit`, default 50, max 200) and update the tests.",
  );
  s.think(
    "**Reading the orders route**\n\nThe handler turns `page` into `skip`, so every deep page scans all the rows before it. A cursor on `(createdAt, id)` makes each page an index seek.",
  );
  s.tool("read", { file_path: "src/routes/orders.ts" }, ORDERS_BEFORE, 1900);
  s.tool(
    "grep",
    { pattern: "listOrders|page=", path: "." },
    'src/routes/orders.ts:6:export async function listOrders(req: Request, res: Response) {\nsrc/app.ts:12:app.get("/v1/orders", listOrders);\ntest/orders.test.ts:14:    const res = await request(app).get("/v1/orders?page=2");\n',
    2100,
  );
  s.tool("read", { file_path: "test/orders.test.ts" }, ORDERS_TEST_BEFORE, 1700);
  s.bill(29_800, 540);
  s.tool("write", { file_path: "src/lib/cursor.ts", content: CURSOR_TS }, undefined, 6800);
  s.tool(
    "multi_edit",
    {
      file_path: "src/routes/orders.ts",
      edits: [
        {
          old_string: 'import { db } from "../db.js";\n\nconst PAGE_SIZE = 50;',
          new_string: 'import { db } from "../db.js";\nimport { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";\n\nconst PAGE_SIZE = 50;\nconst MAX_PAGE_SIZE = 200;',
        },
        { old_string: ORDERS_HANDLER_BEFORE, new_string: ORDERS_HANDLER_AFTER },
      ],
    },
    undefined,
    5400,
  );
  s.tool("edit", { file_path: "test/orders.test.ts", old_string: ORDERS_TEST_OLD, new_string: ORDERS_TEST_NEW }, undefined, 5100);
  s.bill(36_200, 2_180);
  s.tool(
    "bash",
    { command: "npm test -- test/orders.test.ts", description: "Run the orders tests" },
    "\n> atlas-api@2.0.0-rc.1 test\n> vitest run test/orders.test.ts\n\n RUN  v2.1.8 /home/demo/code/atlas-api\n\n ✓ test/orders.test.ts (4 tests) 184ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  1.12s\n",
    8200,
  );
  s.say(
    [
      "`GET /v1/orders` now pages with a cursor instead of an offset.",
      "",
      "- [src/routes/orders.ts](src/routes/orders.ts) reads `cursor` and `limit` (default 50, max 200) and answers `{ data, nextCursor }`. It fetches one extra row to know whether another page exists.",
      "- [src/lib/cursor.ts](src/lib/cursor.ts) encodes the `(createdAt, id)` pair as an opaque base64url string, so clients never depend on its shape.",
      "- A malformed cursor answers `400` instead of an empty page.",
      "",
      "All four orders tests pass. Clients that still send `page` now get the first page, which is worth a line in the changelog.",
    ].join("\n"),
  );
  s.bill(39_100, 420);
  s.end(161_000);

  s.begin("Add a short note about it to the API docs.", 5 * MIN);
  s.tool("read", { file_path: "docs/api/orders.md" }, DOCS_BEFORE, 1500);
  s.tool("edit", { file_path: "docs/api/orders.md", old_string: DOCS_PAGINATION_OLD, new_string: DOCS_PAGINATION_NEW }, undefined, 4300);
  s.say(
    "Added a **Pagination** section to [docs/api/orders.md](docs/api/orders.md) with a request example, and noted that `page` is deprecated and now returns the first page.",
  );
  s.bill(40_300, 610);
  s.end(38_000);
  return thread(s, "Add cursor pagination to GET /v1/orders", 2);
}

/** Waiting: an edit is in, and a shell command needs approval before it runs. */
function contrastThread(now: number): SeedThread {
  const s = new Script(THREADS.contrast, PROJECTS.lumen, now - 4 * MIN, { branch: "fix/dark-contrast" });
  const turnId = s.begin(
    "The muted text in the settings dialog is hard to read in dark mode. Fix the contrast without touching the light theme, then update the visual snapshots.",
  );
  s.think(
    "**Checking the dark-mode tokens**\n\n`--text-muted` is `#6b7280` in both themes. On the dark surface that is 3.8:1, under the 4.5:1 WCAG AA minimum for body text.",
  );
  s.tool(
    "grep",
    { pattern: "--text-muted", path: "src" },
    "src/styles/tokens.css:4:  --text-muted: #6b7280;\nsrc/styles/tokens.css:10:  --text-muted: #6b7280;\nsrc/components/SettingsDialog.module.css:12:  color: var(--text-muted);\nsrc/components/Sidebar.module.css:31:  color: var(--text-muted);\n",
    1800,
  );
  s.tool("read", { file_path: "src/styles/tokens.css" }, TOKENS_BEFORE, 1600);
  s.bill(22_600, 480);
  s.tool("edit", { file_path: "src/styles/tokens.css", old_string: TOKENS_DARK_OLD, new_string: TOKENS_DARK_NEW }, undefined, 4700);
  const command = "npx playwright test settings-dialog --update-snapshots";
  const pending = s.add(
    {
      kind: "toolCall",
      tool: "bash",
      callId: "call_01a0f3d1b9c4",
      args: JSON.stringify({ command, description: "Update the settings dialog's visual snapshots" }),
    },
    3300,
    "item/started",
  );
  s.bill(24_100, 390);
  const approval: ApprovalRequest = {
    approvalId: sampleId(`${THREADS.contrast}:approval`),
    sessionId: THREADS.contrast,
    itemId: pending.itemId,
    turnId,
    toolName: "bash",
    toolCallId: "call_01a0f3d1b9c4",
    currentRequirementId: "req-1",
    subject: { kind: "shell", command, workspaceRoot: PROJECTS.lumen },
    availableChoices: [
      { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: "npx playwright test *" },
      { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
      { choiceId: "reject", label: "Reject", decision: "denied", scope: "once", acceptsFeedback: true },
    ],
  };
  s.push("approval/requested", approval as unknown as Record<string, unknown>, 200);
  return thread(
    s,
    "Fix low-contrast muted text in dark mode",
    1,
    { live: live({ activeTurnId: turnId, turnStartedAt: iso(now - 4 * MIN + 600), pendingApprovals: 1, lastTerminal: null }) },
    [approval],
  );
}

/** Finished a few minutes ago and not opened since, so the sidebar marks it unread. A native subagent surveyed the other pages. */
function lazyChartsThread(now: number): SeedThread {
  const s = new Script(THREADS.lazyCharts, PROJECTS.lumen, now - 12 * MIN, { branch: "perf/lazy-charts" });
  s.begin("The dashboard's first load pulls in the whole charts library. Load it only when a chart is actually rendered.");
  s.tool(
    "grep",
    { pattern: 'from "@/charts"', path: "src" },
    'src/pages/Dashboard.tsx:1:import { RevenueChart } from "@/charts";\nsrc/pages/Reports.tsx:5:import { RevenueChart, UsageChart } from "@/charts";\n',
    1700,
  );
  s.tool("read", { file_path: "src/pages/Dashboard.tsx" }, DASHBOARD_BEFORE, 1500);
  s.bill(19_800, 360);
  // Muse spawned a native subagent for the survey, as 1.4.0 surfaces one: a spawn call, then a wait for its result.
  const subagentId = sampleId(`${THREADS.lazyCharts}:subagent:chart-imports-survey`);
  const taskRef = `subagent-task://${subagentId}/1`;
  s.tool(
    "subagent_spawn",
    {
      command_id: sampleId(`${THREADS.lazyCharts}:command:survey`),
      objective: "Check every other page that imports @/charts and say whether it renders a chart on first paint, so an eager import there is justified.",
      role: "explorer",
      task_name: "chart-imports-survey",
    },
    JSON.stringify({ status: "accepted", subagent_id: subagentId, work_id: sampleId(`${THREADS.lazyCharts}:work:survey`), agent_path: "main/chart-imports-survey/1", task_ref: taskRef }),
    900,
  );
  s.tool("edit", { file_path: "src/pages/Dashboard.tsx", old_string: DASHBOARD_OLD, new_string: DASHBOARD_NEW }, undefined, 4200);
  s.tool(
    "bash",
    { command: "npm run build", description: "Build to compare chunk sizes" },
    "\n> lumen-web@0.9.0 build\n> vite build\n\nvite v6.0.7 building for production...\n✓ 412 modules transformed.\ndist/index.html                      0.61 kB │ gzip:  0.38 kB\ndist/assets/index-3f9c1a2e.css      18.40 kB │ gzip:  4.71 kB\ndist/assets/RevenueChart-8b2e4d71.js 231.64 kB │ gzip: 71.12 kB\ndist/assets/index-c41d9e07.js       148.21 kB │ gzip: 47.90 kB\n✓ built in 2.84s\n",
    7600,
  );
  s.tool(
    "subagent_wait",
    { subagent_id: subagentId, timeout_ms: 120_000, wait_for: "result" },
    JSON.stringify({
      status: "completed",
      subagent_id: subagentId,
      task_ref: taskRef,
      summary: "Reports.tsx renders UsageChart above the fold on every report, so its eager import is right; no other page imports @/charts.",
      workspace: { placement: "shared", setup: "none", parent_changes: [] },
      evidence_refs: [],
    }),
    2400,
  );
  s.say(
    "The charts now load on demand. [src/pages/Dashboard.tsx](src/pages/Dashboard.tsx) imports `RevenueChart` with `React.lazy` and shows the card's skeleton while it loads. The entry chunk dropped from **379 kB to 148 kB** (gzip 119 kB to 48 kB); the charts arrive as their own 232 kB chunk the first time the dashboard renders one. `Reports.tsx` still imports them eagerly, which is right: a subagent checked, and every report renders a chart above the fold.",
  );
  s.bill(21_400, 520);
  s.end(64_000);
  return thread(s, "Lazy-load the charts bundle", 1);
}

/** Finished this morning under the second account. */
function statusJsonThread(now: number): SeedThread {
  const s = new Script(THREADS.statusJson, PROJECTS.orbit, now - 3 * HOUR - 12 * MIN, { branch: "main" });
  s.begin("Add a --json flag to `orbit status` so scripts can read it. Keep the human output as the default.");
  s.tool("read", { file_path: "cmd/status.go" }, STATUS_GO_BEFORE, 1500);
  s.tool("read", { file_path: "internal/workspace/repo.go" }, REPO_GO_BEFORE, 1300);
  s.bill(14_200, 300);
  s.tool(
    "multi_edit",
    {
      file_path: "cmd/status.go",
      edits: [
        { old_string: 'import (\n\t"flag"\n\t"fmt"\n\t"io"', new_string: 'import (\n\t"encoding/json"\n\t"flag"\n\t"fmt"\n\t"io"' },
        {
          old_string: '\tfs := flag.NewFlagSet("status", flag.ContinueOnError)\n\tif err := fs.Parse(args); err != nil {',
          new_string: '\tfs := flag.NewFlagSet("status", flag.ContinueOnError)\n\tasJSON := fs.Bool("json", false, "print machine-readable JSON")\n\tif err := fs.Parse(args); err != nil {',
        },
        {
          old_string: "\tfor _, r := range repos {",
          new_string: '\tif *asJSON {\n\t\tenc := json.NewEncoder(out)\n\t\tenc.SetIndent("", "  ")\n\t\treturn enc.Encode(repos)\n\t}\n\tfor _, r := range repos {',
        },
      ],
    },
    undefined,
    5200,
  );
  s.tool("edit", { file_path: "internal/workspace/repo.go", old_string: REPO_STRUCT_OLD, new_string: REPO_STRUCT_NEW }, undefined, 3100);
  s.tool("bash", { command: "go test ./...", description: "Run the tests" }, "ok  \torbit/cmd\t0.214s\nok  \torbit/internal/sync\t0.388s\nok  \torbit/internal/workspace\t0.102s\n", 6400);
  s.tool(
    "bash",
    { command: "go run . status --json", description: "Try the new flag" },
    '[\n  {\n    "name": "atlas-api",\n    "branch": "release/v2.0",\n    "ahead": 3,\n    "behind": 0,\n    "dirty": false\n  },\n  {\n    "name": "lumen-web",\n    "branch": "fix/dark-contrast",\n    "ahead": 1,\n    "behind": 2,\n    "dirty": true\n  }\n]\n',
    3900,
  );
  s.say(
    "`orbit status --json` now prints the tracked repos as an indented JSON array; without the flag the table is unchanged. The field names come from new `json` tags on `workspace.Repo` in [internal/workspace/repo.go](internal/workspace/repo.go), so they stay lowercase and stable even if the Go fields get renamed.",
  );
  s.bill(17_900, 470);
  s.end(71_000);
  return thread(s, "Add --json output to orbit status", 1, { accountId: SIDE_ACCOUNT });
}

/** Finished yesterday: a question, answered from the code without changing it. */
function syncHangThread(now: number): SeedThread {
  const s = new Script(THREADS.syncHang, PROJECTS.orbit, now - 26 * HOUR, { branch: "main" });
  s.begin("`orbit sync` hangs forever on repos with more than about 10k files. Why?");
  s.tool("grep", { pattern: "chan ", path: "internal/sync" }, "internal/sync/walker.go:13:\tpaths := make(chan string)\ninternal/sync/walker.go:14:\tresults := make(chan Entry)\ninternal/sync/walker.go:15:\terrs := make(chan error)\n", 1600);
  s.tool("read", { file_path: "internal/sync/walker.go" }, WALKER_GO, 1400);
  s.think(
    "**Following the error path**\n\n`errs` is unbuffered and only read after `results` is drained, but `results` only closes once every worker has returned.",
  );
  s.bill(16_300, 820);
  s.say(
    [
      "It is a deadlock in [internal/sync/walker.go](internal/sync/walker.go#L22-L26), and repo size only matters because big repos are the ones likely to contain an unreadable path.",
      "",
      "1. A worker that fails to `stat` a path sends the error on `errs`, which is unbuffered.",
      "2. Nothing reads `errs` until the `results` loop ends, so that worker blocks forever.",
      "3. `wg.Wait()` never returns, `results` is never closed, and the loop over it waits forever too.",
      "",
      "A broken symlink or a permission-denied folder is enough to trigger it. This reproduces it on any machine:",
      "",
      "```sh",
      "mkdir -p /tmp/repro && ln -s missing /tmp/repro/broken && orbit sync /tmp/repro",
      "```",
      "",
      "The smallest fix is to drop the second channel: give `Entry` an `Err` field, send failures on `results` like any other entry, and return the first error after the loop. Want me to make that change and add the repro as a test?",
    ].join("\n"),
  );
  s.bill(18_100, 640);
  s.end(52_000);
  return thread(s, "Why does orbit sync hang on large repos?", 1, { accountId: SIDE_ACCOUNT, origin: "muse" });
}

/** Two days old. */
function rateLimitThread(now: number): SeedThread {
  const s = new Script(THREADS.rateLimit, PROJECTS.atlas, now - 2 * DAY - 3 * HOUR, { branch: "main" });
  s.begin("Rate-limit POST /v1/login to 10 attempts per minute per IP.");
  s.tool("read", { file_path: "src/app.ts" }, APP_TS, 1500);
  s.tool("edit", { file_path: "src/app.ts", old_string: APP_LOGIN_OLD, new_string: APP_LOGIN_NEW }, undefined, 4100);
  s.tool("bash", { command: "npm test -- test/login.test.ts", description: "Run the login tests" }, " ✓ test/login.test.ts (3 tests) 96ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n", 6100);
  s.say(
    "`POST /v1/login` now allows 10 attempts per IP per minute and answers `429` with a `Retry-After` header after that. The limiter keeps its counts in memory, so they reset on restart and are per instance; point it at a shared store before running more than one instance.",
  );
  s.bill(21_700, 690);
  s.end(47_000);
  return thread(s, "Rate-limit the login endpoint", 1, { live: null });
}

/** Almost a week old and shelved, so it sits in the project's settled list; it ran in the project's second folder. */
function viteThread(now: number): SeedThread {
  const s = new Script(THREADS.vite, PROJECTS.lumenSite, now - 6 * DAY - 2 * HOUR, { branch: "main" });
  s.begin("Upgrade Vite to v6 and fix whatever breaks.");
  s.tool("bash", { command: "npm install -D vite@6 @vitejs/plugin-react@4", description: "Upgrade Vite" }, "\nchanged 14 packages, and audited 402 packages in 6s\n\nfound 0 vulnerabilities\n", 2200);
  s.tool("bash", { command: "npm run build", description: "Check the build" }, "vite v6.0.7 building for production...\n✓ 409 modules transformed.\n✓ built in 2.91s\n", 7400);
  s.say("Vite 6 builds cleanly with no config changes. The only difference in output is that CSS chunks are now hashed with 8 characters instead of 7.");
  s.bill(12_400, 250);
  s.end(29_000);
  return thread(s, "Upgrade to Vite 6", 1, { live: null, settled: true, settledAt: iso(now - 4 * DAY) });
}

/** The defaults the demo's research settings answer with, and the config every demo run records. */
export const RESEARCH_CONFIG: ResearchConfig = {
  windowMinMinutes: 3,
  windowMaxMinutes: 10,
  maxRounds: 12,
  maxParallel: 3,
  workerMaxToolCalls: 25,
  workerMaxSearches: 3,
  workerMaxReads: 10,
  workerMaxSaves: 10,
  workerWallTimeMinutes: 10,
  draftFirst: false,
  salvageFraction: 0.6,
  tokenSoftCap: null,
  trace: false,
  models: { supervisor: null, worker: null, writer: null },
};

/** The finished run's report: what it says is true of WCAG, and every citation is a page the workers read. */
export const RESEARCH_REPORT = `# What muted text has to meet in dark mode

**Short answer.** WCAG 2.1 asks the same of secondary text as of any other body text: a contrast ratio of at least 4.5:1 against its background, or 3:1 when the text is large, which the guideline defines as 18 point, or 14 point bold [1]. There is no lower bar for text that is meant to look secondary; the technique notes are explicit that de-emphasised text is still text [2]. The AAA level raises the body-text bar to 7:1 [3].

## What the guideline says

The minimum-contrast criterion (1.4.3) is a Level AA requirement and applies to the visual presentation of text and images of text. It exempts three things only: text that is part of an inactive user interface component, purely decorative text, and text inside a picture where the picture carries the meaning [1]. Placeholder and hint text are not on that list, and the Understanding document treats them as ordinary text [2].

The ratio is computed from relative luminance, so it does not care which of the two colours is lighter. That is why a muted grey that passes on white can fail on a dark surface: the same grey sits closer in luminance to a dark canvas than to a light one [2].

## What that means for a dark theme

- Pick the muted colour per theme rather than sharing one hex value across both. A single value tuned for the light theme is the usual cause of a dark-mode failure [2].
- Check the muted colour against every surface it sits on, not only the page background. Cards and sidebars in a dark theme are often a few steps lighter than the canvas, which lowers the ratio further [1].
- Large text and non-text elements have their own, lower bar of 3:1 (1.4.11 for user interface components and graphical objects), which is the number to use for borders and icons, not for captions [4].

## Open questions

The guideline measures contrast with the WCAG 2 formula. The draft APCA model used in some design tools weights dark-on-light and light-on-dark text differently, and a colour that passes one can fail the other; nothing here settles which a product should follow, only that the shipping standard is the WCAG 2 ratio [1].

## Sources

[1] Web Content Accessibility Guidelines (WCAG) 2.1, Success Criterion 1.4.3 Contrast (Minimum) (https://www.w3.org/TR/WCAG21/#contrast-minimum)
[2] Understanding Success Criterion 1.4.3: Contrast (Minimum) (https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
[3] Web Content Accessibility Guidelines (WCAG) 2.1, Success Criterion 1.4.6 Contrast (Enhanced) (https://www.w3.org/TR/WCAG21/#contrast-enhanced)
[4] Web Content Accessibility Guidelines (WCAG) 2.1, Success Criterion 1.4.11 Non-text Contrast (https://www.w3.org/TR/WCAG21/#non-text-contrast)
`;

/** A worker row as the server reports one; the counts are what it has done so far. */
function researchWorker(
  agentId: number,
  round: number,
  topic: string,
  state: ResearchRunView["workers"][number]["state"],
  counts: { searches: number; reads: number; saved: number },
  startedAt: number,
  endedAt: number | null,
): ResearchRunView["workers"][number] {
  return {
    agentId,
    round,
    topic,
    discovery: false,
    state,
    toolCalls: counts.searches + counts.reads + counts.saved,
    ...counts,
    startedAt: iso(startedAt),
    endedAt: endedAt === null ? null : iso(endedAt),
  };
}

/**
 * The research thread: one short turn, then a run that finished, then one that is out now. The client carries
 * the running one on from here, so on the page its workers keep counting and it writes its report.
 */
function researchThread(now: number): { thread: SeedThread; runs: ResearchRunView[] } {
  const s = new Script(THREADS.research, PROJECTS.lumen, now - 52 * MIN, { branch: "fix/dark-contrast" });
  s.begin("Before I touch the tokens: what does WCAG actually require of muted text in dark mode, and is there a lower bar for secondary text?");
  s.say(
    "From memory: WCAG AA wants 4.5:1 for body text and 3:1 for large text, with no exception for text that is merely de-emphasised. I would rather not answer this from memory when the tokens depend on it: a deep research run on the question will come back with the guideline's own wording and where each claim comes from.",
  );
  s.bill(9_800, 210);
  s.end(14_000);
  const built = thread(s, "What muted text has to meet in dark mode", 1, { live: null });
  const doneCreated = now - 50 * MIN;
  const doneStarted = doneCreated + 2_000;
  const doneEnded = doneStarted + 7 * MIN + 41_000;
  const done: ResearchRunView = {
    runId: RESEARCH_RUNS.done,
    sessionId: THREADS.research,
    status: "completed",
    phase: "done",
    question: "What does WCAG require of muted or secondary text in dark mode, and is there a lower bar for de-emphasised text?",
    brief: "Establish the contrast WCAG 2.1 requires of secondary text, whether de-emphasised text is exempt, and what changes on a dark surface.",
    round: 3,
    maxRounds: RESEARCH_CONFIG.maxRounds,
    createdAt: iso(doneCreated),
    startedAt: iso(doneStarted),
    endedAt: iso(doneEnded),
    researchDeadlineAt: iso(doneStarted + RESEARCH_CONFIG.windowMaxMinutes * MIN),
    workers: [
      researchWorker(1, 1, "the success criteria as written", "completed", { searches: 2, reads: 3, saved: 2 }, doneStarted + 24_000, doneStarted + 2 * MIN + 10_000),
      researchWorker(2, 1, "exemptions for placeholder and de-emphasised text", "completed", { searches: 3, reads: 4, saved: 1 }, doneStarted + 24_000, doneStarted + 2 * MIN + 40_000),
      researchWorker(3, 1, "how the ratio is measured", "completed", { searches: 2, reads: 2, saved: 1 }, doneStarted + 24_000, doneStarted + 1 * MIN + 55_000),
      researchWorker(4, 2, "non-text contrast and large text", "completed", { searches: 2, reads: 3, saved: 1 }, doneStarted + 3 * MIN, doneStarted + 4 * MIN + 30_000),
      researchWorker(5, 2, "APCA and the newer models", "completed", { searches: 3, reads: 3, saved: 0 }, doneStarted + 3 * MIN, doneStarted + 5 * MIN),
    ],
    sources: { registry: 14, verified: 11, curated: 4 },
    usage: { inputTokens: 212_400, outputTokens: 9_850, cachedInputTokens: 96_200, totalTokens: 222_250 },
    failure: null,
    reportAvailable: true,
    report: RESEARCH_REPORT,
    reportPath: `${PROJECTS.lumen}/.ancilla/research/${RESEARCH_RUNS.done}/report.md`,
    config: RESEARCH_CONFIG,
  };
  const runCreated = now - 3 * MIN - 20_000;
  const runStarted = runCreated + 1_500;
  const running: ResearchRunView = {
    runId: RESEARCH_RUNS.running,
    sessionId: THREADS.research,
    status: "running",
    phase: "researching",
    question: "How do Radix Colors, GitHub Primer and Material 3 choose their muted text colours for dark themes, and what contrast do they land on?",
    brief: "Compare how three design systems derive secondary text colours in dark themes and the contrast each documents.",
    round: 2,
    maxRounds: RESEARCH_CONFIG.maxRounds,
    createdAt: iso(runCreated),
    startedAt: iso(runStarted),
    endedAt: null,
    researchDeadlineAt: iso(runStarted + RESEARCH_CONFIG.windowMaxMinutes * MIN),
    workers: [
      researchWorker(1, 1, "Radix Colors dark scales", "completed", { searches: 2, reads: 3, saved: 2 }, runStarted + 20_000, runStarted + 1 * MIN + 30_000),
      researchWorker(2, 1, "Primer's functional colour roles", "completed", { searches: 3, reads: 3, saved: 2 }, runStarted + 20_000, runStarted + 1 * MIN + 48_000),
      researchWorker(3, 1, "Material 3 tonal palettes", "failed", { searches: 1, reads: 0, saved: 0 }, runStarted + 20_000, runStarted + 50_000),
      researchWorker(4, 2, "Material 3 on-surface-variant", "working", { searches: 2, reads: 1, saved: 0 }, runStarted + 2 * MIN + 5_000, null),
      researchWorker(5, 2, "documented contrast figures", "working", { searches: 1, reads: 0, saved: 0 }, runStarted + 2 * MIN + 5_000, null),
      researchWorker(6, 2, "how the scales are generated", "queued", { searches: 0, reads: 0, saved: 0 }, runStarted + 2 * MIN + 5_000, null),
    ],
    sources: { registry: 9, verified: 7, curated: 0 },
    usage: { inputTokens: 88_300, outputTokens: 3_120, cachedInputTokens: 40_100, totalTokens: 91_420 },
    failure: null,
    reportAvailable: false,
    report: null,
    reportPath: null,
    config: RESEARCH_CONFIG,
  };
  return { thread: built, runs: [done, running] };
}

export function seed(now: number, scenario: Scenario = "running"): Seed {
  const first = scenario === "task" ? { ...tasksThread(now), run: null } : scenario === "big" ? bigThread(now) : auditThread(now, scenario);
  const research = researchThread(now);
  return {
    threads: [
      first.thread,
      contrastThread(now),
      research.thread,
      lazyChartsThread(now),
      paginationThread(now),
      statusJsonThread(now),
      syncHangThread(now),
      rateLimitThread(now),
      viteThread(now),
    ],
    audit: first.run,
    streams: first.streams,
    research: research.runs,
  };
}

// ------------------------------------------------------------------------------------ file contents

export const ORDERS_HANDLER_BEFORE = `export async function listOrders(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  res.json({ page, data: rows });
}`;

export const ORDERS_HANDLER_AFTER = `export async function listOrders(req: Request, res: Response) {
  const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const cursor = req.query.cursor === undefined ? null : decodeCursor(String(req.query.cursor));
  if (req.query.cursor !== undefined && !cursor) {
    return res.status(400).json({ error: "invalid_cursor" });
  }
  const rows = await db.order.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    where: cursor ? afterCursor(cursor) : undefined,
    take: limit + 1,
  });
  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  res.json({ data, nextCursor: more ? encodeCursor(data[data.length - 1]!) : null });
}`;

export const ORDERS_BEFORE = `import type { Request, Response } from "express";
import { db } from "../db.js";

const PAGE_SIZE = 50;

${ORDERS_HANDLER_BEFORE}
`;

export const ORDERS_AFTER = `import type { Request, Response } from "express";
import { db } from "../db.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

${ORDERS_HANDLER_AFTER}
`;

export const CURSOR_TS = `/** Opaque page cursors: the last row's sort key, base64url-encoded so clients never parse it. */
export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString("base64url");
}

export function decodeCursor(value: string): Cursor | null {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown[];
    if (typeof createdAt !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(createdAt))) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Rows strictly after the cursor, in (createdAt desc, id desc) order. */
export function afterCursor(cursor: Cursor) {
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  };
}
`;

export const ORDERS_TEST_OLD = `  it("returns the second page", async () => {
    const res = await request(app).get("/v1/orders?page=2");
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.data).toHaveLength(50);
  });`;

export const ORDERS_TEST_NEW = `  it("returns the first page with a next cursor", async () => {
    const res = await request(app).get("/v1/orders?limit=20");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it("follows the cursor without repeating rows", async () => {
    const first = await request(app).get("/v1/orders?limit=20");
    const second = await request(app).get(\`/v1/orders?limit=20&cursor=\${first.body.nextCursor}\`);
    const seen = new Set(first.body.data.map((order: { id: string }) => order.id));
    expect(second.body.data.some((order: { id: string }) => seen.has(order.id))).toBe(false);
  });

  it("caps limit at 200", async () => {
    const res = await request(app).get("/v1/orders?limit=5000");
    expect(res.body.data.length).toBeLessThanOrEqual(200);
  });

  it("rejects a malformed cursor", async () => {
    const res = await request(app).get("/v1/orders?cursor=not-a-cursor");
    expect(res.status).toBe(400);
  });`;

const ORDERS_TEST_HEAD = `import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";

describe("GET /v1/orders", () => {
  it("returns the newest orders first", async () => {
    const res = await request(app).get("/v1/orders");
    expect(res.status).toBe(200);
    const dates = res.body.data.map((order: { createdAt: string }) => order.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

`;

export const ORDERS_TEST_BEFORE = `${ORDERS_TEST_HEAD}${ORDERS_TEST_OLD}\n});\n`;
export const ORDERS_TEST_AFTER = `${ORDERS_TEST_HEAD}${ORDERS_TEST_NEW}\n});\n`;

export const DOCS_PAGINATION_OLD = `## Pagination

Pass \`page\` (1-based) to fetch later pages. Each page holds 50 orders.
`;

export const DOCS_PAGINATION_NEW = `## Pagination

Results come newest first, \`limit\` orders at a time (default 50, at most 200). Each response carries
\`nextCursor\`; pass it back as \`cursor\` to fetch the next page. It is \`null\` on the last page.

\`\`\`http
GET /v1/orders?limit=2&cursor=WyIyMDI2LTA5LTI1VDEwOjQyOjAwLjAwMFoiLCJvcmRfOGsyIl0
\`\`\`

\`page\` is deprecated: it is ignored and returns the first page.
`;

const DOCS_HEAD = `# Orders

\`GET /v1/orders\` lists the orders the API key can see.

| Field | Type | Notes |
| --- | --- | --- |
| \`id\` | string | Stable, prefixed \`ord_\` |
| \`status\` | string | \`pending\`, \`paid\`, \`refunded\` or \`cancelled\` |
| \`total\` | object | \`{ amount, currency }\`, amount in minor units |
| \`createdAt\` | string | ISO 8601 |

`;

export const DOCS_BEFORE = `${DOCS_HEAD}${DOCS_PAGINATION_OLD}`;
export const DOCS_AFTER = `${DOCS_HEAD}${DOCS_PAGINATION_NEW}`;

export const TOKENS_DARK_OLD = `[data-theme="dark"] {
  --surface: #111418;
  --text: #f3f4f6;
  --text-muted: #6b7280;
}`;

export const TOKENS_DARK_NEW = `[data-theme="dark"] {
  --surface: #111418;
  --text: #f3f4f6;
  /* 7.7:1 on --surface; #6b7280 was 3.8:1, under WCAG AA. */
  --text-muted: #a1a8b3;
}`;

const TOKENS_LIGHT = `:root {
  --surface: #ffffff;
  --text: #111827;
  --text-muted: #6b7280;
}
`;

export const TOKENS_BEFORE = `${TOKENS_LIGHT}\n${TOKENS_DARK_OLD}\n`;
export const TOKENS_AFTER = `${TOKENS_LIGHT}\n${TOKENS_DARK_NEW}\n`;

export const DASHBOARD_OLD = `import { RevenueChart } from "@/charts";
import { Card } from "@/components/Card";`;

export const DASHBOARD_NEW = `import { lazy, Suspense } from "react";
import { Card, CardSkeleton } from "@/components/Card";

// The charts library is the biggest thing on this page; load it only once a chart renders.
const RevenueChart = lazy(() => import("@/charts").then((charts) => ({ default: charts.RevenueChart })));`;

const DASHBOARD_BODY = `
import { useMetrics } from "@/hooks/useMetrics";

export function Dashboard() {
  const metrics = useMetrics();
  return (
    <main className="grid gap-4 md:grid-cols-3">
      <Card title="Active users" value={metrics.activeUsers} />
      <Card title="Signups this week" value={metrics.signups} />
      <Card title="Churn" value={\`\${metrics.churn}%\`} />
      <section className="md:col-span-3">
        <RevenueChart data={metrics.revenue} />
      </section>
    </main>
  );
}
`;

export const DASHBOARD_BEFORE = `${DASHBOARD_OLD}${DASHBOARD_BODY}`;
export const DASHBOARD_AFTER = `${DASHBOARD_NEW}${DASHBOARD_BODY.replace(
  "        <RevenueChart data={metrics.revenue} />",
  "        <Suspense fallback={<CardSkeleton height={320} />}>\n          <RevenueChart data={metrics.revenue} />\n        </Suspense>",
)}`;

export const STATUS_GO_BEFORE = `package cmd

import (
	"flag"
	"fmt"
	"io"

	"orbit/internal/workspace"
)

// Status prints where every tracked repo stands.
func Status(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	repos, err := workspace.Load()
	if err != nil {
		return err
	}
	for _, r := range repos {
		fmt.Fprintf(out, "%-24s %-20s %d ahead, %d behind\\n", r.Name, r.Branch, r.Ahead, r.Behind)
	}
	return nil
}
`;

export const STATUS_GO_AFTER = `package cmd

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"orbit/internal/workspace"
)

// Status prints where every tracked repo stands, as a table or, with --json, for scripts.
func Status(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print machine-readable JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	repos, err := workspace.Load()
	if err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(repos)
	}
	for _, r := range repos {
		fmt.Fprintf(out, "%-24s %-20s %d ahead, %d behind\\n", r.Name, r.Branch, r.Ahead, r.Behind)
	}
	return nil
}
`;

export const REPO_STRUCT_OLD = `type Repo struct {
	Name   string
	Branch string
	Ahead  int
	Behind int
	Dirty  bool
}`;

export const REPO_STRUCT_NEW = `type Repo struct {
	Name   string \`json:"name"\`
	Branch string \`json:"branch"\`
	Ahead  int    \`json:"ahead"\`
	Behind int    \`json:"behind"\`
	Dirty  bool   \`json:"dirty"\`
}`;

const REPO_GO_HEAD = `package workspace

// Repo is one repository orbit tracks, with how far its branch is from upstream.
`;

export const REPO_GO_BEFORE = `${REPO_GO_HEAD}${REPO_STRUCT_OLD}\n`;
export const REPO_GO_AFTER = `${REPO_GO_HEAD}${REPO_STRUCT_NEW}\n`;

export const WALKER_GO = `package sync

import (
	"io/fs"
	"path/filepath"
	gosync "sync"
)

// Walk stats every file under root with a pool of workers.
func Walk(root string, workers int) ([]Entry, error) {
	var wg gosync.WaitGroup

	paths := make(chan string)
	results := make(chan Entry)
	errs := make(chan error)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range paths {
				e, err := stat(p)
				if err != nil {
					errs <- err
					continue
				}
				results <- e
			}
		}()
	}

	go func() {
		filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			paths <- p
			return nil
		})
		close(paths)
	}()

	go func() {
		wg.Wait()
		close(results)
		close(errs)
	}()

	var out []Entry
	for e := range results {
		out = append(out, e)
	}
	if err := <-errs; err != nil {
		return nil, err
	}
	return out, nil
}
`;

export const APP_LOGIN_OLD = `app.post("/v1/login", login);`;

export const APP_LOGIN_NEW = `// 10 attempts per IP per minute; counts live in memory, so they are per instance.
const loginLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true });
app.post("/v1/login", loginLimit, login);`;

const APP_HEAD = `import express from "express";
import { rateLimit } from "./lib/rate-limit.js";
import { login } from "./routes/auth.js";
import { listOrders } from "./routes/orders.js";

export const app = express();
app.use(express.json());

`;

export const APP_TS = `${APP_HEAD}${APP_LOGIN_OLD}
app.get("/v1/orders", listOrders);
`;

export const APP_TS_AFTER = `${APP_HEAD}${APP_LOGIN_NEW}
app.get("/v1/orders", listOrders);
`;
