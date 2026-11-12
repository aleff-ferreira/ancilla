import { ConflictError, NotFoundError, ValidationError } from "../assistant/store.js";
import type { AssistantReply, AssistantRequest } from "../assistant/routes.js";
import { probeToolMode, type ToolModeProvider } from "./brain.js";
import { detectLocalServers } from "./local-models.js";
import { VoiceUnavailableError, type VoiceService } from "./service.js";

/**
 * The voice's HTTP surface, as a function from a request to a reply, like the assistant's: it knows nothing of sockets,
 * and authentication, host checks and CORS stay in front of it, for every `/api` request. The call itself is a WebSocket
 * (see ws.ts); this is what the settings page and the conversation list talk to.
 */

export const VOICE_PREFIX = "/api/voice";

export function isVoicePath(path: string): boolean {
  return path === VOICE_PREFIX || path.startsWith(`${VOICE_PREFIX}/`);
}

const ID = "([A-Za-z0-9_-]{1,64})";

function replyError(error: unknown): AssistantReply {
  if (error instanceof ValidationError) return { status: 400, body: { error: error.message, kind: "invalid", field: error.field } };
  if (error instanceof ConflictError) return { status: 409, body: { error: error.message, kind: "conflict" } };
  if (error instanceof NotFoundError) return { status: 404, body: { error: error.message, kind: "not_found" } };
  if (error instanceof VoiceUnavailableError) return { status: error.status, body: { error: error.message, kind: "unavailable" } };
  throw error;
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError("request", "a number was expected");
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export async function handleVoice(service: VoiceService, req: AssistantRequest): Promise<AssistantReply> {
  try {
    return await route(service, req);
  } catch (error) {
    return replyError(error);
  }
}

async function route(service: VoiceService, req: AssistantRequest): Promise<AssistantReply> {
  const sub = req.path.slice(VOICE_PREFIX.length);
  const { method } = req;

  if (method === "GET" && sub === "") return { status: 200, body: service.status() };

  if (method === "PATCH" && sub === "/settings") {
    const body = await req.body();
    return { status: 200, body: { settings: service.updateSettings(body), status: service.status() } };
  }

  if (method === "POST" && sub === "/warm") {
    void service.prewarm();
    return { status: 202, body: { warming: true } };
  }

  if (method === "GET" && sub === "/metrics") return { status: 200, body: { turns: service.recentMetrics() } };

  if (sub === "/pack") {
    if (method === "GET") {
      const plan = service.installer.plan(true);
      return {
        status: 200,
        body: {
          plan: { items: service.installer.catalog(), totalBytes: plan?.totalBytes ?? 0, platform: plan?.platform ?? `${process.platform}-${process.arch}` },
          job: service.installer.job(),
          installedBytes: await service.installer.installedBytes(),
        },
      };
    }
    if (method === "POST") {
      const body = await req.body();
      return { status: 202, body: { job: service.startInstall({ refine: body["refine"] !== false }) } };
    }
    if (method === "DELETE") {
      await service.removePack();
      return { status: 200, body: { removed: true } };
    }
  }
  if (method === "DELETE" && sub === "/pack/job") {
    service.installer.cancel();
    return { status: 200, body: { job: service.installer.job() } };
  }

  if (method === "POST" && sub === "/brain/test") {
    const settings = service.settings.get();
    const chosen = service.brainFor(null);
    if (settings.brain.kind === "muse" || (settings.brain.kind === "provider" && settings.brain.providerId !== "api")) {
      const who = chosen.brain.label || "Muse";
      return { status: 200, body: { ok: true, skipped: true, text: `${who} answers through a thread; it is tried by starting a call.` } };
    }
    if (chosen.problem) return { status: 200, body: { ok: false, error: chosen.problem } };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    const started = Date.now();
    let text = "";
    let firstMs: number | null = null;
    let error: string | null = null;
    try {
      for await (const event of chosen.brain.stream({ messages: [{ role: "user", content: "Reply with the single word: ready." }], tools: [], signal: abort.signal, maxTokens: 16, temperature: 0 })) {
        if (event.type === "text") {
          if (firstMs === null) firstMs = Date.now() - started;
          text += event.delta;
        } else if (event.type === "error") error = event.message;
      }
    } finally {
      clearTimeout(timer);
    }
    if (abort.signal.aborted && error === null && text === "") error = "The model did not answer in time.";
    const ok = error === null && text.trim() !== "";
    // A model that answers is also asked to use a tool, because a server that takes a plain request may refuse one with tools:
    // the way that works (built in, or through text) is found and kept for the calls that follow.
    let tools: "native" | "text" | "none" | null = null;
    if (ok && "setToolMode" in chosen.brain) {
      const probeAbort = new AbortController();
      const probeTimer = setTimeout(() => probeAbort.abort(), 25_000);
      try {
        tools = await probeToolMode(chosen.brain as ToolModeProvider, probeAbort.signal);
      } finally {
        clearTimeout(probeTimer);
      }
    }
    return { status: 200, body: { ok, ms: Date.now() - started, firstTokenMs: firstMs, text: text.trim().slice(0, 80), tools, ...(error ? { error } : {}) } };
  }

  // What model servers run on this computer, so the settings can offer them rather than ask for an address.
  if (method === "GET" && sub === "/local-models") return { status: 200, body: { servers: await detectLocalServers() } };

  if (sub === "/conversations") {
    const store = service.conversations(false);
    if (method === "GET") return { status: 200, body: { conversations: store ? store.list(integer(req.query.get("limit"), 50, 1, 200)) : [] } };
    if (method === "DELETE") {
      if (req.query.get("all") !== "1") throw new ValidationError("all", "pass all=1 to delete every conversation");
      return { status: 200, body: { deleted: store ? store.purge(null) : 0 } };
    }
  }

  const one = new RegExp(`^/conversations/${ID}$`).exec(sub);
  if (one) {
    const id = one[1] as string;
    const store = service.conversations(false);
    if (!store) throw new NotFoundError("The conversation");
    if (method === "GET") {
      const conversation = store.get(id);
      if (!conversation) throw new NotFoundError("The conversation");
      return { status: 200, body: { conversation, utterances: store.utterances(id, integer(req.query.get("limit"), 400, 1, 2000)) } };
    }
    if (method === "PATCH") {
      const body = await req.body();
      if (typeof body["title"] !== "string" || body["title"].length > 200) throw new ValidationError("title", "title must be text of at most 200 characters");
      if (!store.rename(id, body["title"])) throw new NotFoundError("The conversation");
      return { status: 200, body: { conversation: store.get(id) } };
    }
    if (method === "DELETE") {
      if (!store.remove(id)) throw new NotFoundError("The conversation");
      return { status: 200, body: { deleted: 1 } };
    }
  }

  return { status: 404, body: { error: "Not found.", kind: "not_found" } };
}
