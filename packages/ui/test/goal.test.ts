import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import { describeTool, toolKind } from "../src/model/format.js";
import { goalPrompt, goalView, parseGoalRecord, statusLabel } from "../src/model/goal.js";
import type { MspItem, ViewEvent } from "../src/types.js";

const BASELINE_TIME_MS = Date.parse("2026-10-20T14:00:00.000Z");
const toIsoString = (timestampMs: number): string => new Date(timestampMs).toISOString();

function createGoalRecordPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: {
      goal_id: "goal_auth_01",
      percent_complete: 0,
      objective: "Refactor authentication provider",
      status: "active",
      created_at_ms: BASELINE_TIME_MS,
      current_work: null,
      updated_at_ms: BASELINE_TIME_MS,
      next_work: null,
      tokens_used: 0,
      last_progress_at_ms: null,
      token_budget: 500_000,
      ...overrides,
    },
  });
}

function createToolCompletionEvent(
  itemId: string,
  turnId: string,
  toolName: string,
  visibleOutput: string,
  timestampMs: number,
): ViewEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        itemId,
        kind: "toolCall",
        status: "completed",
        revision: 1,
        turnId,
        tool: toolName,
        args: "{}",
        visibleOutput,
        recordedAt: toIsoString(timestampMs),
      },
    },
  };
}

function createPromptEvent(itemId: string, turnId: string, timestampMs: number): ViewEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        itemId,
        kind: "userMessage",
        status: "completed",
        revision: 1,
        turnId,
        text: "proceed",
        recordedAt: toIsoString(timestampMs),
      },
    },
  };
}

function createTokenUsageEvent(
  turnId: string,
  cursor: string,
  promptTokens: number,
  outputTokens: number,
): ViewEvent {
  return {
    method: "session/tokenUsage",
    params: {
      turnId,
      viewCursor: cursor,
      promptTokens,
      usage: { inputTokens: promptTokens, outputTokens },
    },
  };
}

function createGoalChangedEvent(goalData: Record<string, unknown> | null): ViewEvent {
  return {
    method: "session/goalChanged",
    params: { goal: goalData },
  };
}

const PRIOR_SESSION_EVENTS = [
  createPromptEvent("prompt_init", "turn_pre", BASELINE_TIME_MS - 60_000),
  createTokenUsageEvent("turn_pre", "cur_pre", 1000, 100),
];

const INITIAL_GOAL_EVENTS = [
  createPromptEvent("prompt_g1", "turn_set", BASELINE_TIME_MS - 2_000),
  createToolCompletionEvent(
    "tool_init_goal",
    "turn_set",
    "create_goal",
    createGoalRecordPayload(),
    BASELINE_TIME_MS + 100,
  ),
  createTokenUsageEvent("turn_set", "cur_set", 5000, 200),
  createGoalChangedEvent({
    objective: "Refactor authentication provider",
    status: "active",
    percentComplete: 0,
  }),
];

const PROGRESS_WORK_EVENTS = [
  createPromptEvent("prompt_work", "turn_work", BASELINE_TIME_MS + 60_000),
  createTokenUsageEvent("turn_work", "cur_work", 7000, 300),
  createGoalChangedEvent({
    objective: "Refactor authentication provider",
    status: "active",
    percentComplete: 40,
    currentWork: "Writing auth adapter tests",
    nextWork: "Migrate token verification",
  }),
];

