import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  type ApprovalMode,
  type CommandConnection,
  type MspNotification,
  type NotificationHandler,
  type ProtocolErrorHandler,
  type ReasoningEffort,
  type SubscriptionUsage,
  type TurnImage,
  type UserInputAnswerItem,
  isApprovalMode,
  isReasoningEffort,
} from "../sessions.js";
import {
  type ProviderCapabilities,
  type ProviderId,
  type SessionJournal,
  UnsupportedCapabilityError,
  capabilitiesForProvider,
  descriptorForProvider,
} from "./types.js";

const MAX_VISIBLE_OUTPUT_BYTES = 48 * 1024;
const MAX_STORED_OUTPUTS = 256;

export interface CanonicalPendingApproval {
  request: Record<string, unknown>;
  resolve: (decision: { allow: boolean; scope: "once" | "session"; choiceId: string; feedback: string | null }) => void;
}

export interface CanonicalPendingUserInput {
  request: Record<string, unknown>;
  resolve: (outcome: {
    kind: "answered" | "cancelled" | "clarified";
    answers: UserInputAnswerItem[];
    reason?: string;
    clarification?: string;
  }) => void;
}

export interface CanonicalSessionState {
  sessionId: string;
  externalSessionId: string | null;
  workspaceRoot: string;
  modelId: string | null;
  approvalMode: ApprovalMode;
  reasoningEffort: ReasoningEffort | null;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  activeTurnId: string | null;
  activeTurnAbort: AbortController | null;
  nextSeq: number;
  events: { seq: number; method: string; params: Record<string, unknown>; at: string }[];
  items: Map<string, Record<string, unknown>>;
  pendingApprovals: Map<string, CanonicalPendingApproval>;
  pendingUserInputs: Map<string, CanonicalPendingUserInput>;
  sessionAllowedTools: Set<string>;
  cumulativePromptTokens: number;
  cumulativeOutputTokens: number;
  contextWindowTokens: number | null;
  lastUsedTokens: number;
}

export interface CanonicalTurnContext {
  session: CanonicalSessionState;
  turnId: string;
  prompt: string;
  displayText?: string;
  images: TurnImage[];
  reasoningEffort: ReasoningEffort | null;
  signal: AbortSignal;
}

export interface CanonicalDriverHooks {
  readonly providerId: ProviderId;
  readonly capabilities?: ProviderCapabilities;
  readonly journal?: SessionJournal;
  onStartSession?(options: {
    sessionId: string;
    workspaceRoot: string;
    approvalMode: ApprovalMode;
    modelId: string | null;
  }): Promise<{ externalSessionId?: string | null; modelId?: string | null } | void>;
  onResumeSession?(session: CanonicalSessionState): Promise<{ externalSessionId?: string | null; modelId?: string | null } | void>;
  onRunTurn(ctx: CanonicalTurnContext, runtime: CanonicalSessionRuntime): Promise<void>;
  onSteerTurn?(session: CanonicalSessionState, turnId: string, text: string, runtime: CanonicalSessionRuntime): Promise<void>;
  onInterruptTurn?(session: CanonicalSessionState, turnId: string | undefined, retract: boolean): Promise<void>;
  onListModels?(session: CanonicalSessionState | null): Promise<{ models: Record<string, unknown>[]; source?: string } | null>;
  onSetModel?(session: CanonicalSessionState, modelId: string): Promise<void>;
  onSetApprovalMode?(session: CanonicalSessionState, mode: ApprovalMode): Promise<void>;
  onSetReasoningEffort?(session: CanonicalSessionState, effort: ReasoningEffort): Promise<void>;
  onCompactSession?(session: CanonicalSessionState, runtime: CanonicalSessionRuntime): Promise<unknown>;
  onForkSession?(
    source: CanonicalSessionState,
    newSessionId: string,
    runtime: CanonicalSessionRuntime,
  ): Promise<{ externalSessionId?: string | null } | void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Shared MSP-compatible `CommandConnection` implementation for non-Muse providers
 * (ACP, Codex App-Server, Claude stream-json, and built-in Direct API/Local).
 */
export class CanonicalSessionRuntime implements CommandConnection {
  readonly providerId: ProviderId;
  readonly capabilities: ProviderCapabilities;
  private readonly sessions = new Map<string, CanonicalSessionState>();
  private readonly notificationHandlers: NotificationHandler[] = [];
  private readonly protocolErrorHandlers: ProtocolErrorHandler[] = [];
  private readonly storedOutputs = new Map<string, Buffer>();
  private subscriptionUsage: SubscriptionUsage | null = null;

