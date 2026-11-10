import { homedir } from "node:os";
import { MAX_AVATAR_BYTES, MAX_AVATARS, MAX_TOTAL_AVATAR_BYTES } from "./avatars.js";
import { parseEmbeddingSettings, testEmbedding } from "./embed.js";
import { DEFAULT_PROFILE } from "./profile.js";
import { NO_EMBEDDING, type AssistantService } from "./service.js";
import { ConflictError, EMPTY_BOND, NotFoundError, ValidationError, type ListFilter } from "./store.js";
import { dismissSuggestion, suggest } from "./suggest.js";
import { parseScheduleSpec, parseTaskSpec } from "./tasks.js";
import { MEMORY_KINDS, type MemoryKind, type Scope } from "./types.js";

/**
 * The assistant's HTTP surface, as a function from a request to a reply. It knows nothing of sockets: the server
 * hands it the method, the path, the query and a way to read the body, and writes whatever comes back. That keeps
 * every route testable without a server, and keeps authentication, host checks and CORS where they already are
 * (in front of this, for every `/api` request).
 */

export interface AssistantRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
}

export interface AssistantReply {
  status: number;
  body: unknown;
  /** Send the body as a file with this name. */
  download?: string;
}

const ID = "([A-Za-z0-9_-]{1,64})";
const STATUSES = ["active", "superseded", "contested", "pending", "history", "attention", "all"] as const;
const SCOPE_KINDS = ["global", "account", "project", "thread"] as const;

function bad(message: string, field?: string): never {
  throw new ValidationError(field ?? "request", message);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") bad(`${field} must be text`, field);
  if (value.length > max) bad(`${field} is longer than ${max} characters`, field);
  return value;
}

function optionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) bad(`${field} must be a number or null`, field);
  return value;
}

function kindOf(value: unknown): MemoryKind {
  if (typeof value !== "string" || !(MEMORY_KINDS as readonly string[]).includes(value)) bad(`kind must be one of ${MEMORY_KINDS.join(", ")}`, "kind");
  return value as MemoryKind;
}

function scopeOf(value: unknown): Scope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("scope must be an object", "scope");
  const s = value as Record<string, unknown>;
  const kind = s["kind"];
  if (typeof kind !== "string" || !(SCOPE_KINDS as readonly string[]).includes(kind)) bad(`scope.kind must be one of ${SCOPE_KINDS.join(", ")}`, "scope");
  const key = typeof s["key"] === "string" ? s["key"] : "";
  if (kind !== "global" && key.length === 0) bad("scope.key is required unless the scope is global", "scope");
  if (key.length > 500) bad("scope.key is too long", "scope");
  return { kind: kind as Scope["kind"], key: kind === "global" ? "" : key };
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) bad("a number was expected");
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function replyError(error: unknown): AssistantReply {
  if (error instanceof ValidationError) return { status: 400, body: { error: error.message, kind: "invalid", field: error.field } };
  if (error instanceof ConflictError) return { status: 409, body: { error: error.message, kind: "conflict", ...error.detail } };
  if (error instanceof NotFoundError) return { status: 404, body: { error: error.message, kind: "not_found" } };
  throw error;
}

export const ASSISTANT_PREFIX = "/api/assistant";

export function isAssistantPath(path: string): boolean {
  return path === ASSISTANT_PREFIX || path.startsWith(`${ASSISTANT_PREFIX}/`);
}

/**
 * Where the assistant comes from. Its file is made the first time something is written to it, so a user who never
 * switches it on has no file and no code of it running; looking at the page creates nothing.
 */
export interface AssistantAccess {
  /** The assistant, opened (and its file created) only when `create` is set. Null when there is none yet or it could not be opened. */
  get(create: boolean): AssistantService | null;
  /** Why it could not be opened, when that is the reason `get` gave nothing. */
  unavailable(): string | null;
}

const NO_STATS = { schemaVersion: 0, ftsEnabled: false, epoch: 0, items: { active: 0, superseded: 0, contested: 0, pending: 0, deleted: 0 }, kinds: {}, revisions: 0, sources: 0, tombstones: 0, bytes: 0 };

