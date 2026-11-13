/**
 * The mind of a call, as an interface any model can stand behind. A provider takes the conversation so far and streams
 * back text and requests to use tools; it knows nothing of audio, of turns or of Ancilla. That is the whole contract, and
 * it is small enough that a local model behind llama.cpp, a hosted API and a Muse thread all fit it:
 *
 *   stream(messages, tools, signal) -> text deltas, tool calls, usage, and how it ended
 *
 * Aborting the signal stops the stream, and costs nothing more.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments as JSON text, as the model wrote them: they are parsed, and checked, by whoever runs the tool. */
  arguments: string;
  /** Optional provider thought signature (such as Gemini 2.5 thinking parts) preserved across tool rounds. */
  thoughtSignature?: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; rawUserText?: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; spokenNarration?: string };

export type BrainEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; reason: "stop" | "tool" | "length" }
  /** Something the person should be told that does not stop the answer: shown on the call, the answer goes on. */
  | { type: "notice"; text: string }
  /** `code` says why, when the caller can do something about it: "tools-unsupported" is a server that turned the request down because it cannot take tools. */
  | { type: "error"; message: string; retryable: boolean; code?: "tools-unsupported" };

export interface BrainRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface BrainCapabilities {
  /** Calls tools natively. When false, `withTextTools` can give it tools by a convention in the text. */
  tools: boolean;
  /** Cheap to start and to cancel, so a reply can be started before the person has surely finished. */
  speculative: boolean;
  /** Runs on this machine: nothing said leaves it. */
  local: boolean;
}

export interface BrainProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: BrainCapabilities;
  warm?(): Promise<void>;
  stream(request: BrainRequest): AsyncIterable<BrainEvent>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Any server that speaks the OpenAI chat-completions protocol: OpenAI, OpenRouter, Groq, Together, Ollama, llama.cpp,
// LM Studio, vLLM and the compatibility layers of the other large providers.

export interface OpenAiOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  label?: string;
  local?: boolean;
  headers?: Record<string, string>;
  /** For tests. */
  fetchImpl?: typeof fetch;
  temperature?: number;
}

/**
 * How model servers say they cannot take tools: Ollama ("does not support tools"), llama.cpp ("tools param requires
 * --jinja"), vLLM ("auto tool choice requires --enable-auto-tool-choice"), OpenRouter ("support tool use"). Only a refusal
 * that says so is taken as one: a bad key or a busy server is an error as it always was.
 */
const TOOLS_NOT_TAKEN = /does not support tools?|support tool|tools? (param|parameter)|unsupported[^.]{0,30}tools?|--jinja|tool[_ -]?choice|tool[_ -]?use|tool[_ -]?call|function[_ -]?call/i;
const STREAM_OPTIONS_REFUSED = /stream[_ -]?options|include[_ -]?usage/i;
const TOOL_REFUSAL_STATUS = new Set([400, 404, 422, 500, 501]);
const streamOptionsUnsupported = new Set<string>();

/**
 * Reasoning models (Qwen3, DeepSeek-R1, QwQ, Nemotron) often wrap internal thoughts in `<think>...</think>` inside the
 * content stream. Speaking those thoughts aloud or showing them as answers ruins a call or a task, so this filter strips
 * them as chunks arrive while letting ordinary text pass without waiting.
 */
export class ThinkTagFilter {
  private buffer = "";
  private thinking = false;
  private trimLeading = false;

  push(delta: string): string {
    if (delta === "") return "";
    this.buffer += delta;
    let out = "";
    for (;;) {
      if (this.thinking) {
        const close = this.buffer.toLowerCase().indexOf("</think>");
        if (close < 0) {
          // Keep only a possible partial `</think>` tail.
          const tail = partialTagTail(this.buffer, "</think>");
          this.buffer = tail;
          return out;
        }
        this.buffer = this.buffer.slice(close + "</think>".length);
        this.thinking = false;
        this.trimLeading = true;
      }
      if (this.trimLeading) {
        this.buffer = this.buffer.replace(/^\s+/, "");
        if (this.buffer === "") return out;
        this.trimLeading = false;
      }
      const open = this.buffer.toLowerCase().indexOf("<think>");
      if (open < 0) {
        const tail = partialTagTail(this.buffer, "<think>");
        const emitLen = this.buffer.length - tail.length;
        if (emitLen > 0) {
          out += this.buffer.slice(0, emitLen);
          this.buffer = tail;
        }
        return out;
      }
      if (open > 0) out += this.buffer.slice(0, open);
      this.buffer = this.buffer.slice(open + "<think>".length);
      this.thinking = true;
    }
  }

