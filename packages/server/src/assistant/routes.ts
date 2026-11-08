import { DEFAULT_PROFILE } from "./profile.js";
import type { AssistantService } from "./service.js";
import { ConflictError, NotFoundError, ValidationError, type ListFilter } from "./store.js";
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

/** What looking at an assistant that has not been used yet shows: its defaults, and nothing stored. */
function untouched(req: AssistantRequest, sub: string): AssistantReply {
  if (req.method === "GET" && sub === "") return { status: 200, body: { available: true, fresh: true, profile: DEFAULT_PROFILE, goals: [], stats: NO_STATS, epoch: 0 } };
  if (req.method === "GET" && sub === "/goals") return { status: 200, body: { goals: [] } };
  if (req.method === "GET" && sub === "/memories") return { status: 200, body: { items: [], total: 0, epoch: 0 } };
  if (req.method === "GET" && sub === "/activity") return { status: 200, body: { activity: [] } };
  if (req.method === "GET" && sub === "/export") return { status: 200, body: { format: "ancilla.assistant.export", version: 1, items: [], goals: [], profile: DEFAULT_PROFILE, notes: ["The assistant has not been used yet."] }, download: "ancilla-assistant-empty.json" };
  if (req.method === "POST" && sub === "/preview") return { status: 200, body: { text: "", tokens: 0, wouldAdd: false, noEvidence: false, omitted: [], memories: [] } };
  if (req.method === "GET" && /^\/threads\/[^/]+\/context$/.test(sub)) return { status: 200, body: { context: null } };
  return { status: 404, body: { error: "Nothing is saved yet.", kind: "not_found" } };
}

/** Answers an assistant request, or null when the path is not one of its routes. A bad request is an error reply, not a throw. */
export async function handleAssistant(access: AssistantAccess, req: AssistantRequest): Promise<AssistantReply | null> {
  if (!isAssistantPath(req.path)) return null;
  const sub = req.path.slice(ASSISTANT_PREFIX.length);
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
      return { status: 200, body: { available: true, profile: store.getProfile(), goals: store.listGoals(), stats: store.stats(), epoch: store.epoch() } };
    }
    if (req.method === "PATCH" && sub === "/profile") {
      const body = await req.body();
      const { expectedUpdatedAt, ...patch } = body;
      if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== "number" || !Number.isFinite(expectedUpdatedAt))) bad("expectedUpdatedAt must be a number", "expectedUpdatedAt");
      const profile = store.saveProfile(patch, expectedUpdatedAt as number | undefined);
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

    // ---- transparency and portability
    if (req.method === "GET" && sub === "/activity") return { status: 200, body: { activity: store.activity(integer(req.query.get("limit"), 50, 1, 500)) } };
    if (req.method === "GET" && sub === "/export") {
      const stamp = new Date(store.now()).toISOString().slice(0, 10);
      return { status: 200, body: store.exportAll(), download: `ancilla-assistant-${stamp}.json` };
    }
    if (req.method === "POST" && sub === "/preview") {
      const body = await req.body();
      const out = service.preview({
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
    return { status: 404, body: { error: "No such assistant route.", kind: "not_found" } };
  } catch (error) {
    return replyError(error);
  }
}
