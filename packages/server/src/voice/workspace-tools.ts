import type { AuthorizationHub, LaunchManager, LaunchSpec } from "../assistant/launcher.js";
import { isLikelyServerCommand } from "../assistant/launcher.js";
import { formatPageDiagnostics, type PageDiagnostics } from "../browser/service.js";
import { isRestrictedAssistantOrigin, isRestrictedAssistantUrl, originOf } from "../browser/sites.js";
import { FileError, listFolder, readProjectFile, resolveInRoot, searchProjectFiles } from "../files.js";
import type { ToolCall, ToolSpec } from "./brain.js";
import { resolveByFuzzyName } from "./harness.js";
import type { ToolResult } from "./host.js";

/**
 * Provider-independent workspace inspection, process/URL/editor launching, and live page/animation diagnostics for calls
 * and chat brains.
 *
 * Read operations (`inspect_project`, `launch_status` list/logs) execute immediately inside registered project roots.
 * Consequential operations (`launch`, `launch_status` stop, and `inspect_page` on unapproved origins) obey the user's
 * authorization posture: immediate when pre-authorized (such as YOLO mode), or queued on `AuthorizationHub` so the user
 * can click Allow on the call card or confirm in their next spoken/typed turn.
 */

export interface WorkspaceProjectRef {
  name: string;
  cwd: string;
  displayCwd: string;
}

export interface PageInspector {
  available(): Promise<{ ok: boolean; reason?: string }>;
  isSiteAllowed(origin: string): boolean;
  grantSite(origin: string): void;
  inspectUrl(url: string): Promise<{ url: string; title: string; diagnostics: PageDiagnostics; snapshotText: string }>;
}

export interface WorkspaceVoiceDeps {
  projects: () => WorkspaceProjectRef[];
  currentProject: () => WorkspaceProjectRef | null;
  launcher: LaunchManager;
  authorizations: AuthorizationHub;
  isPreAuthorized: () => boolean;
  inspector?: PageInspector;
}

export const WORKSPACE_TOOLS: readonly ToolSpec[] = [
  {
    name: "inspect_project",
    description:
      "Read files, list folders, or search filenames inside a project (such as package.json, Vite/Next config, HTML/CSS, or animation source code). Read-only and instant.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "search", "read"], description: "list a folder, search filenames, or read a file." },
        project: { type: "string", description: "Project name (fuzzy matched, e.g. 'Amazon River' -> amazonia_river). Defaults to current project." },
        path: { type: "string", description: "Relative file or folder path inside the project." },
        query: { type: "string", description: "Filename search words when action is 'search'." },
        startLine: { type: "number", description: "Optional 1-based start line when reading a file." },
        endLine: { type: "number", description: "Optional 1-based end line when reading a file." },
      },
    },
  },
  {
    name: "launch",
    description:
      "Launch a dev server (localhost), shell command, web URL, project folder, or editor. Runs immediately when pre-authorized (such as YOLO mode); otherwise puts a Launch prompt on the call card so the user can click Launch or say 'go ahead'.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run in the project (e.g. 'npm run dev', 'npx vite', 'python3 -m http.server 8080')." },
        url: { type: "string", description: "Web address (http:// or https://, or localhost:PORT) to open." },
        open: { type: "string", enum: ["files", "editor"], description: "Open the project folder or path in the system file manager or editor." },
        path: { type: "string", description: "Optional relative path inside the project when opening files/editor." },
        project: { type: "string", description: "Project name (fuzzy matched). Defaults to current project." },
        background: { type: "boolean", description: "Keep running in the background (automatic for dev servers)." },
        openInBrowser: { type: "boolean", description: "Open the detected localhost URL or given URL in Ancilla's browser." },
      },
    },
  },
  {
    name: "launch_status",
    description: "List launched servers/commands, read recent stdout/stderr logs, or stop a running launch.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "logs", "stop"] },
        id: { type: "string", description: "Launch id from launch/launch_status, or 'last'." },
      },
    },
  },
  {
    name: "inspect_page",
    description:
      "Open a live URL (such as http://localhost:5173) in Ancilla's browser and measure rendering health: live FPS, frame drops, Canvas DPI/buffer scaling, CSS/Web animations, layout-thrashing properties, console/JS errors, and page content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Address to inspect, e.g. 'http://localhost:5173/'." },
      },
      required: ["url"],
    },
  },
];

export const WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set(WORKSPACE_TOOLS.map((t) => t.name));

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

