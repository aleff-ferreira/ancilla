import {
  ResearchFailure,
  type ExecFn,
  type ExecResult,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelRole,
  type ResearchModelIds,
  type TokenUsage,
} from "@ancilla/daemon";

/**
 * The `muse exec` argument list for one tool-less completion, the same one thread titles use: JSON events on
 * stdout, no session log, no web tools, one model step. The prompt goes last so a prompt that starts with a dash
 * never reads as a flag.
 */
export function museExecArgs(prompt: string, modelId: string | null): string[] {
  return [
    "exec",
    "--json",
    "--no-session-log",
    "--disable-web-tools",
    "--reasoning-effort",
    "minimal",
    "--max-model-steps",
    "1",
    ...(modelId ? ["--model", modelId] : []),
    prompt,
  ];
}

/**
 * The prompt is a command-line argument (the title path's precedent), and command lines have a ceiling: Windows
 * stops at about 32 K characters for the whole line, and Linux and macOS at a few hundred KiB per argument. The
 * research writer prompt with curated excerpts can exceed the Windows figure. Whether `muse exec` can take the
 * prompt on stdin or from a file instead is the plan's open question 1 and is not verified, so until it is the
 * client refuses a prompt over the ceiling with an `invalid_output` failure rather than sending something that a
 * shell would truncate or reject.
 */
export const MAX_EXEC_PROMPT_CHARS_WIN32 = 28_000;
export const MAX_EXEC_PROMPT_CHARS_POSIX = 100_000;

export function maxExecPromptChars(platform: string = process.platform): number {
  return platform === "win32" ? MAX_EXEC_PROMPT_CHARS_WIN32 : MAX_EXEC_PROMPT_CHARS_POSIX;
}

/** A planned `muse exec` process: the binary (or `wsl` on Windows), its argument list and the environment. */
export interface MuseExecPlan {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface MuseExecModelClientOptions {
  exec: ExecFn;
  /** Turns the `muse exec` argument list into the process to run: the binary, WSL routing and the account's env. */
  plan: (args: string[]) => Promise<MuseExecPlan> | MuseExecPlan;
  /** Per-role model ids from the run's config; a null falls back to `fallbackModelId`, then to Muse's default. */
  models: ResearchModelIds;
  /** The thread's model. */
  fallbackModelId: string | null;
  platform?: string;
  log?: (message: string) => void;
}

/** Which configured model serves each role: the supervisor's for everything but the writer's. */
export function modelIdForRole(role: ModelRole, models: ResearchModelIds, fallback: string | null): string | null {
  const configured = role === "writer" ? models.writer : models.supervisor;
  return configured ?? fallback;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A usage block as `muse exec` might print it: Muse's raw counters or the counted-once prompt/total pair. */
function usageOf(value: unknown): TokenUsage | null {
  const record = recordOf(value);
  if (!record) {
    return null;
  }
  const inner = recordOf(record["usage"]) ?? record;
  const inputTokens = numberOf(inner["inputTokens"]) ?? numberOf(record["promptTokens"]) ?? numberOf(inner["input_tokens"]) ?? numberOf(inner["prompt_tokens"]);
  const outputTokens = numberOf(inner["outputTokens"]) ?? numberOf(inner["output_tokens"]) ?? numberOf(inner["completion_tokens"]);
  if (inputTokens === null && outputTokens === null) {
    return null;
  }
  const cached = numberOf(inner["cachedTokens"]) ?? numberOf(inner["cacheReadTokens"]) ?? numberOf(inner["cached_tokens"]) ?? 0;
  const total = numberOf(record["totalTokens"]) ?? numberOf(inner["totalTokens"]) ?? numberOf(inner["total_tokens"]) ?? (inputTokens ?? 0) + (outputTokens ?? 0);
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, cachedInputTokens: cached, totalTokens: total };
}

export interface ParsedExecOutput {
  text: string | null;
  usage: TokenUsage | null;
  modelId: string | null;
  /** The terminal record's outcome when it was not `completed`, e.g. `failed`; null when it completed or was absent. */
  terminal: string | null;
}

/**
 * The answer of `muse exec --json`, read the way the title parser reads it: the last `run.terminal.completed`
 * text wins, concatenated `run.output.delta` chunks stand in when the terminal record is missing, and anything
 * that is not JSON is skipped. Usage and the model id are taken from whichever event carries them; the title path
 * never needed either, so their exact shape is read leniently and null stands for "not reported".
 */
export function parseExecOutput(stdout: string): ParsedExecOutput {
  let terminalText: string | null = null;
  let terminal: string | null = null;
  let deltas = "";
  let usage: TokenUsage | null = null;
  let modelId: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = recordOf(event);
    const payload = record ? recordOf(record["payload"]) : null;
    if (!record || !payload) {
      continue;
    }
    const found = usageOf(payload["usage"] !== undefined || payload["promptTokens"] !== undefined ? payload : record["usage"]);
    if (found) {
      usage = usage ? { ...found, inputTokens: usage.inputTokens + found.inputTokens, outputTokens: usage.outputTokens + found.outputTokens, cachedInputTokens: usage.cachedInputTokens + found.cachedInputTokens, totalTokens: usage.totalTokens + found.totalTokens } : found;
    }
    const model = payload["modelId"] ?? payload["model"] ?? record["modelId"];
    if (typeof model === "string" && model) {
      modelId = model;
    }
    const text = typeof payload["text"] === "string" ? payload["text"] : "";
    const payloadType = record["payload_type"];
    if (payloadType === "run.terminal.completed" || payload["kind"] === "run_terminal") {
      const outcome = payload["terminal"];
      if (outcome !== undefined && outcome !== "completed") {
        terminal = typeof outcome === "string" ? outcome : String(outcome);
        continue;
      }
      if (text) {
        terminalText = text;
      }
    } else if (payloadType === "run.output.delta" || payload["kind"] === "run_output_delta") {
      deltas += text;
    }
  }
  return { text: terminalText ?? (deltas || null), usage, modelId, terminal };
}

