/**
 * Path parsing and normalization utilities for workspace and project selection.
 * Handles POSIX paths, Windows drive paths, UNC shares, and Git URLs.
 */

export interface BrowsePath {
  /** Directory path up to and including the trailing separator. Empty string if none. */
  directory: string;
  /** Leaf filename or directory prefix following the last separator. */
  leaf: string;
  /** Separator character identified in the input. */
  separator: "/" | "\\";
}

/**
 * Splits a file browser input string into its base directory and filtering leaf.
 */
export function splitBrowsePath(input: string): BrowsePath {
  const lastSlash = input.lastIndexOf("/");
  const lastBackslash = input.lastIndexOf("\\");
  const cutPoint = Math.max(lastSlash, lastBackslash);

  if (cutPoint < 0) {
    return { directory: "", leaf: input, separator: "/" };
  }

  const separator: "/" | "\\" = input[cutPoint] === "\\" ? "\\" : "/";
  return {
    directory: input.slice(0, cutPoint + 1),
    leaf: input.slice(cutPoint + 1),
    separator,
  };
}

/**
 * Evaluates whether an input represents a root-anchored filesystem path.
 * Matches `~/`, `/`, `C:\`, `C:/`, or `\\server\share`.
 */
export function isFullPath(input: string): boolean {
  return /^(~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/.test(input);
}

/**
 * Appends the specified separator to a path string if not already present.
 */
export function withTrailingSeparator(path: string, separator: string): string {
  return /[\\/]$/.test(path) ? path : `${path}${separator}`;
}

/**
 * Resolves the parent directory ending with a separator, or null if no parent exists.
 */
export function parentFolder(path: string): string | null {
  const cleanPath = path.trim().replace(/[\\/]+$/, "");
  const lastSlash = Math.max(cleanPath.lastIndexOf("/"), cleanPath.lastIndexOf("\\"));
  if (lastSlash < 0) {
    return null;
  }
  return cleanPath.slice(0, lastSlash + 1);
}

/**
 * Compares two paths for folder equivalence, normalizing separators, trailing slashes,
 * and Windows drive-letter casing.
 */
export function sameFolder(a: string, b: string): boolean {
  const normalize = (target: string): string => {
    const formatted = target.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[A-Za-z]:/.test(formatted) ? formatted.toLowerCase() : formatted;
  };
  return normalize(a) === normalize(b);
}

/**
 * Converts user repository input into a fully qualified clone URL.
 * Recognizes owner/repo GitHub shorthand, HTTPS/SSH URLs, and git@ host formats.
 */
export function cloneUrl(input: string): string | null {
  const raw = input.trim();
  const shorthandMatch = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  if (shorthandMatch) {
    const [, owner, repo] = shorthandMatch;
    return `https://github.com/${owner}/${repo}.git`;
  }

  const isStandardUrl = /^(https?:\/\/|ssh:\/\/|git:\/\/)\S+$/.test(raw);
  const isScpSyntax = /^git@[^\s:]+:\S+$/.test(raw);

  if (isStandardUrl || isScpSyntax) {
    return raw;
  }

  return null;
}

/**
 * Extracts the default repository directory name from a Git clone URL.
 */
export function repoName(url: string): string {
  const stripped = url.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "");
  const segments = stripped.split(/[\\/:]/);
  return segments[segments.length - 1] || "repository";
}
