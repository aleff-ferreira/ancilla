import { ResearchFailure, type ModelClient, type ModelRequest, type ModelResponse, type ResearchModelIds } from "@ancilla/daemon";
import { maxExecPromptChars, modelIdForRole } from "./execModelClient.js";
import { DEFAULT_RESEARCH_STARTUP_MS, describeMs, raceStartup } from "./startup.js";
import { failureKindOf, kindOfTurnError, planApproval, runTurn, type SessionNotificationHandler, type TurnClock, type TurnSession } from "./turn.js";

/**
 * Appended to every prompt sent through a control session. A serve session has Muse's tools, and the completions
 * the engine asks for are tool-less by design: the answer must come in the message itself.
 */
export const CONTROL_TURN_INSTRUCTION =
  "Answer directly in this message with the requested output and nothing else. Do not use any tools: do not search " +
  "the web, do not read or write files, do not run commands, and do not ask questions. Everything you need is above.";

/** What a denied control-session approval tells the model. */
export const CONTROL_DENY_FEEDBACK = "Answer directly from the material in the prompt; tools are not available for this call.";

/** Why a control session declines a user-input prompt. */
export const CONTROL_INPUT_DECLINED = "This call runs unattended; answer from the prompt alone.";

/** What the client needs from the server: a control session on the thread's host, and its notifications. */
export interface ControlSessionHost {
  /**
   * Starts a control session for one model, recorded archived under `research-worker` so it never reaches the
   * sidebar. `giveUp` is aborted when the caller stopped waiting for the start (a stop, or the startup allowance),
   * so the host side knows the session it is still opening has no one behind it.
   */
  startControlSession(modelId: string | null, giveUp?: AbortSignal): Promise<TurnSession>;
  /** Delivers that session's host notifications until the returned function is called. */
  subscribe(sessionId: string, handler: SessionNotificationHandler): () => void;
  log?(message: string): void;
}

export interface MuseSessionModelClientOptions {
  host: ControlSessionHost;
  /** Per-role model ids from the run's config; a null falls back to `fallbackModelId`, then to Muse's default. */
  models: ResearchModelIds;
  /** The thread's model. */
  fallbackModelId: string | null;
  clock?: TurnClock;
  cancelGraceMs?: number;
  /** How long a session start may take, in milliseconds or as a function read at each call; two minutes unless given. */
  startupMs?: number | (() => number);
}

