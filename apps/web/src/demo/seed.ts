/**
 * Ancilla Web Demo Mock Data Synthesizer:
 * Generates synthetic workspaces, multi-turn transcripts, and multi-agent workflow
 * event sequences for interactive evaluation and automated UI test fixtures.
 */
import type {
  ApprovalRequest,
  LiveView,
  MspItem,
  ResearchConfig,
  ResearchRunView,
  SessionSummary,
  TokenUsage,
  ViewEvent,
  WorkflowChild,
} from "@ancilla/ui";
import { DAY, HOUR, MIN, MODEL, Script, iso, sampleId } from "./script.js";
export const HOME = "/home/demo";
export const PROJECTS = Object.freeze({ atlas: `${HOME}/code/atlas-api`, lumen: `${HOME}/code/lumen-web`, lumenSite: `${HOME}/code/lumen-site`, orbit: `${HOME}/code/orbit-cli` } as const);
export const THREADS = Object.freeze({
  audit: "01a0f3c4-6d2e-7b1a-8c3f-5e9d2a7b4c10", pagination: "01a0f2b8-1c4d-7e2f-9a3b-6c8d4e2f1a07", contrast: "01a0f3d1-8e5a-7c2b-b4d6-2f9e1a3c5b88",
  lazyCharts: "01a0f3b9-2a7c-7d4e-8f1b-9c3e5a7d2b46", statusJson: "01a0f2e0-5b3d-7a9c-a2e4-1d6f8b3c7e21", syncHang: "01a0ef41-9d2c-7b5e-8a3f-4c1e7b9d2a63",
  rateLimit: "01a0ed12-3f8b-7c1d-9e4a-6b2d8f1c3a95", vite: "01a0e8a7-7c1e-7f3b-b5d2-8e4a1c6f9b30", research: "01a0f3e2-4b7d-7a1c-9e5f-3d8b6c2a4f19",
} as const);

export const RESEARCH_RUNS = Object.freeze({ done: "01a0f3e3-1c2d-7e4f-8a6b-5d9c3e7f1b28", running: "01a0f3e5-6d8e-7f1a-9b2c-7e4d1f8a3c56" } as const);
export const SIDE_ACCOUNT = "side";
export const SCENARIOS = [
  "running",
  "stalled",
  "failed",
  "waiting",
  "partial",
  "reconnect",
  "done",
  "big",
  "task",
  "turn",
] as const;

export type Scenario = (typeof SCENARIOS)[number];
export function isScenario(candidateValue: string | null | undefined): candidateValue is Scenario {
  return typeof candidateValue === "string" && (SCENARIOS as readonly string[]).includes(candidateValue);
}
export type SeedThread = { readonly summary: SessionSummary; readonly events: ViewEvent[]; readonly seq: number; readonly approvals: ApprovalRequest[]; truncated?: boolean; };
export type AuditAttempt = { attempt: number; scheduledAt: number; startedAt?: number; usageAt?: number; usage?: TokenUsage; endedAt?: number; terminal?: "completed" | "failed" | "cancelled"; durationMs?: number; };
export type AuditChild = { readonly childId: string; readonly label: string; readonly attempts: AuditAttempt[]; readonly toolCalls: number; };
export type PlannedAgent = { readonly label: string; readonly input: string; };
export type AuditRun = { readonly sessionId: string; readonly turnId: string; readonly itemId: string; readonly callId: string; readonly runId: string; readonly name: string; readonly scriptId: string; readonly plan: PlannedAgent[]; readonly startedAt: number; endedAt: number | null; status: "inProgress" | "completed" | "cancelled"; revision: number; revisedAt: number; readonly children: AuditChild[]; summary: string | null; readonly report: string; readonly failure: string; readonly handoffs: { agent: string; description: string }[]; readonly stoppedReply: string; };
export type TaskStream = { readonly sessionId: string; readonly itemId: string; readonly lines: string[]; };
export type Seed = { readonly threads: SeedThread[]; readonly audit: AuditRun | null; readonly streams: TaskStream[]; readonly research: ResearchRunView[]; };
type TimedEventRecord = { at: number; method: string; params: Record<string, unknown>; };
function makeLiveStatus(statusPatch: Partial<LiveView> = {}): LiveView {
  return { activeTurnId: null, turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: "completed", lastError: null, ...statusPatch };
}
function buildSeedThread(timelineScript: Script, displayHeading: string, totalTurns: number, additionalSessionMeta: Partial<SessionSummary> = {}, associatedApprovals: ApprovalRequest[] = []): SeedThread {
  const earliestTimestamp = timelineScript.events[0]?.at ?? timelineScript.at;
  const sessionSummaryPayload: SessionSummary = { sessionId: timelineScript.sessionId, cwd: timelineScript.cwd, title: displayHeading, titleSource: "auto", turnCount: totalTurns, modelId: MODEL, origin: "ancilla", archived: false, createdAt: iso(earliestTimestamp), activityAt: iso(timelineScript.at), settled: false, settledAt: null, unsettledAt: null, sandboxDisabled: false, accountId: null, live: makeLiveStatus(), ...additionalSessionMeta };
  return { summary: sessionSummaryPayload, events: timelineScript.events, seq: timelineScript.seq, approvals: associatedApprovals };
}
function toMs(mins: number, secs = 0): number { return Math.round((mins * 60 + secs) * 1000); }
export function tokensOf(total: number): TokenUsage {
  const inputTokens = Math.round(total * 0.81);
  const outputTokens = total - inputTokens;
  const cached = Math.round(inputTokens * 0.6);
  return { inputTokens, outputTokens, reasoningTokens: Math.round(total * 0.07), cachedTokens: cached, cacheReadTokens: cached, cacheWriteTokens: 0 };
}
export function childIdFor(sessionId: string, label: string, scheduledAt: number): string {
  const time = Math.max(0, Math.floor(scheduledAt)).toString(16).padStart(12, "0").slice(-12);
  return `${time.slice(0, 8)}-${time.slice(8)}-${sampleId(`${sessionId}:agent:${label}`).slice(14)}`;
}
function encodeReconciledMessage(payloadObject: Record<string, unknown>): string {
  return `<workflow-launch-reconciled>${JSON.stringify(payloadObject)}</workflow-launch-reconciled>`;
}
export type ChildCache = Map<string, { key: string; child: WorkflowChild; usageSent: boolean }>;
export function childrenAt(
  activeRunModel: AuditRun,
  currentWallTime: number,
  priorTimestamp: number,
  lookupCache?: ChildCache,
): WorkflowChild[] {
  const outputChildrenList: WorkflowChild[] = [];

  for (const childNode of activeRunModel.children) {
    let activeAttemptRecord: AuditAttempt | null = null;
    for (const attemptCandidate of childNode.attempts) {
      if (attemptCandidate.scheduledAt <= currentWallTime) {
        activeAttemptRecord = attemptCandidate;
      }
    }

    if (!activeAttemptRecord) {
      continue;
    }

    const cachedSnapshot = lookupCache?.get(childNode.childId);
    const isNewAttempt = lookupCache
      ? cachedSnapshot === undefined || cachedSnapshot.child.attempt !== activeAttemptRecord.attempt
      : priorTimestamp < activeAttemptRecord.scheduledAt;

    const childViewModel: WorkflowChild = {
      childId: childNode.childId,
      attempt: activeAttemptRecord.attempt,
      status: "scheduled",
    };

    if (isNewAttempt) {
      childViewModel.label = childNode.label;
    }

    if (activeAttemptRecord.endedAt !== undefined && activeAttemptRecord.endedAt <= currentWallTime) {
      childViewModel.status = "terminal";
      childViewModel.terminal = activeAttemptRecord.terminal;
      if (activeAttemptRecord.durationMs !== undefined) {
        childViewModel.durationMs = activeAttemptRecord.durationMs;
      }
    } else if (activeAttemptRecord.usageAt !== undefined && activeAttemptRecord.usageAt <= currentWallTime) {
      childViewModel.status = "usage";
    } else if (activeAttemptRecord.startedAt !== undefined && activeAttemptRecord.startedAt <= currentWallTime) {
      childViewModel.status = "started";
    }

    const isUsageReady =
      activeAttemptRecord.usage !== undefined &&
      activeAttemptRecord.usageAt !== undefined &&
      activeAttemptRecord.usageAt <= currentWallTime;
    const wasUsageDelivered = !isNewAttempt && cachedSnapshot !== undefined && cachedSnapshot.usageSent;

    if (isUsageReady && (lookupCache ? !wasUsageDelivered : priorTimestamp < (activeAttemptRecord.usageAt as number))) {
      childViewModel.usage = activeAttemptRecord.usage;
    }

    const fingerprintKey = `${childViewModel.attempt}|${childViewModel.status}|${childViewModel.terminal ?? ""}|${childViewModel.durationMs ?? ""}|${childViewModel.label ? 1 : 0}|${childViewModel.usage ? 1 : 0}`;

    if (cachedSnapshot && cachedSnapshot.key === fingerprintKey) {
      outputChildrenList.push(cachedSnapshot.child);
    } else {
      lookupCache?.set(childNode.childId, {
        key: fingerprintKey,
        child: childViewModel,
        usageSent: wasUsageDelivered || childViewModel.usage !== undefined,
      });
      outputChildrenList.push(childViewModel);
    }
  }

  return outputChildrenList;
}
export function auditItem(runModel: AuditRun, atTime: number, sinceTime: number, revisionIndex: number, cacheRef?: ChildCache): MspItem {
  const isTerminated = runModel.endedAt !== null && atTime >= runModel.endedAt;
  const itemPayload: MspItem = {
    itemId: runModel.itemId, kind: "workflow", status: isTerminated ? runModel.status : "inProgress", revision: revisionIndex,
    turnId: runModel.turnId, recordedAt: iso(atTime), entryId: runModel.name, scriptId: runModel.scriptId,
    triggerSource: "guidanceAuto", workflowRunId: runModel.runId, fallbackText: `Workflow: ${runModel.name}`,
    children: childrenAt(runModel, atTime, sinceTime, cacheRef),
  };
  if (isTerminated) {
    const hasFailingAttempt = runModel.children.some((agent) => agent.attempts[agent.attempts.length - 1]?.terminal === "failed");
    itemPayload.message = encodeReconciledMessage({
      type: "workflow-launch-reconciled", call_id: runModel.callId, route: "guidance", launch_admitted: true, deferred_to_background: false,
      agents_activity: runModel.children.map((agentEntry) => ({ agent: agentEntry.childId, duration_ms: agentEntry.attempts[agentEntry.attempts.length - 1]?.durationMs ?? 0, tool_calls: agentEntry.toolCalls })),
      final_summary: runModel.summary ? { status: "success", summary: runModel.summary } : null,
      latest_failure: hasFailingAttempt ? runModel.failure : null,
      workspace_handoffs: runModel.summary ? runModel.handoffs : [],
    });
  }
  return itemPayload;
}

