/**
 * Builds sample threads as the MSP view events `muse serve` streams: turns made of prompts, reasoning,
 * tool calls and replies, with the token and context readings that follow each model call. Only the
 * demo uses it; nothing here reaches the production bundle.
 */
import type { ApprovalMode, MspItem, ViewEvent } from "@ancilla/ui";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const MODEL = "muse-spark-1.3";

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function fnv(text: string, salt: number): string {
  let hash = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A stable UUID-shaped id, so a reload keeps every item, turn and agent where it was. */
export function sampleId(seed: string): string {
  const hex = [1, 2, 3, 4].map((salt) => fnv(seed, salt)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** An item as the builder takes it: everything but the kind can be left for the builder to fill in. */
export type ItemInput = Partial<MspItem> & { kind: string };

/** One thread's history, written in order. Times advance by each step's gap, like a real turn. */
export class Script {
  readonly events: ViewEvent[] = [];
  /** The view cursor's sequence; the live client carries on from here. */
  seq = 0;
  at: number;
  private n = 0;
  private turnId: string | null = null;
  private turnStart = 0;
  private promptTotal = 0;
  private outputTotal = 0;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    start: number,
    options: { branch?: string; approvalMode?: ApprovalMode; modelId?: string } = {},
  ) {
    this.at = start;
    this.push(
      "session/started",
      {
        session: {
          sessionId,
          status: "idle",
          modelId: options.modelId ?? MODEL,
          workspaceRoot: cwd,
          approvalMode: { mode: options.approvalMode ?? "onRequest", source: "startup", lastCommandId: null },
          turnCount: 0,
        },
      },
      0,
    );
    if (options.branch) {
      this.push("session/branchChanged", { branch: options.branch }, 0);
    }
  }

  /** A fresh id scoped to this thread. */
  id(kind: string): string {
    this.n += 1;
    return sampleId(`${this.sessionId}:${kind}:${this.n}`);
  }

  get currentTurn(): string | null {
    return this.turnId;
  }

  push(method: string, params: Record<string, unknown>, gap = 40): void {
    this.at += gap;
    this.seq += 1;
    this.events.push({ method, params: { sessionId: this.sessionId, viewCursor: `v:${this.sessionId}:${this.seq}`, ...params }, at: this.at });
  }

  /** Records an item; `method` is `item/started` for one still running. */
  add(input: ItemInput, gap = 40, method: "item/started" | "item/completed" = "item/completed"): MspItem {
    this.at += gap;
    const item = {
      ...input,
      itemId: input.itemId ?? this.id(input.kind),
      status: input.status ?? (method === "item/started" ? "inProgress" : "completed"),
      revision: input.revision ?? 1,
      turnId: input.turnId ?? this.turnId,
      recordedAt: input.recordedAt ?? iso(this.at),
    } as MspItem;
    this.push(method, { item }, 0);
    return item;
  }

  begin(text: string, gap = 600): string {
    const turnId = this.id("turn");
    this.turnId = turnId;
    this.push("turn/started", { turnId, commandId: turnId }, gap);
    this.turnStart = this.at;
    this.add({ kind: "userMessage", text, commandId: turnId }, 30);
    return turnId;
  }

  think(summary: string, gap = 2400): MspItem {
    return this.add({ kind: "reasoning", summary: [summary] }, gap);
  }

  tool(tool: string, args: Record<string, unknown>, output?: string, gap = 2600, extra: Partial<MspItem> = {}): MspItem {
    return this.add(
      {
        kind: "toolCall",
        tool,
        callId: extra.callId ?? `call_${this.id("call").replace(/-/g, "").slice(0, 12)}`,
        args: JSON.stringify(args),
        ...(output !== undefined ? { visibleOutput: output } : {}),
        ...extra,
      },
      gap,
    );
  }

  say(text: string, gap = 3200): MspItem {
    return this.add({ kind: "agentMessage", text }, gap);
  }

  /** One model call's tokens, as `session/tokenUsage` reports it, and the context it left. */
  bill(promptTokens: number, outputTokens: number, cachedTokens = Math.round(promptTokens * 0.72)): void {
    this.promptTotal += promptTokens;
    this.outputTotal += outputTokens;
    this.push(
      "session/tokenUsage",
      {
        turnId: this.turnId,
        modelId: MODEL,
        durationMs: 1800 + (outputTokens % 2400),
        promptTokens,
        totalTokens: promptTokens + outputTokens,
        usage: {
          inputTokens: promptTokens,
          outputTokens,
          cachedTokens,
          cacheReadTokens: cachedTokens,
          cacheWriteTokens: 0,
          reasoningTokens: Math.round(outputTokens * 0.2),
        },
        cumulative: { promptTokens: this.promptTotal, outputTokens: this.outputTotal, totalTokens: this.promptTotal + this.outputTotal },
      },
      0,
    );
    this.push("session/contextUsage", { usedTokens: promptTokens + outputTokens, windowTokens: 1_000_000, pressure: "normal" }, 0);
  }

  todos(items: { text: string; status: string; activeForm?: string }[], gap = 300): void {
    this.push("session/todoListChanged", { items }, gap);
  }

  /** Closes the turn at least `durationMs` after it started, the way the transcript times it. */
  end(durationMs: number, terminal = "completed"): void {
    const turnId = this.turnId;
    if (!turnId) {
      return;
    }
    this.at = Math.max(this.at + 250, this.turnStart + durationMs);
    this.push("turn/completed", { turnId, terminal, durationMs: this.at - this.turnStart, timeToFirstTokenMs: 1600 }, 0);
    this.turnId = null;
  }
}
