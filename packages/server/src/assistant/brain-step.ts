import { listFolder, readProjectFile, searchProjectFiles } from "../files.js";
import type { BrainProvider, ChatMessage, ToolCall, ToolSpec } from "../voice/brain.js";

/**
 * Runs a read-only project step directly on a `BrainProvider` (cloud or local) when Muse CLI is not installed or reachable.
 * It gives the model three read-only tools inside the project's folder (`list_folder`, `read_file`, `search_files`), rooted by
 * `files.ts` so symlinks and `..` cannot leave the workspace, and never runs commands or writes files.
 */

const MAX_ROUNDS = 8;
const MAX_READ_CHARS = 16_000;

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

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* invalid JSON falls back to empty arguments */
  }
  return {};
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