describe("Goal state management and progress calculation", () => {
  it("parses structured goal records from tool execution output", () => {
    const validOutput = createGoalRecordPayload({
      tokens_used: 1234,
      last_progress_at_ms: BASELINE_TIME_MS + 5,
    });
    const parsed = parseGoalRecord(validOutput);

    assert.equal(parsed?.goalId, "goal_auth_01");
    assert.equal(parsed?.createdAt, BASELINE_TIME_MS);
    assert.equal(parsed?.tokensUsed, 1234);
    assert.equal(parsed?.tokenBudget, 500_000);
    assert.equal(parsed?.lastProgressAt, BASELINE_TIME_MS + 5);

    assert.equal(parseGoalRecord('{"goal":{"objective":"incomplete'), null);
    assert.equal(parseGoalRecord(JSON.stringify({ goal: { status: "active" } })), null);
    assert.equal(parseGoalRecord(undefined), null);
  });

  it("tracks active goal metrics, isolating elapsed turns and token spend from prior session history", () => {
    const combinedEvents = [...PRIOR_SESSION_EVENTS, ...INITIAL_GOAL_EVENTS, ...PROGRESS_WORK_EVENTS];
    const view = goalView(applyEvents(emptyFold(), combinedEvents));

    assert.ok(view);
    assert.equal(view.objective, "Refactor authentication provider");
    assert.equal(view.label, "In progress");
    assert.equal(view.tone, "active");
    assert.equal(view.percent, 40);
    assert.equal(view.currentWork, "Writing auth adapter tests");
    assert.equal(view.nextWork, "Migrate token verification");
    assert.equal(view.startedAt, BASELINE_TIME_MS);
    assert.equal(view.endedAt, null);
    assert.equal(view.turns, 2);
    assert.equal(view.tokens, 5000 + 200 + 7000 + 300);
    assert.equal(view.tokenBudget, 500_000);
  });

  it("freezes metrics and timestamps upon goal completion", () => {
    const finalizationEvents = [
      createToolCompletionEvent(
        "tool_finish_goal",
        "turn_work",
        "update_goal",
        createGoalRecordPayload({
          status: "complete",
          percent_complete: 100,
          updated_at_ms: BASELINE_TIME_MS + 90_000,
          tokens_used: 12_500,
        }),
        BASELINE_TIME_MS + 90_000,
      ),
      createGoalChangedEvent({
        objective: "Refactor authentication provider",
        status: "complete",
        percentComplete: 100,
      }),
      createPromptEvent("prompt_post", "turn_post", BASELINE_TIME_MS + 200_000),
      createTokenUsageEvent("turn_post", "cur_post", 9000, 900),
    ];

    const allEvents = [
      ...PRIOR_SESSION_EVENTS,
      ...INITIAL_GOAL_EVENTS,
      ...PROGRESS_WORK_EVENTS,
      ...finalizationEvents,
    ];
    const view = goalView(applyEvents(emptyFold(), allEvents));

    assert.strictEqual(view?.percent, 100);
    assert.strictEqual(view?.label, "Done");
    assert.strictEqual(view?.endedAt, BASELINE_TIME_MS + 90_000);
    assert.strictEqual(view?.tone, "done");
    assert.equal(view?.endedAt, BASELINE_TIME_MS + 90_000);
    assert.equal(view?.turns, 2);
    assert.equal(view?.tokensUsed, 12_500);
  });

  it("clears active goal representation upon explicit nullification", () => {
    assert.equal(
      goalView(applyEvents(emptyFold(), [...INITIAL_GOAL_EVENTS, createGoalChangedEvent(null)])),
      null,
    );

    const recordOnlyView = goalView(
      applyEvents(emptyFold(), [
        createPromptEvent("prompt_r1", "turn_r1", BASELINE_TIME_MS),
        createToolCompletionEvent(
          "tool_cr",
          "turn_r1",
          "create_goal",
          createGoalRecordPayload(),
          BASELINE_TIME_MS + 100,
        ),
      ]),
    );

    assert.equal(recordOnlyView?.objective, "Refactor authentication provider");
    assert.equal(recordOnlyView?.turns, 1);
    assert.equal(goalView(emptyFold()), null);
  });

  it("pauses elapsed duration during goal suspension and resumes accurately", () => {
    const pausedFold = applyEvents(emptyFold(), [
      ...INITIAL_GOAL_EVENTS,
      {
        method: "session/goalChanged",
        params: {
          goal: {
            objective: "Refactor authentication provider",
            status: "paused",
            percentComplete: 20,
          },
        },
        at: BASELINE_TIME_MS + 30_000,
      },
    ]);

    const pausedView = goalView(pausedFold);
    assert.equal(pausedView?.label, "Paused");
    assert.equal(pausedView?.endedAt, BASELINE_TIME_MS + 30_000);

    const resumedFold = applyEvents(pausedFold, [
      {
        method: "session/goalChanged",
        params: {
          goal: {
            objective: "Refactor authentication provider",
            status: "active",
            percentComplete: 20,
          },
        },
        at: BASELINE_TIME_MS + 60_000,
      },
    ]);

    const resumedView = goalView(resumedFold);
    assert.equal(resumedView?.label, "In progress");
    assert.equal(resumedView?.endedAt, null);
  });

  it("excludes paused periods and interstitial user prompts from goal accounting", () => {
    const eventSequence: ViewEvent[] = [
      ...INITIAL_GOAL_EVENTS,
      {
        method: "session/goalChanged",
        params: {
          goal: {
            objective: "Refactor authentication provider",
            status: "paused",
            percentComplete: 20,
          },
        },
        at: BASELINE_TIME_MS + 30_000,
      },
      createPromptEvent("p_pause_interstitial", "t_pause", BASELINE_TIME_MS + 50_000),
      createTokenUsageEvent("t_pause", "c_pause", 8000, 800),
      {
        method: "session/goalChanged",
        params: {
          goal: {
            objective: "Refactor authentication provider",
            status: "active",
            percentComplete: 20,
          },
        },
        at: BASELINE_TIME_MS + 90_000,
      },
      createPromptEvent("p_resume", "t_resume", BASELINE_TIME_MS + 95_000),
      createTokenUsageEvent("t_resume", "c_resume", 6000, 600),
      {
        method: "session/goalChanged",
        params: {
          goal: {
            objective: "Refactor authentication provider",
            status: "complete",
            percentComplete: 100,
          },
        },
        at: BASELINE_TIME_MS + 120_000,
      },
    ];

    const view = goalView(applyEvents(emptyFold(), eventSequence));
    assert.equal(view?.pausedMs, 60_000);
    assert.equal(view?.endedAt, BASELINE_TIME_MS + 120_000);
    assert.equal(view?.turns, 2);
    assert.equal(view?.tokens, 5000 + 200 + 6000 + 600);
  });

  it("safely ignores malformed goal events lacking valid objectives or standard types", () => {
    const baseFold = applyEvents(emptyFold(), INITIAL_GOAL_EVENTS);
    assert.equal(
      applyEvents(baseFold, [createGoalChangedEvent({ status: "paused" })]).meta.goal?.status,
      "active",
    );

    const unusualDataFold = goalView(
      applyEvents(baseFold, [
        createGoalChangedEvent({
          objective: "Refactor authentication provider",
          status: 7,
          percentComplete: "50",
          currentWork: 3,
        }),
      ]),
    );

    assert.equal(unusualDataFold?.label, "In progress");
    assert.equal(unusualDataFold?.percent, 0);
    assert.equal(unusualDataFold?.currentWork, null);
  });

  it("resolves display status tags and formats model prompt instructions", () => {
    assert.deepEqual(statusLabel("waiting_on_ci"), { label: "Waiting on ci", tone: "paused" });
    assert.deepEqual(statusLabel("budget_limited"), { label: "Out of budget", tone: "attention" });
    assert.deepEqual(statusLabel("superseded"), { label: "Replaced", tone: "ended" });
    assert.match(
      goalPrompt("  Deploy canary cluster "),
      /create_goal tool\. Objective: Deploy canary cluster\n/,
    );
  });

  it("correctly characterizes goal management tools as operational steps rather than file writes", () => {
    const buildCallItem = (
      tool: string,
      args: Record<string, unknown>,
      status = "completed",
    ): MspItem =>
      ({
        itemId: "item_goal_call",
        kind: "toolCall",
        status,
        revision: 1,
        tool,
        args: JSON.stringify(args),
      }) as MspItem;

    const formatAction = (item: MspItem): string => {
      const desc = describeTool(item);
      return `${desc.verb} ${desc.subject ?? ""}`.trim();
    };

    assert.equal(toolKind("create_goal", null), "goal");
    assert.equal(formatAction(buildCallItem("create_goal", { objective: "Deploy canary" })), "Set a goal Deploy canary");
    assert.equal(
      formatAction(buildCallItem("report_progress", { percent_complete: 33.4, current_work: "Phase 1" })),
      "Reported progress 33%",
    );
    assert.equal(
      describeTool(buildCallItem("report_progress", { percent_complete: 33, current_work: "Phase 1" })).note,
      "Phase 1",
    );
    assert.equal(formatAction(buildCallItem("update_goal", { status: "complete" })), "Marked the goal done");
    assert.equal(
      formatAction(buildCallItem("update_goal", { status: "blocked" }, "inProgress")),
      "Updating the goal blocked",
    );
    assert.equal(formatAction(buildCallItem("get_goal", {})), "Checked the goal");
  });
});
