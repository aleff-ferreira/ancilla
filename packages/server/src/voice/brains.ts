import type { ExecResult } from "@ancilla/daemon";
import { MuseExecBrain } from "../browser/muse-brain.js";
import { AnthropicProvider, GoogleGenAiProvider, OpenAiCompatibleProvider, withTextTools, withToolFallback, type BrainEvent, type BrainProvider, type BrainRequest } from "./brain.js";
import { MuseThreadBrain, type MuseBrainHost } from "./muse-brain.js";
import type { BrainSetting, VoiceSettings } from "./settings.js";

/**
 * Which model answers the call, chosen from the settings. Every kind stands behind the same small interface, so the call
 * does not know whether it is talking to a hosted model, one on this machine, or a Muse thread.
 */

/** Says one thing and stops. Stands in when no model is ready, so that the call can still say what is wrong. */
export class StaticBrain implements BrainProvider {
  readonly id = "static";
  readonly label = "No model";
  readonly capabilities = { tools: false, speculative: true, local: true };

  constructor(private readonly message: string) {}

  async *stream(_request: BrainRequest): AsyncGenerator<BrainEvent> {
    yield { type: "text", delta: this.message };
    yield { type: "done", reason: "stop" };
  }
}

/** What a brain needs to know about the call it is for. */
export interface BrainContext {
  /** The folder a Muse thread is made in, and spoken tasks run in. */
  project: string | null;
  /** The name of the assistant, for the title of a Muse thread. */
  name: string;
  /** The Muse thread this conversation already has. */
  museSession: string | null;
  /** Called when a Muse thread was made for the conversation. */
  rememberMuseSession: (sessionId: string) => void;
}

export interface ResolvedApiAccount {
  apiKind: "openai" | "anthropic" | "google";
  baseUrl: string;
  apiKey: string | null;
  defaultModelId: string | null;
  label: string;
  local: boolean;
}

export interface BrainFactoryDeps {
  /** What a Muse thread needs of the server; absent where there is no Muse host to think in. */
  museHost: MuseBrainHost | null;
  /** For tests: a model that stands in for Muse. */
  muse?: ((context: BrainContext) => BrainProvider) | null;
  keyFor: (brain: BrainSetting) => string | null;
  /** Resolves a saved `Settings -> Providers` API account for direct HTTP brains. */
  resolveApiAccount?: (accountId: string | null) => ResolvedApiAccount | null;
  /** Human-readable name for a provider and optional account. */
  providerName?: (providerId: string, accountId: string | null) => string;
}

export interface ChosenBrain {
  brain: BrainProvider;
  /** Why it is not the model the settings ask for, or null when it is. */
  problem: string | null;
}

export const NO_BRAIN_CONTEXT: BrainContext = { project: null, name: "Assistant", museSession: null, rememberMuseSession: () => undefined };

function defaultApiModel(kind: ResolvedApiAccount["apiKind"], baseUrl: string): string {
  if (/openrouter\.ai/i.test(baseUrl)) return "openrouter/auto";
  if (/localhost:11434|127\.0\.0\.1:11434/i.test(baseUrl)) return "qwen2.5-coder:7b";
  if (kind === "anthropic") return "claude-sonnet-4-6";
  if (kind === "google") return "gemini-2.5-pro";
  return "gpt-5.3-codex";
}

function makeApiAccountBrain(
  accountId: string | null,
  chosenModel: string | null,
  resolveApiAccount: ((id: string | null) => ResolvedApiAccount | null) | undefined,
  missingKeyHint: string,
): ChosenBrain {
  const resolved = resolveApiAccount?.(accountId) ?? null;
  if (!resolved) {
    return {
      brain: new StaticBrain("That API provider is not configured. Check Settings, Providers, or choose another model in the voice settings."),
      problem: "API provider is not configured in Settings, Providers.",
    };
  }
  const model = chosenModel ?? resolved.defaultModelId ?? defaultApiModel(resolved.apiKind, resolved.baseUrl);
  const label = `${resolved.label} (${model})`;
  const problem = resolved.apiKey === null && !resolved.local ? missingKeyHint.replace("{label}", resolved.label) : null;
  if (resolved.apiKind === "anthropic") {
    const provider = new AnthropicProvider({ baseUrl: resolved.baseUrl, model, apiKey: resolved.apiKey, label, local: resolved.local });
    return { brain: withToolFallback(provider, { key: `anthropic:${resolved.baseUrl}|${model}` }), problem };
  }
  if (resolved.apiKind === "google") {
    const provider = new GoogleGenAiProvider({ baseUrl: resolved.baseUrl, model, apiKey: resolved.apiKey, label, local: resolved.local });
    return { brain: withToolFallback(provider, { key: `google:${resolved.baseUrl}|${model}` }), problem };
  }
  const provider = new OpenAiCompatibleProvider({ baseUrl: resolved.baseUrl, model, apiKey: resolved.apiKey, label, local: resolved.local });
  return { brain: withToolFallback(provider, { key: `${resolved.baseUrl}|${model}` }), problem };
}

