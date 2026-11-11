import type { AssistantReply, AssistantRequest } from "../assistant/routes.js";
import { DownloadError } from "./downloads.js";
import type { BrowserService } from "./service.js";

/**
 * The browser's HTTP surface: status, download folder preferences, and the native OS folder picker (the pane's tabs and
 * screencast travel over `/api/browser/ws`). Like the voice's, it is a function from a request to a reply: authentication,
 * host checks and CORS stay in front of it.
 */

export const BROWSER_PREFIX = "/api/browser";

export function isBrowserPath(path: string): boolean {
  return path === BROWSER_PREFIX || path.startsWith(`${BROWSER_PREFIX}/`);
}

export async function handleBrowser(service: BrowserService, req: AssistantRequest): Promise<AssistantReply> {
  const sub = req.path.slice(BROWSER_PREFIX.length);
  if (req.method === "GET" && sub === "/status") return { status: 200, body: await service.status() };
  if (req.method === "GET" && sub === "/downloads/prefs") return { status: 200, body: service.downloads.preferences() };
  if (req.method === "PATCH" && sub === "/downloads/prefs") {
    const body = await req.body();
    const folder = body["folder"] === undefined ? undefined : typeof body["folder"] === "string" ? body["folder"] : null;
    if (folder === null) return { status: 400, body: { error: "folder must be a path string", kind: "invalid" } };
    const rememberFolder = body["rememberFolder"] === undefined ? undefined : typeof body["rememberFolder"] === "boolean" ? body["rememberFolder"] : null;
    if (rememberFolder === null) return { status: 400, body: { error: "rememberFolder must be a boolean", kind: "invalid" } };
    try {
      return {
        status: 200,
        body: service.downloads.setPreferences({
          ...(folder !== undefined ? { folder } : {}),
          ...(rememberFolder !== undefined ? { rememberFolder } : {}),
        }),
      };
    } catch (error) {
      if (error instanceof DownloadError) return { status: 400, body: { error: error.message, kind: "invalid" } };
      throw error;
    }
  }
  if (req.method === "POST" && sub === "/downloads/pick-folder") {
    const body = await req.body();
    const initial = typeof body["folder"] === "string" && body["folder"].trim() !== "" ? body["folder"] : undefined;
    return { status: 200, body: await service.pickDownloadFolder(initial) };
  }
  return { status: 404, body: { error: "not found", kind: "not_found" } };
}