export function auditHistory(
  activeWorkflowRun: AuditRun,
  upperBoundTimestamp: number,
): { at: number; method: string; item: MspItem }[] {
  const distinctMoments = new Set<number>([activeWorkflowRun.startedAt]);

  for (const childAgent of activeWorkflowRun.children) {
    for (const attempt of childAgent.attempts) {
      for (const stamp of [attempt.scheduledAt, attempt.startedAt, attempt.usageAt, attempt.endedAt]) {
        if (stamp !== undefined) {
          distinctMoments.add(stamp);
        }
      }
    }
  }

  if (activeWorkflowRun.endedAt !== null) {
    distinctMoments.add(activeWorkflowRun.endedAt);
  }

  const childMemoryCache: ChildCache = new Map();
  let precedingTick = Number.NEGATIVE_INFINITY;

  return [...distinctMoments]
    .filter((timeVal) => timeVal <= upperBoundTimestamp)
    .sort((a, b) => a - b)
    .map((momentTime, stepIndex) => {
      const generatedMspItem = auditItem(activeWorkflowRun, momentTime, precedingTick, stepIndex + 1, childMemoryCache);
      precedingTick = momentTime;
      return {
        at: momentTime,
        method: stepIndex === 0 ? "item/started" : "item/updated",
        item: generatedMspItem,
      };
    });
}
type WorkflowScriptPhaseDef = { comment: string; agents: PlannedAgent[]; };
function synthesizeWorkflowScript(phasesArray: WorkflowScriptPhaseDef[]): string {
  const stepIdentifiers = ["findings", "checks", "verdicts"];
  const scriptLines: string[] = ["export default async function workflow(host) {"];

  phasesArray.forEach((phaseEntry, phaseIndex) => {
    const dependencyBinding = phaseIndex > 0 ? `, { ${stepIdentifiers[phaseIndex - 1] ?? `step${phaseIndex - 1}`} }` : "";
    const isTerminalPhase = phaseIndex === phasesArray.length - 1;

    scriptLines.push(`  // ${phaseEntry.comment}`);
    scriptLines.push(
      `  ${isTerminalPhase ? "return" : `const ${stepIdentifiers[phaseIndex] ?? `step${phaseIndex}`} =`} await host.parallel([`,
    );

    for (const agentDesc of phaseEntry.agents) {
      scriptLines.push(
        `    { label: ${JSON.stringify(agentDesc.label)}, input: ${JSON.stringify(agentDesc.input)} },`,
      );
    }
    scriptLines.push(`  ]${dependencyBinding});`);
  });
  scriptLines.push("}");
  return scriptLines.join("\n");
}
const RUN_NAME = "v2-breaking-change-audit";
const LAUNCH_CALL = "call_01a0f3c4e7b2";
const AUDIT_PLAN: WorkflowScriptPhaseDef[] = [
  { comment: "Four domain auditors inspect git changes across routes, openapi, sdk, and migrations concurrently.", agents: [
    { label: "audit:routes", input: "Inspect Express route handlers in src/routes/ for breaking input validation or response shape diffs." },
    { label: "audit:schema", input: "Diff openapi/v1.9.0.yaml against openapi/v2.yaml detecting removed endpoints, parameter types, or schema properties." },
    { label: "audit:sdk", input: "Compare sdk/typescript/ exports and client signatures against v1.9.0 for contract breaking changes." },
    { label: "audit:migrations", input: "Review migrations/ SQL scripts for column drops, renames, type mutations, or constraints." },
  ] },
  { comment: "Reproduce identified compatibility breaking changes.", agents: [
    { label: "verify:sdk-examples", input: "Execute v1.9 SDK test suites against running v2 backend to verify broken API calls." },
    { label: "verify:webhooks", input: "Replay recorded webhook events through v2 ingestion endpoints and compare output contracts." },
    { label: "verify:migration-replay", input: "Replay migrations 0042 and 0043 on a populated v1.9 database snapshot to verify schema upgrade path." },
  ] },
  { comment: "Judge models evaluate breaking severity and feasibility of shims.", agents: [
    { label: "judge:severity", input: "Score detected breaking modifications by customer severity tier and blast radius." },
    { label: "judge:compat", input: "Evaluate backward-compatibility impact and assess client migration costs." },
  ] },
  { comment: "Synthesize release documentation.", agents: [
    { label: "report:release-notes", input: "Write the breaking-changes section for the v2.0 changelog outlining impacted APIs and migration paths." },
  ] },
];

export const AUDIT_SUMMARY = `## Breaking changes since v1.9.0

A multi-agent audit scanned routes, openapi specifications, SDK typings and SQL migrations.
Nine breaking alterations were identified across 3 components, with 1 migration replay failure requiring attention.

* \`DELETE /v1/tokens/legacy\`: removed endpoint; callers must migrate to scoped access tokens.
* \`GET /v1/orders\`: cursor pagination adopted (\`cursor\`, \`limit\`). The legacy \`page\` parameter defaults to first page.
* \`Order.total\`: formatted as structured \`{ amount, currency }\` rather than raw integer cents.
* Migration \`0042_orders_currency.sql\`: added non-null \`currency\` column without default on preexisting records.`;

export const REPLAY_FAILURE =
  "verify:migration-replay: pg_restore exited with status 1: could not open input file fixtures/db/atlas-v1.9.0.dump";
const AUDIT_HANDOFFS = [
  {
    agent: "report:release-notes",
    description: "docs/releases/v2.0.md: the breaking-changes section, ready to paste",
  },
];
const AUDIT_STOPPED =
  "Stopped the audit. The four audits and two of the three checks had finished: `DELETE /v1/tokens/legacy` is gone, `Order.total` became `{ amount, currency }` and `GET /v1/orders` pages with a cursor. The judges did not complete, so the report is not final.";
const AUDIT_PROMPT =
  "We're about to tag v2.0. Audit everything that changed since v1.9.0 for breaking changes: route handlers, the OpenAPI schema, the TypeScript SDK and the database migrations. Run the checks in parallel and give me one report I can paste into the release notes.";
function instantiateAuditChildren(parentSession: string, startOffset: number, scenarioMode: Scenario): AuditChild[] {
  const replayTokenMetrics: TokenUsage = {
    inputTokens: 52_100,
    outputTokens: 6_400,
    reasoningTokens: 5_700,
    cachedTokens: 31_300,
    cacheReadTokens: 31_300,
    cacheWriteTokens: 0,
  };
  const createCompletedAttempt = (
    attempt: number,
    sched: number,
    start: number,
    end: number,
    toks: number,
    usageTime = end - 2000,
  ): AuditAttempt => ({
    attempt,
    scheduledAt: sched,
    startedAt: start,
    usageAt: usageTime,
    usage: tokensOf(toks),
    endedAt: end,
    terminal: "completed",
    durationMs: end - start,
  });
  const createFailedAttempt = (
    attempt: number,
    sched: number,
    start: number,
    end: number,
    customUsage?: TokenUsage,
  ): AuditAttempt => ({
    attempt,
    scheduledAt: sched,
    startedAt: start,
    ...(customUsage ? { usageAt: end - 1000, usage: customUsage } : {}),
    endedAt: end,
    terminal: "failed",
    durationMs: end - start,
  });
  const createInProgressAttempt = (
    sched: number,
    start: number,
    usageSpec?: { at: number; tokens: number },
  ): AuditAttempt => ({
    attempt: 1,
    scheduledAt: sched,
    startedAt: start,
    ...(usageSpec ? { usageAt: usageSpec.at, usage: tokensOf(usageSpec.tokens) } : {}),
  });

  const baselineReplayAttempts = [
    createFailedAttempt(1, toMs(12, 10), toMs(12, 12), toMs(14, 20)),
    createFailedAttempt(2, toMs(14, 21), toMs(14, 22), toMs(18, 13), replayTokenMetrics),
  ];
  const landedReplayAttempts = [
    baselineReplayAttempts[0] as AuditAttempt,
    {
      ...createCompletedAttempt(2, toMs(14, 21), toMs(14, 22), toMs(18, 13), 64_200, toMs(18, 12)),
      usage: replayTokenMetrics,
    },
  ];
  const severityFinishingAttempt = createInProgressAttempt(toMs(25, 12), toMs(25, 14), {
    at: toMs(40, 23),
    tokens: 148_000,
  });
  const compatSilentAttempt = createInProgressAttempt(toMs(25, 12), toMs(25, 14));
  const compatFinishingAttempt = createInProgressAttempt(toMs(25, 12), toMs(25, 14), {
    at: toMs(40, 58),
    tokens: 96_000,
  });

  let activeReplayAttempts = baselineReplayAttempts;
  let activeSeverityAttempt = severityFinishingAttempt;
  let activeCompatAttempt = compatSilentAttempt;
  let reportAttempts: AuditAttempt[] = [];

  if (scenarioMode === "stalled") {
    activeReplayAttempts = landedReplayAttempts;
    activeSeverityAttempt = createCompletedAttempt(1, toMs(25, 12), toMs(25, 14), toMs(36, 30), 148_000);
  } else if (scenarioMode === "failed") {
    activeCompatAttempt = compatFinishingAttempt;
  } else if (scenarioMode === "waiting") {
    activeReplayAttempts = landedReplayAttempts;
    activeCompatAttempt = compatFinishingAttempt;
  } else if (scenarioMode === "done") {
    activeReplayAttempts = [
      ...baselineReplayAttempts,
      createCompletedAttempt(3, toMs(41, 52), toMs(41, 54), toMs(44, 4), 118_000),
    ];
    activeSeverityAttempt = createCompletedAttempt(1, toMs(25, 12), toMs(25, 14), toMs(42, 34), 148_000, toMs(40, 23));
    activeCompatAttempt = createCompletedAttempt(1, toMs(25, 12), toMs(25, 14), toMs(43, 50), 96_000);
    reportAttempts = [createCompletedAttempt(1, toMs(44, 8), toMs(44, 10), toMs(45, 10), 41_000)];
  }

  const childSpecsList: [string, number, AuditAttempt[]][] = [
    ["audit:routes", 41, [createCompletedAttempt(1, toMs(0), toMs(0, 4), toMs(12, 4), 288_000)]],
    ["audit:schema", 27, [createCompletedAttempt(1, toMs(0, 0.4), toMs(0, 4), toMs(8, 19), 164_000)]],
    ["audit:sdk", 19, [createCompletedAttempt(1, toMs(0, 0.4), toMs(0, 5), toMs(5, 35), 112_000)]],
    ["audit:migrations", 14, [createCompletedAttempt(1, toMs(0, 0.4), toMs(0, 5), toMs(4, 7), 96_000)]],
    ["verify:sdk-examples", 84, [createCompletedAttempt(1, toMs(12, 10), toMs(12, 12), toMs(24, 52), 236_000)]],
    ["verify:webhooks", 33, [createCompletedAttempt(1, toMs(12, 10), toMs(12, 12), toMs(21, 24), 168_000)]],
    ["verify:migration-replay", 22, activeReplayAttempts],
    ["judge:severity", 58, [activeSeverityAttempt]],
    ["judge:compat", 47, [activeCompatAttempt]],
  ];

  if (reportAttempts.length > 0) {
    childSpecsList.push(["report:release-notes", 9, reportAttempts]);
  }

  return attachAbsoluteTimestamps(parentSession, startOffset, childSpecsList);
}
function attachAbsoluteTimestamps(
  sessionKey: string,
  baseTime: number,
  definitions: [string, number, AuditAttempt[]][],
): AuditChild[] {
  return definitions.map(([nameLabel, callCount, attemptsArray]) => ({
    childId: childIdFor(sessionKey, nameLabel, baseTime + (attemptsArray[0] as AuditAttempt).scheduledAt),
    label: nameLabel,
    toolCalls: callCount,
    attempts: attemptsArray.map((rawAttempt) => {
      const adjusted: AuditAttempt = {
        ...rawAttempt,
        scheduledAt: rawAttempt.scheduledAt + baseTime,
      };
      if (rawAttempt.startedAt !== undefined) {
        adjusted.startedAt = rawAttempt.startedAt + baseTime;
      }
      if (rawAttempt.usageAt !== undefined) {
        adjusted.usageAt = rawAttempt.usageAt + baseTime;
      }
      if (rawAttempt.endedAt !== undefined) {
        adjusted.endedAt = rawAttempt.endedAt + baseTime;
      }
      return adjusted;
    }),
  }));
}
const E2E_COMMAND = "npm run test:e2e -- --grep orders";
const E2E_CALL = "call_01a0f3c4e2e0";
const E2E_HEAD = "> atlas-api@2.0.0-rc.1 test:e2e\n> playwright test --grep orders\n\nRunning 15 tests using 2 workers\n\n";

