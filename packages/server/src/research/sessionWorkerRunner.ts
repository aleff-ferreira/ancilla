import {
  addUsage,
  type ObservedToolCall,
  type ResearchFailureKind,
  type ResearchModelIds,
  type SavedSource,
  type SessionManager,
  type TokenUsage,
  type WorkerBudgets,
  type WorkerResult,
  type WorkerRunner,
  type WorkerSink,
  type WorkerStatus,
  type WorkerTask,
} from "@ancilla/daemon";

/** A worker session the host started for one task: its id and the manager of the host it lives on. */
export interface WorkerSessionHandle {
  sessionId: string;
  manager: SessionManager;
}

/** How a worker's state looks to whoever keeps the rows and the live counters. */
export interface WorkerUpdate {
  runId: string;
  round: number;
  agentId: number;
  topic: string;
  discovery: boolean;
  workerSessionId: string;
  state: "working" | WorkerStatus;
  toolCalls: number;
  searches: number;
  reads: number;
  saved: number;
  startedAt: string;
  endedAt: string | null;
}

export type SessionNotificationHandler = (method: string, params: Record<string, unknown>) => void;

/** What the runner needs from the server: a session on the thread's host, its notifications, and a log. */
export interface WorkerRunnerHost {
  /** Starts a worker session on the thread's host and records it archived; rejects when Muse cannot. */
  startWorkerSession(task: WorkerTask, modelId: string | null): Promise<WorkerSessionHandle>;
  /** Delivers that session's host notifications until the returned function is called. */
  subscribe(sessionId: string, handler: SessionNotificationHandler): () => void;
  onWorkerUpdate?(update: WorkerUpdate): void;
  log?(message: string): void;
}

/** The clock the runner measures wall time with; tests inject a fake one. */
export interface WorkerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: WorkerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long a worker gets between `turn/interrupt` and `turn/cancel`. */
export const WORKER_CANCEL_GRACE_MS = 30_000;

export interface MuseSessionWorkerRunnerOptions {
  host: WorkerRunnerHost;
  models: ResearchModelIds;
  /** The thread's model, for when the config names none for workers. */
  fallbackModelId: string | null;
  clock?: WorkerClock;
  cancelGraceMs?: number;
}

/** Muse's tool names are not pinned, so kinds are read off the name; unknown web-ish names count as `other`. */
export function classifyTool(tool: string): ObservedToolCall["kind"] {
  if (/search/i.test(tool)) {
    return "search";
  }
  if (/fetch|read_?url|browse|open_?url|web_?get|crawl|http/i.test(tool)) {
    return "fetch";
  }
  return "other";
}

/** Whether a tool name looks like a web tool, the only kind a worker is allowed to be approved for. */
export function isWebTool(tool: string | null | undefined): boolean {
  return typeof tool === "string" && classifyTool(tool) !== "other";
}

const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]]+/g;

export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.match(URL_PATTERN) ?? []) {
    const url = match.replace(/[.,;:!?]+$/, "");
    if (url.length > 0) {
      seen.add(url);
    }
  }
  return [...seen];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the object inside */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** The search query named in a tool call's arguments, under whichever key the tool uses. */
export function queryOf(args: string | null | undefined): string | null {
  const parsed = recordOf(parseJson(args));
  if (!parsed) {
    return null;
  }
  for (const key of ["query", "q", "search", "term", "keywords", "input"]) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** Results (url and title) named in a tool's output: JSON objects with both, Markdown links, or bare URLs. */
export function resultsOf(output: string): { url: string; title: string | null }[] {
  const results = new Map<string, string | null>();
  const parsed = parseJson(output);
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry, depth + 1);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const url = typeof record["url"] === "string" ? record["url"] : typeof record["link"] === "string" ? record["link"] : null;
    if (url && /^https?:\/\//.test(url)) {
      const title = typeof record["title"] === "string" ? record["title"] : typeof record["name"] === "string" ? record["name"] : null;
      if (!results.has(url) || (title && !results.get(url))) {
        results.set(url, title);
      }
    }
    for (const entry of Object.values(record)) {
      walk(entry, depth + 1);
    }
  };
  walk(parsed, 0);
  for (const match of output.matchAll(/\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = match[2] as string;
    if (!results.has(url) || !results.get(url)) {
      results.set(url, (match[1] as string).trim());
    }
  }
  for (const url of extractUrls(output)) {
    if (!results.has(url)) {
      results.set(url, null);
    }
  }
  return [...results.entries()].map(([url, title]) => ({ url, title }));
}

