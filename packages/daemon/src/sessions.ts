import {
  MUSE_CAPABILITIES,
  UnsupportedCapabilityError,
  type ProviderCapabilities,
  type ProviderId,
} from "./providers/types.js";

/** User approval policy for tool invocations and commands. */
export type ApprovalMode =
  | "allowAll"
  | "denyUnmatched"
  | "onRequest"
  | "promptUnmatched";

export const APPROVAL_MODES: readonly ApprovalMode[] = [
  "allowAll",
  "denyUnmatched",
  "onRequest",
  "promptUnmatched",
];

export function isApprovalMode(val: unknown): val is ApprovalMode {
  return (
    typeof val === "string" &&
    (APPROVAL_MODES as readonly string[]).includes(val)
  );
}

/** Reasoning effort level requested from the model. */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function isReasoningEffort(val: unknown): val is ReasoningEffort {
  return (
    typeof val === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(val)
  );
}

/** Behavior when sending a turn while the session is currently executing. */
export type IfBusy = "queue" | "steer" | "replace";

export function isIfBusy(val: unknown): val is IfBusy {
  return val === "queue" || val === "steer" || val === "replace";
}

export interface TextPart {
  type: "text";
  text: string;
}

export function textInput(promptText: string): TextPart[] {
  return [{ type: "text", text: promptText }];
}

export interface MspNotification {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
}

export type NotificationHandler = (notice: MspNotification) => void;

/** Handler for frames refused by the client transport layer before reaching protocol dispatch. */
export type ProtocolErrorHandler = (err: unknown) => void;

/**
 * Underlying RPC channel between the daemon and a Muse provider subprocess.
 */
export interface CommandConnection {
  command(verb: string, params?: Record<string, unknown>): Promise<unknown>;
  request?(verb: string, params?: Record<string, unknown>): Promise<unknown>;
  onNotification(handler: NotificationHandler): void;
  onProtocolError?(handler: ProtocolErrorHandler): void;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === "object" && val !== null ? (val as Record<string, unknown>) : null;
}

function nestedString(source: unknown, pathSegments: string[]): string | null {
  let curr: unknown = source;
  for (const seg of pathSegments) {
    const rec = asRecord(curr);
    if (!rec) return null;
    curr = rec[seg];
  }
  return typeof curr === "string" ? curr : null;
}

function sessionIdOf(payload: unknown): string {
  const extractedId = nestedString(payload, ["session", "sessionId"]);
  if (!extractedId) {
    throw new Error("MSP response carried no session.sessionId.");
  }
  return extractedId;
}

export interface StartSessionOptions {
  workspaceRoot?: string;
  approvalMode?: ApprovalMode;
  modelId?: string;
}

export interface StartedSession {
  sessionId: string;
  raw: unknown;
}

export interface TurnAck {
  turnId: string | null;
  status: unknown;
  disposition: unknown;
  raw: unknown;
}

function toTurnAck(payload: unknown): TurnAck {
  const parsedRec = asRecord(payload);
  const ackResult: TurnAck = {
    turnId: parsedRec ? nestedString(parsedRec, ["turnId"]) : null,
    status: parsedRec ? parsedRec["status"] : undefined,
    disposition: parsedRec ? parsedRec["disposition"] : undefined,
    raw: payload,
  };
  return ackResult;
}

