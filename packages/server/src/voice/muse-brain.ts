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
  startSession(input: { cwd: string; account: string | null; title: string }): Promise<{ sessionId: string }>;
  startTurn(input: { sessionId: string; text: string; displayText: string; commandId: string }): Promise<{ turnId: string }>;
  interruptTurn(sessionId: string, turnId: string): Promise<void>;
  needsUser(sessionId: string): boolean;
  watch(sessionId: string, handler: (method: string, params: Record<string, unknown>) => void): () => void;
  log(line: string): void;
}

export interface MuseBrainOptions {
  host: MuseBrainHost;
  /** The folder the thread belongs to. */
  cwd: string;
  title: string;
  /** The thread this conversation already has, to go on in. */
  sessionId?: string | null;
  /** Called when a thread was made, so the conversation can remember it. */
  onSession?: (sessionId: string) => void;
  /** How long a turn may go without a word from Muse before it is given up on. */
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 90_000;

const RULES = [
  "This is a live voice call: everything you write is spoken aloud.",
  "Answer first, in one to three short sentences, the way a person talks. No markdown, lists, headings or emoji.",
  "Do not use any tools, read or change any files, or run anything: answer from what you know and the notes below. If something needs that, say so in a sentence.",
].join(" ");

const REMINDER = "(Voice call: answer aloud in one to three short sentences, no markdown, no tools.)";

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
  readonly label = "Muse";
  readonly capabilities: BrainCapabilities = { tools: false, speculative: false, local: false };
  private sessionId: string | null;
  /** The rules of the call have been told to the thread. */
  private told = false;
  /** The thread was made for this call, so earlier turns of the conversation have to be told to it. */
  private fresh: boolean;

  constructor(private readonly options: MuseBrainOptions) {
    this.sessionId = options.sessionId ?? null;
    this.fresh = this.sessionId === null;
  }

  private async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const { sessionId } = await this.options.host.startSession({ cwd: this.options.cwd, account: null, title: this.options.title });
    this.sessionId = sessionId;
    this.options.onSession?.(sessionId);
    return sessionId;
  }

  /** The text to send for this request, and the person's own words from it for the thread to show. */
  private promptFor(messages: readonly ChatMessage[]): { text: string; shown: string } | null {
    const fresh = freshMessages(messages);
    if (fresh.length === 0) return null;
    const parts: string[] = [];
    let shown = "";
    for (const m of fresh) {
      if (m.role === "user") {
        parts.push(m.content);
        shown = m.content.split("\n").pop() ?? m.content;
      } else if (m.role === "tool") {
        parts.push(`[Result of ${m.name}] ${m.content}`);
        shown = shown || `(${m.name} finished)`;
      }
    }
    let text = parts.join("\n\n");
    if (!this.told) {
      const system = messages.find((m) => m.role === "system");
      const earlier = this.fresh ? messages.slice(0, messages.length - fresh.length).filter((m) => m.role === "user" || m.role === "assistant") : [];
      const recap = earlier.length === 0 ? "" : `Earlier in this conversation:\n${earlier.slice(-12).map((m) => `${m.role === "user" ? "User" : "You"}: ${clip((m as { content: string }).content, 300)}`).join("\n")}\n\n`;
      text = `${RULES}\n${system && system.role === "system" ? system.content : ""}\n\n${recap}${text}`;
      this.told = true;
    } else {
      text = `${REMINDER}\n${text}`;
    }
    return { text, shown };
  }

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const { host } = this.options;
    const prompt = this.promptFor(request.messages);
    if (!prompt) {
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
    if (request.signal.aborted) return;

    // Everything Muse says about this thread is queued as it comes, and read in order below.
    const queue: Array<{ method: string; params: Record<string, unknown> }> = [];
    let wake: (() => void) | null = null;
    const unwatch = host.watch(sessionId, (method, params) => {
      queue.push({ method, params });
      wake?.();
    });
    let turnId: string | null = null;
    let interrupted = false;
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
        const ack = await host.startTurn({ sessionId, text: prompt.text, displayText: `Voice: ${clip(prompt.shown, 400)}`, commandId: `voice-${randomUUID()}` });
        turnId = ack.turnId;
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
            } else if (kind !== "" && kind !== "reasoning" && kind !== "userMessage" && method !== "item/completed" && host.needsUser(sessionId)) {
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
            interrupt();
            yield { type: "error", message: "Muse asked for an approval, which a call cannot give. It is waiting on the screen.", retryable: false };
            return;
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
        if (Date.now() - lastWordAt > idleMs) {
          interrupt();
          yield { type: "error", message: "Muse took too long to answer.", retryable: true };
          return;
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
      request.signal.removeEventListener("abort", onAbort);
      unwatch();
    }
  }
}