export interface ParsedFindings {
  findings: string;
  saved: SavedSource[];
}

function savedOf(value: unknown): SavedSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const saved: SavedSource[] = [];
  for (const entry of value) {
    const record = recordOf(entry);
    const url = record ? (typeof record["url"] === "string" ? record["url"] : typeof record["link"] === "string" ? record["link"] : null) : typeof entry === "string" ? entry : null;
    if (!url || !/^https?:\/\//.test(url)) {
      continue;
    }
    saved.push({
      url: url.trim(),
      title: record && typeof record["title"] === "string" ? record["title"] : null,
      reason: record && typeof record["reason"] === "string" ? record["reason"] : record && typeof record["why"] === "string" ? record["why"] : "",
      excerpt: record && typeof record["excerpt"] === "string" ? record["excerpt"] : record && typeof record["quote"] === "string" ? record["quote"] : null,
    });
  }
  return saved;
}

/**
 * The worker's final message: its findings plus a fenced `findings` block (or `<findings>` tags) with the sources
 * it kept, as JSON. Read leniently, because the block is prompt-enforced only. Without a block the whole message
 * is the findings and nothing was saved; the engine then falls back to what the worker fetched.
 */
export function parseFindings(text: string): ParsedFindings {
  const match = /```findings[^\n]*\n([\s\S]*?)```/i.exec(text) ?? /<findings>([\s\S]*?)<\/findings>/i.exec(text);
  if (!match) {
    return { findings: text.trim(), saved: [] };
  }
  const block = recordOf(parseJson(match[1]));
  const outside = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  const inside = block && typeof block["findings"] === "string" ? block["findings"].trim() : "";
  return {
    findings: inside || outside,
    saved: savedOf(block?.["saved"] ?? block?.["sources"] ?? block?.["saved_sources"]),
  };
}

/** The failure kind a message points at, for the `error` prefix of a failed worker. */
export function failureKindOf(message: string): ResearchFailureKind {
  if (/\b(401|403)\b|unauthori[sz]ed|not logged in|forbidden/i.test(message)) {
    return "auth";
  }
  if (/\b402\b|quota|insufficient/i.test(message)) {
    return "quota";
  }
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(message)) {
    return "rate_limited";
  }
  if (/timed? ?out/i.test(message)) {
    return "timeout";
  }
  if (/cancel/i.test(message)) {
    return "cancelled";
  }
  if (/unavailable|could not start|connection|ECONN|refused/i.test(message)) {
    return "unavailable";
  }
  return "other";
}

function usageOfNotification(params: Record<string, unknown>): TokenUsage | null {
  const usage = recordOf(params["usage"]) ?? {};
  const inputTokens = typeof params["promptTokens"] === "number" ? params["promptTokens"] : typeof usage["inputTokens"] === "number" ? usage["inputTokens"] : 0;
  const outputTokens = typeof usage["outputTokens"] === "number" ? usage["outputTokens"] : 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }
  const cachedInputTokens = typeof usage["cacheReadTokens"] === "number" ? usage["cacheReadTokens"] : typeof usage["cachedTokens"] === "number" ? usage["cachedTokens"] : 0;
  const totalTokens = typeof params["totalTokens"] === "number" ? params["totalTokens"] : inputTokens + outputTokens;
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

interface SeenCall {
  itemId: string;
  tool: string;
  kind: ObservedToolCall["kind"];
  query: string | null;
  argUrls: string[];
  at: string;
  reported: boolean;
}

/**
 * Runs one delegated task as a Muse worker session: one `turn/start` with the task's instructions, then the
 * session's `item/*` events read for the tool calls Muse made (the ground truth for provenance), its token usage
 * summed, its approvals decided by a fixed policy, and the final agent message parsed for findings. Budgets are
 * enforced here, not by Muse: a breach or the wall time sends `turn/interrupt`, and `turn/cancel` follows when
 * the turn is still running after the grace period.
 */
