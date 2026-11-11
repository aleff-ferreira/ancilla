import { homedir } from "node:os";
import type { AuthorizationHub } from "../assistant/launcher.js";
import type { AssistantService } from "../assistant/service.js";
import type { Task } from "../assistant/tasks.js";
import { awaitsApproval, parseTaskSpec, TERMINAL_TASK } from "../assistant/tasks.js";
import { ConflictError, NotFoundError, ValidationError } from "../assistant/store.js";
import { isRestrictedAssistantUrl } from "../browser/sites.js";
import type { ToolCall, ToolSpec } from "./brain.js";
import type { ToolResult } from "./host.js";
import { sayable, taskPhrase } from "./prompt.js";
import type { Lang } from "./text.js";

/**
 * What the voice can do beyond talking: start work in the background, look at it, and change its course while it goes on.
 * Every tool is a small, checked operation on the task executive or on the notes. None of these tools can approve anything on
 * its own: `delegate_task` reads and researches only. Work that would change files is proposed (`propose_change`): unless the
 * user explicitly pre-authorized writes (such as YOLO mode), it waits paused on the user's screen (in Tasks and on the call
 * card), where the user clicks Approve/Decline or confirms on a subsequent turn when microphone echo cancellation is active.
 * Resuming an unapproved proposal via `resume_task` is refused. `browse` starts a web task in the assistant's isolated browser
 * context: new origins and actions that submit/commit ask first on the screen, and Meta consumer/social domains are fenced off.
 * `use_connector` starts a task on one connected account (GitHub, Brevo, Supabase) where any write action asks on the screen.
 */