export function makeBrain(settings: VoiceSettings, context: BrainContext, deps: BrainFactoryDeps): ChosenBrain {
  const choice = settings.brain;
  if (choice.kind === "openai") {
    const apiKey = deps.keyFor(choice);
    // A server that cannot take tools (a model on this computer often cannot) is given them through text instead.
    const provider = new OpenAiCompatibleProvider({ baseUrl: choice.baseUrl, model: choice.model, apiKey, label: choice.label ?? choice.model, local: choice.local });
    return {
      brain: withToolFallback(provider, { key: `${choice.baseUrl}|${choice.model}` }),
      problem: apiKey === null && !choice.local ? "No key is set for this model. Add one in Settings, Voice." : null,
    };
  }
  if (choice.kind === "anthropic") {
    const apiKey = deps.keyFor(choice);
    const provider = new AnthropicProvider({ baseUrl: choice.baseUrl, model: choice.model, apiKey, label: choice.label ?? choice.model, local: choice.local });
    return {
      brain: withToolFallback(provider, { key: `anthropic:${choice.baseUrl}|${choice.model}` }),
      problem: apiKey === null && !choice.local ? "No key is set for this model. Add one in Settings, Voice." : null,
    };
  }
  if (choice.kind === "google") {
    const apiKey = deps.keyFor(choice);
    const provider = new GoogleGenAiProvider({ baseUrl: choice.baseUrl, model: choice.model, apiKey, label: choice.label ?? choice.model, local: choice.local });
    return {
      brain: withToolFallback(provider, { key: `google:${choice.baseUrl}|${choice.model}` }),
      problem: apiKey === null && !choice.local ? "No key is set for this model. Add one in Settings, Voice." : null,
    };
  }
  if (choice.kind === "muse") {
    if (deps.muse) return { brain: deps.muse(context), problem: null };
    const accountId = choice.accountId ?? null;
    const who = deps.providerName?.("muse", accountId) ?? "Muse";
    if (!deps.museHost) return { brain: new StaticBrain(`I cannot reach ${who} from here. Choose another model in the voice settings.`), problem: `${who} is not available here.` };
    if (!context.project) {
      return { brain: new StaticBrain(`${who} needs a project to think in, and none is open. Open a project in Ancilla, or choose another model in the voice settings.`), problem: `${who} needs a project: open one in Ancilla.` };
    }
    // Muse has no tool calling of its own to offer a call, so its tools are asked for in its text.
    const thread = new MuseThreadBrain({
      host: deps.museHost,
      cwd: context.project,
      account: accountId,
      providerId: "muse",
      providerLabel: who,
      title: `Voice with ${context.name}`,
      sessionId: context.museSession,
      onSession: context.rememberMuseSession,
      model: choice.model,
    });
    return { brain: withTextTools(thread), problem: null };
  }
  if (choice.kind === "provider") {
    if (choice.providerId === "api") {
      return makeApiAccountBrain(
        choice.accountId,
        choice.model,
        deps.resolveApiAccount,
        "No API key is set for {label}. Add one in Settings, Providers.",
      );
    }
    if (choice.providerId === "muse" && deps.muse) return { brain: deps.muse(context), problem: null };
    const who = deps.providerName?.(choice.providerId, choice.accountId) ?? choice.providerId;
    if (!deps.museHost) {
      return {
        brain: new StaticBrain(`I cannot reach ${who} from here. Choose another model in the voice settings.`),
        problem: `${who} is not available here.`,
      };
    }
    if (!context.project) {
      return {
        brain: new StaticBrain(`${who} needs a project to think in, and none is open. Open a project in Ancilla, or choose another model in the voice settings.`),
        problem: `${who} needs a project: open one in Ancilla.`,
      };
    }
    const thread = new MuseThreadBrain({
      host: deps.museHost,
      cwd: context.project,
      account: choice.accountId,
      providerId: choice.providerId,
      providerLabel: who,
      title: `Voice with ${context.name}`,
      sessionId: context.museSession,
      onSession: context.rememberMuseSession,
      model: choice.model,
    });
    return { brain: withTextTools(thread), problem: null };
  }
  return { brain: new StaticBrain("No model is set up for the voice yet. Open the voice settings and choose one."), problem: "No model is chosen." };
}

