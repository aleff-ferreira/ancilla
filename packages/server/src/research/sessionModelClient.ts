import { ResearchFailure, type ModelClient, type ModelRequest, type ModelResponse, type ResearchModelIds } from "@ancilla/daemon";
import { maxExecPromptChars, modelIdForRole } from "./execModelClient.js";
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

/** What the client needs from the server: the run's control session on the thread's host, and its notifications. */
export interface ControlSessionHost {
  /** Starts the control session for one model, recorded archived under `research-worker` so it never reaches the sidebar. */
  startControlSession(modelId: string | null): Promise<TurnSession>;
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
}

/**
 * Tool-less completions as turns in a dedicated research control session: the transport for prompts a command
 * line cannot carry (see `MAX_EXEC_PROMPT_CHARS_*`). The session is started lazily on the first call and reused
 * across calls, which run one at a time; each call is one `turn/start` whose final agent message is the answer
 * and whose `session/tokenUsage` is the usage. The supervisor and the writer may be configured with different
 * models, so there is one session per model id in use, which is one session for the usual config. Approvals are
 * denied and user-input prompts declined, since the answer is meant to come without tools; a session Muse closes
 * is replaced on the next call.
 */
export class MuseSessionModelClient implements ModelClient {
  private readonly sessions = new Map<string, Promise<TurnSession>>();
  /** Calls run one after another: a control session holds one turn at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: MuseSessionModelClientOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal.aborted) {
      throw new ResearchFailure("cancelled", "The run was stopped before the model call started.");
    }
    const modelId = modelIdForRole(request.role, this.options.models, this.options.fallbackModelId);
    const call = this.queue.then(() => this.turn(request, modelId));
    this.queue = call.catch(() => undefined);
    return call;
  }

  private sessionFor(modelId: string | null): Promise<TurnSession> {
    const key = modelId ?? "";
    const known = this.sessions.get(key);
    if (known) {
      return known;
    }
    const started = this.options.host.startControlSession(modelId).catch((error: unknown) => {
      // A failed start is not kept: the next call tries again.
      this.sessions.delete(key);
      throw error;
    });
    this.sessions.set(key, started);
    return started;
  }

  private async turn(request: ModelRequest, modelId: string | null): Promise<ModelResponse> {
    if (request.signal.aborted) {
      throw new ResearchFailure("cancelled", "The run was stopped before the model call started.");
    }
    const key = modelId ?? "";
    let session: TurnSession;
    try {
      session = await this.sessionFor(modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = failureKindOf(message);
      throw new ResearchFailure(kind === "other" ? "unavailable" : kind, `could not start the research control session: ${message}`);
    }
    const { sessionId, manager } = session;
    const log = (message: string): void => this.options.host.log?.(message);
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
          case "session/closed": {
            this.sessions.delete(key);
            return;
          }
          default:
            return;
        }
      },
    });
    if (outcome.startFailed) {
      // A session that no longer takes a turn (closed between calls, say) is dropped; the next call starts a new one.
      this.sessions.delete(key);
    }
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
  /** The control-session path: one turn per call in a reused session. */
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