/** The connected accounts, as the call needs them: which can be used now, and whether one can be used for a task. */
export interface VoiceConnectors {
  usable(): Array<{ id: string; name: string }>;
  available(connector: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface VoiceToolDeps {
  assistant: AssistantService;
  /** The folder a spoken task runs in, or null when none is known. */
  project: () => string | null;
  /** Optional fuzzy resolver when the user names a specific project during the call. */
  resolveProject?: (name?: string | null) => string | null;
  /** True when the user's standing posture (such as YOLO mode) pre-authorizes write proposals. */
  isPreAuthorized?: () => boolean;
  /** Shared authorization hub so proposals also appear inline on the active voice call card. */
  authorizations?: AuthorizationHub;
  /** The language of the call, for what is said back. */
  lang: () => Lang;
  /** The conversation, to look notes up in its scope. */
  conversationId: string;
  /** The assistant's own browser, when this server has one to give: without it the `browse` tool is not offered. */
  browse?: { available(): Promise<{ ok: boolean; reason?: string }> };
  /** The connected accounts, when there are any to use: without one the `use_connector` tool is not offered. */
  connectors?: VoiceConnectors;
}

export const VOICE_TOOLS: readonly ToolSpec[] = [
  {
    name: "delegate_task",
    description:
      "Start a task in the background and carry on talking. Use it for work that takes more than a few seconds: reading a codebase, researching, summarising files, checking something. The task can read and research only; it cannot change files. For a change, use propose_change. For a page on the web, use browse.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the task is to find out or produce, in a sentence or two, complete enough to be understood on its own." },
        title: { type: "string", description: "A short name for it, a few words." },
        project: { type: "string", description: "Project name when the user named a specific project." },
      },
      required: ["goal"],
    },
  },
  {
    name: "propose_change",
    description:
      "Ask for work that would change files in the project: fix a bug, edit code or a document. Unless pre-authorized by YOLO mode, nothing starts until the user approves it on the screen or call card.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What is to be changed and how, in a sentence or two, complete enough to be understood on its own." },
        title: { type: "string", description: "A short name for it, a few words." },
        project: { type: "string", description: "Project name when the user named a specific project." },
      },
      required: ["goal"],
    },
  },
  {
    name: "browse",
    description:
      "Look something up on the web, or do a short task on a web page, in the background, in a browser of its own. It reads pages; it cannot sign in, buy, post or download on its own — every site, form, download, or file upload requires the user's approval on the screen, and the user is told when it is done.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What to find out or do on the web, complete enough to be understood on its own." },
        url: { type: "string", description: "A page to start from, if the user named one." },
        title: { type: "string", description: "A short name for it, a few words." },
      },
      required: ["goal"],
    },
  },
  {
    name: "use_connector",
    description:
      "Look something up in one of the user's connected accounts (such as GitHub, Brevo or Supabase), in the background. It can only read: it cannot change, send or post anything. The user is told when it is done.",
    parameters: {
      type: "object",
      properties: {
        connector: { type: "string", description: "Which connected account." },
        goal: { type: "string", description: "What to find out, complete enough to be understood on its own." },
        title: { type: "string", description: "A short name for it, a few words." },
      },
      required: ["connector", "goal"],
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

function normalizeGoal(goal: string): string {
  return goal.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
}

function describe(task: Task): string {
  const progress = task.progress.total > 0 ? `, ${task.progress.done} of ${task.progress.total} steps` : "";
  return `${task.id} | ${task.status} | ${sayable(task.title, 80)}${progress}${task.reason ? ` | ${task.reason.slice(0, 120)}` : ""}`;
}

export class VoiceTools {
  constructor(private readonly deps: VoiceToolDeps) {}

  specs(): ToolSpec[] {
    // Without the executive (no host to run tasks on) the task tools are not offered, so the model never promises what it cannot do.
    // The same goes for `browse` where this server has no browser of its own to give.
    if (!this.deps.assistant.executive) return VOICE_TOOLS.filter((t) => t.name === "recall");
    // `use_connector` is offered only while an account is connected and on, and it names them: the model picks from what exists.
    const usable = this.deps.connectors?.usable() ?? [];
    return VOICE_TOOLS.filter((t) => (t.name !== "browse" || this.deps.browse !== undefined) && (t.name !== "use_connector" || usable.length > 0)).map((t) => {
      if (t.name !== "use_connector") return t;
      const properties = (t.parameters["properties"] ?? {}) as Record<string, unknown>;
      return { ...t, parameters: { ...t.parameters, properties: { ...properties, connector: { type: "string", enum: usable.map((u) => u.id), description: `Which connected account: ${usable.map((u) => u.name).join(", ")}.` } } } };
    });
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

  private resolveCwd(namedProject: string): string | null {
    if (namedProject && this.deps.resolveProject) {
      const found = this.deps.resolveProject(namedProject);
      if (found) return found;
    }
    return this.deps.project();
  }

  async run(call: ToolCall, turn = 0): Promise<ToolResult> {
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
          const cwd = this.resolveCwd(str(args["project"], 120));
          if (!cwd) return { ok: false, text: "I do not know which project to work in. Ask the user to open a project in Ancilla, or to name one." };
          const spec = parseTaskSpec({ goal, cwd, ...(str(args["title"], 120) ? { title: str(args["title"], 120) } : {}) }, assistant.store.getProfile(), (c) => assistant.projectKey(c));
          const wantedGoal = normalizeGoal(spec.goal);
          const existing = assistant.tasks
            .list("active", 50)
            .find((t) => t.origin === "user" && !t.allowWrites && t.cwd === spec.cwd && normalizeGoal(t.goal) === wantedGoal);
          if (existing) {
            return {
              ok: true,
              text: `Task ${existing.id}, "${sayable(existing.title, 80)}", is already ${existing.status} for that goal. Nothing new was started; tell the user it is already under way.`,
            };
          }
          const task = executive.create({ ...spec, origin: "user" });
          return {
            ok: true,
            text: `Started task ${task.id}, "${sayable(task.title, 80)}". It reads and researches in the background and cannot change files. The user is told when it finishes or needs them.`,
            narration: taskPhrase(lang, "started", task.title),
          };
        }
        case "propose_change": {
          if (!executive) return { ok: false, text: "Background tasks are not available right now." };
          const goal = str(args["goal"], 2000);
          if (goal === "") return { ok: false, text: "A proposal needs a goal: say what is to be changed." };
          const cwd = this.resolveCwd(str(args["project"], 120));
          if (!cwd) return { ok: false, text: "I do not know which project to work in. Ask the user to open a project in Ancilla, or to name one." };
          const preAuthorized = this.deps.isPreAuthorized?.() === true;
          const baseProfile = assistant.store.getProfile();
          const effectiveProfile = preAuthorized && !baseProfile.policy.allowProjectWrites
            ? { ...baseProfile, policy: { ...baseProfile.policy, allowProjectWrites: true } }
            : baseProfile;
          const spec = parseTaskSpec({ goal, cwd, allowWrites: true, ...(str(args["title"], 120) ? { title: str(args["title"], 120) } : {}) }, effectiveProfile, (c) => assistant.projectKey(c));
          const wantedGoal = normalizeGoal(spec.goal);
          const existing = assistant.tasks
            .list("active", 50)
            .find((t) => t.allowWrites && t.cwd === spec.cwd && normalizeGoal(t.goal) === wantedGoal);
          if (existing) {
            if (awaitsApproval(existing)) {
              return {
                ok: true,
                text: `Proposed task ${existing.id}, "${sayable(existing.title, 80)}", is already waiting on the user's screen for approval. Do not say it is under way; say that it waits for their approval.`,
              };
            }
            return {
              ok: true,
              text: `Task ${existing.id}, "${sayable(existing.title, 80)}", was already approved and is currently ${existing.status}. Nothing new was proposed; report its actual status (${existing.status}).`,
            };
          }
          const task = executive.propose(spec);
          if (this.deps.isPreAuthorized?.()) {
            const approved = executive.approve(task.id);
            return {
              ok: true,
              text: `Started task ${approved.id}, "${sayable(approved.title, 80)}" (pre-authorized by YOLO mode). The user is told when it finishes.`,
              narration: taskPhrase(lang, "started", approved.title),
            };
          }
          this.deps.authorizations?.request({
            id: `task_${task.id}`,
            kind: "task-proposal",
            title: `Approve change: ${sayable(task.title, 80)}`,
            detail: goal.slice(0, 320),
            allowLabel: "Approve",
            denyLabel: "Decline",
            createdTurn: turn,
            onDecide: async (allow) => {
              if (allow) {
                const approved = executive.approve(task.id);
                return { ok: true, message: `Approved task "${sayable(approved.title, 80)}" (${approved.status}).` };
              }
              await executive.cancel(task.id, "Declined by user.");
              return { ok: true, message: `Declined proposal "${sayable(task.title, 80)}".` };
            },
          });
          return {
            ok: true,
            text: `Proposed task ${task.id}, "${sayable(task.title, 80)}". Nothing has started: it waits on the user's screen for approval (click Approve or confirm on the next turn). Say that it waits for their approval; do not say it is under way.`,
            narration: taskPhrase(lang, "proposed", task.title),
          };
        }
        case "browse": {
          const browse = this.deps.browse;
          if (!executive || !browse) return { ok: false, text: "Browsing is not available right now." };
          const goal = str(args["goal"], 1500);
          if (goal === "") return { ok: false, text: "A web task needs a goal: say what to find out." };
          const url = str(args["url"], 500);
          if (url !== "" && isRestrictedAssistantUrl(url)) {
            return {
              ok: false,
              text: "Automated assistant browsing is disabled on Meta consumer sites; ask the user to open it in their own Browser tab instead.",
            };
          }
          const ready = await browse.available();
          if (!ready.ok) return { ok: false, text: `The browser cannot be used right now: ${ready.reason ?? "it is not available"}` };
          // A web task belongs to no project, but a task row names a folder: the project of the call, or the home folder.
          const cwd = this.deps.project() ?? homedir();
          const spec = parseTaskSpec({ goal: url ? `${goal}\nStart at: ${url}` : goal, cwd, ...(str(args["title"], 120) ? { title: str(args["title"], 120) } : {}) }, assistant.store.getProfile(), (c) => assistant.projectKey(c));
          const wantedGoal = normalizeGoal(spec.goal);
          const existing = assistant.tasks.list("active", 50).find((t) => t.origin === "browse" && normalizeGoal(t.goal) === wantedGoal);
          if (existing) {
            return {
              ok: true,
              text: `Web task ${existing.id}, "${sayable(existing.title, 80)}", is already ${existing.status} for that goal. Nothing new was started; report its actual status (${existing.status}).`,
            };
          }
          const task = executive.createBrowse(spec);
          return {
            ok: true,
            text: `Started web task ${task.id}, "${sayable(task.title, 80)}". The assistant's own browser is on it. The user may be asked on the screen to allow a site, and is told when it finishes. Say that it is on it; do not say what it found until it has.`,
            narration: taskPhrase(lang, "started", task.title),
          };
        }
        case "use_connector": {
          const connectors = this.deps.connectors;
          if (!executive || !connectors) return { ok: false, text: "Connected accounts are not available right now." };
          const goal = str(args["goal"], 1500);
          if (goal === "") return { ok: false, text: "A task on a connected account needs a goal: say what to find out." };
          const usable = connectors.usable();
          const named = str(args["connector"], 40).toLowerCase();
          const connector = usable.find((u) => u.id === named || u.name.toLowerCase() === named);
          if (!connector) return { ok: false, text: `There is no connected account called "${named.slice(0, 40)}" that can be used now. ${usable.length > 0 ? `The accounts are: ${usable.map((u) => u.name).join(", ")}.` : "None is connected: the user connects one under Assistant, Connectors."}` };
          const ready = await connectors.available(connector.id);
          if (!ready.ok) return { ok: false, text: ready.reason ?? `${connector.name} cannot be used right now.` };
          // A task on an account belongs to no project, but a task row names a folder: the project of the call, or the home folder.
          const cwd = this.deps.project() ?? homedir();
          const spec = parseTaskSpec({ goal, cwd, ...(str(args["title"], 120) ? { title: str(args["title"], 120) } : {}) }, assistant.store.getProfile(), (c) => assistant.projectKey(c));
          const wantedGoal = normalizeGoal(spec.goal);
          const existing = assistant.tasks
            .list("active", 50)
            .find((t) => t.origin === "connector" && t.account === connector.id && normalizeGoal(t.goal) === wantedGoal);
          if (existing) {
            return {
              ok: true,
              text: `Task ${existing.id}, "${sayable(existing.title, 80)}", is already ${existing.status} in ${connector.name} for that goal. Nothing new was started; report its actual status (${existing.status}).`,
            };
          }
          const task = executive.createConnector(spec, connector.id, "person");
          return {
            ok: true,
            text: `Started task ${task.id}, "${sayable(task.title, 80)}". It works in ${connector.name} in the background. It can change something only if the user asked for that, and then the user must approve each change on the screen. The user is told when it finishes or when it waits for them. Say that it is on it; do not say what it found until it has.`,
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
          const found = await assistant.previewAsync({ sessionId: this.deps.conversationId, text: query, project: null, account: null }, { timeoutMs: 600 });
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