  constructor(private readonly hooks: CanonicalDriverHooks) {
    this.providerId = hooks.providerId;
    this.capabilities = hooks.capabilities ?? capabilitiesForProvider(hooks.providerId);
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  onProtocolError(handler: ProtocolErrorHandler): void {
    this.protocolErrorHandlers.push(handler);
  }

  reportProtocolError(error: unknown): void {
    for (const handler of this.protocolErrorHandlers) {
      try {
        handler(error);
      } catch {
        /* ignore */
      }
    }
  }

  updateSubscriptionUsage(usage: SubscriptionUsage): void {
    this.subscriptionUsage = usage;
    this.broadcast({
      method: "usage/changed",
      params: { ...usage },
      emittedAtMs: Date.now(),
    });
  }

  getSession(sessionId: string): CanonicalSessionState | null {
    return this.sessions.get(sessionId) ?? null;
  }

  findByExternalSessionId(externalId: string): CanonicalSessionState | null {
    for (const session of this.sessions.values()) {
      if (session.externalSessionId === externalId) {
        return session;
      }
    }
    return null;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.dispatch(method, params);
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.dispatch(method, params);
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "session/list": {
        const workspaceRoot = str(params["workspaceRoot"]);
        const limit = typeof params["limit"] === "number" ? Math.max(1, params["limit"]) : 50;
        const rows = [...this.sessions.values()]
          .filter((s) => !workspaceRoot || s.workspaceRoot === workspaceRoot)
          .slice(0, limit)
          .map((s) => this.sessionSnapshot(s));
        return { sessions: rows, nextCursor: null };
      }

      case "session/start": {
        const sessionId = randomUUID();
        const workspaceRoot = str(params["workspaceRoot"]) ?? process.cwd();
        const approvalMode = isApprovalMode(params["approvalMode"]) ? params["approvalMode"] : "onRequest";
        const seedModels = descriptorForProvider(this.providerId).fallbackModels;
        const requestedModel = str(params["modelId"]) ?? null;
        const created = await this.hooks.onStartSession?.({
          sessionId,
          workspaceRoot,
          approvalMode,
          modelId: requestedModel,
        });
        const now = new Date().toISOString();
        const modelId = created && created.modelId !== undefined ? created.modelId : requestedModel;
        const matchedSeed = seedModels.find((m) => m.modelId === modelId);
        const session: CanonicalSessionState = {
          sessionId,
          externalSessionId: created?.externalSessionId ?? null,
          workspaceRoot,
          modelId,
          approvalMode,
          reasoningEffort: null,
          name: null,
          createdAt: now,
          updatedAt: now,
          turnCount: 0,
          activeTurnId: null,
          activeTurnAbort: null,
          nextSeq: 1,
          events: [],
          items: new Map(),
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          sessionAllowedTools: new Set(),
          cumulativePromptTokens: 0,
          cumulativeOutputTokens: 0,
          contextWindowTokens: matchedSeed?.contextWindowTokens ?? null,
          lastUsedTokens: 0,
        };
        this.sessions.set(sessionId, session);
        const snap = this.sessionSnapshot(session);
        this.emitDurable(session, "session/started", { session: snap });
        return { session: snap };
      }

      case "session/resume": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        const resumed = await this.hooks.onResumeSession?.(session);
        if (resumed?.externalSessionId) {
          session.externalSessionId = resumed.externalSessionId;
        }
        if (resumed?.modelId) {
          session.modelId = resumed.modelId;
        }
        return {
          session: this.sessionSnapshot(session),
          history: params["excludeItems"] === true ? { mode: "none" } : { mode: "inline", items: [...session.items.values()] },
        };
      }

      case "session/read": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        return {
          session: this.sessionSnapshot(session),
          pendingRequests: [
            ...session.pendingApprovals.values(),
            ...session.pendingUserInputs.values(),
          ].map((entry) => entry.request),
          history: params["excludeItems"] === true ? { mode: "none" } : { mode: "inline", items: [...session.items.values()] },
        };
      }

      case "view/page": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        const limit = typeof params["limit"] === "number" ? Math.max(1, params["limit"]) : 200;
        const direction = params["direction"] === "backward" ? "backward" : "forward";
        const cursorStr = str(params["cursor"]);
        const cursorSeq = cursorStr ? Number(cursorStr.split(":").pop()) : null;

        if (direction === "backward") {
          const filtered =
            cursorSeq !== null && Number.isFinite(cursorSeq)
              ? session.events.filter((e) => e.seq < cursorSeq)
              : session.events;
          const slice = filtered.slice(Math.max(0, filtered.length - limit));
          const hasMore = filtered.length > slice.length && slice.length > 0;
          return {
            events: slice.map((e) => ({ method: e.method, params: e.params })),
            nextCursor: hasMore ? `v:${sessionId}:${slice[0]!.seq}` : null,
          };
        }

        const filtered =
          cursorSeq !== null && Number.isFinite(cursorSeq)
            ? session.events.filter((e) => e.seq > cursorSeq)
            : session.events;
        const slice = filtered.slice(0, limit);
        const hasMore = filtered.length > slice.length && slice.length > 0;
        return {
          events: slice.map((e) => ({ method: e.method, params: e.params })),
          nextCursor: hasMore ? `v:${sessionId}:${slice[slice.length - 1]!.seq}` : null,
        };
      }

      case "approval/listPending": {
        const sessionId = this.requireSessionId(params);
        const session = this.sessions.get(sessionId);
        if (!session) {
          return { approvals: [], userInputs: [] };
        }
        return {
          approvals: [...session.pendingApprovals.values()].map((p) => p.request),
          userInputs: [...session.pendingUserInputs.values()].map((p) => p.request),
        };
      }

      case "approval/decide": {
        const sessionId = this.requireSessionId(params);
        const approvalId = str(params["approvalId"]);
        const choiceId = str(params["choiceId"]) ?? "deny_once";
        const feedback = typeof params["feedback"] === "string" ? params["feedback"] : null;
        const session = this.requireLoadedSession(sessionId);
        const pending = approvalId ? session.pendingApprovals.get(approvalId) : undefined;
        if (!pending || !approvalId) {
          throw Object.assign(new Error("Approval request is no longer pending."), { kind: "approvalNotFound" });
        }
        session.pendingApprovals.delete(approvalId);
        const allow = choiceId.startsWith("allow") || choiceId.startsWith("approve") || choiceId === "accept" || choiceId === "once" || choiceId === "always";
        const scope: "once" | "session" = choiceId.includes("session") || choiceId.includes("always") ? "session" : "once";
        const toolKey = str(pending.request["toolName"]);
        if (allow && scope === "session" && toolKey) {
          session.sessionAllowedTools.add(toolKey);
        }
        this.emitDurable(session, "approval/resolved", {
          approvalId,
          decision: allow ? (scope === "session" ? "approvedForSession" : "approved") : "denied",
          resolvedBy: "user",
        });
        pending.resolve({ allow, scope, choiceId, feedback });
        return { ok: true };
      }

