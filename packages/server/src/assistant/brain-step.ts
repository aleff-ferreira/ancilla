import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { FileError, listFolder, readProjectFile, searchProjectFiles, writeProjectFile } from "../files.js";
import type { BrainProvider, ChatMessage, ToolCall, ToolSpec } from "../voice/brain.js";

/**
 * Runs project steps directly on a `BrainProvider` (cloud or local) when Muse CLI is not installed or reachable.
 * - `runBrainReadStep` exposes read-only workspace tools (`list_folder`, `read_file`, `search_files`).
 * - `runBrainWriteStep` additionally exposes workspace-confined file mutation (`write_file`, `edit_file`) and
 *   non-shell verification checks (`run_check`) for tasks where the user explicitly enabled/approved `allowWrites`.
 */

const MAX_ROUNDS = 8;
const MAX_WRITE_ROUNDS = 12;
const MAX_READ_CHARS = 16_000;
const MAX_CHECK_CHARS = 16_000;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

export const ALLOWED_CHECK_PROGRAMS: ReadonlySet<string> = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "tsc",
  "pytest",
  "python",
  "python3",
  "cargo",
  "go",
  "dotnet",
  "git",
]);

const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "rev-parse"]);
const ALLOWED_ENV_TEMPLATES: ReadonlySet<string> = new Set([".env.example", ".env.sample", ".env.template"]);

const READ_TOOLS: ToolSpec[] = [
  {
    name: "list_folder",
    description: "List files and folders inside a project directory (relative to the project root, or '.' for the root).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative folder path, such as '.' or 'src'." } },
    },
  },
  {
    name: "read_file",
    description: "Read the text of a file inside the project.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative file path inside the project." } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Find files in the project whose path matches all words in the query.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Words to match in file paths." } },
      required: ["query"],
    },
  },
];

const WRITE_TOOLS: ToolSpec[] = [
  ...READ_TOOLS,
  {
    name: "write_file",
    description: "Create a new UTF-8 text file or overwrite an existing file inside the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the project, such as 'docs/NOTES.md' or 'src/util.ts'." },
        content: { type: "string", description: "Complete UTF-8 file text to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text inside an existing UTF-8 file in the project.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the project." },
        old_text: { type: "string", description: "Exact existing substring to replace (must match whitespace)." },
        new_text: { type: "string", description: "Replacement substring." },
        replace_all: { type: "boolean", description: "Set true to replace every occurrence when old_text appears multiple times." },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "run_check",
    description: "Run an allowlisted non-shell build, test, lint, or read-only git command inside the project root to verify changes.",
    parameters: {
      type: "object",
      properties: {
        program: {
          type: "string",
          description: "Program name (one of: node, npm, npx, pnpm, yarn, bun, tsc, pytest, python, python3, cargo, go, dotnet, git).",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments, such as ['test'] or ['status', '--short'].",
        },
      },
      required: ["program"],
    },
  },
];

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* invalid JSON falls back to empty arguments */
  }
  return {};
}

/** Rejects `.git/`, `.githooks/`, and secret `.env` files (while permitting `.env.example` templates). */
export function isProtectedProjectPath(relPath: string): string | null {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return "A file path is required.";
  const lowerParts = parts.map((p) => p.toLowerCase());
  if (lowerParts.includes(".git")) return "Files inside .git cannot be modified.";
  if (lowerParts.includes(".githooks")) return "Files inside .githooks cannot be modified.";
  const leaf = lowerParts[lowerParts.length - 1] ?? "";
  if ((leaf === ".env" || leaf.startsWith(".env.")) && !ALLOWED_ENV_TEMPLATES.has(leaf)) {
    return "Environment secret files (.env*) cannot be modified automatically.";
  }
  return null;
}

/**
 * Resolves a relative write target strictly inside `root`, refusing `..`, drive prefixes, protected paths, and any
 * symbolic link along existing parent directories or at the destination itself.
 */
