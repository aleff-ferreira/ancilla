import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "@ancilla/daemon";
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
  }): Promise<{ sessionId: string; modelId?: string | null }>;
  /**
   * Makes sure a thread this conversation already had is loaded on its Muse host, as opening it on the screen does: a host
   * that started again since the thread was last used holds none, and refuses every command to a thread it does not hold.
   * False when the thread cannot be used (it is gone, belongs to another provider/account, or another client holds it);
   * an error when the host cannot be reached.
   */
  openSession?(
    sessionId: string,
    expected?: { providerId?: string | null; account?: string | null },
  ): Promise<boolean | { ok: boolean; modelId?: string | null }>;
  /** Pre-spawns the voice host for `cwd` ahead of the first turn without creating an orphan thread. */
  warmHost?(cwd: string, account: string | null, providerId?: string | null): Promise<void>;
  /** Puts a thread on a model, doing nothing when it is on it already; absent where a thread's model cannot be changed. A refusal is an error. */
  setModel?(sessionId: string, modelId: string): Promise<void>;
  startTurn(input: {
    sessionId: string;
    text: string;
    displayText: string;
    commandId: string;
    reasoningEffort?: ReasoningEffort;
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
  /** Called when the underlying session confirms or heals its active model id. */
  onModelResolved?: (modelId: string | null) => void;
  /** Called when early `agentMessage` settlement bypasses a trailing `eot_gate` stall. */
  onEarlySettle?: (savedMs: number) => void;
  /** How long a turn may go without a word from Muse before it is given up on. */
  idleMs?: number;
  /** Grace window after `agentMessage` `item/completed` (with zero open tools/approvals) before settling early. Default 100 ms. */
  earlySettleGraceMs?: number;
  /** Compaction threshold on session prompt tokens before rotating to a fresh compacted voice session. Default 48_000. */
  maxSessionInputTokens?: number;
  /** The Muse model the thread answers with; null or absent leaves the thread on whatever Muse chose. */
  model?: string | null;
  /** Reasoning effort per voice turn; defaults to "minimal" on short conversational turns and "low" otherwise. */
  reasoningEffort?: ReasoningEffort;
}

function unpackOpened(res: boolean | { ok: boolean; modelId?: string | null }): { ok: boolean; modelId: string | null } {
  if (typeof res === "boolean") return { ok: res, modelId: null };
  return { ok: res.ok, modelId: typeof res.modelId === "string" && res.modelId !== "" ? res.modelId : null };
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
const DEFAULT_EARLY_SETTLE_GRACE_MS = 100;
const DEFAULT_MAX_SESSION_INPUT_TOKENS = 48_000;

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

function extractShownUserText(m: Extract<ChatMessage, { role: "user" }>): string {
  if (typeof m.rawUserText === "string" && m.rawUserText.trim() !== "") return m.rawUserText;
  const blocks = m.content.split(/\n\n+/);
  if (blocks.length <= 1) return m.content;
  let idx = 0;
  while (idx < blocks.length - 1) {
    const b = (blocks[idx] ?? "").trim();
    if (
      b.startsWith("[") ||
      b.startsWith("Memory ") ||
      b.startsWith("Relevant ") ||
      b.startsWith("Right now") ||
      b.startsWith("Background tasks:") ||
      b.startsWith("Active ")
    ) {
      idx++;
    } else {
      break;
    }
  }
  return blocks.slice(idx).join("\n\n");
}

function extractTextToolSection(systemContent: string): { section: string; names: string[] } | null {
  const marker = "\n\nYou can use tools. To use one, write it on a line of its own";
  const at = systemContent.indexOf(marker);
  if (at < 0) return null;
  const section = systemContent.slice(at + 2);
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^-\s+([A-Za-z_][\w.-]*):/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names.length > 0 ? { section, names } : null;
}

function extractTurnDeltaLines(systemContent: string): string[] {
  const deltas: string[] = [];
  for (const line of systemContent.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("The local time is ") ||
      trimmed.startsWith("The user is speaking ") ||
      trimmed.startsWith("The user mixed ") ||
      trimmed.startsWith("[Live Call State")
    ) {
      deltas.push(trimmed);
    }
  }
  return deltas;
}

interface LingeringTurn {
  sessionId: string;
  turnId: string;
  settledAt: number;
  done: Promise<void>;
  cancel: () => void;
}

export class MuseThreadBrain implements BrainProvider {
  readonly id = "muse-thread";
  readonly capabilities: BrainCapabilities = { tools: false, speculative: false, local: false };
  private sessionId: string | null;
  private model: string | null;
  /** The model confirmed active on the underlying session after `startSession`, `openSession`, or `setModel` succeeded. */
  private confirmedModel: string | null;
  /** One-time context note injected on the next turn after a mid-call model or provider switch. */
  private switchedToModel: string | null = null;
  /** The rules of the call have been told to the thread. */
  private told = false;
  private readonly toldToolNames = new Set<string>();
  /** The thread was made for this call, so earlier turns of the conversation have to be told to it. */
  private fresh: boolean;
  /** The thread is on the model chosen for the call (or none was chosen), so it need not be asked again. */
  private modelSet: boolean;
  /** The thread is loaded on its host: it was made for this call, or it has been opened. */
  private opened = false;
  /** Deduplicated in-flight `session()` resolution so `warm()` and `stream()` never double-open or double-start. */
  private sessionInFlight: Promise<string> | null = null;
  /** Set when session prompt tokens exceed the compaction threshold so the next turn rotates cleanly. */
  private rotateOnNextTurn = false;
  /** Prior turn that settled early on `agentMessage` completion while Muse's `eot_gate` was still finishing. */
  private lingeringTurn: LingeringTurn | null = null;
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
    const shownModel = this.model ?? this.confirmedModel;
    return shownModel ? `${who} (${shownModel})` : who;
  }

  get activeModel(): string | null {
    return this.confirmedModel ?? this.model;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  async warm(): Promise<void> {
    if (this.sessionId !== null && !this.opened) {
      await this.session().catch(() => undefined);
      return;
    }
    if (this.sessionId === null && this.options.host.warmHost) {
      await this.options.host
        .warmHost(this.options.cwd, this.options.account ?? null, this.options.providerId ?? "muse")
        .catch(() => undefined);
    }
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
        this.toldToolNames.clear();
      }
      this.switchedToModel = `${who}'s default model`;
      return;
    }
    this.model = normalized;
    this.modelSet = false;
    this.switchedToModel = `${who} (${normalized})`;
  }

  /** Updates live model state when the user or host changes the session's model outside voice settings. */
  syncExternalModel(sessionId: string, modelId: string): void {
    const normalized = modelId.trim();
    if (!normalized || this.sessionId !== sessionId) return;
    if (normalized === this.confirmedModel && normalized === this.model) return;
    const who = this.options.providerLabel ?? "Muse";
    this.model = normalized;
    this.confirmedModel = normalized;
    this.modelSet = true;
    this.switchedToModel = `${who} (${normalized})`;
  }

  /** Marks a brand-new provider thread opened mid-call so its first turn knows a live switch just occurred. */
  announceInitialSwitch(targetLabel: string): void {
    this.switchedToModel = targetLabel;
  }

  /** The thread to talk in: the conversation's own, loaded and on the model chosen, or a new one when it cannot be used. */
  private session(): Promise<string> {
    if (this.sessionInFlight) return this.sessionInFlight;
    const run = this.resolveSession().finally(() => {
      if (this.sessionInFlight === run) this.sessionInFlight = null;
    });
    this.sessionInFlight = run;
    return run;
  }

  private async resolveSession(): Promise<string> {
    const { host } = this.options;
    const who = this.options.providerLabel ?? "Muse";
    if (this.rotateOnNextTurn && this.sessionId !== null) {
      this.rotateOnNextTurn = false;
      this.lingeringTurn?.cancel();
      this.lingeringTurn = null;
      this.sessionId = null;
      this.opened = false;
      this.fresh = true;
      this.told = false;
      this.toldToolNames.clear();
    }
    const model = this.model;
    if (this.sessionId !== null && !this.opened) {
      const openedRes = host.openSession
        ? unpackOpened(
            await host.openSession(this.sessionId, {
              providerId: this.options.providerId ?? "muse",
              account: this.options.account ?? null,
            }),
          )
        : { ok: true, modelId: null };
      if (openedRes.ok) {
        this.opened = true;
        if (openedRes.modelId && this.confirmedModel === null) {
          this.confirmedModel = openedRes.modelId;
          this.options.onModelResolved?.(this.confirmedModel);
        }
      } else {
        host.log(`voice: the conversation's ${who} thread ${this.sessionId} cannot be used, so a new one was started`);
        this.sessionId = null;
        this.fresh = true;
        this.told = false;
        this.toldToolNames.clear();
      }
    }
    if (this.sessionId === null) {
      const created = await host.startSession({
        cwd: this.options.cwd,
        account: this.options.account ?? null,
        ...(this.options.providerId ? { providerId: this.options.providerId } : {}),
        title: this.options.title,
        ...(model ? { modelId: model } : {}),
      });
      this.sessionId = created.sessionId;
      this.opened = true;
      this.modelSet = true;
      const resolvedFromHost = typeof created.modelId === "string" && created.modelId !== "" ? created.modelId : null;
      this.confirmedModel = resolvedFromHost ?? model;
      if (resolvedFromHost && model && resolvedFromHost !== model) {
        this.model = resolvedFromHost;
      }
      this.options.onSession?.(created.sessionId);
      if (this.confirmedModel) this.options.onModelResolved?.(this.confirmedModel);
    }
    if (!this.modelSet && model) {
      this.modelSet = true;
      if (host.setModel) {
        try {
          await host.setModel(this.sessionId, model);
          this.confirmedModel = model;
          this.options.onModelResolved?.(model);
        } catch (error) {
          const why = (error instanceof Error ? error.message : String(error)).trim().replace(/[.\s]+$/, "");
          this.notice = `${who} would not put this thread on ${model}: ${why}. It answers on the model the thread already has.`;
          this.model = this.confirmedModel;
          this.switchedToModel = null;
          this.options.onModelResolved?.(this.confirmedModel);
          host.log(`voice: ${this.notice}`);
        }
      } else {
        this.confirmedModel = model;
        this.options.onModelResolved?.(model);
      }
    }
    return this.sessionId;
  }

  /**
   * The text to send for this request, and the person's own words from it for the thread to show. Nothing is marked as told
   * here: that is done once Muse has taken the prompt, so a prompt that did not get there does not use up the rules.
   */
  private promptFor(messages: readonly ChatMessage[]): {
    text: string;
    shown: string;
    toolNames: string[];
    hasToolResult: boolean;
  } | null {
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
    let hasToolResult = false;
    for (const m of fresh) {
      if (m.role === "user") {
        parts.push(m.content);
        shown = extractShownUserText(m);
      } else if (m.role === "tool") {
        hasToolResult = true;
        const spokenSuffix = m.spokenNarration
          ? `\n[Already spoken aloud: "${m.spokenNarration}" — do not repeat this confirmation unless adding new facts.]`
          : "";
        parts.push(`[Result of ${m.name}] ${m.content}${spokenSuffix}`);
        shown = shown || `(${m.name} finished)`;
        if (BACKGROUND_TASK_TOOLS.has(m.name)) startedBackgroundTask = true;
      }
    }
    if (startedBackgroundTask) {
      parts.push(
        "(The background task is now managed independently in its own session. Give a brief spoken confirmation in one or two plain sentences and finish this turn immediately — do not read or edit project files for that task in this voice thread.)",
      );
    }
    let text = parts.join("\n\n");
    const activeIdentity = this.confirmedModel ? ` Active model: ${who} (${this.confirmedModel}).` : "";
    const system = messages.find((m): m is Extract<ChatMessage, { role: "system" }> => m.role === "system");
    const systemContent = system?.content ?? "";
    const toolSection = extractTextToolSection(systemContent);

    if (!this.told) {
      const earlier = this.fresh
        ? messages.slice(0, messages.length - fresh.length).filter((m) => m.role === "user" || m.role === "assistant")
        : [];
      const recap =
        earlier.length === 0
          ? ""
          : `Earlier in this conversation:\n${earlier
              .slice(-12)
              .map((m) => `${m.role === "user" ? "User" : "You"}: ${clip((m as { content: string }).content, 300)}`)
              .join("\n")}\n\n`;
      text = `${RULES}${activeIdentity}\n${systemContent}\n\n${recap}${text}`;
      return { text, shown, toolNames: toolSection?.names ?? [], hasToolResult };
    }

    const headerLines: string[] = [REMINDER];
    if (activeIdentity) headerLines.push(`(${activeIdentity.trim()})`);
    const deltas = extractTurnDeltaLines(systemContent);
    if (deltas.length > 0) {
      headerLines.push(`(${deltas.join(" | ")})`);
    }
    const newTools = toolSection ? toolSection.names.some((name) => !this.toldToolNames.has(name)) : false;
    if (toolSection && newTools) {
      headerLines.push(toolSection.section);
    }
    text = `${headerLines.join("\n")}\n${text}`;
    return { text, shown, toolNames: toolSection?.names ?? [], hasToolResult };
  }

  private chooseEffort(shown: string, hasToolResult: boolean): ReasoningEffort {
    if (this.options.reasoningEffort) return this.options.reasoningEffort;
    if (!hasToolResult) {
      const words = shown.trim().split(/\s+/).filter(Boolean).length;
      if (words > 0 && words <= 12) return "minimal";
    }
    return "low";
  }

  private trackLingeringCompletion(sessionId: string, turnId: string): void {
    this.lingeringTurn?.cancel();
    const settledAt = Date.now();
    let resolveDone: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unwatchBg: (() => void) | null = null;
    let finished = false;
    const finish = (fromHost: boolean): void => {
      if (finished) return;
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      unwatchBg?.();
      unwatchBg = null;
      if (fromHost) {
        const saved = Math.max(0, Date.now() - settledAt);
        this.options.onEarlySettle?.(saved);
      }
      if (this.lingeringTurn?.turnId === turnId) {
        this.lingeringTurn = null;
      }
      resolveDone();
    };
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    unwatchBg = this.options.host.watch(sessionId, (method, params) => {
      if (method === "turn/completed" && params["turnId"] === turnId) {
        finish(true);
      } else if (method === "session/tokenUsage") {
        this.noteTokenUsage(params);
      }
    });
    timer = setTimeout(() => finish(false), 15_000);
    timer.unref?.();
    this.lingeringTurn = {
      sessionId,
      turnId,
      settledAt,
      done,
      cancel: () => finish(false),
    };
  }

  private noteTokenUsage(params: Record<string, unknown>): { inputTokens: number; outputTokens: number } | null {
    const usage = (params["usage"] ?? null) as Record<string, unknown> | null;
    const inputTokens = Number(params["promptTokens"] ?? usage?.["inputTokens"] ?? 0);
    const outputTokens = Number(usage?.["outputTokens"] ?? 0);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return null;
    const maxTokens = this.options.maxSessionInputTokens ?? DEFAULT_MAX_SESSION_INPUT_TOKENS;
    if (inputTokens > maxTokens) {
      this.rotateOnNextTurn = true;
    }
    return { inputTokens, outputTokens: Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0 };
  }

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const { host } = this.options;
    if (freshMessages(request.messages).length === 0) {
      yield { type: "error", message: "There was nothing to say to Muse.", retryable: false };
      return;
    }
    if (this.lingeringTurn) {
      const lingering = this.lingeringTurn;
      let timedOut = false;
      await Promise.race([
        lingering.done,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            timedOut = true;
            resolve();
          }, 250);
          t.unref?.();
        }),
      ]);
      if (timedOut && this.lingeringTurn === lingering) {
        await host.interruptTurn(lingering.sessionId, lingering.turnId).catch(() => undefined);
        await Promise.race([
          lingering.done,
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 250);
            t.unref?.();
          }),
        ]);
        if (this.lingeringTurn === lingering) lingering.cancel();
      }
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
    const prompt = this.promptFor(request.messages);
    if (!prompt) return;

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
      host.interruptTurn(sessionId, turnId).catch((error: unknown) =>
        host.log(`voice: Muse's turn could not be interrupted: ${error instanceof Error ? error.message : String(error)}`),
      );
    };
    const onAbort = (): void => {
      interrupt();
      wake?.();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        const effort = this.chooseEffort(prompt.shown, prompt.hasToolResult);
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
          if (!(isNotLoaded(error) && host.openSession && unpackOpened(await host.openSession(sessionId)).ok)) {
            throw error;
          }
          ack = await send();
        }
        turnId = ack.turnId;
        this.told = true;
        for (const name of prompt.toolNames) this.toldToolNames.add(name);
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
      const openNonMessageItems = new Set<string>();
      let completedAgentMessageAt: number | null = null;
      let lastWordAt = Date.now();
      let approvalWaitStartedAt: number | null = null;
      const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
      const graceMs = this.options.earlySettleGraceMs ?? DEFAULT_EARLY_SETTLE_GRACE_MS;

      for (;;) {
        while (queue.length > 0) {
          const { method, params } = queue.shift() as { method: string; params: Record<string, unknown> };
          lastWordAt = Date.now();
          if (method === "session/tokenUsage") {
            const u = this.noteTokenUsage(params);
            if (u) yield { type: "usage", inputTokens: u.inputTokens, outputTokens: u.outputTokens };
            continue;
          }
          if (method === "session/modelChanged") {
            const changedModel = typeof params["modelId"] === "string" ? params["modelId"].trim() : "";
            if (changedModel) {
              this.confirmedModel = changedModel;
              this.model = changedModel;
              this.options.onModelResolved?.(changedModel);
            }
            continue;
          }
          const item = (params["item"] ?? null) as Record<string, unknown> | null;
          const itemTurn =
            item && typeof item["turnId"] === "string"
              ? item["turnId"]
              : typeof params["turnId"] === "string"
                ? params["turnId"]
                : null;
          if (item && itemTurn !== null && itemTurn !== turnId) continue;
          if (method === "item/started" || method === "item/updated" || method === "item/completed") {
            if (!item) continue;
            const id = String(item["itemId"] ?? item["id"] ?? "");
            const kind = String(item["kind"] ?? item["type"] ?? "");
            if (id) kinds.set(id, kind);
            if (kind === "agentMessage") {
              if (method === "item/started" || method === "item/updated") {
                completedAgentMessageAt = null;
              }
              const buffered = early.get(id);
              if (buffered) {
                early.delete(id);
                for (const delta of buffered) {
                  spoken.add(id);
                  yield { type: "text", delta };
                }
              }
              // A message that arrived whole (nothing streamed it) is said as it is.
              if (method === "item/completed") {
                if (!spoken.has(id) && typeof item["text"] === "string" && item["text"] !== "") {
                  spoken.add(id);
                  yield { type: "text", delta: item["text"] };
                }
                completedAgentMessageAt = Date.now();
              }
            } else if (kind !== "" && kind !== "userMessage" && kind !== "reasoning") {
              if (method === "item/completed") {
                if (id) openNonMessageItems.delete(id);
              } else {
                completedAgentMessageAt = null;
                if (id) openNonMessageItems.add(id);
                if (!host.onApprovalRequested && host.needsUser(sessionId)) {
                  interrupt();
                  yield {
                    type: "error",
                    message: "Muse wants to do something that needs your approval, which a call cannot give. It is waiting on the screen.",
                    retryable: false,
                  };
                  return;
                }
              }
            }
          } else if (method === "item/delta" || method === "item/agentMessage/delta") {
            const id = String(params["itemId"] ?? params["id"] ?? "");
            const delta = typeof params["delta"] === "string" ? params["delta"] : "";
            if (delta === "") continue;
            const kind = kinds.get(id);
            if (kind === "agentMessage") {
              completedAgentMessageAt = null;
              spoken.add(id);
              yield { type: "text", delta };
            } else if (kind === undefined) {
              early.set(id, [...(early.get(id) ?? []), delta]);
            }
          } else if (method === "approval/requested") {
            completedAgentMessageAt = null;
            if (!host.onApprovalRequested) {
              interrupt();
              yield {
                type: "error",
                message: "Muse asked for an approval, which a call cannot give. It is waiting on the screen.",
                retryable: false,
              };
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
              yield {
                type: "error",
                message: typeof error?.message === "string" && error.message !== "" ? error.message : `Muse's turn ended early (${terminal}).`,
                retryable: terminal === "failed",
              };
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
          if (completedAgentMessageAt !== null && openNonMessageItems.size === 0) {
            const elapsed = Date.now() - completedAgentMessageAt;
            if (elapsed >= graceMs) {
              this.trackLingeringCompletion(sessionId, turnId);
              yield { type: "done", reason: "stop" };
              return;
            }
          }
          if (Date.now() - lastWordAt > idleMs) {
            interrupt();
            yield { type: "error", message: "Muse took too long to answer.", retryable: true };
            return;
          }
        }
        const waitMs =
          !awaitingApproval && completedAgentMessageAt !== null && openNonMessageItems.size === 0
            ? Math.max(5, graceMs - (Date.now() - completedAgentMessageAt))
            : 1000;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, waitMs);
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
      request.signal.removeEventListener("abort", onAbort);
      unwatch();
    }
  }
}
