import type {
  ApprovalMode,
  ApprovalRequest,
  ContextUsage,
  Goal,
  MspItem,
  TodoItem,
  TokenTotals,
  TranscriptLoad,
  UserInputAnswer,
  UserInputRequest,
  ViewEvent,
} from "../types.js";

/**
 * The per-thread fold of the MSP view stream. Pure and immutable: every apply returns a new
 * object (or the same one when nothing changed), so React can compare by reference.
 */

export interface TurnInfo {
  turnId: string;
  startedAt?: number;
  completedAt?: number;
  /**
   * Muse's word for how the turn ended. `unknown` is Ancilla's own: Muse says the turn is over, but the saved history
   * it could read stops before the outcome, so nothing is claimed about it.
   */
  terminal?: string;
  /** The outcome came from a partial history read, so a later read that holds the real one may still replace it. */
  provisional?: boolean;
  durationMs?: number;
  /** Time to the first streamed token, when the host measured it. */
  firstTokenMs?: number;
  /** The model text streaming in right now, for a live speed estimate. A pause starts a new burst. */
  stream?: { chars: number; startAt: number; lastAt: number };
  error?: { kind: string; message: string; retryable: boolean };
  /** The user acted on the failure notice, so the transcript stops showing it. */
  dismissed?: boolean;
  retry?: { attempt: number; maxAttempts: number; nextAttempt: number; reason: string; retryDelayMs: number };
  retracted?: boolean;
}

/** A prompt the user sent that the stream has not echoed back yet. */
/** A file going out with a prompt that has not landed yet; `url` is a local object URL while it is in flight. */
export interface EchoAttachment {
  name: string;
  mediaType: string;
  kind: "image" | "file";
  url: string | null;
}

export interface LocalEcho {
  localId: string;
  text: string;
  turnId: string | null;
  disposition: "sending" | "started" | "queued" | "steered";
  createdAt: number;
  attachments?: EchoAttachment[];
  /**
   * Prompt items text alone must not match this echo to: the ones already in the thread when it was sent, and the ones
   * that already stand for another send. Two identical steers ("continue", "yes") share a turn and a text, so this is
   * what keeps the first one's item from taking the second one's bubble.
   */
  excluded?: string[];
}

/** One model call's usage, from its `session/tokenUsage` event. */
export interface CallUsage {
  turnId: string | null;
  modelId: string | null;
  /** Prompt tokens counted once under the provider's cache convention. */
  promptTokens: number;
  outputTokens: number;
  inputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number | null;
}

type MetaField = "todoList" | "branch" | "contextUsage" | "modelId" | "approvalMode" | "goal";
interface MetaObservation { cursor: string | null; at: number | undefined }

export interface ThreadMeta {
  /** Ordering evidence for accepting newer metadata from a non-authoritative history page. */
  observed?: Partial<Record<MetaField, MetaObservation>>;
  todoList: TodoItem[] | null;
  branch: string | null;
  contextUsage: ContextUsage | null;
  tokenTotals: TokenTotals | null;
  /** Every model call's usage, keyed by view cursor so a reloaded history never counts one twice. */
  calls: Record<string, CallUsage>;
  modelId: string | null;
  approvalMode: ApprovalMode | null;
  goal: Goal | null;
  /** A goal change arrived, so a null goal means cleared rather than never set. */
  goalSeen: boolean;
  /** When the current objective first appeared live; the goal record's own start time is preferred. */
  goalSince: number | null;
  /** When the goal's status last changed live, so a paused or finished goal's clock stops there. */
  goalStatusAt: number | null;
  /** Stretches the goal spent paused or blocked, seen live; its running time and counts leave them out. */
  goalPauses: { from: number; to: number | null }[];
}

export interface ThreadFold {
  items: Record<string, MspItem>;
  /** Small stable index for the agent panel; ordinary text deltas do not replace it. */
  agentItems?: Record<string, MspItem>;
  /** Item ids in first-opened order. */
  order: string[];
  turns: Record<string, TurnInfo>;
  activeTurnId: string | null;
  /** Pending approvals and questions for this thread, keyed by id. */
  approvals: Record<string, ApprovalRequest>;
  userInputs: Record<string, UserInputRequest>;
  resolved: Record<string, { decision: string; resolvedBy: string }>;
  settled: Record<string, { outcome: string; answers: UserInputAnswer[] }>;
  echoes: LocalEcho[];
  meta: ThreadMeta;
  /** The host unloaded the session; the next command must resume it first. */
  closed: boolean;
}

export const HIDDEN_KINDS: ReadonlySet<string> = new Set(["reminderChild"]);