/** What the avatar library may hold, and how much of it is in use. */
function avatarLimits(usage: { used: number; total: number }): { count: number; perAvatarBytes: number; totalBytes: number; used: number; total: number } {
  return { count: MAX_AVATARS, perAvatarBytes: MAX_AVATAR_BYTES, totalBytes: MAX_TOTAL_AVATAR_BYTES, used: usage.used, total: usage.total };
}

/** A number the caller may send to say which version they were looking at. */
function expected(value: unknown): number | undefined {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) bad("expectedUpdatedAt must be a number", "expectedUpdatedAt");
  return value as number | undefined;
}

/** What looking at an assistant that has not been used yet shows: its defaults, and nothing stored. */
function untouched(req: AssistantRequest, sub: string): AssistantReply {
  if (req.method === "GET" && sub === "") return { status: 200, body: { available: true, fresh: true, profile: DEFAULT_PROFILE, goals: [], stats: NO_STATS, bond: EMPTY_BOND, epoch: 0, executive: false, tasks: { open: 0, needsYou: 0, running: 0 } } };
  if (req.method === "GET" && sub === "/goals") return { status: 200, body: { goals: [] } };
  if (req.method === "GET" && sub === "/tasks") return { status: 200, body: { tasks: [], summary: { open: 0, needsYou: 0, running: 0 } } };
  if (req.method === "GET" && sub === "/suggestions") return { status: 200, body: { suggestions: [], autonomy: DEFAULT_PROFILE.autonomy } };
  if (req.method === "GET" && sub === "/schedules") return { status: 200, body: { schedules: [] } };
  if (req.method === "GET" && sub === "/memories") return { status: 200, body: { items: [], total: 0, epoch: 0 } };
  if (req.method === "GET" && sub === "/embeddings") return { status: 200, body: { ...NO_EMBEDDING } };
  if (req.method === "GET" && sub === "/activity") return { status: 200, body: { activity: [] } };
  if (req.method === "GET" && sub === "/avatars") return { status: 200, body: { avatars: [], limits: avatarLimits({ used: 0, total: 0 }) } };
  if (req.method === "GET" && sub === "/export") return { status: 200, body: { format: "ancilla.assistant.export", version: 1, items: [], goals: [], avatars: [], profile: DEFAULT_PROFILE, notes: ["The assistant has not been used yet."] }, download: "ancilla-assistant-empty.json" };
  if (req.method === "POST" && sub === "/preview") return { status: 200, body: { text: "", tokens: 0, wouldAdd: false, noEvidence: false, omitted: [], memories: [] } };
  if (req.method === "GET" && /^\/threads\/[^/]+\/context$/.test(sub)) return { status: 200, body: { context: null } };
  return { status: 404, body: { error: "Nothing is saved yet.", kind: "not_found" } };
}

const TASK_ACTIONS = /^\/tasks\/([A-Za-z0-9_-]{1,64})\/(pause|resume|cancel|retry|confirm|extend|resolve|approve|site)$/;

