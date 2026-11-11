import type { AuthorizationHub, PendingAuthorizationView } from "../assistant/launcher.js";
import type { AssistantService } from "../assistant/service.js";
import { awaitsApproval, TERMINAL_TASK, type Task } from "../assistant/tasks.js";
import { waitingCause } from "../assistant/waiting.js";
import { VOICES } from "../assistant/context.js";
import type { ChatMessage, ToolCall, ToolSpec } from "./brain.js";
import type { ConversationStore } from "./conversations.js";
import type { HostEvent, Persona, ToolResult, TranscriptEntry, VoiceHost } from "./host.js";
import { openingPhrase, sayable, spokenTaskGist, taskMilestonePhrase, taskUpdatePhrase, type TaskNotice } from "./prompt.js";
import type { CallApproval } from "./protocol.js";
import type { VoiceSettings } from "./settings.js";
import { guessLanguage, type Lang } from "./text.js";
import { ambientDigest, HARNESS_TOOL_NAMES, HarnessTools, type HarnessReader } from "./harness.js";
import { VoiceTools, type VoiceConnectors } from "./tools.js";
import { WORKSPACE_TOOL_NAMES, WorkspaceVoiceTools, type WorkspaceVoiceDeps } from "./workspace-tools.js";

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
export function noticeOf(task: Task, needsUser: ((sessionId: string) => boolean) | null = null): TaskNotice | null {
  // Whether a task waits on the person is `waitingCause`'s to say: here, on the screens and in the notifications alike.
  if (waitingCause(task, null, needsUser)) return "needs";
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
  /** The connected accounts, when the server has any: it is what lets the call offer `use_connector`. */
  connectors?: VoiceConnectors;
  /** Workspace inspection, authorized process/URL launching, and live page/animation diagnostics. */
  workspace?: WorkspaceVoiceDeps | null;
  /** True when global user pre-authorization (such as YOLO mode) permits immediate execution of proposals. */
  isPreAuthorized?: () => boolean;
  /** Shared user authorization hub for inline call-card prompts. */
  authorizations?: AuthorizationHub | null;
  log: (line: string) => void;
}

function toCallApproval(view: PendingAuthorizationView | null): CallApproval | null {
  if (!view) return null;
  return {
    id: view.id,
    kind: view.kind,
    title: view.title,
    detail: view.detail,
    allowLabel: view.allowLabel,
    denyLabel: view.denyLabel,
  };
}

export class AssistantVoiceHost implements VoiceHost {
  private userLang: Lang = "unknown";
  /** The last spoken notice/milestone each task announced, so a milestone or outcome is said once and never twice. */
  private readonly told = new Map<string, string>();
  /** The last visual status + note pushed to the call card for each task. */
  private readonly shown = new Map<string, string>();
  private readonly voiceTools: VoiceTools;
  private readonly harnessTools: HarnessTools | null;
  private readonly workspaceTools: WorkspaceVoiceTools | null;
  private readonly authHub: AuthorizationHub | null;

