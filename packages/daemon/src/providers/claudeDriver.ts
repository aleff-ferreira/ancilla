import { randomUUID } from "node:crypto";
import type { ServeExit, ServeTarget } from "../mspHost.js";
import type { ApprovalMode, CommandConnection } from "../sessions.js";
import {
  CanonicalSessionRuntime,
  type CanonicalSessionState,
  type CanonicalTurnContext,
} from "./canonicalRuntime.js";
import {
  defaultSpawnStdio,
  type SpawnStdioFn,
  type SpawnedStdioProcess,
} from "./jsonRpcStdio.js";
import {
  CLAUDE_CAPABILITIES,
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

interface SessionProcessState {
  child: SpawnedStdioProcess;
  stdoutBuffer: string;
  spawnedEffort: string | null;
  activeTurn: {
    turnId: string;
    startedAtMs: number;
    messageItemId: string | null;
    reasoningItemId: string | null;
    blockItems: Map<number, { kind: "text" | "thinking" | "tool"; itemId: string; toolId?: string; toolName?: string; inputJson: string }>;
    toolUseItems: Map<string, string>;
    resolve: () => void;
    reject: (err: Error) => void;
  } | null;
}

export interface ClaudeCliStreamHostOptions {
  spawnFn?: SpawnStdioFn;
  journal?: SessionJournal;
  onStderr?: (chunk: string) => void;
  initTimeoutMs?: number;
}

const CLAUDE_CLI_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_CATALOG_TTL_MS = 5 * 60_000;

function normalizeClaudeToolName(name: string): string {
  switch (name) {
    case "Bash":
      return "shell";
    case "WebSearch":
      return "web_search";
    case "WebFetch":
      return "web_fetch";
    case "Edit":
    case "MultiEdit":
    case "Write":
      return "edit_file";
    default:
      return name;
  }
}

/**
 * Anthropic Claude Code CLI host over official `stream-json` + `--permission-prompt-tool stdio`.
 * Uses the user's locally installed `claude` binary and official `claude auth login` state;
 * never reads or extracts OAuth credentials from `~/.claude`.
 */
export class ClaudeCliStreamHost implements AgentHost {
  readonly providerId = "claude" as const;
  readonly capabilities: ProviderCapabilities = CLAUDE_CAPABILITIES;
  private readonly spawnFn: SpawnStdioFn;
  private readonly onStderr: (chunk: string) => void;
  private readonly initTimeoutMs: number;
  private readonly runtime: CanonicalSessionRuntime;
  private readonly processes = new Map<string, SessionProcessState>();
  private readonly pendingForkFrom = new Map<string, string>();
  private readonly resolvedModelMap = new Map<string, string>();
  private readonly stderrTail: string[] = [];
  private readonly exitHandlers: ((exit: ServeExit) => void)[] = [];
  private cachedCatalog: { models: Record<string, unknown>[]; source: string; fetchedAtMs: number } | null = null;
  private catalogInFlight: Promise<{ models: Record<string, unknown>[]; source?: string } | null> | null = null;
  private detectedVersion: string | null = null;
  private closed = false;

  constructor(
    private readonly target: ServeTarget,
    options: ClaudeCliStreamHostOptions = {},
  ) {
    this.spawnFn = options.spawnFn ?? defaultSpawnStdio;
    this.onStderr = options.onStderr ?? (() => {});
    this.initTimeoutMs = options.initTimeoutMs ?? 2_500;
    this.runtime = new CanonicalSessionRuntime({
      providerId: this.providerId,
      capabilities: this.capabilities,
      journal: options.journal,
      onStartSession: async (opts) => ({
        externalSessionId: null,
        modelId: opts.modelId,
      }),
      onResumeSession: async (session) => ({
        externalSessionId: session.externalSessionId,
        modelId: session.modelId,
      }),
      onRunTurn: (ctx) => this.handleRunTurn(ctx),
      onInterruptTurn: (session) => this.handleInterruptTurn(session),
      onListModels: () => this.handleListModels(),
      onSetModel: (session, modelId) => this.handleSetModel(session, modelId),
      onSetApprovalMode: (session, mode) => this.handleSetApprovalMode(session, mode),
      onSetReasoningEffort: (session) => this.handleSetReasoningEffort(session),
      onCompactSession: (session) => this.handleCompactSession(session),
      onForkSession: (source, newSessionId) => this.handleForkSession(source, newSessionId),
    });
  }

  get connection(): CommandConnection {
    return this.runtime;
  }

  get recentStderr(): string {
    return this.stderrTail.join("\n").trim();
  }

  onExit(handler: (exit: ServeExit) => void): void {
    this.exitHandlers.push(handler);
  }

  async start(_clientVersion: string): Promise<AgentHostStartResult> {
    if (this.closed) {
      throw new Error("Claude host is closed.");
    }
    return {
      initializeResult: {
        serverInfo: {
          name: "claude-stream-json",
          version: this.detectedVersion ?? "cli",
        },
      },
      fingerprintWarning: null,
    };
  }

  async close(): Promise<ServeExit> {
    this.closed = true;
    for (const [sessionId, proc] of this.processes) {
      this.processes.delete(sessionId);
      if (proc.activeTurn) {
        proc.activeTurn.reject(new Error("Claude host closed."));
        proc.activeTurn = null;
      }
      try {
        proc.child.stdin.end();
        proc.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    return { code: 0, signal: null };
  }

  // ------------------------------------------------------------------ Live Model Discovery

  private buildProbeArgs(): string[] {
    const args = [...this.target.args];
    if (!args.includes("-p") && !args.includes("--print")) {
      args.unshift("-p");
    }
    if (!args.includes("--input-format")) {
      args.push("--input-format", "stream-json");
    }
    if (!args.includes("--output-format")) {
      args.push("--output-format", "stream-json");
    }
    if (!args.includes("--verbose")) {
      args.push("--verbose");
    }
    return args;
  }

  private async handleListModels(): Promise<{ models: Record<string, unknown>[]; source?: string } | null> {
    if (this.cachedCatalog && Date.now() - this.cachedCatalog.fetchedAtMs < CLAUDE_CATALOG_TTL_MS) {
      return { models: this.cachedCatalog.models, source: this.cachedCatalog.source };
    }
    if (this.catalogInFlight) {
      return this.catalogInFlight;
    }
    const task = this.probeLiveCatalog().finally(() => {
      this.catalogInFlight = null;
    });
    this.catalogInFlight = task;
    return task;
  }

  private async probeLiveCatalog(): Promise<{ models: Record<string, unknown>[]; source?: string } | null> {
    if (this.closed) {
      return null;
    }
    let child: SpawnedStdioProcess;
    try {
      child = this.spawnFn({
        command: this.target.command,
        args: this.buildProbeArgs(),
        cwd: this.target.cwd,
        env: this.target.env,
      });
    } catch {
      return null;
    }

    const requestId = `init_${randomUUID()}`;
    return new Promise((resolve) => {
      let settled = false;
      let stdoutBuf = "";
      const finish = (result: { models: Record<string, unknown>[]; source?: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.stdin.end();
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve(result);
      };

      const timer = setTimeout(() => finish(null), this.initTimeoutMs);

      const handleLine = (line: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        const msg = asRecord(parsed);
        if (!msg || msg["type"] !== "control_response") {
          return;
        }
        const resp = asRecord(msg["response"]);
        if (resp?.["request_id"] && resp["request_id"] !== requestId) {
          return;
        }
        const payload = asRecord(resp?.["response"]) ?? resp;
        const version = str(payload?.["claude_code_version"]);
        if (version) {
          this.detectedVersion = version;
        }
        const rawModels = Array.isArray(payload?.["models"]) ? payload["models"] : [];
        if (rawModels.length === 0) {
          finish(null);
          return;
        }

        let defaultResolved: string | null = null;
        let defaultEntry: Record<string, unknown> | null = null;
        const concreteEntries: Record<string, unknown>[] = [];
        for (const item of rawModels) {
          const entry = asRecord(item);
          if (!entry) continue;
          const val = str(entry["value"]) ?? str(entry["modelId"]) ?? str(entry["id"]);
          if (!val) continue;
          if (val === "default") {
            defaultEntry = entry;
            defaultResolved = str(entry["resolvedModel"]);
          } else {
            concreteEntries.push(entry);
          }
        }

        const models: Record<string, unknown>[] = [];
        this.resolvedModelMap.clear();
        let matchedDefault = false;

        for (const entry of concreteEntries) {
          const id = str(entry["value"]) ?? str(entry["modelId"]) ?? str(entry["id"]);
          if (!id) continue;
          const resolved = str(entry["resolvedModel"]);
          if (resolved && !this.resolvedModelMap.has(resolved)) {
            this.resolvedModelMap.set(resolved, id);
          }
          const displayLabel = str(entry["displayName"]) ?? str(entry["displayLabel"]) ?? id;
          const description = str(entry["description"]) ?? "";
          const rawEfforts = Array.isArray(entry["supportedEffortLevels"])
            ? entry["supportedEffortLevels"]
            : Array.isArray(entry["supportedReasoningEfforts"])
              ? entry["supportedReasoningEfforts"]
              : [];
          const efforts: string[] = [];
          if (entry["supportsThinkingOff"] === true) {
            efforts.push("none");
          }
          for (const eff of rawEfforts) {
            if (typeof eff === "string" && eff.length > 0 && !efforts.includes(eff)) {
              efforts.push(eff);
            }
          }
          const contextLimit =
            num(entry["contextWindow"]) ??
            num(entry["contextWindowTokens"]) ??
            num(entry["contextLimit"]) ??
            (id.includes("[1m]") || /\b1M context\b/i.test(description) ? 1_000_000 : null);
          const isDefault = Boolean(
            entry["isDefault"] === true ||
              (defaultResolved && (id === defaultResolved || resolved === defaultResolved)),
          );
          if (isDefault) {
            matchedDefault = true;
          }
          models.push({
            modelId: id,
            displayLabel,
            description,
            providerId: this.providerId,
            isDefault,
            ...(contextLimit !== null ? { contextLimit, contextWindowTokens: contextLimit } : {}),
            ...(efforts.length > 0 ? { variants: efforts, supportedReasoningEfforts: efforts } : {}),
          });
        }

        if (defaultResolved && !matchedDefault) {
          const desc = str(defaultEntry?.["description"]) ?? "";
          models.unshift({
            modelId: defaultResolved,
            displayLabel: defaultResolved,
            description: desc,
            providerId: this.providerId,
            isDefault: true,
          });
        }

        if (models.length === 0) {
          finish(null);
          return;
        }

        const account = asRecord(payload?.["account"]);
        const tokenSource = str(account?.["tokenSource"]);
        const hasAmbientKey = Boolean(this.target.env?.["ANTHROPIC_API_KEY"]);
        const source =
          (tokenSource && tokenSource !== "none") || hasAmbientKey ? "providerCatalog" : "bundledCatalog";
        this.cachedCatalog = { models, source, fetchedAtMs: Date.now() };
        finish({ models, source });
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let idx = stdoutBuf.indexOf("\n");
        while (idx >= 0) {
          const line = stdoutBuf.slice(0, idx).replace(/\r$/, "").trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line.length > 0) {
            handleLine(line);
          }
          idx = stdoutBuf.indexOf("\n");
        }
      });
      child.on("error", () => finish(null));
      child.on("exit", () => {
        if (stdoutBuf.trim().length > 0) {
          handleLine(stdoutBuf.trim());
          stdoutBuf = "";
        }
        finish(null);
      });

      try {
        const initFrame = {
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize" },
        };
        child.stdin.write(`${JSON.stringify(initFrame)}\n`, "utf8");
      } catch {
        finish(null);
      }
    });
  }

  // ------------------------------------------------------------------ Session Process Lifecycle

  private ensureProcess(session: CanonicalSessionState, turnEffort?: string | null): SessionProcessState {
    const desiredEffort =
      turnEffort && CLAUDE_CLI_EFFORTS.has(turnEffort)
        ? turnEffort
        : session.reasoningEffort && CLAUDE_CLI_EFFORTS.has(session.reasoningEffort)
          ? session.reasoningEffort
          : null;
    const existing = this.processes.get(session.sessionId);
    if (existing) {
      if (!existing.activeTurn && existing.spawnedEffort !== desiredEffort) {
        this.recycleProcess(session.sessionId);
      } else {
        return existing;
      }
    }

    const args = [...this.target.args];
    const forkSource = this.pendingForkFrom.get(session.sessionId);
    if (forkSource) {
      this.pendingForkFrom.delete(session.sessionId);
      args.push("--resume", forkSource, "--fork-session");
    } else if (session.externalSessionId) {
      args.push("--resume", session.externalSessionId);
    }
    if (session.modelId) {
      args.push("--model", session.modelId);
    }
    if (desiredEffort && !args.includes("--effort")) {
      args.push("--effort", desiredEffort);
    }
    if (session.approvalMode === "allowAll") {
      args.push("--permission-mode", "bypassPermissions");
    }

    const child = this.spawnFn({
      command: this.target.command,
      args,
      cwd: session.workspaceRoot || this.target.cwd,
      env: this.target.env,
    });

    const proc: SessionProcessState = {
      child,
      stdoutBuffer: "",
      spawnedEffort: desiredEffort,
      activeTurn: null,
    };
    this.processes.set(session.sessionId, proc);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      proc.stdoutBuffer += text;
      let idx = proc.stdoutBuffer.indexOf("\n");
      while (idx >= 0) {
        const line = proc.stdoutBuffer.slice(0, idx).replace(/\r$/, "");
        proc.stdoutBuffer = proc.stdoutBuffer.slice(idx + 1);
        if (line.trim().length > 0) {
          this.processLine(session, proc, line);
        }
        idx = proc.stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.rememberStderr(text);
      this.onStderr(text);
    });

    child.on("error", (err) => {
      this.rememberStderr(err.message);
      this.processes.delete(session.sessionId);
      if (proc.activeTurn) {
        const active = proc.activeTurn;
        proc.activeTurn = null;
        active.reject(err);
      }
    });

    child.on("exit", (code, signal) => {
      if (proc.stdoutBuffer.trim().length > 0) {
        this.processLine(session, proc, proc.stdoutBuffer);
        proc.stdoutBuffer = "";
      }
      this.processes.delete(session.sessionId);
      if (proc.activeTurn) {
        const active = proc.activeTurn;
        proc.activeTurn = null;
        if (code === 0) {
          active.resolve();
        } else {
          const tail = this.recentStderr;
          active.reject(
            new Error(
              `Claude CLI exited (${code ?? signal ?? "unknown"})${tail ? `: ${tail}` : ""}`,
            ),
          );
        }
      }
    });

    return proc;
  }

  private async handleRunTurn(ctx: CanonicalTurnContext): Promise<void> {
    const { session, turnId, prompt, images, reasoningEffort } = ctx;
    const proc = this.ensureProcess(session, reasoningEffort);

    let resolveTurn!: () => void;
    let rejectTurn!: (err: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolveTurn = res;
      rejectTurn = rej;
    });

    proc.activeTurn = {
      turnId,
      startedAtMs: Date.now(),
      messageItemId: null,
      reasoningItemId: null,
      blockItems: new Map(),
      toolUseItems: new Map(),
      resolve: resolveTurn,
      reject: rejectTurn,
    };

    const content: unknown =
      images.length === 0
        ? prompt
        : [
            ...(prompt.length > 0 ? [{ type: "text", text: prompt }] : []),
            ...images.map((img) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mediaType,
                data: img.base64Data,
              },
            })),
          ];

    const userEnvelope = {
      type: "user",
      session_id: session.externalSessionId ?? "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content,
      },
    };

    try {
      proc.child.stdin.write(`${JSON.stringify(userEnvelope)}\n`, "utf8");
      await done;
    } finally {
      if (proc.activeTurn?.turnId === turnId) {
        proc.activeTurn = null;
      }
    }
  }

  private async handleInterruptTurn(session: CanonicalSessionState): Promise<void> {
    const proc = this.processes.get(session.sessionId);
    if (!proc) return;
    try {
      const interruptFrame = {
        type: "control_request",
        request_id: `int_${randomUUID()}`,
        request: { subtype: "interrupt" },
      };
      proc.child.stdin.write(`${JSON.stringify(interruptFrame)}\n`, "utf8");
    } catch {
      try {
        proc.child.kill("SIGINT");
      } catch {
        /* ignore */
      }
    }
    proc.activeTurn?.resolve();
  }

  private async handleSetModel(session: CanonicalSessionState, modelId: string): Promise<void> {
    const proc = this.processes.get(session.sessionId);
    if (!proc) return;
    if (proc.activeTurn) {
      const frame = {
        type: "control_request",
        request_id: `model_${randomUUID()}`,
        request: { subtype: "set_model", model: modelId },
      };
      proc.child.stdin.write(`${JSON.stringify(frame)}\n`, "utf8");
      return;
    }
    this.recycleProcess(session.sessionId);
  }

  private async handleSetApprovalMode(session: CanonicalSessionState, mode: ApprovalMode): Promise<void> {
    const proc = this.processes.get(session.sessionId);
    if (!proc) return;
    if (proc.activeTurn) {
      const frame = {
        type: "control_request",
        request_id: `perm_${randomUUID()}`,
        request: {
          subtype: "set_permission_mode",
          mode: mode === "allowAll" ? "bypassPermissions" : "default",
        },
      };
      proc.child.stdin.write(`${JSON.stringify(frame)}\n`, "utf8");
      return;
    }
    this.recycleProcess(session.sessionId);
  }

  private async handleSetReasoningEffort(session: CanonicalSessionState): Promise<void> {
    const proc = this.processes.get(session.sessionId);
    if (!proc || proc.activeTurn) {
      return;
    }
    this.recycleProcess(session.sessionId);
  }

  private async handleCompactSession(session: CanonicalSessionState): Promise<unknown> {
    await this.runtime.command("turn/start", {
      sessionId: session.sessionId,
      input: [{ type: "text", text: "/compact" }],
      displayText: "/compact",
    });
    return { ok: true };
  }

  private async handleForkSession(
    source: CanonicalSessionState,
    newSessionId: string,
  ): Promise<{ externalSessionId?: string | null }> {
    if (source.externalSessionId) {
      this.pendingForkFrom.set(newSessionId, source.externalSessionId);
    }
    return { externalSessionId: null };
  }

  private recycleProcess(sessionId: string): void {
    const proc = this.processes.get(sessionId);
    if (!proc) return;
    this.processes.delete(sessionId);
    try {
      proc.child.stdin.end();
      proc.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ Stream-JSON Parser

  private processLine(session: CanonicalSessionState, proc: SessionProcessState, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.runtime.reportProtocolError(error);
      return;
    }
    const msg = asRecord(parsed);
    if (!msg) return;

    const extSid = str(msg["session_id"]);
    if (extSid && extSid !== session.externalSessionId) {
      session.externalSessionId = extSid;
    }

    const type = str(msg["type"]);
    const active = proc.activeTurn;

    if (type === "system" && msg["subtype"] === "init") {
      const model = str(msg["model"]);
      if (model && !session.modelId) {
        this.runtime.recordModelResolved(session, this.resolvedModelMap.get(model) ?? model);
      }
      return;
    }

    if (type === "control_request") {
      void this.handleControlRequest(session, proc, msg);
      return;
    }

    if (!active) {
      return;
    }

    if (type === "stream_event") {
      const ev = asRecord(msg["event"]);
      if (!ev) return;
      const evType = str(ev["type"]);
      const index = num(ev["index"]) ?? 0;

      if (evType === "content_block_start") {
        const block = asRecord(ev["content_block"]);
        const blockType = str(block?.["type"]);
        if (blockType === "text") {
          const itemId = this.runtime.startAgentMessage(session, active.turnId);
          active.messageItemId = itemId;
          active.blockItems.set(index, { kind: "text", itemId, inputJson: "" });
        } else if (blockType === "thinking") {
          const itemId = this.runtime.startReasoning(session, active.turnId);
          active.reasoningItemId = itemId;
          active.blockItems.set(index, { kind: "thinking", itemId, inputJson: "" });
        } else if (blockType === "tool_use") {
          const rawName = str(block?.["name"]) ?? "tool";
          const toolId = str(block?.["id"]) ?? randomUUID();
          const tool = normalizeClaudeToolName(rawName);
          const itemId = this.runtime.startToolCall(session, active.turnId, {
            tool,
            extra: { callId: toolId, rawToolName: rawName },
          });
          active.blockItems.set(index, { kind: "tool", itemId, toolId, toolName: rawName, inputJson: "" });
          active.toolUseItems.set(toolId, itemId);
        }
      } else if (evType === "content_block_delta") {
        const delta = asRecord(ev["delta"]);
        const deltaType = str(delta?.["type"]);
        const tracked = active.blockItems.get(index);
        if (deltaType === "text_delta" && typeof delta?.["text"] === "string") {
          const itemId = tracked?.itemId ?? active.messageItemId ?? this.runtime.startAgentMessage(session, active.turnId);
          active.messageItemId = itemId;
          this.runtime.deltaAgentMessage(session, active.turnId, itemId, delta["text"]);
        } else if (deltaType === "thinking_delta" && typeof delta?.["thinking"] === "string") {
          const itemId = tracked?.itemId ?? active.reasoningItemId ?? this.runtime.startReasoning(session, active.turnId);
          active.reasoningItemId = itemId;
          this.runtime.deltaReasoning(session, active.turnId, itemId, delta["thinking"]);
        } else if (deltaType === "input_json_delta" && typeof delta?.["partial_json"] === "string" && tracked?.kind === "tool") {
          tracked.inputJson += delta["partial_json"];
        }
      } else if (evType === "content_block_stop") {
        const tracked = active.blockItems.get(index);
        if (!tracked) return;
        if (tracked.kind === "text") {
          this.runtime.completeAgentMessage(session, active.turnId, tracked.itemId);
          if (active.messageItemId === tracked.itemId) active.messageItemId = null;
        } else if (tracked.kind === "thinking") {
          this.runtime.completeReasoning(session, active.turnId, tracked.itemId);
          if (active.reasoningItemId === tracked.itemId) active.reasoningItemId = null;
        } else if (tracked.kind === "tool" && tracked.inputJson) {
          const existing = session.items.get(tracked.itemId);
          if (existing) {
            existing["args"] = tracked.inputJson;
            try {
              const parsedArgs = JSON.parse(tracked.inputJson) as Record<string, unknown>;
              if (typeof parsedArgs["command"] === "string") {
                existing["commandText"] = parsedArgs["command"];
              }
            } catch {
              /* partial json */
            }
          }
        }
      }
      return;
    }

    if (type === "assistant") {
      const message = asRecord(msg["message"]);
      const content = Array.isArray(message?.["content"]) ? message!["content"] : [];
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (!block) continue;
        if (block["type"] === "text" && typeof block["text"] === "string" && active.blockItems.size === 0) {
          const id = active.messageItemId ?? this.runtime.startAgentMessage(session, active.turnId);
          this.runtime.completeAgentMessage(session, active.turnId, id, block["text"]);
          active.messageItemId = null;
        } else if (block["type"] === "tool_use") {
          const toolId = str(block["id"]);
          const rawName = str(block["name"]) ?? "tool";
          if (toolId && !active.toolUseItems.has(toolId)) {
            const argsStr = block["input"] ? JSON.stringify(block["input"]) : undefined;
            const cmdText = str(asRecord(block["input"])?.["command"]) ?? undefined;
            const itemId = this.runtime.startToolCall(session, active.turnId, {
              tool: normalizeClaudeToolName(rawName),
              args: argsStr,
              commandText: cmdText,
              extra: { callId: toolId },
            });
            active.toolUseItems.set(toolId, itemId);
          }
        }
      }
      return;
    }

    if (type === "user") {
      const message = asRecord(msg["message"]);
      const content = Array.isArray(message?.["content"]) ? message!["content"] : [];
      for (const rawBlock of content) {
        const block = asRecord(rawBlock);
        if (!block || block["type"] !== "tool_result") continue;
        const toolUseId = str(block["tool_use_id"]);
        const itemId = toolUseId ? active.toolUseItems.get(toolUseId) : undefined;
        if (!itemId) continue;
        const isError = block["is_error"] === true;
        const out =
          typeof block["content"] === "string"
            ? block["content"]
            : Array.isArray(block["content"])
              ? block["content"]
                  .map((c) => str(asRecord(c)?.["text"]) ?? "")
                  .filter(Boolean)
                  .join("\n")
              : "";
        this.runtime.completeToolCall(session, active.turnId, itemId, {
          status: isError ? "failed" : "completed",
          output: out,
          ...(isError ? { failureReason: out || "Tool returned an error." } : {}),
        });
      }
      return;
    }

    if (type === "result") {
      if (active.reasoningItemId) {
        this.runtime.completeReasoning(session, active.turnId, active.reasoningItemId);
      }
      if (active.messageItemId) {
        this.runtime.completeAgentMessage(session, active.turnId, active.messageItemId);
      }
      for (const itemId of active.toolUseItems.values()) {
        const current = session.items.get(itemId);
        if (current?.["status"] === "inProgress") {
          this.runtime.completeToolCall(session, active.turnId, itemId, { status: "completed" });
        }
      }

      const usage = asRecord(msg["usage"]);
      if (usage) {
        const inTok = num(usage["input_tokens"]) ?? 0;
        const outTok = num(usage["output_tokens"]) ?? 0;
        const cacheRead = num(usage["cache_read_input_tokens"]) ?? 0;
        const cacheWrite = num(usage["cache_creation_input_tokens"]) ?? 0;
        if (inTok > 0 || outTok > 0 || cacheRead > 0) {
          this.runtime.recordTokenUsage(session, active.turnId, {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            durationMs: num(msg["duration_ms"]) ?? Date.now() - active.startedAtMs,
          });
        }
      }

      const isError = msg["is_error"] === true || String(msg["subtype"] ?? "").startsWith("error");
      if (isError) {
        const errText =
          str(msg["result"]) ??
          (Array.isArray(msg["errors"]) ? msg["errors"].map(String).join("; ") : null) ??
          "Claude Code reported a turn error.";
        active.reject(new Error(errText));
      } else {
        const resultText = str(msg["result"]);
        const hasAnyAgentMsg = [...session.items.values()].some(
          (i) => i["turnId"] === active.turnId && i["kind"] === "agentMessage",
        );
        if (resultText && !hasAnyAgentMsg) {
          const itemId = this.runtime.startAgentMessage(session, active.turnId);
          this.runtime.completeAgentMessage(session, active.turnId, itemId, resultText);
        }
        active.resolve();
      }
    }
  }

  private async handleControlRequest(
    session: CanonicalSessionState,
    proc: SessionProcessState,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const requestId = str(msg["request_id"]);
    const req = asRecord(msg["request"]) ?? msg;
    const subtype = str(req["subtype"]);
    if (!requestId) return;

    if (subtype !== "can_use_tool") {
      const ack = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {},
        },
      };
      proc.child.stdin.write(`${JSON.stringify(ack)}\n`, "utf8");
      return;
    }

    const toolName = str(req["tool_name"]) ?? "Tool";
    const input = asRecord(req["input"]) ?? asRecord(req["tool_input"]) ?? {};
    const turnId = proc.activeTurn?.turnId ?? session.activeTurnId ?? "turn";

    if (toolName === "AskUserQuestion" && Array.isArray(input["questions"])) {
      const questions = input["questions"]
        .map(asRecord)
        .filter((q): q is Record<string, unknown> => q !== null)
        .map((q, idx) => ({
          id: str(q["header"]) ?? `q_${idx + 1}`,
          header: str(q["header"]) ?? "Question",
          question: str(q["question"]) ?? "",
          multiSelect: q["multiSelect"] === true,
          options: (Array.isArray(q["options"]) ? q["options"] : [])
            .map(asRecord)
            .filter((o): o is Record<string, unknown> => o !== null && typeof o["label"] === "string")
            .map((o) => ({
              label: String(o["label"]),
              ...(str(o["description"]) ? { description: String(o["description"]) } : {}),
            })),
        }));
      const outcome = await this.runtime.requestUserInput(session, turnId, {
        toolName: "AskUserQuestion",
        questions,
      });
      const answersObj: Record<string, string> = {};
      for (const ans of outcome.answers) {
        answersObj[ans.questionId] =
          ans.selectedLabels?.join(", ") ?? ans.selectedLabel ?? ans.freeText ?? "";
      }
      const reply = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: outcome.kind === "cancelled" ? "deny" : "allow",
            ...(outcome.kind === "cancelled"
              ? { message: outcome.reason ?? "Question cancelled by user." }
              : { updatedInput: { ...input, answers: answersObj } }),
          },
        },
      };
      proc.child.stdin.write(`${JSON.stringify(reply)}\n`, "utf8");
      return;
    }

    const commandText = str(input["command"]);
    const filePath = str(input["file_path"]) ?? str(input["path"]);
    const urlText = str(input["url"]);

    const decision = await this.runtime.requestApproval(session, turnId, {
      toolName,
      rawArgs: JSON.stringify(input),
      subject: commandText
        ? { kind: "command", command: commandText, toolName }
        : filePath
          ? { kind: "fileWrite", path: filePath, toolName }
          : urlText
            ? { kind: "network", host: urlText, toolName }
            : { kind: "tool", toolName },
    });

    const responseFrame = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: decision.allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.feedback ?? "Denied by user in Ancilla." },
      },
    };
    proc.child.stdin.write(`${JSON.stringify(responseFrame)}\n`, "utf8");
  }

  private rememberStderr(text: string): void {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    this.stderrTail.push(...lines);
    if (this.stderrTail.length > 16) {
      this.stderrTail.splice(0, this.stderrTail.length - 16);
    }
  }
}