  finish(): string {
    const rest = this.thinking ? "" : this.trimLeading ? this.buffer.replace(/^\s+/, "") : this.buffer;
    this.buffer = "";
    this.thinking = false;
    this.trimLeading = false;
    return rest;
  }
}

function partialTagTail(text: string, tag: string): string {
  const lower = text.toLowerCase();
  const max = Math.min(lower.length, tag.length - 1);
  for (let len = max; len >= 1; len -= 1) {
    if (lower.endsWith(tag.slice(0, len))) return text.slice(text.length - len);
  }
  return "";
}

interface WireToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

function formatToolContent(m: Extract<ChatMessage, { role: "tool" }>): string {
  return m.spokenNarration
    ? `${m.content}\n[Already spoken aloud: "${m.spokenNarration}" — do not repeat this confirmation unless adding new facts.]`
    : m.content;
}

function wireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "assistant":
        return m.toolCalls && m.toolCalls.length > 0
          ? { role: "assistant", content: m.content === "" ? null : m.content, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
          : { role: "assistant", content: m.content };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: formatToolContent(m) };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

export class OpenAiCompatibleProvider implements BrainProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: BrainCapabilities;

  constructor(private readonly options: OpenAiOptions) {
    this.id = `openai:${options.model}`;
    this.label = options.label ?? options.model;
    this.capabilities = { tools: true, speculative: options.local === true, local: options.local === true };
  }

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const o = this.options;
    const doFetch = o.fetchImpl ?? fetch;
    const base = o.baseUrl.replace(/\/+$/, "");
    const send = async (withStreamOptions: boolean): Promise<Response> => {
      const body: Record<string, unknown> = {
        model: o.model,
        messages: wireMessages(request.messages),
        stream: true,
        ...(withStreamOptions ? { stream_options: { include_usage: true } } : {}),
        temperature: request.temperature ?? o.temperature ?? 0.7,
      };
      if (request.maxTokens) body["max_tokens"] = request.maxTokens;
      if (request.tools.length > 0) body["tools"] = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      return doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}), ...(o.headers ?? {}) },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    };
    let usedStreamOptions = !streamOptionsUnsupported.has(base);
    let response: Response;
    try {
      response = await send(usedStreamOptions);
    } catch (error) {
      if (request.signal.aborted) return;
      yield { type: "error", message: `The model could not be reached: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
      return;
    }
    if ((!response.ok || !response.body) && usedStreamOptions && (response.status === 400 || response.status === 422)) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* the body is only for the message */
      }
      if (STREAM_OPTIONS_REFUSED.test(detail)) {
        streamOptionsUnsupported.add(base);
        usedStreamOptions = false;
        try {
          response = await send(false);
        } catch (error) {
          if (request.signal.aborted) return;
          yield { type: "error", message: `The model could not be reached: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
          return;
        }
      } else {
        const toolsRefused = request.tools.length > 0 && TOOL_REFUSAL_STATUS.has(response.status) && TOOLS_NOT_TAKEN.test(detail);
        yield { type: "error", message: `The model answered ${response.status}${detail ? `: ${detail}` : ""}`, retryable: false, ...(toolsRefused ? { code: "tools-unsupported" as const } : {}) };
        return;
      }
    }
    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* the body is only for the message */
      }
      const toolsRefused = request.tools.length > 0 && TOOL_REFUSAL_STATUS.has(response.status) && TOOLS_NOT_TAKEN.test(detail);
      yield { type: "error", message: `The model answered ${response.status}${detail ? `: ${detail}` : ""}`, retryable: response.status === 408 || response.status === 429 || response.status >= 500, ...(toolsRefused ? { code: "tools-unsupported" as const } : {}) };
      return;
    }
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    const think = new ThinkTagFilter();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "" || data === "[DONE]") continue;
          let json: { choices?: Array<{ delta?: { content?: string | null; tool_calls?: WireToolCall[] }; finish_reason?: string | null }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json.usage) usage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            const visible = think.push(delta.content);
            if (visible !== "") yield { type: "text", delta: visible };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const i = tc.index ?? 0;
            const have = calls.get(i) ?? { id: "", name: "", args: "" };
            if (tc.id) have.id = tc.id;
            if (tc.function?.name) have.name += tc.function.name;
            if (tc.function?.arguments) have.args += tc.function.arguments;
            calls.set(i, have);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (error) {
      if (request.signal.aborted) return;
      yield { type: "error", message: `The model stopped answering: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
      return;
    }
    if (request.signal.aborted) return;
    const tail = think.finish();
    if (tail !== "") yield { type: "text", delta: tail };
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (c.name !== "") yield { type: "tool", call: { id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, arguments: c.args === "" ? "{}" : c.args } };
    }
    if (usage) yield { type: "usage", ...usage };
    yield { type: "done", reason: calls.size > 0 ? "tool" : finish === "length" ? "length" : "stop" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Any server that speaks the Messages API (`/v1/messages` with `x-api-key` and `anthropic-version`): Anthropic itself,
// local servers that expose `/v1/messages` (such as Ollama 0.14+), and compatible gateways.

export interface AnthropicOptions {
  baseUrl?: string;
  model: string;
  apiKey?: string | null;
  label?: string;
  local?: boolean;
  headers?: Record<string, string>;
  /** For tests. */
  fetchImpl?: typeof fetch;
  temperature?: number;
  defaultMaxTokens?: number;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

function parseObjectArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* keep an empty object when the stored JSON was malformed */
  }
  return {};
}

function anthropicMessages(messages: ChatMessage[]): { system: string | null; messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> } {
  const systems: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim() !== "") systems.push(m.content);
    } else if (m.role === "user") {
      if (m.content !== "") push("user", [{ type: "text", text: m.content }]);
    } else if (m.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (m.content !== "") blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: parseObjectArgs(tc.arguments) });
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: formatToolContent(m) }]);
    }
  }
  if (out.length === 0 || out[0]?.role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });
  return { system: systems.length > 0 ? systems.join("\n\n") : null, messages: out };
}

export class AnthropicProvider implements BrainProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: BrainCapabilities;

  constructor(private readonly options: AnthropicOptions) {
    this.id = `anthropic:${options.model}`;
    this.label = options.label ?? options.model;
    this.capabilities = { tools: true, speculative: options.local === true, local: options.local === true };
  }

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const o = this.options;
    const doFetch = o.fetchImpl ?? fetch;
    const base = (o.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    const shaped = anthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: o.model,
      messages: shaped.messages,
      max_tokens: request.maxTokens ?? o.defaultMaxTokens ?? 1024,
      stream: true,
      temperature: request.temperature ?? o.temperature ?? 0.7,
    };
    if (shaped.system) {
      body["system"] =
        shaped.system.length >= 1024
          ? [{ type: "text", text: shaped.system, cache_control: { type: "ephemeral" } }]
          : shaped.system;
    }
    if (request.tools.length > 0) {
      body["tools"] = request.tools.map((t, idx) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        ...(request.tools.length >= 2 && idx === request.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
    }

    let response: Response;
    try {
      response = await doFetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "anthropic-version": "2023-06-01",
          ...(o.apiKey ? { "x-api-key": o.apiKey } : {}),
          ...(o.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) return;
      yield { type: "error", message: `The model could not be reached: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
      return;
    }

    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* the body is only for the message */
      }
      const toolsRefused = request.tools.length > 0 && TOOL_REFUSAL_STATUS.has(response.status) && TOOLS_NOT_TAKEN.test(detail);
      yield {
        type: "error",
        message: `The model answered ${response.status}${detail ? `: ${detail}` : ""}`,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        ...(toolsRefused ? { code: "tools-unsupported" as const } : {}),
      };
      return;
    }

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    const think = new ThinkTagFilter();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "" || data === "[DONE]") continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = evt["type"];
          if (type === "message_start") {
            const msg = evt["message"] as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
            if (msg?.usage) {
              inputTokens = msg.usage.input_tokens ?? inputTokens;
              outputTokens = msg.usage.output_tokens ?? outputTokens;
              sawUsage = true;
            }
          } else if (type === "content_block_start") {
            const index = typeof evt["index"] === "number" ? evt["index"] : 0;
            const block = evt["content_block"] as { type?: string; id?: string; name?: string; text?: string } | undefined;
            if (block?.type === "tool_use") {
              calls.set(index, { id: block.id ?? "", name: block.name ?? "", args: "" });
            } else if (block?.type === "text" && block.text) {
              const visible = think.push(block.text);
              if (visible !== "") yield { type: "text", delta: visible };
            }
          } else if (type === "content_block_delta") {
            const index = typeof evt["index"] === "number" ? evt["index"] : 0;
            const delta = evt["delta"] as { type?: string; text?: string; partial_json?: string } | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              const visible = think.push(delta.text);
              if (visible !== "") yield { type: "text", delta: visible };
            } else if (delta?.type === "input_json_delta" && delta.partial_json) {
              const have = calls.get(index);
              if (have) have.args += delta.partial_json;
            }
          } else if (type === "message_delta") {
            const delta = evt["delta"] as { stop_reason?: string | null } | undefined;
            if (delta?.stop_reason) stopReason = delta.stop_reason;
            const u = evt["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
            if (u) {
              if (typeof u.input_tokens === "number") inputTokens = u.input_tokens;
              if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
              sawUsage = true;
            }
          } else if (type === "error") {
            const err = evt["error"] as { type?: string; message?: string } | undefined;
            yield { type: "error", message: `The model stopped answering: ${err?.message ?? "stream error"}`, retryable: err?.type === "overloaded_error" || err?.type === "rate_limit_error" };
            return;
          }
        }
      }
    } catch (error) {
      if (request.signal.aborted) return;
      yield { type: "error", message: `The model stopped answering: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
      return;
    }

    if (request.signal.aborted) return;
    const tail = think.finish();
    if (tail !== "") yield { type: "text", delta: tail };
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (c.name !== "") yield { type: "tool", call: { id: c.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: c.name, arguments: c.args === "" ? "{}" : c.args } };
    }
    if (sawUsage) yield { type: "usage", inputTokens, outputTokens };
    yield { type: "done", reason: calls.size > 0 || stopReason === "tool_use" ? "tool" : stopReason === "max_tokens" ? "length" : "stop" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Any server that speaks the Google Generative Language REST API (`/v1beta/models/{model}:streamGenerateContent?alt=sse`
// with `x-goog-api-key`): Google AI Studio / Gemini API keys and compatible proxies.

export interface GoogleGenAiOptions {
  baseUrl?: string;
  model: string;
  apiKey?: string | null;
  label?: string;
  local?: boolean;
  headers?: Record<string, string>;
  /** For tests. */
  fetchImpl?: typeof fetch;
  temperature?: number;
  defaultMaxTokens?: number;
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

function geminiMessages(messages: ChatMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | null;
  contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }>;
} {
  const systems: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  const push = (role: "user" | "model", parts: GeminiPart[]): void => {
    if (parts.length === 0) return;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim() !== "") systems.push(m.content);
    } else if (m.role === "user") {
      if (m.content !== "") push("user", [{ text: m.content }]);
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content !== "") parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        parts.push({
          functionCall: { name: tc.name, args: parseObjectArgs(tc.arguments) },
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        });
      }
      push("model", parts);
    } else if (m.role === "tool") {
      push("user", [{ functionResponse: { name: m.name, response: { output: formatToolContent(m) } } }]);
    }
  }
  if (contents.length === 0 || contents[0]?.role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "Continue." }] });
  }
  return {
    systemInstruction: systems.length > 0 ? { parts: [{ text: systems.join("\n\n") }] } : null,
    contents,
  };
}

export class GoogleGenAiProvider implements BrainProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: BrainCapabilities;

  constructor(private readonly options: GoogleGenAiOptions) {
    this.id = `google:${options.model}`;
    this.label = options.label ?? options.model;
    this.capabilities = { tools: true, speculative: options.local === true, local: options.local === true };
  }

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const o = this.options;
    const doFetch = o.fetchImpl ?? fetch;
    const base = (o.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const bareModel = o.model.replace(/^models\//, "");
    const modelPath = o.model.startsWith("models/") ? o.model : `models/${o.model}`;
    const shaped = geminiMessages(request.messages);

    const body: Record<string, unknown> = {
      contents: shaped.contents,
      generationConfig: {
        temperature: request.temperature ?? o.temperature ?? 0.7,
        ...(request.maxTokens || o.defaultMaxTokens ? { maxOutputTokens: request.maxTokens ?? o.defaultMaxTokens } : {}),
        ...(/^gemini-2\.5-flash/i.test(bareModel) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    };
    if (shaped.systemInstruction) body["systemInstruction"] = shaped.systemInstruction;
    if (request.tools.length > 0) {
      body["tools"] = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    let response: Response;
    try {
      response = await doFetch(`${base}/${modelPath}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(o.apiKey ? { "x-goog-api-key": o.apiKey } : {}),
          ...(o.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) return;
      yield {
        type: "error",
        message: `The model could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
      return;
    }

    if (!response.ok || !response.body) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* the body is only for the message */
      }
      const toolsRefused = request.tools.length > 0 && TOOL_REFUSAL_STATUS.has(response.status) && TOOLS_NOT_TAKEN.test(detail);
      yield {
        type: "error",
        message: `The model answered ${response.status}${detail ? `: ${detail}` : ""}`,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        ...(toolsRefused ? { code: "tools-unsupported" as const } : {}),
      };
      return;
    }

    const calls: ToolCall[] = [];
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    const think = new ThinkTagFilter();
    const decoder = new TextDecoder();
    let buffer = "";
    let callIdx = 0;

    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "" || data === "[DONE]") continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const usageMeta = evt["usageMetadata"] as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
          if (usageMeta) {
            if (typeof usageMeta.promptTokenCount === "number") inputTokens = usageMeta.promptTokenCount;
            if (typeof usageMeta.candidatesTokenCount === "number") outputTokens = usageMeta.candidatesTokenCount;
            sawUsage = true;
          }
          const candidates = Array.isArray(evt["candidates"]) ? evt["candidates"] : [];
          const first = candidates[0] as {
            content?: {
              parts?: Array<{
                text?: string;
                thought?: boolean;
                thoughtSignature?: string;
                functionCall?: { name?: string; args?: unknown };
              }>;
            };
            finishReason?: string;
          } | undefined;
          if (!first) continue;
          if (first.finishReason) finishReason = first.finishReason;
          for (const part of first.content?.parts ?? []) {
            if (part.thought === true) continue;
            if (typeof part.text === "string" && part.text !== "") {
              const visible = think.push(part.text);
              if (visible !== "") yield { type: "text", delta: visible };
            } else if (part.functionCall?.name) {
              calls.push({
                id: `gcall_${++callIdx}_${Math.random().toString(36).slice(2, 8)}`,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
                ...(typeof part.thoughtSignature === "string" && part.thoughtSignature !== ""
                  ? { thoughtSignature: part.thoughtSignature }
                  : {}),
              });
            }
          }
        }
      }
    } catch (error) {
      if (request.signal.aborted) return;
      yield {
        type: "error",
        message: `The model stopped answering: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      };
      return;
    }

    if (request.signal.aborted) return;
    const tail = think.finish();
    if (tail !== "") yield { type: "text", delta: tail };
    for (const c of calls) {
      yield { type: "tool", call: c };
    }
    if (sawUsage) yield { type: "usage", inputTokens, outputTokens };
    yield {
      type: "done",
      reason: calls.length > 0 ? "tool" : finishReason === "MAX_TOKENS" ? "length" : "stop",
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tools for a model that has none: a convention in the text.

const MARKER_OPEN = "[[";
const MARKER_CLOSE = "]]";

/** The instructions that teach a model without tool calling to ask for tools in its text. */
export function textToolInstructions(tools: readonly ToolSpec[]): string {
  if (tools.length === 0) return "";
  const lines = tools.map((t) => `- ${t.name}: ${t.description} Arguments: ${JSON.stringify(t.parameters)}`);
  return [
    "You can use tools. To use one, write it on a line of its own, at the end of your reply, as [[tool_name {\"argument\": \"value\"}]] and nothing else on that line.",
    "Never say that you will use a tool without writing the line. Never write the line inside a sentence. The line is not spoken aloud.",
    "Tools:",
    ...lines,
  ].join("\n");
}

function findMarkerClose(buffer: string): number {
  let inString = false;
  let escaped = false;
  let braceDepth = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      continue;
    }
    if (braceDepth === 0 && ch === "]" && buffer[i + 1] === "]") {
      return i;
    }
  }
  return -1;
}

