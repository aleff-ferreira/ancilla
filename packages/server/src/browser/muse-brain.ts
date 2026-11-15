import type { ExecResult } from "@ancilla/daemon";
import type { BrainCapabilities, BrainEvent, BrainProvider, BrainRequest, ChatMessage } from "../voice/brain.js";
import { classifyExecFailure, maxExecPromptChars, parseExecOutput } from "../research/execModelClient.js";

/**
 * Muse as the mind of the browsing agent: one `muse exec` process for each step, started with the `empty` preset, which leaves the
 * model with no tools at all (Muse itself says "Session tool ids: (none)"). It cannot read a file, run a command, fetch a page or
 * change anything; it can only answer in text, and its tool calls are asked for in that text, as for a call. This is what makes
 * it safe to let Muse read pages anyone can write: measured on a real Muse, a thread kept to an approval mode still read a file
 * outside its folder without being asked, and `empty` did not (it said no file tool exists). A step is stateless, so the whole
 * state of the task goes into each prompt, and the prompt is what the agent already keeps small.
 */

/** The argument list of one step. The prompt goes last so one that starts with a dash never reads as a flag. */
export function museBrowseArgs(prompt: string, modelId: string | null): string[] {
  return [
    "exec",
    "--json",
    "--no-session-log",
    "--preset",
    "empty",
    "--disable-web-tools",
    "--reasoning-effort",
    "low",
    "--max-model-steps",
    "1",
    ...(modelId ? ["--model", modelId] : []),
    prompt,
  ];
}

const PLAIN_TEXT_NOTE =
  "Function calling does not exist here: a tool call is only text. Write it as the last line of your reply in the form [[tool_name {\"argument\": \"value\"}]], with double-quoted JSON, and write nothing after it.";

const RETRY_NOTE =
  "Your last reply failed because it tried to call a tool the way a program would. There are no such calls: write the tool call as plain text, for example [[open {\"url\": \"https://example.com\"}]], as the last line of your reply.";

/** The conversation so far as one prompt: Muse starts each step knowing nothing else. */
export function flattenForExec(messages: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") parts.push(`${message.content}\n\n${PLAIN_TEXT_NOTE}`);
    else if (message.role === "user") parts.push(message.content);
    else if (message.role === "assistant") {
      const calls = (message.toolCalls ?? []).map((call) => `[[${call.name} ${call.arguments}]]`).join("\n");
      parts.push(`You wrote:\n${[message.content.trim(), calls].filter((s) => s !== "").join("\n")}`);
    } else parts.push(`[Result of ${message.name}]\n${message.content}`);
  }
  parts.push("Now write your next reply.");
  return parts.join("\n\n");
}

export interface MuseExecBrainOptions {
  /** Runs one `muse exec` with these arguments (the server routes it: the binary, WSL, the account). */
  run: (args: string[], limits: { timeoutMs: number; signal: AbortSignal }) => Promise<ExecResult>;
  /** The Muse model chosen for the assistant, or null for Muse's own default. */
  model: string | null;
  /** How long one step may take. */
  stepMs?: number;
  platform?: string;
  log?: (line: string) => void;
}

const STEP_MS = 120_000;

/**
 * What a step cost, read off the `run.usage` event `muse exec` prints (its models, each with the tokens in and out). Measured on a real
 * Muse: a one-word prompt already costs about 15,000 tokens in, which is Muse's own instructions, so a step is never cheap.
 */
export function execUsage(stdout: string): { inputTokens: number; outputTokens: number } | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{") || !text.includes('"run.usage"')) continue;
    try {
      const event = JSON.parse(text) as { payload_type?: string; payload?: { models?: Array<{ input_tokens?: unknown; output_tokens?: unknown }> } };
      if (event.payload_type !== "run.usage") continue;
      for (const model of event.payload?.models ?? []) {
        inputTokens += Number(model.input_tokens) || 0;
        outputTokens += Number(model.output_tokens) || 0;
        found = true;
      }
    } catch {
      // a line that is not JSON is not an event
    }
  }
  return found ? { inputTokens, outputTokens } : null;
}

/** Why a step failed, in words: Muse prints what it is doing first and what went wrong last, so the last line is the one that says. */
function failureText(result: ExecResult, kind: string | undefined, fallback: string): string {
  const last = (result.stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "").pop();
  return kind === "unavailable" && last ? `Muse failed: ${last.slice(0, 200)}` : fallback;
}

export class MuseExecBrain implements BrainProvider {
  readonly id = "muse-exec";
  readonly label: string;
  readonly capabilities: BrainCapabilities = { tools: false, speculative: false, local: false };

  constructor(private readonly options: MuseExecBrainOptions) {
    this.label = options.model ? `Muse (${options.model})` : "Muse";
  }

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const prompt = flattenForExec(request.messages);
    const limit = maxExecPromptChars(this.options.platform);
    if (prompt.length > limit) {
      yield { type: "error", message: `The task grew too long for Muse to take in one step (${prompt.length} characters, the limit is ${limit}).`, retryable: false };
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (request.signal.aborted) return;
      const result = await this.options.run(museBrowseArgs(attempt === 0 ? prompt : `${prompt}\n\n${RETRY_NOTE}`, this.options.model), { timeoutMs: this.options.stepMs ?? STEP_MS, signal: request.signal });
      if (request.signal.aborted) return;
      if (result.exitCode !== 0 || result.aborted || result.timedOut) {
        const failure = classifyExecFailure(result);
        const kind = (failure as { kind?: string }).kind;
        // A process that failed without saying it was refused (not signed in, rate limited, out of quota) is tried once more: Muse does
        // fail now and then for no reason a person could act on.
        if (attempt === 0 && !result.aborted && !result.timedOut && kind === "unavailable") {
          this.options.log?.(`browse: muse exec failed (${failureText(result, kind, failure.message)}); trying once more`);
          continue;
        }
        yield { type: "error", message: failureText(result, kind, failure.message), retryable: true };
        return;
      }
      const parsed = parseExecOutput(result.stdout);
      // A reply that failed because the model reached for a native tool call is asked for again, once, in plain words.
      if (parsed.terminal || !parsed.text) {
        if (attempt === 0) {
          this.options.log?.(`browse: Muse's step ended ${parsed.terminal ?? "without text"}; asking again once`);
          continue;
        }
        yield { type: "error", message: parsed.terminal ? `Muse could not answer that step (it ended "${parsed.terminal}").` : "Muse gave no answer for that step.", retryable: true };
        return;
      }
      yield { type: "text", delta: parsed.text };
      const usage = parsed.usage ?? execUsage(result.stdout);
      if (usage) yield { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
      yield { type: "done", reason: "stop" };
      return;
    }
  }
}
