import { randomUUID } from "node:crypto";
import type { BrainCapabilities, BrainEvent, BrainProvider, BrainRequest, ChatMessage } from "./brain.js";

/**
 * The call's mind, when it is Muse: a thread of the person's own Muse plan. Muse keeps the conversation itself, so each
 * turn sends only what is new (what the person just said, or what a tool returned), and the thread is a normal one the
 * person can open and read. It is slower than a model made for chat, because a Muse turn is a whole agent turn, and the
 * call covers the wait with a short phrase. What it must never do is act: a voice call cannot approve anything, so a turn
 * that asks to use a tool or for an approval is stopped and said to be waiting on the screen, never left hanging.
 */

/** What this needs of the server: the same four things the task executive uses, and a way to ask whether the thread is waiting on the person. */
export interface MuseBrainHost {
  /** `modelId` is the model the thread starts on; absent leaves it to Muse / the chosen CLI provider. */
  startSession(input: {
    cwd: string;
    account: string | null;
    providerId?: string | null;
    title: string;
    modelId?: string | null;
  }): Promise<{ sessionId: string }>;
  /**
   * Makes sure a thread this conversation already had is loaded on its Muse host, as opening it on the screen does: a host
   * that started again since the thread was last used holds none, and refuses every command to a thread it does not hold.
   * False when the thread cannot be used (it is gone, belongs to another provider/account, or another client holds it);
   * an error when the host cannot be reached.
   */
  openSession?(sessionId: string, expected?: { providerId?: string | null; account?: string | null }): Promise<boolean>;
  /** Puts a thread on a model, doing nothing when it is on it already; absent where a thread's model cannot be changed. A refusal is an error. */
  setModel?(sessionId: string, modelId: string): Promise<void>;
  startTurn(input: {
    sessionId: string;
    text: string;
    displayText: string;
    commandId: string;
    reasoningEffort?: "low" | "medium" | "high";
  }): Promise<{ turnId: string }>;
  interruptTurn(sessionId: string, turnId: string): Promise<void>;
  needsUser(sessionId: string): boolean;
  /** Surfaces a live Muse tool/command approval on the voice call card instead of aborting the turn. */
  onApprovalRequested?(input: { sessionId: string; turnId: string; params: Record<string, unknown> }): void;
  /** Clears a live Muse approval from the call card once resolved or aborted. */
  onApprovalResolved?(approvalId: string): void;
  watch(sessionId: string, handler: (method: string, params: Record<string, unknown>) => void): () => void;
  log(line: string): void;
}

export interface MuseBrainOptions {
  host: MuseBrainHost;
  /** The folder the thread belongs to. */
  cwd: string;
  /** Named account/profile for the chosen CLI provider, or null for its default sign-in. */
  account?: string | null;
  /** Which CLI provider runs the thread ("muse" by default). */
  providerId?: string | null;
  /** Display name of the chosen provider/account for status labels and notices. */
  providerLabel?: string | null;
  title: string;
  /** The thread this conversation already has, to go on in. */
  sessionId?: string | null;
  /** Called when a thread was made, so the conversation can remember it. */
  onSession?: (sessionId: string) => void;
  /** How long a turn may go without a word from Muse before it is given up on. */
  idleMs?: number;
  /** The Muse model the thread answers with; null or absent leaves the thread on whatever Muse chose. */
  model?: string | null;
  /** Reasoning effort per voice turn; defaults to "medium" so voice turns stay responsive while still supporting tool reasoning. */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * Muse refused a command because its host does not hold the thread: the thread has to be loaded, and the command is then
 * sent again. By the kind the protocol gives that refusal, or by the host's words for it ("session ... is not loaded on
 * this host"), in case a host words it under another kind.
 */
function isNotLoaded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  return kind === "sessionNotLoaded" || (typeof message === "string" && /\bnot loaded on this host\b/i.test(message));
}

const DEFAULT_IDLE_MS = 90_000;
const MAX_APPROVAL_WAIT_MS = 10 * 60_000;

