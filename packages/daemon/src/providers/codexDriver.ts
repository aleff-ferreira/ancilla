import { randomUUID } from "node:crypto";
import type { ServeExit, ServeTarget } from "../mspHost.js";
import type { ApprovalMode, CommandConnection, SubscriptionUsage } from "../sessions.js";
import {
  CanonicalSessionRuntime,
  type CanonicalSessionState,
  type CanonicalTurnContext,
} from "./canonicalRuntime.js";
import { StdioJsonRpcPeer, type StdioJsonRpcPeerOptions } from "./jsonRpcStdio.js";
import {
  CODEX_CAPABILITIES,
  type AgentHost,
  type AgentHostStartResult,
  type ProviderCapabilities,
  type SessionJournal,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapCodexApprovalPolicy(mode: ApprovalMode): string {
  switch (mode) {
    case "allowAll":
      return "never";
    case "denyUnmatched":
      return "untrusted";
    case "onRequest":
    case "promptUnmatched":
    default:
      return "on-request";
  }
}

interface ActiveCodexTurn {
  canonicalTurnId: string;
  externalTurnId: string | null;
  startedAtMs: number;
  itemMap: Map<string, string>;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface CodexAppServerHostOptions extends StdioJsonRpcPeerOptions {
  journal?: SessionJournal;
}

/**
 * OpenAI Codex CLI (`codex app-server --listen stdio://`) host over JSON-RPC 2.0 JSONL.
 * Supports ChatGPT Plus, Pro, Team, Edu, and Enterprise logins via `codex login`.
 */
export class CodexAppServerHost implements AgentHost {
  readonly providerId = "codex" as const;
  readonly capabilities: ProviderCapabilities = CODEX_CAPABILITIES;
  private readonly peer: StdioJsonRpcPeer;
  private readonly runtime: CanonicalSessionRuntime;
  private readonly activeTurns = new Map<string, ActiveCodexTurn>();

  constructor(
    target: ServeTarget,
    options: CodexAppServerHostOptions = {},
  ) {
    this.peer = new StdioJsonRpcPeer(target, options);
    this.runtime = new CanonicalSessionRuntime({
      providerId: this.providerId,
      capabilities: this.capabilities,
      journal: options.journal,
      onStartSession: (opts) => this.handleStartSession(opts),
      onResumeSession: (session) => this.handleResumeSession(session),
      onRunTurn: (ctx) => this.handleRunTurn(ctx),
      onSteerTurn: (session, _turnId, text) => this.handleSteerTurn(session, text),
      onInterruptTurn: (session) => this.handleInterruptTurn(session),
      onListModels: () => this.handleListModels(),
      onCompactSession: (session) => this.handleCompactSession(session),
      onForkSession: (source) => this.handleForkSession(source),
    });

    this.peer.onProtocolError((err) => this.runtime.reportProtocolError(err));
    this.peer.onNotification((method, params) => this.handleNotification(method, params));
    this.peer.onRequest((method, params) => this.handleServerRequest(method, params));
  }

  get connection(): CommandConnection {
    return this.runtime;
  }

  get recentStderr(): string {
    return this.peer.recentStderr;
  }

  onExit(handler: (exit: ServeExit) => void): void {
    this.peer.onExit(handler);
  }

  async start(clientVersion: string): Promise<AgentHostStartResult> {
    this.peer.spawn();
    try {
      const initResult = await this.peer.request<Record<string, unknown>>(
        "initialize",
        {
          clientInfo: {
            name: "ancilla",
            title: "Ancilla",
            version: clientVersion,
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        this.peer.startTimeoutMs,
      );
      this.peer.notify("initialized", {});
      void this.refreshRateLimits();
      const record = asRecord(initResult);
      return {
        initializeResult: {
          ...record,
          serverInfo: {
            name: "codex-app-server",
            version: str(record?.["userAgent"]) ?? "codex",
          },
        },
        fingerprintWarning: null,
      };
    } catch (error) {
      await this.peer.close().catch(() => undefined);
      throw error;
    }
  }

  close(): Promise<ServeExit> {
    for (const [threadId, active] of this.activeTurns) {
      this.activeTurns.delete(threadId);
      active.reject(new Error("Codex app-server host closed."));
    }
    return this.peer.close();
  }

  // ------------------------------------------------------------------ Session & Turn Hooks

  private async handleStartSession(opts: {
    sessionId: string;
    workspaceRoot: string;
    approvalMode: ApprovalMode;
    modelId: string | null;
  }): Promise<{ externalSessionId?: string | null; modelId?: string | null }> {
    const res = asRecord(
      await this.peer.request("thread/start", {
        cwd: opts.workspaceRoot,
        approvalPolicy: mapCodexApprovalPolicy(opts.approvalMode),
        ...(opts.modelId ? { model: opts.modelId } : {}),
      }),
    );
    const thread = asRecord(res?.["thread"]);
    const threadId = str(thread?.["id"]) ?? str(res?.["threadId"]);
    const model = str(res?.["model"]) ?? opts.modelId;
    return { externalSessionId: threadId, modelId: model };
  }

  private async handleResumeSession(
    session: CanonicalSessionState,
  ): Promise<{ externalSessionId?: string | null; modelId?: string | null }> {
    if (session.externalSessionId) {
      try {
        const res = asRecord(
          await this.peer.request("thread/resume", {
            threadId: session.externalSessionId,
          }),
        );
        const thread = asRecord(res?.["thread"]);
        return {
          externalSessionId: str(thread?.["id"]) ?? session.externalSessionId,
          modelId: str(res?.["model"]) ?? session.modelId,
        };
      } catch {
        /* Fall back to starting a fresh thread */
      }
    }
    return this.handleStartSession({
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      approvalMode: session.approvalMode,
      modelId: session.modelId,
    });
  }

  private async handleForkSession(source: CanonicalSessionState): Promise<{ externalSessionId?: string | null }> {
    if (source.externalSessionId) {
      try {
        const res = asRecord(
          await this.peer.request("thread/fork", {
            threadId: source.externalSessionId,
          }),
        );
        const thread = asRecord(res?.["thread"]);
        return { externalSessionId: str(thread?.["id"]) };
      } catch {
        /* Fall back to fresh thread */
      }
    }
    const created = await this.handleStartSession({
      sessionId: randomUUID(),
      workspaceRoot: source.workspaceRoot,
      approvalMode: source.approvalMode,
      modelId: source.modelId,
    });
    return { externalSessionId: created.externalSessionId };
  }

  private async handleCompactSession(session: CanonicalSessionState): Promise<unknown> {
    if (!session.externalSessionId) {
      return { ok: true };
    }
    return this.peer.request("thread/compact/start", { threadId: session.externalSessionId });
  }

  private async handleListModels(): Promise<{ models: Record<string, unknown>[]; source?: string } | null> {
    try {
      const rawEntries: Record<string, unknown>[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const res = asRecord(await this.peer.request("model/list", cursor ? { cursor } : {}));
        const rows = Array.isArray(res?.["data"])
          ? res["data"]
          : Array.isArray(res?.["models"])
            ? res["models"]
            : [];
        for (const entry of rows) {
          const m = asRecord(entry);
          if (m && m["hidden"] !== true) {
            rawEntries.push(m);
          }
        }
        const nextCursor = str(res?.["nextCursor"]);
        if (!nextCursor || nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;
      }
      const anyExplicitDefault = rawEntries.some((m) => typeof m["isDefault"] === "boolean");
      const models: Record<string, unknown>[] = [];
      for (const m of rawEntries) {
        const id = str(m["model"]) ?? str(m["id"]) ?? str(m["modelId"]);
        if (!id) continue;
        const effortsRaw = Array.isArray(m["supportedReasoningEfforts"]) ? m["supportedReasoningEfforts"] : [];
        const efforts = effortsRaw
          .map((e) => {
            if (typeof e === "string") return e;
            const rec = asRecord(e);
            return str(rec?.["reasoningEffort"]) ?? str(rec?.["tier"]);
          })
          .filter((e): e is string => Boolean(e));
        const contextLimit =
          num(m["contextWindow"]) ??
          num(m["contextWindowTokens"]) ??
          num(m["contextLimit"]) ??
          num(m["maxInputTokens"]) ??
          num(m["inputTokenLimit"]);
        const outputLimit = num(m["maxOutputTokens"]) ?? num(m["outputLimit"]) ?? num(m["outputTokenLimit"]);
        models.push({
          modelId: id,
          displayLabel: str(m["displayName"]) ?? str(m["displayLabel"]) ?? id,
          description: str(m["description"]) ?? "",
          providerId: this.providerId,
          ...(anyExplicitDefault ? { isDefault: m["isDefault"] === true } : {}),
          ...(contextLimit !== null ? { contextLimit, contextWindowTokens: contextLimit } : {}),
          ...(outputLimit !== null ? { outputLimit } : {}),
          ...(efforts.length > 0 ? { variants: efforts, supportedReasoningEfforts: efforts } : {}),
          ...(str(m["defaultReasoningEffort"]) ? { defaultReasoningEffort: str(m["defaultReasoningEffort"]) } : {}),
        });
      }
      return models.length > 0 ? { models, source: "providerCatalog" } : null;
    } catch {
      return null;
    }
  }

  private async handleRunTurn(ctx: CanonicalTurnContext): Promise<void> {
    const { session, turnId, prompt, images, reasoningEffort } = ctx;
    if (!session.externalSessionId) {
      const created = await this.handleStartSession({
        sessionId: session.sessionId,
        workspaceRoot: session.workspaceRoot,
        approvalMode: session.approvalMode,
        modelId: session.modelId,
      });
      session.externalSessionId = created.externalSessionId ?? null;
    }
    const threadId = session.externalSessionId;
    if (!threadId) {
      throw new Error("Codex app-server did not return a threadId.");
    }

    const input: Record<string, unknown>[] = [];
    if (prompt.length > 0) {
      input.push({ type: "text", text: prompt });
    }
    for (const img of images) {
      input.push({
        type: "image",
        url: `data:${img.mediaType};base64,${img.base64Data}`,
      });
    }

    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    const active: ActiveCodexTurn = {
      canonicalTurnId: turnId,
      externalTurnId: null,
      startedAtMs: Date.now(),
      itemMap: new Map(),
      resolve: resolveDone,
      reject: rejectDone,
    };
    this.activeTurns.set(threadId, active);

    try {
      const reply = asRecord(
        await this.peer.request("turn/start", {
          threadId,
          input,
          cwd: session.workspaceRoot,
          approvalPolicy: mapCodexApprovalPolicy(session.approvalMode),
          ...(session.modelId ? { model: session.modelId } : {}),
          ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        }),
      );
      const turnObj = asRecord(reply?.["turn"]);
      active.externalTurnId = str(turnObj?.["id"]) ?? str(reply?.["turnId"]);
      if (turnObj?.["status"] === "completed") {
        active.resolve();
      } else if (turnObj?.["status"] === "failed") {
        const errMsg = str(asRecord(turnObj["error"])?.["message"]) ?? "Codex turn failed.";
        active.reject(new Error(errMsg));
      }
      await done;
    } finally {
      this.activeTurns.delete(threadId);
    }
  }

  private async handleSteerTurn(session: CanonicalSessionState, text: string): Promise<void> {
    const threadId = session.externalSessionId;
    const active = threadId ? this.activeTurns.get(threadId) : undefined;
    if (!threadId || !active?.externalTurnId) {
      throw new Error("No active Codex turn to steer.");
    }
    await this.peer.request("turn/steer", {
      threadId,
      expectedTurnId: active.externalTurnId,
      input: [{ type: "text", text }],
    });
  }

  private async handleInterruptTurn(session: CanonicalSessionState): Promise<void> {
    const threadId = session.externalSessionId;
    const active = threadId ? this.activeTurns.get(threadId) : undefined;
    if (!threadId) return;
    await this.peer
      .request("turn/interrupt", {
        threadId,
        ...(active?.externalTurnId ? { turnId: active.externalTurnId } : {}),
      })
      .catch(() => undefined);
    active?.resolve();
  }

  // ------------------------------------------------------------------ Notifications & Approvals

  private handleNotification(method: string, rawParams: unknown): void {
    const params = asRecord(rawParams) ?? {};

    if (method === "account/rateLimits/updated") {
      const parsed = this.parseRateLimits(params["rateLimits"] ?? params);
      if (parsed) {
        this.runtime.updateSubscriptionUsage(parsed);
      }
      return;
    }

    const threadId = str(params["threadId"]) ?? str(asRecord(params["thread"])?.["id"]);
    if (!threadId) return;
    const session = this.runtime.findByExternalSessionId(threadId);
    const active = this.activeTurns.get(threadId);
    if (!session) return;
    const turnId = active?.canonicalTurnId ?? session.activeTurnId ?? "turn";

    switch (method) {
      case "turn/started": {
        const turnObj = asRecord(params["turn"]);
        if (active && turnObj && str(turnObj["id"])) {
          active.externalTurnId = str(turnObj["id"]);
        }
        break;
      }

      case "item/started": {
        const item = asRecord(params["item"]);
        const extItemId = item ? str(item["id"]) : null;
        const itemType = item ? str(item["type"]) : null;
        if (!item || !extItemId || !itemType || !active) break;

        if (itemType === "agentMessage") {
          const canonicalId = this.runtime.startAgentMessage(session, turnId);
          active.itemMap.set(extItemId, canonicalId);
        } else if (itemType === "reasoning") {
          const canonicalId = this.runtime.startReasoning(session, turnId);
          active.itemMap.set(extItemId, canonicalId);
        } else if (itemType === "commandExecution") {
          const cmd = str(item["command"]) ?? "";
          const canonicalId = this.runtime.startToolCall(session, turnId, {
            tool: "shell",
            commandText: cmd,
            args: JSON.stringify({ command: cmd, cwd: str(item["cwd"]) }),
          });
          active.itemMap.set(extItemId, canonicalId);
        } else if (itemType === "fileChange") {
          const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
          const canonicalId = this.runtime.startToolCall(session, turnId, {
            tool: "edit_file",
            args: JSON.stringify({ changes }),
          });
          active.itemMap.set(extItemId, canonicalId);
        } else if (itemType === "webSearch") {
          const query = str(item["query"]) ?? "";
          const canonicalId = this.runtime.startToolCall(session, turnId, {
            tool: "web_search",
            args: JSON.stringify({ query }),
          });
          active.itemMap.set(extItemId, canonicalId);
        } else if (itemType === "mcpToolCall") {
          const toolName = `${str(item["server"]) ?? "mcp"}:${str(item["tool"]) ?? "call"}`;
          const canonicalId = this.runtime.startToolCall(session, turnId, {
            tool: toolName,
            args: item["arguments"] ? JSON.stringify(item["arguments"]) : undefined,
          });
          active.itemMap.set(extItemId, canonicalId);
        }
        break;
      }

      case "item/agentMessage/delta": {
        const extItemId = str(params["itemId"]);
        const delta = typeof params["delta"] === "string" ? params["delta"] : "";
        if (!extItemId || !delta || !active) break;
        let canonicalId = active.itemMap.get(extItemId);
        if (!canonicalId) {
          canonicalId = this.runtime.startAgentMessage(session, turnId);
          active.itemMap.set(extItemId, canonicalId);
        }
        this.runtime.deltaAgentMessage(session, turnId, canonicalId, delta);
        break;
      }

      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const extItemId = str(params["itemId"]);
        const delta = typeof params["delta"] === "string" ? params["delta"] : "";
        if (!extItemId || !delta || !active) break;
        let canonicalId = active.itemMap.get(extItemId);
        if (!canonicalId) {
          canonicalId = this.runtime.startReasoning(session, turnId);
          active.itemMap.set(extItemId, canonicalId);
        }
        this.runtime.deltaReasoning(session, turnId, canonicalId, delta);
        break;
      }

      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta": {
        const extItemId = str(params["itemId"]);
        const delta = typeof params["delta"] === "string" ? params["delta"] : "";
        if (!extItemId || !delta || !active) break;
        const canonicalId = active.itemMap.get(extItemId);
        if (canonicalId) {
          this.runtime.deltaToolOutput(session, turnId, canonicalId, delta);
        }
        break;
      }

      case "item/completed": {
        const item = asRecord(params["item"]);
        const extItemId = item ? str(item["id"]) : null;
        const itemType = item ? str(item["type"]) : null;
        if (!item || !extItemId || !itemType || !active) break;
        const canonicalId = active.itemMap.get(extItemId);

        if (itemType === "agentMessage") {
          const text = str(item["text"]);
          const id = canonicalId ?? this.runtime.startAgentMessage(session, turnId);
          this.runtime.completeAgentMessage(session, turnId, id, text ?? undefined);
        } else if (itemType === "reasoning") {
          const summary = Array.isArray(item["summary"]) ? item["summary"].map(String) : undefined;
          const id = canonicalId ?? this.runtime.startReasoning(session, turnId);
          this.runtime.completeReasoning(session, turnId, id, summary);
        } else if (itemType === "commandExecution") {
          const id = canonicalId ?? this.runtime.startToolCall(session, turnId, { tool: "shell" });
          const exitCode = num(item["exitCode"]);
          const failed = item["status"] === "failed" || item["status"] === "declined" || (exitCode !== null && exitCode !== 0);
          this.runtime.completeToolCall(session, turnId, id, {
            status: failed ? "failed" : "completed",
            output: str(item["aggregatedOutput"]) ?? undefined,
            exitCode,
            durationMs: num(item["durationMs"]) ?? undefined,
          });
        } else if (itemType === "fileChange") {
          const id = canonicalId ?? this.runtime.startToolCall(session, turnId, { tool: "edit_file" });
          const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
          const diffs = changes
            .map(asRecord)
            .filter(Boolean)
            .map((c) => str(c!["diff"]) ?? `${str(c!["kind"]) ?? "edit"} ${str(c!["path"]) ?? ""}`)
            .join("\n");
          this.runtime.completeToolCall(session, turnId, id, {
            status: item["status"] === "failed" || item["status"] === "declined" ? "failed" : "completed",
            output: diffs || undefined,
          });
        } else if (itemType === "webSearch" || itemType === "mcpToolCall") {
          const id = canonicalId ?? this.runtime.startToolCall(session, turnId, { tool: itemType });
          this.runtime.completeToolCall(session, turnId, id, {
            status: item["status"] === "failed" ? "failed" : "completed",
            output: item["result"] ? JSON.stringify(item["result"], null, 2) : undefined,
          });
        }
        break;
      }

      case "turn/plan/updated": {
        const plan = Array.isArray(params["plan"]) ? params["plan"] : [];
        const items = plan
          .map(asRecord)
          .filter((p): p is Record<string, unknown> => p !== null && typeof p["step"] === "string")
          .map((p, idx) => ({
            id: `step_${idx + 1}`,
            content: String(p["step"]),
            status: str(p["status"]) ?? "pending",
          }));
        this.runtime.emitTodoList(session, turnId, items);
        break;
      }

      case "thread/tokenUsage/updated": {
        const tokenUsage = asRecord(params["tokenUsage"]);
        const last = asRecord(tokenUsage?.["last"]) ?? tokenUsage;
        if (last) {
          const inTok = num(last["inputTokens"]) ?? 0;
          const outTok = num(last["outputTokens"]) ?? 0;
          const cachedTok = num(last["cachedInputTokens"]) ?? 0;
          const reasoningTok = num(last["reasoningOutputTokens"]) ?? 0;
          const windowTok = num(tokenUsage?.["modelContextWindow"]);
          if (inTok > 0 || outTok > 0) {
            this.runtime.recordTokenUsage(session, turnId, {
              inputTokens: Math.max(0, inTok - cachedTok),
              outputTokens: outTok,
              cacheReadTokens: cachedTok,
              reasoningTokens: reasoningTok,
              contextWindowTokens: windowTok,
              durationMs: active ? Date.now() - active.startedAtMs : null,
            });
          }
        }
        break;
      }

      case "turn/completed": {
        const turnObj = asRecord(params["turn"]);
        const status = str(turnObj?.["status"]) ?? "completed";
        if (active) {
          if (status === "failed") {
            const errMsg = str(asRecord(turnObj?.["error"])?.["message"]) ?? "Codex turn failed.";
            active.reject(new Error(errMsg));
          } else {
            active.resolve();
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private async handleServerRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = asRecord(rawParams) ?? {};
    const threadId = str(params["threadId"]);
    const session = threadId ? this.runtime.findByExternalSessionId(threadId) : null;
    if (!session) {
      return { decision: "decline" };
    }
    const turnId = session.activeTurnId ?? "turn";

    if (method === "item/commandExecution/requestApproval") {
      const cmd = str(params["command"]) ?? "shell command";
      const decision = await this.runtime.requestApproval(session, turnId, {
        toolName: "commandExecution",
        rawArgs: cmd,
        subject: { kind: "command", command: cmd, toolName: "Run command" },
      });
      return {
        decision: decision.allow ? (decision.scope === "session" ? "acceptForSession" : "accept") : "decline",
      };
    }

    if (method === "item/fileChange/requestApproval") {
      const path = str(params["grantRoot"]) ?? str(params["reason"]) ?? "workspace files";
      const decision = await this.runtime.requestApproval(session, turnId, {
        toolName: "fileChange",
        subject: { kind: "fileWrite", path, toolName: "Modify files" },
      });
      return {
        decision: decision.allow ? (decision.scope === "session" ? "acceptForSession" : "accept") : "decline",
      };
    }

    if (method === "item/tool/requestUserInput") {
      const rawQuestions = Array.isArray(params["questions"]) ? params["questions"] : [];
      const questions = rawQuestions
        .map(asRecord)
        .filter((q): q is Record<string, unknown> => q !== null)
        .map((q, idx) => ({
          id: str(q["id"]) ?? `q_${idx + 1}`,
          header: str(q["header"]) ?? "Question",
          question: str(q["question"]) ?? "",
          options: (Array.isArray(q["options"]) ? q["options"] : [])
            .map(asRecord)
            .filter((o): o is Record<string, unknown> => o !== null && typeof o["label"] === "string")
            .map((o) => ({
              label: String(o["label"]),
              ...(str(o["description"]) ? { description: String(o["description"]) } : {}),
            })),
        }));
      const outcome = await this.runtime.requestUserInput(session, turnId, {
        toolName: "request_user_input",
        questions,
      });
      const answersMap: Record<string, { answers: string[] }> = {};
      for (const ans of outcome.answers) {
        const list = ans.selectedLabels ?? (ans.selectedLabel ? [ans.selectedLabel] : ans.freeText ? [ans.freeText] : []);
        answersMap[ans.questionId] = { answers: list };
      }
      return { answers: answersMap };
    }

    throw new Error(`Unsupported Codex server request: ${method}`);
  }

  private async refreshRateLimits(): Promise<void> {
    try {
      const res = asRecord(await this.peer.request("account/rateLimits/read", {}));
      const parsed = this.parseRateLimits(res?.["rateLimits"] ?? res);
      if (parsed) {
        this.runtime.updateSubscriptionUsage(parsed);
      }
    } catch {
      /* Not all Codex auth modes expose rate limits */
    }
  }

  private parseRateLimits(raw: unknown): SubscriptionUsage | null {
    const r = asRecord(raw);
    if (!r) return null;
    const primary = asRecord(r["primary"]);
    const secondary = asRecord(r["secondary"]) ?? primary;
    if (!primary || !secondary) return null;

    const toMs = (val: unknown): number | null => {
      const n = num(val);
      if (n === null) return null;
      return n < 10_000_000_000 ? n * 1000 : n;
    };

    const pUsed = num(primary["usedPercent"]);
    const pReset = toMs(primary["resetsAt"]) ?? toMs(primary["resetsAtMs"]);
    const sUsed = num(secondary["usedPercent"]);
    const sReset = toMs(secondary["resetsAt"]) ?? toMs(secondary["resetsAtMs"]);
    if (pUsed === null || pReset === null || sUsed === null || sReset === null) {
      return null;
    }

    const tier = str(r["planType"]) ?? str(r["limitName"]) ?? "chatgpt";
    return {
      tier,
      observedAtMs: Date.now(),
      window: {
        usedPercent: pUsed,
        resetsAtMs: pReset,
        windowDurationMins: num(primary["windowDurationMins"]) ?? 300,
      },
      weekly: {
        usedPercent: sUsed,
        resetsAtMs: sReset,
        windowDurationMins: null,
      },
    };
  }
}