export function normalizeWebUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{2,5})(?:\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class WorkspaceVoiceTools {
  constructor(private readonly deps: WorkspaceVoiceDeps) {}

  specs(): ToolSpec[] {
    return WORKSPACE_TOOLS.filter((t) => t.name !== "inspect_page" || this.deps.inspector !== undefined);
  }

  resolveProject(named?: string | null): WorkspaceProjectRef | null {
    const all = this.deps.projects();
    const query = (named ?? "").trim();
    if (query) {
      return resolveByFuzzyName(all, (p) => p.name, query);
    }
    return this.deps.currentProject() ?? (all.length === 1 ? all[0]! : null);
  }

  private missingProjectText(named: string): string {
    const all = this.deps.projects();
    const known = all.length > 0 ? ` Known projects: ${all.slice(0, 12).map((p) => p.name).join(", ")}.` : " No projects are registered yet.";
    return named
      ? `No project matched "${named}".${known}`
      : `Which project should I use?${known}`;
  }

  async run(call: ToolCall, turn = 0): Promise<ToolResult> {
    const args = parseArgs(call);
    try {
      switch (call.name) {
        case "inspect_project": {
          const named = str(args["project"], 120);
          const proj = this.resolveProject(named);
          if (!proj) return { ok: false, text: this.missingProjectText(named) };
          const pathArg = str(args["path"], 400);
          const queryArg = str(args["query"], 200);
          const action =
            args["action"] === "read" || args["action"] === "search" || args["action"] === "list"
              ? args["action"]
              : queryArg
                ? "search"
                : pathArg && /\.[a-z0-9]{1,8}$/i.test(pathArg)
                  ? "read"
                  : "list";

          if (action === "search") {
            const q = queryArg || pathArg;
            if (!q) return { ok: false, text: "Provide a query to search filenames in the project." };
            const found = await searchProjectFiles(proj.cwd, q, 40);
            if (found.length === 0) return { ok: true, text: `No files in ${proj.name} matched "${q}".` };
            return {
              ok: true,
              text: `Files in ${proj.name} matching "${q}" (${found.length}):\n${found.map((f) => `${f.path} (${formatSize(f.size)})`).join("\n")}`,
            };
          }

          if (action === "read") {
            if (!pathArg) return { ok: false, text: "Provide a relative file path to read." };
            const file = await readProjectFile(proj.cwd, proj.displayCwd, pathArg);
            if (file.content === undefined) {
              return { ok: true, text: `${proj.name}/${file.path}: ${file.kind} (${file.mediaType}, ${formatSize(file.size)}).` };
            }
            const lines = file.content.split(/\r?\n/);
            const start = typeof args["startLine"] === "number" && Number.isFinite(args["startLine"]) ? Math.max(1, Math.floor(args["startLine"])) : 1;
            const end =
              typeof args["endLine"] === "number" && Number.isFinite(args["endLine"])
                ? Math.min(lines.length, Math.max(start, Math.floor(args["endLine"])))
                : Math.min(lines.length, start + 159);
            const numbered = lines
              .slice(start - 1, end)
              .map((line, idx) => `${start + idx}: ${line}`)
              .join("\n");
            const clipped = numbered.length > 6000 ? `${numbered.slice(0, 6000)}\n... (clipped)` : numbered;
            return {
              ok: true,
              text: `${proj.name}/${file.path} (lines ${start}-${end} of ${lines.length}):\n${clipped}`,
            };
          }

          const listing = await listFolder(proj.cwd, proj.displayCwd, pathArg || ".");
          const shown = listing.entries.slice(0, 80);
          const body =
            shown.length === 0
              ? "(empty folder)"
              : shown.map((e) => (e.kind === "dir" ? `[dir] ${e.path}/` : `${e.path} (${formatSize(e.size)})`)).join("\n");
          const more = listing.entries.length > shown.length ? `\n... and ${listing.entries.length - shown.length} more` : "";
          return {
            ok: true,
            text: `${proj.name}/${listing.path || "."}:\n${body}${more}`,
          };
        }

        case "launch": {
          const command = str(args["command"], 800);
          const rawUrl = str(args["url"], 500);
          const openTarget = args["open"] === "files" || args["open"] === "editor" ? args["open"] : null;
          const named = str(args["project"], 120);

          let spec: LaunchSpec;
          if (command) {
            const proj = this.resolveProject(named);
            if (!proj) return { ok: false, text: this.missingProjectText(named) };
            const background = typeof args["background"] === "boolean" ? args["background"] : isLikelyServerCommand(command);
            const openInBrowser = typeof args["openInBrowser"] === "boolean" ? args["openInBrowser"] : background;
            spec = {
              kind: "command",
              command,
              cwd: proj.cwd,
              projectName: proj.name,
              background,
              openInBrowser,
            };
          } else if (rawUrl) {
            const url = normalizeWebUrl(rawUrl);
            const inAncillaBrowser = typeof args["openInBrowser"] === "boolean" ? args["openInBrowser"] : true;
            if (inAncillaBrowser && isRestrictedAssistantUrl(url)) {
              return {
                ok: false,
                text: "Automated assistant browsing is disabled on Meta consumer sites; ask the user to open it in their own Browser tab or pass openInBrowser: false for the system browser.",
              };
            }
            spec = { kind: "url", url, inAncillaBrowser };
          } else if (openTarget) {
            const proj = this.resolveProject(named);
            if (!proj) return { ok: false, text: this.missingProjectText(named) };
            const subPath = str(args["path"], 400);
            const resolved = subPath ? await resolveInRoot(proj.cwd, subPath, proj.displayCwd) : { abs: proj.cwd, rel: "" };
            spec = {
              kind: "open",
              path: resolved.abs,
              label: resolved.rel ? `${proj.name}/${resolved.rel}` : proj.name,
              target: openTarget,
            };
          } else {
            return { ok: false, text: "Specify a command, a url, or open ('files' or 'editor') to launch." };
          }

          const outcome = await this.deps.launcher.requestLaunch(spec, { turn });
          if (outcome.status === "needs_authorization") {
            return {
              ok: true,
              text:
                `Authorization required: "${outcome.authorization.title}" is now shown on the user's call card. ` +
                `Tell the user briefly what you queued and that they can click ${outcome.authorization.allowLabel} or say "go ahead" to launch it. ` +
                `Do not say it is running yet.`,
            };
          }

          const l = outcome.launch;
          const urlLine = l.urls.length > 0 ? `\nListening URL(s): ${l.urls.join(", ")}` : "";
          const pageLine = outcome.browserPage ? `\nOpened in Ancilla browser: ${outcome.browserPage.url} (${outcome.browserPage.title || "untitled"})` : "";
          const outTail = l.output.trim() ? `\nOutput:\n${l.output.trim().slice(-1200)}` : "";
          return {
            ok: true,
            text: `Launch ${l.id} (${l.status}${l.pid ? `, pid ${l.pid}` : ""}): ${l.title}${urlLine}${pageLine}${outTail}`,
          };
        }

        case "launch_status": {
          const action = args["action"] === "stop" || args["action"] === "logs" ? args["action"] : "list";
          const id = str(args["id"], 80) || "last";
          if (action === "list") {
            const list = this.deps.launcher.list();
            if (list.length === 0) return { ok: true, text: "Nothing has been launched in this session." };
            return {
              ok: true,
              text: list
                .slice(0, 12)
                .map((l) => `${l.id} | ${l.status}${l.pid ? ` (pid ${l.pid})` : ""} | ${l.title}${l.urls[0] ? ` | ${l.urls[0]}` : ""}`)
                .join("\n"),
            };
          }
          if (action === "logs") {
            const item = this.deps.launcher.get(id);
            if (!item) return { ok: false, text: `No launch matched "${id}".` };
            return {
              ok: true,
              text: `${item.id} (${item.status})${item.urls[0] ? ` ${item.urls[0]}` : ""}:\n${item.output.trim().slice(-3000) || "(no output yet)"}`,
            };
          }
          const target = this.deps.launcher.get(id);
          if (!target) return { ok: false, text: `No launch matched "${id}".` };
          const stopped = await this.deps.launcher.stop(target.id);
          return { ok: true, text: stopped ? `Stopped ${stopped.id} (${stopped.title}).` : `Could not stop "${id}".` };
        }

        case "inspect_page": {
          const inspector = this.deps.inspector;
          if (!inspector) return { ok: false, text: "Ancilla's integrated browser is not available on this host." };
          const rawUrl = str(args["url"], 500);
          if (!rawUrl) return { ok: false, text: "Provide the http:// or https:// URL to inspect." };
          const url = normalizeWebUrl(rawUrl);
          const origin = originOf(url);
          if (!origin) return { ok: false, text: `"${rawUrl}" is not a valid http:// or https:// address.` };
          if (isRestrictedAssistantOrigin(origin)) {
            return {
              ok: false,
              text: "Automated assistant page inspection is disabled on Meta consumer sites; ask the user to inspect it in their own Browser tab.",
            };
          }

          const ready = await inspector.available();
          if (!ready.ok) return { ok: false, text: `Browser is not available: ${ready.reason ?? "no Chromium/Edge/Brave binary found"}.` };

          if (!this.deps.isPreAuthorized() && !inspector.isSiteAllowed(origin)) {
            const auth = this.deps.authorizations.request({
              kind: "browser-site",
              title: `Allow Ancilla browser to inspect ${origin}`,
              detail: url,
              allowLabel: "Allow",
              denyLabel: "Deny",
              createdTurn: turn,
              onDecide: async (allow) => {
                if (!allow) return { ok: true, message: `Denied browser access to ${origin}.` };
                inspector.grantSite(origin);
                const report = await inspector.inspectUrl(url);
                return {
                  ok: true,
                  message: `Inspected ${report.url} (${report.diagnostics.fps.fps} fps, ${report.diagnostics.canvases.length} canvas, ${report.diagnostics.consoleErrors.length} console issues).`,
                };
              },
            });
            return {
              ok: true,
              text:
                `Authorization required to open ${origin}: "${auth.title}" is now on the user's call card. ` +
                `Ask the user to click Allow or say "go ahead", then inspect it.`,
            };
          }

          inspector.grantSite(origin);
          const report = await inspector.inspectUrl(url);
          const snap = report.snapshotText ? `\nVisible page tree:\n${report.snapshotText.slice(0, 2200)}` : "";
          return {
            ok: true,
            text: `${formatPageDiagnostics(report.diagnostics)}${snap}`,
          };
        }

        default:
          return { ok: false, text: `There is no tool called ${call.name}.` };
      }
    } catch (error) {
      if (error instanceof FileError) return { ok: false, text: error.message };
      return { ok: false, text: error instanceof Error ? error.message : `That did not work: ${String(error)}` };
    }
  }
}
