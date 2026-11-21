import type { AssistantReply, AssistantRequest } from "../assistant/routes.js";
import { ConflictError, NotFoundError, ValidationError } from "../assistant/store.js";
import { parseSettingsPatch, type SentinelService } from "./service.js";

/**
 * The Sentinel's HTTP surface, under `/api/assistant/desktop`: what it sees and has concluded, the history by day, the audit and
 * a check of its chain, and the two settings. Like the assistant's it is a function from a request to a reply; authentication,
 * host checks and CORS are in front of it, for every `/api` request.
 */

const PREFIX = "/api/assistant/desktop";

export function isSentinelPath(path: string): boolean {
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

function failure(error: unknown): AssistantReply {
  if (error instanceof ValidationError) return { status: 400, body: { error: error.message, kind: "invalid", field: error.field } };
  if (error instanceof ConflictError) return { status: 409, body: { error: error.message, kind: "conflict" } };
  if (error instanceof NotFoundError) return { status: 404, body: { error: error.message, kind: "not_found" } };
  throw error;
}

function wholeNumber(text: string | null, fallback: number, min: number, max: number): number {
  const value = Number(text ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

export async function handleSentinel(service: SentinelService, req: AssistantRequest): Promise<AssistantReply> {
  const sub = req.path.slice(PREFIX.length);
  try {
    if (req.method === "GET" && sub === "") return { status: 200, body: service.status() };
    if (req.method === "PATCH" && sub === "/settings") return { status: 200, body: { settings: service.setSettings(parseSettingsPatch(await req.body())) } };
    if (req.method === "GET" && sub === "/findings") {
      const since = req.query.get("since");
      const options: { open?: boolean; since?: number; limit?: number } = { limit: wholeNumber(req.query.get("limit"), 100, 1, 500) };
      if (req.query.get("open") === "1") options.open = true;
      if (since !== null && Number.isFinite(Number(since))) options.since = Number(since);
      return { status: 200, body: { findings: service.findings(options) } };
    }
    if (req.method === "GET" && sub === "/digest") return { status: 200, body: { digest: service.digest() } };
    if (req.method === "GET" && sub === "/history") {
      return { status: 200, body: { days: service.daily(wholeNumber(req.query.get("days"), 14, 1, 120), wholeNumber(req.query.get("offset"), 0, -840, 840)) } };
    }
    if (req.method === "GET" && sub === "/audit") return { status: 200, body: { entries: service.recentAudit(wholeNumber(req.query.get("limit"), 50, 1, 200)) } };
    if (req.method === "GET" && sub === "/audit/verify") return { status: 200, body: { check: service.verifyAudit() } };
    return { status: 404, body: { error: "Nothing is here.", kind: "not_found" } };
  } catch (error) {
    return failure(error);
  }
}