const BACKGROUND_TASK_TOOLS = new Set(["delegate_task", "propose_change", "browse", "use_connector"]);

const RULES = [
  "This is a live voice call: everything you write in your spoken reply is read aloud.",
  "Answer first, in one to three short sentences, the way a person talks. No markdown, lists, headings, code blocks or emoji in spoken text.",
  "You are a multi-tasking voice coordinator: multiple background tasks can run simultaneously while you continue listening and answering new questions. Answering a question or starting a new task never stops already-running tasks unless the user explicitly asks to pause or cancel one.",
  "Use your workspace tools for quick read-only lookups and any [[tool_name {...}]] call tools whenever the user asks to check files or threads, inspect a project, launch localhost or a command or URL, inspect a live page or animation, or start background work.",
  "Never edit files, run builds, or carry out multi-step coding work directly inside this voice thread — start a background task with [[propose_change {...}]], [[delegate_task {...}]], [[browse {...}]] or [[use_connector {...}]], and once a tool confirms the task is started or waiting for approval, reply briefly and end your turn immediately.",
  "Prefer the [[launch {...}]] and [[inspect_page {...}]] call tools when starting a local server or checking graphics and animations on localhost so Ancilla manages the process and measures FPS, Canvas scaling, CSS animations and console errors.",
].join(" ");

const REMINDER =
  "(Voice call: speak naturally in one to three short sentences with no markdown. Keep existing background tasks running unless asked to pause or cancel them. Delegate edits or multi-step work via [[propose_change {...}]] or [[delegate_task {...}]], use workspace tools only for quick read-only checks, and end your turn as soon as a background task is started.)";

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** What is new in a request: the messages after the model's own last one. */
function freshMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  let from = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as ChatMessage).role === "assistant") break;
    from = i;
  }
  return messages.slice(from).filter((m) => m.role !== "system");
}

export class MuseThreadBrain implements BrainProvider {
  readonly id = "muse-thread";
  readonly capabilities: BrainCapabilities = { tools: false, speculative: false, local: false };
  private sessionId: string | null;
  private model: string | null;
  /** The model confirmed active on the underlying session after `startSession` or `setModel` succeeded. */
  private confirmedModel: string | null;
  /** One-time context note injected on the next turn after a mid-call model or provider switch. */
  private switchedToModel: string | null = null;
  /** The rules of the call have been told to the thread. */
  private told = false;
  /** The thread was made for this call, so earlier turns of the conversation have to be told to it. */
  private fresh: boolean;
  /** The thread is on the model chosen for the call (or none was chosen), so it need not be asked again. */
  private modelSet: boolean;
  /** The thread is loaded on its host: it was made for this call, or it has been opened. */
  private opened = false;
  /** Something the person should be told that does not stop the answer, said with the next one. */
  private notice: string | null = null;

  constructor(private readonly options: MuseBrainOptions) {
    this.sessionId = options.sessionId ?? null;
    this.model = options.model ?? null;
    this.confirmedModel = this.sessionId === null ? this.model : null;
    this.fresh = this.sessionId === null;
    this.modelSet = !this.model;
  }

  get label(): string {
    const who = this.options.providerLabel ?? "Muse";
    return this.model ? `${who} (${this.model})` : who;
  }

  /** Switches the active model of an open voice call without dropping the call. */
  switchModel(nextModel: string | null): void {
    const normalized = nextModel?.trim() ? nextModel.trim() : null;
    if (normalized === this.model) return;
    const who = this.options.providerLabel ?? "Muse";
    if (normalized === null) {
      this.model = null;
      this.confirmedModel = null;
      this.modelSet = true;
      if (this.sessionId !== null) {
        this.sessionId = null;
        this.opened = false;
        this.fresh = true;
        this.told = false;
      }
      this.switchedToModel = `${who}'s default model`;
      return;
    }
    this.model = normalized;
    this.modelSet = false;
    this.switchedToModel = `${who} (${normalized})`;
  }

  /** Marks a brand-new provider thread opened mid-call so its first turn knows a live switch just occurred. */
  announceInitialSwitch(targetLabel: string): void {
    this.switchedToModel = targetLabel;
  }