/** Tasks, what to do next, and schedules: the executive's side of the surface. Null when the path is not one of theirs. */
async function handleWork(service: AssistantService, sub: string, req: AssistantRequest): Promise<AssistantReply | null> {
  const mine = ["/tasks", "/suggestions", "/schedules", "/browse"].some((p) => sub === p || sub.startsWith(`${p}/`));
  if (!mine) return null;
  const exec = service.executive;
  if (!exec) return { status: 503, body: { error: "Tasks need a Muse host, and this server was not given one.", kind: "tasks_unavailable" } };
  const store = service.store;
  const tasks = service.tasks;
  const profile = store.getProfile();
  const projectKey = (cwd: string): string => service.projectKey(cwd);

  if (req.method === "GET" && sub === "/tasks") {
    const filter = req.query.get("filter") ?? "all";
    if (filter !== "active" && filter !== "done" && filter !== "all") bad("filter must be active, done or all", "filter");
    return { status: 200, body: { tasks: tasks.list(filter, integer(req.query.get("limit"), 100, 1, 500)), summary: service.taskSummary() } };
  }
  if (req.method === "POST" && sub === "/tasks") {
    const task = exec.create(parseTaskSpec(await req.body(), profile, projectKey));
    return { status: 201, body: { task } };
  }
  // A web task started from a screen (the Browser panel's box), as the voice's `browse` starts one.
  if (req.method === "POST" && sub === "/browse") {
    const body = await req.body();
    const goal = typeof body["goal"] === "string" ? body["goal"].trim() : "";
    if (goal.length < 3) bad("goal must say what to find out", "goal");
    const url = typeof body["url"] === "string" ? body["url"].trim() : "";
    const ready = await exec.browseAvailable();
    if (!ready.ok) return { status: 409, body: { error: ready.reason ?? "The browser cannot be used right now.", kind: "browse_unavailable" } };
    const cwd = typeof body["cwd"] === "string" && body["cwd"] !== "" ? body["cwd"] : homedir();
    const task = exec.createBrowse(parseTaskSpec({ goal: url ? `${goal}\nStart at: ${url}` : goal, cwd }, profile, projectKey));
    return { status: 201, body: { task } };
  }
  // The sites the person said yes or no to for good: listed, and taken back one at a time.
  if (sub === "/browse/sites" && req.method === "GET") return { status: 200, body: { rules: exec.browseSites() } };
  if (sub === "/browse/sites" && req.method === "DELETE") {
    const body = await req.body();
    const origin = typeof body["origin"] === "string" ? body["origin"] : "";
    if (origin === "") bad("origin is required", "origin");
    if (!exec.removeBrowseSite(origin)) return { status: 404, body: { error: "That site has no saved rule.", kind: "not_found" } };
    return { status: 200, body: { rules: exec.browseSites() } };
  }
  const one = sub.match(/^\/tasks\/([A-Za-z0-9_-]{1,64})$/);
  if (one && req.method === "GET") {
    const id = one[1] as string;
    return { status: 200, body: { ...tasks.detail(id), checkpoint: tasks.latestCheckpoint(id) } };
  }
  const act = sub.match(TASK_ACTIONS);
  if (act && req.method === "POST") {
    const id = act[1] as string;
    const action = act[2] as string;
    const body = await req.body();
    let task;
    if (action === "pause") task = exec.pause(id);
    else if (action === "resume") task = exec.resume(id);
    else if (action === "retry") task = exec.retry(id);
    else if (action === "confirm") task = exec.confirm(id);
    else if (action === "approve") task = exec.approve(id);
    else if (action === "site") {
      // The person's answer to the site a web task is waiting on: allow it for the task, always, not now, or block it.
      if (typeof body["answer"] !== "string") bad("answer is required", "answer");
      task = exec.answerSite(id, body["answer"]);
    } else if (action === "cancel") task = await exec.cancel(id);
    else if (action === "extend") {
      const turns = typeof body["turns"] === "number" ? body["turns"] : 0;
      const minutes = typeof body["minutes"] === "number" ? body["minutes"] : 0;
      task = exec.extend(id, turns, minutes);
    } else {
      const resolution = body["resolution"];
      if (typeof body["stepId"] !== "string") bad("stepId is required", "stepId");
      if (resolution !== "done" && resolution !== "retry" && resolution !== "skip") bad("resolution must be done, retry or skip", "resolution");
      task = exec.resolve(id, body["stepId"], resolution);
    }
    return { status: 200, body: { task } };
  }

  if (req.method === "GET" && sub === "/suggestions") {
    return { status: 200, body: { suggestions: suggest({ memory: store, tasks, profile, now: store.now() }), autonomy: profile.autonomy } };
  }
  if (req.method === "POST" && sub === "/suggestions/dismiss") {
    const body = await req.body();
    dismissSuggestion(store, text(body["id"], "id", 200), store.now());
    return { status: 200, body: { ok: true } };
  }
  if (req.method === "POST" && sub === "/suggestions/accept") {
    const body = await req.body();
    const id = text(body["id"], "id", 200);
    const found = suggest({ memory: store, tasks, profile, now: store.now() }).find((s) => s.id === id);
    if (!found) throw new NotFoundError("The suggestion");
    if (found.action.type === "confirm-memory") {
      const item = store.confirm(found.action.memoryId);
      service.announce({ reason: "memory" });
      return { status: 200, body: { item } };
    }
    if (found.action.type === "open-task") return { status: 200, body: { task: tasks.require(found.action.taskId) } };
    const cwd = found.action.project ?? (typeof body["cwd"] === "string" ? body["cwd"] : "");
    if (!cwd) bad("This suggestion has no project of its own: say where it should run with cwd", "cwd");
    const spec = parseTaskSpec({ goal: found.action.goal, cwd, title: found.title.slice(0, 100) }, profile, projectKey);
    return { status: 201, body: { task: exec.create({ ...spec, origin: "suggestion" }) } };
  }

  if (req.method === "GET" && sub === "/schedules") return { status: 200, body: { schedules: tasks.schedules() } };
  if (req.method === "POST" && sub === "/schedules") {
    const spec = parseScheduleSpec(await req.body(), profile, projectKey, store.now());
    const schedule = tasks.createSchedule(spec, store.now());
    service.announce({ reason: "task" });
    return { status: 201, body: { schedule } };
  }
  const sch = sub.match(/^\/schedules\/([A-Za-z0-9_-]{1,64})(?:\/(enable|disable))?$/);
  if (sch && req.method === "POST" && sch[2]) {
    const schedule = tasks.setScheduleEnabled(sch[1] as string, sch[2] === "enable", sch[2] === "disable" ? "Paused by you." : "");
    service.announce({ reason: "task" });
    return { status: 200, body: { schedule } };
  }
  if (sch && req.method === "DELETE" && !sch[2]) {
    tasks.removeSchedule(sch[1] as string);
    service.announce({ reason: "task" });
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "No such assistant route.", kind: "not_found" } };
}

