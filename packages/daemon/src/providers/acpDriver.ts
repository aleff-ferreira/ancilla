import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ServeExit, ServeTarget } from "../mspHost.js";
import type { ApprovalMode, CommandConnection } from "../sessions.js";
import {
  CanonicalSessionRuntime,
  type CanonicalSessionState,
  type CanonicalTurnContext,
} from "./canonicalRuntime.js";
import { StdioJsonRpcPeer, type StdioJsonRpcPeerOptions } from "./jsonRpcStdio.js";
import {
  ACP_CAPABILITIES,
  type AgentHost,
  type AgentHostStartResult,
  type ProviderCapabilities,
  type ProviderId,
  type SessionJournal,
} from "./types.js";

const ACP_PROTOCOL_VERSION = 1;
const MAX_TERMINAL_BUFFER = 256 * 1024;

interface ManagedTerminal {
  id: string;
  sessionId: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
}

interface ActiveAcpTurn {
  turnId: string;
  messageItemId: string | null;
  reasoningItemId: string | null;
  toolItems: Map<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function confinePath(workspaceRoot: string, targetPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = isAbsolute(targetPath) ? resolve(targetPath) : resolve(root, targetPath);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path "${targetPath}" is outside workspace "${root}".`);
  }
  return resolved;
}

export interface AcpAgentHostOptions extends StdioJsonRpcPeerOptions {
  providerId?: ProviderId;
  journal?: SessionJournal;
}

/**
 * Generic Agent Client Protocol (ACP) host over stdio JSON-RPC 2.0.
 * Drives `gemini --acp`, `copilot --acp --stdio`, `kimi acp`, `qwen --acp`, `opencode acp`,
 * and user-registered custom ACP agents.
 */
export class AcpAgentHost implements AgentHost {
  readonly providerId: ProviderId;
  readonly capabilities: ProviderCapabilities = ACP_CAPABILITIES;
  private readonly peer: StdioJsonRpcPeer;
  private readonly runtime: CanonicalSessionRuntime;
  private agentLoadSessionSupported = false;
  private readonly discoveredModels = new Map<string, Record<string, unknown>>();
  private modelConfigOptionId: string | null = null;
  private modelProbeInFlight: Promise<void> | null = null;
  private readonly activeTurns = new Map<string, ActiveAcpTurn>();
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly needsHistorySeed = new Set<string>();

  constructor(
    private readonly target: ServeTarget,
    options: AcpAgentHostOptions = {},
  ) {
    this.providerId = options.providerId ?? "acp-custom";
    this.peer = new StdioJsonRpcPeer(target, options);
    this.runtime = new CanonicalSessionRuntime({
      providerId: this.providerId,
      capabilities: this.capabilities,
      journal: options.journal,
      onStartSession: (opts) => this.handleStartSession(opts),
      onResumeSession: (session) => this.handleResumeSession(session),
      onRunTurn: (ctx) => this.handleRunTurn(ctx),
      onInterruptTurn: (session) => this.handleInterruptTurn(session),
      onListModels: (session) => this.handleListModels(session),
      onSetModel: (session, modelId) => this.handleSetModel(session, modelId),
      onSetApprovalMode: (session, mode) => this.handleSetApprovalMode(session, mode),
      onForkSession: (source) => this.handleForkSession(source),
    });

    this.peer.onProtocolError((err) => this.runtime.reportProtocolError(err));
    this.peer.onNotification((method, params) => this.handleNotification(method, params));
    this.peer.onRequest((method, params) => this.handleAgentRequest(method, params));
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
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: {
            name: "ancilla",
            title: "Ancilla",
            version: clientVersion,
          },
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
        },
        this.peer.startTimeoutMs,
      );
      const record = asRecord(initResult);
      const agentCaps = asRecord(record?.["agentCapabilities"]);
      this.agentLoadSessionSupported = agentCaps?.["loadSession"] === true;
      const agentInfo = asRecord(record?.["agentInfo"]);
      return {
        initializeResult: {
          ...record,
          serverInfo: {
            name: str(agentInfo?.["name"]) ?? String(this.providerId),
            version: str(agentInfo?.["version"]) ?? "acp-1",
          },
        },
        fingerprintWarning: null,
      };
    } catch (error) {
      await this.peer.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<ServeExit> {
    for (const term of this.terminals.values()) {
      try {
        term.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.terminals.clear();
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
      await this.peer.request("session/new", {
        cwd: opts.workspaceRoot,
        mcpServers: [],
      }),
    );
    const extId = str(res?.["sessionId"]);
    const currentModel = this.captureModelsFromSessionReply(res);
    const chosenModel = opts.modelId ?? currentModel;
    if (extId && opts.modelId && opts.modelId !== currentModel) {
      await this.peer.request("session/set_model", { sessionId: extId, modelId: opts.modelId }).catch(() => undefined);
    }
    return {
      externalSessionId: extId,
      modelId: chosenModel,
    };
  }

  private async handleResumeSession(
    session: CanonicalSessionState,
  ): Promise<{ externalSessionId?: string | null; modelId?: string | null }> {
    if (session.externalSessionId && this.agentLoadSessionSupported) {
      try {
        const res = asRecord(
          await this.peer.request("session/load", {
            sessionId: session.externalSessionId,
            cwd: session.workspaceRoot,
            mcpServers: [],
          }),
        );
        const model = this.captureModelsFromSessionReply(res);
        return { externalSessionId: session.externalSessionId, modelId: model ?? session.modelId };
      } catch {
        /* Fall back to creating a fresh ACP session seeded with prior history */
      }
    }
    if (!session.externalSessionId) {
      const created = await this.handleStartSession({
        sessionId: session.sessionId,
        workspaceRoot: session.workspaceRoot,
        approvalMode: session.approvalMode,
        modelId: session.modelId,
      });
      if (session.turnCount > 0 && created.externalSessionId) {
        this.needsHistorySeed.add(session.sessionId);
      }
      return created;
    }
    return { externalSessionId: session.externalSessionId, modelId: session.modelId };
  }

  private async handleForkSession(source: CanonicalSessionState): Promise<{ externalSessionId?: string | null }> {
    const created = await this.handleStartSession({
      sessionId: randomUUID(),
      workspaceRoot: source.workspaceRoot,
      approvalMode: source.approvalMode,
      modelId: source.modelId,
    });
    return { externalSessionId: created.externalSessionId };
  }

  private async handleRunTurn(ctx: CanonicalTurnContext): Promise<void> {
    const { session, turnId, prompt, images } = ctx;
    if (!session.externalSessionId) {
      const started = await this.handleStartSession({
        sessionId: session.sessionId,
        workspaceRoot: session.workspaceRoot,
        approvalMode: session.approvalMode,
        modelId: session.modelId,
      });
      session.externalSessionId = started.externalSessionId ?? null;
    }
    const extId = session.externalSessionId;
    if (!extId) {
      throw new Error("ACP agent did not return a sessionId.");
    }

    let effectivePrompt = prompt;
    if (this.needsHistorySeed.delete(session.sessionId)) {
      const recap = this.buildHistoryRecap(session);
      if (recap) {
        effectivePrompt = `${recap}\n\n${prompt}`;
      }
    }

    const active: ActiveAcpTurn = {
      turnId,
      messageItemId: null,
      reasoningItemId: null,
      toolItems: new Map(),
    };
    this.activeTurns.set(extId, active);

    const contentBlocks: Record<string, unknown>[] = [];
    if (effectivePrompt.length > 0) {
      contentBlocks.push({ type: "text", text: effectivePrompt });
    }
    for (const img of images) {
      contentBlocks.push({
        type: "image",
        data: img.base64Data,
        mimeType: img.mediaType,
      });
    }

    const startedAt = Date.now();
    try {
      const reply = asRecord(
        await this.peer.request("session/prompt", {
          sessionId: extId,
          prompt: contentBlocks,
        }),
      );

      if (active.reasoningItemId) {
        this.runtime.completeReasoning(session, turnId, active.reasoningItemId);
      }
      if (active.messageItemId) {
        this.runtime.completeAgentMessage(session, turnId, active.messageItemId);
      }
      for (const itemId of active.toolItems.values()) {
        const current = session.items.get(itemId);
        if (current?.["status"] === "inProgress") {
          this.runtime.completeToolCall(session, turnId, itemId, { status: "completed" });
        }
      }

      const usage = asRecord(reply?.["usage"]);
      if (usage) {
        const inTok = Number(usage["inputTokens"] ?? usage["input_tokens"] ?? 0);
        const outTok = Number(usage["outputTokens"] ?? usage["output_tokens"] ?? 0);
        const cachedTok = Number(usage["cachedReadTokens"] ?? usage["cache_read_input_tokens"] ?? 0);
        if (inTok > 0 || outTok > 0) {
          this.runtime.recordTokenUsage(session, turnId, {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cachedTok,
            durationMs: Date.now() - startedAt,
          });
        }
      }
    } finally {
      this.activeTurns.delete(extId);
    }
  }

  private async handleInterruptTurn(session: CanonicalSessionState): Promise<void> {
    if (session.externalSessionId) {
      this.peer.notify("session/cancel", { sessionId: session.externalSessionId });
    }
  }

  private async handleListModels(
    session: CanonicalSessionState | null,
  ): Promise<{ models: Record<string, unknown>[]; source?: string } | null> {
    if (this.discoveredModels.size === 0) {
      if (!this.modelProbeInFlight) {
        const cwd = session?.workspaceRoot || this.target.cwd;
        this.modelProbeInFlight = this.peer
          .request("session/new", { cwd, mcpServers: [] }, Math.min(this.peer.startTimeoutMs, 6_000))
          .then((res) => {
            this.captureModelsFromSessionReply(asRecord(res));
          })
          .catch(() => undefined)
          .finally(() => {
            this.modelProbeInFlight = null;
          });
      }
      await this.modelProbeInFlight;
    }
    if (this.discoveredModels.size === 0) {
      return null;
    }
    return {
      source: "providerCatalog",
      models: [...this.discoveredModels.values()],
    };
  }

  private async handleSetModel(session: CanonicalSessionState, modelId: string): Promise<void> {
    if (!session.externalSessionId) {
      return;
    }
    if (this.modelConfigOptionId) {
      try {
        await this.peer.request("session/set_config_option", {
          sessionId: session.externalSessionId,
          configId: this.modelConfigOptionId,
          value: modelId,
        });
        return;
      } catch {
        /* Fall back to session/set_model */
      }
    }
    await this.peer.request("session/set_model", {
      sessionId: session.externalSessionId,
      modelId,
    });
  }

  private async handleSetApprovalMode(session: CanonicalSessionState, mode: ApprovalMode): Promise<void> {
    if (!session.externalSessionId) return;
    const modeId = mode === "allowAll" ? "bypassPermissions" : "default";
    await this.peer.request("session/set_mode", { sessionId: session.externalSessionId, modeId }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ Incoming ACP Notifications & Requests

  private handleNotification(method: string, rawParams: unknown): void {
    if (method !== "session/update") {
      return;
    }
    const params = asRecord(rawParams);
    const extId = params ? str(params["sessionId"]) : null;
    const update = params ? asRecord(params["update"]) : null;
    if (!extId || !update) {
      return;
    }
    const session = this.runtime.findByExternalSessionId(extId);
    const kind = str(update["sessionUpdate"]);
    if (kind === "current_model_update") {
      const nextModel = str(update["currentModelId"]) ?? str(update["modelId"]);
      if (session && nextModel) {
        this.runtime.recordModelResolved(session, nextModel);
      }
      return;
    }
    if (kind === "config_option_update") {
      const current = this.captureModelsFromSessionReply({ configOptions: update["configOptions"] });
      if (session && current) {
        this.runtime.recordModelResolved(session, current);
      }
      return;
    }
    const active = this.activeTurns.get(extId);
    if (!session || !active) {
      return;
    }
    switch (kind) {
      case "agent_message_chunk": {
        const content = asRecord(update["content"]);
        const text = content && content["type"] === "text" ? str(content["text"]) : str(update["text"]);
        if (text) {
          if (!active.messageItemId) {
            active.messageItemId = this.runtime.startAgentMessage(session, active.turnId);
          }
          this.runtime.deltaAgentMessage(session, active.turnId, active.messageItemId, text);
        }
        break;
      }
      case "agent_thought_chunk": {
        const content = asRecord(update["content"]);
        const text = content && content["type"] === "text" ? str(content["text"]) : str(update["text"]);
        if (text) {
          if (!active.reasoningItemId) {
            active.reasoningItemId = this.runtime.startReasoning(session, active.turnId);
          }
          this.runtime.deltaReasoning(session, active.turnId, active.reasoningItemId, text);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const callId = str(update["toolCallId"]) ?? randomUUID();
        const title = str(update["title"]) ?? str(update["kind"]) ?? "tool";
        const toolKind = str(update["kind"]) ?? "other";
        const statusRaw = str(update["status"]);
        const rawInput = update["rawInput"];
        const argsStr =
          rawInput !== undefined
            ? typeof rawInput === "string"
              ? rawInput
              : JSON.stringify(rawInput)
            : undefined;

        let itemId = active.toolItems.get(callId);
        if (!itemId) {
          itemId = this.runtime.startToolCall(session, active.turnId, {
            tool: toolKind === "search" ? "web_search" : toolKind === "fetch" ? "web_fetch" : title,
            args: argsStr,
            extra: { callId, acpKind: toolKind },
          });
          active.toolItems.set(callId, itemId);
        }

        const formattedOutput = this.extractToolContent(update["content"], update["rawOutput"]);
        if (formattedOutput) {
          this.runtime.deltaToolOutput(session, active.turnId, itemId, formattedOutput);
        }

        if (statusRaw === "completed" || statusRaw === "failed") {
          this.runtime.completeToolCall(session, active.turnId, itemId, {
            status: statusRaw === "failed" ? "failed" : "completed",
            ...(statusRaw === "failed" ? { failureReason: formattedOutput || "Tool call failed." } : {}),
          });
        }
        break;
      }
      case "plan": {
        const entries = Array.isArray(update["entries"]) ? update["entries"] : [];
        const items = entries
          .map(asRecord)
          .filter((e): e is Record<string, unknown> => e !== null && typeof e["content"] === "string")
          .map((e, idx) => ({
            id: `plan_${idx + 1}`,
            content: String(e["content"]),
            status: str(e["status"]) ?? "pending",
          }));
        this.runtime.emitTodoList(session, active.turnId, items);
        break;
      }
      default:
        break;
    }
  }

  private async handleAgentRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = asRecord(rawParams) ?? {};
    switch (method) {
      case "session/request_permission": {
        const extId = str(params["sessionId"]);
        const session = extId ? this.runtime.findByExternalSessionId(extId) : null;
        const options = Array.isArray(params["options"]) ? params["options"].map(asRecord).filter(Boolean) : [];
        if (!session) {
          return { outcome: { outcome: "cancelled" } };
        }
        const toolCall = asRecord(params["toolCall"]);
        const title = str(toolCall?.["title"]) ?? "Action";
        const toolKind = str(toolCall?.["kind"]) ?? "tool";
        const locations = Array.isArray(toolCall?.["locations"]) ? toolCall!["locations"] : [];
        const firstPath = str(asRecord(locations[0])?.["path"]);
        const rawInput = toolCall?.["rawInput"];
        const commandText = str(asRecord(rawInput)?.["command"]);

        const turnId = session.activeTurnId ?? "turn";
        const decision = await this.runtime.requestApproval(session, turnId, {
          toolName: title,
          rawArgs: rawInput ? JSON.stringify(rawInput) : "",
          subject: commandText
            ? { kind: "command", command: commandText, toolName: title }
            : firstPath || toolKind === "edit" || toolKind === "delete"
              ? { kind: "fileWrite", path: firstPath ?? title, toolName: title }
              : { kind: "tool", toolName: title },
        });

        if (!decision.allow) {
          const rejectOpt =
            options.find((o) => str(o?.["kind"]) === "reject_once") ??
            options.find((o) => String(o?.["kind"] ?? "").startsWith("reject"));
          if (rejectOpt && str(rejectOpt["optionId"])) {
            return { outcome: { outcome: "selected", optionId: str(rejectOpt["optionId"]) } };
          }
          return { outcome: { outcome: "cancelled" } };
        }

        const preferredKind = decision.scope === "session" ? "allow_always" : "allow_once";
        const allowOpt =
          options.find((o) => str(o?.["kind"]) === preferredKind) ??
          options.find((o) => String(o?.["kind"] ?? "").startsWith("allow")) ??
          options[0];
        const optionId = str(allowOpt?.["optionId"]) ?? "allow-once";
        return { outcome: { outcome: "selected", optionId } };
      }

      case "fs/read_text_file": {
        const extId = str(params["sessionId"]);
        const session = extId ? this.runtime.findByExternalSessionId(extId) : null;
        const root = session?.workspaceRoot ?? this.target.cwd;
        const path = str(params["path"]);
        if (!path) throw new Error("path is required.");
        const safe = confinePath(root, path);
        const text = await readFile(safe, "utf8");
        const line = typeof params["line"] === "number" ? Math.max(1, params["line"]) : null;
        const limit = typeof params["limit"] === "number" ? Math.max(1, params["limit"]) : null;
        if (line !== null || limit !== null) {
          const lines = text.split("\n");
          const start = (line ?? 1) - 1;
          const end = limit !== null ? start + limit : lines.length;
          return { content: lines.slice(start, end).join("\n") };
        }
        return { content: text };
      }

      case "fs/write_text_file": {
        const extId = str(params["sessionId"]);
        const session = extId ? this.runtime.findByExternalSessionId(extId) : null;
        const root = session?.workspaceRoot ?? this.target.cwd;
        const path = str(params["path"]);
        const content = typeof params["content"] === "string" ? params["content"] : "";
        if (!path) throw new Error("path is required.");
        const safe = confinePath(root, path);
        if (session) {
          const decision = await this.runtime.requestApproval(session, session.activeTurnId ?? "turn", {
            toolName: "fs/write_text_file",
            subject: { kind: "fileWrite", path: safe, toolName: "Write file" },
          });
          if (!decision.allow) {
            throw new Error(decision.feedback ?? "File write denied by user.");
          }
        }
        await mkdir(dirname(safe), { recursive: true });
        await writeFile(safe, content, "utf8");
        return {};
      }

      case "terminal/create": {
        const extId = str(params["sessionId"]) ?? "";
        const session = extId ? this.runtime.findByExternalSessionId(extId) : null;
        const root = session?.workspaceRoot ?? this.target.cwd;
        const command = str(params["command"]);
        if (!command) throw new Error("command is required.");
        const args = Array.isArray(params["args"]) ? params["args"].map(String) : [];
        const cwdParam = str(params["cwd"]);
        const cwd = cwdParam ? confinePath(root, cwdParam) : root;
        const fullCmd = [command, ...args].join(" ").trim();
        if (session) {
          const decision = await this.runtime.requestApproval(session, session.activeTurnId ?? "turn", {
            toolName: "terminal/create",
            rawArgs: fullCmd,
            subject: { kind: "command", command: fullCmd, toolName: "Terminal command" },
          });
          if (!decision.allow) {
            throw new Error(decision.feedback ?? "Terminal command denied by user.");
          }
        }
        const terminalId = `term_${randomUUID()}`;
        const child = spawn(command, args, { cwd, windowsHide: true });
        let resolveExit!: (val: { exitCode: number | null; signal: string | null }) => void;
        const exited = new Promise<{ exitCode: number | null; signal: string | null }>((r) => {
          resolveExit = r;
        });
        const managed: ManagedTerminal = {
          id: terminalId,
          sessionId: extId,
          child,
          output: "",
          truncated: false,
          exitCode: null,
          signal: null,
          exited,
        };
        const append = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (managed.output.length < MAX_TERMINAL_BUFFER) {
            managed.output = (managed.output + text).slice(0, MAX_TERMINAL_BUFFER);
          } else {
            managed.truncated = true;
          }
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("close", (code, sig) => {
          managed.exitCode = code;
          managed.signal = sig ? String(sig) : null;
          resolveExit({ exitCode: code, signal: managed.signal });
        });
        child.on("error", (err) => {
          append(Buffer.from(`${err.message}\n`, "utf8"));
          managed.exitCode = 1;
          resolveExit({ exitCode: 1, signal: null });
        });
        this.terminals.set(terminalId, managed);
        return { terminalId };
      }

      case "terminal/output": {
        const terminalId = str(params["terminalId"]);
        const term = terminalId ? this.terminals.get(terminalId) : undefined;
        if (!term) throw new Error("Unknown terminalId.");
        return {
          output: term.output,
          truncated: term.truncated,
          ...(term.exitCode !== null || term.signal !== null
            ? { exitStatus: { exitCode: term.exitCode, signal: term.signal } }
            : {}),
        };
      }

      case "terminal/wait_for_exit": {
        const terminalId = str(params["terminalId"]);
        const term = terminalId ? this.terminals.get(terminalId) : undefined;
        if (!term) throw new Error("Unknown terminalId.");
        const status = await term.exited;
        return { exitCode: status.exitCode, signal: status.signal };
      }

      case "terminal/kill": {
        const terminalId = str(params["terminalId"]);
        const term = terminalId ? this.terminals.get(terminalId) : undefined;
        if (term) {
          try {
            term.child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }
        return {};
      }

      case "terminal/release": {
        const terminalId = str(params["terminalId"]);
        const term = terminalId ? this.terminals.get(terminalId) : undefined;
        if (term) {
          try {
            term.child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          this.terminals.delete(terminalId!);
        }
        return {};
      }

      default:
        throw new Error(`Unsupported ACP client method: ${method}`);
    }
  }

  // ------------------------------------------------------------------ Formatting Helpers

  private captureModelsFromSessionReply(reply: Record<string, unknown> | null): string | null {
    if (!reply) {
      return null;
    }
    let currentModelId: string | null = null;
    const configOptions = Array.isArray(reply["configOptions"]) ? reply["configOptions"] : [];

    // Extract reasoning / thought level stops if advertised via ACP configOptions
    const discoveredEfforts: string[] = [];
    for (const rawOpt of configOptions) {
      const opt = asRecord(rawOpt);
      if (!opt) continue;
      const cat = str(opt["category"]) ?? str(opt["id"]);
      if (cat === "thought_level" || cat === "reasoning_effort") {
        const optsList = Array.isArray(opt["options"]) ? opt["options"] : [];
        for (const entry of optsList) {
          const item = asRecord(entry);
          const val = str(item?.["value"]);
          if (val && !discoveredEfforts.includes(val)) {
            discoveredEfforts.push(val);
          }
        }
      }
    }

    const modelsBlock = asRecord(reply["models"]);
    if (modelsBlock) {
      currentModelId = str(modelsBlock["currentModelId"]) ?? currentModelId;
      const available = Array.isArray(modelsBlock["availableModels"]) ? modelsBlock["availableModels"] : [];
      available.forEach((entry, idx) => {
        const m = asRecord(entry);
        const id = str(m?.["modelId"]) ?? str(m?.["id"]);
        if (!m || !id) return;
        const contextLimit =
          typeof m["contextWindow"] === "number"
            ? m["contextWindow"]
            : typeof m["contextLimit"] === "number"
              ? m["contextLimit"]
              : null;
        this.discoveredModels.set(id, {
          modelId: id,
          displayLabel: str(m["name"]) ?? str(m["displayName"]) ?? str(m["displayLabel"]) ?? id,
          description: str(m["description"]) ?? "",
          providerId: this.providerId,
          isDefault: currentModelId ? id === currentModelId : idx === 0,
          ...(contextLimit !== null ? { contextLimit, contextWindowTokens: contextLimit } : {}),
          ...(discoveredEfforts.length > 0
            ? { variants: discoveredEfforts, supportedReasoningEfforts: discoveredEfforts }
            : {}),
        });
      });
    }

    for (const rawOpt of configOptions) {
      const opt = asRecord(rawOpt);
      if (!opt) continue;
      const cat = str(opt["category"]);
      const optId = str(opt["id"]);
      if (cat !== "model" && optId !== "model") {
        continue;
      }
      this.modelConfigOptionId = optId ?? "model";
      const currentVal = str(opt["currentValue"]);
      if (currentVal) {
        currentModelId = currentModelId ?? currentVal;
      }
      const rawOptions = Array.isArray(opt["options"]) ? opt["options"] : [];
      const flatOptions: Record<string, unknown>[] = [];
      for (const item of rawOptions) {
        const rec = asRecord(item);
        if (!rec) continue;
        if (Array.isArray(rec["options"])) {
          for (const sub of rec["options"]) {
            const subRec = asRecord(sub);
            if (subRec) flatOptions.push(subRec);
          }
        } else {
          flatOptions.push(rec);
        }
      }
      flatOptions.forEach((m, idx) => {
        const id = str(m["value"]) ?? str(m["modelId"]) ?? str(m["id"]);
        if (!id) return;
        this.discoveredModels.set(id, {
          modelId: id,
          displayLabel: str(m["name"]) ?? str(m["displayLabel"]) ?? id,
          description: str(m["description"]) ?? "",
          providerId: this.providerId,
          isDefault: currentVal ? id === currentVal : idx === 0,
          ...(discoveredEfforts.length > 0
            ? { variants: discoveredEfforts, supportedReasoningEfforts: discoveredEfforts }
            : {}),
        });
      });
    }

    if (currentModelId && this.discoveredModels.size > 0) {
      for (const [id, entry] of this.discoveredModels) {
        entry["isDefault"] = id === currentModelId;
      }
    }

    return currentModelId;
  }

  private extractToolContent(content: unknown, rawOutput: unknown): string {
    const parts: string[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        const r = asRecord(block);
        if (!r) continue;
        if (r["type"] === "diff") {
          const path = str(r["path"]) ?? "file";
          const oldText = typeof r["oldText"] === "string" ? r["oldText"] : "";
          const newText = typeof r["newText"] === "string" ? r["newText"] : "";
          parts.push(`--- a/${path}\n+++ b/${path}\n-${oldText.split("\n").join("\n-")}\n+${newText.split("\n").join("\n+")}\n`);
        } else if (r["type"] === "content") {
          const inner = asRecord(r["content"]);
          if (inner && typeof inner["text"] === "string") {
            parts.push(inner["text"]);
          }
        } else if (typeof r["text"] === "string") {
          parts.push(r["text"]);
        }
      }
    }
    if (parts.length === 0 && rawOutput !== undefined && rawOutput !== null) {
      parts.push(typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2));
    }
    return parts.join("\n");
  }

  private buildHistoryRecap(session: CanonicalSessionState): string | null {
    const lines: string[] = [];
    for (const item of session.items.values()) {
      if (item["kind"] === "userMessage" && typeof item["text"] === "string") {
        lines.push(`User: ${item["text"]}`);
      } else if (item["kind"] === "agentMessage" && typeof item["text"] === "string") {
        lines.push(`Assistant: ${item["text"]}`);
      }
    }
    if (lines.length === 0) return null;
    const recent = lines.slice(-12).join("\n\n");
    return `[Prior conversation context]\n${recent}\n[End of prior context]`;
  }
}
