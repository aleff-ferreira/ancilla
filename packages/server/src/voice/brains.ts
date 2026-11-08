import { OpenAiCompatibleProvider, withTextTools, type BrainEvent, type BrainProvider, type BrainRequest } from "./brain.js";
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

export interface BrainFactoryDeps {
  /** What a Muse thread needs of the server; absent where there is no Muse host to think in. */
  museHost: MuseBrainHost | null;
  /** For tests: a model that stands in for Muse. */
  muse?: ((context: BrainContext) => BrainProvider) | null;
  keyFor: (brain: BrainSetting) => string | null;
}

export interface ChosenBrain {
  brain: BrainProvider;
  /** Why it is not the model the settings ask for, or null when it is. */
  problem: string | null;
}

export const NO_BRAIN_CONTEXT: BrainContext = { project: null, name: "Assistant", museSession: null, rememberMuseSession: () => undefined };

export function makeBrain(settings: VoiceSettings, context: BrainContext, deps: BrainFactoryDeps): ChosenBrain {
  const choice = settings.brain;
  if (choice.kind === "openai") {
    const apiKey = deps.keyFor(choice);
    return {
      brain: new OpenAiCompatibleProvider({ baseUrl: choice.baseUrl, model: choice.model, apiKey, label: choice.label ?? choice.model, local: choice.local }),
      problem: apiKey === null && !choice.local ? "No key is set for this model. Add one in Settings, Voice." : null,
    };
  }
  if (choice.kind === "muse") {
    if (deps.muse) return { brain: deps.muse(context), problem: null };
    if (!deps.museHost) return { brain: new StaticBrain("I cannot reach Muse from here. Choose another model in the voice settings."), problem: "Muse is not available here." };
    if (!context.project) {
      return { brain: new StaticBrain("Muse needs a project to think in, and none is open. Open a project in Ancilla, or choose another model in the voice settings."), problem: "Muse needs a project: open one in Ancilla." };
    }
    // Muse has no tool calling of its own to offer a call, so its tools are asked for in its text.
    const thread = new MuseThreadBrain({ host: deps.museHost, cwd: context.project, title: `Voice with ${context.name}`, sessionId: context.museSession, onSession: context.rememberMuseSession });
    return { brain: withTextTools(thread), problem: null };
  }
  return { brain: new StaticBrain("No model is set up for the voice yet. Open the voice settings and choose one."), problem: "No model is chosen." };
}
