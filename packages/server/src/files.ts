// Workspace file operations: inspection, classification, streaming, and editing
import * as filePromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as pathEngine from "node:path";
import * as streamPromises from "node:stream/promises";
import { SANDBOX_CSP } from "./attachments.js";
const { lstat, open, readdir, realpath, rename, stat, unlink, writeFile } = filePromises;
const { basename, extname, join, relative, resolve, sep } = pathEngine;
const { pipeline } = streamPromises;
/** Error produced during file system operations with HTTP status and discriminator kind. */
export class FileError extends Error {
  readonly status: number;
  readonly kind: string | null;
  constructor(status: number, message: string, kind: string | null = null) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.name = "FileError";
    Object.setPrototypeOf(this, FileError.prototype);
  }
}
export type FileKind = | "text" | "markdown" | "image" | "video" | "audio" | "pdf" | "binary";
export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  mtimeMs: number;
}
export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}
export interface FileRead {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  kind: FileKind;
  mediaType: string;
  content?: string;
  truncated: boolean;
}
const MAX_ENTRIES = 5000;
export const MAX_TEXT_BYTES: number = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const DIRECTORIES_TO_SKIP = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
]);
const IMAGE_MIME_REGISTRY: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
};
const VIDEO_MIME_REGISTRY: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".ogv": "video/ogg",
};
const AUDIO_MIME_REGISTRY: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".m4a": "audio/mp4", ".flac": "audio/flac",
};
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".mdown"]);
/** Inspects filename extension and initial byte buffer to classify file kind and media type. */
export function classifyFile(fileName: string, initialBuffer: Uint8Array): { kind: FileKind; mediaType: string } {
  const extension = extname(fileName).toLowerCase();
  if (IMAGE_MIME_REGISTRY[extension]) {
    return { kind: "image", mediaType: IMAGE_MIME_REGISTRY[extension] };
  }
  if (VIDEO_MIME_REGISTRY[extension]) {
    return { kind: "video", mediaType: VIDEO_MIME_REGISTRY[extension] };
  }
  if (AUDIO_MIME_REGISTRY[extension]) {
    return { kind: "audio", mediaType: AUDIO_MIME_REGISTRY[extension] };
  }
  if (extension === ".pdf") {
    return { kind: "pdf", mediaType: "application/pdf" };
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return { kind: "markdown", mediaType: "text/markdown" };
  }
  const containsNullByte = initialBuffer.includes(0);
  return containsNullByte
    ? { kind: "binary", mediaType: "application/octet-stream" }
    : { kind: "text", mediaType: "text/plain" };
}
/** Formats relative path using forward slashes. */
function formatRelativePath(baseDirectory: string, absoluteTarget: string): string {
  return relative(baseDirectory, absoluteTarget).split(sep).join("/");
}
// Resolves a requested relative or display path against a project root, preventing path traversal.
export async function resolveInRoot(
  projectRoot: string, userRequestedPath: string, displayRoot: string,
  resolutionOptions: { mustExist?: boolean } = {},
): Promise<{ abs: string; rel: string }> {
  let normalizedInput = userRequestedPath.trim().replace(/\\/g, "/");
  const normalizedDisplay = displayRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedDisplay && (normalizedInput === normalizedDisplay || normalizedInput.startsWith(`${normalizedDisplay}/`))) {
    normalizedInput = normalizedInput.slice(normalizedDisplay.length);
  }
  normalizedInput = normalizedInput.replace(/^\/+/, "").replace(/^\.\//, "");
  const hasDrivePrefix = /^[A-Za-z]:\//.test(normalizedInput);
  const segments = normalizedInput.split("/");
  if (hasDrivePrefix || segments.includes("..")) {
    throw new FileError(403, `That file is outside this project.`);
  }
  const canonicalRoot = await realpath(projectRoot).catch(() => {
    throw new FileError(404, `This project's folder is not there anymore.`);
  });
  const targetAbsolute = resolve(canonicalRoot, ...segments.filter(Boolean));
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(targetAbsolute);
  } catch {
    if (resolutionOptions.mustExist === false) {
      return { abs: targetAbsolute, rel: formatRelativePath(canonicalRoot, targetAbsolute) };
    }
    throw new FileError(404, `That file does not exist.`);
  }
  const rootBoundaryPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(rootBoundaryPrefix)) {
    throw new FileError(403, `That file is outside this project.`);
  }
  return { abs: canonicalTarget, rel: formatRelativePath(canonicalRoot, canonicalTarget) };
}
/** Lists folder contents with directories ordered before files in alphanumeric order. */
export async function listFolder(
  projectRoot: string,
  displayRoot: string,
  userRequestedPath: string,
): Promise<FileListing> {
  const { abs: folderAbs, rel: folderRel } = await resolveInRoot(projectRoot, userRequestedPath || ".", displayRoot);
  const directoryStat = await stat(folderAbs);
  if (!directoryStat.isDirectory()) {
    throw new FileError(400, `That is a file, not a folder.`);
  }
  const childNames = await readdir(folderAbs);
  const listingEntries: FileEntry[] = [];
  const boundedNames = childNames.slice(0, MAX_ENTRIES);
  for (const childName of boundedNames) {
    const childPath = join(folderAbs, childName);
    const itemStat = await stat(childPath).catch(() => null);
    if (!itemStat) {
      continue;
    }
    listingEntries.push({
      name: childName,
      path: folderRel ? `${folderRel}/${childName}` : childName,
      kind: itemStat.isDirectory() ? "dir" : "file",
      size: itemStat.isDirectory() ? 0 : itemStat.size,
      mtimeMs: Math.round(itemStat.mtimeMs),
    });
  }
  const stringCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  listingEntries.sort((first, second) => {
    if (first.kind === second.kind) {
      return stringCollator.compare(first.name, second.name);
    }
    return first.kind === "dir" ? -1 : 1;
  });
  return {
    path: folderRel,
    entries: listingEntries,
    truncated: childNames.length > MAX_ENTRIES,
  };
}
/** Reads project file content for viewer, loading text inline and describing media. */
export async function readProjectFile(
  projectRoot: string,
  displayRoot: string,
  userRequestedPath: string,
): Promise<FileRead> {
  const { abs: fileAbs, rel: fileRel } = await resolveInRoot(projectRoot, userRequestedPath, displayRoot);
  const fileStat = await stat(fileAbs);
  if (fileStat.isDirectory()) {
    throw new FileError(400, `That is a folder, not a file.`);
  }
  const openedHandle = await open(fileAbs, "r");
  try {
    const inspectHeaderSize = Math.min(fileStat.size, 8192);
    const headerBuffer = new Uint8Array(inspectHeaderSize);
    await openedHandle.read(headerBuffer, 0, inspectHeaderSize, 0);
    const { kind: detectedKind, mediaType: detectedMediaType } = classifyFile(basename(fileAbs), headerBuffer);
    const baseSummary = {
      path: fileRel,
      name: basename(fileAbs),
      size: fileStat.size,
      mtimeMs: Math.round(fileStat.mtimeMs),
      kind: detectedKind,
      mediaType: detectedMediaType,
      truncated: false,
    };
    if (detectedKind !== "text" && detectedKind !== "markdown") {
      return baseSummary;
    }
    const readableTextLength = Math.min(fileStat.size, MAX_TEXT_BYTES);
    const textBuffer = Buffer.alloc(readableTextLength);
    await openedHandle.read(textBuffer, 0, readableTextLength, 0);
    return {
      ...baseSummary,
      content: textBuffer.toString("utf8"),
      truncated: fileStat.size > MAX_TEXT_BYTES,
    };
  } finally {
    await openedHandle.close();
  }
}
/** Atomically writes edited file content to disk with optimistic concurrency verification. */
export async function writeProjectFile(
  projectRoot: string, displayRoot: string, userRequestedPath: string,
  fileContent: string, expectedBaseMtimeMs: number | null,
): Promise<{ path: string; size: number; mtimeMs: number }> {
  const encodedContentBytes = Buffer.from(fileContent, "utf8");
  if (encodedContentBytes.length > MAX_WRITE_BYTES) {
    throw new FileError(413, `That file is too large to save from here.`);
  }
  const { abs: writeTargetAbs, rel: writeTargetRel } = await resolveInRoot(projectRoot, userRequestedPath, displayRoot);
  const existingStat = await lstat(writeTargetAbs);
  if (!existingStat.isFile()) {
    throw new FileError(400, `Only a regular file can be saved.`);
  }
  if (expectedBaseMtimeMs !== null && Math.round(existingStat.mtimeMs) !== expectedBaseMtimeMs) {
    throw new FileError(409, `This file changed on disk since you opened it.`, "fileChanged");
  }
  const temporaryFilePath = join(writeTargetAbs, "..", `.${basename(writeTargetAbs)}.ancilla-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporaryFilePath, encodedContentBytes, { mode: existingStat.mode });
    await rename(temporaryFilePath, writeTargetAbs);
  } catch (ioFailure) {
    await unlink(temporaryFilePath).catch(() => undefined);
    throw ioFailure;
  }
  const verifiedStat = await stat(writeTargetAbs);
  return { path: writeTargetRel, size: verifiedStat.size, mtimeMs: Math.round(verifiedStat.mtimeMs) };
}
/** Searches workspace files matching query tokens in breadth-first directory order. */
export async function searchProjectFiles(projectRoot: string, searchQuery: string, maxResultsLimit = 60): Promise<FileEntry[]> {
  const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) {
    return [];
  }
  const canonicalRoot = await realpath(projectRoot).catch(() => {
    throw new FileError(404, `This project's folder is not there anymore.`);
  });
  const accumulatedMatches: FileEntry[] = [];
  const searchQueue: string[] = [canonicalRoot];
  let visitedDirectoryCount = 0;
  while (searchQueue.length > 0 && accumulatedMatches.length < maxResultsLimit && visitedDirectoryCount < 20_000) {
    const currentDirectory = searchQueue.shift() as string;
    const directoryEntries = await readdir(currentDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of directoryEntries) {
      visitedDirectoryCount += 1;
      const entryAbsolute = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!DIRECTORIES_TO_SKIP.has(entry.name)) {
          searchQueue.push(entryAbsolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const entryRelative = formatRelativePath(canonicalRoot, entryAbsolute);
      const lowerRelative = entryRelative.toLowerCase();
      const matchesAllWords = queryWords.every((wordToken) => lowerRelative.includes(wordToken));
      if (matchesAllWords) {
        const entryStat = await stat(entryAbsolute).catch(() => null);
        accumulatedMatches.push({
          name: entry.name,
          path: entryRelative,
          kind: "file",
          size: entryStat?.size ?? 0,
          mtimeMs: Math.round(entryStat?.mtimeMs ?? 0),
        });
        if (accumulatedMatches.length >= maxResultsLimit) {
          break;
        }
      }
    }
  }
  const lastQueryToken = queryWords[queryWords.length - 1] as string;
  return accumulatedMatches.sort((a, b) => {
    const aIncludesLast = a.name.toLowerCase().includes(lastQueryToken);
    const bIncludesLast = b.name.toLowerCase().includes(lastQueryToken);
    return Number(!aIncludesLast) - Number(!bIncludesLast) || a.path.length - b.path.length;
  });
}
/** Serves project file content over HTTP with byte range support and security headers. */
export async function serveProjectFile(
  incomingReq: IncomingMessage,
  serverResponse: ServerResponse,
  projectRoot: string,
  displayRoot: string,
  requestedFile: string,
): Promise<void> {
  const { abs: fileAbs } = await resolveInRoot(projectRoot, requestedFile, displayRoot);
  const targetStat = await stat(fileAbs);
  if (!targetStat.isFile()) {
    throw new FileError(400, `That is not a file.`);
  }
  const fileDescriptor = await open(fileAbs, "r");
  let isStreamingActive = false;
  try {
    const sniffSize = Math.min(targetStat.size, 8192);
    const sniffHeader = new Uint8Array(sniffSize);
    await fileDescriptor.read(sniffHeader, 0, sniffSize, 0);
    const { kind: detectedKind, mediaType: detectedMediaType } = classifyFile(basename(fileAbs), sniffHeader);
    const responseContentType = detectedKind === "text" || detectedKind === "markdown"
      ? "text/plain; charset=utf-8"
      : detectedMediaType;
    const responseHeaders: Record<string, string> = {
      "content-type": responseContentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
      "content-disposition": "inline",
    };
    if (detectedKind !== "pdf") {
      responseHeaders["content-security-policy"] = SANDBOX_CSP;
    }
    const rangeHeaderValue = String(incomingReq.headers["range"] ?? "");
    const parsedRange = /^bytes=(\d*)-(\d*)$/.exec(rangeHeaderValue);
    if (parsedRange && targetStat.size > 0 && (parsedRange[1] || parsedRange[2])) {
      let rangeStart = parsedRange[1] ? Number(parsedRange[1]) : Math.max(0, targetStat.size - Number(parsedRange[2]));
      let rangeEnd = parsedRange[1] && parsedRange[2] ? Number(parsedRange[2]) : targetStat.size - 1;
      rangeEnd = Math.min(rangeEnd, targetStat.size - 1);
      rangeStart = Math.min(rangeStart, rangeEnd);
      serverResponse.writeHead(206, {
        ...responseHeaders,
        "content-range": `bytes ${rangeStart}-${rangeEnd}/${targetStat.size}`,
        "content-length": String(rangeEnd - rangeStart + 1),
      });
      if (incomingReq.method === "HEAD") {
        serverResponse.end();
        return;
      }
      isStreamingActive = true;
      await pipeFile(serverResponse, fileDescriptor, { start: rangeStart, end: rangeEnd });
      return;
    }
    serverResponse.writeHead(200, {
      ...responseHeaders,
      "content-length": String(targetStat.size),
    });
    if (incomingReq.method === "HEAD") {
      serverResponse.end();
      return;
    }
    isStreamingActive = true;
    await pipeWholeFile(serverResponse, fileDescriptor, targetStat.size);
  } finally {
    if (!isStreamingActive) {
      await fileDescriptor.close().catch(() => undefined);
    }
  }
}
/** Pipes file read stream to HTTP response with automatic error and descriptor cleanup. */
export async function pipeFile(
  serverResponse: ServerResponse,
  fileHandle: FileHandle,
  rangeBounds?: { start: number; end: number },
): Promise<void> {
  const readStream = fileHandle.createReadStream(rangeBounds ? { start: rangeBounds.start, end: rangeBounds.end } : {});
  try {
    await pipeline(readStream, serverResponse);
  } catch {
    readStream.destroy();
    serverResponse.destroy();
  }
}
/** Pipes complete file up to specified length, closing descriptor immediately for empty files. */
export async function pipeWholeFile(serverResponse: ServerResponse, fileHandle: FileHandle, totalByteSize: number): Promise<void> {
  if (totalByteSize <= 0) {
    await fileHandle.close().catch(() => undefined);
    serverResponse.end();
    return;
  }
  await pipeFile(serverResponse, fileHandle, { start: 0, end: totalByteSize - 1 });
}