async function resolveWriteTarget(root: string, displayRoot: string, requested: string): Promise<{ realRoot: string; abs: string; rel: string }> {
  if (/[\u0000-\u001f\u007f]/.test(requested)) {
    throw new FileError(400, "File path contains invalid control characters.");
  }
  let value = requested.trim().replace(/\\/g, "/");
  const display = displayRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (display && (value === display || value.startsWith(`${display}/`))) {
    value = value.slice(display.length);
  }
  value = value.replace(/^\/+/, "").replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = value.split("/");
  if (!value || value === "." || /^[A-Za-z]:/.test(value) || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new FileError(403, "That file path is outside this project.");
  }
  const rel = segments.join("/");
  const protectedReason = isProtectedProjectPath(rel);
  if (protectedReason) throw new FileError(403, protectedReason);

  const realRoot = await realpath(root).catch(() => {
    throw new FileError(404, "This project's folder is not there anymore.");
  });

  // Walk every segment from realRoot to refuse symbolic links at any directory level or at the target file.
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = resolve(cursor, segments[i] as string);
    const info = await lstat(cursor).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      throw new FileError(403, "Refusing to write through a symbolic link.");
    }
    if (i < segments.length - 1 && !info.isDirectory()) {
      throw new FileError(400, `Parent segment '${segments.slice(0, i + 1).join("/")}' is a file, not a folder.`);
    }
    if (i === segments.length - 1 && info.isDirectory()) {
      throw new FileError(400, "Target path is a folder, not a file.");
    }
  }

  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (!cursor.startsWith(rootPrefix)) {
    throw new FileError(403, "That file path is outside this project.");
  }
  return { realRoot, abs: cursor, rel: relative(realRoot, cursor).split(sep).join("/") };
}

