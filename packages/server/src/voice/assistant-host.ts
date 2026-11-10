import type { AssistantService } from "../assistant/service.js";
import { awaitsApproval, type Task } from "../assistant/tasks.js";
import { waitingCause } from "../assistant/waiting.js";
import { VOICES } from "../assistant/context.js";
import type { ChatMessage, ToolCall, ToolSpec } from "./brain.js";
import type { ConversationStore } from "./conversations.js";
import type { HostEvent, Persona, ToolResult, TranscriptEntry, VoiceHost } from "./host.js";
import { openingPhrase, taskPhrase, type TaskNotice } from "./prompt.js";
import type { VoiceSettings } from "./settings.js";
import { guessLanguage, type Lang } from "./text.js";
import { ambientDigest, HARNESS_TOOL_NAMES, HarnessTools, type HarnessReader } from "./harness.js";
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
  // Whether a task waits on the person is `waitingCause`'s to say: here, on the screens and in the notifications alike.
  if (waitingCause(task, null)) return "needs";
  switch (task.status) {
    case "completed":
      return "done";
    case "unverified":
      return "unverified";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
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
  /** The harness the call may look at (read only), when the server gives one. */
  harness?: HarnessReader | null;
  /** The assistant's own browser, when the server has one: it is what lets the call offer `browse`. */
  browse?: { available(): Promise<{ ok: boolean; reason?: string }> };
  log: (line: string) => void;
}

export class AssistantVoiceHost implements VoiceHost {
  private userLang: Lang = "unknown";
  /** The last state each task was told in, so a state is said once and never twice. */
  private readonly told = new Map<string, string>();
  private readonly voiceTools: VoiceTools;
  private readonly harnessTools: HarnessTools | null;

  constructor(private readonly deps: AssistantVoiceHostDeps) {
    this.voiceTools = new VoiceTools({ assistant: deps.assistant, project: deps.project, lang: () => this.lang(), conversationId: deps.conversationId, ...(deps.browse ? { browse: deps.browse } : {}) });
    this.harnessTools = deps.harness ? new HarnessTools({ reader: deps.harness, taskCounts: () => this.taskCounts() }) : null;
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
      const prefix = (await this.deps.assistant.prepareTurnAsync({ sessionId: this.deps.conversationId, text, project: null, account: null }, { timeoutMs: VOICE_MEANING_TIMEOUT_MS })).prefix;
      return this.withRightNow(prefix);
    } catch (error) {
      this.deps.log(`voice: the notes for a turn could not be chosen: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private taskCounts(): { active: number; waiting: number } {
    const active = this.deps.assistant.tasks.list("active", 50);
    return { active: active.length, waiting: active.filter((t) => noticeOf(t) === "needs").length };
  }

  /** The "Right now" block joined to the notes of a turn, so a question about what is going on needs no tool call. */
  private withRightNow(prefix: string | null): string | null {
    let block: string | null = null;
    try {
      block = this.deps.harness ? ambientDigest(this.deps.harness, this.taskCounts(), Date.now()) : null;
    } catch (error) {
      this.deps.log(`voice: the harness digest could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parts = [prefix, block].filter((p): p is string => typeof p === "string" && p !== "");
    return parts.length === 0 ? null : parts.join("\n\n");
  }

  record(entry: TranscriptEntry): void {
    try {
      this.deps.conversations.append(this.deps.conversationId, entry);
    } catch (error) {
      this.deps.log(`voice: a line of the conversation could not be kept: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  tools(): ToolSpec[] {
    return this.harnessTools ? [...this.voiceTools.specs(), ...this.harnessTools.specs()] : this.voiceTools.specs();
  }

  runTool(call: ToolCall, _context: { turn: number; signal: AbortSignal }): Promise<ToolResult> {
    if (this.harnessTools && HARNESS_TOOL_NAMES.has(call.name)) return this.harnessTools.run(call);
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
      // A proposal made in this call was said by the tool that made it, so its event goes out without saying it again.
      const said = awaitsApproval(task) && task.updatedAt === task.createdAt;
      handler({
        id: task.id,
        kind: "task",
        title: task.title,
        status: task.status,
        say: this.deps.settings().proactive && !said ? taskPhrase(this.lang(), notice, task.title) : null,
        needsUser,
      });
    });
  }

  history(thread: string | null): ChatMessage[] {
    const messages = this.deps.conversations.history(thread ?? this.deps.conversationId);
    // A conversation goes on in the language it was in, so that what is said before anyone speaks is too.
    if (this.userLang === "unknown") {
      const last = [...messages].reverse().find((m) => m.role === "user");
      const guess = last ? guessLanguage(last.content) : "unknown";
      if (guess !== "unknown") this.userLang = guess;
    }
    return messages;
  }

  /**
   * What is worth saying as a call opens: work that finished, failed or waits on the person since they last talked (or, if
   * they never have, only what waits on them). The first two, then how many more. Null when there is none, or when they
   * asked for nothing unprompted.
   */
  opening(): string | null {
    if (!this.deps.settings().proactive) return null;
    const { assistant, conversations } = this.deps;
    // When they last talked: the latest conversation with anything in it (a new one for this call has nothing yet).
    const last = conversations.list(5).find((c) => c.turns > 0)?.updatedAt ?? null;
    const rank: Record<string, number> = { needs: 0, failed: 1, unverified: 2, done: 3 };
    const news = assistant.tasks
      .list("all", 50)
      .map((task) => ({ task, notice: noticeOf(task) }))
      .filter((n): n is { task: Task; notice: TaskNotice } => n.notice !== null && n.notice in rank && (last === null ? n.notice === "needs" : n.task.updatedAt > last))
      .sort((a, b) => (rank[a.notice] as number) - (rank[b.notice] as number) || b.task.updatedAt - a.task.updatedAt);
    if (news.length === 0) return null;
    return openingPhrase(this.lang(), news.slice(0, 2).map((n) => ({ notice: n.notice, title: n.task.title })), news.length - 2);
  }
}
