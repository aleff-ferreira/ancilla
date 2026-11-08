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
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type BrainEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; reason: "stop" | "tool" | "length" }
  | { type: "error"; message: string; retryable: boolean };

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

interface WireToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

function wireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "assistant":
        return m.toolCalls && m.toolCalls.length > 0
          ? { role: "assistant", content: m.content === "" ? null : m.content, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
          : { role: "assistant", content: m.content };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
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
    const body: Record<string, unknown> = {
      model: o.model,
      messages: wireMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? o.temperature ?? 0.7,
    };
    if (request.maxTokens) body["max_tokens"] = request.maxTokens;
    if (request.tools.length > 0) body["tools"] = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    let response: Response;
    try {
      response = await doFetch(`${o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}), ...(o.headers ?? {}) },
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
      yield { type: "error", message: `The model answered ${response.status}${detail ? `: ${detail}` : ""}`, retryable: response.status === 408 || response.status === 429 || response.status >= 500 };
      return;
    }
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: { inputTokens: number; outputTokens: number } | null = null;
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
          if (delta?.content) yield { type: "text", delta: delta.content };
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
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (c.name !== "") yield { type: "tool", call: { id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, arguments: c.args === "" ? "{}" : c.args } };
    }
    if (usage) yield { type: "usage", ...usage };
    yield { type: "done", reason: calls.size > 0 ? "tool" : finish === "length" ? "length" : "stop" };
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

/**
 * Finds the tool lines in a stream of text and takes them out, so that they are never spoken. `push` returns the text to
 * keep; `finish` returns what is left and the calls found. A marker that never closes, or does not parse, is dropped.
 */
export class TextToolFilter {
  private buffer = "";
  private inside = false;
  private readonly calls: ToolCall[] = [];
  private counter = 0;

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
      const end = this.buffer.indexOf(MARKER_CLOSE);
      if (end < 0) return out;
      this.take(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + MARKER_CLOSE.length);
      this.inside = false;
    }
  }

  finish(): { text: string; calls: ToolCall[] } {
    const text = this.inside ? "" : this.buffer;
    this.buffer = "";
    this.inside = false;
    return { text, calls: this.calls.splice(0) };
  }

  private take(body: string): void {
    const m = /^\s*([A-Za-z_][\w.-]{0,63})\s*([\s\S]*)$/.exec(body);
    if (!m) return;
    const args = (m[2] ?? "").trim();
    let json = args === "" ? "{}" : args;
    try {
      JSON.parse(json);
    } catch {
      json = "{}";
    }
    this.calls.push({ id: `text_${++this.counter}`, name: m[1] as string, arguments: json });
  }
}

/** Gives a provider that cannot call tools the ability to, through the convention above. */
export function withTextTools(inner: BrainProvider): BrainProvider {
  if (inner.capabilities.tools) return inner;
  return {
    id: inner.id,
    label: inner.label,
    capabilities: { ...inner.capabilities, tools: true },
    async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
      const filter = new TextToolFilter();
      const hint = textToolInstructions(request.tools);
      const messages = request.messages.map((m, i) => (i === 0 && m.role === "system" && hint !== "" ? { ...m, content: `${m.content}\n\n${hint}` } : m));
      let reason: "stop" | "tool" | "length" = "stop";
      for await (const event of inner.stream({ ...request, tools: [], messages })) {
        if (event.type === "text") {
          const text = filter.push(event.delta);
          if (text !== "") yield { type: "text", delta: text };
        } else if (event.type === "done") {
          reason = event.reason;
        } else {
          yield event;
        }
      }
      const rest = filter.finish();
      if (rest.text !== "") yield { type: "text", delta: rest.text };
      for (const call of rest.calls) yield { type: "tool", call };
      yield { type: "done", reason: rest.calls.length > 0 ? "tool" : reason };
    },
  };
}
