/**
 * Ancilla Synthetic Session Test Fixture
 *
 * Synthetic replay event sequences modeling an agent interaction session:
 * - Turn 1: Direct single-word response ('pong')
 * - Turn 2: Shell execution tool call ('ls -la') returning directory listing
 * - Turn 3: User input request with multiple choices ('Which color do you prefer?')
 *
 * Provides:
 * - liveEvents: Full event stream including incremental token deltas (50 events)
 * - historyEvents: Consolidated transcript events for turn re-hydration (34 events)
 * - modelList: Registered AI model specifications and capabilities
 */

import type { ViewEvent } from "../../src/types.js";

const PROBE_SESSION_ID = "01a090c3-7bfd-7783-a745-f0a4449690bc";
const TURN_1_ID = "01a090c3-a4c0-7000-8f46-0d3ccf6404af";
const TURN_2_ID = "01a090c4-3d7c-7000-9be4-7c3b03f35a28";
const TURN_3_ID = "01a090c4-dd69-7000-9595-de62e24b1ead";
const DEFAULT_MODEL = "muse-spark-1.3-contributor";
const WORKSPACE_DIR = "/mnt/d/work/probe";

const ITEM_MSG_USER_1 = "851efcd2-6467-4494-a4a4-54c1e0ab3380";
const ITEM_REM_SKILL_1 = "e796ec3d-9e0e-4542-aa82-84910a27cded";
const ITEM_MSG_AGENT_1 = "dc6bb53d-242e-4cac-8ea8-7264bcb4e3ec";
const ITEM_REM_GOAL_1 = "9306a93c-1efa-44bd-94f5-6b5dfcde9c51";
const ITEM_REM_VERIFY_1 = "1d2f0f3d-5629-4372-98c2-3488c2009ca6";

const ITEM_MSG_USER_2 = "39f04c84-55e5-4684-af22-af2cb69f6a77";
const ITEM_REM_SKILL_2 = "08878048-2b40-49f5-8d4c-5080ac90f8c1";
const ITEM_TOOL_BASH = "01a090c4-627c-73c3-83b3-59f77ae7b746";
const ITEM_REM_SKILL_2B = "02667910-aa11-4c60-8b08-c3a8ee39a9d9";
const ITEM_MSG_AGENT_2 = "c9bbeeb9-82b1-45ce-8aad-196dabf11b2b";
const ITEM_REM_GOAL_2 = "71f3f4ba-06b0-40d8-a8c8-d1bce02a7c1c";
const ITEM_REM_VERIFY_2 = "3eb225c3-550e-4dac-b728-95de5d78c264";

const ITEM_MSG_USER_3 = "d71fc26b-37b6-47b8-aa6a-7152454c2c8a";
const ITEM_REM_SKILL_3 = "8e32f1e0-b1a0-4367-9abc-8a914e427b09";
const ITEM_TOOL_INPUT = "01a090c4-c310-73c1-871b-2b08dd18070f";
const ITEM_MSG_AGENT_3 = "55af1d46-e143-4d80-bf8b-2e6eeb225080";
const ITEM_REM_GOAL_3 = "9483b954-03ff-4c6f-9a80-9a77bd4dd9fd";
const ITEM_REM_VERIFY_3 = "5c77cb75-5252-474b-8ca9-b648d61584a0";

function makeSessionStarted(at: number): ViewEvent {
  return {
    method: "session/started",
    params: {
      session: {
        activeTurnId: null,
        approvalMode: {
          lastCommandId: null,
          mode: "onRequest",
          source: "startup",
        },
        createdAt: "2026-09-11T13:58:45.506824Z",
        forkedFrom: null,
        modelId: DEFAULT_MODEL,
        path: `/home/dev/.local/share/muse/sessions/2026/09/11/${PROBE_SESSION_ID}/session.jsonl`,
        providerId: "meta",
        sessionId: PROBE_SESSION_ID,
        status: "idle",
        turnCount: 0,
        updatedAt: "2026-09-11T13:58:45.506828Z",
        workspaceRoot: WORKSPACE_DIR,
      },
    },
    at,
  };
}

