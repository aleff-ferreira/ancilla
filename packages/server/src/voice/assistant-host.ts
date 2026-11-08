import type { AssistantService } from "../assistant/service.js";
import type { Task } from "../assistant/tasks.js";
import { VOICES } from "../assistant/context.js";
import type { ChatMessage, ToolCall, ToolSpec } from "./brain.js";
import type { ConversationStore } from "./conversations.js";
import type { HostEvent, Persona, ToolResult, TranscriptEntry, VoiceHost } from "./host.js";
import { taskPhrase, type TaskNotice } from "./prompt.js";
import type { VoiceSettings } from "./settings.js";
import { guessLanguage, type Lang } from "./text.js";
import { VoiceTools } from "./tools.js";

/**
 * A call's view of Ancilla, built from the assistant: its character and notes, the conversation it keeps, the tasks it
 * runs and tells the person about. The call itself knows none of this; it is handed this object and nothing else.
 */

/** How long a spoken turn waits for the vector of what was said, to find notes by meaning, before it goes on with words. */
const VOICE_MEANING_TIMEOUT_MS = 250;

export interface TaskChange {
  taskId: string;
}

/** Tells every open call that a task changed. One of these is shared by the server. */
export class TaskHub {
  private readonly listeners = new Set<(change: TaskChange) => void>();

  subscribe(listener: (change: TaskChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change: TaskChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        /* a listener that throws must not stop the others */
      }
    }
  }
}

/** What is worth saying about a task now, or null when its state is not news. */
export function noticeOf(task: Task): TaskNotice | null {
  switch (task.status) {
    case "completed":
      return "done";
    case "unverified":
      return "unverified";
    case "failed":
      return "failed";
    case "blocked":
      return "needs";
    case "cancelled":
      return "cancelled";
    case "paused":
      return /approval|approve|needs you|waiting for you/i.test(task.reason) ? "needs" : null;
    default:
      return null;
  }
}

export interface AssistantVoiceHostDeps {
  assistant: AssistantService;
  conversations: ConversationStore;
  conversationId: string;
  settings: () => VoiceSettings;
  hub: TaskHub;
  /** The folder a spoken task is started in. */
  project: () => string | null;
  log: (line: string) => void;
}

export class AssistantVoiceHost implements VoiceHost {
  private userLang: Lang = "unknown";
  /** The last state each task was told in, so a state is said once and never twice. */
  private readonly told = new Map<string, string>();
  private readonly voiceTools: VoiceTools;

  constructor(private readonly deps: AssistantVoiceHostDeps) {
    this.voiceTools = new VoiceTools({ assistant: deps.assistant, project: deps.project, lang: () => this.lang(), conversationId: deps.conversationId });
  }

  private lang(): Lang {
    const forced = this.persona().language;
    if (forced) return forced.toLowerCase().startsWith("pt") ? "pt" : "en";
    return this.userLang;
  }

  persona(): Persona {
    const profile = this.deps.assistant.store.getProfile();
    const character = profile.character;
    const archetype = VOICES[character.voice.archetype];
    const language = profile.communication.language.trim();
    return {
      name: profile.name,
      callsUser: character.callsUser.trim() === "" ? null : character.callsUser.trim(),
      language: language === "" ? null : language,
      tone: character.setupAt !== null && character.presence !== "off" && archetype.tone !== "" ? archetype.tone : null,
      voice: this.deps.settings().voice,
    };
  }

  async context(text: string, _source: "voice" | "text"): Promise<string | null> {
    const guess = guessLanguage(text);
    if (guess !== "unknown") this.userLang = guess;
    try {
      // Meaning search is given a short wait: a call is about the next half second, and the words decide when it is late.
      return (await this.deps.assistant.prepareTurnAsync({ sessionId: this.deps.conversationId, text, project: null, account: null }, { timeoutMs: VOICE_MEANING_TIMEOUT_MS })).prefix;
    } catch (error) {
      this.deps.log(`voice: the notes for a turn could not be chosen: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  record(entry: TranscriptEntry): void {
    try {
      this.deps.conversations.append(this.deps.conversationId, entry);
    } catch (error) {
      this.deps.log(`voice: a line of the conversation could not be kept: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  tools(): ToolSpec[] {
    return this.voiceTools.specs();
  }

  runTool(call: ToolCall, _context: { turn: number; signal: AbortSignal }): Promise<ToolResult> {
    return this.voiceTools.run(call);
  }

  subscribe(handler: (event: HostEvent) => void): () => void {
    return this.deps.hub.subscribe(({ taskId }) => {
      const task = this.deps.assistant.tasks.get(taskId);
      if (!task) return;
      const notice = noticeOf(task);
      const key = `${task.status}:${task.updatedAt}`;
      if (notice === null) return;
      if (this.told.get(task.id)?.startsWith(`${task.status}:`)) return;
      this.told.set(task.id, key);
      const needsUser = notice === "needs";
      handler({
        id: task.id,
        kind: "task",
        title: task.title,
        status: task.status,
        say: this.deps.settings().proactive ? taskPhrase(this.lang(), notice, task.title) : null,
        needsUser,
      });
    });
  }

  history(thread: string | null): ChatMessage[] {
    return this.deps.conversations.history(thread ?? this.deps.conversationId);
  }
}
