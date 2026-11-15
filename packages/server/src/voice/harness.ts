import type { ToolCall, ToolSpec } from "./brain.js";
import type { ToolResult } from "./host.js";
import { sayable } from "./prompt.js";

/**
 * The call's read-only view of the harness: which threads run, which wait on the user, what was said in one, how much of
 * the plan is used. The server implements `HarnessReader`; nothing here can start, change or approve anything, and what is
 * returned is short plain lines (titles and project names, never folders, ids of files or credentials).
 */

export type ThreadState = "running" | "waiting" | "idle";

export interface HarnessThread {
  id: string;
  title: string;
  /** The project's name (the last part of its folder), never its path. */
  project: string;
  state: ThreadState;
  /** Epoch milliseconds of the last activity. */
  activityAt: number;
}

export interface HarnessUsage {
  tier: string;
  windowPercent: number | null;
  weeklyPercent: number | null;
  /** Epoch milliseconds the weekly meter resets, when known. */
  weeklyResetsAt: number | null;
}

export interface HarnessMessage {
  role: "user" | "assistant";
  text: string;
}

export interface HarnessReader {
  /** Threads, most recently active first (archived ones left out). */
  threads(): HarnessThread[];
  /** The last `count` messages of a thread, oldest first. */
  messages(threadId: string, count: number): Promise<HarnessMessage[]>;
  /** The plan meter last seen, without asking anyone (for the digest); null when none. */
  cachedUsage(): HarnessUsage | null;
  /** The plan meter, read fresh; null when none has been read. */
  usage(): Promise<HarnessUsage | null>;
  /** Project names with their thread counts. */
  projects(): { name: string; threads: number }[];
  /** The project the user last worked in, by name. */
  currentProject(): string | null;
}

const QUERY_NOISE_WORDS = new Set([
  "project",
  "projects",
  "projeto",
  "projetos",
  "proyecto",
  "proyectos",
  "thread",
  "threads",
  "trail",
  "trails",
  "tread",
  "treads",
  "conversa",
  "conversas",
  "hilo",
  "hilos",
  "task",
  "tasks",
  "tarefa",
  "tarefas",
  "tarea",
  "tareas",
  "folder",
  "pasta",
  "carpeta",
  "repo",
  "repository",
  "the",
  "of",
  "in",
  "for",
  "on",
  "at",
  "called",
  "named",
  "do",
  "da",
  "de",
  "no",
  "na",
  "del",
  "en",
  "chamado",
  "chamada",
  "llamado",
  "llamada",
]);

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Uint16Array(b.length + 1);
  const curr = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev.set(curr);
  }
  return prev[b.length]!;
}

