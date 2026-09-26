import {
  type ObservedToolCall,
  type ResearchFailureKind,
  type ResearchModelIds,
  type SavedSource,
  type SessionManager,
  type WorkerBudgets,
  type WorkerResult,
  type WorkerRunner,
  type WorkerSink,
  type WorkerStatus,
  type WorkerTask,
  parseFindings as parseEngineFindings,
} from "@ancilla/daemon";
import {
  TURN_CANCEL_GRACE_MS,
  approvalSubjectOf,
  failureKindOf,
  planApproval,
  recordOf,
  runTurn,
  type SessionNotificationHandler,
  type TurnClock,
  type TurnControl,
} from "./turn.js";

export type { SessionNotificationHandler } from "./turn.js";

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
export type WorkerClock = TurnClock;

/** How long a worker gets between `turn/interrupt` and `turn/cancel`. */
export const WORKER_CANCEL_GRACE_MS = TURN_CANCEL_GRACE_MS;

/** What a denied worker approval tells the model. */
export const WORKER_DENY_FEEDBACK = "Research workers may only use web search and fetch tools.";

/** Why a research session declines a user-input prompt. */
export const RESEARCH_INPUT_DECLINED = "Research sessions run unattended; no one can answer.";

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

/**
 * Whether a worker may have an approval: network access with no tool named (the web tools' own requests), or a
 * network or tool request that names a web tool. Everything else (shell, files, other tools) is denied.
 */
export function workerApprovalAllowed(kind: string, toolName: string | null): boolean {
  if (kind === "network") {
    return toolName === null || isWebTool(toolName);
  }
  return kind === "tool" && isWebTool(toolName);
}