/** Binary image attachment supported by Muse turn inputs. */
export interface TurnImage {
  base64Data: string;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface SendTurnOptions {
  displayText?: string;
  ifBusy?: string;
  reasoningEffort?: string;
  images?: TurnImage[];
}

/**
 * Constructs multipart turn input items from text and image attachments.
 */
export function turnInput(text: string, images: TurnImage[] = []): unknown[] {
  const elements: unknown[] = [];
  if (text.length > 0) {
    elements.push({ type: "text", text });
  }
  for (const img of images) {
    const imgObj: Record<string, unknown> = {
      type: "image",
      base64Data: img.base64Data,
      mediaType: img.mediaType,
    };
    if (img.width !== undefined && img.height !== undefined) {
      imgObj["width"] = img.width;
      imgObj["height"] = img.height;
    }
    elements.push(imgObj);
  }
  return elements;
}

export interface ApprovalDecision {
  sessionId: string;
  approvalId: string;
  requirementId: unknown;
  choiceId: string;
  feedback?: string | null;
}

export interface UserInputAnswerItem {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
}

export interface SessionPage {
  sessions: unknown[];
  nextCursor: string | null;
}

export interface ViewPage {
  events: unknown[];
  nextCursor: string | null;
}

export interface PendingRequests {
  approvals: unknown[];
  userInputs: unknown[];
}

/**
 * Protocol client managing RPC sessions, turns, tool approvals, and subagents.
 */
export class SessionManager {
  readonly providerId: ProviderId;
  readonly capabilities: ProviderCapabilities;

  constructor(
    private readonly connection: CommandConnection,
    options: { providerId?: ProviderId; capabilities?: ProviderCapabilities } = {},
  ) {
    this.providerId = options.providerId ?? "muse";
    this.capabilities = options.capabilities ?? MUSE_CAPABILITIES;
  }

  onNotification(handler: NotificationHandler): void {
    this.connection.onNotification(handler);
  }

  onProtocolError(handler: ProtocolErrorHandler): boolean {
    const errorListener = this.connection.onProtocolError;
    if (!errorListener) {
      return (false);
    }
    errorListener.call(this.connection, handler);
    return (true);
  }

  private query(verb: string, payload: Record<string, unknown>): Promise<unknown> {
    const customReq = this.connection.request;
    if (customReq) {
      return customReq.call(this.connection, verb, payload);
    }
    return this.connection.command(verb, payload);
  }

  async listSessions(workspaceRoot?: string, limit = 50): Promise<unknown[]> {
    const pageResult = await this.listSessionsPage({ workspaceRoot, limit });
    return pageResult.sessions;
  }

  async listSessionsPage(options: {
    workspaceRoot?: string;
    limit?: number;
    cursor?: string | null;
  } = {}): Promise<SessionPage> {
    const pageParams: Record<string, unknown> = {
      limit: options.limit ?? 50,
    };
    if (typeof options.workspaceRoot !== "undefined") {
      pageParams["workspaceRoot"] = options.workspaceRoot;
    }
    if (Boolean(options.cursor)) {
      pageParams["cursor"] = options.cursor;
    }

    const rawResponse = await this.query("session/list", pageParams);
    const pageRec = asRecord(rawResponse);
    if (pageRec && Array.isArray(pageRec["sessions"])) {
      const pageResult: SessionPage = {
        sessions: pageRec["sessions"],
        nextCursor: typeof pageRec["nextCursor"] === "string" ? pageRec["nextCursor"] : null,
      };
      return pageResult;
    }
    if (Array.isArray(rawResponse)) {
      const fallbackResult: SessionPage = { sessions: rawResponse, nextCursor: null };
      return fallbackResult;
    }
    const emptyResult: SessionPage = { sessions: [], nextCursor: null };
    return emptyResult;
  }

  async startSession(options: StartSessionOptions = {}): Promise<StartedSession> {
    const startPayload: Record<string, unknown> = {};
    if (typeof options.workspaceRoot !== "undefined") {
      startPayload["workspaceRoot"] = options.workspaceRoot;
    }
    if (typeof options.approvalMode !== "undefined") {
      startPayload["approvalMode"] = options.approvalMode;
    }
    if (typeof options.modelId !== "undefined") {
      startPayload["modelId"] = options.modelId;
    }

    const startReply = await this.connection.command("session/start", startPayload);
    const started: StartedSession = {
      sessionId: sessionIdOf(startReply),
      raw: startReply,
    };
    return started;
  }

  async resumeSession(sessionId: string, excludeItems = false): Promise<unknown> {
    return this.connection.command("session/resume", {
      sessionId,
      excludeItems,
    });
  }