      case "userInput/answer":
      case "userInput/cancel":
      case "userInput/clarify": {
        const sessionId = this.requireSessionId(params);
        const userInputId = str(params["userInputId"]);
        const session = this.requireLoadedSession(sessionId);
        const pending = userInputId ? session.pendingUserInputs.get(userInputId) : undefined;
        if (!pending || !userInputId) {
          throw Object.assign(new Error("Question is no longer pending."), { kind: "userInputNotFound" });
        }
        session.pendingUserInputs.delete(userInputId);
        if (method === "userInput/answer") {
          const answers = Array.isArray(params["answers"]) ? (params["answers"] as UserInputAnswerItem[]) : [];
          this.emitDurable(session, "userInput/settled", {
            userInputId,
            outcome: "answered",
            answers,
          });
          pending.resolve({ kind: "answered", answers });
        } else if (method === "userInput/cancel") {
          this.emitDurable(session, "userInput/settled", {
            userInputId,
            outcome: "cancelled",
            answers: [],
          });
          pending.resolve({ kind: "cancelled", answers: [], reason: str(params["reason"]) ?? undefined });
        } else {
          const clarification = str(asRecord(params["clarification"])?.["content"]) ?? "";
          this.emitDurable(session, "userInput/settled", {
            userInputId,
            outcome: "clarified",
            answers: [],
          });
          pending.resolve({ kind: "clarified", answers: [], clarification });
        }
        return { ok: true };
      }

      case "turn/start": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        if (session.activeTurnId) {
          const ifBusy = str(params["ifBusy"]);
          if (ifBusy === "steer" && this.capabilities.supportsSteer && this.hooks.onSteerTurn) {
            const text = this.extractInputText(params["input"]);
            await this.hooks.onSteerTurn(session, session.activeTurnId, text, this);
            return { turnId: session.activeTurnId, status: "inProgress", disposition: "steered" };
          }
          if (ifBusy === "replace") {
            await this.interruptActiveTurn(session, true);
          } else {
            throw Object.assign(new Error("A turn is already running on this session."), { kind: "turnBusy" });
          }
        }
        const turnId = randomUUID();
        const prompt = this.extractInputText(params["input"]);
        const images = this.extractInputImages(params["input"]);
        const displayText = str(params["displayText"]) ?? undefined;
        const effortRaw = params["reasoningEffort"];
        const effort = isReasoningEffort(effortRaw) ? effortRaw : session.reasoningEffort;

        const abortController = new AbortController();
        session.activeTurnId = turnId;
        session.activeTurnAbort = abortController;
        session.updatedAt = new Date().toISOString();

        this.emitDurable(session, "turn/started", { turnId });

        const userItemId = randomUUID();
        const userItem: Record<string, unknown> = {
          itemId: userItemId,
          turnId,
          kind: "userMessage",
          status: "completed",
          revision: 1,
          text: prompt,
          ...(displayText ? { displayText } : {}),
          recordedAt: new Date().toISOString(),
        };
        this.upsertItem(session, userItem, true);

        const startedAtMs = Date.now();
        void this.executeTurn(
          {
            session,
            turnId,
            prompt,
            displayText,
            images,
            reasoningEffort: effort,
            signal: abortController.signal,
          },
          startedAtMs,
        );

