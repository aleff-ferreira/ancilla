import type { AssistantReply, AssistantRequest } from "../assistant/routes.js";
import type { BrowserService } from "./service.js";

/**
 * The browser's HTTP surface. B1 has only the status; the pane (B2) adds tabs and the screencast socket. Like the
 * voice's, it is a function from a request to a reply: authentication, host checks and CORS stay in front of it.
 */

export const BROWSER_PREFIX = "/api/browser";

export function isBrowserPath(path: string): boolean {
  return path === BROWSER_PREFIX || path.startsWith(`${BROWSER_PREFIX}/`);
}

export async function handleBrowser(service: BrowserService, req: AssistantRequest): Promise<AssistantReply> {
  const sub = req.path.slice(BROWSER_PREFIX.length);
  if (req.method === "GET" && sub === "/status") return { status: 200, body: await service.status() };
  return { status: 404, body: { error: "not found", kind: "not_found" } };
}
