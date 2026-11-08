import type { AssistantService } from "../assistant/service.js";
import type { Task } from "../assistant/tasks.js";
import { parseTaskSpec, TERMINAL_TASK } from "../assistant/tasks.js";
import { ConflictError, NotFoundError, ValidationError } from "../assistant/store.js";
import type { ToolCall, ToolSpec } from "./brain.js";
import type { ToolResult } from "./host.js";
import { sayable, taskPhrase } from "./prompt.js";
import type { Lang } from "./text.js";

/**
 * What the voice can do beyond talking: start work in the background, look at it, and change its course while it goes on.
 * Every tool is a small, checked operation on the task executive or on the notes. None of them can approve anything or
 * change a file: a task started by voice reads and researches only, so a spoken sentence (which may have been misheard,
 * or may not have been the user's at all) can never be what lets something be altered. Work that would change something
 * is proposed, and the approval is a click on the screen.
 */

export interface VoiceToolDeps {
  assistant: AssistantService;
  /** The folder a spoken task runs in, or null when none is known. */
  project: () => string | null;
  /** The language of the call, for what is said back. */
  lang: () => Lang;
  /** The conversation, to look notes up in its scope. */
  conversationId: string;
}

export const VOICE_TOOLS: readonly ToolSpec[] = [
  {
    name: "delegate_task",
    description:
      "Start a task in the background and carry on talking. Use it for work that takes more than a few seconds: reading a codebase, researching, summarising files, checking something. The task can read and research only; it cannot change files. When the user wants a change made, say so and give the goal as a proposal.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the task is to find out or produce, in a sentence or two, complete enough to be understood on its own." },
        title: { type: "string", description: "A short name for it, a few words." },
      },
      required: ["goal"],
    },
  },
  {
    name: "list_tasks",
    description: "List the user's tasks: what is running, what waits for them, what finished lately.",
    parameters: { type: "object", properties: { filter: { type: "string", enum: ["active", "done", "all"] } } },
  },
  {
    name: "task_status",
    description: "How one task is going, and its result when it is done. The id may be an id from list_tasks, or \"last\" for the newest.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "pause_task",
    description: "Stop a task from starting new work. What is running finishes first.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "resume_task",
    description: "Let a paused task go on.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "cancel_task",
    description: "Stop a task for good. Ask the user first unless they just told you to.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "recall",
    description: "Look up what is remembered about the user, their projects and their goals, when the notes you were given do not cover a question.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const raw = JSON.parse(call.arguments === "" ? "{}" : call.arguments) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function describe(task: Task): string {
  const progress = task.progress.total > 0 ? `, ${task.progress.done} of ${task.progress.total} steps` : "";
  return `${task.id} | ${task.status} | ${sayable(task.title, 80)}${progress}${task.reason ? ` | ${task.reason.slice(0, 120)}` : ""}`;
}

export class VoiceTools {
  constructor(private readonly deps: VoiceToolDeps) {}

  specs(): ToolSpec[] {
    // Without the executive (no host to run tasks on) the task tools are not offered, so the model never promises what it cannot do.
    return this.deps.assistant.executive ? [...VOICE_TOOLS] : VOICE_TOOLS.filter((t) => t.name === "recall");
  }

  private find(id: string): Task {
    const tasks = this.deps.assistant.tasks;
    if (id === "" || id === "last" || id === "latest") {
      const newest = tasks.list("all", 1)[0];
      if (!newest) throw new NotFoundError("Any task");
      return newest;
    }
    const exact = tasks.get(id);
    if (exact) return exact;
    const matches = tasks.list("all", 200).filter((t) => t.id.startsWith(id) || t.id.endsWith(id));
    if (matches.length === 1) return matches[0] as Task;
    if (matches.length > 1) throw new ConflictError("More than one task fits that. Use the full id from list_tasks.");
    throw new NotFoundError("That task");
  }

  async run(call: ToolCall): Promise<ToolResult> {
    const args = parseArgs(call);
    const { assistant } = this.deps;
    const executive = assistant.executive;
    const lang = this.deps.lang();
    try {
      switch (call.name) {
        case "delegate_task": {
          if (!executive) return { ok: false, text: "Background tasks are not available right now." };
          const goal = str(args["goal"], 2000);
          if (goal === "") return { ok: false, text: "A task needs a goal: say what it is to find out or produce." };
          const cwd = this.deps.project();
          if (!cwd) return { ok: false, text: "I do not know which project to work in. Ask the user to open a project in Ancilla, or to name one." };
          const spec = parseTaskSpec({ goal, cwd, ...(str(args["title"], 120) ? { title: str(args["title"], 120) } : {}) }, assistant.store.getProfile(), (c) => assistant.projectKey(c));
          const task = executive.create({ ...spec, origin: "user" });
          return {
            ok: true,
            text: `Started task ${task.id}, "${sayable(task.title, 80)}". It reads and researches in the background and cannot change files. The user is told when it finishes or needs them.`,
            narration: taskPhrase(lang, "started", task.title),
          };
        }
        case "list_tasks": {
          const filter = args["filter"] === "done" ? "done" : args["filter"] === "all" ? "all" : "active";
          const tasks = assistant.tasks.list(filter, 12);
          return { ok: true, text: tasks.length === 0 ? `There are no ${filter === "all" ? "" : `${filter} `}tasks.` : tasks.map(describe).join("\n") };
        }
        case "task_status": {
          const task = this.find(str(args["id"], 80));
          const tail = TERMINAL_TASK.has(task.status) && task.result ? `\nResult: ${task.result.slice(0, 900)}` : "";
          return { ok: true, text: `${describe(task)}${tail}` };
        }
        case "pause_task": {
          if (!executive) return { ok: false, text: "Background tasks are not available right now." };
          const task = executive.pause(this.find(str(args["id"], 80)).id);
          return { ok: true, text: `Paused: ${describe(task)}` };
        }
        case "resume_task": {
          if (!executive) return { ok: false, text: "Background tasks are not available right now." };
          const task = executive.resume(this.find(str(args["id"], 80)).id);
          return { ok: true, text: `Resumed: ${describe(task)}` };
        }
        case "cancel_task": {
          if (!executive) return { ok: false, text: "Background tasks are not available right now." };
          const task = await executive.cancel(this.find(str(args["id"], 80)).id, "Cancelled by voice.");
          return { ok: true, text: `Cancelled: ${describe(task)}` };
        }
        case "recall": {
          const query = str(args["query"], 400);
          if (query === "") return { ok: false, text: "Say what to look up." };
          const found = assistant.preview({ sessionId: this.deps.conversationId, text: query, project: null, account: null });
          return { ok: true, text: found.memories.length === 0 ? "Nothing is remembered about that." : found.text };
        }
        default:
          return { ok: false, text: `There is no tool called ${call.name}.` };
      }
    } catch (error) {
      if (error instanceof ValidationError || error instanceof ConflictError || error instanceof NotFoundError) return { ok: false, text: error.message };
      return { ok: false, text: `That did not work: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
