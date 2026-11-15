import type {
  ApprovalMode, ApprovalRequest, ContextUsage, Goal, MspItem, TodoItem, TokenTotals, TokenUsage, TranscriptLoad, UserInputAnswer, UserInputRequest, ViewEvent, WorkflowChild,
} from "../types.js";

export interface TurnInfo {
  readonly turnId: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly terminal?: string;
  provisional?: boolean;
  readonly durationMs?: number;
  readonly firstTokenMs?: number;
  readonly stream?: { readonly chars: number; readonly startAt: number; readonly lastAt: number };
  readonly error?: { readonly kind: string; readonly message: string; readonly retryable: boolean };
  readonly dismissed?: boolean;
  readonly retry?: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly nextAttempt: number;
    readonly reason: string;
    readonly retryDelayMs: number;
  };
  readonly retracted?: boolean;
}

export interface EchoAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly kind: "image" | "file";
  readonly url: string | null;
}

export interface LocalEcho {
  readonly localId: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly disposition: "sending" | "started" | "queued" | "steered" | "unconfirmed";
  readonly createdAt: number;
  readonly attachments?: EchoAttachment[];
  readonly excluded?: string[];
}

export interface CallUsage {
  readonly turnId: string | null;
  readonly modelId: string | null;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly durationMs: number | null;
}

type MetaField = "todoList" | "branch" | "contextUsage" | "modelId" | "approvalMode" | "goal";

interface MetaObservation {
  readonly cursor: string | null;
  readonly at: number | undefined;
}

export interface ThreadMeta {
  observed?: Partial<Record<MetaField, MetaObservation>>;
  todoList: TodoItem[] | null; todoTurnId?: string | null;
  branch: string | null; contextUsage: ContextUsage | null;
  tokenTotals: TokenTotals | null; calls: Record<string, CallUsage>;
  modelId: string | null; approvalMode: ApprovalMode | null;
  goal: Goal | null; goalSeen: boolean;
  goalSince: number | null; goalStatusAt: number | null;
  goalPauses: { from: number; to: number | null }[];
}

export interface ChildTrace {
  readonly scheduledAt?: number;
  readonly startedAt?: number;
  readonly usageAt?: number;
  readonly completedAt?: number;
  readonly terminalAt?: number;
  readonly lastEventAt: number | null;
  readonly usage?: TokenUsage;
  readonly label?: string;
  readonly terminal?: string;
  readonly durationMs?: number;
  readonly approx: boolean;
}

export interface RunTrace {
  readonly startedAt: number | null;
  readonly approx: boolean;
  readonly endedAt: number | null;
  readonly children: Record<string, ChildTrace>;
  readonly eventMinutes: number[];
}

export interface RequestTrace {
  readonly kind: "approval" | "input";
  readonly itemId: string | null;
  readonly askedAt: number | null;
  readonly decidedAt: number | null;
}

export interface TaskTrace {
  readonly firstSeenAt: number | null;
  readonly approx: boolean;
  readonly lastOutputAt: number | null;
  readonly endedAt: number | null;
}

export interface CrewTrace {
  readonly runs: Record<string, RunTrace>;
  readonly requests: Record<string, RequestTrace>;
  readonly tasks: Record<string, TaskTrace>;
}

export interface ThreadFold {
  items: Record<string, MspItem>; agentItems?: Record<string, MspItem>;
  order: string[]; turns: Record<string, TurnInfo>;
  activeTurnId: string | null; approvals: Record<string, ApprovalRequest>;
  userInputs: Record<string, UserInputRequest>;
  resolved: Record<string, { decision: string; resolvedBy: string }>;
  settled: Record<string, { outcome: string; answers: UserInputAnswer[] }>;
  echoes: LocalEcho[]; meta: ThreadMeta;
  closed: boolean; crew: CrewTrace;
}

export const HIDDEN_KINDS: ReadonlySet<string> = new Set(["reminderChild"]);

function isCrewItem(item: MspItem): boolean {
  return item.kind === "workflow" || item.kind === "subagent" || item.kind === "toolCall";
}

const EVENT_MINUTES_CAP = 600;
const REQUEST_TRACE_CAP = 500;

export function emptyCrew(): CrewTrace {
  return { runs: Object.create(null), requests: Object.create(null), tasks: Object.create(null) };
}

export function uuidTime(id: string): number | null {
  const isV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  if (!isV7) return null;
  const rawHex = id.slice(0, 8) + id.slice(9, 13);
  const parsedMs = parseInt(rawHex, 16);
  const earliestEpoch = Date.UTC(2020, 0, 1);
  const latestEpoch = Date.UTC(2100, 0, 1);
  return parsedMs > earliestEpoch && parsedMs < latestEpoch ? parsedMs : null;
}

export function emptyFold(): ThreadFold {
  return {
    items: {}, agentItems: {}, order: [], turns: {}, activeTurnId: null,
    approvals: {}, userInputs: {}, resolved: {}, settled: {}, echoes: [],
    closed: false, crew: emptyCrew(),
    meta: {
      todoList: null, branch: null, contextUsage: null, tokenTotals: null,
      calls: {}, modelId: null, approvalMode: null, goal: null,
      goalSeen: false, goalSince: null, goalStatusAt: null, goalPauses: [],
    },
  };
}

function parseRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function parseString(val: unknown): string | null {
  return typeof val === "string" && val.length > 0 ? val : null;
}