  /** The thread to talk in: the conversation's own, loaded and on the model chosen, or a new one when it cannot be used. */
  private async session(): Promise<string> {
    const { host } = this.options;
    const model = this.model;
    const who = this.options.providerLabel ?? "Muse";
    if (this.sessionId !== null && !this.opened) {
      // A thread the conversation already had is not loaded on a Muse host that started again since it was last used (the
      // desktop app starts one with each launch), and the host refuses every command to it. It is loaded, as opening it on
      // the screen does, once for the call; one that cannot be used is replaced by a new thread, told what was said before.
      const usable = host.openSession
        ? await host.openSession(this.sessionId, {
            providerId: this.options.providerId ?? "muse",
            account: this.options.account ?? null,
          })
        : true;
      if (usable) this.opened = true;
      else {
        host.log(`voice: the conversation's ${who} thread ${this.sessionId} cannot be used, so a new one was started`);
        this.sessionId = null;
        this.fresh = true;
        this.told = false;
      }
    }
    if (this.sessionId === null) {
      const { sessionId } = await host.startSession({
        cwd: this.options.cwd,
        account: this.options.account ?? null,
        ...(this.options.providerId ? { providerId: this.options.providerId } : {}),
        title: this.options.title,
        ...(model ? { modelId: model } : {}),
      });
      this.sessionId = sessionId;
      this.opened = true;
      // A thread that began on the model is on it.
      this.modelSet = true;
      this.confirmedModel = model;
      this.options.onSession?.(sessionId);
    }
    if (!this.modelSet && model) {
      // A thread the conversation already had is put on the model chosen now, once; a thread that is on it is left alone.
      // When Muse will not, the call still answers, on the model the thread has, and says so: a call that cannot change
      // model is a lesser thing than one that does not answer.
      this.modelSet = true;
      if (host.setModel) {
        try {
          await host.setModel(this.sessionId, model);
          this.confirmedModel = model;
        } catch (error) {
          const why = (error instanceof Error ? error.message : String(error)).trim().replace(/[.\s]+$/, "");
          this.notice = `${who} would not put this thread on ${model}: ${why}. It answers on the model the thread already has.`;
          this.model = this.confirmedModel;
          this.switchedToModel = null;
          host.log(`voice: ${this.notice}`);
        }
      } else {
        this.confirmedModel = model;
      }
    }
    return this.sessionId;
  }