  constructor(private readonly deps: AssistantVoiceHostDeps) {
    this.authHub = deps.authorizations ?? deps.workspace?.authorizations ?? null;
    this.workspaceTools = deps.workspace ? new WorkspaceVoiceTools(deps.workspace) : null;
    this.voiceTools = new VoiceTools({
      assistant: deps.assistant,
      project: deps.project,
      ...(this.workspaceTools ? { resolveProject: (name?: string | null) => this.workspaceTools?.resolveProject(name)?.cwd ?? null } : {}),
      ...(deps.isPreAuthorized
        ? { isPreAuthorized: deps.isPreAuthorized }
        : deps.workspace
          ? { isPreAuthorized: deps.workspace.isPreAuthorized }
          : {}),
      ...(this.authHub ? { authorizations: this.authHub } : {}),
      lang: () => this.lang(),
      conversationId: deps.conversationId,
      ...(deps.browse ? { browse: deps.browse } : {}),
      ...(deps.connectors ? { connectors: deps.connectors } : {}),
    });
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

  private readonly needsSessionUser = (sessionId: string): boolean => this.deps.assistant.sessionNeedsUser(sessionId);

  private taskCounts(): { active: number; waiting: number } {
    const active = this.deps.assistant.tasks.list("active", 50);
    return { active: active.length, waiting: active.filter((t) => noticeOf(t, this.needsSessionUser) === "needs").length };
  }

  private taskView(task: Task): {
    status: string;
    note: string | null;
    needsUser: boolean;
    notice: TaskNotice | null;
    causeCode: string | null;
    causeReason: string | null;
  } {
    const cause = waitingCause(task, null, this.needsSessionUser);
    const notice = cause ? "needs" : noticeOf(task, this.needsSessionUser);
    const needsUser = notice === "needs";
    const status = needsUser && task.status === "running" ? "paused" : task.status;
    const causeReason = cause
      ? task.status === "running" && cause === "approval"
        ? "Waiting for your approval in the task thread."
        : task.reason
      : null;
    let note: string | null = null;
    if (causeReason) {
      note = causeReason.slice(0, 140);
    } else if (task.status === "completed" || task.status === "unverified") {
      note = spokenTaskGist(task.result, 120) ?? (task.status === "completed" ? "Done" : "Finished");
    } else if (task.reason) {
      note = task.reason.slice(0, 140);
    }
    return {
      status,
      note,
      needsUser,
      notice,
      causeCode: cause,
      causeReason,
    };
  }

  private tasksDigest(): string | null {
    const all = this.deps.assistant.tasks.list("all", 12);
    if (all.length === 0) return null;
    const now = this.deps.assistant.store.now();
    const active = all.filter((t) => !TERMINAL_TASK.has(t.status));
    const recentDone = all
      .filter((t) => TERMINAL_TASK.has(t.status) && t.status !== "cancelled" && now - t.updatedAt <= 5 * 60_000)
      .slice(0, 3);
    if (active.length === 0 && recentDone.length === 0) return null;
    const lines: string[] = ["Background tasks:"];
    for (const t of active.slice(0, 5)) {
      const v = this.taskView(t);
      lines.push(`- ${t.id} "${sayable(t.title, 60)}" [${v.status}]${v.note ? `: ${v.note}` : ""}`);
    }
    if (active.length > 5) lines.push(`- and ${active.length - 5} more active tasks.`);
    for (const t of recentDone) {
      const gist = spokenTaskGist(t.result, 100);
      lines.push(`- ${t.id} "${sayable(t.title, 60)}" [${t.status}]${gist ? `: ${gist}` : ""}`);
    }
    return lines.join("\n");
  }

  /** The "Right now" block joined to the notes of a turn, so a question about what is going on needs no tool call. */
  private withRightNow(prefix: string | null): string | null {
    let block: string | null = null;
    try {
      block = this.deps.harness ? ambientDigest(this.deps.harness, this.taskCounts(), Date.now()) : null;
    } catch (error) {
      this.deps.log(`voice: the harness digest could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
    let tasksBlock: string | null = null;
    try {
      tasksBlock = this.tasksDigest();
    } catch (error) {
      this.deps.log(`voice: the tasks digest could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parts = [prefix, block, tasksBlock].filter((p): p is string => typeof p === "string" && p !== "");
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
    return [
      ...this.voiceTools.specs(),
      ...(this.harnessTools ? this.harnessTools.specs() : []),
      ...(this.workspaceTools ? this.workspaceTools.specs() : []),
    ];
  }

  runTool(call: ToolCall, context: { turn: number; signal: AbortSignal }): Promise<ToolResult> {
    if (this.harnessTools && HARNESS_TOOL_NAMES.has(call.name)) return this.harnessTools.run(call);
    if (this.workspaceTools && WORKSPACE_TOOL_NAMES.has(call.name)) return this.workspaceTools.run(call, context.turn);
    return this.voiceTools.run(call, context.turn);
  }

  pendingApproval(): PendingAuthorizationView | null {
    return this.authHub?.current() ?? null;
  }

  async decideApproval(id: string, allow: boolean): Promise<{ ok: boolean; message: string }> {
    if (!this.authHub) return { ok: false, message: "No authorization hub is active." };
    return await this.authHub.decide(id, allow);
  }

  subscribeApprovals(handler: (request: CallApproval | null) => void): () => void {
    if (!this.authHub) return () => undefined;
    return this.authHub.subscribe((current) => handler(toCallApproval(current)));
  }

  activeTasks(): HostEvent[] {
    return this.deps.assistant.tasks.list("active", 12).map((task) => {
      const v = this.taskView(task);
      this.shown.set(task.id, `${v.status}|${v.note ?? ""}`);
      return {
        id: task.id,
        kind: "task",
        title: task.title,
        status: v.status,
        note: v.note,
        say: null,
        needsUser: v.needsUser,
      };
    });
  }

  subscribe(handler: (event: HostEvent) => void): () => void {
    return this.deps.hub.subscribe(({ taskId }) => {
      const task = this.deps.assistant.tasks.get(taskId);
      if (!task) return;
      const v = this.taskView(task);
      const proactive = this.deps.settings().proactive;
      let say: string | null = null;

      if (v.notice !== null) {
        const sayKey = v.notice === "needs" ? `needs:${v.causeCode ?? task.status}` : v.notice;
        const justProposed = awaitsApproval(task) && task.updatedAt === task.createdAt;
        if (justProposed) {
          this.told.set(task.id, sayKey);
        } else if (this.told.get(task.id) !== sayKey) {
          this.told.set(task.id, sayKey);
          if (proactive) {
            say = taskUpdatePhrase(this.lang(), v.notice, task.title, {
              result: task.result,
              reason: v.causeReason ?? task.reason,
            });
          }
        }
      } else {
        const prevTold = this.told.get(task.id);
        if (prevTold?.startsWith("needs:") || prevTold === "paused") {
          this.told.delete(task.id);
        }
        if (task.status === "running") {
          if (task.progress.total > 1 && task.progress.done > 0 && task.progress.done < task.progress.total) {
            const stepKey = `step:${task.progress.done}/${task.progress.total}`;
            if (this.told.get(task.id) !== stepKey) {
              this.told.set(task.id, stepKey);
              if (proactive) {
                const stepMatch = /^Step \d+ of \d+:\s*(.+)$/.exec(task.reason);
                const nextTitle = stepMatch?.[1]?.trim();
                say = taskMilestonePhrase(this.lang(), task.title, {
                  kind: "step",
                  done: task.progress.done,
                  total: task.progress.total,
                  ...(nextTitle ? { nextTitle } : {}),
                });
              }
            }
          } else {
            const goalMatch = /^(\d{1,3})%\s*[—-]\s*(.+)$/.exec(task.reason);
            if (goalMatch) {
              const pct = Number(goalMatch[1]);
              const detail = goalMatch[2]?.trim() ?? "";
              if (pct >= 50 && pct < 100 && detail !== "" && !this.told.get(task.id)?.startsWith("goal:")) {
                this.told.set(task.id, "goal:50");
                if (proactive) {
                  say = taskMilestonePhrase(this.lang(), task.title, { kind: "progress", percent: pct, detail });
                }
              }
            }
          }
        }
      }

      const visualKey = `${v.status}|${v.note ?? ""}`;
      if (say === null && this.shown.get(task.id) === visualKey) return;
      this.shown.set(task.id, visualKey);
      handler({
        id: task.id,
        kind: "task",
        title: task.title,
        status: v.status,
        note: v.note,
        say,
        needsUser: v.needsUser,
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
      .map((task) => ({ task, notice: noticeOf(task, this.needsSessionUser) }))
      .filter((n): n is { task: Task; notice: TaskNotice } => n.notice !== null && n.notice in rank && (last === null ? n.notice === "needs" : n.task.updatedAt > last))
      .sort((a, b) => (rank[a.notice] as number) - (rank[b.notice] as number) || b.task.updatedAt - a.task.updatedAt);
    if (news.length === 0) return null;
    return openingPhrase(this.lang(), news.slice(0, 2).map((n) => ({ notice: n.notice, title: n.task.title })), news.length - 2);
  }
}
