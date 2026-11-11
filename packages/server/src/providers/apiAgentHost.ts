import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  API_CAPABILITIES,
  CanonicalSessionRuntime,
  PROVIDER_CATALOG,
  type AgentHost,
  type AgentHostStartResult,
  type ApiProviderKind,
  type ApprovalMode,
  type CanonicalSessionState,
  type CanonicalTurnContext,
  type CommandConnection,
  type ProviderCapabilities,
  type ServeExit,
  type SessionJournal,
} from "@ancilla/daemon";
import { isProtectedProjectPath } from "../assistant/brain-step.js";
import { FileError, listFolder, readProjectFile, searchProjectFiles, writeProjectFile } from "../files.js";
import {
  AnthropicProvider,
  GoogleGenAiProvider,
  OpenAiCompatibleProvider,
  withToolFallback,
  type BrainProvider,
  type ChatMessage,
  type ToolCall,
  type ToolSpec,
} from "../voice/brain.js";

const MAX_TOOL_ROUNDS = 16;
const MAX_READ_CHARS = 24_000;
const MAX_CMD_OUTPUT_CHARS = 32_000;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const CMD_TIMEOUT_MS = 90_000;

const API_AGENT_TOOLS: ToolSpec[] = [
  {
    name: "list_folder",
    description: "List files and folders inside a directory relative to the workspace root (use '.' for root).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory path inside the workspace." },
      },
    },
  },
  {
    name: "read_file",
    description: "Read UTF-8 text from a file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the workspace." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files in the workspace whose paths match all words in the query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords matched against file paths." },
      },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the workspace." },
        content: { type: "string", description: "Complete UTF-8 file text." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact substring inside an existing UTF-8 file in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the workspace." },
        old_text: { type: "string", description: "Exact existing text to replace." },
        new_text: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace all occurrences when true." },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "shell",
    description: "Run a shell command inside the workspace root (for builds, tests, git status, or diagnostics).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute in the workspace root." },
      },
      required: ["command"],
    },
  },
  {
    name: "web_search",
    description: "Search the public web for a query and return matching titles and URLs.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string." },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a public HTTPS/HTTP web page and extract readable text.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http:// or https:// URL." },
      },
      required: ["url"],
    },
  },
];

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    clean === "localhost" ||
    clean.endsWith(".localhost") ||
    clean.endsWith(".local") ||
    clean === "0.0.0.0" ||
    clean === "::1"
  ) {
    return true;
  }
  const ipKind = isIP(clean);
  if (ipKind === 4) {
    const parts = clean.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (ipKind === 6) {
    return clean === "::1" || clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fe80:");
  }
  return false;
}

async function resolveSafeWritePath(root: string, requested: string): Promise<{ realRoot: string; abs: string; rel: string }> {
  if (/[\u0000-\u001f\u007f]/.test(requested)) {
    throw new FileError(400, "File path contains invalid control characters.");
  }
  let value = requested.trim().replace(/\\/g, "/");
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normRoot && (value === normRoot || value.startsWith(`${normRoot}/`))) {
    value = value.slice(normRoot.length);
  }
  value = value.replace(/^\/+/, "").replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = value.split("/");
  if (!value || value === "." || /^[A-Za-z]:/.test(value) || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new FileError(403, "Path is outside the workspace.");
  }
  const rel = segments.join("/");
  const protectedReason = isProtectedProjectPath(rel);
  if (protectedReason) throw new FileError(403, protectedReason);

  const realRoot = await realpath(root).catch(() => {
    throw new FileError(404, "Workspace folder does not exist.");
  });
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = resolve(cursor, segments[i] as string);
    const info = await lstat(cursor).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw new FileError(403, "Refusing to write through a symbolic link.");
    }
    if (i < segments.length - 1 && !info.isDirectory()) {
      throw new FileError(400, `Parent segment '${segments.slice(0, i + 1).join("/")}' is not a directory.`);
    }
    if (i === segments.length - 1 && info.isDirectory()) {
      throw new FileError(400, "Target path is a directory, not a file.");
    }
  }
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (!cursor.startsWith(rootPrefix)) {
    throw new FileError(403, "Path resolved outside the workspace.");
  }
  return { realRoot, abs: cursor, rel: relative(realRoot, cursor).split(sep).join("/") };
}