function parseFiniteNumber(val: unknown): number | undefined {
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function parseGoal(val: unknown): Goal | null {
  const dict = parseRecord(val);
  const objectiveText = dict ? parseString(dict["objective"]) : null;
  if (!dict || !objectiveText) return null;
  return {
    objective: objectiveText,
    status: parseString(dict["status"]) ?? "active",
    percentComplete: parseFiniteNumber(dict["percentComplete"]) ?? 0,
    currentWork: parseString(dict["currentWork"]) ?? undefined,
    nextWork: parseString(dict["nextWork"]) ?? undefined,
  };
}

function parseItem(val: unknown): MspItem | null {
  const dict = parseRecord(val);
  if (!dict || typeof dict["itemId"] !== "string" || typeof dict["kind"] !== "string") {
    return null;
  }
  return {
    ...dict,
    status: typeof dict["status"] === "string" ? dict["status"] : "completed",
    revision: typeof dict["revision"] === "number" ? dict["revision"] : 1,
  } as MspItem;
}

function cleanWhitespace(txt: string): string {
  return txt.replace(/\s+/g, " ").trim();
}

function isValidApprovalMode(val: unknown): val is ApprovalMode {
  return val === "allowAll" || val === "denyUnmatched" || val === "onRequest" || val === "promptUnmatched";
}

interface Touched {
  readonly items: boolean;
  readonly turns: boolean;
  readonly approvals: boolean;
  readonly userInputs: boolean;
}

function inspectEventTouch(events: readonly ViewEvent[]): Touched {
  let touchItems = false;
  let touchTurns = false;
  let touchApprovals = false;
  let touchInputs = false;
  for (const ev of events) {
    const m = ev.method;
    if (m.startsWith("item/")) {
      touchItems = true;
      touchTurns = true;
    } else if (m.startsWith("turn/")) {
      touchTurns = true;
      touchItems = true;
    } else if (m.startsWith("approval/")) {
      touchApprovals = true;
    } else if (m.startsWith("userInput/")) {
      touchInputs = true;
    }
  }
  return { items: touchItems, turns: touchTurns, approvals: touchApprovals, userInputs: touchInputs };
}

class Draft {
  fold: ThreadFold;
  private copiedOrder = false;
  private copiedEchoes = false;
  private copiedCalls = false;
  private copiedAgents = false;
  private copiedCrew = false;
  private readonly copiedRunIds = new Set<string>();

  constructor(base: ThreadFold, touches: Touched, readonly saved = false) {
    this.fold = {
      ...base,
      items: touches.items ? { ...base.items } : base.items,
      turns: touches.turns ? { ...base.turns } : base.turns,
      approvals: touches.approvals ? { ...base.approvals } : base.approvals,
      resolved: touches.approvals ? { ...base.resolved } : base.resolved,
      userInputs: touches.userInputs ? { ...base.userInputs } : base.userInputs,
      settled: touches.userInputs ? { ...base.settled } : base.settled,
      meta: { ...base.meta },
    };
  }

  pushOrder(id: string): void {
    if (!this.copiedOrder) {
      (this.fold as any).order = this.fold.order.concat(id);
      this.copiedOrder = true;
    } else {
      (this.fold as any).order.push(id);
    }
  }

  removeEcho(idx: number): void {
    if (!this.copiedEchoes) {
      (this.fold as any).echoes = this.fold.echoes.filter((_, i) => i !== idx);
      this.copiedEchoes = true;
    } else {
      (this.fold as any).echoes.splice(idx, 1);
    }
  }

  patchEcho(idx: number, patch: Partial<LocalEcho>): void {
    if (!this.copiedEchoes) {
      (this.fold as any).echoes = this.fold.echoes.map((e, i) => (i === idx ? { ...e, ...patch } : e));
      this.copiedEchoes = true;
    } else {
      (this.fold as any).echoes[idx] = { ...(this.fold.echoes[idx] as LocalEcho), ...patch };
    }
  }

  claimForEchoes(item: MspItem): void {
    const updated = claimedBy(this.fold.echoes, item);
    if (updated !== this.fold.echoes) {
      (this.fold as any).echoes = updated;
      this.copiedEchoes = true;
    }
  }

  putCall(callKey: string, callData: CallUsage): void {
    if (!this.copiedCalls) {
      (this.fold.meta as any).calls = Object.assign({}, this.fold.meta.calls, { [callKey]: callData });
      this.copiedCalls = true;
    } else {
      (this.fold.meta as any).calls[callKey] = callData;
    }
  }

  putAgentItem(item: MspItem): void {
    const relevant = isCrewItem(item);
    if (!relevant && !this.fold.agentItems?.[item.itemId]) return;
    if (!this.copiedAgents) {
      (this.fold as any).agentItems = Object.assign(
        {},
        this.fold.agentItems ?? Object.fromEntries(Object.entries(this.fold.items).filter(([, e]) => isCrewItem(e))),
      );
      this.copiedAgents = true;
    }
    if (relevant) {
      (this.fold.agentItems as any)![item.itemId] = item;
    } else {
      delete (this.fold.agentItems as any)![item.itemId];
    }
  }

  crew(): CrewTrace {
    if (!this.copiedCrew) {
      const base = this.fold.crew ?? emptyCrew();
      (this.fold as any).crew = {
        runs: Object.assign({}, base.runs),
        requests: Object.assign({}, base.requests),
        tasks: Object.assign({}, base.tasks),
      };
      this.copiedCrew = true;
    }
    return this.fold.crew;
  }

  runTrace(itemId: string): RunTrace {
    const crewObj = this.crew();
    const curr = crewObj.runs[itemId];
    if (curr && this.copiedRunIds.has(itemId)) return curr;
    const created: RunTrace = curr
      ? { ...curr, children: Object.assign({}, curr.children), eventMinutes: curr.eventMinutes.slice() }
      : { startedAt: null, approx: false, endedAt: null, children: Object.create(null), eventMinutes: [] };
    (crewObj.runs as any)[itemId] = created;
    this.copiedRunIds.add(itemId);
    return created;
  }
}

function buildChildKey(child: { childId: string; attempt: number }): string {
  return `${child.childId}:${child.attempt}`;
}

function resolveRevisionTimestamp(item: MspItem, eventAt: number | undefined): number | undefined {
  if (eventAt !== undefined) return eventAt;
  const parsed = item.recordedAt ? Date.parse(item.recordedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function traceWorkflow(draft: Draft, previous: MspItem | undefined, incoming: MspItem, eventAt: number | undefined): void {
  const ts = resolveRevisionTimestamp(incoming, eventAt);
  const childArray = Array.isArray(incoming.children) ? incoming.children : [];
  const prevMap = new Map<string, WorkflowChild>();
  for (const c of previous?.children ?? []) {
    prevMap.set(buildChildKey(c), c);
  }
  const existingRun = draft.fold.crew?.runs[incoming.itemId];
  const isTerminated = incoming.status !== "inProgress";
  const updatedChildren: WorkflowChild[] = [];

  for (const child of childArray) {
    const k = buildChildKey(child);
    const prev = prevMap.get(k);
    const trace = existingRun?.children[k];
    if (
      !trace || !prev ||
      prev.status !== child.status || prev.terminal !== child.terminal ||
      (child.usage !== undefined && trace.usage === undefined) ||
      (child.label !== undefined && trace.label === undefined) ||
      (child.durationMs !== undefined && trace.durationMs === undefined)
    ) {
      updatedChildren.push(child);
    }
  }

  if (
    existingRun && updatedChildren.length === 0 &&
    !(isTerminated && existingRun.endedAt === null) &&
    !(existingRun.startedAt === null && ts !== undefined)
  ) {
    return;
  }

  const runObj = draft.runTrace(incoming.itemId);
  if (!existingRun) {
    (runObj as any).startedAt = ts ?? null;
    (runObj as any).approx = incoming.revision > 1 || ts === undefined;
  } else if (runObj.startedAt === null && ts !== undefined) {
    (runObj as any).startedAt = ts;
    (runObj as any).approx = true;
  }

  if (isTerminated && runObj.endedAt === null) {
    (runObj as any).endedAt = ts ?? null;
  }

  for (const child of updatedChildren) {
    const k = buildChildKey(child);
    const existingTrace = runObj.children[k];
    const trace: ChildTrace = existingTrace
      ? { ...existingTrace }
      : { lastEventAt: null, approx: false };

    if (!existingTrace && child.status !== "scheduled") {
      const heuristicTime = child.attempt === 1 ? uuidTime(child.childId) : null;
      if (heuristicTime !== null && (ts === undefined || heuristicTime <= ts)) {
        (trace as any).scheduledAt = heuristicTime;
      }
      (trace as any).approx = true;
    }

    if (ts !== undefined) {
      if (child.status === "scheduled") (trace as any).scheduledAt ??= ts;
      else if (child.status === "usage") (trace as any).usageAt ??= ts;
      else if (child.status === "completed") (trace as any).completedAt ??= ts;
      else if (child.status !== "terminal") (trace as any).startedAt ??= ts;

      if (child.terminal) (trace as any).terminalAt ??= ts;
      (trace as any).lastEventAt = ts;
    }

    if (child.usage !== undefined) (trace as any).usage = child.usage;
    if (typeof child.label === "string" && child.label.trim()) (trace as any).label = child.label;
    if (typeof child.terminal === "string" && child.terminal) (trace as any).terminal = child.terminal;
    if (typeof child.durationMs === "number" && Number.isFinite(child.durationMs)) (trace as any).durationMs = child.durationMs;
    (runObj.children as any)[k] = trace;
  }

  if (updatedChildren.length > 0 && ts !== undefined) {
    runObj.eventMinutes.push(Math.floor(ts / 60_000));
    if (runObj.eventMinutes.length > EVENT_MINUTES_CAP) {
      runObj.eventMinutes.splice(0, runObj.eventMinutes.length - EVENT_MINUTES_CAP);
    }
  }
}

function traceTask(draft: Draft, incoming: MspItem, eventAt: number | undefined): void {
  const ts = resolveRevisionTimestamp(incoming, eventAt);
  const isRunning = incoming.status === "inProgress";
  const curr = draft.fold.crew?.tasks[incoming.itemId];

  if (!curr) {
    const fallbackTime = uuidTime(incoming.itemId);
    (draft.crew().tasks as any)[incoming.itemId] = {
      firstSeenAt: isRunning ? (ts ?? fallbackTime) : (fallbackTime ?? ts ?? null),
      approx: !isRunning || ts === undefined,
      lastOutputAt: null,
      endedAt: isRunning ? null : (ts ?? null),
    };
    return;
  }

  if (!isRunning && curr.endedAt === null) {
    (draft.crew().tasks as any)[incoming.itemId] = { ...curr, endedAt: ts ?? null };
  }
}

function traceRequest(draft: Draft, id: string, kind: RequestTrace["kind"], itemId: string | null, eventAt: number | undefined): void {
  if (draft.fold.crew?.requests?.[id]) return;
  const reqMap = draft.crew().requests;
  (reqMap as any)[id] = { kind, itemId, askedAt: eventAt ?? null, decidedAt: null };
  const keys = Object.keys(reqMap);
  const excess = keys.length - REQUEST_TRACE_CAP;
  for (let i = 0; i < excess; i += 1) {
    delete (reqMap as any)[keys[i]!];
  }
}

function traceDecision(draft: Draft, id: string, eventAt: number | undefined): void {
  const existing = draft.fold.crew?.requests[id];
  if (!existing || existing.decidedAt !== null || eventAt === undefined) return;
  (draft.crew().requests as any)[id] = { ...existing, decidedAt: eventAt };
}

function upsertItem(draft: Draft, incoming: MspItem, eventAt?: number): void {
  const foldRef = draft.fold;
  if (HIDDEN_KINDS.has(incoming.kind)) return;

  const existing = foldRef.items[incoming.itemId];
  if (!existing) {
    (foldRef.items as any)[incoming.itemId] = incoming;
    draft.putAgentItem(incoming);
    draft.pushOrder(incoming.itemId);
    if (incoming.kind === "userMessage") matchEcho(draft, incoming);
    else if (incoming.kind === "workflow") traceWorkflow(draft, undefined, incoming, eventAt);
    else if (incoming.kind === "toolCall") traceTask(draft, incoming, eventAt);
    return;
  }

  const currFinished = existing.status !== "inProgress";
  const incFinished = incoming.status !== "inProgress";
  const isNewer = draft.saved && incFinished !== currFinished
    ? incFinished
    : incoming.revision > existing.revision ||
      existing.revision === 0 ||
      (incoming.revision === existing.revision && incFinished && !currFinished);

  if (!isNewer) return;

  const nextItem: MspItem = { ...incoming };
  if (incoming.kind === "workflow" && incoming.children && existing.children) {
    const oldLabels = new Map(existing.children.map((ch) => [`${ch.childId}:${ch.attempt}`, ch.label]));
    nextItem.children = incoming.children.map((ch) => {
      const remembered = ch.label ?? oldLabels.get(`${ch.childId}:${ch.attempt}`);
      return remembered && !ch.label ? { ...ch, label: remembered } : ch;
    });
  }

  if (!nextItem.text && existing.text) nextItem.text = existing.text;
  if (!nextItem.visibleOutput && existing.visibleOutput) nextItem.visibleOutput = existing.visibleOutput;
  if ((!nextItem.summary || nextItem.summary.length === 0) && existing.summary && existing.summary.length > 0) {
    nextItem.summary = existing.summary;
  }
  if (nextItem.turnId === undefined && existing.turnId !== undefined) {
    nextItem.turnId = existing.turnId;
  }

  (foldRef.items as any)[incoming.itemId] = nextItem;
  draft.putAgentItem(nextItem);

  if (nextItem.kind === "userMessage") matchEcho(draft, nextItem);
  else if (nextItem.kind === "workflow") traceWorkflow(draft, existing, nextItem, eventAt);
  else if (nextItem.kind === "toolCall") traceTask(draft, nextItem, eventAt);
}

const ATTACHMENT_TAIL = /(?:\s*(?:@\S*?attachments\/\S+?|\[Image #\d+\]))+\s*$/;
const ATTACHMENT_MARK = /attachments\/|\[Image #\d+\]/;

function extractPromptTexts(item: MspItem): Set<string> {
  const candidates = [item.displayText, item.text];
  if (!item.displayText && item.text && ATTACHMENT_MARK.test(item.text)) {
    candidates.push(item.text.replace(ATTACHMENT_TAIL, ""));
  }
  const cleanTokens = candidates
    .filter((t): t is string => Boolean(t))
    .map((t) => cleanWhitespace(t))
    .filter(Boolean);
  return new Set(cleanTokens);
}

function doesTextMatch(echo: LocalEcho, item: MspItem): boolean {
  return !echo.excluded?.includes(item.itemId) && extractPromptTexts(item).has(cleanWhitespace(echo.text));
}

function echoMatchesPrompt(echo: LocalEcho, item: MspItem): boolean {
  if (item.kind !== "userMessage") return false;
  if (echo.turnId !== null) {
    if (echo.turnId !== item.turnId && echo.turnId !== item.commandId) return false;
    if (echo.disposition !== "steered") return item.steered !== true;
    return item.steered === true && doesTextMatch(echo, item);
  }
  return doesTextMatch(echo, item);
}

function isMatchedByTextOnly(echo: LocalEcho): boolean {
  return echo.turnId === null || echo.disposition === "steered";
}

function claimedBy(echoes: LocalEcho[], item: MspItem): LocalEcho[] {
  let list = echoes;
  echoes.forEach((echo, idx) => {
    if (!isMatchedByTextOnly(echo) || !echoMatchesPrompt(echo, item)) return;
    if (list === echoes) list = echoes.slice();
    list[idx] = { ...echo, excluded: [...(echo.excluded ?? []), item.itemId] };
  });
  return list;
}

function matchEcho(draft: Draft, item: MspItem): void {
  const currentEchoes = draft.fold.echoes;
  if (currentEchoes.length === 0) return;
  let targetIdx = currentEchoes.findIndex((e) => e.turnId !== null && echoMatchesPrompt(e, item));
  if (targetIdx < 0) {
    targetIdx = currentEchoes.findIndex((e) => e.turnId === null && echoMatchesPrompt(e, item));
  }
  if (targetIdx >= 0) {
    draft.removeEcho(targetIdx);
    draft.claimForEchoes(item);
  }
}

function appendDelta(draft: Draft, params: Record<string, unknown>, eventAt: number | undefined): void {
  const foldRef = draft.fold;
  const itemId = parseString(params["itemId"]);
  const deltaText = typeof params["delta"] === "string" ? params["delta"] : "";
  if (!itemId || deltaText.length === 0) return;

  const fieldKey = parseString(params["field"]) ?? "text";
  let target = foldRef.items[itemId];
  if (!target) {
    target = {
      itemId,
      kind: fieldKey === "output" ? "toolCall" : fieldKey.startsWith("summary") ? "reasoning" : "agentMessage",
      status: "inProgress",
      revision: 0,
    };
    draft.pushOrder(itemId);
  } else if (target.status !== "inProgress") {
    return;
  }

  const updatedItem: MspItem = { ...target };
  if (fieldKey === "text") {
    updatedItem.text = (updatedItem.text ?? "") + deltaText;
  } else if (fieldKey === "output") {
    updatedItem.visibleOutput = (updatedItem.visibleOutput ?? "") + deltaText;
    if (target.kind === "toolCall" && eventAt !== undefined) {
      const activeTask = foldRef.crew?.tasks[itemId];
      if (activeTask) {
        (draft.crew().tasks as any)[itemId] = { ...activeTask, lastOutputAt: eventAt };
      } else if (target.background === true || target.revision === 0) {
        (draft.crew().tasks as any)[itemId] = { firstSeenAt: eventAt, approx: true, lastOutputAt: eventAt, endedAt: null };
      }
    }
  } else if (fieldKey.startsWith("summary.")) {
    const summaryIdx = Number(fieldKey.slice("summary.".length));
    if (Number.isInteger(summaryIdx) && summaryIdx >= 0) {
      const list = [...(updatedItem.summary ?? [])];
      while (list.length < summaryIdx) list.push("");
      list[summaryIdx] = (list[summaryIdx] ?? "") + deltaText;
      updatedItem.summary = list;
    }
  } else {
    const prevVal = updatedItem[fieldKey];
    updatedItem[fieldKey] = (typeof prevVal === "string" ? prevVal : "") + deltaText;
  }
  (foldRef.items as any)[itemId] = updatedItem;
  draft.putAgentItem(updatedItem);
}

const STREAM_BURST_GAP_MS = 2000;

function trackStream(draft: Draft, params: Record<string, unknown>, eventAt: number | undefined): void {
  const fieldKey = parseString(params["field"]) ?? "text";
  const deltaStr = typeof params["delta"] === "string" ? params["delta"] : "";
  if (eventAt === undefined || deltaStr.length === 0 || fieldKey === "output") return;

  const foldRef = draft.fold;
  const itemId = parseString(params["itemId"]);
  const tId = parseString(params["turnId"]) ?? (itemId ? foldRef.items[itemId]?.turnId : null);
  if (!tId) return;

  const existingTurn = foldRef.turns[tId] ?? { turnId: tId };
  const prior = existingTurn.stream && eventAt - existingTurn.stream.lastAt <= STREAM_BURST_GAP_MS
    ? existingTurn.stream
    : { chars: 0, startAt: eventAt, lastAt: eventAt };
  (foldRef.turns as any)[tId] = {
    ...existingTurn,
    stream: { chars: prior.chars + deltaStr.length, startAt: prior.startAt, lastAt: eventAt },
  };
}

function observeMeta(meta: ThreadMeta, field: MetaField, event: ViewEvent): void {
  (meta as any).observed = Object.assign({}, meta.observed, {
    [field]: { cursor: parseString(event.params["viewCursor"]), at: event.at },
  });
}

function newerObservation(event: ViewEvent, previous: MetaObservation): boolean {
  const prevMatch = previous.cursor?.match(/^(v:.+):(\d+)$/);
  const nextMatch = parseString(event.params["viewCursor"])?.match(/^(v:.+):(\d+)$/);
  if (prevMatch && nextMatch && prevMatch[1] === nextMatch[1]) {
    return BigInt(nextMatch[2]!) > BigInt(prevMatch[2]!);
  }
  if (previous.cursor && previous.cursor === event.params["viewCursor"]) return false;
  return event.at !== undefined && previous.at !== undefined && event.at > previous.at;
}

function handleTurnEvent(draft: Draft, event: ViewEvent): void {
  const foldRef = draft.fold;
  const params = event.params;
  const tId = parseString(params["turnId"]);
  if (!tId) return;

  if (event.method === "turn/started") {
    const prior = foldRef.turns[tId];
    (foldRef.turns as any)[tId] = { ...prior, turnId: tId, startedAt: prior?.startedAt ?? event.at };
    if (!prior?.terminal) (foldRef as any).activeTurnId = tId;
    (foldRef as any).closed = false;
    const matchIdx = foldRef.echoes.findIndex((e) => e.turnId === tId && e.disposition === "queued");
    if (matchIdx >= 0) draft.patchEcho(matchIdx, { disposition: "started" });
  } else if (event.method === "turn/completed") {
    const errDict = parseRecord(params["error"]);
    const completedTurn: TurnInfo = {
      ...foldRef.turns[tId],
      turnId: tId,
      terminal: parseString(params["terminal"]) ?? "completed",
      durationMs: parseFiniteNumber(params["durationMs"]) ?? foldRef.turns[tId]?.durationMs,
      firstTokenMs: parseFiniteNumber(params["timeToFirstTokenMs"]) ?? foldRef.turns[tId]?.firstTokenMs,
      completedAt: event.at ?? foldRef.turns[tId]?.completedAt,
      error: errDict
        ? {
            kind: parseString(errDict["kind"]) ?? "error",
            message: parseString(errDict["message"]) ?? "The turn failed.",
            retryable: errDict["retryable"] === true,
          }
        : undefined,
      retry: undefined,
    };
    if (draft.saved) completedTurn.provisional = true;
    else delete completedTurn.provisional;
    (foldRef.turns as any)[tId] = completedTurn;
    if (foldRef.activeTurnId === tId) (foldRef as any).activeTurnId = null;
    for (let i = foldRef.echoes.length - 1; i >= 0; i -= 1) {
      if (foldRef.echoes[i]?.turnId === tId) draft.removeEcho(i);
    }
  } else if (event.method === "turn/retryScheduled") {
    (foldRef.turns as any)[tId] = {
      ...foldRef.turns[tId],
      turnId: tId,
      retry: {
        attempt: parseFiniteNumber(params["attempt"]) ?? 1,
        maxAttempts: parseFiniteNumber(params["maxAttempts"]) ?? 1,
        nextAttempt: parseFiniteNumber(params["nextAttempt"]) ?? 2,
        reason: parseString(params["reason"]) ?? "",
        retryDelayMs: parseFiniteNumber(params["retryDelayMs"]) ?? 0,
      },
    };
  } else if (event.method === "turn/retracted") {
    (foldRef.turns as any)[tId] = { ...foldRef.turns[tId], turnId: tId, retracted: true };
  } else if (event.method === "turn/unqueued") {
    (foldRef.turns as any)[tId] = { ...foldRef.turns[tId], turnId: tId, terminal: "unqueued" };
    const echoIdx = foldRef.echoes.findIndex((e) => e.turnId === tId);
    if (echoIdx >= 0) draft.removeEcho(echoIdx);
  }
}

function handleApprovalEvent(draft: Draft, event: ViewEvent): void {
  const foldRef = draft.fold;
  const appId = parseString(event.params["approvalId"]);
  if (!appId) return;

  if (event.method === "approval/requested" || event.method === "approval/updated") {
    if (!foldRef.resolved[appId]) {
      (foldRef.approvals as any)[appId] = Object.assign({}, foldRef.approvals[appId], event.params);
      traceRequest(draft, appId, "approval", parseString(event.params["itemId"]), event.at);
    }
  } else if (event.method === "approval/resolved") {
    delete (foldRef.approvals as any)[appId];
    (foldRef.resolved as any)[appId] = {
      decision: parseString(event.params["decision"]) ?? "resolved",
      resolvedBy: parseString(event.params["resolvedBy"]) ?? "user",
    };
    traceDecision(draft, appId, event.at);
  }
}

function handleUserInputEvent(draft: Draft, event: ViewEvent): void {
  const foldRef = draft.fold;
  const inputId = parseString(event.params["userInputId"]);
  if (!inputId) return;

  if (event.method === "userInput/requested" || event.method === "userInput/updated") {
    if (!foldRef.settled[inputId]) {
      (foldRef.userInputs as any)[inputId] = Object.assign({}, foldRef.userInputs[inputId], event.params);
      traceRequest(draft, inputId, "input", parseString(event.params["itemId"]), event.at);
    }
  } else if (event.method === "userInput/settled") {
    delete (foldRef.userInputs as any)[inputId];
    (foldRef.settled as any)[inputId] = {
      outcome: parseString(event.params["outcome"]) ?? "answered",
      answers: Array.isArray(event.params["answers"]) ? (event.params["answers"] as UserInputAnswer[]) : [],
    };
    traceDecision(draft, inputId, event.at);
  }
}

function handleSessionEvent(draft: Draft, event: ViewEvent): void {
  const metaRef = draft.fold.meta;
  const params = event.params;
  const m = event.method;

  if (m === "session/todoListChanged") {
    (metaRef as any).todoList = Array.isArray(params["items"]) ? (params["items"] as TodoItem[]) : [];
    (metaRef as any).todoTurnId = parseString(params["turnId"]) ?? draft.fold.activeTurnId;
    observeMeta(metaRef, "todoList", event);
  } else if (m === "session/branchChanged") {
    (metaRef as any).branch = parseString(params["branch"]);
    observeMeta(metaRef, "branch", event);
  } else if (m === "session/contextUsage") {
    (metaRef as any).contextUsage = {
      usedTokens: parseFiniteNumber(params["usedTokens"]) ?? 0,
      windowTokens: parseFiniteNumber(params["windowTokens"]),
      pressure: parseString(params["pressure"]) ?? "normal",
    };
    observeMeta(metaRef, "contextUsage", event);
  } else if (m === "session/tokenUsage") {
    const cumulativeDict = parseRecord(params["cumulative"]);
    if (cumulativeDict) {
      (metaRef as any).tokenTotals = {
        promptTokens: parseFiniteNumber(cumulativeDict["promptTokens"]) ?? 0,
        outputTokens: parseFiniteNumber(cumulativeDict["outputTokens"]) ?? 0,
        totalTokens: parseFiniteNumber(cumulativeDict["totalTokens"]) ?? 0,
      };
    }
    const usageDict = parseRecord(params["usage"]) ?? {};
    const promptTokens = parseFiniteNumber(params["promptTokens"]) ?? parseFiniteNumber(usageDict["inputTokens"]) ?? 0;
    const totalsList = cumulativeDict
      ? [parseFiniteNumber(cumulativeDict["promptTokens"]), parseFiniteNumber(cumulativeDict["outputTokens"]), parseFiniteNumber(cumulativeDict["totalTokens"])]
      : [];
    const hasTotals = totalsList.some((v) => v !== undefined);
    const callLookupKey = hasTotals
      ? [parseString(params["turnId"]) ?? "", ...totalsList.map((v) => v ?? ""), parseFiniteNumber(params["durationMs"]) ?? "", promptTokens].join(":")
      : parseString(params["viewCursor"]) ?? `${parseString(params["turnId"]) ?? "turn"}:${Object.keys(metaRef.calls).length}`;

    draft.putCall(callLookupKey, {
      turnId: parseString(params["turnId"]),
      modelId: parseString(params["modelId"]),
      promptTokens,
      outputTokens: parseFiniteNumber(usageDict["outputTokens"]) ?? Math.max(0, (parseFiniteNumber(params["totalTokens"]) ?? 0) - promptTokens),
      inputTokens: parseFiniteNumber(usageDict["inputTokens"]) ?? 0,
      cachedTokens: parseFiniteNumber(usageDict["cachedTokens"]) ?? 0,
      cacheReadTokens: parseFiniteNumber(usageDict["cacheReadTokens"]) ?? 0,
      cacheWriteTokens: parseFiniteNumber(usageDict["cacheWriteTokens"]) ?? 0,
      reasoningTokens: parseFiniteNumber(usageDict["reasoningTokens"]) ?? 0,
      durationMs: parseFiniteNumber(params["durationMs"]) ?? null,
    });
  } else if (m === "session/modelChanged") {
    const mId = parseString(params["modelId"]);
    if (mId) {
      (metaRef as any).modelId = mId;
      observeMeta(metaRef, "modelId", event);
    }
  } else if (m === "session/approvalModeChanged") {
    if (isValidApprovalMode(params["mode"])) {
      (metaRef as any).approvalMode = params["mode"];
      observeMeta(metaRef, "approvalMode", event);
    }
  } else if (m === "session/goalChanged") {
    const rawVal = params["goal"];
    const nextGoal = parseGoal(rawVal);
    if (rawVal !== null && rawVal !== undefined && !nextGoal) return;

    const prevGoal = metaRef.goal;
    const isSameObjective = nextGoal !== null && prevGoal !== null && nextGoal.objective === prevGoal.objective;
    if (!isSameObjective) {
      (metaRef as any).goalSince = nextGoal ? (event.at ?? null) : null;
      (metaRef as any).goalPauses = [];
    }
    if (!isSameObjective || nextGoal?.status !== prevGoal?.status) {
      (metaRef as any).goalStatusAt = nextGoal ? (event.at ?? null) : null;
    }
    if (isSameObjective && nextGoal && prevGoal && event.at !== undefined && nextGoal.status !== prevGoal.status) {
      const pauseIntervals = metaRef.goalPauses;
      const currentOpenPause = pauseIntervals[pauseIntervals.length - 1];
      if (prevGoal.status === "active") {
        (metaRef as any).goalPauses = [...pauseIntervals, { from: event.at, to: null }];
      } else if (nextGoal.status === "active" && currentOpenPause && currentOpenPause.to === null) {
        (metaRef as any).goalPauses = [...pauseIntervals.slice(0, -1), { from: currentOpenPause.from, to: event.at }];
      }
    }
    (metaRef as any).goal = nextGoal;
    (metaRef as any).goalSeen = true;
    observeMeta(metaRef, "goal", event);
  } else if (m === "session/started") {
    const sessionDict = parseRecord(params["session"]);
    if (sessionDict) {
      const sid = parseString(sessionDict["modelId"]);
      if (sid) {
        (metaRef as any).modelId = sid;
        observeMeta(metaRef, "modelId", event);
      }
      const parsedMode = parseRecord(sessionDict["approvalMode"])?.["mode"];
      if (isValidApprovalMode(parsedMode)) {
        (metaRef as any).approvalMode = parsedMode;
        observeMeta(metaRef, "approvalMode", event);
      }
    }
    (draft.fold as any).closed = false;
  } else if (m === "session/closed") {
    (draft.fold as any).closed = true;
    (draft.fold as any).activeTurnId = null;
  }
}

function applyOne(draft: Draft, event: ViewEvent): void {
  const m = event.method;
  if (m.startsWith("item/")) {
    if (m === "item/delta") {
      appendDelta(draft, event.params, event.at);
      trackStream(draft, event.params, event.at);
    } else {
      const parsed = parseItem(event.params["item"]);
      if (parsed) upsertItem(draft, parsed, event.at);
    }
  } else if (m.startsWith("turn/")) {
    handleTurnEvent(draft, event);
  } else if (m.startsWith("approval/")) {
    handleApprovalEvent(draft, event);
  } else if (m.startsWith("userInput/")) {
    handleUserInputEvent(draft, event);
  } else if (m.startsWith("session/")) {
    handleSessionEvent(draft, event);
  }
}

function applyBatch(fold: ThreadFold, events: readonly ViewEvent[], saved: boolean): ThreadFold {
  if (events.length === 0) return fold;
  const draft = new Draft(fold, inspectEventTouch(events), saved);
  for (const ev of events) {
    applyOne(draft, ev);
  }
  return draft.fold;
}

export function applyEvents(fold: ThreadFold, events: readonly ViewEvent[]): ThreadFold {
  return applyBatch(fold, events, false);
}

export function applyEvent(fold: ThreadFold, event: ViewEvent): ThreadFold {
  return applyEvents(fold, [event]);
}

function startedEcho(fold: ThreadFold, echo: LocalEcho): LocalEcho {
  const isRunning = echo.turnId !== null && (fold.turns[echo.turnId] !== undefined || fold.activeTurnId === echo.turnId);
  return echo.disposition === "queued" && isRunning ? { ...echo, disposition: "started" } : echo;
}

function landedItem(fold: ThreadFold, echo: LocalEcho, claimed: readonly MspItem[] = []): MspItem | undefined {
  for (const itemId of fold.order) {
    const it = fold.items[itemId];
    if (it !== undefined && echoMatchesPrompt(echo, it) && !claimed.includes(it)) {
      return it;
    }
  }
  return undefined;
}

function carriedEchoes(fold: ThreadFold, echoes: readonly LocalEcho[]): LocalEcho[] {
  let kept: LocalEcho[] = [];
  const claimed: MspItem[] = [];
  for (const echo of echoes) {
    const tId = echo.turnId;
    if (!tId) {
      kept.push(echo);
      continue;
    }
    if (fold.turns[tId]?.terminal) continue;
    const landed = landedItem(fold, echo, claimed);
    if (landed) {
      claimed.push(landed);
      continue;
    }
    kept.push(startedEcho(fold, echo));
  }
  for (const it of claimed) {
    kept = claimedBy(kept, it);
  }
  return kept;
}

function carriedWorkflowLabels(fold: ThreadFold, previous: ThreadFold | null | undefined): ThreadFold {
  if (!previous) return fold;
  let resultFold = fold;
  for (const item of Object.values(fold.agentItems ?? fold.items)) {
    if (item.kind !== "workflow" || !item.children?.length) continue;
    const oldItem = previous.items[item.itemId];
    if (oldItem?.kind !== "workflow" || !oldItem.children?.length) continue;
    const labelDict = new Map(oldItem.children.map((ch) => [`${ch.childId}:${ch.attempt}`, ch.label]));
    let modified = false;
    const childList = item.children.map((ch) => {
      if (ch.label?.trim()) return ch;
      const lbl = labelDict.get(`${ch.childId}:${ch.attempt}`);
      if (!lbl?.trim()) return ch;
      modified = true;
      return { ...ch, label: lbl };
    });
    if (!modified) continue;
    if (resultFold === fold) {
      resultFold = {
        ...fold,
        items: { ...fold.items },
        ...(fold.agentItems ? { agentItems: { ...fold.agentItems } } : {}),
      };
    }
    const updatedRecord = { ...item, children: childList };
    (resultFold.items as any)[item.itemId] = updatedRecord;
    if (resultFold.agentItems) {
      (resultFold.agentItems as any)[item.itemId] = updatedRecord;
    }
  }
  return resultFold;
}

function pickEarlierTimestamp(fresh: number | undefined, freshApprox: boolean, old: number | undefined, oldApprox: boolean): number | undefined {
  if (fresh === undefined || old === undefined) return fresh ?? old;
  if (freshApprox !== oldApprox) return freshApprox ? old : fresh;
  return Math.min(fresh, old);
}

function mergeChildTrace(fresh: ChildTrace, old: ChildTrace): ChildTrace {
  const merged: ChildTrace = { lastEventAt: null, approx: fresh.approx && old.approx };
  const traceKeys: readonly ("scheduledAt" | "startedAt" | "usageAt" | "completedAt" | "terminalAt")[] = [
    "scheduledAt", "startedAt", "usageAt", "completedAt", "terminalAt",
  ];
  for (const field of traceKeys) {
    const val = pickEarlierTimestamp(fresh[field], fresh.approx, old[field], old.approx);
    if (val !== undefined) (merged as any)[field] = val;
  }
  const lastTimestamps = [fresh.lastEventAt, old.lastEventAt].filter((v): v is number => v !== null);
  (merged as any).lastEventAt = lastTimestamps.length > 0 ? Math.max(...lastTimestamps) : null;
  const usagePayload = fresh.usage ?? old.usage;
  if (usagePayload !== undefined) (merged as any).usage = usagePayload;
  for (const attr of ["label", "terminal"] as const) {
    const attrVal = fresh[attr] ?? old[attr];
    if (attrVal !== undefined) (merged as any)[attr] = attrVal;
  }
  const dur = fresh.durationMs ?? old.durationMs;
  if (dur !== undefined) (merged as any).durationMs = dur;
  return merged;
}

function mergeRunTrace(fresh: RunTrace, old: RunTrace): RunTrace {
  const earliestStart = pickEarlierTimestamp(fresh.startedAt ?? undefined, fresh.approx, old.startedAt ?? undefined, old.approx) ?? null;
  const isExactStart = earliestStart !== null && (
    (fresh.startedAt === earliestStart && !fresh.approx) ||
    (old.startedAt === earliestStart && !old.approx)
  );
  const childMap: Record<string, ChildTrace> = Object.assign({}, old.children);
  for (const [key, freshTrace] of Object.entries(fresh.children)) {
    const priorTrace = childMap[key];
    childMap[key] = priorTrace ? mergeChildTrace(freshTrace, priorTrace) : freshTrace;
  }
  const distinctMinutes = Array.from(new Set([...old.eventMinutes, ...fresh.eventMinutes])).sort((a, b) => a - b);
  return {
    startedAt: earliestStart,
    approx: earliestStart === null ? fresh.approx || old.approx : !isExactStart,
    endedAt: fresh.endedAt ?? old.endedAt,
    children: childMap,
    eventMinutes: distinctMinutes.slice(-EVENT_MINUTES_CAP),
  };
}

function carriedCrew(fold: ThreadFold, previous: ThreadFold | null | undefined): ThreadFold {
  const oldCrew = previous?.crew;
  if (!oldCrew) return fold;

  const runMap: Record<string, RunTrace> = Object.assign({}, fold.crew.runs);
  for (const [runId, oldRun] of Object.entries(oldCrew.runs)) {
    if (!fold.items[runId]) continue;
    const freshRun = runMap[runId];
    runMap[runId] = freshRun ? mergeRunTrace(freshRun, oldRun) : oldRun;
  }

  const reqMap: Record<string, RequestTrace> = Object.assign({}, fold.crew.requests);
  for (const [reqId, oldReq] of Object.entries(oldCrew.requests)) {
    const freshReq = reqMap[reqId];
    reqMap[reqId] = freshReq
      ? { ...freshReq, askedAt: freshReq.askedAt ?? oldReq.askedAt, decidedAt: freshReq.decidedAt ?? oldReq.decidedAt }
      : oldReq;
  }

  const taskMap: Record<string, TaskTrace> = Object.assign({}, fold.crew.tasks);
  for (const [tId, oldTask] of Object.entries(oldCrew.tasks)) {
    if (!fold.items[tId]) continue;
    const freshTask = taskMap[tId];
    if (!freshTask) {
      taskMap[tId] = oldTask;
      continue;
    }
    const firstSeen = pickEarlierTimestamp(freshTask.firstSeenAt ?? undefined, freshTask.approx, oldTask.firstSeenAt ?? undefined, oldTask.approx) ?? null;
    const isExact = firstSeen !== null && (
      (freshTask.firstSeenAt === firstSeen && !freshTask.approx) ||
      (oldTask.firstSeenAt === firstSeen && !oldTask.approx)
    );
    const outputs = [freshTask.lastOutputAt, oldTask.lastOutputAt].filter((v): v is number => v !== null);
    taskMap[tId] = {
      firstSeenAt: firstSeen,
      approx: firstSeen === null ? freshTask.approx || oldTask.approx : !isExact,
      lastOutputAt: outputs.length > 0 ? Math.max(...outputs) : null,
      endedAt: freshTask.endedAt ?? oldTask.endedAt,
    };
  }

  return { ...fold, crew: { runs: runMap, requests: reqMap, tasks: taskMap } };
}

function isIncompleteOutcome(ev: ViewEvent): boolean {
  const errDict = parseRecord(ev.params["error"]);
  return ev.method === "turn/completed" &&
    ev.params["terminal"] === "failed" &&
    (ev.params["reason"] === "incomplete" || errDict?.["kind"] === "incomplete");
}

function partialHistoryEvents(load: TranscriptLoad, previous: ThreadFold): ViewEvent[] {
  const metaMappings: Record<string, MetaField> = {
    "session/todoListChanged": "todoList",
    "session/branchChanged": "branch",
    "session/contextUsage": "contextUsage",
    "session/modelChanged": "modelId",
    "session/approvalModeChanged": "approvalMode",
    "session/goalChanged": "goal",
  };

  const filteredEvents: ViewEvent[] = [];
  for (const event of load.events) {
    const metaKey = metaMappings[event.method];
    if (metaKey) {
      const priorObs = previous.meta.observed?.[metaKey];
      if (priorObs) {
        if (newerObservation(event, priorObs)) filteredEvents.push(event);
      } else {
        const shouldAdmit = metaKey === "goal" ? !previous.meta.goalSeen : previous.meta[metaKey] === null;
        if (shouldAdmit) filteredEvents.push(event);
      }
      continue;
    }

    const tId = parseString(event.params["turnId"]);
    const existingTurn = tId ? previous.turns[tId] : undefined;
    const m = event.method;

    if (m === "turn/started") {
      if (!existingTurn?.terminal && existingTurn?.startedAt === undefined) filteredEvents.push(event);
    } else if (m === "turn/completed" || m === "turn/unqueued") {
      if (!tId || tId === load.msp?.activeTurnId) continue;
      if (existingTurn?.terminal && !(existingTurn.provisional && existingTurn.terminal === "unknown")) continue;
      if (!isIncompleteOutcome(event)) {
        filteredEvents.push(event);
        continue;
      }
      if (existingTurn?.terminal || (!load.msp && tId === previous.activeTurnId)) continue;
      filteredEvents.push({ method: "turn/completed", params: { turnId: tId, terminal: "unknown" } });
    } else if (m === "turn/retryScheduled") {
      const nextAtt = parseFiniteNumber(event.params["nextAttempt"]) ?? 0;
      if (!existingTurn?.terminal && (!existingTurn || (existingTurn.retry !== undefined && nextAtt > existingTurn.retry.nextAttempt))) {
        filteredEvents.push(event);
      }
    } else if (m === "turn/retracted") {
      filteredEvents.push(event);
    } else if (m === "approval/resolved") {
      const appId = parseString(event.params["approvalId"]) ?? "";
      if (!previous.resolved[appId]) filteredEvents.push(event);
    } else if (m === "userInput/settled") {
      const inputId = parseString(event.params["userInputId"]) ?? "";
      if (!previous.settled[inputId]) filteredEvents.push(event);
    }
  }
  return filteredEvents;
}

function mergedOrder(shown: readonly string[], page: readonly string[], all: readonly string[]): string[] {
  const pageMembership = new Set(page);
  const leadingBuffer = new Map<string, string[]>();
  let unpagedItems: string[] = [];

  for (const id of shown) {
    if (!pageMembership.has(id)) {
      unpagedItems.push(id);
    } else if (unpagedItems.length > 0) {
      leadingBuffer.set(id, unpagedItems);
      unpagedItems = [];
    }
  }

  const existingIds = new Set(all);
  const reconstructed: string[] = [];
  for (const pageId of page) {
    const prefix = leadingBuffer.get(pageId);
    if (prefix) reconstructed.push(...prefix);
    if (existingIds.has(pageId)) reconstructed.push(pageId);
  }
  reconstructed.push(...unpagedItems);
  return reconstructed.length === all.length ? reconstructed : [...all];
}

function pendingRequests(
  load: TranscriptLoad,
  fold: ThreadFold,
  snapshot: ThreadFold,
  previous: ThreadFold | null | undefined,
  activeTurnId: string | null,
): { approvals: Record<string, ApprovalRequest>; userInputs: Record<string, UserInputRequest> } {
  const isComplete = load.pendingComplete !== false;
  const approvals: Record<string, ApprovalRequest> = isComplete ? {} : Object.assign({}, previous?.approvals);
  const userInputs: Record<string, UserInputRequest> = isComplete ? {} : Object.assign({}, previous?.userInputs);

  if (!isComplete && activeTurnId) {
    const isRunning = (req: { turnId?: string; itemId?: string }) =>
      (req.turnId ?? (req.itemId ? fold.items[req.itemId]?.turnId : undefined)) === activeTurnId;

    for (const req of Object.values(snapshot.approvals)) {
      if (isRunning(req)) approvals[req.approvalId] ??= req;
    }
    for (const req of Object.values(snapshot.userInputs)) {
      if (isRunning(req)) userInputs[req.userInputId] ??= req;
    }
  }

  for (const app of load.pending.approvals) approvals[app.approvalId] = app;
  for (const inp of load.pending.userInputs) userInputs[inp.userInputId] = inp;

  if (!isComplete) {
    for (const id of Object.keys(approvals)) {
      if (fold.resolved[id] || previous?.resolved[id]) delete approvals[id];
    }
    for (const id of Object.keys(userInputs)) {
      if (fold.settled[id] || previous?.settled[id]) delete userInputs[id];
    }
  }

  return { approvals, userInputs };
}

export function foldFromLoad(load: TranscriptLoad, previous?: ThreadFold | null): ThreadFold {
  const isPartial = load.historyUnavailable || load.viewHealth?.status === "unavailable";
  const snapshot = applyEvents(emptyFold(), load.events);
  let fold = snapshot;

  if (isPartial && previous) {
    const mergedEvents = partialHistoryEvents(load, previous);
    for (const itemId of snapshot.order) {
      const item = snapshot.items[itemId]!;
      const curr = previous.items[itemId];
      mergedEvents.push({ method: "item/updated", params: { item } });
      if (!curr || curr.revision === 0 || item.revision !== curr.revision || item.status !== "inProgress" || curr.status !== "inProgress") {
        continue;
      }
      const diffPairs: [string, string | undefined, string | undefined][] = [
        ["text", curr.text, item.text],
        ["output", curr.visibleOutput, item.visibleOutput],
        ...(item.summary ?? []).map((val, idx): [string, string | undefined, string | undefined] => [
          `summary.${idx}`, curr.summary?.[idx], val,
        ]),
      ];
      for (const [field, before = "", after = ""] of diffPairs) {
        if (after.length > before.length && after.startsWith(before)) {
          mergedEvents.push({
            method: "item/delta",
            params: { itemId, field, delta: after.slice(before.length), turnId: item.turnId },
          });
        }
      }
    }

    fold = applyBatch(previous, mergedEvents, true);
    const prevTotals = previous.meta.tokenTotals;
    const snapTotals = snapshot.meta.tokenTotals;

    fold = {
      ...fold,
      order: fold.order.length > previous.order.length ? mergedOrder(previous.order, snapshot.order, fold.order) : fold.order,
      activeTurnId: previous.activeTurnId && !fold.turns[previous.activeTurnId]?.terminal ? previous.activeTurnId : null,
      meta: {
        ...fold.meta,
        calls: Object.assign({}, snapshot.meta.calls, previous.meta.calls),
        tokenTotals: prevTotals && snapTotals ? {
          promptTokens: Math.max(prevTotals.promptTokens, snapTotals.promptTokens),
          outputTokens: Math.max(prevTotals.outputTokens, snapTotals.outputTokens),
          totalTokens: Math.max(prevTotals.totalTokens, snapTotals.totalTokens),
        } : prevTotals ?? snapTotals,
        modelId: fold.meta.modelId ?? snapshot.meta.modelId,
        approvalMode: fold.meta.approvalMode ?? snapshot.meta.approvalMode,
      },
    };
  }

  fold = carriedWorkflowLabels(fold, previous);
  if (isPartial && previous) {
    fold = carriedWorkflowLabels(fold, snapshot);
    fold = carriedCrew(fold, snapshot);
  } else {
    fold = carriedCrew(fold, previous);
  }

  const currentActiveTurn = load.msp ? load.msp.activeTurnId : fold.activeTurnId;
  const reconciledRequests = pendingRequests(load, fold, snapshot, previous, currentActiveTurn);

  return {
    ...fold,
    approvals: reconciledRequests.approvals,
    userInputs: reconciledRequests.userInputs,
    activeTurnId: currentActiveTurn,
    echoes: carriedEchoes({ ...fold, activeTurnId: currentActiveTurn }, previous?.echoes ?? []),
    meta: {
      ...fold.meta,
      contextUsage: fold.meta.contextUsage ?? (typeof load.msp?.contextUsage?.usedTokens === "number" ? load.msp.contextUsage : null),
      tokenTotals: fold.meta.tokenTotals ?? (typeof load.msp?.tokenUsage?.totalTokens === "number" ? load.msp.tokenUsage : null),
      modelId: fold.meta.modelId ?? load.msp?.modelId ?? load.session?.modelId ?? null,
      approvalMode: fold.meta.approvalMode ?? (isValidApprovalMode(load.msp?.approvalMode) ? load.msp.approvalMode : null),
    },
    closed: false,
  };
}

export function addEcho(fold: ThreadFold, echo: LocalEcho): ThreadFold {
  const normalized = cleanWhitespace(echo.text);
  const matchedEarlierIds = normalized
    ? fold.order.filter((id) => {
        const it = fold.items[id];
        return it?.kind === "userMessage" && extractPromptTexts(it).has(normalized);
      })
    : [];
  const modifiedEcho = matchedEarlierIds.length > 0
    ? { ...echo, excluded: [...(echo.excluded ?? []), ...matchedEarlierIds] }
    : echo;
  return { ...fold, echoes: fold.echoes.concat(modifiedEcho) };
}

export function updateEcho(fold: ThreadFold, localId: string, patch: Partial<LocalEcho>): ThreadFold {
  const idx = fold.echoes.findIndex((e) => e.localId === localId);
  if (idx < 0) return fold;

  let targetEcho = { ...(fold.echoes[idx] as LocalEcho), ...patch };
  if (targetEcho.turnId) {
    if (fold.turns[targetEcho.turnId]?.terminal) return removeEcho(fold, localId);
    const landed = landedItem(fold, targetEcho);
    if (landed) {
      const remaining = removeEcho(fold, localId);
      return { ...remaining, echoes: claimedBy(remaining.echoes, landed) };
    }
    targetEcho = startedEcho(fold, targetEcho);
  }
  const nextEchoes = fold.echoes.slice();
  nextEchoes[idx] = targetEcho;
  return { ...fold, echoes: nextEchoes };
}

export function promptIds(fold: ThreadFold): string[] {
  return fold.order.filter((id) => fold.items[id]?.kind === "userMessage");
}

export function promptLanded(fold: ThreadFold, known: readonly string[], text: string): boolean {
  const target = cleanWhitespace(text);
  return fold.order.some((id) => {
    const item = fold.items[id];
    if (item?.kind !== "userMessage" || known.includes(id)) return false;
    return target === "" || extractPromptTexts(item).has(target);
  });
}

export function removeEcho(fold: ThreadFold, localId: string): ThreadFold {
  const filtered = fold.echoes.filter((e) => e.localId !== localId);
  return filtered.length === fold.echoes.length ? fold : { ...fold, echoes: filtered };
}

export interface TurnView {
  readonly key: string;
  readonly turnId: string | null;
  readonly prompt: MspItem | null;
  readonly entries: MspItem[];
  readonly final: MspItem | null;
  readonly info: TurnInfo | null;
  readonly running: boolean;
}

export function buildTurns(fold: ThreadFold): TurnView[] {
  const viewsByTurn = new Map<string, {
    key: string;
    turnId: string | null;
    prompt: MspItem | null;
    entries: MspItem[];
    final: MspItem | null;
    info: TurnInfo | null;
    running: boolean;
  }>();
  const orderedViews: TurnView[] = [];

  for (const itemId of fold.order) {
    const it = fold.items[itemId];
    if (!it || HIDDEN_KINDS.has(it.kind) || (it.kind === "userMessage" && it.retracted)) {
      continue;
    }
    const groupKey = it.turnId ? `turn:${it.turnId}` : `item:${itemId}`;
    let record = viewsByTurn.get(groupKey);
    if (!record) {
      record = {
        key: groupKey,
        turnId: it.turnId ?? null,
        prompt: null,
        entries: [],
        final: null,
        info: it.turnId ? (fold.turns[it.turnId] ?? null) : null,
        running: it.turnId ? fold.activeTurnId === it.turnId : false,
      };
      viewsByTurn.set(groupKey, record);
      orderedViews.push(record as TurnView);
    }
    if (it.kind === "userMessage" && !it.steered && !record.prompt) {
      record.prompt = it;
    } else {
      record.entries.push(it);
    }
  }

  for (const v of orderedViews) {
    if (!v.running) {
      const candidateFinal = v.entries[v.entries.length - 1];
      if (candidateFinal && candidateFinal.kind === "agentMessage" && (candidateFinal.text ?? "").trim().length > 0) {
        (v as any).final = candidateFinal;
        (v as any).entries = v.entries.slice(0, -1);
      }
    }
  }
  return orderedViews;
}

export function gateFor(
  fold: ThreadFold,
  itemId: string,
): { kind: "approval"; request: ApprovalRequest } | { kind: "input"; request: UserInputRequest } | null {
  const pendingApproval = Object.values(fold.approvals).find((req) => req.itemId === itemId);
  if (pendingApproval) return { kind: "approval", request: pendingApproval };
  const pendingInput = Object.values(fold.userInputs).find((req) => req.itemId === itemId);
  if (pendingInput) return { kind: "input", request: pendingInput };
  return null;
}