  async readSession(sessionId: string, excludeItems = true): Promise<unknown> {
    return this.query("session/read", {
      sessionId,
      excludeItems,
    });
  }

  async pageView(
    sessionId: string,
    options: { cursor?: string; direction?: "forward" | "backward"; limit?: number } = {},
  ): Promise<ViewPage> {
    const viewOptions: Record<string, unknown> = {
      sessionId,
      limit: options.limit ?? 200,
    };
    if (Boolean(options.cursor)) {
      viewOptions["cursor"] = options.cursor;
    }
    if (Boolean(options.direction)) {
      viewOptions["direction"] = options.direction;
    }

    const pageRec = asRecord(await this.query("view/page", viewOptions)) ?? {};
    const pageViewResult: ViewPage = {
      events: Array.isArray(pageRec["events"]) ? pageRec["events"] : [],
      nextCursor: typeof pageRec["nextCursor"] === "string" ? pageRec["nextCursor"] : null,
    };
    return pageViewResult;
  }

  async listPending(sessionId: string): Promise<PendingRequests> {
    const responseRec = asRecord(await this.query("approval/listPending", { sessionId })) ?? {};
    const pendingObj: PendingRequests = {
      approvals: Array.isArray(responseRec["approvals"]) ? responseRec["approvals"] : [],
      userInputs: Array.isArray(responseRec["userInputs"]) ? responseRec["userInputs"] : [],
    };
    return pendingObj;
  }

  async sendTurn(
    sessionId: string,
    text: string,
    options: SendTurnOptions = {},
  ): Promise<TurnAck> {
    const turnPayload: Record<string, unknown> = {
      sessionId,
      input: turnInput(text, options.images ?? []),
    };
    if (typeof options.displayText !== "undefined") {
      turnPayload["displayText"] = options.displayText;
    }
    if (typeof options.ifBusy !== "undefined") {
      turnPayload["ifBusy"] = options.ifBusy;
    }
    if (typeof options.reasoningEffort !== "undefined") {
      turnPayload["reasoningEffort"] = options.reasoningEffort;
    }

    const responseAck = await this.connection.command("turn/start", turnPayload);
    return toTurnAck(responseAck);
  }