const E2E_TESTS: [string, string][] = [
  ["orders sorted by descending creation time", "1.9s"],
  ["initial page returns opaque next cursor", "1.2s"],
  ["sequential cursor pagination deduplication", "2.8s"],
  ["enforces max limit ceiling 200", "1.1s"],
  ["invalid cursor returns 400 error", "0.6s"],
  ["legacy page param maps to first page", "0.9s"],
  ["monetary totals contain amount and currency", "1.4s"],
  ["status filter matches order state", "1.7s"],
  ["secondary sort breaks ties by uuid", "1.3s"],
  ["unauthenticated requests yield 401", "0.4s"],
  ["cross-tenant order access rejected with 403", "0.8s"],
  ["high volume pagination without omissions", "6.2s"],
  ["pages with a cursor under load", "2.4s"],
  ["cross-deployment cursor compatibility", "2.8s"],
  ["token bucket rate limiter on burst reads", "3.1s"],
];
const E2E_CHUNKS: string[] = E2E_TESTS.flatMap(([testTitle, elapsedSecs], testIndex) => {
  const stepNumber = testIndex + 1;
  const standardTestLog = `  ✓  ${stepNumber} orders.spec.ts:${9 + stepNumber * 7}:3 › ${testTitle} (${elapsedSecs})\n`;

  if (stepNumber < 12) {
    return [standardTestLog];
  }
  const upcomingTest = E2E_TESTS[stepNumber]?.[0];
  const progressFooter = upcomingTest
    ? `${stepNumber} passed · ${E2E_TESTS.length - stepNumber} pending · running "${upcomingTest}"\n`
    : `\n  ${stepNumber} passed (4.1m)\n`;
  return [standardTestLog, progressFooter];
});
type ExecutionTaskShape = { itemId: string; command: string; description: string; callId: string; turnId: string; };
function generateTaskTimeline(
  taskDescriptor: ExecutionTaskShape,
  timingParams: { startedAt: number; outputs: { at: number; text: string }[]; backgroundedAt?: number; initiator?: "user" | "timeout"; endedAt?: number; ending?: Partial<MspItem>; },
): TimedEventRecord[] {
  const baseItemPayload = { itemId: taskDescriptor.itemId, kind: "toolCall" as const, tool: "bash", callId: taskDescriptor.callId, args: JSON.stringify({ command: taskDescriptor.command, description: taskDescriptor.description }), turnId: taskDescriptor.turnId };
  const outputEvents: TimedEventRecord[] = [{ at: timingParams.startedAt, method: "item/started", params: { item: { ...baseItemPayload, status: "inProgress" as const, revision: 1, recordedAt: iso(timingParams.startedAt) } } }];
  let accumulatedLogs = "";
  let isTaskBackgrounded = timingParams.backgroundedAt === undefined;
  for (const logChunk of timingParams.outputs) {
    if (!isTaskBackgrounded && timingParams.backgroundedAt !== undefined && logChunk.at >= timingParams.backgroundedAt) {
      isTaskBackgrounded = true;
      outputEvents.push({ at: timingParams.backgroundedAt, method: "item/updated", params: { item: { ...baseItemPayload, status: "inProgress" as const, revision: 2, recordedAt: iso(timingParams.backgroundedAt), background: true, backgroundInitiator: timingParams.initiator ?? "user", visibleOutput: accumulatedLogs } } });
    }
    accumulatedLogs += logChunk.text;
    outputEvents.push({ at: logChunk.at, method: "item/delta", params: { itemId: taskDescriptor.itemId, field: "output", delta: logChunk.text, turnId: taskDescriptor.turnId } });
  }
  if (!isTaskBackgrounded && timingParams.backgroundedAt !== undefined) {
    isTaskBackgrounded = true;
    outputEvents.push({ at: timingParams.backgroundedAt, method: "item/updated", params: { item: { ...baseItemPayload, status: "inProgress" as const, revision: 2, recordedAt: iso(timingParams.backgroundedAt), background: true, backgroundInitiator: timingParams.initiator ?? "user", visibleOutput: accumulatedLogs } } });
  }
  if (timingParams.endedAt !== undefined) {
    const bg = timingParams.backgroundedAt !== undefined ? { background: true, backgroundInitiator: timingParams.initiator ?? "user" } : {};
    outputEvents.push({ at: timingParams.endedAt, method: "item/completed", params: { item: { ...baseItemPayload, status: "completed" as const, revision: 3, recordedAt: iso(timingParams.endedAt), visibleOutput: accumulatedLogs, ...bg, ...timingParams.ending } } });
  }
  return outputEvents;
}