async function writeNewOrExistingProjectFile(root: string, displayRoot: string, requested: string, content: string): Promise<{ path: string; size: number }> {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_WRITE_BYTES) {
    throw new FileError(413, "That file is too large to write (limit 5 MB).");
  }
  const { realRoot, abs, rel } = await resolveWriteTarget(root, displayRoot, requested);
  const parent = dirname(abs);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (realParent !== realRoot && !realParent.startsWith(rootPrefix)) {
    throw new FileError(403, "Parent folder resolved outside the project.");
  }
  const existing = await lstat(abs).catch(() => null);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new FileError(400, "Only a regular file can be written.");
  }
  const temp = join(parent, `.${basename(abs)}.ancilla-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await writeFile(temp, bytes, existing ? { mode: existing.mode } : undefined);
    await rename(temp, abs);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { path: rel, size: bytes.length };
}

export type CheckExecResult = { exitCode: number | null; output: string; timedOut: boolean };
export type CheckExecFn = (program: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs: number) => Promise<CheckExecResult>;

function scrubbedCheckEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith("ANCILLA_TOKEN") || upper.startsWith("ANCILLA_AUTH") || upper.startsWith("ANCILLA_SECRET")) continue;
    clean[key] = value;
  }
  clean["CI"] = "1";
  return clean;
}

const defaultCheckExec: CheckExecFn = (program, args, cwd, signal, timeoutMs) =>
  new Promise((resolveExec) => {
    if (signal.aborted) {
      resolveExec({ exitCode: null, output: "Cancelled.", timedOut: false });
      return;
    }
    let child;
    try {
      child = spawn(program, args, {
        cwd,
        env: scrubbedCheckEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolveExec({ exitCode: null, output: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    let out = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer): void => {
      if (out.length >= MAX_CHECK_CHARS) return;
      out += chunk.toString("utf8").slice(0, MAX_CHECK_CHARS - out.length);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const stopChild = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* process already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => stopChild();
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null, extraError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const text = extraError && out.trim() === "" ? extraError : out;
      resolveExec({ exitCode, output: text, timedOut });
    };
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));
  });

export function validateCheckCommand(programRaw: string, argsRaw: unknown): { ok: true; program: string; args: string[] } | { ok: false; reason: string } {
  const program = programRaw.trim();
  if (!program || /[\\/]/.test(program) || !ALLOWED_CHECK_PROGRAMS.has(program)) {
    return {
      ok: false,
      reason: `Program '${program || "(empty)"}' is not allowed. Allowed programs: ${[...ALLOWED_CHECK_PROGRAMS].join(", ")}.`,
    };
  }
  const args: string[] = [];
  if (argsRaw !== undefined) {
    if (!Array.isArray(argsRaw) || argsRaw.length > 32 || argsRaw.some((a) => typeof a !== "string" || a.length > 500 || a.includes("\u0000"))) {
      return { ok: false, reason: "args must be an array of up to 32 plain strings." };
    }
    for (const arg of argsRaw) args.push(arg as string);
  }
  if (program === "git") {
    let idx = 0;
    while (idx < args.length && (args[idx] ?? "").startsWith("-")) {
      const globalFlag = args[idx] as string;
      if (globalFlag !== "--no-pager" && globalFlag !== "--no-optional-locks") {
        return { ok: false, reason: `git global flag '${globalFlag}' is not allowed in run_check.` };
      }
      idx += 1;
    }
    const sub = args[idx] ?? "";
    if (!SAFE_GIT_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        reason: `git subcommand '${sub || "(none)"}' is not allowed in run_check. Allowed git subcommands: ${[...SAFE_GIT_SUBCOMMANDS].join(", ")}.`,
      };
    }
    for (const tail of args.slice(idx + 1)) {
      if (tail === "--output" || tail.startsWith("--output=") || tail === "--ext-diff" || tail === "--textconv") {
        return { ok: false, reason: `git option '${tail}' is not allowed in run_check.` };
      }
    }
  }
  return { ok: true, program, args };
}

async function runReadTool(root: string, displayRoot: string, call: ToolCall): Promise<string> {
  const args = parseArgs(call.arguments);
  try {
    if (call.name === "list_folder") {
      const requested = typeof args["path"] === "string" && args["path"].trim() !== "" ? args["path"] : ".";
      const listing = await listFolder(root, displayRoot, requested);
      const lines = listing.entries.slice(0, 150).map((e) => `${e.kind === "dir" ? "[dir]" : "[file]"} ${e.path}${e.kind === "file" ? ` (${e.size} B)` : ""}`);
      if (listing.entries.length > 150 || listing.truncated) lines.push("... (more entries omitted)");
      return lines.length > 0 ? lines.join("\n") : "(empty folder)";
    }
    if (call.name === "read_file") {
      const requested = typeof args["path"] === "string" ? args["path"] : "";
      if (requested.trim() === "") return "Error: path is required.";
      const file = await readProjectFile(root, displayRoot, requested);
      if (file.content === undefined) return `[${file.kind}: ${file.path}, ${file.size} bytes — binary or media file]`;
      const sliced = file.content.length > MAX_READ_CHARS ? `${file.content.slice(0, MAX_READ_CHARS)}\n... (truncated at ${MAX_READ_CHARS} characters)` : file.content;
      return sliced;
    }
    if (call.name === "search_files") {
      const query = typeof args["query"] === "string" ? args["query"] : "";
      if (query.trim() === "") return "Error: query is required.";
      const matches = await searchProjectFiles(root, query, 40);
      return matches.length > 0 ? matches.map((m) => m.path).join("\n") : "(no matching files)";
    }
    return `Error: unknown tool ${call.name}.`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runWriteStepTool(
  root: string,
  displayRoot: string,
  call: ToolCall,
  signal: AbortSignal,
  execCheck: CheckExecFn,
  checkTimeoutMs: number,
  changedFiles: Set<string>,
  checksRun: string[],
): Promise<string> {
  if (call.name === "list_folder" || call.name === "read_file" || call.name === "search_files") {
    return runReadTool(root, displayRoot, call);
  }
  const args = parseArgs(call.arguments);
  try {
    if (call.name === "write_file") {
      const requested = typeof args["path"] === "string" ? args["path"] : "";
      if (requested.trim() === "") return "Error: path is required.";
      if (typeof args["content"] !== "string") return "Error: content must be a string.";
      const saved = await writeNewOrExistingProjectFile(root, displayRoot, requested, args["content"]);
      changedFiles.add(saved.path);
      return `Wrote ${saved.path} (${saved.size} bytes).`;
    }
    if (call.name === "edit_file") {
      const requested = typeof args["path"] === "string" ? args["path"] : "";
      const oldText = typeof args["old_text"] === "string" ? args["old_text"] : "";
      const newText = typeof args["new_text"] === "string" ? args["new_text"] : null;
      const replaceAll = args["replace_all"] === true;
      if (requested.trim() === "") return "Error: path is required.";
      if (oldText === "") return "Error: old_text cannot be empty.";
      if (newText === null) return "Error: new_text must be a string.";
      if (oldText === newText) return "Error: old_text and new_text are identical.";

      const { rel } = await resolveWriteTarget(root, displayRoot, requested);
      const current = await readProjectFile(root, displayRoot, rel);
      if (current.content === undefined) return `Error: ${rel} is a binary or media file and cannot be edited as text.`;
      if (current.truncated) return `Error: ${rel} exceeds the text edit limit (${current.size} bytes).`;

      let count = 0;
      let idx = 0;
      while ((idx = current.content.indexOf(oldText, idx)) !== -1) {
        count += 1;
        idx += oldText.length;
      }
      if (count === 0) {
        return `Error: old_text was not found in ${rel}. Read the file first to verify exact text and whitespace.`;
      }
      if (count > 1 && !replaceAll) {
        return `Error: old_text matched ${count} locations in ${rel}. Include more surrounding context or pass replace_all: true.`;
      }
      const firstIdx = current.content.indexOf(oldText);
      const updated = replaceAll
        ? current.content.split(oldText).join(newText)
        : `${current.content.slice(0, firstIdx)}${newText}${current.content.slice(firstIdx + oldText.length)}`;
      const saved = await writeProjectFile(root, displayRoot, rel, updated, current.mtimeMs);
      changedFiles.add(saved.path);
      return `Edited ${saved.path} (${count} replacement${count === 1 ? "" : "s"}, ${saved.size} bytes).`;
    }
    if (call.name === "run_check") {
      const programRaw = typeof args["program"] === "string" ? args["program"] : "";
      const checked = validateCheckCommand(programRaw, args["args"]);
      if (!checked.ok) return `Error: ${checked.reason}`;
      const realRoot = await realpath(root).catch(() => {
        throw new FileError(404, "This project's folder is not there anymore.");
      });
      const res = await execCheck(checked.program, checked.args, realRoot, signal, checkTimeoutMs);
      const label = [checked.program, ...checked.args].join(" ").slice(0, 120);
      const statusLabel = res.timedOut ? "timed out" : `exit ${res.exitCode ?? "error"}`;
      checksRun.push(`${label} (${statusLabel})`);
      const body = res.output.trim() || "(no output)";
      return `[${statusLabel}] ${label}\n${body}`;
    }
    return `Error: unknown tool ${call.name}.`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export interface BrainReadStepInput {
  brain: BrainProvider;
  root: string;
  displayRoot?: string;
  prompt: string;
  signal: AbortSignal;
}

export async function runBrainReadStep(input: BrainReadStepInput): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  const displayRoot = input.displayRoot ?? input.root;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are executing a read-only project step for Ancilla. Inspect the project files as needed with list_folder, search_files and read_file, and answer concisely and accurately based only on what you verified in the files. Never invent file contents.",
    },
    { role: "user", content: input.prompt },
  ];

  let lastText = "";
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (input.signal.aborted) return { ok: false, error: "The step was cancelled." };
    let text = "";
    const calls: ToolCall[] = [];
    for await (const event of input.brain.stream({ messages, tools: READ_TOOLS, signal: input.signal, temperature: 0.2, maxTokens: 1500 })) {
      if (event.type === "text") text += event.delta;
      else if (event.type === "tool") calls.push(event.call);
      else if (event.type === "error") return { ok: false, error: event.message };
    }
    if (input.signal.aborted) return { ok: false, error: "The step was cancelled." };
    if (text.trim() !== "") lastText = text.trim();
    if (calls.length === 0) return { ok: true, answer: lastText || "Done." };
    messages.push({ role: "assistant", content: text, toolCalls: calls });
    for (const call of calls) {
      const out = await runReadTool(input.root, displayRoot, call);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
    }
  }
  return { ok: true, answer: lastText || "Reached the read step tool limit." };
}

export interface BrainWriteStepInput {
  brain: BrainProvider;
  root: string;
  displayRoot?: string;
  prompt: string;
  signal: AbortSignal;
  execCheck?: CheckExecFn;
  checkTimeoutMs?: number;
}

export type BrainWriteStepOutcome =
  | { ok: true; answer: string; changedFiles: string[]; checksRun: string[] }
  | { ok: false; error: string; changedFiles: string[] };

export async function runBrainWriteStep(input: BrainWriteStepInput): Promise<BrainWriteStepOutcome> {
  const displayRoot = input.displayRoot ?? input.root;
  const execCheck = input.execCheck ?? defaultCheckExec;
  const checkTimeoutMs = input.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const changedFiles = new Set<string>();
  const checksRun: string[] = [];

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are executing an authorized project write step for Ancilla inside a single workspace root. Inspect existing files first with list_folder, search_files, and read_file; make targeted, minimal edits with edit_file or create/replace files with write_file; verify your changes with run_check when tests or typechecks apply; and finish with a concise summary of what you changed and verified. Never touch files outside the project or fabricate verification results.",
    },
    { role: "user", content: input.prompt },
  ];

  let lastText = "";
  for (let round = 0; round < MAX_WRITE_ROUNDS; round += 1) {
    if (input.signal.aborted) return { ok: false, error: "The step was cancelled.", changedFiles: [...changedFiles] };
    let text = "";
    const calls: ToolCall[] = [];
    for await (const event of input.brain.stream({ messages, tools: WRITE_TOOLS, signal: input.signal, temperature: 0.2, maxTokens: 2048 })) {
      if (event.type === "text") text += event.delta;
      else if (event.type === "tool") calls.push(event.call);
      else if (event.type === "error") return { ok: false, error: event.message, changedFiles: [...changedFiles] };
    }
    if (input.signal.aborted) return { ok: false, error: "The step was cancelled.", changedFiles: [...changedFiles] };
    if (text.trim() !== "") lastText = text.trim();
    if (calls.length === 0) {
      return {
        ok: true,
        answer: lastText || (changedFiles.size > 0 ? `Updated ${[...changedFiles].join(", ")}.` : "Done."),
        changedFiles: [...changedFiles],
        checksRun,
      };
    }
    messages.push({ role: "assistant", content: text, toolCalls: calls });
    for (const call of calls) {
      if (input.signal.aborted) return { ok: false, error: "The step was cancelled.", changedFiles: [...changedFiles] };
      const out = await runWriteStepTool(input.root, displayRoot, call, input.signal, execCheck, checkTimeoutMs, changedFiles, checksRun);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
    }
  }
  return {
    ok: true,
    answer: lastText || `Reached the write step tool limit (${MAX_WRITE_ROUNDS} rounds).`,
    changedFiles: [...changedFiles],
    checksRun,
  };
}