/**
 * Finds the tool lines in a stream of text and takes them out, so that they are never spoken. `push` returns the text to
 * keep; `finish` returns what is left and the calls found. A marker that never closes, or does not parse, is dropped.
 */
export class TextToolFilter {
  private buffer = "";
  private inside = false;
  private readonly calls: ToolCall[] = [];
  private counter = 0;

  constructor(private readonly knownTools?: ReadonlySet<string>) {}

  push(delta: string): string {
    this.buffer += delta;
    let out = "";
    for (;;) {
      if (!this.inside) {
        const at = this.buffer.indexOf(MARKER_OPEN);
        if (at < 0) {
          // Hold back a trailing "[" that might be the start of a marker.
          const keep = this.buffer.endsWith("[") ? 1 : 0;
          out += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return out;
        }
        out += this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + MARKER_OPEN.length);
        this.inside = true;
      }
      const end = findMarkerClose(this.buffer);
      if (end < 0) {
        // If `knownTools` is provided and the opening word after `[[` cannot possibly be a known tool, flush as plain text.
        if (this.knownTools && this.buffer.length >= 2) {
          const headMatch = /^\s*([A-Za-z_][\w.-]{0,63})\s/.exec(this.buffer);
          if (headMatch && !this.knownTools.has(headMatch[1] as string)) {
            out += MARKER_OPEN;
            this.inside = false;
            continue;
          }
          if (/^\s*[^A-Za-z_\s]/.test(this.buffer)) {
            out += MARKER_OPEN;
            this.inside = false;
            continue;
          }
        }
        if (this.buffer.length > 2400 && this.knownTools) {
          const headMatch = /^\s*([A-Za-z_][\w.-]{0,63})\b/.exec(this.buffer);
          if (!headMatch || !this.knownTools.has(headMatch[1] as string)) {
            out += MARKER_OPEN + this.buffer;
            this.buffer = "";
            this.inside = false;
          }
        }
        return out;
      }
      const candidate = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + MARKER_CLOSE.length);
      this.inside = false;
      if (!this.take(candidate)) {
        if (this.knownTools) {
          out += `${MARKER_OPEN}${candidate}${MARKER_CLOSE}`;
        }
      }
    }
  }

  drainCalls(): ToolCall[] {
    return this.calls.splice(0);
  }

  finish(): { text: string; calls: ToolCall[] } {
    let text = "";
    if (!this.inside) {
      text = this.buffer;
    } else {
      const lastClose = this.buffer.lastIndexOf(MARKER_CLOSE);
      if (lastClose >= 0 && this.take(this.buffer.slice(0, lastClose))) {
        text = this.buffer.slice(lastClose + MARKER_CLOSE.length);
      } else if (this.knownTools) {
        const headMatch = /^\s*([A-Za-z_][\w.-]{0,63})\b/.exec(this.buffer);
        if (!headMatch || !this.knownTools.has(headMatch[1] as string)) {
          text = MARKER_OPEN + this.buffer;
        }
      }
    }
    this.buffer = "";
    this.inside = false;
    return { text, calls: this.calls.splice(0) };
  }

  private take(body: string): boolean {
    const m = /^\s*([A-Za-z_][\w.-]{0,63})\s*([\s\S]*)$/.exec(body);
    if (!m) return false;
    const name = m[1] as string;
    if (this.knownTools && !this.knownTools.has(name)) return false;
    const args = (m[2] ?? "").trim();
    let json = args === "" ? "{}" : args;
    try {
      JSON.parse(json);
    } catch {
      // Models often write the arguments as a script object: bare keys, and line breaks inside a string. Mended once, then given up on.
      const keyed = json.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
      const mended = [keyed, keyed.replace(/\r?\n/g, "\\n")].find((candidate) => {
        try {
          JSON.parse(candidate);
          return true;
        } catch {
          return false;
        }
      });
      json = mended ?? "{}";
    }
    this.calls.push({ id: `text_${++this.counter}`, name, arguments: json });
    return true;
  }
}