/** Answers an assistant request, or null when the path is not one of its routes. A bad request is an error reply, not a throw. */
export async function handleAssistant(access: AssistantAccess, req: AssistantRequest): Promise<AssistantReply | null> {
  if (!isAssistantPath(req.path)) return null;
  const sub = req.path.slice(ASSISTANT_PREFIX.length);
  // Trying an embedding server touches no memory, so it needs (and creates) no assistant file.
  if (req.method === "POST" && sub === "/embeddings/test") {
    try {
      return { status: 200, body: await testEmbedding(parseEmbeddingSettings(await req.body())) };
    } catch (error) {
      return replyError(error);
    }
  }
  const reading = req.method === "GET" || sub === "/preview";
  const service = access.get(!reading);
  if (!service) {
    const why = access.unavailable();
    if (why !== null || !reading) return { status: 503, body: { error: `The assistant is not available: ${why ?? "it did not start"}.`, kind: "assistant_unavailable" } };
    return untouched(req, sub);
  }
  const store = service.store;
  try {
    // ---- status and settings
    if (req.method === "GET" && sub === "") {
      return { status: 200, body: { available: true, profile: store.getProfile(), goals: store.listGoals(), stats: store.stats(), bond: store.bond(), epoch: store.epoch(), executive: service.executive !== null, tasks: service.taskSummary() } };
    }
    if (req.method === "PATCH" && sub === "/profile") {
      const body = await req.body();
      const { expectedUpdatedAt, ...patch } = body;
      const before = store.getProfile();
      const profile = store.saveProfile(patch, expected(expectedUpdatedAt));
      // Switching the assistant off stops its work from starting anything new; a turn already running finishes.
      if (before.enabled && !profile.enabled) service.executive?.pauseAll("The assistant was switched off.");
      service.announce({ reason: "profile" });
      return { status: 200, body: { profile, epoch: store.epoch() } };
    }

    // ---- goals
    if (req.method === "GET" && sub === "/goals") return { status: 200, body: { goals: store.listGoals() } };
    if (req.method === "POST" && sub === "/goals") {
      const goal = store.addGoal(await req.body());
      service.announce({ reason: "goal" });
      return { status: 201, body: { goal } };
    }
    const goalMatch = sub.match(new RegExp(`^/goals/${ID}$`));
    if (goalMatch && req.method === "PATCH") {
      const goal = store.updateGoal(goalMatch[1] as string, await req.body());
      service.announce({ reason: "goal" });
      return { status: 200, body: { goal } };
    }
    if (goalMatch && req.method === "DELETE") {
      store.removeGoal(goalMatch[1] as string);
      service.announce({ reason: "goal" });
      return { status: 200, body: { ok: true } };
    }

    // ---- saved avatars: the library the assistant's look can be chosen from
    if (req.method === "GET" && sub === "/avatars") return { status: 200, body: { avatars: store.listAvatars(), limits: avatarLimits(store.avatarUsage()) } };
    if (req.method === "POST" && sub === "/avatars") {
      const avatar = store.createAvatar(await req.body());
      // The library is part of the Persona page, which reloads with the profile: no event of its own is needed.
      service.announce({ reason: "profile" });
      return { status: 201, body: { avatar } };
    }
    const avatarMatch = sub.match(new RegExp(`^/avatars/${ID}$`));
    if (avatarMatch && req.method === "GET") return { status: 200, body: { avatar: store.requireAvatar(avatarMatch[1] as string) } };
    if (avatarMatch && req.method === "PATCH") {
      const avatarId = avatarMatch[1] as string;
      const { expectedUpdatedAt, ...patch } = await req.body();
      const wearing = store.getProfile().character.avatar.look;
      const active = wearing.kind === "pack" && wearing.id === avatarId;
      const avatar = store.updateAvatar(avatarId, patch, undefined, expected(expectedUpdatedAt));
      service.announce({ reason: "profile" });
      // When the assistant wears this one, its look moved with it: the profile comes back so the page need not ask again.
      return { status: 200, body: { avatar, ...(active ? { profile: store.getProfile() } : {}) } };
    }
    if (avatarMatch && req.method === "DELETE") {
      store.deleteAvatar(avatarMatch[1] as string);
      service.announce({ reason: "profile" });
      return { status: 200, body: { ok: true } };
    }

    // ---- memories
    if (req.method === "GET" && sub === "/memories") {
      const q = req.query;
      const filter: ListFilter = { limit: integer(q.get("limit"), 50, 1, 200), offset: integer(q.get("offset"), 0, 0, 1_000_000) };
      const status = q.get("status");
      if (status) {
        if (!(STATUSES as readonly string[]).includes(status)) bad(`status must be one of ${STATUSES.join(", ")}`, "status");
        filter.status = status as NonNullable<ListFilter["status"]>;
      }
      const kind = q.get("kind");
      if (kind) filter.kind = kindOf(kind);
      const scope = q.get("scope");
      if (scope) filter.scope = text(scope, "scope", 500);
      const search = q.get("q");
      if (search) filter.q = text(search, "q", 200);
      return { status: 200, body: { ...store.list(filter), epoch: store.epoch() } };
    }
    if (req.method === "POST" && sub === "/memories") {
      const body = await req.body();
      const made = store.remember({
        text: text(body["text"], "text", 2000),
        ...(body["kind"] !== undefined ? { kind: kindOf(body["kind"]) } : {}),
        ...(body["scope"] !== undefined ? { scope: scopeOf(body["scope"]) } : {}),
        ...(body["pinned"] === true ? { pinned: true } : {}),
        ...(typeof body["dueAt"] === "number" ? { dueAt: body["dueAt"] } : {}),
        ...(typeof body["validTo"] === "number" ? { validTo: body["validTo"] } : {}),
      });
      service.announce({ reason: "memory" });
      return { status: 201, body: { id: made.id, change: made.change, item: made.id ? store.getItem(made.id) : null, epoch: store.epoch() } };
    }
    if (req.method === "POST" && sub === "/consolidate") {
      const done = store.consolidate();
      if (done.merged + done.expired + done.rolledUp > 0) service.announce({ reason: "memory" });
      return { status: 200, body: { ...done, epoch: store.epoch() } };
    }
    if (req.method === "POST" && sub === "/wipe") {
      const body = await req.body();
      if (body["confirm"] !== "wipe everything") bad('send {"confirm":"wipe everything"} to erase all memories', "confirm");
      const erased = store.wipe();
      service.announce({ reason: "memory", forgotten: erased });
      return { status: 200, body: { erased, epoch: store.epoch() } };
    }
    const memoryMatch = sub.match(new RegExp(`^/memories/${ID}$`));
    if (memoryMatch && req.method === "GET") return { status: 200, body: { ...store.detail(memoryMatch[1] as string), epoch: store.epoch() } };
    if (memoryMatch && req.method === "PATCH") {
      const id = memoryMatch[1] as string;
      const body = await req.body();
      if (typeof body["rev"] !== "number" || !Number.isInteger(body["rev"])) bad("rev is required: the revision of the memory you were looking at", "rev");
      const item = store.edit(
        id,
        {
          ...(body["text"] !== undefined ? { text: text(body["text"], "text", 2000) } : {}),
          ...(body["kind"] !== undefined ? { kind: kindOf(body["kind"]) } : {}),
          ...(typeof body["pinned"] === "boolean" ? { pinned: body["pinned"] } : {}),
          ...(body["dueAt"] !== undefined ? { dueAt: optionalNumber(body["dueAt"], "dueAt") as number | null } : {}),
          ...(body["validTo"] !== undefined ? { validTo: optionalNumber(body["validTo"], "validTo") as number | null } : {}),
        },
        body["rev"],
      );
      service.announce({ reason: "memory" });
      return { status: 200, body: { item, epoch: store.epoch() } };
    }
    if (memoryMatch && req.method === "DELETE") {
      const gone = store.forget([memoryMatch[1] as string]);
      if (gone.length === 0) throw new NotFoundError("The memory");
      service.announce({ reason: "memory", forgotten: gone.length });
      return { status: 200, body: { forgotten: gone, epoch: store.epoch() } };
    }
    const actionMatch = sub.match(new RegExp(`^/memories/${ID}/(pin|unpin|confirm|settle|approve|commitment)$`));
    if (actionMatch && req.method === "POST") {
      const id = actionMatch[1] as string;
      const action = actionMatch[2] as string;
      const body = await req.body();
      let item;
      if (action === "pin" || action === "unpin") item = store.pin(id, action === "pin");
      else if (action === "confirm") item = store.confirm(id);
      else if (action === "settle") item = store.settle(id);
      else if (action === "approve") item = store.approve(id, typeof body["replaces"] === "string" ? body["replaces"] : undefined);
      else {
        const state = body["state"];
        if (state !== "open" && state !== "done" && state !== "dropped") bad("state must be open, done or dropped", "state");
        item = store.setCommitment(id, state);
      }
      service.announce({ reason: "memory" });
      return { status: 200, body: { item, epoch: store.epoch() } };
    }

    // ---- meaning search: finding notes by what they mean, with an embedding model the user names
    if (req.method === "GET" && sub === "/embeddings") return { status: 200, body: service.embeddingStatus() };
    // PUT sets all of it; PATCH changes what it names and keeps the rest (the page sends PATCH, as it does everywhere).
    if ((req.method === "PUT" || req.method === "PATCH") && sub === "/embeddings") {
      const body = await req.body();
      const current = req.method === "PATCH" ? service.embeddingSettings() : null;
      service.configureEmbeddings(parseEmbeddingSettings(current ? { ...current, ...body } : body));
      return { status: 200, body: service.embeddingStatus() };
    }
    if (req.method === "DELETE" && sub === "/embeddings") {
      service.configureEmbeddings(null);
      return { status: 200, body: service.embeddingStatus() };
    }

    // ---- transparency and portability
    if (req.method === "GET" && sub === "/activity") return { status: 200, body: { activity: store.activity(integer(req.query.get("limit"), 50, 1, 500)) } };
    if (req.method === "GET" && sub === "/export") {
      const stamp = new Date(store.now()).toISOString().slice(0, 10);
      return { status: 200, body: store.exportAll(), download: `ancilla-assistant-${stamp}.json` };
    }
    if (req.method === "POST" && sub === "/preview") {
      const body = await req.body();
      const out = await service.previewAsync({
        sessionId: typeof body["sessionId"] === "string" ? body["sessionId"] : "preview",
        text: text(body["text"], "text", 4000),
        project: typeof body["project"] === "string" ? body["project"] : null,
        account: typeof body["account"] === "string" ? body["account"] : null,
      });
      return {
        status: 200,
        body: { text: out.text, tokens: out.tokens, wouldAdd: out.wouldAdd, noEvidence: out.noEvidence, omitted: out.omitted, memories: out.memories.map((m) => ({ id: m.item.id, text: m.item.text, kind: m.item.kind, score: Math.round(m.score * 1000) / 1000, why: m.why, stale: m.stale })) },
      };
    }
    const contextMatch = sub.match(new RegExp(`^/threads/${ID}/context$`));
    if (contextMatch && req.method === "GET") return { status: 200, body: { context: service.lastContext(contextMatch[1] as string) } };

    // ---- tasks, what to do next, and schedules
    const work = await handleWork(service, sub, req);
    if (work) return work;
    return { status: 404, body: { error: "No such assistant route.", kind: "not_found" } };
  } catch (error) {
    return replyError(error);
  }
}
