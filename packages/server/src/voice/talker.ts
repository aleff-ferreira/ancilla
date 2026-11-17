import type { BrainCapabilities, BrainProvider, ChatMessage, ToolCall, ToolSpec } from "./brain.js";
import type { ToolResult, VoiceHost } from "./host.js";
import { routeUtterance } from "./pre-router.js";
import { buildSystemPrompt, sayable, taskPhrase } from "./prompt.js";
import type { Lang } from "./text.js";
import { talkerTools } from "./tool-router.js";

/**
 * The call with a small model on this computer as its talker (see ancilla-voice-w2 in the notes): a few tools, always the same
 * ones; the few requests that such a model does not route reliably run before it answers; and the part of the prompt that never
 * changes is read once, when the call opens, instead of on the first turn. Work that takes time goes to the assistant's own
 * model through `delegate_task`, as it does for every voice.
 */

/** A model that runs on this computer and takes tools. */
export function isTalkerBrain(capabilities: BrainCapabilities): boolean {
  return capabilities.local && capabilities.tools;
}

// ---------------------------------------------------------------------------------------------------------------------
// The first read of the prompt

/** What every request of the call starts with: the system text and the tools. Both are the same for the whole call. */
export interface PromptPrefix {
  system: string;
  tools: ToolSpec[];
}

export function talkerPrefix(host: Pick<VoiceHost, "persona" | "tools">): PromptPrefix {
  return { system: buildSystemPrompt(host.persona(), new Date(0), "en").system, tools: talkerTools(host.tools()) };
}

/**
 * Makes the model read the prefix now: one request with that and one word, that may answer with one token. A server that keeps
 * what it has read of a prompt (llama.cpp does) then has it when the first real turn comes, and that turn pays for its own
 * words only. A brain that does not keep it is left alone, and nothing here throws.
 */
export async function primeBrain(brain: BrainProvider, prefix: () => PromptPrefix, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<void> {
  if (brain.capabilities.prefixCache !== true) return;
  try {
    const { system, tools } = prefix();
    const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: "Hello." }];
    for await (const event of brain.stream({ messages, tools, signal, maxTokens: 1, temperature: 0 })) {
      if (event.type === "error" || event.type === "done") break;
    }
  } catch {
    /* a warm-up that did not happen costs the first turn what it would have cost anyway */
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The requests that run before the model answers

const bank = (lang: Lang): "en" | "pt" | "es" => (lang === "pt" ? "pt" : lang === "es" ? "es" : "en");

const ASK: Record<"en" | "pt" | "es", (title: string) => string> = {
  en: (t) => `Do you want me to cancel ${t}? Say yes to confirm.`,
  pt: (t) => `Quer que eu cancele ${t}? Diga sim para confirmar.`,
  es: (t) => `¿Quieres que cancele ${t}? Di sí para confirmar.`,
};

const KEPT: Record<"en" | "pt" | "es", string> = {
  en: "All right, I will leave it as it is.",
  pt: "Tudo bem, deixo como está.",
  es: "De acuerdo, lo dejo como está.",
};

/** What the router made of a turn, for the call to use before the model is asked. */
export interface Prepared {
  /** Calls the router made and what came back, as the model would have seen them had it made them. */
  rounds: ChatMessage[];
  /** A whole answer that needs no model: the question before a cancellation, or the word that it was done or left. */
  say: string | null;
  /** One line for each tool that ran, for the record of the reply. */
  ran: string[];
  /** The task that `say` asks about cancelling: it waits for the answer once the person has heard the question (see `arm`). */
  asked: { id: string; title: string } | null;
}

const NOTHING: Prepared = { rounds: [], say: null, ran: [], asked: null };

/**
 * The router of a call. It holds one thing between turns: a cancellation that was asked about and waits for the answer. That
 * is the whole of the approval for a cancellation, and it lasts one turn: anything the person says that is not a yes or a no
 * drops it. A question the person never heard (the reply was cut off before it was said) is not waiting for a "yes".
 */
export class TalkerTurn {
  private waiting: { id: string; title: string } | null = null;
  private calls = 0;

  /** The question about cancelling `asked` was heard (at least in part): the next turn may answer it. */
  arm(asked: { id: string; title: string }): void {
    this.waiting = asked;
  }

  async prepare(
    text: string,
    host: Pick<VoiceHost, "runTool" | "findTask">,
    lang: Lang,
    context: { turn: number; signal: AbortSignal },
  ): Promise<Prepared> {
    const waiting = this.waiting;
    this.waiting = null;
    const route = routeUtterance(text, waiting !== null);
    if (route.kind === "none") return NOTHING;
    if (route.kind === "answer") {
      if (waiting === null) return NOTHING;
      if (!route.yes) return { ...NOTHING, say: KEPT[bank(lang)] };
      const done = await this.run(host, "cancel_task", { id: waiting.id }, context);
      if (done === null) return NOTHING;
      return done.result.ok ? { ...NOTHING, say: taskPhrase(lang, "cancelled", waiting.title), ran: [done.line] } : { ...NOTHING, rounds: done.rounds, ran: [done.line] };
    }
    if (route.kind === "cancel") {
      const match = host.findTask?.(route.ref) ?? { kind: "none" as const };
      if (match.kind === "one") return { ...NOTHING, say: ASK[bank(lang)](sayable(match.title)), asked: { id: match.id, title: match.title } };
      if (match.kind === "many") return this.read(host, "list_tasks", { filter: "active" }, context);
      return NOTHING;
    }
    return this.read(host, route.tool, route.args, context);
  }

  private async read(host: Pick<VoiceHost, "runTool">, tool: string, args: Record<string, string>, context: { turn: number; signal: AbortSignal }): Promise<Prepared> {
    const done = await this.run(host, tool, args, context);
    return done === null ? NOTHING : { ...NOTHING, rounds: done.rounds, ran: [done.line] };
  }

  private async run(
    host: Pick<VoiceHost, "runTool">,
    name: string,
    args: Record<string, string>,
    context: { turn: number; signal: AbortSignal },
  ): Promise<{ result: ToolResult; rounds: ChatMessage[]; line: string } | null> {
    const call: ToolCall = { id: `route_${++this.calls}`, name, arguments: JSON.stringify(args) };
    let result: ToolResult;
    try {
      result = await host.runTool(call, context);
    } catch {
      return null;
    }
    return {
      result,
      rounds: [
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: call.id, name, content: result.text },
      ],
      line: `${name} -> ${result.text.replace(/\s+/g, " ").trim().slice(0, 140)}`,
    };
  }
}