export class MuseSessionWorkerRunner implements WorkerRunner {
  private readonly clock: WorkerClock;
  private readonly cancelGraceMs: number;

  constructor(private readonly options: MuseSessionWorkerRunnerOptions) {
    this.clock = options.clock ?? REAL_CLOCK;
    this.cancelGraceMs = options.cancelGraceMs ?? WORKER_CANCEL_GRACE_MS;
  }

  async run(task: WorkerTask, budgets: WorkerBudgets, signal: AbortSignal, sink: WorkerSink): Promise<WorkerResult> {
    const observed: ObservedToolCall[] = [];
    const failed = (kind: ResearchFailureKind, message: string, status: WorkerStatus = "failed"): WorkerResult => ({
      status,
      findings: "",
      saved: [],
      observed,
      usage: null,
      error: `${kind}: ${message}`,
    });
    if (signal.aborted) {
      return failed("cancelled", "The run was stopped before the worker started.", "cancelled");
    }
    const modelId = this.options.models.worker ?? this.options.fallbackModelId;
    let handle: WorkerSessionHandle;
    try {
      handle = await this.options.host.startWorkerSession(task, modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.host.log?.(`research: worker A${task.agentId} could not start: ${message}`);
      return failed(failureKindOf(message) === "other" ? "unavailable" : failureKindOf(message), `could not start a worker session: ${message}`);
    }
    const { sessionId, manager } = handle;
    const startedAt = new Date(this.clock.now()).toISOString();
    const counts = { toolCalls: 0, searches: 0, reads: 0 };
    let usage: TokenUsage | null = null;
    let turnId: string | null = null;
    let finalText: string | null = null;
    const deltas = new Map<string, string>();
    const seen = new Map<string, SeenCall>();
    let outcome: WorkerStatus | null = null;
    let outcomeError: string | null = null;
    let interruptSent = false;
    let cancelTimer: unknown = null;
    let wallTimer: unknown = null;
    let pending: Promise<void> = Promise.resolve();
    let settle: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const report = (state: WorkerUpdate["state"], savedCount: number, endedAt: string | null): void => {
      this.options.host.onWorkerUpdate?.({
        runId: task.runId,
        round: task.round,
        agentId: task.agentId,
        topic: task.topic,
        discovery: task.discovery,
        workerSessionId: sessionId,
        state,
        toolCalls: counts.toolCalls,
        searches: counts.searches,
        reads: counts.reads,
        saved: savedCount,
        startedAt,
        endedAt,
      });
    };

    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancelTimer !== null) {
        this.clock.clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      if (wallTimer !== null) {
        this.clock.clearTimeout(wallTimer);
        wallTimer = null;
      }
      settle?.();
    };

    const stopTurn = async (why: WorkerStatus, message: string): Promise<void> => {
      if (outcome === null) {
        outcome = why;
        outcomeError = message;
      }
      if (interruptSent) {
        return;
      }
      interruptSent = true;
      try {
        await manager.interruptTurn(sessionId, turnId ?? undefined);
      } catch (error) {
        this.options.host.log?.(`research: worker A${task.agentId} interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      cancelTimer = this.clock.setTimeout(() => {
        cancelTimer = null;
        if (settled) {
          return;
        }
        const id = turnId;
        if (id) {
          manager.cancelTurn(sessionId, id).catch((error: unknown) => {
            this.options.host.log?.(`research: worker A${task.agentId} cancel failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
        // Muse may never answer a cancel for a turn it lost; the worker is over from here either way.
        finish();
      }, this.cancelGraceMs);
    };

    const noteCall = (item: Record<string, unknown>, at: string): void => {
      const itemId = typeof item["itemId"] === "string" ? item["itemId"] : null;
      if (!itemId || seen.has(itemId)) {
        return;
      }
      const tool = typeof item["tool"] === "string" ? item["tool"] : "unknown";
      const kind = classifyTool(tool);
      const args = typeof item["args"] === "string" ? item["args"] : null;
      seen.set(itemId, { itemId, tool, kind, query: queryOf(args), argUrls: args ? extractUrls(args) : [], at, reported: false });
      counts.toolCalls += 1;
      if (kind === "search") {
        counts.searches += 1;
      } else if (kind === "fetch") {
        counts.reads += 1;
      }
      sink.onProgress({ ...counts });
      report("working", 0, null);
      if (counts.toolCalls > budgets.maxToolCalls || counts.searches > budgets.maxSearches || counts.reads > budgets.maxReads) {
        this.options.host.log?.(`research: worker A${task.agentId} passed its budget (${counts.toolCalls} calls, ${counts.searches} searches, ${counts.reads} reads); interrupting.`);
        // A budget breach still counts as a completed worker: whatever it wrote so far is its answer.
        void stopTurn("completed", "budget exhausted");
      }
    };

    const completeCall = (item: Record<string, unknown>): void => {
      const itemId = typeof item["itemId"] === "string" ? item["itemId"] : null;
      const call = itemId ? seen.get(itemId) : undefined;
      if (!call || call.reported) {
        return;
      }
      call.reported = true;
      const visible = typeof item["visibleOutput"] === "string" ? item["visibleOutput"] : null;
      const truncated = item["truncated"] === true;
      const ref = recordOf(item["outputRef"]);
      const refId = ref && typeof ref["id"] === "string" ? ref["id"] : ref && typeof ref["uri"] === "string" ? ref["uri"] : null;
      pending = pending.then(async () => {
        let results: { url: string; title: string | null }[] = [];
        if (visible && !truncated) {
          results = resultsOf(visible);
        } else if (call.kind === "search" && refId && itemId) {
          try {
            const range = await manager.readItemOutput(sessionId, itemId, refId, { offsetBytes: 0, lengthBytes: 256 * 1024 });
            results = resultsOf(range.content);
          } catch (error) {
            this.options.host.log?.(`research: worker A${task.agentId} could not read a search output: ${error instanceof Error ? error.message : String(error)}`);
            results = visible ? resultsOf(visible) : [];
          }
        } else if (visible) {
          results = resultsOf(visible);
        }
        const urls = call.kind === "search" ? results.map((r) => r.url) : [...new Set([...call.argUrls, ...results.map((r) => r.url)])];
        const observedCall: ObservedToolCall = {
          tool: call.tool,
          kind: call.kind,
          query: call.query,
          urls: call.kind === "search" ? urls : call.argUrls.length > 0 ? call.argUrls : urls,
          results: call.kind === "search" ? results : [],
          at: call.at,
        };
        observed.push(observedCall);
        sink.onToolCall(observedCall);
      });
    };

    const decide = (params: Record<string, unknown>): void => {
      const approvalId = typeof params["approvalId"] === "string" ? params["approvalId"] : null;
      if (!approvalId) {
        return;
      }
      const subject = recordOf(params["subject"]);
      const kind = subject && typeof subject["kind"] === "string" ? subject["kind"] : "unknown";
      const toolName = (subject && typeof subject["toolName"] === "string" ? subject["toolName"] : null) ?? (typeof params["toolName"] === "string" ? params["toolName"] : null);
      const allow = (kind === "network" || kind === "tool") && isWebTool(toolName ?? (kind === "network" ? "web" : null));
      const wanted = allow ? "allow" : "deny";
      const choices = Array.isArray(params["availableChoices"]) ? (params["availableChoices"] as unknown[]).map(recordOf) : [];
      const matching = choices.filter((c): c is Record<string, unknown> => c !== null && c["decision"] === wanted);
      const choice = matching.find((c) => c["scope"] === "once") ?? matching[0];
      const choiceId = choice && typeof choice["choiceId"] === "string" ? choice["choiceId"] : wanted;
      const requirementId = params["currentRequirementId"] ?? params["requirementId"] ?? null;
      this.options.host.log?.(`research: worker A${task.agentId} approval ${approvalId} (${kind}${toolName ? ` ${toolName}` : ""}) ${wanted}.`);
      pending = pending.then(() =>
        manager.decideApproval({ sessionId, approvalId, requirementId, choiceId, feedback: allow ? null : "Research workers may only use web search and fetch tools." }).then(
          () => undefined,
          (error: unknown) => {
            this.options.host.log?.(`research: worker A${task.agentId} approval decision failed: ${error instanceof Error ? error.message : String(error)}`);
          },
        ),
      );
    };

    const onNotification: SessionNotificationHandler = (method, params) => {
      if (settled) {
        return;
      }
      const at = new Date(this.clock.now()).toISOString();
      switch (method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const item = recordOf(params["item"]);
          if (!item) {
            return;
          }
          if (item["kind"] === "toolCall") {
            noteCall(item, at);
            if (method === "item/completed" || (typeof item["status"] === "string" && item["status"] !== "inProgress")) {
              completeCall(item);
            }
          } else if (item["kind"] === "agentMessage" && typeof item["text"] === "string" && item["text"].length > 0) {
            finalText = item["text"];
          }
          return;
        }
        case "item/delta": {
          const field = params["field"];
          const itemId = typeof params["itemId"] === "string" ? params["itemId"] : null;
          if (itemId && (field === undefined || field === "text") && typeof params["delta"] === "string") {
            deltas.set(itemId, (deltas.get(itemId) ?? "") + params["delta"]);
          }
          return;
        }
        case "session/tokenUsage": {
          const found = usageOfNotification(params);
          if (found) {
            usage = addUsage(usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 }, found);
          }
          return;
        }
        case "approval/requested": {
          decide(params);
          return;
        }
        case "turn/completed": {
          const completedTurn = typeof params["turnId"] === "string" ? params["turnId"] : null;
          if (turnId && completedTurn && completedTurn !== turnId) {
            return;
          }
          const terminal = typeof params["terminal"] === "string" ? params["terminal"] : "completed";
          if (outcome === null) {
            if (terminal === "completed") {
              outcome = "completed";
            } else if (terminal === "failed") {
              outcome = "failed";
              const error = recordOf(params["error"]);
              const message = (error && typeof error["message"] === "string" ? error["message"] : null) ?? (typeof params["reason"] === "string" ? params["reason"] : "The worker turn failed.");
              outcomeError = `${failureKindOf(message)}: ${message}`;
            } else {
              outcome = "cancelled";
              outcomeError = `cancelled: the worker turn ended as ${terminal}.`;
            }
          }
          finish();
          return;
        }
        case "session/closed": {
          if (outcome === null) {
            outcome = "failed";
            outcomeError = "unavailable: the worker session closed before its turn completed.";
          }
          finish();
          return;
        }
        default:
          return;
      }
    };

    const unsubscribe = this.options.host.subscribe(sessionId, onNotification);
    const onAbort = (): void => {
      void stopTurn("cancelled", "cancelled: the run was stopped.");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    report("working", 0, null);
    try {
      let ack;
      try {
        ack = await manager.sendTurn(sessionId, task.instructions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report("failed", 0, new Date(this.clock.now()).toISOString());
        return failed(failureKindOf(message) === "other" ? "unavailable" : failureKindOf(message), `could not start the worker turn: ${message}`);
      }
      turnId = ack.turnId;
      if (signal.aborted && !interruptSent) {
        void stopTurn("cancelled", "cancelled: the run was stopped.");
      }
      wallTimer = this.clock.setTimeout(() => {
        wallTimer = null;
        this.options.host.log?.(`research: worker A${task.agentId} passed its wall time; interrupting.`);
        void stopTurn("timed_out", `timeout: the worker passed its ${Math.round(budgets.wallTimeMs / 1000)} s wall time.`);
      }, budgets.wallTimeMs);
      await done;
      await pending;
    } finally {
      finish();
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    }
    const text = finalText ?? [...deltas.values()].filter((t) => t.trim().length > 0).pop() ?? "";
    const parsed = parseFindings(text);
    // `outcome` is written from the notification closures, which TypeScript's narrowing cannot see.
    const status: WorkerStatus = (outcome as WorkerStatus | null) ?? "completed";
    const endedAt = new Date(this.clock.now()).toISOString();
    report(status, parsed.saved.length, endedAt);
    let error: string | null = null;
    if (status === "failed" || status === "cancelled") {
      error = outcomeError ?? `${status}: the worker did not complete.`;
    } else if (status === "timed_out") {
      error = outcomeError ?? "timeout: the worker passed its wall time.";
    }
    return { status, findings: parsed.findings, saved: parsed.saved, observed, usage, error };
  }
}
