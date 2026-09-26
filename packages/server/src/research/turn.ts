import { addUsage, type ResearchFailureKind, type SessionManager, type TokenUsage, type WorkerStatus } from "@ancilla/daemon";

/** A Muse session a turn runs in: its id and the manager of the host it lives on. */
export interface TurnSession {
  sessionId: string;
  manager: SessionManager;
}

export type SessionNotificationHandler = (method: string, params: Record<string, unknown>) => void;

/**
 * The clock turns measure time with; tests inject a fake one. The real one unrefs its timers, so a turn whose
 * host never answers can never keep the server process alive on its own.
 */
export interface TurnClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_CLOCK: TurnClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long a turn gets between `turn/interrupt` and `turn/cancel`. */
export const TURN_CANCEL_GRACE_MS = 30_000;

/** How long past the wall time and the grace period a turn may take before the runner gives up on the host. */
export const TURN_HARD_DEADLINE_SLACK_MS = 5_000;

/** The abort reason a shutdown carries: the turn is cancelled at once rather than interrupted and waited for. */
export function isShutdownReason(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as Record<string, unknown>)["type"] === "shutdown";
}

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The failure kind a message points at, for the `kind: ` prefix of a failed turn's error. */
export function failureKindOf(message: string): ResearchFailureKind {
  if (/\b(401|403)\b|unauthori[sz]ed|not logged in|forbidden/i.test(message)) {
    return "auth";
  }
  if (/\b402\b|quota|insufficient/i.test(message)) {
    return "quota";
  }
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(message)) {
    return "rate_limited";
  }
  if (/timed? ?out/i.test(message)) {
    return "timeout";
  }
  if (/cancel/i.test(message)) {
    return "cancelled";
  }
  if (/unavailable|could not start|connection|ECONN|refused/i.test(message)) {
    return "unavailable";
  }
  return "other";
}

const KIND_PREFIX = /^(timeout|cancelled|auth|quota|rate_limited|unavailable|invalid_output|other):/;