        return { turnId, status: "inProgress", disposition: "started" };
      }

      case "turn/steer": {
        if (!this.capabilities.supportsSteer || !this.hooks.onSteerTurn) {
          throw new UnsupportedCapabilityError(this.providerId, "mid-turn steering");
        }
        const sessionId = this.requireSessionId(params);
        const session = this.requireLoadedSession(sessionId);
        const expectedTurnId = str(params["expectedTurnId"]) ?? session.activeTurnId;
        if (!expectedTurnId || session.activeTurnId !== expectedTurnId) {
          throw Object.assign(new Error("No matching active turn to steer."), { kind: "turnNotActive" });
        }
        const text = this.extractInputText(params["input"]);
        const steerItemId = randomUUID();
        this.upsertItem(
          session,
          {
            itemId: steerItemId,
            turnId: expectedTurnId,
            kind: "userMessage",
            status: "completed",
            revision: 1,
            text,
            steered: true,
            recordedAt: new Date().toISOString(),
          },
          true,
        );
        await this.hooks.onSteerTurn(session, expectedTurnId, text, this);
        return { ok: true };
      }

      case "turn/interrupt":
      case "turn/cancel": {
        const sessionId = this.requireSessionId(params);
        const session = this.sessions.get(sessionId);
        if (!session || !session.activeTurnId) {
          return { ok: true };
        }
        const retract = params["retract"] === true;
        await this.interruptActiveTurn(session, retract);
        return { ok: true };
      }

      case "turn/unqueue":
        return { ok: true };

      case "model/list": {
        const sessionId = str(params["sessionId"]);
        const session = sessionId ? (this.sessions.get(sessionId) ?? null) : null;
        const fromHook = await this.hooks.onListModels?.(session);
        if (fromHook && fromHook.models.length > 0) {
          const anyExplicitDefault = fromHook.models.some((m) => typeof m["isDefault"] === "boolean");
          const defaultIdx = anyExplicitDefault
            ? fromHook.models.findIndex((m) => m["isDefault"] === true)
            : 0;
          return {
            providerId: this.providerId,
            source: fromHook.source ?? "providerCatalog",
            models: fromHook.models.map((m, idx) => {
              const isDefault = anyExplicitDefault ? m["isDefault"] === true : idx === 0;
              const efforts = Array.isArray(m["supportedReasoningEfforts"])
                ? m["supportedReasoningEfforts"]
                : Array.isArray(m["variants"])
                  ? m["variants"]
                  : undefined;
              return {
                ...m,
                isDefault,
                isActive: session?.modelId ? m["modelId"] === session.modelId : idx === (defaultIdx >= 0 ? defaultIdx : 0),
                ...(typeof m["contextWindowTokens"] === "number" && m["contextLimit"] === undefined
                  ? { contextLimit: m["contextWindowTokens"] }
                  : {}),
                ...(efforts && m["variants"] === undefined ? { variants: efforts } : {}),
                ...(efforts && m["reasoningEffortVariants"] === undefined
                  ? { reasoningEffortVariants: efforts }
                  : {}),
              };
            }),
          };
        }
        const seeds = descriptorForProvider(this.providerId).fallbackModels;
        return {
          providerId: this.providerId,
          source: "bundledCatalog",
          models: seeds.map((seed, idx) => ({
            modelId: seed.modelId,
            displayLabel: seed.displayLabel,
            description: seed.description ?? "",
            providerId: this.providerId,
            isDefault: idx === 0,
            isActive: session?.modelId ? seed.modelId === session.modelId : idx === 0,
            ...(seed.supportedReasoningEfforts
              ? {
                  variants: seed.supportedReasoningEfforts,
                  supportedReasoningEfforts: seed.supportedReasoningEfforts,
                  reasoningEffortVariants: seed.supportedReasoningEfforts,
                }
              : {}),
            ...(seed.defaultReasoningEffort ? { defaultReasoningEffort: seed.defaultReasoningEffort } : {}),
            ...(seed.contextWindowTokens
              ? { contextWindowTokens: seed.contextWindowTokens, contextLimit: seed.contextWindowTokens }
              : {}),
          })),
        };
      }

      case "session/setModel": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        const rawModel = params["model"];
        const modelId = typeof rawModel === "string" ? rawModel : str(asRecord(rawModel)?.["modelId"]);
        if (!modelId) {
          throw new Error("modelId is required.");
        }
        await this.hooks.onSetModel?.(session, modelId);
        session.modelId = modelId;
        session.updatedAt = new Date().toISOString();
        this.emitDurable(session, "session/modelChanged", { modelId, source: "user" });
        return { modelId };
      }

      case "session/setApprovalMode": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        const mode = params["mode"];
        if (!isApprovalMode(mode)) {
          throw new Error("Invalid approval mode.");
        }
        await this.hooks.onSetApprovalMode?.(session, mode);
        session.approvalMode = mode;
        this.emitDurable(session, "session/approvalModeChanged", { mode });
        return { mode };
      }

      case "session/setReasoningEffort": {
        if (!this.capabilities.supportsReasoningEffort) {
          return { ok: true };
        }
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        const effort = params["reasoningEffort"];
        if (!isReasoningEffort(effort)) {
          throw new Error("Invalid reasoning effort.");
        }
        await this.hooks.onSetReasoningEffort?.(session, effort);
        session.reasoningEffort = effort;
        this.emitLive(session, "session/reasoningEffortChanged", { reasoningEffort: effort });
        return { reasoningEffort: effort };
      }

      case "session/rename": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        const name = str(params["name"]) ?? "";
        session.name = name;
        return { name };
      }

      case "session/compact": {
        if (!this.capabilities.supportsCompact || !this.hooks.onCompactSession) {
          throw new UnsupportedCapabilityError(this.providerId, "context compaction");
        }
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        return this.hooks.onCompactSession(session, this);
      }

      case "session/fork": {
        if (!this.capabilities.supportsFork) {
          throw new UnsupportedCapabilityError(this.providerId, "session forking");
        }
        const sourceId = this.requireSessionId(params);
        const source = this.ensureHydratedSession(sourceId, params);
        const newSessionId = randomUUID();
        const forked = await this.hooks.onForkSession?.(source, newSessionId, this);
        const now = new Date().toISOString();
        const clone: CanonicalSessionState = {
          sessionId: newSessionId,
          externalSessionId: forked?.externalSessionId ?? null,
          workspaceRoot: source.workspaceRoot,
          modelId: source.modelId,
          approvalMode: source.approvalMode,
          reasoningEffort: source.reasoningEffort,
          name: source.name ? `${source.name} (fork)` : null,
          createdAt: now,
          updatedAt: now,
          turnCount: source.turnCount,
          activeTurnId: null,
          activeTurnAbort: null,
          nextSeq: 1,
          events: [],
          items: new Map(),
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          sessionAllowedTools: new Set(source.sessionAllowedTools),
          cumulativePromptTokens: source.cumulativePromptTokens,
          cumulativeOutputTokens: source.cumulativeOutputTokens,
          contextWindowTokens: source.contextWindowTokens,
          lastUsedTokens: source.lastUsedTokens,
        };
        this.sessions.set(newSessionId, clone);
        this.emitDurable(clone, "session/started", { session: this.sessionSnapshot(clone) });
        for (const item of source.items.values()) {
          this.upsertItem(clone, { ...item }, true);
        }
        return { session: this.sessionSnapshot(clone) };
      }

      case "session/userShell": {
        const sessionId = this.requireSessionId(params);
        const session = this.ensureHydratedSession(sessionId, params);
        const commandText = str(params["commandText"]) ?? "";
        return this.runUserShell(session, commandText);
      }

      case "usage/read":
        return { usage: this.subscriptionUsage };

      case "item/readOutput": {
        const outputRef = str(params["outputRef"]);
        const buf = outputRef ? this.storedOutputs.get(outputRef) : undefined;
        if (!buf) {
          return { content: "", encoding: "utf8", mediaType: "text/plain", offsetBytes: 0, byteLen: 0, eof: true };
        }
        const offset = typeof params["offsetBytes"] === "number" ? Math.max(0, params["offsetBytes"]) : 0;
        const length = typeof params["lengthBytes"] === "number" ? Math.max(1, params["lengthBytes"]) : 64 * 1024;
        const slice = buf.subarray(offset, offset + length);
        return {
          content: slice.toString("utf8"),
          encoding: "utf8",
          mediaType: "text/plain",
          offsetBytes: offset,
          byteLen: slice.byteLength,
          eof: offset + slice.byteLength >= buf.byteLength,
        };
      }

      case "skill/list":
        return { skills: [] };

      default: {
        if (method.startsWith("goal/")) {
          throw new UnsupportedCapabilityError(this.providerId, "autonomous goals");
        }
        if (method.startsWith("subagent/") || method.startsWith("workflow/") || method.startsWith("task/")) {
          throw new UnsupportedCapabilityError(this.providerId, method);
        }
        throw new UnsupportedCapabilityError(this.providerId, method);
      }
    }
  }

  // ------------------------------------------------------------------ Turn & Item Helpers for Drivers

  recordModelResolved(session: CanonicalSessionState, modelId: string): void {
    if (!modelId || session.modelId === modelId) {
      return;
    }
    session.modelId = modelId;
    session.updatedAt = new Date().toISOString();
    this.emitDurable(session, "session/modelChanged", { modelId, source: "provider" });
  }

  startAgentMessage(session: CanonicalSessionState, turnId: string, itemId = randomUUID()): string {
    this.upsertItem(
      session,
      {
        itemId,
        turnId,
        kind: "agentMessage",
        status: "inProgress",
        revision: 1,
        text: "",
        recordedAt: new Date().toISOString(),
      },
      false,
    );
    return itemId;
  }

  deltaAgentMessage(session: CanonicalSessionState, turnId: string, itemId: string, delta: string): void {
    if (!delta) return;
    const item = session.items.get(itemId);
    if (item) {
      item["text"] = `${typeof item["text"] === "string" ? item["text"] : ""}${delta}`;
      item["revision"] = Number(item["revision"] ?? 1) + 1;
    }
    this.emitLive(session, "item/delta", { turnId, itemId, field: "text", delta });
  }

  completeAgentMessage(session: CanonicalSessionState, turnId: string, itemId: string, finalText?: string): void {
    const existing = session.items.get(itemId);
    const text = finalText !== undefined ? finalText : (typeof existing?.["text"] === "string" ? existing["text"] : "");
    this.upsertItem(
      session,
      {
        ...(existing ?? {}),
        itemId,
        turnId,
        kind: "agentMessage",
        status: "completed",
        revision: Number(existing?.["revision"] ?? 1) + 1,
        text,
        recordedAt: (existing?.["recordedAt"] as string | undefined) ?? new Date().toISOString(),
      },
      true,
    );
  }

  startReasoning(session: CanonicalSessionState, turnId: string, itemId = randomUUID()): string {
    this.upsertItem(
      session,
      {
        itemId,
        turnId,
        kind: "reasoning",
        status: "inProgress",
        revision: 1,
        summary: [""],
        recordedAt: new Date().toISOString(),
      },
      false,
    );
    return itemId;
  }

  deltaReasoning(session: CanonicalSessionState, turnId: string, itemId: string, delta: string): void {
    if (!delta) return;
    const item = session.items.get(itemId);
    if (item) {
      const summary = Array.isArray(item["summary"]) ? [...(item["summary"] as string[])] : [""];
      summary[0] = `${summary[0] ?? ""}${delta}`;
      item["summary"] = summary;
      item["revision"] = Number(item["revision"] ?? 1) + 1;
    }
    this.emitLive(session, "item/delta", { turnId, itemId, field: "summary.0", delta });
  }

  completeReasoning(session: CanonicalSessionState, turnId: string, itemId: string, finalSummary?: string[]): void {
    const existing = session.items.get(itemId);
    const summary = finalSummary ?? (Array.isArray(existing?.["summary"]) ? (existing["summary"] as string[]) : []);
    this.upsertItem(
      session,
      {
        ...(existing ?? {}),
        itemId,
        turnId,
        kind: "reasoning",
        status: "completed",
        revision: Number(existing?.["revision"] ?? 1) + 1,
        summary,
        recordedAt: (existing?.["recordedAt"] as string | undefined) ?? new Date().toISOString(),
      },
      true,
    );
  }

  startToolCall(
    session: CanonicalSessionState,
    turnId: string,
    options: {
      itemId?: string;
      tool: string;
      args?: string;
      commandText?: string;
      extra?: Record<string, unknown>;
    },
  ): string {
    const itemId = options.itemId ?? randomUUID();
    this.upsertItem(
      session,
      {
        ...(options.extra ?? {}),
        itemId,
        turnId,
        kind: "toolCall",
        status: "inProgress",
        revision: 1,
        tool: options.tool,
        ...(options.args !== undefined ? { args: options.args } : {}),
        ...(options.commandText !== undefined ? { commandText: options.commandText } : {}),
        visibleOutput: "",
        recordedAt: new Date().toISOString(),
      },
      false,
    );
    return itemId;
  }

  deltaToolOutput(session: CanonicalSessionState, turnId: string, itemId: string, delta: string): void {
    if (!delta) return;
    const item = session.items.get(itemId);
    if (item) {
      const prev = typeof item["visibleOutput"] === "string" ? item["visibleOutput"] : "";
      const combined = prev + delta;
      item["visibleOutput"] =
        combined.length > MAX_VISIBLE_OUTPUT_BYTES ? combined.slice(0, MAX_VISIBLE_OUTPUT_BYTES) : combined;
      item["truncated"] = combined.length > MAX_VISIBLE_OUTPUT_BYTES;
      item["revision"] = Number(item["revision"] ?? 1) + 1;
    }
    this.emitLive(session, "item/delta", { turnId, itemId, field: "output", delta });
  }

  completeToolCall(
    session: CanonicalSessionState,
    turnId: string,
    itemId: string,
    outcome: {
      status?: "completed" | "failed" | "cancelled";
      output?: string;
      exitCode?: number | null;
      durationMs?: number;
      failureReason?: string;
      extra?: Record<string, unknown>;
    } = {},
  ): void {
    const existing = session.items.get(itemId);
    const fullOutput =
      outcome.output !== undefined
        ? outcome.output
        : typeof existing?.["visibleOutput"] === "string"
          ? existing["visibleOutput"]
          : "";
    let visibleOutput = fullOutput;
    let truncated = Boolean(existing?.["truncated"]);
    let outputRef: Record<string, unknown> | undefined;

    const byteLen = Buffer.byteLength(fullOutput, "utf8");
    if (byteLen > MAX_VISIBLE_OUTPUT_BYTES) {
      truncated = true;
      visibleOutput = Buffer.from(fullOutput, "utf8").subarray(0, MAX_VISIBLE_OUTPUT_BYTES).toString("utf8");
      const refId = `out_${itemId}`;
      this.rememberOutput(refId, Buffer.from(fullOutput, "utf8"));
      outputRef = {
        id: refId,
        kind: "toolOutput",
        mediaType: "text/plain",
        byteLen,
        availability: "available",
      };
    }

    this.upsertItem(
      session,
      {
        ...(existing ?? {}),
        ...(outcome.extra ?? {}),
        itemId,
        turnId,
        kind: "toolCall",
        status: outcome.status ?? "completed",
        revision: Number(existing?.["revision"] ?? 1) + 1,
        visibleOutput,
        truncated,
        ...(outputRef ? { outputRef } : {}),
        ...(outcome.exitCode !== undefined && outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
        ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
        ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
        recordedAt: (existing?.["recordedAt"] as string | undefined) ?? new Date().toISOString(),
      },
      true,
    );
  }

  emitTodoList(
    session: CanonicalSessionState,
    turnId: string,
    items: { content: string; status: string; id?: string }[],
  ): void {
    this.emitDurable(session, "session/todoListChanged", {
      turnId,
      items: items.map((item, idx) => ({
        id: item.id ?? `todo_${idx + 1}`,
        text: item.content,
        content: item.content,
        status: item.status,
      })),
    });
  }

  recordTokenUsage(
    session: CanonicalSessionState,
    turnId: string,
    usage: {
      modelId?: string | null;
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      durationMs?: number | null;
      contextWindowTokens?: number | null;
    },
  ): void {
    const promptTokens = Math.max(0, usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
    const outTokens = Math.max(0, usage.outputTokens);
    session.cumulativePromptTokens += promptTokens;
    session.cumulativeOutputTokens += outTokens;
    session.lastUsedTokens = promptTokens + outTokens;
    if (usage.contextWindowTokens) {
      session.contextWindowTokens = usage.contextWindowTokens;
    }

    this.emitDurable(session, "session/tokenUsage", {
      turnId,
      modelId: usage.modelId ?? session.modelId,
      promptTokens,
      totalTokens: promptTokens + outTokens,
      durationMs: usage.durationMs ?? null,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: outTokens,
        cachedTokens: usage.cachedTokens ?? usage.cacheReadTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
      },
      cumulative: {
        promptTokens: session.cumulativePromptTokens,
        outputTokens: session.cumulativeOutputTokens,
        totalTokens: session.cumulativePromptTokens + session.cumulativeOutputTokens,
      },
    });

    if (session.contextWindowTokens) {
      const ratio = session.lastUsedTokens / session.contextWindowTokens;
      this.emitLive(session, "session/contextUsage", {
        usedTokens: session.lastUsedTokens,
        windowTokens: session.contextWindowTokens,
        pressure: ratio >= 0.85 ? "high" : ratio >= 0.65 ? "elevated" : "normal",
      });
    }
  }

  async requestApproval(
    session: CanonicalSessionState,
    turnId: string,
    spec: {
      approvalId?: string;
      itemId?: string;
      toolName: string;
      rawArgs?: string;
      subject: {
        kind: "command" | "fileWrite" | "fileAccess" | "network" | "tool";
        command?: string;
        path?: string;
        host?: string;
        toolName?: string;
      };
      choices?: { choiceId: string; label: string; decision: "approved" | "approvedForSession" | "denied" | "allow" | "deny"; scope: "once" | "session"; acceptsFeedback?: boolean }[];
    },
  ): Promise<{ allow: boolean; scope: "once" | "session"; choiceId: string; feedback: string | null }> {
    if (session.approvalMode === "allowAll" || session.sessionAllowedTools.has(spec.toolName)) {
      return { allow: true, scope: "session", choiceId: "allow_session", feedback: null };
    }
    if (session.approvalMode === "denyUnmatched") {
      return { allow: false, scope: "once", choiceId: "deny_once", feedback: "Denied by session approval policy." };
    }

    const approvalId = spec.approvalId ?? randomUUID();
    const requirementId = `req_${approvalId}`;
    const availableChoices = spec.choices ?? [
      { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
      { choiceId: "allow_session", label: "Allow for session", decision: "approvedForSession", scope: "session" },
      { choiceId: "deny_once", label: "Deny", decision: "denied", scope: "once", acceptsFeedback: true },
    ];
    const requestPayload: Record<string, unknown> = {
      approvalId,
      sessionId: session.sessionId,
      turnId,
      ...(spec.itemId ? { itemId: spec.itemId } : {}),
      toolName: spec.toolName,
      rawArgs: spec.rawArgs ?? "",
      currentRequirementId: requirementId,
      availableChoices,
      subject: {
        ...spec.subject,
        workspaceRoot: session.workspaceRoot,
      },
    };

    return new Promise((resolve) => {
      session.pendingApprovals.set(approvalId, { request: requestPayload, resolve });
      this.emitDurable(session, "approval/requested", requestPayload);
    });
  }

  async requestUserInput(
    session: CanonicalSessionState,
    turnId: string,
    spec: {
      userInputId?: string;
      itemId?: string;
      toolName?: string;
      questions: {
        id: string;
        header: string;
        question: string;
        options: { label: string; description?: string }[];
        multiSelect?: boolean;
      }[];
    },
  ): Promise<{
    kind: "answered" | "cancelled" | "clarified";
    answers: UserInputAnswerItem[];
    reason?: string;
    clarification?: string;
  }> {
    const userInputId = spec.userInputId ?? randomUUID();
    const requestPayload: Record<string, unknown> = {
      userInputId,
      sessionId: session.sessionId,
      turnId,
      ...(spec.itemId ? { itemId: spec.itemId } : {}),
      ...(spec.toolName ? { toolName: spec.toolName } : {}),
      questions: spec.questions.map((q) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        options: q.options,
        selection: { mode: q.multiSelect ? "multiple" : "single" },
      })),
    };
    return new Promise((resolve) => {
      session.pendingUserInputs.set(userInputId, { request: requestPayload, resolve });
      this.emitDurable(session, "userInput/requested", requestPayload);
    });
  }

  // ------------------------------------------------------------------ Internal Mechanics

  private async executeTurn(ctx: CanonicalTurnContext, startedAtMs: number): Promise<void> {
    const { session, turnId } = ctx;
    try {
      await this.hooks.onRunTurn(ctx, this);
      if (session.activeTurnId === turnId) {
        session.activeTurnId = null;
        session.activeTurnAbort = null;
        session.turnCount += 1;
        session.updatedAt = new Date().toISOString();
        this.emitDurable(session, "turn/completed", {
          turnId,
          terminal: ctx.signal.aborted ? "cancelled" : "completed",
          durationMs: Date.now() - startedAtMs,
        });
      }
    } catch (error) {
      const aborted = ctx.signal.aborted;
      this.settlePendingForTurn(session, "Turn ended before pending request was answered.");
      if (session.activeTurnId === turnId) {
        session.activeTurnId = null;
        session.activeTurnAbort = null;
        if (!aborted) {
          session.turnCount += 1;
        }
        session.updatedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        const kind = this.classifyTurnError(message);
        this.emitDurable(session, "turn/completed", {
          turnId,
          terminal: aborted ? "cancelled" : "failed",
          durationMs: Date.now() - startedAtMs,
          ...(aborted
            ? {}
            : {
                error: {
                  kind,
                  message,
                  retryable: kind === "rate_limited" || kind === "timeout",
                },
              }),
        });
      }
    }
  }

  private async interruptActiveTurn(session: CanonicalSessionState, retract: boolean): Promise<void> {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    session.activeTurnAbort?.abort();
    this.settlePendingForTurn(session, "Turn interrupted.");
    try {
      await this.hooks.onInterruptTurn?.(session, turnId, retract);
    } catch {
      /* best effort */
    }
    if (session.activeTurnId === turnId) {
      session.activeTurnId = null;
      session.activeTurnAbort = null;
      if (retract) {
        this.emitDurable(session, "turn/retracted", { turnId });
      }
      this.emitDurable(session, "turn/completed", {
        turnId,
        terminal: "cancelled",
      });
    }
  }

  private settlePendingForTurn(session: CanonicalSessionState, reason: string): void {
    for (const [approvalId, pending] of session.pendingApprovals) {
      session.pendingApprovals.delete(approvalId);
      this.emitDurable(session, "approval/resolved", {
        approvalId,
        decision: "denied",
        resolvedBy: "system",
      });
      pending.resolve({ allow: false, scope: "once", choiceId: "deny_once", feedback: reason });
    }
    for (const [userInputId, pending] of session.pendingUserInputs) {
      session.pendingUserInputs.delete(userInputId);
      this.emitDurable(session, "userInput/settled", {
        userInputId,
        outcome: "cancelled",
        answers: [],
      });
      pending.resolve({ kind: "cancelled", answers: [], reason });
    }
  }

  upsertItem(session: CanonicalSessionState, item: Record<string, unknown>, persistToJournal: boolean): void {
    const itemId = String(item["itemId"]);
    const existed = session.items.has(itemId);
    session.items.set(itemId, item);
    const status = String(item["status"] ?? "completed");
    const method = !existed
      ? status === "inProgress"
        ? "item/started"
        : "item/completed"
      : status === "inProgress"
        ? "item/updated"
        : "item/completed";
    if (persistToJournal) {
      this.emitDurable(session, method, { item });
    } else {
      this.emitLive(session, method, { item });
    }
  }

  emitDurable(session: CanonicalSessionState, method: string, payload: Record<string, unknown>): void {
    const seq = session.nextSeq++;
    const at = new Date().toISOString();
    const viewCursor = `v:${session.sessionId}:${seq}`;
    const withEnvelope: Record<string, unknown> = {
      ...payload,
      sessionId: session.sessionId,
      viewCursor,
      sourceRange: { start: seq, end: seq },
    };
    session.events.push({ seq, method, params: withEnvelope, at });
    try {
      this.hooks.journal?.append(session.sessionId, method, withEnvelope, at);
    } catch {
      /* journal persistence is best effort */
    }
    this.broadcast({
      method,
      params: withEnvelope,
      emittedAtMs: Date.parse(at),
    });
  }

  emitLive(session: CanonicalSessionState, method: string, payload: Record<string, unknown>): void {
    this.broadcast({
      method,
      params: {
        ...payload,
        sessionId: session.sessionId,
      },
      emittedAtMs: Date.now(),
    });
  }

  private broadcast(notification: MspNotification): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(notification);
      } catch {
        /* ignore */
      }
    }
  }

  private ensureHydratedSession(sessionId: string, params: Record<string, unknown>): CanonicalSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const storedEvents = this.hooks.journal?.list(sessionId) ?? [];
    const now = new Date().toISOString();
    const session: CanonicalSessionState = {
      sessionId,
      externalSessionId: null,
      workspaceRoot: str(params["workspaceRoot"]) ?? process.cwd(),
      modelId: null,
      approvalMode: "onRequest",
      reasoningEffort: null,
      name: null,
      createdAt: storedEvents[0]?.at ?? now,
      updatedAt: storedEvents[storedEvents.length - 1]?.at ?? now,
      turnCount: 0,
      activeTurnId: null,
      activeTurnAbort: null,
      nextSeq: 1,
      events: [],
      items: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      sessionAllowedTools: new Set(),
      cumulativePromptTokens: 0,
      cumulativeOutputTokens: 0,
      contextWindowTokens: null,
      lastUsedTokens: 0,
    };

    for (const ev of storedEvents) {
      session.events.push({ seq: ev.seq, method: ev.method, params: ev.params, at: ev.at });
      session.nextSeq = Math.max(session.nextSeq, ev.seq + 1);
      if (ev.method === "session/started") {
        const snap = asRecord(ev.params["session"]);
        if (snap) {
          session.workspaceRoot = str(snap["workspaceRoot"]) ?? session.workspaceRoot;
          session.modelId = str(snap["modelId"]) ?? session.modelId;
          session.externalSessionId = str(snap["externalSessionId"]) ?? session.externalSessionId;
          const mode = asRecord(snap["approvalMode"])?.["mode"];
          if (isApprovalMode(mode)) session.approvalMode = mode;
        }
      } else if (ev.method === "session/modelChanged") {
        session.modelId = str(ev.params["modelId"]) ?? session.modelId;
      } else if (ev.method === "session/approvalModeChanged") {
        const mode = ev.params["mode"];
        if (isApprovalMode(mode)) session.approvalMode = mode;
      } else if (ev.method === "item/started" || ev.method === "item/updated" || ev.method === "item/completed") {
        const item = asRecord(ev.params["item"]);
        const itemId = item ? str(item["itemId"]) : null;
        if (item && itemId) {
          session.items.set(itemId, item);
        }
      } else if (ev.method === "turn/completed") {
        session.turnCount += 1;
      } else if (ev.method === "session/tokenUsage") {
        const cum = asRecord(ev.params["cumulative"]);
        if (cum) {
          session.cumulativePromptTokens = Number(cum["promptTokens"] ?? session.cumulativePromptTokens);
          session.cumulativeOutputTokens = Number(cum["outputTokens"] ?? session.cumulativeOutputTokens);
        }
      }
    }

    this.sessions.set(sessionId, session);
    return session;
  }

  private sessionSnapshot(session: CanonicalSessionState): Record<string, unknown> {
    return {
      sessionId: session.sessionId,
      ...(session.externalSessionId ? { externalSessionId: session.externalSessionId } : {}),
      providerId: this.providerId,
      status: session.activeTurnId ? "running" : "idle",
      activeTurnId: session.activeTurnId,
      modelId: session.modelId,
      approvalMode: { mode: session.approvalMode },
      workspaceRoot: session.workspaceRoot,
      turnCount: session.turnCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      contextUsage: session.contextWindowTokens
        ? {
            usedTokens: session.lastUsedTokens,
            windowTokens: session.contextWindowTokens,
            pressure: "normal",
          }
        : null,
      tokenUsage: {
        promptTokens: session.cumulativePromptTokens,
        outputTokens: session.cumulativeOutputTokens,
        totalTokens: session.cumulativePromptTokens + session.cumulativeOutputTokens,
      },
    };
  }

  private async runUserShell(session: CanonicalSessionState, commandText: string): Promise<unknown> {
    const itemId = randomUUID();
    const startedAt = Date.now();
    this.upsertItem(
      session,
      {
        itemId,
        kind: "userShell",
        status: "inProgress",
        revision: 1,
        commandText,
        visibleOutput: "",
        recordedAt: new Date().toISOString(),
      },
      false,
    );

    const result = await new Promise<{ output: string; exitCode: number | null }>((resolve) => {
      const isWin = process.platform === "win32";
      const child = isWin
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", commandText], {
            cwd: session.workspaceRoot,
            windowsHide: true,
          })
        : spawn("sh", ["-lc", commandText], {
            cwd: session.workspaceRoot,
          });
      let out = "";
      child.stdout.on("data", (c: Buffer) => {
        const text = c.toString("utf8");
        out += text;
        this.emitLive(session, "item/delta", { itemId, field: "output", delta: text });
      });
      child.stderr.on("data", (c: Buffer) => {
        const text = c.toString("utf8");
        out += text;
        this.emitLive(session, "item/delta", { itemId, field: "output", delta: text });
      });
      child.on("error", (err) => resolve({ output: `${out}${err.message}\n`, exitCode: 1 }));
      child.on("close", (code) => resolve({ output: out, exitCode: code }));
    });

    this.upsertItem(
      session,
      {
        itemId,
        kind: "userShell",
        status: "completed",
        revision: 2,
        commandText,
        visibleOutput: result.output.slice(0, MAX_VISIBLE_OUTPUT_BYTES),
        truncated: result.output.length > MAX_VISIBLE_OUTPUT_BYTES,
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        durationMs: Date.now() - startedAt,
        recordedAt: new Date().toISOString(),
      },
      true,
    );
    return { itemId, exitCode: result.exitCode };
  }

  private rememberOutput(id: string, bytes: Buffer): void {
    this.storedOutputs.set(id, bytes);
    while (this.storedOutputs.size > MAX_STORED_OUTPUTS) {
      const oldest = this.storedOutputs.keys().next().value;
      if (!oldest) break;
      this.storedOutputs.delete(oldest);
    }
  }

  private extractInputText(input: unknown): string {
    if (typeof input === "string") {
      return input;
    }
    if (!Array.isArray(input)) {
      return "";
    }
    const parts: string[] = [];
    for (const part of input) {
      const r = asRecord(part);
      if (r && r["type"] === "text" && typeof r["text"] === "string") {
        parts.push(r["text"]);
      }
    }
    return parts.join("\n");
  }

  private extractInputImages(input: unknown): TurnImage[] {
    if (!Array.isArray(input)) {
      return [];
    }
    const images: TurnImage[] = [];
    for (const part of input) {
      const r = asRecord(part);
      if (r && r["type"] === "image" && typeof r["base64Data"] === "string" && typeof r["mediaType"] === "string") {
        images.push({
          base64Data: r["base64Data"],
          mediaType: r["mediaType"],
          ...(typeof r["width"] === "number" ? { width: r["width"] } : {}),
          ...(typeof r["height"] === "number" ? { height: r["height"] } : {}),
        });
      }
    }
    return images;
  }

  private classifyTurnError(message: string): string {
    if (/unauthorized|unauthenticated|not logged in|invalid api key|auth|login/i.test(message)) {
      return "auth";
    }
    if (/quota|usage limit|billing|insufficient_quota|credit balance/i.test(message)) {
      return "quota";
    }
    if (/rate limit|429|too many requests/i.test(message)) {
      return "rate_limited";
    }
    if (/timed? out|timeout/i.test(message)) {
      return "timeout";
    }
    return "error";
  }

  private requireSessionId(params: Record<string, unknown>): string {
    const id = str(params["sessionId"]);
    if (!id) {
      throw new Error("sessionId is required.");
    }
    return id;
  }

  private requireLoadedSession(sessionId: string): CanonicalSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session ${sessionId} is not loaded.`), { kind: "sessionNotLoaded" });
    }
    return session;
  }
}