function makeApprovalModeChanged(cursor: string, at?: number): ViewEvent {
  return {
    method: "session/approvalModeChanged",
    params: {
      clientName: "ancilla_probe",
      commandId: "01a090c3-a411-7000-af99-8973e9766bf4",
      mode: "onRequest",
      sessionId: PROBE_SESSION_ID,
      source: "approvalReconfigure",
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeTurnStarted(turnId: string, cursor: string, at?: number): ViewEvent {
  return {
    method: "turn/started",
    params: {
      commandId: turnId,
      sessionId: PROBE_SESSION_ID,
      turnId,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeUserMessage(turnId: string, itemId: string, text: string, cursor: string, at?: number): ViewEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        commandId: turnId,
        itemId,
        kind: "userMessage",
        recordedAt: "2026-09-11T13:58:45.722817Z",
        revision: 1,
        status: "completed",
        text,
        turnId,
      },
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeReminderChild(turnId: string, itemId: string, reminderAgentId: string, cursor: string, generationId = 1, at?: number): ViewEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        childSessionId: `child-${itemId}`,
        fallbackText: "Reminder child session",
        generationId,
        itemId,
        kind: "reminderChild",
        recordedAt: "2026-09-11T13:58:45.769117Z",
        reminderAgentId,
        revision: 1,
        status: "completed",
        taskId: `task-${itemId}`,
        turnId,
      },
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeAgentMessageStarted(turnId: string, itemId: string, cursor: string, at: number): ViewEvent {
  return {
    method: "item/started",
    params: {
      item: {
        itemId,
        kind: "agentMessage",
        revision: 1,
        status: "inProgress",
        text: "",
        turnId,
      },
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    at,
  };
}

function makeItemDelta(itemId: string, field: "text" | "output", delta: string, cursor: string, at: number): ViewEvent {
  return {
    method: "item/delta",
    params: {
      delta,
      field,
      itemId,
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    at,
  };
}

function makeAgentMessageCompleted(turnId: string, itemId: string, text: string, revision: number, cursor: string, at?: number): ViewEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        itemId,
        kind: "agentMessage",
        recordedAt: "2026-09-11T13:58:49.404592Z",
        revision,
        status: "completed",
        text,
        turnId,
      },
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

interface TokenMetrics {
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly finishReason?: string;
}

interface CumulativeTokens {
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

function makeTokenUsage(
  turnId: string,
  metrics: TokenMetrics,
  cumulative: CumulativeTokens,
  cursor: string,
  at?: number,
): ViewEvent {
  return {
    method: "session/tokenUsage",
    params: {
      cumulative: {
        outputTokens: cumulative.outputTokens,
        promptTokens: cumulative.promptTokens,
        totalTokens: cumulative.totalTokens,
      },
      durationMs: metrics.durationMs,
      ...(metrics.finishReason ? { finishReason: metrics.finishReason } : {}),
      modelId: DEFAULT_MODEL,
      promptTokens: metrics.promptTokens,
      sessionId: PROBE_SESSION_ID,
      totalTokens: metrics.totalTokens,
      turnId,
      usage: {
        cacheReadTokens: metrics.cacheReadTokens ?? 0,
        cacheWriteTokens: 0,
        cachedTokens: metrics.cacheReadTokens ?? 0,
        inputTokens: metrics.promptTokens,
        outputTokens: metrics.outputTokens,
        reasoningTokens: metrics.reasoningTokens ?? 0,
      },
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeContextUsage(usedTokens: number, cursor: string, at: number): ViewEvent {
  return {
    method: "session/contextUsage",
    params: {
      pressure: "normal",
      sessionId: PROBE_SESSION_ID,
      usedTokens,
      viewCursor: cursor,
      windowTokens: 1007997,
    },
    at,
  };
}

function makeTurnCompleted(turnId: string, durationMs: number, timeToFirstTokenMs: number, cursor: string, at?: number): ViewEvent {
  return {
    method: "turn/completed",
    params: {
      durationMs,
      sessionId: PROBE_SESSION_ID,
      terminal: "completed",
      timeToFirstTokenMs,
      turnId,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeToolCallStarted(turnId: string, itemId: string, tool: string, args: string, cursor: string, at?: number): ViewEvent {
  return {
    method: "item/started",
    params: {
      item: {
        args,
        callId: `call_${itemId}`,
        itemId,
        kind: "toolCall",
        recordedAt: "2026-09-11T13:59:44.52346Z",
        revision: 1,
        status: "inProgress",
        tool,
        turnId,
      },
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeToolCallCompleted(turnId: string, itemId: string, tool: string, args: string, visibleOutput: string, cursor: string, at?: number): ViewEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        args,
        callId: `call_${itemId}`,
        itemId,
        kind: "toolCall",
        recordedAt: "2026-09-11T13:59:44.749416Z",
        revision: 2,
        status: "completed",
        tool,
        turnId,
        visibleOutput,
      },
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeUserInputRequested(turnId: string, itemId: string, cursor: string, at?: number): ViewEvent {
  return {
    method: "userInput/requested",
    params: {
      itemId,
      questions: [
        {
          header: "Color",
          id: "color_pref",
          options: [{ label: "Red" }, { label: "Blue" }],
          question: "Which color do you prefer?",
          selection: { mode: "single" },
        },
      ],
      sessionId: PROBE_SESSION_ID,
      toolCallId: `call_${itemId}`,
      toolName: "request_user_input",
      turnId,
      userInputId: itemId,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeUserInputSettled(itemId: string, selectedLabel: string, cursor: string, at?: number): ViewEvent {
  return {
    method: "userInput/settled",
    params: {
      answers: [{ questionId: "color_pref", selectedLabel }],
      clarification: null,
      decidedByCommandId: "01a090c4-eba1-7000-ac35-589ed041c07b",
      outcome: "answered",
      reason: null,
      sessionId: PROBE_SESSION_ID,
      userInputId: itemId,
      viewCursor: cursor,
    },
    ...(at !== undefined ? { at } : {}),
  };
}

function makeSessionClosed(cursor: string, at: number): ViewEvent {
  return {
    method: "session/closed",
    params: {
      reason: "hostShutdown",
      sessionId: PROBE_SESSION_ID,
      viewCursor: cursor,
    },
    at,
  };
}

const BASH_ARGS = JSON.stringify({ command: "ls -la", description: "List workspace directory contents" });
const BASH_OUTPUT = "total 0\ndrwxrwxrwx 1 dev dev 4096 Sep 11 06:58 .\ndrwxrwxrwx 1 dev dev 4096 Sep 11 06:58 ..\n-rwxrwxrwx 1 dev dev   27 Sep 11 06:58 README.md\n-rwxrwxrwx 1 dev dev   22 Sep 11 06:58 index.js\n";
const INPUT_ARGS = JSON.stringify({ questions: [{ header: "Color", id: "color_pref", options: [{ label: "Red" }, { label: "Blue" }], question: "Which color do you prefer?", selection: { mode: "single" } }] });
const INPUT_OUTPUT = JSON.stringify({ status: "answered", answers: [{ id: "color_pref", selected_label: "Blue" }] });

export const liveEvents: ViewEvent[] = [
  makeSessionStarted(1789135125688),
  makeApprovalModeChanged(`v:${PROBE_SESSION_ID}:1`, 1789135125688),

  // --- Turn 1: Pong Response ---
  makeTurnStarted(TURN_1_ID, `v:${PROBE_SESSION_ID}:2`, 1789135125725),
  makeUserMessage(TURN_1_ID, ITEM_MSG_USER_1, "Reply with exactly one word: pong", `v:${PROBE_SESSION_ID}:3`, 1789135125725),
  makeReminderChild(TURN_1_ID, ITEM_REM_SKILL_1, "skill-reminder", `v:${PROBE_SESSION_ID}:4`, 1, 1789135125773),
  makeAgentMessageStarted(TURN_1_ID, ITEM_MSG_AGENT_1, `v:${PROBE_SESSION_ID}:5`, 1789135129404),
  makeItemDelta(ITEM_MSG_AGENT_1, "text", "pong", `v:${PROBE_SESSION_ID}:6`, 1789135129404),
  makeAgentMessageCompleted(TURN_1_ID, ITEM_MSG_AGENT_1, "pong", 2, `v:${PROBE_SESSION_ID}:7`, 1789135129408),
  makeTokenUsage(
    TURN_1_ID,
    { durationMs: 4179, promptTokens: 21158, outputTokens: 19, totalTokens: 21177, reasoningTokens: 8 },
    { promptTokens: 21158, outputTokens: 19, totalTokens: 21177 },
    `v:${PROBE_SESSION_ID}:8`,
    1789135129583,
  ),
  makeContextUsage(21177, `v:${PROBE_SESSION_ID}:9`, 1789135129583),
  makeReminderChild(TURN_1_ID, ITEM_REM_GOAL_1, "goal-reminder", `v:${PROBE_SESSION_ID}:10`, 1, 1789135129608),
  makeReminderChild(TURN_1_ID, ITEM_REM_VERIFY_1, "verify-reminder", `v:${PROBE_SESSION_ID}:11`, 1, 1789135129633),
  makeTurnCompleted(TURN_1_ID, 42316, 4096, `v:${PROBE_SESSION_ID}:12`, 1789135164705),

  // --- Turn 2: Shell Tool Call ---
  makeTurnStarted(TURN_2_ID, `v:${PROBE_SESSION_ID}:13`, 1789135164746),
  makeUserMessage(TURN_2_ID, ITEM_MSG_USER_2, "Run the shell command `ls -la` in the workspace, then tell me how many entries it printed.", `v:${PROBE_SESSION_ID}:14`, 1789135164746),
  makeReminderChild(TURN_2_ID, ITEM_REM_SKILL_2, "skill-reminder", `v:${PROBE_SESSION_ID}:15`, 1, 1789135164802),
  makeTokenUsage(
    TURN_2_ID,
    { durationMs: 21317, promptTokens: 21205, outputTokens: 182, totalTokens: 21387, reasoningTokens: 92, finishReason: "tool_calls" },
    { promptTokens: 42363, outputTokens: 201, totalTokens: 42564 },
    `v:${PROBE_SESSION_ID}:16`,
    1789135184497,
  ),
  makeContextUsage(21387, `v:${PROBE_SESSION_ID}:17`, 1789135184497),
  makeToolCallStarted(TURN_2_ID, ITEM_TOOL_BASH, "bash", BASH_ARGS, `v:${PROBE_SESSION_ID}:18`, 1789135184526),
  makeItemDelta(ITEM_TOOL_BASH, "output", BASH_OUTPUT, `v:${PROBE_SESSION_ID}:19`, 1789135184731),
  makeToolCallCompleted(TURN_2_ID, ITEM_TOOL_BASH, "bash", BASH_ARGS, BASH_OUTPUT, `v:${PROBE_SESSION_ID}:20`, 1789135184751),
  makeReminderChild(TURN_2_ID, ITEM_REM_SKILL_2B, "skill-reminder", `v:${PROBE_SESSION_ID}:21`, 2, 1789135184798),
  makeAgentMessageStarted(TURN_2_ID, ITEM_MSG_AGENT_2, `v:${PROBE_SESSION_ID}:22`, 1789135190610),
  makeItemDelta(ITEM_MSG_AGENT_2, "text", "`", `v:${PROBE_SESSION_ID}:23`, 1789135190610),
  makeItemDelta(ITEM_MSG_AGENT_2, "text", "ls -la` printed 4 entries: `.`, `..", `v:${PROBE_SESSION_ID}:24`, 1789135190632),
  makeItemDelta(ITEM_MSG_AGENT_2, "text", "`, `README.md`, `index.js`.", `v:${PROBE_SESSION_ID}:25`, 1789135190666),
  makeAgentMessageCompleted(TURN_2_ID, ITEM_MSG_AGENT_2, "`ls -la` printed 4 entries: `.`, `..`, `README.md`, `index.js`.", 2, `v:${PROBE_SESSION_ID}:26`, 1789135190668),
  makeTokenUsage(
    TURN_2_ID,
    { durationMs: 6302, promptTokens: 21573, outputTokens: 226, totalTokens: 21799, reasoningTokens: 193 },
    { promptTokens: 63936, outputTokens: 427, totalTokens: 64363 },
    `v:${PROBE_SESSION_ID}:27`,
    1789135190726,
  ),
  makeContextUsage(21799, `v:${PROBE_SESSION_ID}:28`, 1789135190726),
  makeReminderChild(TURN_2_ID, ITEM_REM_GOAL_2, "goal-reminder", `v:${PROBE_SESSION_ID}:29`, 1, 1789135190770),
  makeReminderChild(TURN_2_ID, ITEM_REM_VERIFY_2, "verify-reminder", `v:${PROBE_SESSION_ID}:30`, 1, 1789135190793),
  makeTurnCompleted(TURN_2_ID, 44309, 27948, `v:${PROBE_SESSION_ID}:31`, 1789135205720),

  // --- Turn 3: User Input Request ---
  makeTurnStarted(TURN_3_ID, `v:${PROBE_SESSION_ID}:32`, 1789135205765),
  makeUserMessage(TURN_3_ID, ITEM_MSG_USER_3, "Use your ask-the-user question tool to ask me one multiple-choice question: which color do I prefer, red or blue. After I answer, reply with only my choice.", `v:${PROBE_SESSION_ID}:33`, 1789135205765),
  makeReminderChild(TURN_3_ID, ITEM_REM_SKILL_3, "skill-reminder", `v:${PROBE_SESSION_ID}:34`, 1, 1789135205812),
  makeTokenUsage(
    TURN_3_ID,
    { durationMs: 3745, promptTokens: 21840, outputTokens: 229, totalTokens: 22069, reasoningTokens: 114, finishReason: "tool_calls" },
    { promptTokens: 85776, outputTokens: 656, totalTokens: 86432 },
    `v:${PROBE_SESSION_ID}:35`,
    1789135209190,
  ),
  makeContextUsage(22069, `v:${PROBE_SESSION_ID}:36`, 1789135209190),
  makeToolCallStarted(TURN_3_ID, ITEM_TOOL_INPUT, "request_user_input", INPUT_ARGS, `v:${PROBE_SESSION_ID}:37`, 1789135209245),
  makeUserInputRequested(TURN_3_ID, ITEM_TOOL_INPUT, `v:${PROBE_SESSION_ID}:38`, 1789135209248),
  makeUserInputSettled(ITEM_TOOL_INPUT, "Blue", `v:${PROBE_SESSION_ID}:39`, 1789135209258),
  makeToolCallCompleted(TURN_3_ID, ITEM_TOOL_INPUT, "request_user_input", INPUT_ARGS, INPUT_OUTPUT, `v:${PROBE_SESSION_ID}:40`, 1789135209263),
  makeAgentMessageStarted(TURN_3_ID, ITEM_MSG_AGENT_3, `v:${PROBE_SESSION_ID}:41`, 1789135212470),
  makeItemDelta(ITEM_MSG_AGENT_3, "text", "Blue", `v:${PROBE_SESSION_ID}:42`, 1789135212470),
  makeAgentMessageCompleted(TURN_3_ID, ITEM_MSG_AGENT_3, "Blue", 2, `v:${PROBE_SESSION_ID}:43`, 1789135212476),
  makeTokenUsage(
    TURN_3_ID,
    { durationMs: 3315, promptTokens: 22112, outputTokens: 61, totalTokens: 22173, reasoningTokens: 50, cacheReadTokens: 21745 },
    { promptTokens: 107888, outputTokens: 717, totalTokens: 108605 },
    `v:${PROBE_SESSION_ID}:44`,
    1789135212642,
  ),
  makeContextUsage(22173, `v:${PROBE_SESSION_ID}:45`, 1789135212642),
  makeReminderChild(TURN_3_ID, ITEM_REM_GOAL_3, "goal-reminder", `v:${PROBE_SESSION_ID}:46`, 1, 1789135212669),
  makeReminderChild(TURN_3_ID, ITEM_REM_VERIFY_3, "verify-reminder", `v:${PROBE_SESSION_ID}:47`, 1, 1789135212696),
  makeTurnCompleted(TURN_3_ID, 73471, 7137, `v:${PROBE_SESSION_ID}:48`, 1789135273398),
  makeSessionClosed(`v:${PROBE_SESSION_ID}:48`, 1789135273495),
];

export const historyEvents: ViewEvent[] = [
  makeApprovalModeChanged(`v:${PROBE_SESSION_ID}:1`),

  // --- Replayed Turn 1 ---
  makeTurnStarted(TURN_1_ID, `v:${PROBE_SESSION_ID}:2`),
  makeUserMessage(TURN_1_ID, ITEM_MSG_USER_1, "Reply with exactly one word: pong", `v:${PROBE_SESSION_ID}:3`),
  makeReminderChild(TURN_1_ID, ITEM_REM_SKILL_1, "skill-reminder", `v:${PROBE_SESSION_ID}:4`),
  makeAgentMessageCompleted(TURN_1_ID, ITEM_MSG_AGENT_1, "pong", 1, `v:${PROBE_SESSION_ID}:5`),
  makeTokenUsage(
    TURN_1_ID,
    { durationMs: 4179, promptTokens: 21158, outputTokens: 19, totalTokens: 21177, reasoningTokens: 8 },
    { promptTokens: 21158, outputTokens: 19, totalTokens: 21177 },
    `v:${PROBE_SESSION_ID}:6`,
  ),
  makeReminderChild(TURN_1_ID, ITEM_REM_GOAL_1, "goal-reminder", `v:${PROBE_SESSION_ID}:7`),
  makeReminderChild(TURN_1_ID, ITEM_REM_VERIFY_1, "verify-reminder", `v:${PROBE_SESSION_ID}:8`),
  makeTurnCompleted(TURN_1_ID, 42316, 4096, `v:${PROBE_SESSION_ID}:9`),

  // --- Replayed Turn 2 ---
  makeTurnStarted(TURN_2_ID, `v:${PROBE_SESSION_ID}:10`),
  makeUserMessage(TURN_2_ID, ITEM_MSG_USER_2, "Run the shell command `ls -la` in the workspace, then tell me how many entries it printed.", `v:${PROBE_SESSION_ID}:11`),
  makeReminderChild(TURN_2_ID, ITEM_REM_SKILL_2, "skill-reminder", `v:${PROBE_SESSION_ID}:12`),
  makeTokenUsage(
    TURN_2_ID,
    { durationMs: 21317, promptTokens: 21205, outputTokens: 182, totalTokens: 21387, reasoningTokens: 92, finishReason: "tool_calls" },
    { promptTokens: 42363, outputTokens: 201, totalTokens: 42564 },
    `v:${PROBE_SESSION_ID}:13`,
  ),
  makeToolCallStarted(TURN_2_ID, ITEM_TOOL_BASH, "bash", BASH_ARGS, `v:${PROBE_SESSION_ID}:14`),
  makeToolCallCompleted(TURN_2_ID, ITEM_TOOL_BASH, "bash", BASH_ARGS, BASH_OUTPUT, `v:${PROBE_SESSION_ID}:15`),
  makeReminderChild(TURN_2_ID, ITEM_REM_SKILL_2B, "skill-reminder", `v:${PROBE_SESSION_ID}:16`),
  makeAgentMessageCompleted(TURN_2_ID, ITEM_MSG_AGENT_2, "`ls -la` printed 4 entries: `.`, `..`, `README.md`, `index.js`.", 1, `v:${PROBE_SESSION_ID}:17`),
  makeTokenUsage(
    TURN_2_ID,
    { durationMs: 6302, promptTokens: 21573, outputTokens: 226, totalTokens: 21799, reasoningTokens: 193 },
    { promptTokens: 63936, outputTokens: 427, totalTokens: 64363 },
    `v:${PROBE_SESSION_ID}:18`,
  ),
  makeReminderChild(TURN_2_ID, ITEM_REM_GOAL_2, "goal-reminder", `v:${PROBE_SESSION_ID}:19`),
  makeReminderChild(TURN_2_ID, ITEM_REM_VERIFY_2, "verify-reminder", `v:${PROBE_SESSION_ID}:20`),
  makeTurnCompleted(TURN_2_ID, 44309, 27948, `v:${PROBE_SESSION_ID}:21`),

  // --- Replayed Turn 3 ---
  makeTurnStarted(TURN_3_ID, `v:${PROBE_SESSION_ID}:22`),
  makeUserMessage(TURN_3_ID, ITEM_MSG_USER_3, "Use your ask-the-user question tool to ask me one multiple-choice question: which color do I prefer, red or blue. After I answer, reply with only my choice.", `v:${PROBE_SESSION_ID}:23`),
  makeReminderChild(TURN_3_ID, ITEM_REM_SKILL_3, "skill-reminder", `v:${PROBE_SESSION_ID}:24`),
  makeTokenUsage(
    TURN_3_ID,
    { durationMs: 3745, promptTokens: 21840, outputTokens: 229, totalTokens: 22069, reasoningTokens: 114, finishReason: "tool_calls" },
    { promptTokens: 85776, outputTokens: 656, totalTokens: 86432 },
    `v:${PROBE_SESSION_ID}:25`,
  ),
  makeToolCallStarted(TURN_3_ID, ITEM_TOOL_INPUT, "request_user_input", INPUT_ARGS, `v:${PROBE_SESSION_ID}:26`),
  makeUserInputRequested(TURN_3_ID, ITEM_TOOL_INPUT, `v:${PROBE_SESSION_ID}:27`),
  makeUserInputSettled(ITEM_TOOL_INPUT, "Blue", `v:${PROBE_SESSION_ID}:28`),
  makeToolCallCompleted(TURN_3_ID, ITEM_TOOL_INPUT, "request_user_input", INPUT_ARGS, INPUT_OUTPUT, `v:${PROBE_SESSION_ID}:29`),
  makeAgentMessageCompleted(TURN_3_ID, ITEM_MSG_AGENT_3, "Blue", 1, `v:${PROBE_SESSION_ID}:30`),
  makeTokenUsage(
    TURN_3_ID,
    { durationMs: 3315, promptTokens: 22112, outputTokens: 61, totalTokens: 22173, reasoningTokens: 50, cacheReadTokens: 21745 },
    { promptTokens: 107888, outputTokens: 717, totalTokens: 108605 },
    `v:${PROBE_SESSION_ID}:31`,
  ),
  makeReminderChild(TURN_3_ID, ITEM_REM_GOAL_3, "goal-reminder", `v:${PROBE_SESSION_ID}:32`),
  makeReminderChild(TURN_3_ID, ITEM_REM_VERIFY_3, "verify-reminder", `v:${PROBE_SESSION_ID}:33`),
  makeTurnCompleted(TURN_3_ID, 73471, 7137, `v:${PROBE_SESSION_ID}:34`),
];

export const modelList: unknown = {
  models: [
    {
      contextLimit: 1007997,
      cost: null,
      description: null,
      displayLabel: "muse-spark-1.3",
      isActive: false,
      isDefault: false,
      modelId: "muse-spark-1.3",
      outputLimit: 128000,
      profileId: "tbh",
      providerId: "meta",
      releaseDate: "2026-09-02",
    },
    {
      contextLimit: 1007997,
      cost: null,
      description: "Your content, including inter-session messages, may be used for product improvement.",
      displayLabel: "muse-spark-1.3-contributor",
      isActive: false,
      isDefault: true,
      modelId: "muse-spark-1.3-contributor",
      outputLimit: 128000,
      profileId: "tbh",
      providerId: "meta",
      releaseDate: "2026-09-02",
    },
    {
      contextLimit: 1007997,
      cost: null,
      description: null,
      displayLabel: "muse-spark-1.2",
      isActive: false,
      isDefault: false,
      modelId: "muse-spark-1.2",
      outputLimit: 128000,
      profileId: "tbh",
      providerId: "meta",
      releaseDate: "2026-08-05",
    },
    {
      contextLimit: 1007997,
      cost: null,
      description: "Your content, including inter-session messages, may be used for product improvement.",
      displayLabel: "muse-spark-1.2-contributor",
      isActive: false,
      isDefault: false,
      modelId: "muse-spark-1.2-contributor",
      outputLimit: 128000,
      profileId: "tbh",
      providerId: "meta",
      releaseDate: "2026-08-05",
    },
  ],
  profileId: "tbh",
  providerId: "meta",
  source: "providerCatalog",
};