function createShellApprovalRequest(
  sessionIdentity: string, keyPrefix: string, itemRefId: string, turnRefId: string, callRefId: string, shellCommand: string, wildcardRule: string,
): ApprovalRequest {
  return {
    approvalId: sampleId(`${sessionIdentity}:approval:${keyPrefix}`), sessionId: sessionIdentity, itemId: itemRefId, turnId: turnRefId,
    toolName: "bash", toolCallId: callRefId, currentRequirementId: `req-${keyPrefix}`, subject: { kind: "shell", command: shellCommand, workspaceRoot: PROJECTS.atlas },
    availableChoices: [
      { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: wildcardRule },
      { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
      { choiceId: "reject", label: "Reject", decision: "denied", scope: "once", acceptsFeedback: true },
    ],
  };
}

const TODO_STEP_1 = "Scope the diff since v1.9.0";
const TODO_STEP_2 = "Audit routes, schema, SDK and migrations in parallel";
const TODO_STEP_3 = "Merge the findings into release-note wording";

function auditThread(currentTime: number, chosenScenario: Scenario): { thread: SeedThread; run: AuditRun; streams: TaskStream[] } {
  const isScenarioCompleted = chosenScenario === "done";
  const startMoment = currentTime - (isScenarioCompleted ? toMs(45, 50) : toMs(41, 16));
  const recorder = new Script(THREADS.audit, PROJECTS.atlas, startMoment - 11_400, { branch: "release/v2.0" });
  const activeTurn = recorder.begin(AUDIT_PROMPT);

  recorder.think("**Partitioning the audit**\n\nThe 4 domains (routes, schema, sdk, migrations) can be audited independently in parallel. Two judge models then evaluate findings, and release notes are generated.", 2600);

  recorder.todos([
    { text: TODO_STEP_1, status: "inProgress", activeForm: "Scoping the diff since v1.9.0" },
    { text: TODO_STEP_2, status: "pending" },
    { text: TODO_STEP_3, status: "pending" },
  ]);

  recorder.tool("bash", { command: "git diff --stat v1.9.0..HEAD -- src openapi sdk migrations", description: "See what changed since v1.9.0" }, " migrations/0042_orders_currency.sql | 18 +++\n migrations/0043_drop_legacy_tokens.sql | 9 ++\n openapi/v2.yaml | 214 ++++++++++++-------\n sdk/typescript/src/client.ts | 23 +--\n sdk/typescript/src/orders.ts | 61 +++---\n src/routes/orders.ts | 74 ++++---\n src/routes/tokens.ts | 41 ++---\n src/routes/webhooks.ts | 36 +++-\n 8 files changed, 311 insertions(+), 165 deletions(-)\n", 3100);
  recorder.bill(38_400, 610);

  recorder.todos([
    { text: TODO_STEP_1, status: "completed" },
    { text: TODO_STEP_2, status: "inProgress", activeForm: "Auditing routes, schema, SDK and migrations in parallel" },
    { text: TODO_STEP_3, status: "pending" },
  ]);

  const synthesizedScriptText = synthesizeWorkflowScript(AUDIT_PLAN);
  recorder.tool("workflow", { name: RUN_NAME, script: synthesizedScriptText }, JSON.stringify({
    status: "admitted", maxParallelAgents: 16, policy: { childLimit: 16, tokenBudget: null },
    scriptPath: `${PROJECTS.atlas}/.muse/workflows/scripts/generated.workflow.${RUN_NAME}.js`, scriptBytes: synthesizedScriptText.length, hostApiVersion: 3,
  }), 4200, { callId: LAUNCH_CALL });
  recorder.bill(41_900, 1_240);

  const workflowRunEntity: AuditRun = {
    sessionId: THREADS.audit, turnId: activeTurn, itemId: recorder.id("workflow"), callId: LAUNCH_CALL, runId: `workflow-run-model-tool-${LAUNCH_CALL}`,
    name: RUN_NAME, scriptId: `generated.workflow.${RUN_NAME}`, plan: AUDIT_PLAN.flatMap((phaseItem) => phaseItem.agents), startedAt: startMoment,
    endedAt: isScenarioCompleted ? startMoment + toMs(45, 10) : null, status: isScenarioCompleted ? "completed" : "inProgress", revision: 0, revisedAt: startMoment,
    children: instantiateAuditChildren(THREADS.audit, startMoment, chosenScenario), summary: isScenarioCompleted ? AUDIT_SUMMARY : null, report: AUDIT_SUMMARY,
    failure: REPLAY_FAILURE, handoffs: AUDIT_HANDOFFS, stoppedReply: AUDIT_STOPPED,
  };

  const scheduledEventsQueue: TimedEventRecord[] = [];
  const compiledRevisions = auditHistory(workflowRunEntity, currentTime);
  for (const singleRevision of compiledRevisions) {
    scheduledEventsQueue.push({ at: singleRevision.at, method: singleRevision.method, params: { item: singleRevision.item } });
  }
  workflowRunEntity.revision = compiledRevisions.length;
  workflowRunEntity.revisedAt = compiledRevisions[compiledRevisions.length - 1]?.at ?? startMoment;

  const pendingApprovalsList: ApprovalRequest[] = [];
  const includesInteractiveApproval = chosenScenario !== "stalled" && chosenScenario !== "failed";

  if (includesInteractiveApproval) {
    const compatItemId = recorder.id("toolCall");
    const compatCallRef = "call_01a0f3c4c0a7";
    const compatCommandString = "npm test -- test/sdk-compat.test.ts";
    const serializedArgs = JSON.stringify({ command: compatCommandString, description: "Run the v1 SDK compatibility tests" });
    const requestTimestamp = startMoment + toMs(39, 36);

    const generatedApproval = createShellApprovalRequest(THREADS.audit, "compat", compatItemId, activeTurn, compatCallRef, compatCommandString, "npm test *");
    scheduledEventsQueue.push({ at: requestTimestamp, method: "item/started", params: { item: { itemId: compatItemId, kind: "toolCall", tool: "bash", callId: compatCallRef, args: serializedArgs, status: "inProgress", revision: 1, turnId: activeTurn, recordedAt: iso(requestTimestamp) } } });
    scheduledEventsQueue.push({ at: requestTimestamp + 200, method: "approval/requested", params: generatedApproval as unknown as Record<string, unknown> });

    if (isScenarioCompleted) {
      const decisionTimestamp = startMoment + toMs(41, 16);
      scheduledEventsQueue.push({ at: decisionTimestamp, method: "approval/resolved", params: { approvalId: generatedApproval.approvalId, decision: "approved", resolvedBy: "user" } });
      scheduledEventsQueue.push({ at: startMoment + toMs(41, 21), method: "item/completed", params: { item: { itemId: compatItemId, kind: "toolCall", tool: "bash", callId: compatCallRef, args: serializedArgs, status: "completed", revision: 2, turnId: activeTurn, recordedAt: iso(startMoment + toMs(41, 21)), visibleOutput: "> atlas-api@2.0.0-rc.1 test\n> vitest run test/sdk-compat.test.ts\n\n PASS  test/sdk-compat.test.ts (6 tests, 412ms)\n" } } });
    } else {
      pendingApprovalsList.push(generatedApproval);
    }
  }

  const liveTaskStreams: TaskStream[] = [];
  if (includesInteractiveApproval) {
    const e2eTaskId = recorder.id("toolCall");
    const steerTimestamp = startMoment + toMs(39, 45);

    scheduledEventsQueue.push({ at: steerTimestamp, method: "item/completed", params: { item: { itemId: recorder.id("userMessage"), kind: "userMessage", status: "completed", revision: 1, text: "While that runs, kick off the e2e suite for orders in the background so we know the RC still passes.", steered: true, turnId: activeTurn, recordedAt: iso(steerTimestamp) } } });
    scheduledEventsQueue.push({ at: startMoment + toMs(39, 51), method: "item/completed", params: { item: { itemId: recorder.id("agentMessage"), kind: "agentMessage", status: "completed", revision: 1, text: "Starting the orders e2e suite; the audit carries on meanwhile.", turnId: activeTurn, recordedAt: iso(startMoment + toMs(39, 51)) } } });

    const printedCount = chosenScenario === "waiting" ? 7 : isScenarioCompleted ? E2E_CHUNKS.length : 13;
    const logChunksBatch: { at: number; text: string }[] = [{ at: startMoment + toMs(39, 55), text: E2E_HEAD }];
    E2E_CHUNKS.slice(0, printedCount).forEach((chunkText, chunkIndex) => {
      const chunkTimestamp = chunkIndex < 12 ? startMoment + toMs(39, 58) + chunkIndex * 6_000 : chunkIndex === 12 ? startMoment + toMs(41, 12) : startMoment + toMs(41, 12) + (chunkIndex - 12) * 20_000;
      logChunksBatch.push({ at: chunkTimestamp, text: chunkText });
    });

    const backgroundJobShape: ExecutionTaskShape = { itemId: e2eTaskId, command: E2E_COMMAND, description: "Run the orders e2e suite", callId: E2E_CALL, turnId: activeTurn };
    scheduledEventsQueue.push(...generateTaskTimeline(backgroundJobShape, { startedAt: startMoment + toMs(39, 53), outputs: logChunksBatch, backgroundedAt: startMoment + toMs(40, 20), initiator: "user", ...(isScenarioCompleted ? { endedAt: startMoment + toMs(43, 12) } : {}) }));

    if (chosenScenario === "waiting") {
      const netApprovalTimestamp = startMoment + toMs(40, 41);
      const networkApprovalReq: ApprovalRequest = {
        approvalId: sampleId(`${THREADS.audit}:approval:e2e-network`), sessionId: THREADS.audit, itemId: e2eTaskId, turnId: activeTurn,
        toolName: "bash", toolCallId: E2E_CALL, currentRequirementId: "req-net-1", subject: { kind: "network", host: "cdn.playwright.dev", port: 443, protocol: "https" },
        availableChoices: [
          { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
          { choiceId: "reject", label: "Reject", decision: "denied", scope: "once", acceptsFeedback: true },
        ],
      };
      scheduledEventsQueue.push({ at: netApprovalTimestamp, method: "approval/requested", params: networkApprovalReq as unknown as Record<string, unknown> });
      pendingApprovalsList.push(networkApprovalReq);
    }

    if (!isScenarioCompleted) {
      liveTaskStreams.push({ sessionId: THREADS.audit, itemId: e2eTaskId, lines: E2E_CHUNKS.slice(printedCount) });
    }
  }

  if (isScenarioCompleted) {
    const finalRunEndTimestamp = workflowRunEntity.endedAt as number;
    scheduledEventsQueue.push({ at: finalRunEndTimestamp + 1_000, method: "session/todoListChanged", params: { items: [
      { text: TODO_STEP_1, status: "completed" },
      { text: TODO_STEP_2, status: "completed" },
      { text: TODO_STEP_3, status: "completed" },
    ] } });
    scheduledEventsQueue.push({ at: finalRunEndTimestamp + 2_000, method: "item/completed", params: { item: { itemId: recorder.id("agentMessage"), kind: "agentMessage", status: "completed", revision: 1, text: AUDIT_SUMMARY, turnId: activeTurn, recordedAt: iso(finalRunEndTimestamp + 2_000) } } });
    scheduledEventsQueue.push({ at: finalRunEndTimestamp + 3_000, method: "turn/completed", params: { turnId: activeTurn, terminal: "completed", durationMs: finalRunEndTimestamp + 3_000 - (startMoment - 10_800), timeToFirstTokenMs: 1600 } });
  }

  scheduledEventsQueue.sort((first, second) => first.at - second.at);
  for (const singleEvent of scheduledEventsQueue) {
    recorder.pushAt(singleEvent.at, singleEvent.method, singleEvent.params);
  }

  const finalizedThread = buildSeedThread(recorder, "Audit the v2 API for breaking changes", 1, {
    live: isScenarioCompleted ? makeLiveStatus() : makeLiveStatus({ activeTurnId: activeTurn, turnStartedAt: iso(startMoment - 10_800), pendingApprovals: pendingApprovalsList.length, lastTerminal: null }),
  }, pendingApprovalsList);

  if (chosenScenario === "partial") {
    const itemTargetIndex = finalizedThread.events.findIndex((ev) => (ev.params["item"] as MspItem | undefined)?.itemId === workflowRunEntity.itemId);
    if (itemTargetIndex >= 0) {
      finalizedThread.events.splice(itemTargetIndex, 1);
    }
    finalizedThread.truncated = true;
  }

  return { thread: finalizedThread, run: workflowRunEntity, streams: liveTaskStreams };
}

const DOCS_COMMAND = "npm run docs:build";
const DIFF_COMMAND = "npx openapi-diff openapi/v1.9.0.yaml openapi/v2.yaml";
function tasksThread(clockTime: number): { thread: SeedThread; streams: TaskStream[] } {
  const recorder = new Script(THREADS.audit, PROJECTS.atlas, clockTime - 6 * MIN, { branch: "release/v2.0" });
  const turnIdent = recorder.begin("Before tagging v2.0, execute docs build, OpenAPI schema diff against v1.9.0, and orders e2e test suite. Send slow jobs to background.");
  recorder.think("**Executing validation checks**\n\nDocs reference compilation and e2e tests run in background while schema comparison finishes quickly.", 2200);
  recorder.bill(21_300, 410);

  const computePastOffset = (m: number, s = 0) => clockTime - toMs(m, s);
  const taskEventsBatch: TimedEventRecord[] = [];
  const docsTaskId = recorder.id("toolCall");
  taskEventsBatch.push(...generateTaskTimeline({ itemId: docsTaskId, command: DOCS_COMMAND, description: "Build the API reference", callId: "call_01a0f3c4d0c5", turnId: turnIdent }, {
    startedAt: computePastOffset(5, 40),
    outputs: [
      { at: computePastOffset(5, 38), text: "> atlas-api@2.0.0-rc.1 docs:build\n> typedoc --out docs/api-ref src\n\n" },
      { at: computePastOffset(4, 52), text: "[info] Loading entry points\n" },
      { at: computePastOffset(4, 10), text: "[info] Resolving 212 declarations\n" },
    ],
    backgroundedAt: computePastOffset(5, 10), initiator: "timeout",
  }));

  const diffTaskId = recorder.id("toolCall");
  taskEventsBatch.push(...generateTaskTimeline({ itemId: diffTaskId, command: DIFF_COMMAND, description: "Diff the OpenAPI schema against v1.9.0", callId: "call_01a0f3c4d1ff", turnId: turnIdent }, {
    startedAt: computePastOffset(4, 50),
    outputs: [
      { at: computePastOffset(4, 48), text: "openapi-diff 3.2.0 · comparing openapi/v1.9.0.yaml → openapi/v2.yaml\n" },
      { at: computePastOffset(4, 5), text: "3 breaking changes\n  - removed: DELETE /v1/tokens/legacy\n  - changed: GET /v1/orders response.data[].total number → object\n  - removed: GET /v1/orders query.page\n" },
    ],
    backgroundedAt: computePastOffset(4, 30), initiator: "user", endedAt: computePastOffset(3, 40),
    ending: { status: "failed", failureKind: "tool_error", failureReason: "openapi-diff exited with status 2" },
  }));

  taskEventsBatch.push({ at: computePastOffset(3, 30), method: "item/completed", params: { item: { itemId: recorder.id("agentMessage"), kind: "agentMessage", status: "completed", revision: 1, turnId: turnIdent, recordedAt: iso(computePastOffset(3, 30)), text: "OpenAPI schema diff detected three breaking alterations and returned exit code 2. The docs build and orders e2e test suite are executing in the background." } } });

  const e2eTestTaskId = recorder.id("toolCall");
  const e2eOutputsBatch: { at: number; text: string }[] = [{ at: computePastOffset(1, 21), text: E2E_HEAD }];
  E2E_CHUNKS.slice(0, 13).forEach((chunkText, idx) => {
    e2eOutputsBatch.push({ at: idx < 12 ? computePastOffset(1, 18) + idx * 5_800 : computePastOffset(0, 4), text: chunkText });
  });

  taskEventsBatch.push(...generateTaskTimeline({ itemId: e2eTestTaskId, command: E2E_COMMAND, description: "Run the orders e2e suite", callId: E2E_CALL, turnId: turnIdent }, {
    startedAt: computePastOffset(1, 23), outputs: e2eOutputsBatch, backgroundedAt: computePastOffset(1, 0), initiator: "user",
  }));

  taskEventsBatch.sort((a, b) => a.at - b.at);
  for (const evt of taskEventsBatch) {
    recorder.pushAt(evt.at, evt.method, evt.params);
  }

  const generatedThreadModel = buildSeedThread(recorder, "Run the release checks for v2.0", 1, {
    live: makeLiveStatus({ activeTurnId: turnIdent, turnStartedAt: iso(clockTime - 6 * MIN + 600), lastTerminal: null }),
  });
  return { thread: generatedThreadModel, streams: [{ sessionId: THREADS.audit, itemId: e2eTestTaskId, lines: E2E_CHUNKS.slice(13) }] };
}

const BIG_NAME = "replay-recorded-traffic";
const BIG_CALL = "call_01a0f3c4b1a9";
const BIG_STAGES = ["load", "replay", "diff", "classify", "cluster", "verify", "rank", "write"] as const;
const BIG_SHARDS = 250;
const BIG_SLOTS = 36;
const BIG_WAVE_MS = 90_000;
const BIG_FAILED: ReadonlySet<string> = new Set([
  "replay:shard-087",
  "classify:shard-140",
  "verify:shard-012",
  "verify:shard-201",
]);
const BIG_SCRIPT = `export default async function workflow(host) {
  const shards = Array.from({ length: 250 }, (_, i) => String(i + 1).padStart(3, "0"));
  const jobs = (stg, carry) => shards.map((shard) => ({ label: \`\${stg}:shard-\${shard}\`, input: \`\${stg} shard \${shard} against the v2 build\`, carry }));
  let carry = null;
  for (const stg of ["load", "replay", "diff", "classify", "cluster", "verify"]) {
    carry = await host.parallel(jobs(stg, carry));
  }
  const [ranked, written] = await Promise.all([host.parallel(jobs("rank", carry)), host.parallel(jobs("write", carry))]);
  return { ranked, written };
}`;
export const BIG_SUMMARY = `## Replay of recorded v1 traffic against v2

Replayed production request captures across 250 partitioned shards through the v2 engine pipeline.
Six pipeline phases completed across all shards before verification halted on shard 201.

* Verified 246 shards with 0 discrepancies.
* Shard 201 encountered downstream connection resets under synthetic concurrency.
* Classified artifacts saved to \`fixtures/traffic/out/\`.`;

function generateBigRunChildren(): { specs: [string, number, AuditAttempt[]][]; now: number } {
  const stageGroups: number[][] = [[0], [1], [2], [3], [4], [5], [6, 7]];
  const compiledSpecs: [string, number, AuditAttempt[]][] = [];
  let timelineClock = 0;
  let simulatedPresent = 0;

  stageGroups.forEach((groupStages, groupIndex) => {
    const scheduledTime = timelineClock;
    const initialWaveTimestamp = scheduledTime + 1_000;
    const isFinalGroup = groupIndex === stageGroups.length - 1;

    const groupMembers = groupStages.flatMap((stg) =>
      Array.from({ length: BIG_SHARDS }, (_, shardNum) => ({ stage: stg, i: shardNum })),
    );
    const wavesFinishedCount = isFinalGroup ? 11 : Number.POSITIVE_INFINITY;

    groupMembers.forEach((memberInfo, memberIndex) => {
      const calculatedWave = Math.floor(memberIndex / BIG_SLOTS);
      const stageName = BIG_STAGES[memberInfo.stage] as string;
      const shardLabel = `${stageName}:shard-${String(memberInfo.i + 1).padStart(3, "0")}`;
      const attemptData: AuditAttempt = { attempt: 1, scheduledAt: scheduledTime };
      const waveStartTime = initialWaveTimestamp + calculatedWave * BIG_WAVE_MS;

      if (calculatedWave < wavesFinishedCount) {
        attemptData.startedAt = waveStartTime;
        attemptData.endedAt = waveStartTime + BIG_WAVE_MS;
        attemptData.durationMs = BIG_WAVE_MS;
        if (BIG_FAILED.has(shardLabel)) {
          attemptData.terminal = "failed";
        } else {
          attemptData.terminal = "completed";
          attemptData.usageAt = attemptData.endedAt - 2_000;
          attemptData.usage = tokensOf(18_000 + ((memberInfo.i * 7_919 + memberInfo.stage * 104_729) % 26_000));
        }
      } else if (calculatedWave === wavesFinishedCount) {
        attemptData.startedAt = waveStartTime;
      }

      compiledSpecs.push([shardLabel, 4 + ((memberInfo.i * 31 + memberInfo.stage * 7) % 15), [attemptData]]);
    });

    if (isFinalGroup) {
      simulatedPresent = initialWaveTimestamp + wavesFinishedCount * BIG_WAVE_MS + 40_000;
    } else {
      timelineClock = initialWaveTimestamp + Math.ceil(groupMembers.length / BIG_SLOTS) * BIG_WAVE_MS + 2_000;
    }
  });

  return { specs: compiledSpecs, now: simulatedPresent };
}
function bigThread(currentTime: number): { thread: SeedThread; run: AuditRun; streams: TaskStream[] } {
  const generatedModel = generateBigRunChildren();
  const startTimestamp = currentTime - generatedModel.now;

  const recorder = new Script(THREADS.audit, PROJECTS.atlas, startTimestamp - 9_000, { branch: "release/v2.0" });
  const turnId = recorder.begin("Replay recorded v1 fixtures against the v2 engine across all shards, classifying differing response bodies.");

  recorder.think("**250 shards fanning across 8 pipeline phases**\n\nIndependent shard processing allows massive parallelism; terminal evaluation stages share common verified datasets.", 2200);
  recorder.tool("bash", { command: "ls fixtures/traffic | wc -l", description: "Count the traffic shards" }, "250\n", 1900);
  recorder.bill(24_600, 520);

  recorder.tool("workflow", { name: BIG_NAME, script: BIG_SCRIPT }, JSON.stringify({
    status: "admitted", maxParallelAgents: BIG_SLOTS, policy: { childLimit: BIG_SLOTS, tokenBudget: null },
    scriptPath: `${PROJECTS.atlas}/.muse/workflows/scripts/generated.workflow.${BIG_NAME}.js`, scriptBytes: BIG_SCRIPT.length, hostApiVersion: 3,
  }), 3600, { callId: BIG_CALL });
  recorder.bill(26_100, 980);

  const bigAuditRunEntity: AuditRun = {
    sessionId: THREADS.audit, turnId, itemId: recorder.id("workflow"), callId: BIG_CALL, runId: `workflow-run-model-tool-${BIG_CALL}`,
    name: BIG_NAME, scriptId: `generated.workflow.${BIG_NAME}`, plan: [], startedAt: startTimestamp, endedAt: null,
    status: "inProgress", revision: 0, revisedAt: startTimestamp, children: attachAbsoluteTimestamps(THREADS.audit, startTimestamp, generatedModel.specs),
    summary: null, report: BIG_SUMMARY, failure: "verify:shard-201: the v2 build answered 502 for every request in the shard",
    handoffs: [{ agent: "write:shard-250", description: "fixtures/traffic/out/: classified outputs per shard" }],
    stoppedReply: "Replay stopped. Six pipeline stages completed across all 250 shards; ranking and writing were in progress. Partial results are in fixtures/traffic/out/.",
  };

  const revisionEventsList = auditHistory(bigAuditRunEntity, currentTime);
  for (const rev of revisionEventsList) {
    recorder.pushAt(rev.at, rev.method, { item: rev.item });
  }

  bigAuditRunEntity.revision = revisionEventsList.length;
  bigAuditRunEntity.revisedAt = revisionEventsList[revisionEventsList.length - 1]?.at ?? startTimestamp;

  const finalizedBigThread = buildSeedThread(recorder, "Replay recorded traffic against v2", 1, {
    live: makeLiveStatus({ activeTurnId: turnId, turnStartedAt: iso(startTimestamp - 8_400), lastTerminal: null }),
  });

  return { thread: finalizedBigThread, run: bigAuditRunEntity, streams: [] };
}

function paginationThread(currentTime: number): SeedThread {
  const recorder = new Script(THREADS.pagination, PROJECTS.atlas, currentTime - 74 * MIN, { branch: "feat/orders-cursor" });
  recorder.begin("Migrate GET /v1/orders from offset to opaque cursor pagination to eliminate deep page scan bottlenecks (maintain limit default 50, maximum 200) and adjust test cases accordingly.");
  recorder.think("**Analyzing orders endpoint**\n\nThe current query translates page into offset skip. Using a cursor on (createdAt, id) enables indexed keyset pagination.");
  recorder.tool("read", { file_path: "src/routes/orders.ts" }, ORDERS_BEFORE, 1900);
  recorder.tool("grep", { pattern: "listOrders|page=", path: "." }, "src/routes/orders.ts:6:export async function listOrders\nsrc/app.ts:12:app.get(\"/v1/orders\", listOrders)\ntest/orders.test.ts:14:const res = await request(app).get(\"/v1/orders?page=2\")", 2100);
  recorder.tool("read", { file_path: "test/orders.test.ts" }, ORDERS_TEST_BEFORE, 1700);
  recorder.bill(29_800, 540);
  recorder.tool("write", { file_path: "src/lib/cursor.ts", content: CURSOR_TS }, undefined, 6800);
  recorder.tool("multi_edit", { file_path: "src/routes/orders.ts", edits: [{ old_string: 'import { db } from "../db.js";\n\nconst PAGE_SIZE = 50;', new_string: 'import { db } from "../db.js";\nimport { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";\n\nconst PAGE_SIZE = 50;\nconst MAX_PAGE_SIZE = 200;' }, { old_string: ORDERS_HANDLER_BEFORE, new_string: ORDERS_HANDLER_AFTER }] }, undefined, 5400);
  recorder.tool("edit", { file_path: "test/orders.test.ts", old_string: ORDERS_TEST_OLD, new_string: ORDERS_TEST_NEW }, undefined, 5100);
  recorder.bill(36_200, 2_180);
  recorder.tool("bash", { command: "npm test -- test/orders.test.ts", description: "Run the orders tests" }, "> atlas-api@2.0.0-rc.1 test\n> vitest run test/orders.test.ts\n\n PASS  test/orders.test.ts (4 tests, 184ms)\n\nTest Files: 1 passed\nTests: 4 passed\nDuration: 1.12s\n", 8200);
  recorder.say([
    "Switched `GET /v1/orders` to cursor-based keyset pagination.",
    "",
    "- [src/routes/orders.ts](src/routes/orders.ts): parses `cursor` and `limit` (50 default, 200 ceiling), responding with `{ data, nextCursor }` via n+1 probe.",
    "- [src/lib/cursor.ts](src/lib/cursor.ts): encodes timestamp and record identifier into opaque base64url tokens.",
    "- Rejects invalid cursor formatting with HTTP 400 Bad Request.",
    "",
    "All 4 unit tests passing. Legacy callers providing `page` receive the initial page.",
  ].join("\n"));
  recorder.bill(39_100, 420);
  recorder.end(161_000);

  recorder.begin("Please document the pagination changes in the API reference.", 5 * MIN);
  recorder.tool("read", { file_path: "docs/api/orders.md" }, DOCS_BEFORE, 1500);
  recorder.tool("edit", { file_path: "docs/api/orders.md", old_string: DOCS_PAGINATION_OLD, new_string: DOCS_PAGINATION_NEW }, undefined, 4300);
  recorder.say("Documented the keyset pagination contract in [docs/api/orders.md](docs/api/orders.md) including sample queries and legacy fallback.");
  recorder.bill(40_300, 610);
  recorder.end(38_000);

  return buildSeedThread(recorder, "Add cursor pagination to GET /v1/orders", 2);
}

function contrastThread(clockTime: number): SeedThread {
  const recorder = new Script(THREADS.contrast, PROJECTS.lumen, clockTime - 4 * MIN, { branch: "fix/dark-contrast" });
  const turnIdentifier = recorder.begin("Improve text contrast of muted labels in settings dialog under dark theme mode without modifying light palette.");
  recorder.think("**Evaluating WCAG color contrast**\n\nExisting muted color token resolves to #6b7280 against dark surface, yielding 3.8:1 ratio below AA 4.5:1 threshold.");
  recorder.tool("grep", { pattern: "--text-muted", path: "src" }, "src/styles/tokens.css:4:--text-muted: #6b7280\nsrc/styles/tokens.css:10:--text-muted: #6b7280\nsrc/components/SettingsDialog.module.css:12:color: var(--text-muted)", 1800);
  recorder.tool("read", { file_path: "src/styles/tokens.css" }, TOKENS_BEFORE, 1600);
  recorder.bill(22_600, 480);
  recorder.tool("edit", { file_path: "src/styles/tokens.css", old_string: TOKENS_DARK_OLD, new_string: TOKENS_DARK_NEW }, undefined, 4700);

  const snapshotUpdateCmd = "npx playwright test settings-dialog --update-snapshots";
  const pendingToolItem = recorder.add({ kind: "toolCall", tool: "bash", callId: "call_01a0f3d1b9c4", args: JSON.stringify({ command: snapshotUpdateCmd, description: "Update the settings dialog's visual snapshots" }) }, 3300, "item/started");
  recorder.bill(24_100, 390);

  const dialogApproval: ApprovalRequest = {
    approvalId: sampleId(`${THREADS.contrast}:approval`), sessionId: THREADS.contrast, itemId: pendingToolItem.itemId, turnId: turnIdentifier,
    toolName: "bash", toolCallId: "call_01a0f3d1b9c4", currentRequirementId: "req-1", subject: { kind: "shell", command: snapshotUpdateCmd, workspaceRoot: PROJECTS.lumen },
    availableChoices: [
      { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: "npx playwright test *" },
      { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
      { choiceId: "reject", label: "Reject", decision: "denied", scope: "once", acceptsFeedback: true },
    ],
  };
  recorder.push("approval/requested", dialogApproval as unknown as Record<string, unknown>, 200);

  return buildSeedThread(recorder, "Fix low-contrast muted text in dark mode", 1, {
    live: makeLiveStatus({ activeTurnId: turnIdentifier, turnStartedAt: iso(clockTime - 4 * MIN + 600), pendingApprovals: 1, lastTerminal: null }),
  }, [dialogApproval]);
}

function lazyChartsThread(clockTime: number): SeedThread {
  const recorder = new Script(THREADS.lazyCharts, PROJECTS.lumen, clockTime - 12 * MIN, { branch: "perf/lazy-charts" });
  recorder.begin("Optimize bundle size by dynamically importing charts only when rendered on screen.");
  recorder.tool("grep", { pattern: 'from "@/charts"', path: "src" }, 'src/pages/Dashboard.tsx:1:import { RevenueChart } from "@/charts";\nsrc/pages/Reports.tsx:5:import { RevenueChart, UsageChart } from "@/charts";', 1700);
  recorder.tool("read", { file_path: "src/pages/Dashboard.tsx" }, DASHBOARD_BEFORE, 1500);
  recorder.bill(19_800, 360);

  const surveySubagentKey = sampleId(`${THREADS.lazyCharts}:subagent:chart-imports-survey`);
  const surveyTaskRef = `subagent-task://${surveySubagentKey}/1`;
  recorder.tool("subagent_spawn", {
    command_id: sampleId(`${THREADS.lazyCharts}:command:survey`),
    objective: "Check every other page that imports @/charts and say whether it renders a chart on first paint, so an eager import there is justified.",
    role: "explorer", task_name: "chart-imports-survey",
  }, JSON.stringify({ status: "accepted", subagent_id: surveySubagentKey, work_id: sampleId(`${THREADS.lazyCharts}:work:survey`), agent_path: "main/chart-imports-survey/1", task_ref: surveyTaskRef }), 900);

  recorder.tool("edit", { file_path: "src/pages/Dashboard.tsx", old_string: DASHBOARD_OLD, new_string: DASHBOARD_NEW }, undefined, 4200);
  recorder.tool("bash", { command: "npm run build", description: "Build to compare chunk sizes" }, "> lumen-web@0.9.0 build\n> vite build\n\ndist/assets/index.js 148 kB\ndist/assets/RevenueChart.js 232 kB\nBuilt cleanly.\n", 7600);
  recorder.tool("subagent_wait", { subagent_id: surveySubagentKey, timeout_ms: 120_000, wait_for: "result" }, JSON.stringify({
    status: "completed", subagent_id: surveySubagentKey, task_ref: surveyTaskRef,
    summary: "Reports.tsx renders UsageChart above the fold on every report, so its eager import is right; no other page imports @/charts.",
    workspace: { placement: "shared", setup: "none", parent_changes: [] }, evidence_refs: [],
  }), 2400);

  recorder.say("Deferred charting library load via React.lazy on Dashboard. Initial entry payload decreased to 148 kB while Reports retains direct import.");
  recorder.bill(21_400, 520);
  recorder.end(64_000);

  return buildSeedThread(recorder, "Lazy-load the charts bundle", 1);
}

function statusJsonThread(clockTime: number): SeedThread {
  const recorder = new Script(THREADS.statusJson, PROJECTS.orbit, clockTime - 3 * HOUR - 12 * MIN, { branch: "main" });
  recorder.begin("Provide a --json command-line argument for orbit status for automation scripts.");
  recorder.tool("read", { file_path: "cmd/status.go" }, STATUS_GO_BEFORE, 1500);
  recorder.tool("read", { file_path: "internal/workspace/repo.go" }, REPO_GO_BEFORE, 1300);
  recorder.bill(14_200, 300);
  recorder.tool("multi_edit", {
    file_path: "cmd/status.go",
    edits: [
      { old_string: 'import "flag"', new_string: 'import "encoding/json"; import "flag"' },
      { old_string: '\tcmdFlags := flag.NewFlagSet("status", flag.ContinueOnError)', new_string: '\tcmdFlags := flag.NewFlagSet("status", flag.ContinueOnError)\n\tasJSON := cmdFlags.Bool("json", false, "Emit machine-readable JSON array")' },
      { old_string: '\tfor _, repoItem := range repoList {', new_string: '\tif *asJSON {\n\t\tencoder := json.NewEncoder(writer)\n\t\tencoder.SetIndent("", "  ")\n\t\treturn encoder.Encode(repoList)\n\t}\n\tfor _, repoItem := range repoList {' },
    ],
  }, undefined, 5200);
  recorder.tool("edit", { file_path: "internal/workspace/repo.go", old_string: REPO_STRUCT_OLD, new_string: REPO_STRUCT_NEW }, undefined, 3100);
  recorder.tool("bash", { command: "go test ./...", description: "Run the tests" }, "ok  	orbit/cmd	0.214s\nok  	orbit/internal/sync	0.388s\nok  	orbit/internal/workspace	0.102s\n", 6400);
  recorder.tool("bash", { command: "go run . status --json", description: "Try the new flag" }, '[{"name":"atlas-api","branch":"release/v2.0","ahead":3,"behind":0,"dirty":false}]\n', 3900);
  recorder.say("Added --json flag to orbit status emitting structured JSON payloads formatted with 2-space indentation.");
  recorder.bill(17_900, 470);
  recorder.end(71_000);

  return buildSeedThread(recorder, "Add --json output to orbit status", 1, { accountId: SIDE_ACCOUNT });
}

function syncHangThread(clockTime: number): SeedThread {
  const recorder = new Script(THREADS.syncHang, PROJECTS.orbit, clockTime - 26 * HOUR, { branch: "main" });
  recorder.begin("Investigate why orbit sync hangs indefinitely on directories containing over 10k files.");
  recorder.tool("grep", { pattern: "chan ", path: "internal/sync" }, "internal/sync/walker.go:13:paths := make(chan string)\ninternal/sync/walker.go:14:results := make(chan Entry)\ninternal/sync/walker.go:15:errs := make(chan error)", 1600);
  recorder.tool("read", { file_path: "internal/sync/walker.go" }, WALKER_GO, 1400);
  recorder.think("**Diagnosing channel concurrency deadlock**\n\nUnbuffered error channel blocks workers on stat failure, preventing workgroup completion before results drain.", 2200);
  recorder.bill(16_300, 820);
  recorder.say([
    "Root cause identified: deadlock in [internal/sync/walker.go](internal/sync/walker.go#L22-L26).",
    "",
    "- Unbuffered `errs` channel halts worker execution on any path resolution failure.",
    "- Worker pool blocks before signaling `wg.Done()`, so `results` channel is never closed.",
    "- Reader loop on `results` blocks indefinitely awaiting channel termination.",
    "",
    "Recommended resolution: attach error status directly to `Entry` and unify error dispatch onto the primary results channel.",
  ].join("\n"));
  recorder.bill(18_100, 640);
  recorder.end(52_000);

  return buildSeedThread(recorder, "Why does orbit sync hang on large repos?", 1, { accountId: SIDE_ACCOUNT, origin: "muse" });
}

function rateLimitThread(clockTime: number): SeedThread {
  const recorder = new Script(THREADS.rateLimit, PROJECTS.atlas, clockTime - 2 * DAY - 3 * HOUR, { branch: "main" });
  recorder.begin("Enforce rate limit of 10 requests per minute per IP address on POST /v1/login.");
  recorder.tool("read", { file_path: "src/app.ts" }, APP_TS, 1500);
  recorder.tool("edit", { file_path: "src/app.ts", old_string: APP_LOGIN_OLD, new_string: APP_LOGIN_NEW }, undefined, 4100);
  recorder.tool("bash", { command: "npm test -- test/login.test.ts", description: "Run login tests" }, " PASS  test/login.test.ts (3 tests, 96ms)\nTest Files: 1 passed\nTests: 3 passed\n", 6100);
  recorder.say("The login endpoint now enforces 10 requests per minute per client IP, responding with 429 Too Many Requests once exceeded.");
  recorder.bill(21_700, 690);
  recorder.end(47_000);
  return buildSeedThread(recorder, "Rate-limit the login endpoint", 1, { live: null });
}

function viteThread(clockTime: number): SeedThread {
  const recorder = new Script(THREADS.vite, PROJECTS.lumenSite, clockTime - 6 * DAY - 2 * HOUR, { branch: "main" });
  recorder.begin("Upgrade Vite to v6 and fix whatever breaks.");

  recorder.tool(
    "bash",
    { command: "npm install -D vite@6 @vitejs/plugin-react@4", description: "Upgrade Vite" },
    "\nchanged 14 packages, and audited 402 packages in 6s\n\nfound 0 vulnerabilities\n",
    2200,
  );
  recorder.tool(
    "bash",
    { command: "npm run build", description: "Check the build" },
    "vite v6.0.7 building for production...\n✓ 409 modules transformed.\n✓ built in 2.91s\n",
    7400,
  );
  recorder.say(
    "Vite 6 builds cleanly with no config changes. The only difference in output is that CSS chunks are now hashed with 8 characters instead of 7.",
  );
  recorder.bill(12_400, 250);
  recorder.end(29_000);
  return buildSeedThread(recorder, "Upgrade to Vite 6", 1, {
    live: null,
    settled: true,
    settledAt: iso(clockTime - 4 * DAY),
  });
}
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

export const RESEARCH_REPORT = `# What muted text has to meet in dark mode

**Short answer.** WCAG 2.1 asks the same of secondary text as of any other body text: a contrast ratio of at least 4.5:1 against its background, or 3:1 when the text is large, which the guideline defines as 18 point, or 14 point bold [^1]. There is no lower bar for text that is meant to look secondary; the technique notes are explicit that de-emphasised text is still text [^2]. The AAA level raises the body-text bar to 7:1 [^3].

## What the guideline says

The minimum-contrast criterion (1.4.3) is a Level AA requirement and applies to the visual presentation of text and images of text. It exempts three things only: text that is part of an inactive user interface component, purely decorative text, and text inside a picture where the picture carries the meaning [^1]. Placeholder and hint text are not on that list, and the Understanding document treats them as ordinary text [^2].

The ratio is computed from relative luminance, so it does not care which of the two colours is lighter. That is why a muted grey that passes on white can fail on a dark surface: the same grey sits closer in luminance to a dark canvas than to a light one [^2].

## What that means for a dark theme

- Pick the muted colour per theme rather than sharing one hex value across both. A single value tuned for the light theme is the usual cause of a dark-mode failure [^2].
- Check the muted colour against every surface it sits on, not only the page background. Cards and sidebars in a dark theme are often a few steps lighter than the canvas, which lowers the ratio further [^1].
- Large text and non-text elements have their own, lower bar of 3:1 (1.4.11 for user interface components and graphical objects), which is the number to use for borders and icons, not for captions [^4].

## Open questions

The guideline measures contrast with the WCAG 2 formula. The draft APCA model used in some design tools weights dark-on-light and light-on-dark text differently, and a colour that passes one can fail the other; nothing here settles which a product should follow, only that the shipping standard is the WCAG 2 ratio [^1].

## Sources

[^1]: [Web Content Accessibility Guidelines (WCAG) 2.1, Success Criterion 1.4.3 Contrast (Minimum)](https://www.w3.org/TR/WCAG21/#contrast-minimum)
[^2]: [Understanding Success Criterion 1.4.3: Contrast (Minimum)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
[^3]: [Web Content Accessibility Guidelines (WCAG) 2.1, Success Criterion 1.4.6 Contrast (Enhanced)](https://www.w3.org/TR/WCAG21/#contrast-enhanced)
[^4]: [Web Content Accessibility Guidelines (WCAG) 2.1, Success Criterion 1.4.11 Non-text Contrast](https://www.w3.org/TR/WCAG21/#non-text-contrast)
`;

function createResearchWorkerRecord(
  workerId: number,
  roundNum: number,
  topicDesc: string,
  stateDesc: ResearchRunView["workers"][number]["state"],
  actionCounts: { searches: number; reads: number; saved: number },
  startTime: number,
  endTime: number | null,
): ResearchRunView["workers"][number] {
  return {
    agentId: workerId,
    round: roundNum,
    topic: topicDesc,
    discovery: false,
    state: stateDesc,
    toolCalls: actionCounts.searches + actionCounts.reads + actionCounts.saved,
    ...actionCounts,
    startedAt: iso(startTime),
    endedAt: endTime === null ? null : iso(endTime),
  };
}

function researchThread(clockTime: number): { thread: SeedThread; runs: ResearchRunView[] } {
  const recorder = new Script(THREADS.research, PROJECTS.lumen, clockTime - 52 * MIN, { branch: "fix/dark-contrast" });
  recorder.begin("Before I touch the tokens: what does WCAG actually require of muted text in dark mode, and is there a lower bar for secondary text?");

  recorder.say(
    "From memory: WCAG AA wants 4.5:1 for body text and 3:1 for large text, with no exception for text that is merely de-emphasised. I would rather not answer this from memory when the tokens depend on it: a deep research run on the question will come back with the guideline's own wording and where each claim comes from.",
  );
  recorder.bill(9_800, 210);
  recorder.end(14_000);

  const compiledThread = buildSeedThread(recorder, "What muted text has to meet in dark mode", 1, { live: null });

  const doneCreationStamp = clockTime - 50 * MIN;
  const doneStartStamp = doneCreationStamp + 2_000;
  const doneEndStamp = doneStartStamp + 7 * MIN + 41_000;

  const completedRunView: ResearchRunView = {
    runId: RESEARCH_RUNS.done,
    sessionId: THREADS.research,
    status: "completed",
    phase: "done",
    question: "What does WCAG require of muted or secondary text in dark mode, and is there a lower bar for de-emphasised text?",
    brief: "Establish the contrast WCAG 2.1 requires of secondary text, whether de-emphasised text is exempt, and what changes on a dark surface.",
    round: 3,
    maxRounds: RESEARCH_CONFIG.maxRounds,
    createdAt: iso(doneCreationStamp),
    startedAt: iso(doneStartStamp),
    endedAt: iso(doneEndStamp),
    researchDeadlineAt: iso(doneStartStamp + RESEARCH_CONFIG.windowMaxMinutes * MIN),
    workers: [
      createResearchWorkerRecord(1, 1, "the success criteria as written", "completed", { searches: 2, reads: 3, saved: 2 }, doneStartStamp + 24_000, doneStartStamp + 2 * MIN + 10_000),
      createResearchWorkerRecord(2, 1, "exemptions for placeholder and de-emphasised text", "completed", { searches: 3, reads: 4, saved: 1 }, doneStartStamp + 24_000, doneStartStamp + 2 * MIN + 40_000),
      createResearchWorkerRecord(3, 1, "how the ratio is measured", "completed", { searches: 2, reads: 2, saved: 1 }, doneStartStamp + 24_000, doneStartStamp + 1 * MIN + 55_000),
      createResearchWorkerRecord(4, 2, "non-text contrast and large text", "completed", { searches: 2, reads: 3, saved: 1 }, doneStartStamp + 3 * MIN, doneStartStamp + 4 * MIN + 30_000),
      createResearchWorkerRecord(5, 2, "APCA and the newer models", "completed", { searches: 3, reads: 3, saved: 0 }, doneStartStamp + 3 * MIN, doneStartStamp + 5 * MIN),
    ],
    sources: { registry: 14, verified: 11, curated: 4, opened: 9, searchOnly: 2, attempted: 1, listedEarlier: 0, evidence: 141 },
    usage: { inputTokens: 212_400, outputTokens: 9_850, cachedInputTokens: 96_200, totalTokens: 222_250 },
    failure: null,
    reportAvailable: true,
    report: RESEARCH_REPORT,
    reportPath: `${PROJECTS.lumen}/.ancilla/research/${RESEARCH_RUNS.done}/report.md`,
    config: RESEARCH_CONFIG,
  };

  const activeCreationStamp = clockTime - 3 * MIN - 20_000;
  const activeStartStamp = activeCreationStamp + 1_500;

  const runningRunView: ResearchRunView = {
    runId: RESEARCH_RUNS.running,
    sessionId: THREADS.research,
    status: "running",
    phase: "researching",
    question: "How do Radix Colors, GitHub Primer and Material 3 choose their muted text colours for dark themes, and what contrast do they land on?",
    brief: "Compare how three design systems derive secondary text colours in dark themes and the contrast each documents.",
    round: 2,
    maxRounds: RESEARCH_CONFIG.maxRounds,
    createdAt: iso(activeCreationStamp),
    startedAt: iso(activeStartStamp),
    endedAt: null,
    researchDeadlineAt: iso(activeStartStamp + RESEARCH_CONFIG.windowMaxMinutes * MIN),
    workers: [
      createResearchWorkerRecord(1, 1, "Radix Colors dark scales", "completed", { searches: 2, reads: 3, saved: 2 }, activeStartStamp + 20_000, activeStartStamp + 1 * MIN + 30_000),
      createResearchWorkerRecord(2, 1, "Primer's functional colour roles", "completed", { searches: 3, reads: 3, saved: 2 }, activeStartStamp + 20_000, activeStartStamp + 1 * MIN + 48_000),
      createResearchWorkerRecord(3, 1, "Material 3 tonal palettes", "failed", { searches: 1, reads: 0, saved: 0 }, activeStartStamp + 20_000, activeStartStamp + 50_000),
      createResearchWorkerRecord(4, 2, "Material 3 on-surface-variant", "working", { searches: 2, reads: 1, saved: 0 }, activeStartStamp + 2 * MIN + 5_000, null),
      createResearchWorkerRecord(5, 2, "documented contrast figures", "working", { searches: 1, reads: 0, saved: 0 }, activeStartStamp + 2 * MIN + 5_000, null),
      createResearchWorkerRecord(6, 2, "how the scales are generated", "queued", { searches: 0, reads: 0, saved: 0 }, activeStartStamp + 2 * MIN + 5_000, null),
    ],
    sources: { registry: 9, verified: 7, curated: 0, opened: 5, searchOnly: 2, attempted: 1, listedEarlier: 0, evidence: 89 },
    usage: { inputTokens: 88_300, outputTokens: 3_120, cachedInputTokens: 40_100, totalTokens: 91_420 },
    failure: null,
    reportAvailable: false,
    report: null,
    reportPath: null,
    config: RESEARCH_CONFIG,
  };

  return { thread: compiledThread, runs: [completedRunView, runningRunView] };
}

function turnThread(currentTime: number): { thread: SeedThread; streams: TaskStream[] } {
  const recorder = new Script(THREADS.audit, PROJECTS.atlas, currentTime - 20 * MIN, { branch: "main" });
  recorder.begin("Where does the renderer set up the camera?");
  recorder.tool(
    "grep",
    { pattern: "PerspectiveCamera", path: "src" },
    "src/scene.ts:41:  const camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 500);\n",
    1800,
  );
  recorder.bill(9_400, 120);
  recorder.say("The camera is created in `src/scene.ts`, line 41, with a 55 degree field of view.", 1400);
  recorder.end(6_000);

  return {
    thread: buildSeedThread(recorder, "Terrain scene", 1, { live: makeLiveStatus() }),
    streams: [],
  };
}
export function seed(currentTimestamp: number, scenarioKey: Scenario = "running"): Seed {
  const primaryBundle =
    scenarioKey === "task"
      ? { ...tasksThread(currentTimestamp), run: null }
      : scenarioKey === "turn"
        ? { ...turnThread(currentTimestamp), run: null }
        : scenarioKey === "big"
          ? bigThread(currentTimestamp)
          : auditThread(currentTimestamp, scenarioKey);

  const researchBundle = researchThread(currentTimestamp);

  return {
    threads: [
      primaryBundle.thread,
      contrastThread(currentTimestamp),
      researchBundle.thread,
      lazyChartsThread(currentTimestamp),
      paginationThread(currentTimestamp),
      statusJsonThread(currentTimestamp),
      syncHangThread(currentTimestamp),
      rateLimitThread(currentTimestamp),
      viteThread(currentTimestamp),
    ],
    audit: primaryBundle.run,
    streams: primaryBundle.streams,
    research: researchBundle.runs,
  };
}
// ------------------------------------------------------------------------------------ Code diff constants
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const ORDERS_HANDLER_BEFORE = `export async function listOrders(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(PAGE_SIZE, Math.max(1, parseInt(String(req.query.limit ?? PAGE_SIZE), 10) || PAGE_SIZE));
  const skip = (page - 1) * limit;

  const [orders, total] = await Promise.all([
    db.order.findMany({ skip, take: limit, orderBy: { createdAt: "desc" } }),
    db.order.count(),
  ]);

  res.json({ data: orders, page, totalPages: Math.ceil(total / limit), total });
}`;

export const ORDERS_HANDLER_AFTER = `export async function listOrders(req: Request, res: Response): Promise<void> {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(String(req.query.limit ?? PAGE_SIZE), 10) || PAGE_SIZE));
  const cursorParam = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  let cursorFilter = undefined;
  if (cursorParam) {
    try { cursorFilter = decodeCursor(cursorParam); } catch {
      res.status(400).json({ error: "invalid_cursor", message: "Cursor is malformed" });
      return;
    }
  }

  const items = await db.order.findMany({
    take: limit + 1, where: cursorFilter ? afterCursor(cursorFilter) : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const hasNextPage = items.length > limit;
  const pageItems = hasNextPage ? items.slice(0, limit) : items;
  const lastItem = pageItems[pageItems.length - 1];
  const nextCursor = hasNextPage && lastItem ? encodeCursor(lastItem) : null;

  res.json({ data: pageItems, nextCursor });
}`;

export const ORDERS_BEFORE = `import { Request, Response } from "express";
import { db } from "../db.js";

const PAGE_SIZE = 50;

${ORDERS_HANDLER_BEFORE}
`;

export const ORDERS_AFTER = `import { Request, Response } from "express";
import { db } from "../db.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

${ORDERS_HANDLER_AFTER}
`;

export const CURSOR_TS = `export type CursorPayload = { readonly createdAt: string; readonly id: string; };

export function encodeCursor(item: { createdAt: Date | string; id: string }): string {
  const rawTimestamp = item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt;
  const payload: CursorPayload = { createdAt: rawTimestamp, id: item.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursorToken: string): CursorPayload {
  const parsed = JSON.parse(Buffer.from(cursorToken, "base64url").toString("utf8")) as Record<string, unknown>;
  if (typeof parsed["createdAt"] !== "string" || typeof parsed["id"] !== "string") {
    throw new Error("Invalid cursor structure");
  }
  return { createdAt: parsed["createdAt"], id: parsed["id"] };
}

export function afterCursor(cursor: CursorPayload): Record<string, unknown> {
  return {
    OR: [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ],
  };
}
`;

export const ORDERS_TEST_HEAD = `import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("GET /v1/orders", () => {
`;

export const ORDERS_TEST_OLD = `  it("paginates by page offset", async () => {
    const res = await request(app).get("/v1/orders?page=2");
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
  });`;

export const ORDERS_TEST_NEW = `  it("pages with a cursor under load", async () => {
    const res1 = await request(app).get("/v1/orders?limit=2");
    expect(res1.status).toBe(200);
    expect(res1.body.data).toHaveLength(2);
    expect(res1.body.nextCursor).toBeTruthy();

    const res2 = await request(app).get(\`/v1/orders?cursor=\${res1.body.nextCursor}&limit=2\`);
    expect(res2.status).toBe(200);
    expect(res2.body.data).toHaveLength(2);
  });

  it("rejects invalid cursor tokens", async () => {
    const res = await request(app).get("/v1/orders?cursor=not-valid-base64");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
  });`;

export const ORDERS_TEST_BEFORE = `${ORDERS_TEST_HEAD}${ORDERS_TEST_OLD}\n});\n`;
export const ORDERS_TEST_AFTER = `${ORDERS_TEST_HEAD}${ORDERS_TEST_NEW}\n});\n`;

export const DOCS_HEAD = `# Orders API

## Endpoints

### \`GET /v1/orders\`

Retrieve a page of orders.
`;

export const DOCS_PAGINATION_OLD = `### Pagination

Pass \`page\` (1-indexed) and \`limit\` (default 50).
`;

export const DOCS_PAGINATION_NEW = `### Pagination

Requests accept \`limit\` (1..200, default 50) and an opaque \`nextCursor\` token.
Legacy \`page\` queries return the first page.
`;

export const DOCS_BEFORE = `${DOCS_HEAD}\n${DOCS_PAGINATION_OLD}`;
export const DOCS_AFTER = `${DOCS_HEAD}\n${DOCS_PAGINATION_NEW}`;

export const TOKENS_LIGHT = `:root {
  --surface: #ffffff;
  --text: #111827;
  --text-muted: #6b7280;
}`;

export const TOKENS_DARK_OLD = `[data-theme="dark"] {
  --surface: #111827;
  --text: #f9fafb;
  --text-muted: #6b7280;
}`;

export const TOKENS_DARK_NEW = `[data-theme="dark"] {
  --surface: #111827;
  --text: #f9fafb;
  --text-muted: #9ca3af;
}`;

export const TOKENS_BEFORE = `${TOKENS_LIGHT}\n\n${TOKENS_DARK_OLD}\n`;
export const TOKENS_AFTER = `${TOKENS_LIGHT}\n\n${TOKENS_DARK_NEW}\n`;

export const RevenueChart = `export const RevenueChart = () => <div>Revenue</div>;`;

export const DASHBOARD_OLD = `import { RevenueChart } from "@/charts";`;
export const DASHBOARD_NEW = `// Defer charting bundle load until visual mount
import React from "react";
const RevenueChart = React.lazy(() => import("@/charts").then((m) => ({ default: m.RevenueChart })));`;

export const DASHBOARD_BODY = `export function Dashboard() {
  return (
    <div className="dashboard">
      <h1>Store Metrics</h1>
      <React.Suspense fallback={<div className="skeleton" />}>
        <RevenueChart />
      </React.Suspense>
    </div>
  );
}`;

export const DASHBOARD_BEFORE = `${DASHBOARD_OLD}\n\n${DASHBOARD_BODY}\n`;
export const DASHBOARD_AFTER = `${DASHBOARD_NEW}\n\n${DASHBOARD_BODY}\n`;

const PKG_CMD = "package cmd\n\n";

export const STATUS_GO_BEFORE = `${PKG_CMD}import "flag"; import "fmt"; import "io"; import "orbit/internal/workspace"

// Prints repository checkout statuses across tracked paths
func Status(cliArgs []string, writer io.Writer) error {
	cmdFlags := flag.NewFlagSet("status", flag.ContinueOnError)
	if parseErr := cmdFlags.Parse(cliArgs); parseErr != nil { return parseErr }
	repoList, loadErr := workspace.Load()
	if loadErr != nil { return loadErr }
	for _, repoItem := range repoList {
		fmt.Fprintf(writer, "%-24s %-20s %d ahead, %d behind\\n", repoItem.Name, repoItem.Branch, repoItem.Ahead, repoItem.Behind)
	}
	return nil
}
`;

export const STATUS_GO_AFTER = `${PKG_CMD}import "encoding/json"; import "flag"; import "fmt"; import "io"; import "orbit/internal/workspace"

// Prints repository checkout statuses across tracked paths
func Status(cliArgs []string, writer io.Writer) error {
	cmdFlags := flag.NewFlagSet("status", flag.ContinueOnError)
	asJSON := cmdFlags.Bool("json", false, "Emit machine-readable JSON array")
	if parseErr := cmdFlags.Parse(cliArgs); parseErr != nil { return parseErr }
	repoList, loadErr := workspace.Load()
	if loadErr != nil { return loadErr }
	if *asJSON {
		encoder := json.NewEncoder(writer)
		encoder.SetIndent("", "  ")
		return encoder.Encode(repoList)
	}
	for _, repoItem := range repoList {
		fmt.Fprintf(writer, "%-24s %-20s %d ahead, %d behind\\n", repoItem.Name, repoItem.Branch, repoItem.Ahead, repoItem.Behind)
	}
	return nil
}
`;

export const REPO_STRUCT_OLD = `type Repo struct { Name string; Branch string; Ahead int; Behind int }`;
export const REPO_STRUCT_NEW = `type Repo struct { Name string \`json:"name"\`; Branch string \`json:"branch"\`; Ahead int \`json:"ahead"\`; Behind int \`json:"behind"\` }`;

const REPO_GO_HEAD = `package workspace

// Models workspace repository tracking state
`;

export const REPO_GO_BEFORE = `${REPO_GO_HEAD}${REPO_STRUCT_OLD}\n`;
export const REPO_GO_AFTER = `${REPO_GO_HEAD}${REPO_STRUCT_NEW}\n`;

export const WALKER_GO = `package sync

import "context"; import "io/fs"; import "path/filepath"; import "sync"

// Traverses workspace directory trees concurrently
type Walker struct {
	concurrencyLimit int
	errChan          chan error
}

func NewWalker(limit int) *Walker {
	return &Walker{ concurrencyLimit: limit, errChan: make(chan error, 64) }
}

func (w *Walker) Walk(ctx context.Context, directoryRoot string, visitor func(path string, entry fs.DirEntry) error) error {
	var group sync.WaitGroup
	tokens := make(chan struct{}, w.concurrencyLimit)

	walkErr := filepath.WalkDir(directoryRoot, func(entryPath string, dirEntry fs.DirEntry, ioErr error) error {
		if ioErr != nil { return ioErr }
		select {
		case <-ctx.Done(): return ctx.Err()
		case tokens <- struct{}{}:
			group.Add(1)
			go func() {
				defer func() { <-tokens; group.Done() }()
				if err := visitor(entryPath, dirEntry); err != nil {
					select { case w.errChan <- err: default: }
				}
			}()
		}
		return nil
	})

	group.Wait()
	close(w.errChan)
	if walkErr != nil { return walkErr }
	if initialError := <-w.errChan; initialError != nil { return initialError }
	return nil
}
`;

export const APP_LOGIN_OLD = `app.post("/v1/login", handleLogin);`;

export const APP_LOGIN_NEW = `app.post("/v1/login", loginLimiter, handleLogin);`;

export const loginLimit = `const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded", detail: "Too many login attempts. Please retry later." }
});`;

const APP_HEAD = `import express from "express";
import rateLimit from "express-rate-limit";
import { handleLogin } from "./routes/auth.js";
import { listOrders } from "./routes/orders.js";

export const app = express();
app.use(express.json());

${loginLimit}

app.get("/v1/orders", listOrders);
`;

export const app = `export const app = express();`;

export const APP_TS = `${APP_HEAD}${APP_LOGIN_OLD}\n`;
export const APP_TS_AFTER = `${APP_HEAD}${APP_LOGIN_NEW}\n`;