/** The failure kind a failed `muse exec` maps to, read off its exit and whatever it printed. */
export function classifyExecFailure(result: ExecResult): ResearchFailure {
  if (result.aborted) {
    return new ResearchFailure("cancelled", "muse exec was cancelled.");
  }
  if (result.timedOut) {
    return new ResearchFailure("timeout", "muse exec did not answer in time.");
  }
  const text = `${result.stderr ?? ""}\n${result.stdout}`;
  const excerpt = (result.stderr ?? "").trim().split("\n").find((line) => line.trim().length > 0)?.trim() ?? `exit code ${result.exitCode}`;
  if (/\b(401|403)\b|unauthori[sz]ed|not logged in|login required|forbidden/i.test(text)) {
    return new ResearchFailure("auth", `muse exec refused: ${excerpt}`);
  }
  if (/\b402\b|quota|insufficient/i.test(text)) {
    return new ResearchFailure("quota", `muse exec refused: ${excerpt}`);
  }
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(text)) {
    return new ResearchFailure("rate_limited", `muse exec was rate limited: ${excerpt}`);
  }
  return new ResearchFailure("unavailable", `muse exec failed (${excerpt}).`);
}

/**
 * Tool-less completions through `muse exec`, one process per call, the way thread titles are made. The prompt is
 * a command-line argument (see `MAX_EXEC_PROMPT_CHARS_*`), the answer is read off the JSON event stream, and the
 * child is killed when the request's signal fires or its timeout passes.
 */
export class MuseExecModelClient implements ModelClient {
  constructor(private readonly options: MuseExecModelClientOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const limit = maxExecPromptChars(this.options.platform);
    if (request.prompt.length > limit) {
      const message = `prompt too long for muse exec: ${request.prompt.length} chars (limit ${limit}).`;
      this.options.log?.(`research: ${request.role} ${message}`);
      throw new ResearchFailure("invalid_output", message);
    }
    if (request.signal.aborted) {
      throw new ResearchFailure("cancelled", "The run was stopped before the model call started.");
    }
    const modelId = modelIdForRole(request.role, this.options.models, this.options.fallbackModelId);
    const plan = await this.options.plan(museExecArgs(request.prompt, modelId));
    const result = await this.options.exec(plan.command, plan.args, {
      ...(plan.env ? { env: plan.env } : {}),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    if (result.exitCode !== 0 || result.aborted || result.timedOut) {
      throw classifyExecFailure(result);
    }
    const parsed = parseExecOutput(result.stdout);
    if (parsed.terminal) {
      throw new ResearchFailure("unavailable", `muse exec ended with terminal "${parsed.terminal}".`);
    }
    if (!parsed.text) {
      throw new ResearchFailure("invalid_output", "muse exec printed no answer.");
    }
    return { text: parsed.text, usage: parsed.usage, modelId: parsed.modelId ?? modelId };
  }
}