  /**
   * The text to send for this request, and the person's own words from it for the thread to show. Nothing is marked as told
   * here: that is done once Muse has taken the prompt, so a prompt that did not get there does not use up the rules.
   */
  private promptFor(messages: readonly ChatMessage[]): { text: string; shown: string } | null {
    const fresh = freshMessages(messages);
    if (fresh.length === 0) return null;
    const who = this.options.providerLabel ?? "Muse";
    const parts: string[] = [];
    if (this.switchedToModel !== null) {
      parts.push(
        `(System note: The user just switched your active model for this conversation to ${this.switchedToModel}. Answer from your current model identity and do not repeat any previous model name mentioned in earlier turns.)`,
      );
    }
    let shown = "";
    let startedBackgroundTask = false;
    for (const m of fresh) {
      if (m.role === "user") {
        parts.push(m.content);
        shown = m.content.split("\n").pop() ?? m.content;
      } else if (m.role === "tool") {
        parts.push(`[Result of ${m.name}] ${m.content}`);
        shown = shown || `(${m.name} finished)`;
        if (BACKGROUND_TASK_TOOLS.has(m.name)) startedBackgroundTask = true;
      }
    }
    if (startedBackgroundTask) {
      parts.push("(The background task is now managed independently in its own session. Give a brief spoken confirmation in one or two plain sentences and finish this turn immediately — do not read or edit project files for that task in this voice thread.)");
    }
    let text = parts.join("\n\n");
    const activeIdentity = this.confirmedModel ? ` Active model: ${who} (${this.confirmedModel}).` : "";
    if (!this.told) {
      const system = messages.find((m) => m.role === "system");
      const earlier = this.fresh ? messages.slice(0, messages.length - fresh.length).filter((m) => m.role === "user" || m.role === "assistant") : [];
      const recap = earlier.length === 0 ? "" : `Earlier in this conversation:\n${earlier.slice(-12).map((m) => `${m.role === "user" ? "User" : "You"}: ${clip((m as { content: string }).content, 300)}`).join("\n")}\n\n`;
      text = `${RULES}${activeIdentity}\n${system && system.role === "system" ? system.content : ""}\n\n${recap}${text}`;
    } else {
      text = `${REMINDER}${activeIdentity ? `\n(${activeIdentity.trim()})` : ""}\n${text}`;
    }
    return { text, shown };
  }

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const { host } = this.options;
    if (freshMessages(request.messages).length === 0) {
      yield { type: "error", message: "There was nothing to say to Muse.", retryable: false };
      return;
    }
    let sessionId: string;
    try {
      sessionId = await this.session();
    } catch (error) {
      yield { type: "error", message: `Muse could not be reached: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
      return;
    }
    if (this.notice !== null) {
      yield { type: "notice", text: this.notice };
      this.notice = null;
    }
    if (request.signal.aborted) return;
    // Made only now: a thread that was replaced is a new one, which has to be told what was said before.
    const prompt = this.promptFor(request.messages) as { text: string; shown: string };

    // Everything Muse says about this thread is queued as it comes, and read in order below.
    const queue: Array<{ method: string; params: Record<string, unknown> }> = [];
    let wake: (() => void) | null = null;
    const unwatch = host.watch(sessionId, (method, params) => {
      queue.push({ method, params });
      wake?.();
    });
    let turnId: string | null = null;
    let interrupted = false;
    const waitingApprovals = new Set<string>();
    const interrupt = (): void => {
      if (interrupted || !turnId) return;
      interrupted = true;
      host.interruptTurn(sessionId, turnId).catch((error: unknown) => host.log(`voice: Muse's turn could not be interrupted: ${error instanceof Error ? error.message : String(error)}`));
    };
    const onAbort = (): void => {
      interrupt();
      wake?.();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        const effort = this.options.reasoningEffort ?? "medium";
        const send = () =>
          host.startTurn({
            sessionId,
            text: prompt.text,
            displayText: `Voice: ${clip(prompt.shown, 400)}`,
            commandId: `voice-${randomUUID()}`,
            reasoningEffort: effort,
          });
        let ack: { turnId: string };
        try {
          ack = await send();
        } catch (error) {
          // The host started again in the middle of the call, or let the thread go: it refused the prompt, so loading the
          // thread and sending it once more cannot say it twice. Only once; what is refused after that is the answer.
          if (!(isNotLoaded(error) && host.openSession && (await host.openSession(sessionId)))) throw error;
          ack = await send();
        }
        turnId = ack.turnId;
        this.told = true;
        this.switchedToModel = null;
      } catch (error) {
        yield { type: "error", message: `Muse did not take that: ${error instanceof Error ? error.message : String(error)}`, retryable: true };
        return;
      }
      if (request.signal.aborted) {
        interrupt();
        return;
      }
      const kinds = new Map<string, string>();
      const spoken = new Set<string>();
      const early = new Map<string, string[]>();
      let lastWordAt = Date.now();
      let approvalWaitStartedAt: number | null = null;
      const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
      for (;;) {
        while (queue.length > 0) {
          const { method, params } = queue.shift() as { method: string; params: Record<string, unknown> };
          lastWordAt = Date.now();
          const item = (params["item"] ?? null) as Record<string, unknown> | null;
          const itemTurn = item && typeof item["turnId"] === "string" ? item["turnId"] : null;
          if (item && itemTurn !== null && itemTurn !== turnId) continue;
          if (method === "item/started" || method === "item/updated" || method === "item/completed") {
            if (!item) continue;
            const id = String(item["itemId"] ?? "");
            const kind = String(item["kind"] ?? "");
            kinds.set(id, kind);
            if (kind === "agentMessage") {
              const buffered = early.get(id);
              if (buffered) {
                early.delete(id);
                for (const delta of buffered) {
                  spoken.add(id);
                  yield { type: "text", delta };
                }
              }
              // A message that arrived whole (nothing streamed it) is said as it is.
              if (method === "item/completed" && !spoken.has(id) && typeof item["text"] === "string" && item["text"] !== "") {
                spoken.add(id);
                yield { type: "text", delta: item["text"] };
              }
            } else if (
              !host.onApprovalRequested &&
              kind !== "" &&
              kind !== "reasoning" &&
              kind !== "userMessage" &&
              method !== "item/completed" &&
              host.needsUser(sessionId)
            ) {
              interrupt();
              yield { type: "error", message: "Muse wants to do something that needs your approval, which a call cannot give. It is waiting on the screen.", retryable: false };
              return;
            }
          } else if (method === "item/delta") {
            const id = String(params["itemId"] ?? "");
            const delta = typeof params["delta"] === "string" ? params["delta"] : "";
            if (delta === "") continue;
            const kind = kinds.get(id);
            if (kind === "agentMessage") {
              spoken.add(id);
              yield { type: "text", delta };
            } else if (kind === undefined) {
              early.set(id, [...(early.get(id) ?? []), delta]);
            }
          } else if (method === "approval/requested") {
            if (!host.onApprovalRequested) {
              interrupt();
              yield { type: "error", message: "Muse asked for an approval, which a call cannot give. It is waiting on the screen.", retryable: false };
              return;
            }
            const approvalId = String(params["approvalId"] ?? "");
            if (approvalId) waitingApprovals.add(approvalId);
            approvalWaitStartedAt ??= Date.now();
            host.onApprovalRequested({ sessionId, turnId: turnId ?? "", params });
            yield { type: "notice", text: "Waiting for your approval — click Allow on the call card or say go ahead." };
          } else if (method === "approval/resolved") {
            const approvalId = String(params["approvalId"] ?? "");
            if (approvalId) {
              waitingApprovals.delete(approvalId);
              host.onApprovalResolved?.(approvalId);
            }
            if (waitingApprovals.size === 0) approvalWaitStartedAt = null;
          } else if (method === "turn/completed" && params["turnId"] === turnId) {
            const terminal = String(params["terminal"] ?? "completed");
            if (terminal === "completed") {
              yield { type: "done", reason: "stop" };
            } else if (request.signal.aborted) {
              return;
            } else {
              const error = params["error"] as { message?: unknown } | undefined;
              yield { type: "error", message: typeof error?.message === "string" && error.message !== "" ? error.message : `Muse's turn ended early (${terminal}).`, retryable: terminal === "failed" };
            }
            return;
          }
        }
        if (request.signal.aborted) return;
        const awaitingApproval = waitingApprovals.size > 0 || (Boolean(host.onApprovalRequested) && host.needsUser(sessionId));
        if (awaitingApproval) {
          approvalWaitStartedAt ??= Date.now();
          lastWordAt = Date.now();
          if (Date.now() - approvalWaitStartedAt > MAX_APPROVAL_WAIT_MS) {
            interrupt();
            yield { type: "error", message: "Approval timed out after ten minutes.", retryable: false };
            return;
          }
        } else {
          approvalWaitStartedAt = null;
          if (Date.now() - lastWordAt > idleMs) {
            interrupt();
            yield { type: "error", message: "Muse took too long to answer.", retryable: true };
            return;
          }
        }
        // Wait for the next word from Muse, or for a second to pass so that silence is noticed.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1000);
          function done(): void {
            clearTimeout(timer);
            wake = null;
            resolve();
          }
          wake = done;
          if (queue.length > 0 || request.signal.aborted) done();
        });
      }
    } finally {
      for (const approvalId of waitingApprovals) {
        host.onApprovalResolved?.(approvalId);
      }
      request.signal.removeEventListener("abort", onAbort);
      unwatch();
    }
  }
}