/** Parentheses are allowed inside a URL (Wikipedia titles); the trailing punctuation of prose is not. */
const URL_PATTERN = /https?:\/\/[^\s"'<>[\]]+/g;

function unbalancedTrailing(url: string): string {
  let text = url;
  for (;;) {
    const trimmed = text.replace(/[.,;:!?]+$/, "");
    let opens = 0;
    let closes = 0;
    for (const char of trimmed) {
      if (char === "(") {
        opens += 1;
      } else if (char === ")") {
        closes += 1;
      }
    }
    // A closing parenthesis with no opening one belongs to the prose around the URL, not to the URL.
    const next = closes > opens && trimmed.endsWith(")") ? trimmed.slice(0, -1) : trimmed;
    if (next === text) {
      return next;
    }
    text = next;
  }
}

/** The URLs in a text, in order, once each; balanced parentheses stay, an unbalanced trailing one goes. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.match(URL_PATTERN) ?? []) {
    const url = unbalancedTrailing(match);
    if (url.length > 0) {
      seen.add(url);
    }
  }
  return [...seen];
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

/**
 * The URLs a fetch was asked for: the `url`, `urls` or `href` fields of its JSON arguments when they parse, so a
 * URL with parentheses or trailing punctuation is taken exactly as the tool got it; the regex is the fallback
 * for arguments that are not JSON.
 */
export function argUrlsOf(args: string | null | undefined): string[] {
  const parsed = recordOf(parseJson(args));
  if (parsed) {
    const urls: string[] = [];
    for (const key of ["url", "urls", "href"]) {
      const value = parsed[key];
      const list = Array.isArray(value) ? value : [value];
      for (const entry of list) {
        if (typeof entry === "string" && /^https?:\/\//.test(entry.trim()) && !urls.includes(entry.trim())) {
          urls.push(entry.trim());
        }
      }
    }
    if (urls.length > 0) {
      return urls;
    }
  }
  return args ? extractUrls(args) : [];
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
  // A Markdown link's URL may hold one level of balanced parentheses, as Wikipedia titles do.
  for (const match of output.matchAll(/\[([^\]\n]{1,300})\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g)) {
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
  // The worker prompt asks for a closing fenced JSON block with `findings` and `saved`; the engine's parser reads
  // that form (the last fenced block, whatever its tag). Prose around the block still counts as findings when the
  // block carries none of its own.
  const contract = parseEngineFindings(text);
  if (contract.ok) {
    const fences = [...text.matchAll(/```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n[\s\S]*?```/g)];
    const last = fences[fences.length - 1];
    const outside = last && last.index !== undefined ? (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim() : "";
    return { findings: contract.value.findings || outside, saved: contract.value.saved };
  }
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
 * Runs one delegated task as a Muse worker session: one `turn/start` with the task's instructions (see
 * `runTurn` for the turn itself), then the session's `item/*` events read for the tool calls Muse made (the ground
 * truth for provenance), its approvals decided by a fixed policy, its user-input prompts declined, and the final
 * agent message parsed for findings. Budgets are enforced here, not by Muse: passing the tool-call cap or the
 * wall time interrupts the turn, and `turn/cancel` follows when it is still running after the grace period. The
 * search, read and save caps are soft: the prompt states them, the counters report them, and nothing stops a
 * worker that has read one page too many.
 */
export class MuseSessionWorkerRunner implements WorkerRunner {
  constructor(private readonly options: MuseSessionWorkerRunnerOptions) {}

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
    const log = (message: string): void => this.options.host.log?.(`research: worker A${task.agentId} ${message}`);
    let handle: WorkerSessionHandle;
    try {
      handle = await this.options.host.startWorkerSession(task, modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`could not start: ${message}`);
      return failed(failureKindOf(message) === "other" ? "unavailable" : failureKindOf(message), `could not start a worker session: ${message}`);
    }
    const { sessionId, manager } = handle;
    const clock = this.options.clock;
    const now = (): number => clock?.now() ?? Date.now();
    const startedAt = new Date(now()).toISOString();
    const counts = { toolCalls: 0, searches: 0, reads: 0 };
    const seen = new Map<string, SeenCall>();
    const softCapsPassed = new Set<string>();

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

    const noteCall = (item: Record<string, unknown>, at: string, control: TurnControl): void => {
      const itemId = typeof item["itemId"] === "string" ? item["itemId"] : null;
      if (!itemId || seen.has(itemId)) {
        return;
      }
      const tool = typeof item["tool"] === "string" ? item["tool"] : "unknown";
      const kind = classifyTool(tool);
      const args = typeof item["args"] === "string" ? item["args"] : null;
      seen.set(itemId, { itemId, tool, kind, query: queryOf(args), argUrls: argUrlsOf(args), at, reported: false });
      counts.toolCalls += 1;
      if (kind === "search") {
        counts.searches += 1;
      } else if (kind === "fetch") {
        counts.reads += 1;
      }
      sink.onProgress({ ...counts });
      report("working", 0, null);
      // The search and read caps are stated in the prompt and reported here; only the tool-call cap interrupts.
      if (counts.searches > budgets.maxSearches && !softCapsPassed.has("searches")) {
        softCapsPassed.add("searches");
        log(`passed its search allowance (${counts.searches} of ${budgets.maxSearches}); counting on.`);
      }
      if (counts.reads > budgets.maxReads && !softCapsPassed.has("reads")) {
        softCapsPassed.add("reads");
        log(`passed its read allowance (${counts.reads} of ${budgets.maxReads}); counting on.`);
      }
      if (counts.toolCalls > budgets.maxToolCalls) {
        log(`passed its budget (${counts.toolCalls} tool calls of ${budgets.maxToolCalls}, ${counts.searches} searches, ${counts.reads} reads); interrupting.`);
        // A budget breach still counts as a completed worker: whatever it wrote so far is its answer.
        control.stop("completed", "budget exhausted");
      }
    };

    const completeCall = (item: Record<string, unknown>, control: TurnControl): void => {
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
      control.defer(async () => {
        let results: { url: string; title: string | null }[] = [];
        if (visible && !truncated) {
          results = resultsOf(visible);
        } else if (call.kind === "search" && refId && itemId) {
          try {
            const range = await manager.readItemOutput(sessionId, itemId, refId, { offsetBytes: 0, lengthBytes: 256 * 1024 });
            results = resultsOf(range.content);
          } catch (error) {
            log(`could not read a search output: ${error instanceof Error ? error.message : String(error)}`);
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

    const decide = (params: Record<string, unknown>, control: TurnControl): void => {
      const { approvalId, kind, toolName } = approvalSubjectOf(params);
      if (!approvalId) {
        return;
      }
      const allow = workerApprovalAllowed(kind, toolName);
      const plan = planApproval(params, allow, WORKER_DENY_FEEDBACK);
      const subject = `${kind}${toolName ? ` ${toolName}` : ""}`;
      if (!plan) {
        // Muse rejects a choiceId it did not offer, and an approval nobody answers holds the turn forever.
        log(`approval ${approvalId} (${subject}) offers no ${allow ? "approve" : "deny"} choice; interrupting.`);
        control.stop("completed", "an approval offered no usable choice");
        return;
      }
      log(`approval ${approvalId} (${subject}) ${plan.decision} (${plan.choiceId}).`);
      control.defer(() =>
        manager.decideApproval({ sessionId, approvalId: plan.approvalId, requirementId: plan.requirementId, choiceId: plan.choiceId, feedback: plan.feedback }).then(
          () => undefined,
          (error: unknown) => {
            log(`approval decision failed: ${error instanceof Error ? error.message : String(error)}`);
          },
        ),
      );
    };

    const declineInput = (params: Record<string, unknown>, control: TurnControl): void => {
      const userInputId = typeof params["userInputId"] === "string" ? params["userInputId"] : null;
      if (!userInputId) {
        return;
      }
      // Nobody is watching a worker: the prompt is declined so the tool call resolves, and the turn is ended.
      log(`asked for user input (${userInputId}); declining and interrupting.`);
      control.defer(() =>
        manager.cancelUserInput(sessionId, userInputId, RESEARCH_INPUT_DECLINED).then(
          () => undefined,
          (error: unknown) => {
            log(`declining user input failed: ${error instanceof Error ? error.message : String(error)}`);
          },
        ),
      );
      control.stop("completed", "the worker asked for user input");
    };

    const onNotification = (method: string, params: Record<string, unknown>, control: TurnControl): void => {
      switch (method) {
        case "item/started":
        case "item/updated":
        case "item/completed": {
          const item = recordOf(params["item"]);
          if (item && item["kind"] === "toolCall") {
            noteCall(item, new Date(now()).toISOString(), control);
            if (method === "item/completed" || (typeof item["status"] === "string" && item["status"] !== "inProgress")) {
              completeCall(item, control);
            }
          }
          return;
        }
        case "approval/requested":
          decide(params, control);
          return;
        case "userInput/requested":
          declineInput(params, control);
          return;
        default:
          return;
      }
    };

    report("working", 0, null);
    const turn = await runTurn(
      { sessionId, manager },
      task.instructions,
      {
        timeoutMs: budgets.wallTimeMs,
        signal,
        subscribe: (id, handler) => this.options.host.subscribe(id, handler),
        onNotification,
        ...(clock ? { clock } : {}),
        ...(this.options.cancelGraceMs !== undefined ? { cancelGraceMs: this.options.cancelGraceMs } : {}),
        label: `worker A${task.agentId}`,
        kind: "worker",
        log: (message) => this.options.host.log?.(message),
      },
    );
    const endedAt = new Date(now()).toISOString();
    if (turn.startFailed) {
      report("failed", 0, endedAt);
      return { ...failed("unavailable", "the worker turn did not start"), error: turn.error };
    }
    const parsed = parseFindings(turn.text);
    report(turn.status, parsed.saved.length, endedAt);
    return { status: turn.status, findings: parsed.findings, saved: parsed.saved, observed, usage: turn.usage, error: turn.error };
  }
}
