// Ancilla Web Demo Timeline Synthesizer
// Generates simulated Meta Muse Protocol (MSP) view event sequences
// for interactive demo scenarios, turn flows, and simulated streaming.
import type { ApprovalMode, MspItem, ViewEvent } from "@ancilla/ui";
// Time unit constants for demo timeline scheduling (in milliseconds)
export const MIN: number = 60_000;
export const HOUR: number = 3_600_000;
export const DAY: number = 86_400_000;
// Default simulated language model identifier
export const MODEL: string = "muse-spark-1.3";
export function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
// 32-bit FNV-1a hash algorithm for deterministic ID generation across demo runs
function computeHash32(text: string, initialSeed: number): string {
  let hashVal = (0x811c9dc5 ^ initialSeed) >>> 0;
  for (let idx = 0; idx < text.length; idx += 1) {
    hashVal ^= text.charCodeAt(idx);
    hashVal = Math.imul(hashVal, 0x01000193) >>> 0;
  }
  return hashVal.toString(16).padStart(8, "0");
}
// Produces deterministic UUIDv7-formatted identifiers for reproducible mock timelines
export function sampleId(inputSeed: string): string {
  const segment1 = computeHash32(inputSeed, 1);
  const segment2 = computeHash32(inputSeed, 2);
  const segment3 = computeHash32(inputSeed, 3);
  const segment4 = computeHash32(inputSeed, 4);
  const combined = `${segment1}${segment2}${segment3}${segment4}`;
  // Formats RFC4122 v7 simulated UUID segments
  return [
    combined.slice(0, 8),
    combined.slice(8, 12),
    `7${combined.slice(13, 16)}`,
    `8${combined.slice(17, 20)}`,
    combined.slice(20, 32),
  ].join("-");
}
export type ItemInput = Partial<MspItem> & { kind: string };
export interface ScriptOptions {
  branch?: string;
  approvalMode?: ApprovalMode;
  modelId?: string;
}
// Procedural timeline recorder that builds chronologically ordered ViewEvents
export class Script {
  readonly events: ViewEvent[] = [];
  seq: number = 0;
  at: number;
  private itemCounter = 0;
  private activeTurnId: string | null = null;
  private turnStartedTimestamp = 0;
  private promptTokensAccumulated = 0;
  private outputTokensAccumulated = 0;
  public constructor(
    public readonly sessionId: string,
    public readonly cwd: string,
    startTimeMs: number,
    options: ScriptOptions = {},
  ) {
    this.at = startTimeMs;
    const startupApproval: { mode: ApprovalMode; source: "startup"; lastCommandId: null } = {
      mode: options.approvalMode ?? "onRequest",
      source: "startup",
      lastCommandId: null,
    };
    const initialSessionPayload = {
      session: {
        sessionId: this.sessionId,
        status: "idle" as const,
        modelId: options.modelId ?? MODEL,
        workspaceRoot: this.cwd,
        approvalMode: startupApproval,
        turnCount: 0,
      },
    };
    this.push("session/started", initialSessionPayload, 0);
    const initialBranch = options.branch;
    if (initialBranch) {
      this.push("session/branchChanged", { branch: initialBranch }, 0);
    }
  }
  id(itemKind: string): string {
    this.itemCounter += 1;
    return sampleId(`${this.sessionId}:${itemKind}:${this.itemCounter}`);
  }
  public get currentTurn(): string | null {
    return this.activeTurnId;
  }
  push(eventName: string, payload: Record<string, unknown>, stepMs = 40): void {
    this.at += stepMs;
    this.seq = (this.seq + 1) | 0;
    // Enrich event parameters with session cursor
    const enrichedParams = {
      sessionId: this.sessionId,
      viewCursor: `v:${this.sessionId}:${this.seq}`,
      ...payload,
    };
    // Register event in timeline
    this.events.push({
      method: eventName,
      params: enrichedParams,
      at: this.at,
    });
  }
  pushAt(targetTimestamp: number, eventName: string, payload: Record<string, unknown>): void {
    this.at = targetTimestamp;
    this.push(eventName, payload, 0);
  }
  add(
    descriptor: ItemInput,
    delayMs = 40,
    notificationType: "item/started" | "item/completed" = "item/completed",
  ): MspItem {
    this.at += delayMs;
    // Derive item identifier and state
    const generatedId = descriptor.itemId ?? this.id(descriptor.kind);
    const resolvedStatus =
      descriptor.status ?? (notificationType === "item/started" ? "inProgress" : "completed");
    // Construct full item structure
    const fullItem = {
      ...descriptor,
      itemId: generatedId,
      status: resolvedStatus,
      revision: descriptor.revision ?? 1,
      turnId: descriptor.turnId ?? this.activeTurnId,
      recordedAt: descriptor.recordedAt ?? iso(this.at),
    } as unknown as MspItem;
    // Dispatch item notification event
    this.push(notificationType, { item: fullItem }, 0);
    return fullItem;
  }
  begin(promptMessage: string, pauseBeforeMs = 600): string {
    const freshTurnId = this.id("turn");
    this.activeTurnId = freshTurnId;
    this.push("turn/started", { turnId: freshTurnId, commandId: freshTurnId }, pauseBeforeMs);
    this.turnStartedTimestamp = this.at;
    // Insert user message item
    this.add({ kind: "userMessage", text: promptMessage, commandId: freshTurnId }, 30);
    return freshTurnId;
  }
  think(thoughtText: string, thinkingDurationMs = 2400): MspItem {
    return this.add({ kind: "reasoning", summary: [thoughtText] }, thinkingDurationMs);
  }
  tool(
    name: string,
    parameters: Record<string, unknown>,
    capturedOutput?: string,
    executionDurationMs = 2600,
    supplementalProps: Partial<MspItem> = {},
  ): MspItem {
    const defaultCallIdentifier = `call_${this.id("call").replace(/-/g, "").slice(0, 12)}`;
    const toolCallPayload: ItemInput = {
      kind: "toolCall",
      tool: name,
      callId: supplementalProps.callId ?? defaultCallIdentifier,
      args: JSON.stringify(parameters),
      ...(capturedOutput !== undefined ? { visibleOutput: capturedOutput } : {}),
      ...supplementalProps,
    };
    // Append completed tool call
    return this.add(toolCallPayload, executionDurationMs);
  }
  say(replyText: string, typingDurationMs = 3200): MspItem {
    return this.add({ kind: "agentMessage", text: replyText }, typingDurationMs);
  }
  bill(promptTokens: number, generatedTokens: number, cachedTokens = Math.round(promptTokens * 0.72)): void {
    this.promptTokensAccumulated += promptTokens;
    this.outputTokensAccumulated += generatedTokens;
    // Compute duration and reasoning token approximations
    const elapsedComputation = 1800 + (generatedTokens % 2400);
    const reasoningCount = Math.round(generatedTokens * 0.2);
    // Package token accounting payload
    const tokenAccountingData = {
      turnId: this.activeTurnId,
      modelId: MODEL,
      durationMs: elapsedComputation,
      promptTokens,
      totalTokens: promptTokens + generatedTokens,
      usage: {
        inputTokens: promptTokens,
        outputTokens: generatedTokens,
        cachedTokens,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: 0,
        reasoningTokens: reasoningCount,
      },
      cumulative: {
        promptTokens: this.promptTokensAccumulated,
        outputTokens: this.outputTokensAccumulated,
        totalTokens: this.promptTokensAccumulated + this.outputTokensAccumulated,
      },
    };
    // Post token accounting notification
    this.push("session/tokenUsage", tokenAccountingData, 0);
    // Prepare session context pressure metrics
    const contextMetrics = {
      usedTokens: promptTokens + generatedTokens,
      windowTokens: 1_000_000,
      pressure: "normal" as const,
    };
    // Post context usage notification
    this.push("session/contextUsage", contextMetrics, 0);
  }
  todos(checklistEntries: { text: string; status: string; activeForm?: string }[], delayMs = 300): void {
    this.push("session/todoListChanged", { items: checklistEntries }, delayMs);
  }
  end(minimumDurationMs: number, completionStatus = "completed"): void {
    const currentId = this.activeTurnId;
    if (!currentId) {
      return;
    }
    // Adjust timeline clock to match duration
    const elapsed = this.at - this.turnStartedTimestamp;
    if (elapsed < minimumDurationMs) {
      this.at = this.turnStartedTimestamp + minimumDurationMs;
    } else {
      this.at += 250;
    }
    // Package turn completion metrics
    const turnCompletionData = {
      turnId: currentId,
      terminal: completionStatus,
      durationMs: this.at - this.turnStartedTimestamp,
      timeToFirstTokenMs: 1600,
    };
    // Post turn completed event
    this.push("turn/completed", turnCompletionData, 0);
    this.activeTurnId = null;
  }
}