function tokenizeName(raw: string, stripNoise: boolean): string[] {
  const normalized = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (!stripNoise) return tokens;
  const filtered = tokens.filter((t) => !QUERY_NOISE_WORDS.has(t));
  return filtered.length > 0 ? filtered : tokens;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

function tokenSimilarity(cand: string, q: string): number {
  if (cand === q) return 1;
  const shorter = cand.length <= q.length ? cand : q;
  const longer = cand.length <= q.length ? q : cand;
  if (shorter.length >= 4 && longer.startsWith(shorter)) {
    return 0.88;
  }
  if (shorter.length >= 4 && editDistanceAtMostOne(cand, q)) {
    return 0.82;
  }
  if (shorter.length >= 4) {
    const ratio = 1 - levenshteinDistance(cand, q) / longer.length;
    if (ratio >= 0.75) return Number((ratio * 0.92).toFixed(4));
  }
  if (shorter.length >= 5 && longer.includes(shorter)) {
    return 0.72;
  }
  return 0;
}

/**
 * Scores how well `candidate` (e.g. `"amazonia_river"`) matches spoken/typed `query` (e.g. `"Amazon River"`,
 * `"trail of Amazonia River"`), returning a number in `[0, 1]`.
 */
export function scoreNameMatch(candidate: string, query: string): number {
  const candClean = candidate.trim().toLowerCase();
  const queryClean = query.trim().toLowerCase();
  if (!candClean || !queryClean) return 0;
  if (candClean === queryClean) return 1;

  const candTokens = tokenizeName(candidate, false);
  const queryTokens = tokenizeName(query, true);
  if (candTokens.length === 0 || queryTokens.length === 0) return 0;
  if (candTokens.join(" ") === queryTokens.join(" ")) return 0.99;

  let matchedSum = 0;
  for (const qt of queryTokens) {
    let best = 0;
    for (const ct of candTokens) {
      const sim = tokenSimilarity(ct, qt);
      if (sim > best) best = sim;
    }
    matchedSum += best;
  }
  const queryCoverage = matchedSum / queryTokens.length;
  if (queryCoverage < 0.6) return 0;
  const candCoverage = Math.min(1, matchedSum / candTokens.length);
  return Number((queryCoverage * 0.78 + candCoverage * 0.22).toFixed(4));
}

export function resolveByFuzzyName<T>(items: readonly T[], getName: (item: T) => string, query: string, minScore = 0.65): T | null {
  const q = query.trim();
  if (!q || items.length === 0) return null;
  const lower = q.toLowerCase();
  const exact = items.find((item) => getName(item).trim().toLowerCase() === lower);
  if (exact) return exact;

  const scored = items
    .map((item) => ({ item, score: scoreNameMatch(getName(item), q) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0]!.score - scored[1]!.score < 0.08) return null;
  return scored[0]!.item;
}

export const HARNESS_TOOLS: readonly ToolSpec[] = [
  { name: "harness_overview", description: "One-call summary of Ancilla now: the project, what is running, what waits on the user, tasks, plan usage.", parameters: { type: "object", properties: {} } },
  {
    name: "list_threads",
    description: "Recent threads: title, project, state, when.",
    parameters: { type: "object", properties: { filter: { type: "string", enum: ["all", "running", "waiting"] }, project: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "read_thread",
    description: "The last messages of one thread. The thread is an id or title from list_threads, or \"latest\".",
    parameters: { type: "object", properties: { thread: { type: "string" }, count: { type: "number" } }, required: ["thread"] },
  },
  { name: "usage", description: "How much of the plan's five-hour and weekly limits is used.", parameters: { type: "object", properties: {} } },
  { name: "list_projects", description: "The projects Ancilla knows, with their thread counts.", parameters: { type: "object", properties: {} } },
];

export const HARNESS_TOOL_NAMES: ReadonlySet<string> = new Set(HARNESS_TOOLS.map((t) => t.name));

export interface HarnessToolDeps {
  reader: HarnessReader;
  /** Tasks the user has running and tasks waiting on them. */
  taskCounts: () => { active: number; waiting: number };
  now?: () => number;
}

function args(call: ToolCall): Record<string, unknown> {
  try {
    const raw = JSON.parse(call.arguments === "" ? "{}" : call.arguments) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function count(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(1, n));
}

/** "3 min ago", "2 h ago", "4 d ago". */
export function ago(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function threadLine(t: HarnessThread, now: number): string {
  return `${t.id.slice(0, 8)} | ${sayable(t.title, 70)} | ${t.project} | ${t.state} | ${ago(t.activityAt, now)}`;
}

function usageLine(u: HarnessUsage, now: number): string {
  const parts: string[] = [];
  if (u.windowPercent !== null) parts.push(`${Math.round(u.windowPercent)}% of the five-hour limit`);
  if (u.weeklyPercent !== null) parts.push(`${Math.round(u.weeklyPercent)}% of the weekly limit${u.weeklyResetsAt !== null ? `, resets in ${Math.max(1, Math.round((u.weeklyResetsAt - now) / 3_600_000))} h` : ""}`);
  return parts.length === 0 ? "No plan usage has been read yet." : `Plan ${u.tier}: ${parts.join("; ")}.`;
}

/**
 * The compact "Right now" block for a call's context: running threads, what waits on the user, usage only when high.
 * Null when there is nothing worth saying, so a quiet harness adds nothing to the prompt.
 */
export function ambientDigest(reader: HarnessReader, taskCounts: { active: number; waiting: number }, now: number): string | null {
  const usage = reader.cachedUsage();
  const threads = reader.threads();
  const lines: string[] = [];
  const running = threads.filter((t) => t.state === "running");
  const waiting = threads.filter((t) => t.state === "waiting");
  if (running.length > 0) lines.push(`Running now: ${running.slice(0, 3).map((t) => sayable(t.title, 50)).join("; ")}${running.length > 3 ? ` and ${running.length - 3} more` : ""}.`);
  if (waiting.length > 0) lines.push(`Waiting on the user: ${waiting.slice(0, 3).map((t) => sayable(t.title, 50)).join("; ")}${waiting.length > 3 ? ` and ${waiting.length - 3} more` : ""}.`);
  if (taskCounts.waiting > 0) lines.push(`${taskCounts.waiting} background task${taskCounts.waiting === 1 ? "" : "s"} wait${taskCounts.waiting === 1 ? "s" : ""} on the user.`);
  if (usage && ((usage.weeklyPercent ?? 0) >= 80 || (usage.windowPercent ?? 0) >= 80)) lines.push(usageLine(usage, now));
  return lines.length === 0 ? null : `Right now in Ancilla:\n${lines.join("\n")}`;
}

export class HarnessTools {
  constructor(private readonly deps: HarnessToolDeps) {}

  specs(): ToolSpec[] {
    return [...HARNESS_TOOLS];
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private resolve(ref: string): HarnessThread {
    const threads = this.deps.reader.threads();
    const needle = ref.trim().toLowerCase();
    if (needle === "" || needle === "latest" || needle === "last") {
      const newest = threads[0];
      if (!newest) throw new Error("There are no threads.");
      return newest;
    }
    const byId = threads.filter((t) => t.id.toLowerCase().startsWith(needle));
    const matches = byId.length > 0 ? byId : threads.filter((t) => t.title.toLowerCase().includes(needle));
    if (matches.length === 1) return matches[0] as HarnessThread;
    if (matches.length > 1) throw new Error("More than one thread fits that. Use an id from list_threads.");

    const scored = threads
      .map((t) => ({ thread: t, score: Math.max(scoreNameMatch(t.title, ref), scoreNameMatch(`${t.project} ${t.title}`, ref)) }))
      .filter((entry) => entry.score >= 0.65)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1) return scored[0]!.thread;
    if (scored.length > 1) {
      if (scored[0]!.score - scored[1]!.score >= 0.1) return scored[0]!.thread;
      throw new Error("More than one thread fits that. Use an id from list_threads.");
    }
    throw new Error("No thread fits that.");
  }

  async run(call: ToolCall): Promise<ToolResult> {
    const a = args(call);
    const { reader } = this.deps;
    const now = this.now();
    try {
      switch (call.name) {
        case "harness_overview": {
          const threads = reader.threads();
          const running = threads.filter((t) => t.state === "running");
          const waiting = threads.filter((t) => t.state === "waiting");
          const tasks = this.deps.taskCounts();
          const usage = await reader.usage().catch(() => null);
          const lines = [
            `Project: ${reader.currentProject() ?? "none yet"}.`,
            running.length === 0 ? "Nothing is running." : `Running (${running.length}): ${running.slice(0, 5).map((t) => sayable(t.title, 60)).join("; ")}.`,
            waiting.length === 0 ? "Nothing waits on the user." : `Waiting on the user (${waiting.length}): ${waiting.slice(0, 5).map((t) => sayable(t.title, 60)).join("; ")}.`,
            `Tasks: ${tasks.active} active, ${tasks.waiting} waiting on the user.`,
            usage ? usageLine(usage, now) : "No plan usage has been read yet.",
          ];
          return { ok: true, text: lines.join("\n") };
        }
        case "list_threads": {
          const filter = a["filter"] === "running" ? "running" : a["filter"] === "waiting" ? "waiting" : "all";
          const rawProject = typeof a["project"] === "string" ? a["project"].trim() : "";
          const project = rawProject.toLowerCase();
          const limit = count(a["limit"], 8, 20);
          const found = reader
            .threads()
            .filter(
              (t) =>
                (filter === "all" || t.state === filter) &&
                (project === "" || t.project.toLowerCase().includes(project) || scoreNameMatch(t.project, rawProject) >= 0.65),
            )
            .slice(0, limit);
          return { ok: true, text: found.length === 0 ? "No threads fit that." : found.map((t) => threadLine(t, now)).join("\n") };
        }
        case "read_thread": {
          const thread = this.resolve(typeof a["thread"] === "string" ? a["thread"] : "");
          const messages = await reader.messages(thread.id, count(a["count"], 4, 10));
          if (messages.length === 0) return { ok: true, text: `${sayable(thread.title, 70)}: nothing has been said in it yet.` };
          return { ok: true, text: `${sayable(thread.title, 70)} (${thread.state})\n${messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${sayable(m.text, 500)}`).join("\n")}` };
        }
        case "usage": {
          const usage = await reader.usage();
          return { ok: true, text: usage ? usageLine(usage, now) : "No plan usage has been read yet." };
        }
        case "list_projects": {
          const projects = reader.projects();
          return { ok: true, text: projects.length === 0 ? "No projects yet." : projects.slice(0, 20).map((p) => `${p.name}: ${p.threads} thread${p.threads === 1 ? "" : "s"}`).join("\n") };
        }
        default:
          return { ok: false, text: `There is no tool called ${call.name}.` };
      }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : `That did not work: ${String(error)}` };
    }
  }
}