/** Runs one `muse exec` the way the server does every one-shot Muse call: its binary, WSL routing and account. */
export type MuseExecRunner = (args: string[], limits: { timeoutMs: number; signal: AbortSignal }, accountId?: string | null) => Promise<ExecResult>;

export interface BrowseBrainDeps {
  keyFor: (brain: BrainSetting) => string | null;
  /** Absent where there is no Muse to run. */
  museExec: MuseExecRunner | null;
  resolveApiAccount?: (accountId: string | null) => ResolvedApiAccount | null;
  providerName?: (providerId: string, accountId: string | null) => string;
  log: (line: string) => void;
}

/**
 * The model that browses for the assistant: the one chosen for the voice, but used only to answer in text. A server that takes
 * tools gets the browser's; Muse is run as `muse exec` with no tools of its own (see browser/muse-brain.ts), because a Muse thread
 * can read the person's files and the pages it reads are written by strangers.
 */
export function makeBrowseBrain(settings: VoiceSettings, deps: BrowseBrainDeps): ChosenBrain {
  const choice = settings.brain;
  if (choice.kind === "openai") {
    const apiKey = deps.keyFor(choice);
    const provider = new OpenAiCompatibleProvider({ baseUrl: choice.baseUrl, model: choice.model, apiKey, label: choice.label ?? choice.model, local: choice.local });
    return {
      brain: withToolFallback(provider, { key: `${choice.baseUrl}|${choice.model}` }),
      problem: apiKey === null && !choice.local ? "No key is set for the model that browses. Add one in Settings, Voice." : null,
    };
  }
  if (choice.kind === "anthropic") {
    const apiKey = deps.keyFor(choice);
    const provider = new AnthropicProvider({ baseUrl: choice.baseUrl, model: choice.model, apiKey, label: choice.label ?? choice.model, local: choice.local });
    return {
      brain: withToolFallback(provider, { key: `anthropic:${choice.baseUrl}|${choice.model}` }),
      problem: apiKey === null && !choice.local ? "No key is set for the model that browses. Add one in Settings, Voice." : null,
    };
  }
  if (choice.kind === "google") {
    const apiKey = deps.keyFor(choice);
    const provider = new GoogleGenAiProvider({ baseUrl: choice.baseUrl, model: choice.model, apiKey, label: choice.label ?? choice.model, local: choice.local });
    return {
      brain: withToolFallback(provider, { key: `google:${choice.baseUrl}|${choice.model}` }),
      problem: apiKey === null && !choice.local ? "No key is set for the model that browses. Add one in Settings, Voice." : null,
    };
  }
  if (choice.kind === "muse") {
    if (!deps.museExec) return { brain: new StaticBrain("Muse is not available here."), problem: "Muse is not available here, so it cannot browse. Choose another model in the voice settings." };
    const accountId = choice.accountId ?? null;
    return {
      brain: withTextTools(new MuseExecBrain({ run: (args, limits) => deps.museExec!(args, limits, accountId), model: choice.model, log: deps.log })),
      problem: null,
    };
  }
  if (choice.kind === "provider") {
    if (choice.providerId === "api") {
      return makeApiAccountBrain(
        choice.accountId,
        choice.model,
        deps.resolveApiAccount,
        "No API key is set for {label}. Add one in Settings, Providers.",
      );
    }
    if (choice.providerId === "muse") {
      if (!deps.museExec) return { brain: new StaticBrain("Muse is not available here."), problem: "Muse is not available here, so it cannot browse. Choose another model in the voice settings." };
      return {
        brain: withTextTools(new MuseExecBrain({ run: (args, limits) => deps.museExec!(args, limits, choice.accountId), model: choice.model, log: deps.log })),
        problem: null,
      };
    }
    const who = deps.providerName?.(choice.providerId, choice.accountId) ?? choice.providerId;
    return {
      brain: new StaticBrain(`${who} cannot browse untrusted web pages without a sandboxed text-only mode.`),
      problem: `${who} answers voice calls, while web browsing needs Muse, an API provider, or a custom endpoint.`,
    };
  }
  return { brain: new StaticBrain("No model is set up yet."), problem: "No model is chosen for the assistant. Open the voice settings and choose one." };
}