export function emptyFold(): ThreadFold {
  return {
    items: {},
    agentItems: {},
    order: [],
    turns: {},
    activeTurnId: null,
    approvals: {},
    userInputs: {},
    resolved: {},
    settled: {},
    echoes: [],
    meta: {
      todoList: null,
      branch: null,
      contextUsage: null,
      tokenTotals: null,
      calls: {},
      modelId: null,
      approvalMode: null,
      goal: null,
      goalSeen: false,
      goalSince: null,
      goalStatusAt: null,
      goalPauses: [],
    },
    closed: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A goal block from `session/goalChanged`, or null when it is not one. Odd field types fall back to safe values. */
function asGoal(value: unknown): Goal | null {
  const record = asRecord(value);
  const objective = record ? str(record["objective"]) : null;
  if (!record || !objective) {
    return null;
  }
  return {
    objective,
    status: str(record["status"]) ?? "active",
    percentComplete: numberOr(record["percentComplete"]) ?? 0,
    currentWork: str(record["currentWork"]) ?? undefined,
    nextWork: str(record["nextWork"]) ?? undefined,
  };
}

function asItem(value: unknown): MspItem | null {
  const record = asRecord(value);
  if (!record || typeof record["itemId"] !== "string" || typeof record["kind"] !== "string") {
    return null;
  }
  return {
    ...record,
    status: typeof record["status"] === "string" ? record["status"] : "completed",
    revision: typeof record["revision"] === "number" ? record["revision"] : 1,
  } as MspItem;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "allowAll" || value === "denyUnmatched" || value === "onRequest" || value === "promptUnmatched";
}

/** Mutable working copy used inside one batch; collections are copied once, on first write. */
/** Which of the fold's maps a batch of events can write to, so the rest are shared rather than copied. */
interface Touched {
  items: boolean;
  turns: boolean;
  approvals: boolean;
  userInputs: boolean;
}

/** What each event method writes to. An unknown method copies nothing, because it changes nothing here either. */
function touchedBy(events: readonly ViewEvent[]): Touched {
  const touches: Touched = { items: false, turns: false, approvals: false, userInputs: false };
  for (const event of events) {
    const method = event.method;
    if (method.startsWith("item/")) {
      touches.items = true;
      // A delta's characters count towards its turn's streaming speed.
      touches.turns = true;
    } else if (method.startsWith("turn/")) {
      touches.turns = true;
      // A retracted prompt is marked on the item as well as the turn.
      touches.items = true;
    } else if (method.startsWith("approval/")) {
      touches.approvals = true;
    } else if (method.startsWith("userInput/")) {
      touches.userInputs = true;
    }
  }
  return touches;
}

class Draft {
  fold: ThreadFold;
  private orderCopied = false;
  private echoesCopied = false;
  private callsCopied = false;
  private agentsCopied = false;

  /**
   * Only the maps this batch can write to are copied. A long thread holds tens of thousands of items, and copying
   * every map for every batch made applying a stream cost time in the square of the thread's length: a thread with
   * subagents in it, which produce far more items than anything else, would slow to a stop and never recover.
   *
   * `saved` marks a partial history page folded onto what is on screen: it can lag what the thread already shows.
   */
  constructor(base: ThreadFold, touches: Touched, readonly saved = false) {
    this.fold = {
      ...base,
      ...(touches.items ? { items: { ...base.items } } : {}),
      ...(touches.turns ? { turns: { ...base.turns } } : {}),
      ...(touches.approvals ? { approvals: { ...base.approvals }, resolved: { ...base.resolved } } : {}),
      ...(touches.userInputs ? { userInputs: { ...base.userInputs }, settled: { ...base.settled } } : {}),
      // Small, and nearly every event reads or writes something in it.
      meta: { ...base.meta },
    };
  }

  pushOrder(id: string): void {
    if (!this.orderCopied) {
      this.fold.order = [...this.fold.order];
      this.orderCopied = true;
    }
    this.fold.order.push(id);
  }

  removeEcho(index: number): void {
    if (!this.echoesCopied) {
      this.fold.echoes = [...this.fold.echoes];
      this.echoesCopied = true;
    }
    this.fold.echoes.splice(index, 1);
  }

  patchEcho(index: number, patch: Partial<LocalEcho>): void {
    if (!this.echoesCopied) {
      this.fold.echoes = [...this.fold.echoes];
      this.echoesCopied = true;
    }
    this.fold.echoes[index] = { ...(this.fold.echoes[index] as LocalEcho), ...patch };
  }

  claimForEchoes(item: MspItem): void {
    const echoes = claimedBy(this.fold.echoes, item);
    if (echoes !== this.fold.echoes) {
      this.fold.echoes = echoes;
      this.echoesCopied = true;
    }
  }

  putCall(key: string, call: CallUsage): void {
    if (!this.callsCopied) {
      this.fold.meta.calls = { ...this.fold.meta.calls };
      this.callsCopied = true;
    }
    this.fold.meta.calls[key] = call;
  }

  putAgentItem(item: MspItem): void {
    if (item.kind !== "workflow" && item.kind !== "subagent") return;
    if (!this.agentsCopied) {
      this.fold.agentItems = { ...(this.fold.agentItems ?? Object.fromEntries(
        Object.entries(this.fold.items).filter(([, entry]) => entry.kind === "workflow" || entry.kind === "subagent"),
      )) };
      this.agentsCopied = true;
    }
    this.fold.agentItems![item.itemId] = item;
  }
}

function upsertItem(draft: Draft, incoming: MspItem): void {
  const d = draft.fold;
  // Subagent children are never rendered, and a plan that runs subagents produces far more of them than of anything
  // else. Keeping them would grow the fold without ever showing a line of it, and every later event pays for that.
  if (HIDDEN_KINDS.has(incoming.kind)) {
    return;
  }
  const current = d.items[incoming.itemId];
  if (!current) {
    d.items[incoming.itemId] = incoming;
    draft.putAgentItem(incoming);
    draft.pushOrder(incoming.itemId);
    if (incoming.kind === "userMessage") {
      matchEcho(draft, incoming);
    }
    return;
  }
  const currentDone = current.status !== "inProgress";
  const incomingDone = incoming.status !== "inProgress";
  // An item never reopens once it has finished. A saved page's numbering can run apart from the live one's, so there
  // the status decides first: a finished record beats an open one, and an open record never replaces a finished one.
  const newer = draft.saved && incomingDone !== currentDone
    ? incomingDone
    : incoming.revision > current.revision ||
      current.revision === 0 ||
      (incoming.revision === current.revision && incomingDone && !currentDone);
  if (!newer) {
    return;
  }
  const next: MspItem = { ...incoming };
  // Muse supplies a workflow child's assignment at scheduling, then omits it from
  // status-only revisions. Retain the label without carrying stale phase/outcome data.
  if (incoming.kind === "workflow" && incoming.children && current.children) {
    const labels = new Map(current.children.map((child) => [`${child.childId}:${child.attempt}`, child.label]));
    next.children = incoming.children.map((child) => {
      const label = child.label ?? labels.get(`${child.childId}:${child.attempt}`);
      return label && !child.label ? { ...child, label } : child;
    });
  }
  // A final that arrives empty keeps what already streamed in.
  if (!next.text && current.text) {
    next.text = current.text;
  }
  if (!next.visibleOutput && current.visibleOutput) {
    next.visibleOutput = current.visibleOutput;
  }
  if ((!next.summary || next.summary.length === 0) && current.summary && current.summary.length > 0) {
    next.summary = current.summary;
  }
  if (next.turnId === undefined && current.turnId !== undefined) {
    next.turnId = current.turnId;
  }
  d.items[incoming.itemId] = next;
  draft.putAgentItem(next);
  // A later revision can bring the shown text (`displayText`) the first one lacked, so match again.
  if (next.kind === "userMessage") {
    matchEcho(draft, next);
  }
}

/** What the server appends to a prompt sent with files: `@<folder>/attachments/<file>` mentions and image markers. */
const ATTACHMENT_TAIL = /(?:\s*(?:@\S*?attachments\/\S+?|\[Image #\d+\]))+\s*$/;
const ATTACHMENT_MARK = /attachments\/|\[Image #\d+\]/;

/** Both forms of a prompt: what the transcript shows and what the model got; a local echo holds one of them. */
function promptTexts(item: MspItem): Set<string> {
  const texts = [item.displayText, item.text];
  // A saved prompt without its shown text is still the typed text followed by the files that went with it.
  if (!item.displayText && item.text && ATTACHMENT_MARK.test(item.text)) {
    texts.push(item.text.replace(ATTACHMENT_TAIL, ""));
  }
  return new Set(texts.filter((t): t is string => Boolean(t)).map((t) => normalizeText(t)).filter(Boolean));
}

function observeMeta(meta: ThreadMeta, field: MetaField, event: ViewEvent): void {
  meta.observed = { ...meta.observed, [field]: { cursor: str(event.params["viewCursor"]), at: event.at } };
}

/** Only the observed v:<session>:<sequence> cursor form has a comparable order. */
function newerObservation(event: ViewEvent, previous: MetaObservation): boolean {
  const before = previous.cursor?.match(/^(v:.+):(\d+)$/);
  const after = str(event.params["viewCursor"])?.match(/^(v:.+):(\d+)$/);
  if (before && after && before[1] === after[1]) return BigInt(after[2]!) > BigInt(before[2]!);
  if (previous.cursor && previous.cursor === event.params["viewCursor"]) return false;
  return event.at !== undefined && previous.at !== undefined && event.at > previous.at;
}

/** Attachments and expanded commands can change the saved body without changing the send. */
function echoMatchesPrompt(echo: LocalEcho, item: MspItem): boolean {
  if (item.kind !== "userMessage") return false;
  if (echo.turnId !== null) {
    if (echo.turnId !== item.turnId && echo.turnId !== item.commandId) return false;
    // A normal/queued send owns its turn. A steer shares the ongoing turn with the
    // original prompt, so its text must match an actual steered item as well.
    if (echo.disposition !== "steered") return item.steered !== true;
    return item.steered === true && textMatches(echo, item);
  }
  return textMatches(echo, item);
}

/** Text cannot tell two identical sends apart, so it never matches an item the echo already ruled out. */
function textMatches(echo: LocalEcho, item: MspItem): boolean {
  return !echo.excluded?.includes(item.itemId) && promptTexts(item).has(normalizeText(echo.text));
}

/** Echoes matched by text rather than by a turn of their own. */
function matchedByText(echo: LocalEcho): boolean {
  return echo.turnId === null || echo.disposition === "steered";
}

/**
 * The item now stands for one send, so an identical send still in flight is never matched to it as well: not by a
 * later revision of it, and not when that send's own acknowledgement comes back before its own item does.
 */
function claimedBy(echoes: LocalEcho[], item: MspItem): LocalEcho[] {
  let result = echoes;
  echoes.forEach((echo, index) => {
    if (!matchedByText(echo) || !echoMatchesPrompt(echo, item)) return;
    if (result === echoes) result = [...echoes];
    result[index] = { ...echo, excluded: [...(echo.excluded ?? []), item.itemId] };
  });
  return result;
}

function matchEcho(draft: Draft, item: MspItem): void {
  const echoes = draft.fold.echoes;
  if (echoes.length === 0) {
    return;
  }
  let index = echoes.findIndex((e) => e.turnId !== null && echoMatchesPrompt(e, item));
  if (index < 0) {
    // An acknowledged repeat belongs to its own turn, even when an old item is revised.
    index = echoes.findIndex((e) => e.turnId === null && echoMatchesPrompt(e, item));
  }
  if (index >= 0) {
    draft.removeEcho(index);
    draft.claimForEchoes(item);
  }
}

function appendDelta(draft: Draft, params: Record<string, unknown>): void {
  const d = draft.fold;
  const id = str(params["itemId"]);
  const delta = typeof params["delta"] === "string" ? params["delta"] : "";
  if (!id || !delta) {
    return;
  }
  const field = str(params["field"]) ?? "text";
  let item = d.items[id];
  if (!item) {
    item = {
      itemId: id,
      kind: field === "output" ? "toolCall" : field.startsWith("summary") ? "reasoning" : "agentMessage",
      status: "inProgress",
      revision: 0,
    };
    draft.pushOrder(id);
  } else if (item.status !== "inProgress") {
    // The authoritative final already landed; a late delta would duplicate text.
    return;
  }
  const next: MspItem = { ...item };
  if (field === "text") {
    next.text = (next.text ?? "") + delta;
  } else if (field === "output") {
    next.visibleOutput = (next.visibleOutput ?? "") + delta;
  } else if (field.startsWith("summary.")) {
    const index = Number(field.slice("summary.".length));
    if (Number.isInteger(index) && index >= 0) {
      const summary = [...(next.summary ?? [])];
      while (summary.length < index) {
        summary.push("");
      }
      summary[index] = (summary[index] ?? "") + delta;
      next.summary = summary;
    }
  } else {
    const previous = next[field];
    next[field] = (typeof previous === "string" ? previous : "") + delta;
  }
  d.items[id] = next;
}

/** A pause longer than this between text chunks means a new model call, so its speed is measured afresh. */
const STREAM_GAP_MS = 2000;

/** Counts streamed model text (replies and reasoning, not tool output) per turn, in bursts. */
function trackStream(draft: Draft, params: Record<string, unknown>, at: number | undefined): void {
  const field = str(params["field"]) ?? "text";
  const delta = typeof params["delta"] === "string" ? params["delta"] : "";
  if (at === undefined || !delta || field === "output") {
    return;
  }
  const d = draft.fold;
  const itemId = str(params["itemId"]);
  const turnId = str(params["turnId"]) ?? (itemId ? (d.items[itemId]?.turnId ?? null) : null);
  if (!turnId) {
    return;
  }
  const turn = d.turns[turnId] ?? { turnId };
  const previous = turn.stream && at - turn.stream.lastAt <= STREAM_GAP_MS ? turn.stream : { chars: 0, startAt: at, lastAt: at };
  d.turns[turnId] = { ...turn, stream: { chars: previous.chars + delta.length, startAt: previous.startAt, lastAt: at } };
}

function applyOne(draft: Draft, event: ViewEvent): void {
  const d = draft.fold;
  const params = event.params;
  switch (event.method) {
    case "item/started":
    case "item/updated":
    case "item/completed": {
      const item = asItem(params["item"]);
      if (item) {
        upsertItem(draft, item);
      }
      break;
    }
    case "item/delta":
      appendDelta(draft, params);
      trackStream(draft, params, event.at);
      break;
    case "turn/started": {
      const turnId = str(params["turnId"]);
      if (!turnId) {
        break;
      }
      const previous = d.turns[turnId];
      d.turns[turnId] = { ...previous, turnId, startedAt: previous?.startedAt ?? event.at };
      if (!previous?.terminal) {
        d.activeTurnId = turnId;
      }
      d.closed = false;
      const echo = d.echoes.findIndex((e) => e.turnId === turnId && e.disposition === "queued");
      if (echo >= 0) {
        draft.patchEcho(echo, { disposition: "started" });
      }
      break;
    }
    case "turn/completed": {
      const turnId = str(params["turnId"]);
      if (!turnId) {
        break;
      }
      const error = asRecord(params["error"]);
      const ended: TurnInfo = {
        ...d.turns[turnId],
        turnId,
        terminal: str(params["terminal"]) ?? "completed",
        durationMs: numberOr(params["durationMs"]) ?? d.turns[turnId]?.durationMs,
        firstTokenMs: numberOr(params["timeToFirstTokenMs"]) ?? d.turns[turnId]?.firstTokenMs,
        completedAt: event.at ?? d.turns[turnId]?.completedAt,
        error: error
          ? {
              kind: str(error["kind"]) ?? "error",
              message: str(error["message"]) ?? "The turn failed.",
              retryable: error["retryable"] === true,
            }
          : undefined,
        retry: undefined,
      };
      // A live or authoritative outcome is final; one read from a partial page stays open to correction.
      if (draft.saved) {
        ended.provisional = true;
      } else {
        delete ended.provisional;
      }
      d.turns[turnId] = ended;
      if (d.activeTurnId === turnId) {
        d.activeTurnId = null;
      }
      // The turn is over, so its local copy has done its job: the prompt is either in the transcript or it
      // never will be. Keeping it would leave a bubble stuck on "Sending" for the rest of the thread.
      for (let echo = d.echoes.length - 1; echo >= 0; echo--) {
        if (d.echoes[echo]?.turnId === turnId) draft.removeEcho(echo);
      }
      break;
    }
    case "turn/retryScheduled": {
      const turnId = str(params["turnId"]);
      if (turnId) {
        d.turns[turnId] = {
          ...d.turns[turnId],
          turnId,
          retry: {
            attempt: numberOr(params["attempt"]) ?? 1,
            maxAttempts: numberOr(params["maxAttempts"]) ?? 1,
            nextAttempt: numberOr(params["nextAttempt"]) ?? 2,
            reason: str(params["reason"]) ?? "",
            retryDelayMs: numberOr(params["retryDelayMs"]) ?? 0,
          },
        };
      }
      break;
    }
    case "turn/retracted": {
      const turnId = str(params["turnId"]);
      if (turnId) {
        d.turns[turnId] = { ...d.turns[turnId], turnId, retracted: true };
      }
      break;
    }
    case "turn/unqueued": {
      const turnId = str(params["turnId"]);
      if (turnId) {
        d.turns[turnId] = { ...d.turns[turnId], turnId, terminal: "unqueued" };
        const echo = d.echoes.findIndex((e) => e.turnId === turnId);
        if (echo >= 0) {
          draft.removeEcho(echo);
        }
      }
      break;
    }
    case "approval/requested":
    case "approval/updated": {
      const id = str(params["approvalId"]);
      if (id && !d.resolved[id]) {
        d.approvals[id] = { ...d.approvals[id], ...(params as unknown as ApprovalRequest) };
      }
      break;
    }
    case "approval/resolved": {
      const id = str(params["approvalId"]);
      if (id) {
        delete d.approvals[id];
        d.resolved[id] = {
          decision: str(params["decision"]) ?? "resolved",
          resolvedBy: str(params["resolvedBy"]) ?? "user",
        };
      }
      break;
    }
    case "userInput/requested": {
      const id = str(params["userInputId"]);
      if (id && !d.settled[id]) {
        d.userInputs[id] = params as unknown as UserInputRequest;
      }
      break;
    }
    case "userInput/settled": {
      const id = str(params["userInputId"]);
      if (id) {
        delete d.userInputs[id];
        d.settled[id] = {
          outcome: str(params["outcome"]) ?? "answered",
          answers: Array.isArray(params["answers"]) ? (params["answers"] as UserInputAnswer[]) : [],
        };
      }
      break;
    }
    case "session/todoListChanged":
      d.meta.todoList = Array.isArray(params["items"]) ? (params["items"] as TodoItem[]) : [];
      observeMeta(d.meta, "todoList", event);
      break;
    case "session/branchChanged":
      d.meta.branch = str(params["branch"]);
      observeMeta(d.meta, "branch", event);
      break;
    case "session/contextUsage":
      d.meta.contextUsage = {
        usedTokens: numberOr(params["usedTokens"]) ?? 0,
        windowTokens: numberOr(params["windowTokens"]),
        pressure: str(params["pressure"]) ?? "normal",
      };
      observeMeta(d.meta, "contextUsage", event);
      break;
    case "session/tokenUsage": {
      const cumulative = asRecord(params["cumulative"]);
      if (cumulative) {
        d.meta.tokenTotals = {
          promptTokens: numberOr(cumulative["promptTokens"]) ?? 0,
          outputTokens: numberOr(cumulative["outputTokens"]) ?? 0,
          totalTokens: numberOr(cumulative["totalTokens"]) ?? 0,
        };
      }
      const usage = asRecord(params["usage"]) ?? {};
      const promptTokens = numberOr(params["promptTokens"]) ?? numberOr(usage["inputTokens"]) ?? 0;
      const key = str(params["viewCursor"]) ?? `${str(params["turnId"]) ?? "turn"}:${Object.keys(d.meta.calls).length}`;
      draft.putCall(key, {
        turnId: str(params["turnId"]),
        modelId: str(params["modelId"]),
        promptTokens,
        outputTokens: numberOr(usage["outputTokens"]) ?? Math.max(0, (numberOr(params["totalTokens"]) ?? 0) - promptTokens),
        inputTokens: numberOr(usage["inputTokens"]) ?? 0,
        cachedTokens: numberOr(usage["cachedTokens"]) ?? 0,
        cacheReadTokens: numberOr(usage["cacheReadTokens"]) ?? 0,
        cacheWriteTokens: numberOr(usage["cacheWriteTokens"]) ?? 0,
        reasoningTokens: numberOr(usage["reasoningTokens"]) ?? 0,
        durationMs: numberOr(params["durationMs"]) ?? null,
      });
      break;
    }
    case "session/modelChanged":
      d.meta.modelId = str(params["modelId"]) ?? d.meta.modelId;
      if (str(params["modelId"])) observeMeta(d.meta, "modelId", event);
      break;
    case "session/approvalModeChanged":
      if (isApprovalMode(params["mode"])) {
        d.meta.approvalMode = params["mode"];
        observeMeta(d.meta, "approvalMode", event);
      }
      break;
    case "session/goalChanged": {
      const raw = params["goal"];
      const next = asGoal(raw);
      // A block that is there but is not a goal (no objective) changes nothing; only null clears.
      if (raw !== null && raw !== undefined && !next) {
        break;
      }
      const prev = d.meta.goal;
      const same = next !== null && prev !== null && next.objective === prev.objective;
      // A new objective restarts the live clock; the goal record's own start time wins when there is one.
      if (!same) {
        d.meta.goalSince = next ? (event.at ?? null) : null;
        d.meta.goalPauses = [];
      }
      // A pause or finish stops the goal's clock at this moment; history carries no time, so it stays unknown there.
      if (!same || next?.status !== prev?.status) {
        d.meta.goalStatusAt = next ? (event.at ?? null) : null;
      }
      // Time paused or blocked is not running time: a live change marks where each pause began and ended.
      if (same && next && prev && event.at !== undefined && next.status !== prev.status) {
        const pauses = d.meta.goalPauses;
        const open = pauses[pauses.length - 1];
        if (prev.status === "active") {
          d.meta.goalPauses = [...pauses, { from: event.at, to: null }];
        } else if (next.status === "active" && open && open.to === null) {
          d.meta.goalPauses = [...pauses.slice(0, -1), { from: open.from, to: event.at }];
        }
      }
      d.meta.goal = next;
      d.meta.goalSeen = true;
      observeMeta(d.meta, "goal", event);
      break;
    }
    case "session/started": {
      const session = asRecord(params["session"]);
      if (session) {
        d.meta.modelId = str(session["modelId"]) ?? d.meta.modelId;
        if (str(session["modelId"])) observeMeta(d.meta, "modelId", event);
        const mode = asRecord(session["approvalMode"])?.["mode"];
        if (isApprovalMode(mode)) {
          d.meta.approvalMode = mode;
          observeMeta(d.meta, "approvalMode", event);
        }
      }
      d.closed = false;
      break;
    }
    case "session/closed":
      d.closed = true;
      d.activeTurnId = null;
      break;
    default:
      break;
  }
}

/** Apply a batch of view events. Returns the input fold untouched when the batch is empty. */
export function applyEvents(fold: ThreadFold, events: readonly ViewEvent[]): ThreadFold {
  return applyBatch(fold, events, false);
}

function applyBatch(fold: ThreadFold, events: readonly ViewEvent[], saved: boolean): ThreadFold {
  if (events.length === 0) {
    return fold;
  }
  const draft = new Draft(fold, touchedBy(events), saved);
  for (const event of events) {
    applyOne(draft, event);
  }
  return draft.fold;
}

export function applyEvent(fold: ThreadFold, event: ViewEvent): ThreadFold {
  return applyEvents(fold, [event]);
}

/**
 * The local echoes worth keeping across a reload. History is replayed onto an empty fold, so nothing
 * in it clears an echo the way the live stream would, and an echo whose prompt the history already
 * holds used to render alongside it (#55). Only echoes the server acknowledged with a turn id are
 * matched: an unacknowledged one could otherwise pair with an older prompt that shares its text, the
 * way a second "continue" would, and vanish while still in flight.
 */
function carriedEchoes(fold: ThreadFold, echoes: readonly LocalEcho[]): LocalEcho[] {
  let kept: LocalEcho[] = [];
  const claimed: MspItem[] = [];
  for (const echo of echoes) {
    const turnId = echo.turnId;
    if (!turnId) {
      kept.push(echo);
      continue;
    }
    if (fold.turns[turnId]?.terminal) {
      continue;
    }
    const landed = landedItem(fold, echo, claimed);
    if (landed) {
      claimed.push(landed);
      continue;
    }
    kept.push(started(fold, echo));
  }
  for (const item of claimed) {
    kept = claimedBy(kept, item);
  }
  return kept;
}

/** The prompt item an acknowledged echo stands for, if it is in the thread and no other send already owns it. */
function landedItem(fold: ThreadFold, echo: LocalEcho, claimed: readonly MspItem[] = []): MspItem | undefined {
  for (const id of fold.order) {
    const item = fold.items[id];
    if (item !== undefined && echoMatchesPrompt(echo, item) && !claimed.includes(item)) {
      return item;
    }
  }
  return undefined;
}

/**
 * A queued prompt whose turn is under way is running now, as the live stream would have said: its turn is in the
 * fold, or the session reports it active even though the page read with it stops short of its start.
 */
function started(fold: ThreadFold, echo: LocalEcho): LocalEcho {
  const running = echo.turnId !== null && (fold.turns[echo.turnId] !== undefined || fold.activeTurnId === echo.turnId);
  return echo.disposition === "queued" && running ? { ...echo, disposition: "started" } : echo;
}

/** A capped history page can omit the scheduling revision that gave a child its label. */
function carriedWorkflowLabels(fold: ThreadFold, previous: ThreadFold | null | undefined): ThreadFold {
  if (!previous) return fold;
  let result = fold;
  for (const item of Object.values(fold.agentItems ?? fold.items)) {
    if (item.kind !== "workflow" || !item.children?.length) continue;
    const old = previous.items[item.itemId];
    if (old?.kind !== "workflow" || !old.children?.length) continue;
    const labels = new Map(old.children.map((child) => [`${child.childId}:${child.attempt}`, child.label]));
    let changed = false;
    const children = item.children.map((child) => {
      if (child.label?.trim()) return child;
      const label = labels.get(`${child.childId}:${child.attempt}`);
      if (!label?.trim()) return child;
      changed = true;
      return { ...child, label };
    });
    if (!changed) continue;
    if (result === fold) {
      result = { ...fold, items: { ...fold.items }, ...(fold.agentItems ? { agentItems: { ...fold.agentItems } } : {}) };
    }
    const next = { ...item, children };
    result.items[item.itemId] = next;
    if (result.agentItems) result.agentItems[item.itemId] = next;
  }
  return result;
}

/**
 * Muse's history projection writes `failed`/`incomplete` for any run it cannot see the end of, including one that is
 * still running or that finished while the projection was stalled. That record says nothing about how the turn went.
 */
function incompleteRecord(event: ViewEvent): boolean {
  const error = asRecord(event.params["error"]);
  return event.method === "turn/completed" && event.params["terminal"] === "failed" &&
    (event.params["reason"] === "incomplete" || error?.["kind"] === "incomplete");
}

/** A partial projection can contain old terminal and metadata records alongside genuinely newer work. */
function partialHistoryEvents(load: TranscriptLoad, previous: ThreadFold): ViewEvent[] {
  const fields: Record<string, MetaField> = {
    "session/todoListChanged": "todoList", "session/branchChanged": "branch",
    "session/contextUsage": "contextUsage", "session/modelChanged": "modelId",
    "session/approvalModeChanged": "approvalMode", "session/goalChanged": "goal",
  };
  return load.events.flatMap((event): ViewEvent[] => {
    const field = fields[event.method];
    if (field) {
      const observed = previous.meta.observed?.[field];
      if (observed) return newerObservation(event, observed) ? [event] : [];
      return (field === "goal" ? !previous.meta.goalSeen : previous.meta[field] === null) ? [event] : [];
    }
    const turnId = str(event.params["turnId"]);
    const turn = turnId ? previous.turns[turnId] : undefined;
    switch (event.method) {
      case "turn/started":
        return !turn?.terminal && turn?.startedAt === undefined ? [event] : [];
      case "turn/completed":
      case "turn/unqueued": {
        // A saved failure/incomplete is not authority to stop a session still reported running.
        if (!turnId || turnId === load.msp?.activeTurnId) return [];
        // A live or authoritative outcome stands; only a placeholder from an earlier partial read gives way.
        if (turn?.terminal && !(turn.provisional && turn.terminal === "unknown")) return [];
        if (!incompleteRecord(event)) return [event];
        // Without the session's word, the turn on screen may well still be running.
        if (turn?.terminal || (!load.msp && turnId === previous.activeTurnId)) return [];
        // The session says the turn is over, but not how. Record that much, and no failure.
        return [{ method: "turn/completed", params: { turnId, terminal: "unknown" } }];
      }
      case "turn/retryScheduled":
        return !turn?.terminal && (!turn || (turn.retry !== undefined &&
          (numberOr(event.params["nextAttempt"]) ?? 0) > turn.retry.nextAttempt)) ? [event] : [];
      case "turn/retracted":
        return [event];
      case "approval/resolved":
        return !previous.resolved[str(event.params["approvalId"]) ?? ""] ? [event] : [];
      case "userInput/settled":
        return !previous.settled[str(event.params["userInputId"]) ?? ""] ? [event] : [];
      default:
        // Items are merged separately; cumulative usage is monotonic below. An old session/started
        // or session/closed must not replace current settings or revive/stop the displayed turn.
        return [];
    }
  });
}

/**
 * Where the items a partial page adds belong. The page is Muse's own ordered record, so it is the backbone; an item
 * only the thread on screen holds goes just before the next item both know, or at the end when the page stops short
 * of it. Appending them instead put a backfilled step after its turn's final reply, and an older turn after newer ones.
 */
function mergedOrder(shown: readonly string[], page: readonly string[], all: readonly string[]): string[] {
  const inPage = new Set(page);
  const leading = new Map<string, string[]>();
  let run: string[] = [];
  for (const id of shown) {
    if (!inPage.has(id)) {
      run.push(id);
    } else if (run.length > 0) {
      leading.set(id, run);
      run = [];
    }
  }
  const present = new Set(all);
  const order: string[] = [];
  for (const id of page) {
    order.push(...(leading.get(id) ?? []));
    if (present.has(id)) order.push(id);
  }
  order.push(...run);
  return order.length === all.length ? order : [...all];
}

/**
 * The approvals and questions waiting after a load. The server's pending set is authoritative when it is complete.
 * When it is not (the list failed, another host owns the session, or live activity overtook the read), nothing that
 * was waiting is dropped on its word alone: what was on screen stays, the running turn's requests the history shows
 * open are added, and whatever the history shows answered is closed.
 */
function pendingRequests(
  load: TranscriptLoad,
  fold: ThreadFold,
  snapshot: ThreadFold,
  previous: ThreadFold | null | undefined,
  activeTurnId: string | null,
): { approvals: Record<string, ApprovalRequest>; userInputs: Record<string, UserInputRequest> } {
  const complete = load.pendingComplete !== false;
  const approvals: Record<string, ApprovalRequest> = complete ? {} : { ...previous?.approvals };
  const userInputs: Record<string, UserInputRequest> = complete ? {} : { ...previous?.userInputs };
  if (!complete && activeTurnId) {
    // A capped page can hold a request whose answer lies past its end, so only the running turn's count as open.
    const running = (request: { turnId?: string; itemId?: string }) =>
      (request.turnId ?? (request.itemId ? fold.items[request.itemId]?.turnId : undefined)) === activeTurnId;
    for (const request of Object.values(snapshot.approvals)) {
      if (running(request)) approvals[request.approvalId] ??= request;
    }
    for (const request of Object.values(snapshot.userInputs)) {
      if (running(request)) userInputs[request.userInputId] ??= request;
    }
  }
  for (const approval of load.pending.approvals) {
    approvals[approval.approvalId] = approval;
  }
  for (const input of load.pending.userInputs) {
    userInputs[input.userInputId] = input;
  }
  if (!complete) {
    for (const id of Object.keys(approvals)) {
      if (fold.resolved[id] || previous?.resolved[id]) delete approvals[id];
    }
    for (const id of Object.keys(userInputs)) {
      if (fold.settled[id] || previous?.settled[id]) delete userInputs[id];
    }
  }
  return { approvals, userInputs };
}

/** Build a fold from a resume response. */
export function foldFromLoad(load: TranscriptLoad, previous?: ThreadFold | null): ThreadFold {
  const partial = load.historyUnavailable || load.viewHealth?.status === "unavailable";
  const snapshot = applyEvents(emptyFold(), load.events);
  let fold = snapshot;
  if (partial && previous) {
    // Replaying old deltas onto a live item would duplicate its text. Fold the page independently
    // first, then admit only newer snapshots or a verified extension of the same streamed revision.
    const merged = partialHistoryEvents(load, previous);
    for (const id of snapshot.order) {
      const item = snapshot.items[id];
      const current = previous.items[id];
      merged.push({ method: "item/updated", params: { item } });
      if (!current || current.revision === 0 || item.revision !== current.revision || item.status !== "inProgress" || current.status !== "inProgress") continue;
      const fields: [string, string | undefined, string | undefined][] = [
        ["text", current.text, item.text], ["output", current.visibleOutput, item.visibleOutput],
        ...(item.summary ?? []).map((value, index): [string, string | undefined, string | undefined] => [`summary.${index}`, current.summary?.[index], value]),
      ];
      for (const [field, before = "", after = ""] of fields) {
        if (after.length > before.length && after.startsWith(before)) {
          merged.push({ method: "item/delta", params: { itemId: id, field, delta: after.slice(before.length), turnId: item.turnId } });
        }
      }
    }
    fold = applyBatch(previous, merged, true);
    const before = previous.meta.tokenTotals;
    const after = snapshot.meta.tokenTotals;
    fold = {
      ...fold,
      order: fold.order.length > previous.order.length ? mergedOrder(previous.order, snapshot.order, fold.order) : fold.order,
      activeTurnId: previous.activeTurnId && !fold.turns[previous.activeTurnId]?.terminal ? previous.activeTurnId : null,
      meta: {
        ...fold.meta,
        // Cursor-keyed calls can be backfilled independently of a stale cumulative reading.
        calls: { ...snapshot.meta.calls, ...previous.meta.calls },
        tokenTotals: before && after ? {
          promptTokens: Math.max(before.promptTokens, after.promptTokens),
          outputTokens: Math.max(before.outputTokens, after.outputTokens),
          totalTokens: Math.max(before.totalTokens, after.totalTokens),
        } : before ?? after,
        modelId: fold.meta.modelId ?? snapshot.meta.modelId,
        approvalMode: fold.meta.approvalMode ?? snapshot.meta.approvalMode,
      },
    };
  }
  fold = carriedWorkflowLabels(fold, previous);
  if (partial && previous) {
    // The page's own older revision can hold the labels a newer status-only one on screen lacks.
    fold = carriedWorkflowLabels(fold, snapshot);
  }
  const activeTurnId = load.msp ? load.msp.activeTurnId : fold.activeTurnId;
  const { approvals, userInputs } = pendingRequests(load, fold, snapshot, previous, activeTurnId);
  fold = {
    ...fold,
    approvals,
    userInputs,
    activeTurnId,
    echoes: carriedEchoes({ ...fold, activeTurnId }, previous?.echoes ?? []),
    meta: {
      ...fold.meta,
      // History pages carry no context readings; the session's own fill in until the next live one.
      contextUsage:
        fold.meta.contextUsage ?? (typeof load.msp?.contextUsage?.usedTokens === "number" ? load.msp.contextUsage : null),
      tokenTotals: fold.meta.tokenTotals ?? (typeof load.msp?.tokenUsage?.totalTokens === "number" ? load.msp.tokenUsage : null),
      modelId: fold.meta.modelId ?? load.msp?.modelId ?? load.session?.modelId ?? null,
      approvalMode: fold.meta.approvalMode ?? (isApprovalMode(load.msp?.approvalMode) ? load.msp.approvalMode : null),
    },
    closed: false,
  };
  return fold;
}

export function addEcho(fold: ThreadFold, echo: LocalEcho): ThreadFold {
  // A prompt already in the thread is an earlier send, however alike it reads.
  const text = normalizeText(echo.text);
  const earlier = text
    ? fold.order.filter((id) => {
        const item = fold.items[id];
        return item?.kind === "userMessage" && promptTexts(item).has(text);
      })
    : [];
  const added = earlier.length > 0 ? { ...echo, excluded: [...(echo.excluded ?? []), ...earlier] } : echo;
  return { ...fold, echoes: [...fold.echoes, added] };
}

export function updateEcho(fold: ThreadFold, localId: string, patch: Partial<LocalEcho>): ThreadFold {
  const index = fold.echoes.findIndex((e) => e.localId === localId);
  if (index < 0) {
    return fold;
  }
  let echo = { ...(fold.echoes[index] as LocalEcho), ...patch };
  // The item (or even the completed turn) may have reached the stream before its HTTP ack.
  if (echo.turnId) {
    if (fold.turns[echo.turnId]?.terminal) return removeEcho(fold, localId);
    const landed = landedItem(fold, echo);
    if (landed) {
      const rest = removeEcho(fold, localId);
      return { ...rest, echoes: claimedBy(rest.echoes, landed) };
    }
    echo = started(fold, echo);
  }
  const echoes = [...fold.echoes];
  echoes[index] = echo;
  return { ...fold, echoes };
}

export function removeEcho(fold: ThreadFold, localId: string): ThreadFold {
  const echoes = fold.echoes.filter((e) => e.localId !== localId);
  return echoes.length === fold.echoes.length ? fold : { ...fold, echoes };
}

/** One turn as the transcript renders it. */
export interface TurnView {
  key: string;
  turnId: string | null;
  prompt: MspItem | null;
  /** Everything between the prompt and the final reply, in stream order. */
  entries: MspItem[];
  /** The closing agent message of a finished turn, shown outside the work log. */
  final: MspItem | null;
  info: TurnInfo | null;
  running: boolean;
}

export function buildTurns(fold: ThreadFold): TurnView[] {
  const byKey = new Map<string, TurnView>();
  const views: TurnView[] = [];
  for (const id of fold.order) {
    const item = fold.items[id];
    if (!item || HIDDEN_KINDS.has(item.kind) || (item.kind === "userMessage" && item.retracted)) {
      continue;
    }
    const key = item.turnId ? `turn:${item.turnId}` : `item:${id}`;
    let view = byKey.get(key);
    if (!view) {
      view = {
        key,
        turnId: item.turnId ?? null,
        prompt: null,
        entries: [],
        final: null,
        info: item.turnId ? (fold.turns[item.turnId] ?? null) : null,
        running: item.turnId ? fold.activeTurnId === item.turnId : false,
      };
      byKey.set(key, view);
      views.push(view);
    }
    if (item.kind === "userMessage" && !item.steered && !view.prompt) {
      view.prompt = item;
    } else {
      view.entries.push(item);
    }
  }
  for (const view of views) {
    if (view.running) {
      continue;
    }
    const last = view.entries[view.entries.length - 1];
    if (last && last.kind === "agentMessage" && (last.text ?? "").trim().length > 0) {
      view.final = last;
      view.entries = view.entries.slice(0, -1);
    }
  }
  return views;
}

/** The pending approval or question that gates a given tool item, if any. */
export function gateFor(
  fold: ThreadFold,
  itemId: string,
): { kind: "approval"; request: ApprovalRequest } | { kind: "input"; request: UserInputRequest } | null {
  for (const request of Object.values(fold.approvals)) {
    if (request.itemId === itemId) {
      return { kind: "approval", request };
    }
  }
  for (const request of Object.values(fold.userInputs)) {
    if (request.itemId === itemId) {
      return { kind: "input", request };
    }
  }
  return null;
}