  async steerTurn(
    sessionId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<unknown> {
    if (!this.capabilities.supportsSteer) {
      throw new UnsupportedCapabilityError(this.providerId, "mid-turn steering");
    }
    const steerPayload = {
      sessionId,
      expectedTurnId,
      input: textInput(text),
    };
    return await this.connection.command("turn/steer", steerPayload);
  }

  async interruptTurn(
    sessionId: string,
    turnId?: string,
    retract = false,
  ): Promise<unknown> {
    const interruptArgs: Record<string, unknown> = {
      sessionId,
      retract,
    };
    if (typeof turnId !== "undefined") {
      interruptArgs["turnId"] = turnId;
    }
    return await this.connection.command("turn/interrupt", interruptArgs);
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<unknown> {
    return await this.connection.command("turn/cancel", {
      sessionId,
      turnId,
    });
  }

  async unqueueTurn(sessionId: string, turnId: string): Promise<unknown> {
    return await this.connection.command("turn/unqueue", {
      sessionId,
      turnId,
    });
  }

  async compactSession(sessionId: string): Promise<unknown> {
    if (!this.capabilities.supportsCompact) {
      throw new UnsupportedCapabilityError(this.providerId, "context compaction");
    }
    return await this.connection.command("session/compact", { sessionId });
  }

  async userShell(sessionId: string, commandText: string): Promise<unknown> {
    return await this.connection.command("session/userShell", {
      sessionId,
      commandText,
    });
  }

  async forkSession(sessionId: string): Promise<StartedSession> {
    if (!this.capabilities.supportsFork) {
      throw new UnsupportedCapabilityError(this.providerId, "session forking");
    }
    const forkRes = await this.connection.command("session/fork", {
      sessionId,
      excludeItems: true,
    });
    return {
      sessionId: sessionIdOf(forkRes),
      raw: forkRes,
    };
  }

  async decideApproval(decision: ApprovalDecision): Promise<unknown> {
    const decisionPayload = {
      sessionId: decision.sessionId,
      approvalId: decision.approvalId,
      requirementId: decision.requirementId,
      choiceId: decision.choiceId,
      feedback: decision.feedback ?? null,
    };
    return await this.connection.command("approval/decide", decisionPayload);
  }

  async listModels(sessionId?: string): Promise<unknown> {
    const modelPayload: Record<string, unknown> = {};
    if (typeof sessionId !== "undefined") {
      modelPayload["sessionId"] = sessionId;
    }
    return await this.query("model/list", modelPayload);
  }

  async setSessionModel(sessionId: string, model: unknown): Promise<unknown> {
    return await this.connection.command("session/setModel", {
      sessionId,
      model,
    });
  }

  async setSessionApprovalMode(
    sessionId: string,
    mode: ApprovalMode,
  ): Promise<unknown> {
    return await this.connection.command("session/setApprovalMode", {
      sessionId,
      mode,
    });
  }

  async answerUserInput(
    sessionId: string,
    userInputId: string,
    answers: UserInputAnswerItem[],
  ): Promise<unknown> {
    const answerPayload = {
      sessionId,
      userInputId,
      answers,
    };
    return await this.connection.command("userInput/answer", answerPayload);
  }

  async cancelUserInput(sessionId: string, userInputId: string, reason?: string): Promise<unknown> {
    const cancelParams: Record<string, unknown> = {
      sessionId,
      userInputId,
    };
    if (Boolean(reason)) {
      cancelParams["reason"] = reason;
    }
    return await this.connection.command("userInput/cancel", cancelParams);
  }

  async clarifyUserInput(
    sessionId: string,
    userInputId: string,
    content: string,
  ): Promise<unknown> {
    const clarificationPayload = {
      sessionId,
      userInputId,
      clarification: {
        format: "text" as const,
        content,
      },
    };
    return await this.connection.command("userInput/clarify", clarificationPayload);
  }

  async setReasoningEffort(sessionId: string, reasoningEffort: ReasoningEffort): Promise<unknown> {
    if (!this.capabilities.supportsReasoningEffort) {
      throw new UnsupportedCapabilityError(this.providerId, "reasoning effort");
    }
    return await this.connection.command("session/setReasoningEffort", {
      sessionId,
      reasoningEffort,
    });
  }

  async renameSession(sessionId: string, name: string): Promise<string | null> {
    const renameRes = await this.connection.command("session/rename", {
      sessionId,
      name,
    });
    return nestedString(renameRes, ["name"]);
  }

  async readSubscriptionUsage(): Promise<SubscriptionUsage | null> {
    const res = asRecord(await this.query("usage/read", {}));
    return parseSubscriptionUsage(res?.["usage"]);
  }

  async goal(
    sessionId: string,
    action: GoalAction,
    objective?: string,
  ): Promise<GoalAck> {
    if (!this.capabilities.supportsGoals) {
      throw new UnsupportedCapabilityError(this.providerId, "autonomous goals");
    }
    const goalPayload: Record<string, unknown> = { sessionId };
    const isMutationAction = action === "set" || action === "edit";
    if (isMutationAction) {
      const sanitizedGoalText = objective?.trim();
      if (!sanitizedGoalText) {
        throw new Error(`goal/${action} requires an objective.`);
      }
      goalPayload["objective"] = sanitizedGoalText;
    }
    const commandResult = asRecord(await this.connection.command(`goal/${action}`, goalPayload));
    return {
      turnId: typeof commandResult?.["turnId"] === "string" ? commandResult["turnId"] : null,
    };
  }

  async subagent(
    sessionId: string,
    action: SubagentAction,
    subagentId: string,
    options: { reason?: string; body?: string } = {},
  ): Promise<unknown> {
    if (!this.capabilities.supportsSubagents) {
      throw new UnsupportedCapabilityError(this.providerId, "subagent controls");
    }
    const dispatchArgs: Record<string, unknown> = {
      sessionId,
      subagentId,
    };
    const isMessageAction = action === "sendMessage" || action === "followupTask";
    if (isMessageAction) {
      const messageBody = options.body?.trim();
      if (!messageBody) {
        throw new Error(`subagent/${action} requires message content.`);
      }
      dispatchArgs["body"] = messageBody;
    } else if (["stop", "interrupt", "close"].includes(action) && options.reason) {
      dispatchArgs["reason"] = options.reason;
    }
    return await this.connection.command(`subagent/${action}`, dispatchArgs);
  }

  async backgroundTask(sessionId: string, taskId: string): Promise<unknown> {
    return await this.connection.command("task/background", {
      sessionId,
      taskId,
    });
  }

  async stopTask(sessionId: string, taskId: string): Promise<unknown> {
    return await this.connection.command("task/stop", {
      sessionId,
      taskId,
    });
  }

  async stopAllTasks(sessionId: string): Promise<unknown> {
    return await this.connection.command("task/stopAll", {
      sessionId,
    });
  }

  async listSessionSkills(sessionId: string): Promise<SessionSkill[]> {
    const reply = asRecord(await this.query("skill/list", { sessionId }));
    const rawList = Array.isArray(reply?.["skills"]) ? reply["skills"] : [];
    const skillsList: SessionSkill[] = [];

    for (const rawEntry of rawList) {
      const item = asRecord(rawEntry);
      const sel = typeof item?.["selector"] === "string" ? item["selector"] : null;
      if (!item || !sel) continue;

      skillsList.push({
        selector: sel,
        displayName: typeof item["displayName"] === "string" && item["displayName"] ? item["displayName"] : sel,
        description: typeof item["description"] === "string" ? item["description"] : "",
        source: typeof item["source"] === "string" ? item["source"] : "unknown",
        argumentHint: typeof item["argumentHint"] === "string" ? item["argumentHint"] : null,
        pluginId: typeof item["pluginId"] === "string" ? item["pluginId"] : null,
      });
    }

    return skillsList;
  }

  async cancelWorkflow(sessionId: string, workflowRunId: string): Promise<unknown> {
    return this.connection.command("workflow/cancel", {
      sessionId,
      workflowRunId,
    });
  }

  async controlWorkflowChild(
    sessionId: string,
    workflowRunId: string,
    childId: string,
    attempt: number,
    action: WorkflowChildAction,
  ): Promise<unknown> {
    return this.connection.command("workflow/childControl", {
      sessionId,
      workflowRunId,
      childId,
      attempt,
      action,
    });
  }

  async readItemOutput(
    sessionId: string,
    itemId: string,
    outputRef: string,
    options: { offsetBytes?: number; lengthBytes?: number } = {},
  ): Promise<ItemOutputRange> {
    const rangeParams: Record<string, unknown> = {
      sessionId,
      itemId,
      outputRef,
    };
    if (typeof options.offsetBytes !== "undefined") {
      rangeParams["offsetBytes"] = options.offsetBytes;
    }
    if (typeof options.lengthBytes !== "undefined") {
      rangeParams["lengthBytes"] = options.lengthBytes;
    }

    const outputRec = asRecord(await this.query("item/readOutput", rangeParams)) ?? {};
    const itemRangeResult: ItemOutputRange = {
      content: typeof outputRec["content"] === "string" ? outputRec["content"] : "",
      encoding: typeof outputRec["encoding"] === "string" ? outputRec["encoding"] : "utf8",
      mediaType: typeof outputRec["mediaType"] === "string" ? outputRec["mediaType"] : "application/octet-stream",
      offsetBytes: typeof outputRec["offsetBytes"] === "number" ? outputRec["offsetBytes"] : 0,
      byteLen: typeof outputRec["byteLen"] === "number" ? outputRec["byteLen"] : 0,
      eof: outputRec["eof"] === true,
    };
    return itemRangeResult;
  }
}

export type GoalAction = "set" | "edit" | "pause" | "resume" | "clear";

export const GOAL_ACTIONS: readonly GoalAction[] = [
  "set",
  "edit",
  "pause",
  "resume",
  "clear",
];

export function isGoalAction(val: unknown): val is GoalAction {
  return (
    typeof val === "string" &&
    (GOAL_ACTIONS as readonly string[]).includes(val)
  );
}

export interface GoalAck {
  turnId: string | null;
}

export type SubagentAction =
  | "interrupt"
  | "stop"
  | "close"
  | "resume"
  | "reopen"
  | "sendMessage"
  | "followupTask"
  | "readResult";

export const SUBAGENT_ACTIONS: readonly SubagentAction[] = [
  "interrupt",
  "stop",
  "close",
  "resume",
  "reopen",
  "sendMessage",
  "followupTask",
  "readResult",
];

export function isSubagentAction(val: unknown): val is SubagentAction {
  return (
    typeof val === "string" &&
    (SUBAGENT_ACTIONS as readonly string[]).includes(val)
  );
}

export type WorkflowChildAction = "skip" | "retry";

export function isWorkflowChildAction(val: unknown): val is WorkflowChildAction {
  return val === "skip" || val === "retry";
}

export interface SessionSkill {
  selector: string;
  displayName: string;
  description: string;
  source: string;
  argumentHint: string | null;
  pluginId: string | null;
}

export interface ItemOutputRange {
  content: string;
  encoding: string;
  mediaType: string;
  offsetBytes: number;
  byteLen: number;
  eof: boolean;
}

export interface UsageWindow {
  usedPercent: number;
  resetsAtMs: number;
  windowDurationMins: number | null;
}

export interface SubscriptionUsage {
  tier: string;
  observedAtMs: number;
  window: UsageWindow;
  weekly: UsageWindow;
}

function parseUsageWindow(source: unknown): UsageWindow | null {
  const winRecord = asRecord(source);
  if (!winRecord) return null as null;

  const usedRatio = winRecord["usedPercent"];
  const resetTimeMs = winRecord["resetsAtMs"];
  const hasValidNumbers =
    typeof usedRatio === "number" &&
    Number.isFinite(usedRatio) &&
    typeof resetTimeMs === "number" &&
    Number.isFinite(resetTimeMs) &&
    Math.abs(resetTimeMs) <= 8_640_000_000_000_000;
  if (!hasValidNumbers) return null as null;

  const durationVal = winRecord["windowDurationMins"];
  const parsedDuration =
    typeof durationVal === "number" && Number.isFinite(durationVal) && durationVal > 0
      ? durationVal
      : null;

  const windowResult: UsageWindow = {
    usedPercent: usedRatio,
    resetsAtMs: resetTimeMs,
    windowDurationMins: parsedDuration,
  };
  return windowResult;
}

export function parseSubscriptionUsage(rawPayload: unknown): SubscriptionUsage | null {
  const payloadRecord = asRecord(rawPayload);
  if (!payloadRecord) return null as null;

  const standardWindow = parseUsageWindow(payloadRecord["window"]);
  const rollingWeeklyWindow = parseUsageWindow(payloadRecord["weekly"]);
  const observedEpoch = payloadRecord["observedAtMs"];

  const isEpochValid =
    typeof observedEpoch === "number" &&
    Number.isFinite(observedEpoch) &&
    Math.abs(observedEpoch) <= 8_640_000_000_000_000;

  if (!standardWindow || !rollingWeeklyWindow || !isEpochValid) {
    return null as null;
  }

  const accountTier = typeof payloadRecord["tier"] === "string" ? payloadRecord["tier"] : "unknown";

  const subscriptionResult: SubscriptionUsage = {
    tier: accountTier,
    observedAtMs: observedEpoch,
    window: standardWindow,
    weekly: rollingWeeklyWindow,
  };
  return subscriptionResult;
}