/** Rejects with `cancelled` when `signal` fires while `started()` is still false; settles with `call` otherwise. */
function abandonWhileQueued<T>(call: Promise<T>, signal: AbortSignal, started: () => boolean): Promise<T> {
  if (signal.aborted) {
    return call;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      if (!started()) {
        reject(new ResearchFailure("cancelled", "The run was stopped while the model call waited for its turn."));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Tool-less completions as turns in a research control session: the transport for prompts a command line cannot
 * carry (see `MAX_EXEC_PROMPT_CHARS_*`). Every call opens a session of its own and runs one `turn/start` in it,
 * whose final agent message is the answer and whose `session/tokenUsage` is the usage. A session is never reused:
 * a reused one can still deliver the late output or terminal of an earlier call, which an unbound turn would take
 * for its own, so the answer to one request could become another's (and the supervisor and the writer would share
 * one history). Calls run one after another, in the order they were made. Approvals are denied and user-input
 * prompts declined, since the answer is meant to come without tools; a session Muse closes ends its call, and the
 * next call opens another. Starting a session is bounded by `startupMs` and by the run's stop, like every other
 * wait the engine has, so a Muse that never opens a session cannot hold a run (or Stop) hostage.
 */
export class MuseSessionModelClient implements ModelClient {
  /** Calls run one after another: a call that is waiting its turn is the one a stop reaches first. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MuseSessionModelClientOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal.aborted) {
      throw new ResearchFailure("cancelled", "The run was stopped before the model call started.");
    }
    const modelId = modelIdForRole(request.role, this.options.models, this.options.fallbackModelId);
    let started = false;
    const call = this.queue.then(() => {
      started = true;
      return this.turn(request, modelId);
    });
    this.queue = call.catch(() => undefined);
    return abandonWhileQueued(call, request.signal, () => started);
  }

  private startupMs(): number {
    const configured = this.options.startupMs;
    const value = typeof configured === "function" ? configured() : configured;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_RESEARCH_STARTUP_MS;
  }

  private async turn(request: ModelRequest, modelId: string | null): Promise<ModelResponse> {
    if (request.signal.aborted) {
      throw new ResearchFailure("cancelled", "The run was stopped before the model call started.");
    }
    const log = (message: string): void => this.options.host.log?.(message);
    const allowance = this.startupMs();
    const opened = await raceStartup((giveUp) => this.options.host.startControlSession(modelId, giveUp), {
      signal: request.signal,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      timeoutMs: allowance,
      onLate: (late) => log(`research: control (${request.role}) session ${late.sessionId} opened after the call gave up on it; it stays idle.`),
    });
    if (opened.kind === "aborted") {
      throw new ResearchFailure("cancelled", "The run was stopped while the control session was starting.");
    }
    if (opened.kind === "timed_out") {
      log(`research: control (${request.role}) session did not open within ${describeMs(allowance)}; giving up on it.`);
      throw new ResearchFailure("unavailable", `could not start the research control session: Muse did not open it within ${describeMs(allowance)}.`);
    }
    if (opened.kind === "failed") {
      const message = opened.error instanceof Error ? opened.error.message : String(opened.error);
      const kind = failureKindOf(message);
      throw new ResearchFailure(kind === "other" ? "unavailable" : kind, `could not start the research control session: ${message}`);
    }
    const session: TurnSession = opened.value;
    const { sessionId, manager } = session;
    const outcome = await runTurn(session, `${request.prompt}\n\n${CONTROL_TURN_INSTRUCTION}`, {
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      subscribe: (id, handler) => this.options.host.subscribe(id, handler),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.cancelGraceMs !== undefined ? { cancelGraceMs: this.options.cancelGraceMs } : {}),
      label: `control (${request.role})`,
      kind: "control",
      log,
      onNotification: (method, params, control) => {
        switch (method) {
          case "approval/requested": {
            const plan = planApproval(params, false, CONTROL_DENY_FEEDBACK);
            if (!plan) {
              log(`research: control (${request.role}) approval offers no deny choice; interrupting.`);
              control.stop("failed", "invalid_output: the model asked for a tool approval that offers no deny choice.");
              return;
            }
            log(`research: control (${request.role}) approval ${plan.approvalId} ${plan.decision} (${plan.choiceId}).`);
            control.defer(() =>
              manager.decideApproval({ sessionId, approvalId: plan.approvalId, requirementId: plan.requirementId, choiceId: plan.choiceId, feedback: plan.feedback }).then(
                () => undefined,
                (error: unknown) => log(`research: control (${request.role}) approval decision failed: ${error instanceof Error ? error.message : String(error)}`),
              ),
            );
            return;
          }
          case "userInput/requested": {
            const userInputId = typeof params["userInputId"] === "string" ? params["userInputId"] : null;
            if (!userInputId) {
              return;
            }
            log(`research: control (${request.role}) asked for user input (${userInputId}); declining and interrupting.`);
            control.defer(() =>
              manager.cancelUserInput(sessionId, userInputId, CONTROL_INPUT_DECLINED).then(
                () => undefined,
                (error: unknown) => log(`research: control (${request.role}) declining user input failed: ${error instanceof Error ? error.message : String(error)}`),
              ),
            );
            // A question instead of an answer is an invalid answer; a second identical call would ask again.
            control.stop("failed", "invalid_output: the model asked for user input instead of answering.");
            return;
          }
          default:
            return;
        }
      },
    });
    if (outcome.status === "completed") {
      if (!outcome.text.trim()) {
        throw new ResearchFailure("invalid_output", "the research control session gave no answer.");
      }
      return { text: outcome.text, usage: outcome.usage, modelId };
    }
    throw new ResearchFailure(kindOfTurnError(outcome.error, outcome.status), outcome.error ?? `${outcome.status}: the control turn did not complete.`);
  }
}

export interface MuseModelClientOptions {
  /** The `muse exec` path: one process per call, the prompt as an argument. */
  exec: ModelClient;
  /** The control-session path: one turn per call in a session of its own. */
  session: ModelClient;
  platform?: string;
  log?(message: string): void;
}

/**
 * The model client the server hands the engine: `muse exec` while the prompt fits the platform's command line
 * (`maxExecPromptChars`), a control-session turn when it does not. The choice is logged per call, so a run's log
 * says which transport answered each role.
 */
export class MuseModelClient implements ModelClient {
  constructor(private readonly options: MuseModelClientOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const limit = maxExecPromptChars(this.options.platform);
    const transport = request.prompt.length <= limit ? "exec" : "session";
    this.options.log?.(`research: ${request.role} prompt is ${request.prompt.length} chars (exec limit ${limit}); using the ${transport} transport.`);
    return transport === "exec" ? this.options.exec.complete(request) : this.options.session.complete(request);
  }
}
