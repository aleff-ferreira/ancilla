// Workspace file target resolution, path normalization, and size formatting
/** Line range spanning start line to end line (inclusive, 1-based). */
export interface LineRange {
  start: number;
  end: number;
}
/** Resolved file target within workspace with optional line selection. */
export interface FileTarget {
  /** Relative path within project if resolved internally, or verbatim path string. */
  path: string;
  line: LineRange | null;
}
const LINE_NUMBER_SUFFIX_REGEX = /:(\d+)(?:[-:](\d+))?$/;
const HASH_LINE_RANGE_REGEX = /#L(\d+)(?:-L?(\d+))?$/;
function parseLineBounds(startStr?: string, endStr?: string): LineRange | null {
  const fromLine = startStr ? Number(startStr) : Number.NaN;
  if (!Number.isInteger(fromLine) || fromLine < 1) {
    return null;
  }
  const toLine = endStr ? Number(endStr) : fromLine;
  return {
    start: fromLine,
    end: Number.isInteger(toLine) && toLine >= fromLine ? toLine : fromLine,
  };
}
// Standardizes paths by replacing backslashes with forward slashes and stripping trailing slashes.
function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
}
// Resolves an absolute path relative to the given working directory.
// Returns relative path string, or "" if identical to cwd, or null if outside.
// Handles Windows drive paths case-insensitively.
export function relativeToProject(cwd: string, abs: string): string | null {
  const root = normalizePath(cwd);
  const target = normalizePath(abs);
  const isWindowsDrive = /^[A-Za-z]:\//.test(root);
  const areEqual = (a: string, b: string): boolean => {
    return isWindowsDrive ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  if (areEqual(target, root)) {
    return "";
  }
  const rootPrefix = `${root}/`;
  if (areEqual(target.slice(0, rootPrefix.length), rootPrefix)) {
    return target.slice(rootPrefix.length);
  }
  return null;
}
const NON_FILE_SCHEME_REGEX = /^(?:https?|mailto|tel|data|javascript|vscode|cursor):/i;
// Resolves a raw file link or transcript reference into a canonical FileTarget.
// Strips non-file protocol schemes, extracts line numbers (#L10-L20 or :15),
// and normalizes relative paths against baseDir.
export function fileTarget(
  raw: string | null | undefined,
  cwd: string,
  baseDir = "",
): FileTarget | null {
  if (raw == null || raw === "") {
    return null;
  }
  let text = raw.trim();
  if (!text || text.startsWith("#") || NON_FILE_SCHEME_REGEX.test(text)) {
    return null;
  }
  text = text.replace(/^file:\/\//i, "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Retain verbatim text if URL decoding fails
  }
  let lineRange: LineRange | null = null;
  const hashMatch = HASH_LINE_RANGE_REGEX.exec(text);
  if (hashMatch) {
    lineRange = parseLineBounds(hashMatch[1], hashMatch[2]);
    text = text.slice(0, hashMatch.index);
  } else {
    const suffixMatch = LINE_NUMBER_SUFFIX_REGEX.exec(text);
    // Guard against Windows drive letter colon being treated as line number (e.g. C:)
    if (suffixMatch && suffixMatch.index > 1) {
      lineRange = parseLineBounds(suffixMatch[1], suffixMatch[2]);
      text = text.slice(0, suffixMatch.index);
    }
  }
  text = text.replace(/[?#].*$/, "");
  if (!text) {
    return null;
  }
  const isAbsolute = text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text);
  if (isAbsolute) {
    const insideProject = relativeToProject(cwd, text);
    return {
      path: insideProject ?? normalizePath(text),
      line: lineRange,
    };
  }
  const normalizedBase = normalizePath(baseDir);
  const pathSegments: string[] = normalizedBase ? normalizedBase.split("/") : [];
  for (const segment of text.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      pathSegments.pop();
    } else {
      pathSegments.push(segment);
    }
  }
  return {
    path: pathSegments.join("/"),
    line: lineRange,
  };
}
const KNOWN_CODE_EXTENSIONS = new Set(
  "md mdx markdown txt json jsonc yaml yml toml ini lock ts tsx js jsx mjs cjs py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql html htm css scss less vue svelte astro xml svg png jpg jpeg gif webp avif ico mp4 webm mov mp3 wav pdf csv tsv log liquid graphql gql proto dockerfile makefile gradle lua dart ex exs erl zig nim r jl scala clj tf hcl".split(
    " ",
  ),
);
// Heuristically tests whether inline code spans refer to a workspace file path.
export function looksLikeFilePath(text: string): boolean {
  const normalizedText = text.trim();
  if (normalizedText.length < 3 || normalizedText.length > 240 || /\s/.test(normalizedText) || /^[a-z]+:\/\//i.test(normalizedText)) {
    return false;
  }
  const stripped = normalizedText.replace(LINE_NUMBER_SUFFIX_REGEX, "");
  // Recognized dotfiles (.env, .gitignore, etc.)
  if (/^\.[A-Za-z0-9_-]+$/.test(stripped)) {
    return true;
  }
  // File extension checks
  if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(stripped) || /[()<>{}=;,"'`$]/.test(stripped)) {
    return false;
  }
  const ext = stripped.slice(stripped.lastIndexOf(".") + 1).toLowerCase();
  return stripped.includes("/") || KNOWN_CODE_EXTENSIONS.has(ext);
}
const MARKDOWN_EXTENSION_REGEX = /\.(md|markdown|mdx|mdown)$/i;
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION_REGEX.test(path);
}
/** Returns the parent directory portion of a project-relative path. */
export function dirnameOf(path: string): string {
  const cutIndex = path.lastIndexOf("/");
  return cutIndex < 0 ? "" : path.slice(0, cutIndex);
}
/** Returns the filename component of a path. */
export function basenameOf(path: string): string {
  const cutIndex = path.lastIndexOf("/");
  return cutIndex < 0 ? path : path.slice(cutIndex + 1);
}
/** Generates a composite cache key from working directory and relative path. */
export function fileKey(cwd: string, path: string): string {
  return `${cwd}\n${path}`;
}
/** Formats byte counts into human-readable B, KB, or MB units. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const inKb = bytes / 1024;
    return `${inKb.toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  const inMb = bytes / (1024 * 1024);
  return `${inMb.toFixed(1)} MB`;
}