/** The kind a turn error names in its prefix, else the kind its text points at. */
export function kindOfTurnError(error: string | null, status: WorkerStatus): ResearchFailureKind {
  const match = error ? KIND_PREFIX.exec(error) : null;
  if (match) {
    return match[1] as ResearchFailureKind;
  }
  if (status === "timed_out") {
    return "timeout";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  const kind = failureKindOf(error ?? "");
  return kind === "other" ? "unavailable" : kind;
}

export interface ApprovalSubjectInfo {
  approvalId: string | null;
  kind: string;
  toolName: string | null;
}

/** What an `approval/requested` is about: its id, the subject kind, and the tool name when one is given. */
export function approvalSubjectOf(params: Record<string, unknown>): ApprovalSubjectInfo {
  const subject = recordOf(params["subject"]);
  const kind = subject && typeof subject["kind"] === "string" ? subject["kind"] : "unknown";
  const toolName = (subject && typeof subject["toolName"] === "string" ? subject["toolName"] : null) ?? (typeof params["toolName"] === "string" ? params["toolName"] : null);
  return { approvalId: typeof params["approvalId"] === "string" ? params["approvalId"] : null, kind, toolName };
}

export interface ApprovalPlan {
  approvalId: string;
  requirementId: unknown;
  choiceId: string;
  /** The choice's decision word, for the log line. */
  decision: string;
  feedback: string | null;
}

/**
 * The `approval/decide` a fixed policy sends for one request. Muse's choices carry a decision from the
 * `ApprovalDecision` vocabulary (`approved`, `approvedForSession`, `approvedPolicyAmendment`, `denied`,
 * `deniedPolicyAmendment`, ...), so the plan takes an `approved*` or `denied*` choice, a `once` scope before a
 * `session` one before anything else, and sends `feedback` only where the choice accepts it. Null when the request
 * offers no matching choice: a made-up `choiceId` is rejected (-32052), so the caller ends the turn instead.
 */
export function planApproval(params: Record<string, unknown>, allow: boolean, feedback: string): ApprovalPlan | null {
  const approvalId = typeof params["approvalId"] === "string" ? params["approvalId"] : null;
  if (!approvalId) {
    return null;
  }
  const wanted = allow ? /^approved/ : /^denied/;
  const choices = Array.isArray(params["availableChoices"]) ? (params["availableChoices"] as unknown[]).map(recordOf) : [];
  const matching = choices.filter(
    (choice): choice is Record<string, unknown> =>
      choice !== null && typeof choice["choiceId"] === "string" && typeof choice["decision"] === "string" && wanted.test(choice["decision"]),
  );
  const choice = matching.find((c) => c["scope"] === "once") ?? matching.find((c) => c["scope"] === "session") ?? matching[0];
  if (!choice) {
    return null;
  }
  return {
    approvalId,
    requirementId: params["currentRequirementId"] ?? params["requirementId"] ?? null,
    choiceId: choice["choiceId"] as string,
    decision: choice["decision"] as string,
    feedback: choice["acceptsFeedback"] === true ? feedback : null,
  };
}

/** What a notification handler may do to the turn it is watching. */
export interface TurnControl {
  readonly turnId: string | null;
  readonly settled: boolean;
  /** Interrupts the turn, then cancels it after the grace period; `status` is the outcome unless one is recorded already. */
  stop(status: WorkerStatus, message: string): void;
  /** Queues follow-up work (an output read, a decision) that the turn's result waits for. */
  defer(work: () => Promise<void>): void;
}

export interface RunTurnOptions {
  /** Wall time: the turn is interrupted when it passes, and cancelled after the grace period. */
  timeoutMs: number;
  signal: AbortSignal;
  subscribe(sessionId: string, handler: SessionNotificationHandler): () => void;
  /** Sees every notification of the turn before the turn's own bookkeeping; may stop the turn or defer work. */
  onNotification?(method: string, params: Record<string, unknown>, control: TurnControl): void;
  clock?: TurnClock;
  cancelGraceMs?: number;
  /** When the turn resolves whatever the host did: `timeoutMs + cancelGraceMs + TURN_HARD_DEADLINE_SLACK_MS` unless given. */
  hardDeadlineMs?: number;
  /** Names the turn in log lines, e.g. "worker A1" or "control (writer)". */
  label: string;
  /** Names the turn in error messages: "the worker turn", "the control turn". */
  kind: "worker" | "control";
  log?(message: string): void;
}

export interface TurnOutcome {
  status: WorkerStatus;
  /** The final agent message, or the streamed text when no message completed; empty when nothing came. */
  text: string;
  usage: TokenUsage | null;
  turnId: string | null;
  /** Set when status is not `completed`; a failure kind first when known, e.g. "timeout: ...". */
  error: string | null;
  /** True when `turn/start` itself failed, so nothing ran. */
  startFailed: boolean;
}

function usageOfNotification(params: Record<string, unknown>): TokenUsage | null {
  const usage = recordOf(params["usage"]) ?? {};
  const inputTokens = typeof params["promptTokens"] === "number" ? params["promptTokens"] : typeof usage["inputTokens"] === "number" ? usage["inputTokens"] : 0;
  const outputTokens = typeof usage["outputTokens"] === "number" ? usage["outputTokens"] : 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }
  const cachedInputTokens = typeof usage["cacheReadTokens"] === "number" ? usage["cacheReadTokens"] : typeof usage["cachedTokens"] === "number" ? usage["cachedTokens"] : 0;
  const totalTokens = typeof params["totalTokens"] === "number" ? params["totalTokens"] : inputTokens + outputTokens;
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

/** The turn a notification belongs to, when it says. */
function turnOfNotification(params: Record<string, unknown>): string | null {
  if (typeof params["turnId"] === "string") {
    return params["turnId"];
  }
  const item = recordOf(params["item"]);
  return item && typeof item["turnId"] === "string" ? item["turnId"] : null;
}

/**
 * One `turn/start` in a Muse session, run to its end: the session's notifications are read for the final agent
 * message, the streamed text and the token usage, and the turn is ended by force when it outlives its wall time
 * or the run is stopped. Worker and control turns share this; what they do with tool calls, approvals and user
 * input goes through `onNotification`.
 *
 * Ending a turn is a ladder. `turn/interrupt` first; if the turn is still running after the grace period,
 * `turn/cancel`; and if the host never answers anything, the hard deadline resolves the turn anyway, because a
 * host that has gone quiet must not hold a run open. A shutdown skips the ladder and cancels at once. Every timer
 * is cleared when the turn settles, and none is armed afterwards, so a turn that completed before its own
 * `turn/start` acknowledgement settled leaves nothing behind.
 */
export async function runTurn(session: TurnSession, text: string, options: RunTurnOptions): Promise<TurnOutcome> {
  const { sessionId, manager } = session;
  const clock = options.clock ?? REAL_CLOCK;
  const cancelGraceMs = options.cancelGraceMs ?? TURN_CANCEL_GRACE_MS;
  const hardDeadlineMs = options.hardDeadlineMs ?? options.timeoutMs + cancelGraceMs + TURN_HARD_DEADLINE_SLACK_MS;
  const log = (message: string): void => options.log?.(`research: ${options.label} ${message}`);
  if (options.signal.aborted) {
    return { status: "cancelled", text: "", usage: null, turnId: null, error: "cancelled: the run was stopped before the turn started.", startFailed: true };
  }

  let turnId: string | null = null;
  let finalText: string | null = null;
  const deltas = new Map<string, string>();
  let usage: TokenUsage | null = null;
  let outcome: WorkerStatus | null = null;
  let outcomeError: string | null = null;
  let startFailed = false;
  let interruptSent = false;
  let cancelSent = false;
  let settled = false;
  const timers = new Set<unknown>();
  let pending: Promise<void> = Promise.resolve();
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let deadlinePassed: () => void = () => undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlinePassed = resolve;
  });

  /** Arms a timer, unless the turn has settled: nothing may fire after the end. */
  const arm = (ms: number, callback: () => void): void => {
    if (settled) {
      return;
    }
    const handle: unknown = clock.setTimeout(() => {
      timers.delete(handle);
      if (!settled) {
        callback();
      }
    }, ms);
    timers.add(handle);
  };

  const finish = (): void => {
    for (const handle of timers) {
      clock.clearTimeout(handle);
    }
    timers.clear();
    if (settled) {
      return;
    }
    settled = true;
    settle();
  };

  const record = (status: WorkerStatus, message: string | null): void => {
    if (outcome === null) {
      outcome = status;
      outcomeError = message;
    }
  };

  const cancelNow = (): void => {
    if (cancelSent) {
      return;
    }
    cancelSent = true;
    const id = turnId;
    if (!id) {
      // Nothing to cancel by id yet; interrupting the session's current turn is what remains.
      if (!interruptSent) {
        interruptSent = true;
        manager.interruptTurn(sessionId).catch((error: unknown) => log(`interrupt failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }
    manager.cancelTurn(sessionId, id).catch((error: unknown) => log(`cancel failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  const stop = (status: WorkerStatus, message: string, immediate = false): void => {
    record(status, message);
    if (settled) {
      return;
    }
    if (immediate) {
      // A shutdown does not wait for the host: the turn is cancelled now and the result is whatever exists.
      cancelNow();
      finish();
      return;
    }
    if (interruptSent) {
      return;
    }
    interruptSent = true;
    // Armed before the interrupt goes out: a host that never answers the interrupt must not hold the turn open.
    arm(cancelGraceMs, () => {
      log(`did not end within ${cancelGraceMs} ms of the interrupt; cancelling.`);
      cancelNow();
      // Muse may never answer a cancel for a turn it lost; the turn is over from here either way.
      finish();
    });
    manager.interruptTurn(sessionId, turnId ?? undefined).catch((error: unknown) => log(`interrupt failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  const control: TurnControl = {
    get turnId() {
      return turnId;
    },
    get settled() {
      return settled;
    },
    stop: (status, message) => stop(status, message),
    defer: (work) => {
      pending = pending.then(work).catch((error: unknown) => log(`deferred work failed: ${error instanceof Error ? error.message : String(error)}`));
    },
  };

  const onNotification: SessionNotificationHandler = (method, params) => {
    if (settled) {
      return;
    }
    // A reused session may still deliver stragglers of an earlier turn; they are not this turn's.
    const forTurn = turnOfNotification(params);
    if (turnId && forTurn && forTurn !== turnId) {
      return;
    }
    options.onNotification?.(method, params, control);
    if (settled) {
      return;
    }
    switch (method) {
      case "item/started":
      case "item/updated":
      case "item/completed": {
        const item = recordOf(params["item"]);
        if (item && item["kind"] === "agentMessage" && typeof item["text"] === "string" && item["text"].length > 0) {
          finalText = item["text"];
        }
        return;
      }
      case "item/delta": {
        const field = params["field"];
        const itemId = typeof params["itemId"] === "string" ? params["itemId"] : null;
        if (itemId && (field === undefined || field === "text") && typeof params["delta"] === "string") {
          deltas.set(itemId, (deltas.get(itemId) ?? "") + params["delta"]);
        }
        return;
      }
      case "session/tokenUsage": {
        const found = usageOfNotification(params);
        if (found) {
          usage = addUsage(usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 }, found);
        }
        return;
      }
      case "turn/completed": {
        const terminal = typeof params["terminal"] === "string" ? params["terminal"] : "completed";
        if (outcome === null) {
          if (terminal === "completed") {
            record("completed", null);
          } else if (terminal === "failed") {
            const error = recordOf(params["error"]);
            const message = (error && typeof error["message"] === "string" ? error["message"] : null) ?? (typeof params["reason"] === "string" ? params["reason"] : `The ${options.kind} turn failed.`);
            record("failed", `${failureKindOf(message)}: ${message}`);
          } else {
            record("cancelled", `cancelled: the ${options.kind} turn ended as ${terminal}.`);
          }
        }
        finish();
        return;
      }
      case "session/closed": {
        record("failed", `unavailable: the ${options.kind} session closed before its turn completed.`);
        finish();
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = options.subscribe(sessionId, onNotification);
  const onAbort = (): void => {
    stop("cancelled", "cancelled: the run was stopped.", isShutdownReason(options.signal.reason));
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  // The hard deadline is not one of the turn's own timers: it outlives `finish()` so that deferred work which
  // never lands cannot hold the result either. It is cleared when the result is assembled.
  const deadlineTimer = clock.setTimeout(() => {
    log(`passed its hard deadline (${hardDeadlineMs} ms); giving up on the host.`);
    record("timed_out", `timeout: the ${options.kind} turn passed its hard deadline of ${Math.round(hardDeadlineMs / 1000)} s.`);
    cancelNow();
    finish();
    deadlinePassed();
  }, hardDeadlineMs);

  void (async () => {
    try {
      const ack = await manager.sendTurn(sessionId, text);
      if (settled) {
        // The turn completed, or was given up on, before its acknowledgement settled: no timer is armed now.
        return;
      }
      turnId = ack.turnId;
      if (options.signal.aborted) {
        stop("cancelled", "cancelled: the run was stopped.", isShutdownReason(options.signal.reason));
        return;
      }
      arm(options.timeoutMs, () => {
        log(`passed its wall time; interrupting.`);
        stop("timed_out", `timeout: the ${options.kind} turn passed its ${Math.round(options.timeoutMs / 1000)} s wall time.`);
      });
    } catch (error) {
      if (settled) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const kind = failureKindOf(message);
      startFailed = true;
      record("failed", `${kind === "other" ? "unavailable" : kind}: could not start the ${options.kind} turn: ${message}`);
      finish();
    }
  })();

  try {
    await Promise.race([done.then(() => pending), deadline]);
  } finally {
    clock.clearTimeout(deadlineTimer);
    finish();
    unsubscribe();
    options.signal.removeEventListener("abort", onAbort);
  }

  const streamed = [...deltas.values()].filter((t) => t.trim().length > 0).pop() ?? "";
  // `outcome` is written from the notification closures, which TypeScript's narrowing cannot see.
  const status: WorkerStatus = (outcome as WorkerStatus | null) ?? "completed";
  let error: string | null = null;
  if (status === "failed" || status === "cancelled") {
    error = outcomeError ?? `${status}: the ${options.kind} turn did not complete.`;
  } else if (status === "timed_out") {
    error = outcomeError ?? `timeout: the ${options.kind} turn passed its wall time.`;
  }
  return { status, text: finalText ?? streamed, usage, turnId, error, startFailed };
}
