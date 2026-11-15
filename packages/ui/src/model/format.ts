// Formatting and presentation utilities: timestamps, durations, tokens, diffs
import type { ApprovalRequest, MspItem } from "../types.js";
import { GOAL_TOOLS } from "./goal.js";
// Compact relative time formatting: "now", "4m", "3h", "2d", "3w", or short calendar date
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso == null || iso === "") {
    return "";
  }
  const parsedTime = Date.parse(iso);
  if (Number.isNaN(parsedTime)) {
    return "";
  }
  const elapsedSeconds = Math.max(0, (now - parsedTime) / 1000);
  if (elapsedSeconds < 45) {
    return "now";
  }
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }
  const elapsedDays = Math.round(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays}d`;
  }
  const elapsedWeeks = Math.round(elapsedDays / 7);
  if (elapsedWeeks < 5) {
    return `${elapsedWeeks}w`;
  }
  return new Date(parsedTime).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
// Formats milliseconds into human-readable duration strings ("450ms", "12s", "3m 45s", "2h 15m")
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "";
  }
  const positiveMs = Math.max(0, Math.round(ms));
  if (positiveMs < 1000) {
    return `${positiveMs}ms`;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
// Wall-clock time formatter: "3:42 PM" today, or "Sep 10, 3:42 PM", with year when different
export function formatClock(ms: number, now: number = Date.now()): string {
  const targetDate = new Date(ms);
  const referenceDate = new Date(now);
  const timeStr = targetDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (targetDate.toDateString() === referenceDate.toDateString()) {
    return timeStr;
  }
  const isSameYear = targetDate.getFullYear() === referenceDate.getFullYear();
  const dateOptions: Intl.DateTimeFormatOptions = isSameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  const dayStr = targetDate.toLocaleDateString(undefined, dateOptions);
  return `${dayStr}, ${timeStr}`;
}
// Full date and time representation for tooltips and detail views
export function formatFullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}
// Formats token throughput rate: "42 tok/s", with one decimal below 10
export function formatSpeed(tokensPerSecond: number): string {
  const formattedRate = tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond);
  return `${formattedRate} tok/s`;
}
// Session average token throughput: one decimal below 100, whole integer above
export function formatTokensPerSecond(tokensPerSecond: number): string {
  const numericText = tokensPerSecond < 100
    ? tokensPerSecond.toFixed(1).replace(/\.0$/, "")
    : String(Math.round(tokensPerSecond));
  return `${numericText} tok/s`;
}
// Running timer string: "42s", "7m", or "1h 7m"
export function formatElapsed(ms: number): string {
  const elapsedSec = Math.max(0, Math.floor(ms / 1000));
  if (elapsedSec < 60) {
    return `${elapsedSec}s`;
  }
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) {
    return `${elapsedMin}m`;
  }
  const elapsedHours = Math.floor(elapsedMin / 60);
  const remainingMin = elapsedMin % 60;
  return `${elapsedHours}h ${remainingMin}m`;
}
// Compact token count formatting: "450", "12k", "1.5M", "100M"
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const k = value / 1000;
    if (k >= 999.5) {
      // 999,500 and up round to a thousand thousands, which reads better as a million.
      return "1M";
    }
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
}
// Exact token count with commas for thousand separators
export function formatExactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
// Compact tokens for telemetry: 1 decimal place up to 100k
export function formatCompactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  if (value >= 1000 && value < 100_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return formatTokens(value);
}
// Returns filename from path string
export function basename(path: string): string {
  const strippedPath = path.replace(/[\\/]+$/, "");
  const segments = strippedPath.split(/[\\/]/);
  return segments[segments.length - 1] || strippedPath;
}
// Shortens path with middle ellipsis to fit within max characters
export function shortenPath(path: string, max: number = 48): string {
  if (path.length <= max) {
    return path;
  }
  const delimiter = path.includes("\\") ? "\\" : "/";
  const pathParts = path.split(/[\\/]/);
  let tailSegment = pathParts.pop() ?? "";
  while (pathParts.length > 1) {
    const prevSegment = pathParts[pathParts.length - 1] as string;
    if ((prevSegment + delimiter + tailSegment).length + 4 > max) {
      break;
    }
    tailSegment = prevSegment + delimiter + tailSegment;
    pathParts.pop();
  }
  const headSegment = pathParts[0] ?? "";
  return `${headSegment}${delimiter}...${delimiter}${tailSegment}`;
}
const ANSI_PATTERN = `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`;
// Scans from end of text to extract last non-empty line with ANSI stripped
export function lastLine(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const ansiRegex = new RegExp(ANSI_PATTERN, "g");
  let cursor = text.length;
  while (cursor > 0) {
    let lineEndPos = cursor;
    if (text[lineEndPos - 1] === "\n") {
      lineEndPos -= 1;
    }
    if (lineEndPos === 0) {
      return null;
    }
    const lineStartPos = text.lastIndexOf("\n", lineEndPos - 1) + 1;
    const candidateLine = text.slice(lineStartPos, lineEndPos).replace(ansiRegex, "").trim();
    if (candidateLine) {
      return candidateLine;
    }
    if (lineStartPos === 0) {
      return null;
    }
    cursor = lineStartPos;
  }
  return null;
}
// Converts identifier into human-readable words with capitalized first letter
export function humanize(identifier: string): string {
  const wordsText = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .trim()
    .toLowerCase();
  return wordsText.charAt(0).toUpperCase() + wordsText.slice(1);
}
// Parses JSON argument string safely
export function parseArgs(args: string | undefined): Record<string, unknown> | null {
  if (!args) {
    return null;
  }
  try {
    const decoded = JSON.parse(args) as unknown;
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function pickString(args: Record<string, unknown> | null, keys: string[]): string | null {
  if (!args) {
    return null;
  }
  for (const candidateKey of keys) {
    const val = args[candidateKey];
    if (typeof val === "string" && val.trim()) {
      return val;
    }
  }
  return null;
}
export type ToolKind =
  | "shell"
  | "read"
  | "edit"
  | "write"
  | "search"
  | "list"
  | "web"
  | "question"
  | "plan"
  | "agent"
  | "goal"
  | "generic";
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "targetFile"];
const PATTERN_KEYS = ["pattern", "query", "regex", "search", "q"];
// Classifies tool execution into ToolKind category
export function toolKind(tool: string | undefined, args: Record<string, unknown> | null): ToolKind {
  // Muse's goal tools, checked first so `create_goal` never reads as writing a file.
  if (tool && GOAL_TOOLS.has(tool)) {
    return "goal";
  }
  const extractedTokens = new Set(
    (tool ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const matchAny = (...candidates: string[]) => candidates.some((c) => extractedTokens.has(c));
  if (matchAny("ask", "question", "questions") || (matchAny("user") && matchAny("input"))) {
    return "question";
  }
  if (matchAny("todo", "todos", "plan", "todowrite")) {
    return "plan";
  }
  if (matchAny("web", "websearch", "webfetch", "fetch", "http", "browse", "browser", "url")) {
    return "web";
  }
  if (pickString(args, ["command", "cmd"]) || matchAny("bash", "shell", "exec", "execute", "run", "terminal", "powershell", "sh", "cmd")) {
    return "shell";
  }
  if (matchAny("grep", "search", "find", "glob", "rg", "ripgrep")) {
    return "search";
  }
  if (matchAny("edit", "multiedit", "patch", "replace", "apply", "modify")) {
    return "edit";
  }
  if (matchAny("write", "create", "save")) {
    return "write";
  }
  if (matchAny("read", "view", "cat", "open")) {
    return "read";
  }
  if (matchAny("list", "ls", "dir", "tree")) {
    return "list";
  }
  if (matchAny("agent", "task", "subagent", "delegate", "spawn")) {
    return "agent";
  }
  return "generic";
}
export interface ToolDescription {
  kind: ToolKind;
  verb: string;
  subject: string | null;
  mono: boolean;
  note: string | null;
}
const VERBS: Record<ToolKind, [string, string]> = {
  shell: ["Ran", "Running"],
  read: ["Read", "Reading"],
  edit: ["Edited", "Editing"],
  write: ["Wrote", "Writing"],
  search: ["Searched for", "Searching for"],
  list: ["Listed", "Listing"],
  web: ["Fetched", "Fetching"],
  question: ["Asked you", "Asking you"],
  plan: ["Updated the plan", "Updating the plan"],
  agent: ["Delegated", "Delegating"],
  goal: ["Updated the goal", "Updating the goal"],
  generic: ["Used", "Using"],
};
export function describeTool(item: MspItem): ToolDescription {
  const parsedArguments = parseArgs(item.args);
  const detectedKind = toolKind(item.tool, parsedArguments);
  const isInProgress = item.status === "inProgress";
  const selectedVerb = VERBS[detectedKind][isInProgress ? 1 : 0];
  const explanatoryNote = pickString(parsedArguments, ["description", "reason", "explanation"]);
  switch (detectedKind) {
    case "shell":
      return { kind: detectedKind, verb: selectedVerb, subject: pickString(parsedArguments, ["command", "cmd"]) ?? item.args ?? null, mono: true, note: explanatoryNote };
    case "read":
    case "edit":
    case "write":
    case "list":
      return { kind: detectedKind, verb: selectedVerb, subject: pickString(parsedArguments, PATH_KEYS) ?? pickString(parsedArguments, ["directory", "dir"]), mono: true, note: explanatoryNote };
    case "search": {
      const searchPattern = pickString(parsedArguments, PATTERN_KEYS);
      return { kind: detectedKind, verb: selectedVerb, subject: searchPattern, mono: true, note: pickString(parsedArguments, PATH_KEYS) ?? explanatoryNote };
    }
    case "web": {
      const targetUrl = pickString(parsedArguments, ["url", "uri"]);
      if (targetUrl) {
        return { kind: detectedKind, verb: selectedVerb, subject: targetUrl, mono: true, note: explanatoryNote };
      }
      return {
        kind: detectedKind,
        verb: isInProgress ? "Searching the web for" : "Searched the web for",
        subject: pickString(parsedArguments, PATTERN_KEYS),
        mono: false,
        note: explanatoryNote,
      };
    }
    case "question": {
      const questionsList = parsedArguments && Array.isArray(parsedArguments["questions"]) ? (parsedArguments["questions"] as Record<string, unknown>[]) : [];
      const primaryQuestion = questionsList[0];
      return {
        kind: detectedKind,
        verb: selectedVerb,
        subject: primaryQuestion && typeof primaryQuestion["question"] === "string" ? primaryQuestion["question"] : null,
        mono: false,
        note: null,
      };
    }
    case "plan":
      return { kind: detectedKind, verb: selectedVerb, subject: null, mono: false, note: explanatoryNote };
    case "agent":
      return { kind: detectedKind, verb: selectedVerb, subject: pickString(parsedArguments, ["description", "prompt", "objective", "task"]), mono: false, note: null };
    case "goal": {
      if (item.tool === "create_goal") {
        return { kind: detectedKind, verb: isInProgress ? "Setting a goal" : "Set a goal", subject: pickString(parsedArguments, ["objective"]), mono: false, note: null };
      }
      if (item.tool === "report_progress") {
        const percentString = parsedArguments && typeof parsedArguments["percent_complete"] === "number" ? `${Math.round(parsedArguments["percent_complete"])}%` : null;
        return {
          kind: detectedKind,
          verb: isInProgress ? "Reporting progress" : "Reported progress",
          subject: percentString,
          mono: false,
          note: pickString(parsedArguments, ["current_work", "next_work"]),
        };
      }
      if (item.tool === "update_goal") {
        const goalStatus = pickString(parsedArguments, ["status"]);
        return {
          kind: detectedKind,
          verb: isInProgress ? "Updating the goal" : "Marked the goal",
          subject: goalStatus === "complete" ? "done" : goalStatus,
          mono: false,
          note: null,
        };
      }
      return { kind: detectedKind, verb: isInProgress ? "Checking the goal" : "Checked the goal", subject: null, mono: false, note: null };
    }
    default: {
      const fallbackString = parsedArguments ? Object.values(parsedArguments).find((v): v is string => typeof v === "string" && v.length < 160) : null;
      return {
        kind: detectedKind,
        verb: isInProgress ? "Using" : "Used",
        subject: item.tool ? humanize(item.tool) : "a tool",
        mono: false,
        note: fallbackString ?? null,
      };
    }
  }
}
export interface DiffRow {
  kind: "same" | "del" | "add";
  text: string;
}
export interface DiffHunk {
  rows: DiffRow[];
}
export type DiffView = { path: string | null; hunks: DiffHunk[] } | { path: string | null; patch: string };
function lines(value: unknown): string[] {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").split("\n") : [];
}
/** Old/new line pairs past this skip the alignment table and read as two plain blocks. */
export const ALIGN_CELL_LIMIT = 250_000;
export function alignLines(removed: string[], added: string[]): DiffRow[] {
  if (removed.length === 0) {
    return added.map((text) => ({ kind: "add" as const, text }));
  }
  if (added.length === 0) {
    return removed.map((text) => ({ kind: "del" as const, text }));
  }
  if (removed.length * added.length > ALIGN_CELL_LIMIT) {
    return [
      ...removed.map((text) => ({ kind: "del" as const, text })),
      ...added.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const gridWidth = added.length + 1;
  const lcsMatrix = new Uint32Array((removed.length + 1) * gridWidth);
  for (let rIdx = 1; rIdx <= removed.length; rIdx += 1) {
    for (let aIdx = 1; aIdx <= added.length; aIdx += 1) {
      lcsMatrix[rIdx * gridWidth + aIdx] =
        removed[rIdx - 1] === added[aIdx - 1]
          ? (lcsMatrix[(rIdx - 1) * gridWidth + (aIdx - 1)] as number) + 1
          : Math.max(lcsMatrix[(rIdx - 1) * gridWidth + aIdx] as number, lcsMatrix[rIdx * gridWidth + (aIdx - 1)] as number);
    }
  }
  const alignedResultRows: DiffRow[] = [];
  let rPointer = removed.length;
  let aPointer = added.length;
  while (rPointer > 0 || aPointer > 0) {
    if (rPointer > 0 && aPointer > 0 && removed[rPointer - 1] === added[aPointer - 1]) {
      alignedResultRows.push({ kind: "same", text: removed[rPointer - 1] as string });
      rPointer -= 1;
      aPointer -= 1;
    } else if (aPointer > 0 && (rPointer === 0 || (lcsMatrix[rPointer * gridWidth + (aPointer - 1)] as number) >= (lcsMatrix[(rPointer - 1) * gridWidth + aPointer] as number))) {
      alignedResultRows.push({ kind: "add", text: added[aPointer - 1] as string });
      aPointer -= 1;
    } else {
      alignedResultRows.push({ kind: "del", text: removed[rPointer - 1] as string });
      rPointer -= 1;
    }
  }
  return alignedResultRows.reverse();
}
interface EchoBlock {
  removed: string[];
  added: string[];
}
function splitDiffEcho(output: string): { blocks: EchoBlock[]; rest: string } | null {
  const rawOutputLines = output.replace(/\r\n/g, "\n").split("\n");
  let lineIdx = 0;
  const collectedBlocks: EchoBlock[] = [];
  for (;;) {
    const headerLines = rawOutputLines.slice(lineIdx, lineIdx + 5);
    if (
      headerLines.length < 5 ||
      !/^edited\b/.test(headerLines[0] as string) ||
      !(headerLines[1] as string).startsWith("changed lines:") ||
      headerLines[2] !== "--- original" ||
      headerLines[3] !== "+++ updated" ||
      !(headerLines[4] as string).startsWith("@@")
    ) {
      break;
    }
    lineIdx += 5;
    const currentBlock: EchoBlock = { removed: [], added: [] };
    while (lineIdx < rawOutputLines.length) {
      const curLine = rawOutputLines[lineIdx] as string;
      if (curLine.startsWith("+")) {
        currentBlock.added.push(curLine.slice(1));
      } else if (curLine.startsWith("-")) {
        currentBlock.removed.push(curLine.slice(1));
      } else if (curLine === "") {
        currentBlock.removed.push("");
        currentBlock.added.push("");
      } else if (!curLine.startsWith("\\ No newline")) {
        break;
      }
      lineIdx += 1;
    }
    collectedBlocks.push(currentBlock);
  }
  if (collectedBlocks.length === 0) {
    return null;
  }
  return { blocks: collectedBlocks, rest: rawOutputLines.slice(lineIdx).join("\n") };
}
export function withoutDiffEcho(output: string): string | null {
  return splitDiffEcho(output)?.rest ?? null;
}
export function diffFromEcho(output: string, path: string | null): DiffView | null {
  const parsedEcho = splitDiffEcho(output);
  if (!parsedEcho) {
    return null;
  }
  const reconstructedHunks = parsedEcho.blocks.map((b) => ({ rows: alignLines(b.removed, b.added) }));
  if (!reconstructedHunks.some((hunk) => hunk.rows.length > 0)) {
    return null;
  }
  return { path, hunks: reconstructedHunks };
}
export function extractDiff(item: MspItem): DiffView | null {
  const parsedArgs = parseArgs(item.args);
  if (!parsedArgs) {
    return null;
  }
  const targetPath = pickString(parsedArgs, PATH_KEYS);
  const oldTextKey = ["old_string", "oldString", "old_str", "find", "search", "old"].find((k) => typeof parsedArgs[k] === "string");
  const newTextKey = ["new_string", "newString", "new_str", "replace", "new"].find((k) => typeof parsedArgs[k] === "string");
  if (oldTextKey && newTextKey) {
    return { path: targetPath, hunks: [{ rows: alignLines(lines(parsedArgs[oldTextKey]), lines(parsedArgs[newTextKey])) }] };
  }
  if (Array.isArray(parsedArgs["edits"])) {
    const editHunks: DiffHunk[] = [];
    for (const editEntry of parsedArgs["edits"] as unknown[]) {
      const editObj = editEntry && typeof editEntry === "object" ? (editEntry as Record<string, unknown>) : null;
      if (!editObj) {
        continue;
      }
      const oldStr = editObj["old_string"] ?? editObj["oldString"] ?? editObj["old_str"];
      const newStr = editObj["new_string"] ?? editObj["newString"] ?? editObj["new_str"];
      if (typeof oldStr === "string" || typeof newStr === "string") {
        editHunks.push({ rows: alignLines(lines(oldStr), lines(newStr)) });
      }
    }
    if (editHunks.length > 0) {
      return { path: targetPath, hunks: editHunks };
    }
  }
  const rawPatchText = pickString(parsedArgs, ["patch", "diff", "input"]);
  if (rawPatchText && /^(\*\*\* |--- |\+\+\+ |@@|diff --git)/m.test(rawPatchText)) {
    return { path: targetPath, patch: rawPatchText };
  }
  const rawContentText = pickString(parsedArgs, ["content", "contents", "text", "file_text"]);
  if (rawContentText && toolKind(item.tool, parsedArgs) === "write") {
    return { path: targetPath, hunks: [{ rows: alignLines([], lines(rawContentText)) }] };
  }
  if (item.visibleOutput && !item.truncated) {
    const evaluatedKind = toolKind(item.tool, parsedArgs);
    if (evaluatedKind === "edit" || evaluatedKind === "write") {
      return diffFromEcho(item.visibleOutput, targetPath);
    }
  }
  return null;
}
export function diffStats(diff: DiffView): { added: number; removed: number } {
  if ("patch" in diff) {
    let addedCount = 0;
    let removedCount = 0;
    for (const patchLine of diff.patch.split("\n")) {
      if (patchLine.startsWith("+") && !patchLine.startsWith("+++")) {
        addedCount += 1;
      } else if (patchLine.startsWith("-") && !patchLine.startsWith("---")) {
        removedCount += 1;
      }
    }
    return { added: addedCount, removed: removedCount };
  }
  let addedCount = 0;
  let removedCount = 0;
  for (const currentHunk of diff.hunks) {
    for (const rowItem of currentHunk.rows) {
      if (rowItem.kind === "add") {
        addedCount += 1;
      } else if (rowItem.kind === "del") {
        removedCount += 1;
      }
    }
  }
  return { added: addedCount, removed: removedCount };
}
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
}
export function diffLines(diff: DiffView): DiffLine[] {
  const outputLines: DiffLine[] = [];
  if ("patch" in diff) {
    for (const patchLine of diff.patch.split("\n")) {
      if (/^(\+\+\+|---|\*\*\*|@@|diff )/.test(patchLine)) {
        outputLines.push({ kind: "meta", text: patchLine });
      } else if (patchLine.startsWith("+")) {
        outputLines.push({ kind: "add", text: patchLine.slice(1) });
      } else if (patchLine.startsWith("-")) {
        outputLines.push({ kind: "del", text: patchLine.slice(1) });
      } else {
        outputLines.push({ kind: "ctx", text: patchLine.startsWith(" ") ? patchLine.slice(1) : patchLine });
      }
    }
    return outputLines;
  }
  diff.hunks.forEach((hunkItem, hunkIdx) => {
    if (hunkIdx > 0) {
      outputLines.push({ kind: "meta", text: "..." });
    }
    for (const hunkRow of hunkItem.rows) {
      outputLines.push({ kind: hunkRow.kind === "same" ? "ctx" : hunkRow.kind, text: hunkRow.text });
    }
  });
  return outputLines;
}
export function mergeDiffLines(diffs: DiffView[]): DiffLine[] {
  const combinedDiffLines: DiffLine[] = [];
  diffs.forEach((diffItem, diffIdx) => {
    if (diffIdx > 0) {
      combinedDiffLines.push({ kind: "meta", text: "..." });
    }
    combinedDiffLines.push(...diffLines(diffItem));
  });
  return combinedDiffLines;
}
export interface ApprovalDescription {
  title: string;
  detail: string | null;
  mono: boolean;
}
export function describeApproval(request: ApprovalRequest): ApprovalDescription {
  const targetSubject = request.subject ?? { kind: "tool" };
  const assembledStagesCommand = targetSubject.stages?.map((s) => s.argv.join(" ")).join(" | ");
  switch (targetSubject.kind) {
    case "shell":
      return { title: "Run a shell command", detail: targetSubject.command ?? assembledStagesCommand ?? request.rawArgs ?? null, mono: true };
    case "fileAccess": {
      const accessKind = targetSubject.access ? targetSubject.access.toLowerCase() : "access";
      const actionVerb = accessKind.includes("write") ? "Write to" : accessKind.includes("read") ? "Read" : "Access";
      return { title: `${actionVerb} a file`, detail: targetSubject.path ?? targetSubject.target ?? null, mono: true };
    }
    case "network": {
      const networkDestination = targetSubject.host
        ? `${targetSubject.protocol ? `${targetSubject.protocol}://` : ""}${targetSubject.host}${targetSubject.port ? `:${targetSubject.port}` : ""}`
        : (targetSubject.target ?? null);
      return { title: "Connect to the network", detail: networkDestination, mono: true };
    }
    case "process":
      return { title: "Start a process", detail: targetSubject.command ?? targetSubject.target ?? assembledStagesCommand ?? null, mono: true };
    case "tool":
      return {
        title: `Use the ${humanize(targetSubject.toolName ?? request.toolName ?? "tool").toLowerCase()} tool`,
        detail: request.rawArgs ?? null,
        mono: true,
      };
    default:
      return {
        title: `Allow ${humanize(targetSubject.kind).toLowerCase()}`,
        detail: targetSubject.command ?? targetSubject.path ?? targetSubject.target ?? request.rawArgs ?? null,
        mono: true,
      };
  }
}
export function modelDisplayName(modelId: string | null | undefined): string {
  if (!modelId) {
    return "Default model";
  }
  // The server files calls that carry no model id under this word.
  if (modelId === "unknown") {
    return "Unknown model";
  }
  return modelId.replace(/-contributor$/i, "");
}