/** Gives a provider that cannot call tools the ability to, through the convention above. */
export function withTextTools(inner: BrainProvider): BrainProvider {
  if (inner.capabilities.tools) return inner;
  return {
    id: inner.id,
    get label() {
      return inner.label;
    },
    capabilities: { ...inner.capabilities, tools: true },
    ...(inner.warm ? { warm: () => inner.warm!() } : {}),
    async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
      const knownTools = new Set(request.tools.map((t) => t.name));
      const filter = new TextToolFilter(knownTools);
      const hint = textToolInstructions(request.tools);
      const messages = request.messages.map((m, i) => (i === 0 && m.role === "system" && hint !== "" ? { ...m, content: `${m.content}\n\n${hint}` } : m));
      let reason: "stop" | "tool" | "length" = "stop";
      let emittedTool = false;
      for await (const event of inner.stream({ ...request, tools: [], messages })) {
        if (event.type === "text") {
          const text = filter.push(event.delta);
          if (text !== "") yield { type: "text", delta: text };
          for (const call of filter.drainCalls()) {
            emittedTool = true;
            yield { type: "tool", call };
          }
        } else if (event.type === "done") {
          reason = event.reason;
        } else {
          yield event;
        }
      }
      const rest = filter.finish();
      if (rest.text !== "") yield { type: "text", delta: rest.text };
      for (const call of rest.calls) {
        emittedTool = true;
        yield { type: "tool", call };
      }
      yield { type: "done", reason: emittedTool ? "tool" : reason };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Servers differ in whether they take tools: a model on this computer may not. A server that turns tools down is given
// them through text instead, once, and remembered for a while, so the call works rather than failing on its first tool.

export type ToolMode = "native" | "text";

export interface ToolModeProvider extends BrainProvider {
  /** How tools reach this model now: built in, or asked for in its text. */
  toolMode(): ToolMode;
  setToolMode(mode: ToolMode): void;
}

const TOOL_MODE_TTL_MS = 10 * 60_000;
const learnedToolModes = new Map<string, { mode: ToolMode; at: number }>();

/** For tests. */
export function forgetToolModes(): void {
  learnedToolModes.clear();
  streamOptionsUnsupported.clear();
}

/** `key` names the server and model, so what was learned about one is not applied to another. */
export function withToolFallback(inner: BrainProvider, options: { key: string; now?: () => number }): ToolModeProvider {
  const now = options.now ?? Date.now;
  const viaText = withTextTools({ id: inner.id, label: inner.label, capabilities: { ...inner.capabilities, tools: false }, stream: (request) => inner.stream(request) });
  const mode = (): ToolMode => {
    const learned = learnedToolModes.get(options.key);
    return learned && now() - learned.at < TOOL_MODE_TTL_MS ? learned.mode : "native";
  };
  const set = (next: ToolMode): void => {
    if (next === "text") learnedToolModes.set(options.key, { mode: next, at: now() });
    else learnedToolModes.delete(options.key);
  };
  return {
    id: inner.id,
    label: inner.label,
    capabilities: inner.capabilities,
    ...(inner.warm ? { warm: () => inner.warm!() } : {}),
    toolMode: mode,
    setToolMode: set,
    async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
      if (request.tools.length === 0) return yield* inner.stream(request);
      if (mode() === "text") return yield* viaText.stream(request);
      let first = true;
      for await (const event of inner.stream(request)) {
        if (first && event.type === "error" && event.code === "tools-unsupported") {
          set("text");
          return yield* viaText.stream(request);
        }
        first = false;
        yield event;
      }
    },
  };
}

export const PING_TOOL: ToolSpec = { name: "ping", description: "Call this tool to answer. It takes no arguments.", parameters: { type: "object", properties: {} } };

/**
 * Finds out how a model takes tools: built in, through text, or not at all. It asks the way that is known first and then
 * the other, and leaves the working way in place for the calls that follow (and the known way when neither works).
 */
export async function probeToolMode(brain: ToolModeProvider, signal: AbortSignal): Promise<ToolMode | "none"> {
  const called = async (): Promise<boolean> => {
    // A system message is there for the text convention to be written into.
    const messages: ChatMessage[] = [{ role: "system", content: "You are being tested." }, { role: "user", content: "Call the ping tool now." }];
    for await (const event of brain.stream({ messages, tools: [PING_TOOL], signal, maxTokens: 64, temperature: 0 })) {
      if (event.type === "tool" && event.call.name === PING_TOOL.name) return true;
      if (event.type === "error") return false;
    }
    return false;
  };
  const known = brain.toolMode();
  if (await called()) return brain.toolMode();
  const other: ToolMode = brain.toolMode() === "native" ? "text" : "native";
  brain.setToolMode(other);
  if (await called()) return other;
  brain.setToolMode(known);
  return "none";
}