async function atomicWriteWorkspaceFile(root: string, requested: string, content: string): Promise<{ path: string; size: number }> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_WRITE_BYTES) {
    throw new FileError(413, "File exceeds 5 MB limit.");
  }
  const { realRoot, abs, rel } = await resolveSafeWritePath(root, requested);
  const parent = dirname(abs);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (realParent !== realRoot && !realParent.startsWith(rootPrefix)) {
    throw new FileError(403, "Parent directory resolved outside the workspace.");
  }
  const existing = await lstat(abs).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new FileError(400, "Only regular files can be written.");
  }
  const temp = join(parent, `.${basename(abs)}.ancilla-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await writeFile(temp, bytes, existing ? { mode: existing.mode } : undefined);
    await rename(temp, abs);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { path: rel, size: bytes.length };
}

function scrubbedWorkspaceEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (upper.startsWith("ANCILLA_TOKEN") || upper.startsWith("ANCILLA_AUTH") || upper.startsWith("ANCILLA_SECRET")) {
      continue;
    }
    clean[k] = v;
  }
  clean["CI"] = "1";
  return clean;
}

function defaultModelForKind(kind: ApiProviderKind, baseUrl: string): string {
  if (/openrouter\.ai/i.test(baseUrl)) return "openrouter/auto";
  if (/localhost:11434|127\.0\.0\.1:11434/i.test(baseUrl)) return "qwen2.5-coder:7b";
  if (kind === "anthropic") return "claude-sonnet-4-6";
  if (kind === "google") return "gemini-2.5-pro";
  return "gpt-5.3-codex";
}

export interface ApiAgentHostConfig {
  accountName?: string;
  apiKind: ApiProviderKind;
  baseUrl: string;
  resolveApiKey: () => string | null;
  defaultModelId?: string | null;
  customModels?: readonly string[];
  local?: boolean;
  journal?: SessionJournal;
  fetchImpl?: typeof fetch;
  /** Optional BrainProvider factory override for deterministic unit tests. */
  brainFactory?: (modelId: string) => BrainProvider;
}

/**
 * Built-in Direct HTTP API / BYOK / Aggregator / Local AgentHost (`api`).
 * Supports OpenRouter, Venice, OpenAI API keys, Anthropic API keys, Google Gemini API keys,
 * Ollama, LM Studio, llama.cpp, and vLLM with approval-gated workspace coding tools.
 */
export class ApiAgentHost implements AgentHost {
  readonly providerId = "api" as const;
  readonly capabilities: ProviderCapabilities = API_CAPABILITIES;
  private readonly runtime: CanonicalSessionRuntime;
  private readonly histories = new Map<string, ChatMessage[]>();
  private cachedRemoteModels: { models: Record<string, unknown>[]; fetchedAtMs: number } | null = null;
  private remoteInFlight: Promise<Record<string, unknown>[] | null> | null = null;
  private closed = false;

  constructor(private readonly config: ApiAgentHostConfig) {
    this.runtime = new CanonicalSessionRuntime({
      providerId: this.providerId,
      capabilities: this.capabilities,
      journal: config.journal,
      onStartSession: async (opts) => {
        const chosen = opts.modelId ?? config.defaultModelId ?? defaultModelForKind(config.apiKind, config.baseUrl);
        this.histories.set(opts.sessionId, []);
        return { externalSessionId: opts.sessionId, modelId: chosen };
      },
      onResumeSession: async (session) => {
        if (!this.histories.has(session.sessionId)) {
          this.histories.set(session.sessionId, this.rebuildHistoryFromItems(session));
        }
        return {
          externalSessionId: session.sessionId,
          modelId: session.modelId ?? config.defaultModelId ?? defaultModelForKind(config.apiKind, config.baseUrl),
        };
      },
      onRunTurn: (ctx) => this.handleRunTurn(ctx),
      onInterruptTurn: async () => undefined,
      onListModels: () => this.handleListModels(),
      onCompactSession: (session) => this.handleCompactSession(session),
      onForkSession: (source, newSessionId) => this.handleForkSession(source, newSessionId),
    });
  }

  get connection(): CommandConnection {
    return this.runtime;
  }

  async start(_clientVersion: string): Promise<AgentHostStartResult> {
    if (this.closed) {
      throw new Error("ApiAgentHost is closed.");
    }
    return {
      initializeResult: {
        serverInfo: {
          name: `api-${this.config.apiKind}`,
          version: "built-in",
        },
      },
      fingerprintWarning: null,
    };
  }

  async close(): Promise<ServeExit> {
    this.closed = true;
    return { code: 0, signal: null };
  }

  private makeBrainFor(modelId: string): BrainProvider {
    if (this.config.brainFactory) {
      return this.config.brainFactory(modelId);
    }
    const apiKey = this.config.resolveApiKey();
    const baseUrl = this.config.baseUrl;
    const local = this.config.local ?? /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(baseUrl);

    if (this.config.apiKind === "anthropic") {
      const inner = new AnthropicProvider({
        baseUrl,
        model: modelId,
        apiKey,
        local,
        fetchImpl: this.config.fetchImpl,
        defaultMaxTokens: 4096,
      });
      return withToolFallback(inner, { key: `anthropic:${baseUrl}|${modelId}` });
    }

    if (this.config.apiKind === "google") {
      const inner = new GoogleGenAiProvider({
        baseUrl,
        model: modelId,
        apiKey,
        local,
        fetchImpl: this.config.fetchImpl,
        defaultMaxTokens: 4096,
      });
      return withToolFallback(inner, { key: `google:${baseUrl}|${modelId}` });
    }

    const headers: Record<string, string> = {};
    if (/openrouter\.ai/i.test(baseUrl)) {
      headers["HTTP-Referer"] = "https://github.com/aleff-ferreira/ancilla";
      headers["X-Title"] = "Ancilla";
    }
    const inner = new OpenAiCompatibleProvider({
      baseUrl,
      model: modelId,
      apiKey,
      local,
      headers,
      fetchImpl: this.config.fetchImpl,
    });
    return withToolFallback(inner, { key: `openai:${baseUrl}|${modelId}` });
  }

  private rebuildHistoryFromItems(session: CanonicalSessionState): ChatMessage[] {
    const history: ChatMessage[] = [];
    for (const item of session.items.values()) {
      if (item["kind"] === "userMessage") {
        const content = Array.isArray(item["content"]) ? item["content"] : [];
        const text = content
          .map((p) => (typeof p === "object" && p !== null ? String((p as Record<string, unknown>)["text"] ?? "") : ""))
          .filter(Boolean)
          .join("\n");
        if (text) history.push({ role: "user", content: text });
      } else if (item["kind"] === "agentMessage" && typeof item["text"] === "string" && item["text"].trim() !== "") {
        history.push({ role: "assistant", content: item["text"] });
      }
    }
    return history;
  }

  private async handleListModels(): Promise<{ models: Record<string, unknown>[]; source?: string } | null> {
    const models = new Map<string, Record<string, unknown>>();
    const defaultId = this.config.defaultModelId?.trim() || null;
    if (defaultId) {
      models.set(defaultId, {
        modelId: defaultId,
        displayLabel: defaultId,
        providerId: "api",
        isDefault: true,
      });
    }
    for (const custom of this.config.customModels ?? []) {
      const trimmed = custom.trim();
      if (trimmed && !models.has(trimmed)) {
        models.set(trimmed, {
          modelId: trimmed,
          displayLabel: trimmed,
          providerId: "api",
          isDefault: trimmed === defaultId,
        });
      }
    }

    const remote = await this.getRemoteModels();
    if (remote && remote.length > 0) {
      for (const item of remote) {
        const id = typeof item["modelId"] === "string" ? item["modelId"] : "";
        if (!id) continue;
        const existing = models.get(id);
        if (existing) {
          models.set(id, {
            ...item,
            ...existing,
            displayLabel:
              existing["displayLabel"] === id && typeof item["displayLabel"] === "string"
                ? item["displayLabel"]
                : existing["displayLabel"],
            isDefault: existing["isDefault"] === true,
          });
        } else {
          models.set(id, { ...item, isDefault: id === defaultId });
        }
      }
      const list = [...models.values()];
      if (list.length > 0 && !list.some((m) => m["isDefault"] === true)) {
        list[0]!["isDefault"] = true;
      }
      return { source: "providerCatalog", models: list };
    }

    if (models.size === 0) {
      for (const seed of PROVIDER_CATALOG.api.fallbackModels) {
        if (!models.has(seed.modelId)) {
          models.set(seed.modelId, { ...seed, providerId: "api", isDefault: seed.modelId === defaultId });
        }
      }
    }
    if (models.size === 0) {
      const fallback = defaultModelForKind(this.config.apiKind, this.config.baseUrl);
      models.set(fallback, { modelId: fallback, displayLabel: fallback, providerId: "api", isDefault: true });
    }
    const list = [...models.values()];
    if (list.length > 0 && !list.some((m) => m["isDefault"] === true)) {
      list[0]!["isDefault"] = true;
    }
    const hasCustom = Boolean(defaultId || (this.config.customModels && this.config.customModels.length > 0));
    return { source: hasCustom ? "providerCatalog" : "bundledCatalog", models: list };
  }

  private async getRemoteModels(): Promise<Record<string, unknown>[] | null> {
    if (this.cachedRemoteModels && Date.now() - this.cachedRemoteModels.fetchedAtMs < 5 * 60_000) {
      return this.cachedRemoteModels.models;
    }
    if (this.remoteInFlight) {
      return this.remoteInFlight;
    }
    const task = this.fetchRemoteModels().finally(() => {
      this.remoteInFlight = null;
    });
    this.remoteInFlight = task;
    return task;
  }

  private async fetchRemoteModels(): Promise<Record<string, unknown>[] | null> {
    if (this.closed) {
      return null;
    }
    const apiKey = this.config.resolveApiKey();
    const baseUrl = this.config.baseUrl.replace(/\/+$/, "");
    const local = this.config.local ?? /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(baseUrl);
    if (!apiKey && !local) {
      return null;
    }
    const fetchFn = this.config.fetchImpl ?? fetch;
    const asRec = (val: unknown): Record<string, unknown> | null =>
      typeof val === "object" && val !== null && !Array.isArray(val) ? (val as Record<string, unknown>) : null;
    const strVal = (val: unknown): string | null => (typeof val === "string" && val.trim().length > 0 ? val.trim() : null);
    const numVal = (val: unknown): number | null => (typeof val === "number" && Number.isFinite(val) ? val : null);

    try {
      if (this.config.apiKind === "anthropic") {
        const url = /\/v1$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
        const headers: Record<string, string> = {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        };
        const res = await fetchFn(url, { method: "GET", headers, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return null;
        const body = asRec(await res.json());
        const data = Array.isArray(body?.["data"]) ? body["data"] : null;
        if (!data) return null;
        const out: Record<string, unknown>[] = [];
        for (const item of data) {
          const m = asRec(item);
          const id = strVal(m?.["id"]);
          if (!m || !id) continue;
          out.push({
            modelId: id,
            displayLabel: strVal(m["display_name"]) ?? id,
            description: "",
            providerId: "api",
          });
        }
        if (out.length > 0) {
          this.cachedRemoteModels = { models: out, fetchedAtMs: Date.now() };
          return out;
        }
        return null;
      }

      if (this.config.apiKind === "google") {
        const url = /\/v1beta$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1beta/models`;
        const headers: Record<string, string> = {
          accept: "application/json",
          ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
        };
        const res = await fetchFn(url, { method: "GET", headers, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return null;
        const body = asRec(await res.json());
        const items = Array.isArray(body?.["models"]) ? body["models"] : null;
        if (!items) return null;
        const out: Record<string, unknown>[] = [];
        for (const item of items) {
          const m = asRec(item);
          const rawName = strVal(m?.["name"]);
          if (!m || !rawName) continue;
          const methods = Array.isArray(m["supportedGenerationMethods"]) ? m["supportedGenerationMethods"] : null;
          if (methods && !methods.includes("generateContent")) continue;
          const id = rawName.replace(/^models\//i, "");
          const contextLimit = numVal(m["inputTokenLimit"]);
          const outputLimit = numVal(m["outputTokenLimit"]);
          out.push({
            modelId: id,
            displayLabel: strVal(m["displayName"]) ?? id,
            description: strVal(m["description"]) ?? "",
            providerId: "api",
            ...(contextLimit !== null ? { contextLimit, contextWindowTokens: contextLimit } : {}),
            ...(outputLimit !== null ? { outputLimit } : {}),
          });
        }
        if (out.length > 0) {
          this.cachedRemoteModels = { models: out, fetchedAtMs: Date.now() };
          return out;
        }
        return null;
      }

      // OpenAI-compatible (OpenAI, OpenRouter, Venice, Ollama, LM Studio, vLLM)
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      };
      const candidateUrls = [`${baseUrl}/models`];
      if (!/\/v1$/i.test(baseUrl) && local) {
        candidateUrls.push(`${baseUrl}/v1/models`, `${baseUrl}/api/tags`);
      }
      const nonChatPattern =
        /^(whisper|tts-|dall-e|gpt-image|text-embedding|embedding-|omni-moderation|text-moderation|babbage-|davinci-|canary-)/i;
      for (const url of candidateUrls) {
        const res = await fetchFn(url, { method: "GET", headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
        if (!res || !res.ok) continue;
        const body = asRec(await res.json().catch(() => null));
        const items = Array.isArray(body?.["data"])
          ? body["data"]
          : Array.isArray(body?.["models"])
            ? body["models"]
            : null;
        if (!items) continue;
        const out: Record<string, unknown>[] = [];
        for (const item of items) {
          const m = asRec(item);
          const id = strVal(m?.["id"]) ?? strVal(m?.["name"]);
          if (!m || !id || nonChatPattern.test(id)) continue;
          const topProvider = asRec(m["top_provider"]);
          const contextLimit =
            numVal(m["context_length"]) ??
            numVal(topProvider?.["context_length"]) ??
            numVal(m["contextWindow"]) ??
            numVal(m["max_model_len"]);
          const outputLimit =
            numVal(topProvider?.["max_completion_tokens"]) ?? numVal(m["max_output_tokens"]);
          out.push({
            modelId: id,
            displayLabel: strVal(m["name"]) ?? strVal(m["display_name"]) ?? id,
            description: strVal(m["description"]) ?? "",
            providerId: "api",
            ...(contextLimit !== null ? { contextLimit, contextWindowTokens: contextLimit } : {}),
            ...(outputLimit !== null ? { outputLimit } : {}),
          });
        }
        if (out.length > 0) {
          this.cachedRemoteModels = { models: out, fetchedAtMs: Date.now() };
          return out;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async handleForkSession(
    source: CanonicalSessionState,
    newSessionId: string,
  ): Promise<{ externalSessionId?: string | null }> {
    const existing = this.histories.get(source.sessionId) ?? this.rebuildHistoryFromItems(source);
    this.histories.set(newSessionId, existing.map((m) => ({ ...m })));
    return { externalSessionId: newSessionId };
  }

  private async handleCompactSession(session: CanonicalSessionState): Promise<unknown> {
    const history = this.histories.get(session.sessionId);
    if (!history || history.length <= 4) {
      return { ok: true };
    }
    const modelId = session.modelId ?? this.config.defaultModelId ?? defaultModelForKind(this.config.apiKind, this.config.baseUrl);
    const brain = this.makeBrainFor(modelId);
    let summary = "";
    for await (const ev of brain.stream({
      messages: [
        { role: "system", content: "Summarize the key decisions, files edited, and current state concisely for continuing work." },
        ...history,
        { role: "user", content: "Provide a concise continuation summary." },
      ],
      tools: [],
      signal: AbortSignal.timeout(30_000),
      maxTokens: 1024,
      temperature: 0.2,
    })) {
      if (ev.type === "text") summary += ev.delta;
    }
    if (summary.trim()) {
      this.histories.set(session.sessionId, [
        { role: "user", content: "[Compacted prior context]" },
        { role: "assistant", content: summary.trim() },
      ]);
    }
    return { ok: true };
  }

  private async handleRunTurn(ctx: CanonicalTurnContext): Promise<void> {
    const { session, turnId, prompt, signal } = ctx;
    const modelId = session.modelId ?? this.config.defaultModelId ?? defaultModelForKind(this.config.apiKind, this.config.baseUrl);
    const brain = this.makeBrainFor(modelId);

    let history = this.histories.get(session.sessionId);
    if (!history) {
      history = this.rebuildHistoryFromItems(session);
      this.histories.set(session.sessionId, history);
    }
    history.push({ role: "user", content: prompt });

    const systemPrompt = [
      `You are a coding agent working inside workspace "${session.workspaceRoot}".`,
      "Inspect existing files with list_folder, search_files, and read_file before editing.",
      "Use edit_file or write_file for targeted changes, shell to run builds/tests when needed, and web_fetch for public URLs.",
      "Be concise, accurate, and never fabricate command output or file contents.",
    ].join(" ");

    let totalIn = 0;
    let totalOut = 0;
    const startedAt = Date.now();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      if (signal.aborted) return;

      const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...history];
      let msgItemId: string | null = null;
      let assistantText = "";
      const toolCalls: ToolCall[] = [];

      for await (const ev of brain.stream({
        messages,
        tools: API_AGENT_TOOLS,
        signal,
        maxTokens: 4096,
      })) {
        if (ev.type === "text") {
          assistantText += ev.delta;
          if (!msgItemId) {
            msgItemId = this.runtime.startAgentMessage(session, turnId);
          }
          this.runtime.deltaAgentMessage(session, turnId, msgItemId, ev.delta);
        } else if (ev.type === "tool") {
          toolCalls.push(ev.call);
        } else if (ev.type === "usage") {
          totalIn += ev.inputTokens;
          totalOut += ev.outputTokens;
        } else if (ev.type === "error") {
          if (msgItemId) {
            this.runtime.completeAgentMessage(session, turnId, msgItemId, assistantText);
          }
          throw new Error(ev.message);
        }
      }

      if (msgItemId) {
        this.runtime.completeAgentMessage(session, turnId, msgItemId, assistantText);
      }

      if (toolCalls.length === 0) {
        if (assistantText.trim() !== "") {
          history.push({ role: "assistant", content: assistantText });
        }
        break;
      }

      history.push({ role: "assistant", content: assistantText, toolCalls });

      for (const call of toolCalls) {
        if (signal.aborted) return;
        const output = await this.executeToolWithApproval(session, turnId, call, signal);
        history.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: output,
        });
      }
    }

    if (totalIn > 0 || totalOut > 0) {
      this.runtime.recordTokenUsage(session, turnId, {
        inputTokens: totalIn,
        outputTokens: totalOut,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  private async executeToolWithApproval(
    session: CanonicalSessionState,
    turnId: string,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<string> {
    const args = parseToolArgs(call.arguments);
    const cmdText = call.name === "shell" && typeof args["command"] === "string" ? args["command"] : undefined;
    const itemId = this.runtime.startToolCall(session, turnId, {
      tool: call.name,
      args: call.arguments,
      commandText: cmdText,
    });

    const isMutating = call.name === "write_file" || call.name === "edit_file" || call.name === "shell";
    if (isMutating) {
      if (session.approvalMode === "denyUnmatched") {
        const msg = "Denied by session approval mode (denyUnmatched).";
        this.runtime.completeToolCall(session, turnId, itemId, { status: "failed", output: msg, failureReason: msg });
        return `Error: ${msg}`;
      }
      if (session.approvalMode !== "allowAll") {
        const targetPath = typeof args["path"] === "string" ? args["path"] : "";
        const decision = await this.runtime.requestApproval(session, turnId, {
          itemId,
          toolName: call.name,
          rawArgs: call.arguments,
          subject:
            call.name === "shell"
              ? { kind: "command", command: cmdText ?? "", toolName: "shell" }
              : {
                  kind: "fileWrite",
                  path: targetPath,
                  toolName: call.name,
                },
        });
        if (!decision.allow) {
          const reason = decision.feedback ? `Denied by user: ${decision.feedback}` : "Denied by user.";
          this.runtime.completeToolCall(session, turnId, itemId, {
            status: "failed",
            output: reason,
            failureReason: reason,
          });
          return `Error: ${reason}`;
        }
      }
    }

    try {
      const output = await this.runToolBody(session, turnId, itemId, call.name, args, signal);
      this.runtime.completeToolCall(session, turnId, itemId, {
        status: "completed",
        output,
      });
      return output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.runtime.completeToolCall(session, turnId, itemId, {
        status: "failed",
        output: msg,
        failureReason: msg,
      });
      return `Error: ${msg}`;
    }
  }

  private async runToolBody(
    session: CanonicalSessionState,
    turnId: string,
    itemId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const root = session.workspaceRoot || process.cwd();

    if (name === "list_folder") {
      const requested = typeof args["path"] === "string" && args["path"].trim() !== "" ? args["path"] : ".";
      const listing = await listFolder(root, root, requested);
      const lines = listing.entries
        .slice(0, 200)
        .map((e) => `${e.kind === "dir" ? "[dir]" : "[file]"} ${e.path}${e.kind === "file" ? ` (${e.size} B)` : ""}`);
      if (listing.entries.length > 200 || listing.truncated) lines.push("... (truncated)");
      return lines.length > 0 ? lines.join("\n") : "(empty folder)";
    }

    if (name === "read_file") {
      const requested = typeof args["path"] === "string" ? args["path"] : "";
      if (!requested.trim()) throw new Error("path is required.");
      const file = await readProjectFile(root, root, requested);
      if (file.content === undefined) {
        return `[${file.kind}: ${file.path}, ${file.size} bytes — binary/media file]`;
      }
      return file.content.length > MAX_READ_CHARS
        ? `${file.content.slice(0, MAX_READ_CHARS)}\n... (truncated at ${MAX_READ_CHARS} chars)`
        : file.content;
    }

    if (name === "search_files") {
      const query = typeof args["query"] === "string" ? args["query"] : "";
      if (!query.trim()) throw new Error("query is required.");
      const matches = await searchProjectFiles(root, query, 50);
      return matches.length > 0 ? matches.map((m) => m.path).join("\n") : "(no matching files)";
    }

    if (name === "write_file") {
      const requested = typeof args["path"] === "string" ? args["path"] : "";
      const content = typeof args["content"] === "string" ? args["content"] : null;
      if (!requested.trim() || content === null) throw new Error("path and content are required.");
      const saved = await atomicWriteWorkspaceFile(root, requested, content);
      return `Wrote ${saved.path} (${saved.size} bytes).`;
    }

    if (name === "edit_file") {
      const requested = typeof args["path"] === "string" ? args["path"] : "";
      const oldText = typeof args["old_text"] === "string" ? args["old_text"] : "";
      const newText = typeof args["new_text"] === "string" ? args["new_text"] : null;
      const replaceAll = args["replace_all"] === true;
      if (!requested.trim() || !oldText || newText === null) {
        throw new Error("path, old_text, and new_text are required.");
      }
      const { rel } = await resolveSafeWritePath(root, requested);
      const current = await readProjectFile(root, root, rel);
      if (current.content === undefined) throw new Error(`${rel} is a binary file.`);
      let count = 0;
      let idx = 0;
      while ((idx = current.content.indexOf(oldText, idx)) !== -1) {
        count += 1;
        idx += oldText.length;
      }
      if (count === 0) throw new Error(`old_text not found in ${rel}.`);
      if (count > 1 && !replaceAll) {
        throw new Error(`old_text matched ${count} times in ${rel}; pass replace_all: true or add context.`);
      }
      const firstIdx = current.content.indexOf(oldText);
      const updated = replaceAll
        ? current.content.split(oldText).join(newText)
        : `${current.content.slice(0, firstIdx)}${newText}${current.content.slice(firstIdx + oldText.length)}`;
      const saved = await writeProjectFile(root, root, rel, updated, current.mtimeMs);
      return `Edited ${saved.path} (${count} replacement${count === 1 ? "" : "s"}, ${saved.size} bytes).`;
    }

    if (name === "shell") {
      const command = typeof args["command"] === "string" ? args["command"].trim() : "";
      if (!command) throw new Error("command is required.");
      const shellBin = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const shellArgs = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
      return new Promise<string>((resolveCmd, rejectCmd) => {
        const child = spawn(shellBin, shellArgs, {
          cwd: root,
          env: scrubbedWorkspaceEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let out = "";
        let timedOut = false;
        const append = (buf: Buffer): void => {
          const text = buf.toString("utf8");
          if (out.length < MAX_CMD_OUTPUT_CHARS) {
            const slice = text.slice(0, MAX_CMD_OUTPUT_CHARS - out.length);
            out += slice;
            this.runtime.deltaToolOutput(session, turnId, itemId, slice);
          }
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }, CMD_TIMEOUT_MS);
        timer.unref?.();
        const onAbort = (): void => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (err) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          rejectCmd(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          const header = timedOut ? "[timed out]" : `[exit ${code ?? 0}]`;
          resolveCmd(`${header}\n${out.trim() || "(no output)"}`);
        });
      });
    }

    if (name === "web_search") {
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      if (!query) {
        throw new Error("query is required.");
      }
      const doFetch = this.config.fetchImpl ?? fetch;
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await doFetch(ddgUrl, {
        headers: { "user-agent": "Ancilla/1.0 (+https://github.com/HarjjotSinghh/ancilla)" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!resp.ok) {
        throw new Error(`Search HTTP ${resp.status}`);
      }
      const html = await resp.text();
      const results: { title: string; url: string }[] = [];
      for (const match of html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        let rawHref = match[1] ?? "";
        const uddg = /[?&]uddg=([^&]+)/.exec(rawHref);
        if (uddg?.[1]) {
          try {
            rawHref = decodeURIComponent(uddg[1]);
          } catch {
            /* keep raw */
          }
        }
        const title = (match[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (/^https?:\/\//i.test(rawHref) && title && !results.some((r) => r.url === rawHref)) {
          results.push({ title, url: rawHref });
        }
        if (results.length >= 10) break;
      }
      return JSON.stringify({ query, results }, null, 2);
    }

    if (name === "web_fetch") {
      const urlStr = typeof args["url"] === "string" ? args["url"].trim() : "";
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(urlStr);
      } catch {
        throw new Error("Invalid URL.");
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs are allowed.");
      }
      if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
        throw new Error("Refusing to fetch private or loopback network addresses.");
      }
      const doFetch = this.config.fetchImpl ?? fetch;
      const resp = await doFetch(parsedUrl.toString(), {
        headers: { "user-agent": "Ancilla/1.0 (+https://github.com/HarjjotSinghh/ancilla)" },
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} from ${parsedUrl.hostname}`);
      }
      const rawText = await resp.text();
      const stripped = rawText
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return `URL: ${parsedUrl.toString()}\n\n${stripped.slice(0, MAX_READ_CHARS)}`;
    }

    throw new Error(`Unknown tool "${name}".`);
  }
}
