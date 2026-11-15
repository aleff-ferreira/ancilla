// Path utilities for Ancilla host and WSL environments
import fs from "node:fs/promises";
import nodePath from "node:path";

/** Host environment context for resolving workspace and filesystem paths. */
export interface PathContext {
  platform: string;
  home: string;
  distro?: string | null;
}

/** Represents a resolved user path with local disk target and display representation. */
export interface ResolvedPath {
  local: string;
  display: string;
  flavor: "windows" | "posix";
}

/** Directory entry listing metadata for folder navigation. */
export interface DirectoryListing {
  directory: string;
  parent: string | null;
  separator: "/" | "\\";
  exists: boolean;
  entries: { name: string }[];
}

/** Error produced when a requested filesystem path is invalid or inaccessible. */
export class PathError extends Error {
  constructor(detailMessage: string) {
    super(detailMessage);
    this.name = "PathError";
    Object.setPrototypeOf(this, PathError.prototype);
  }
}

/** Strips trailing slashes from normalized posix path string while retaining root slash. */
function trimTrailingSlashes(candidate: string): string {
  return candidate === "/" ? candidate : candidate.replace(/\/+$/, "");
}

/**
 * Resolves arbitrary user-entered directory paths across Windows, WSL, and POSIX filesystems.
 */
export function resolveUserPath(rawPath: string, context: PathContext): ResolvedPath {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new PathError(`Type a folder path.`);
  }

  // Handle tilde prefix expanding to home directory
  let expanded = trimmed;
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = `${context.home}${expanded.slice(1)}`;
  }

  if (context.platform === "win32") {
    // Windows drive-prefixed path or UNC network path
    const isDriveOrUnc = /^[A-Za-z]:([\\/]|$)/.test(expanded) || expanded.startsWith("\\\\");
    if (isDriveOrUnc) {
      const formatted = /^[A-Za-z]:$/.test(expanded) ? `${expanded}\\` : expanded;
      const targetLocal = nodePath.win32.resolve(formatted);
      return { local: targetLocal, display: targetLocal, flavor: "windows" };
    }

    // POSIX path routed through WSL or Windows mount
    if (expanded.startsWith("/")) {
      const normalizedPosix = trimTrailingSlashes(nodePath.posix.normalize(expanded));
      const mntMatch = /^\/mnt\/([A-Za-z])(\/.*)?$/.exec(normalizedPosix);
      if (mntMatch) {
        const driveLetter = (mntMatch[1] as string).toUpperCase();
        const subDirectory = (mntMatch[2] ?? "").replace(/\//g, "\\");
        const mountedLocal = nodePath.win32.resolve(`${driveLetter}:\\${subDirectory}`);
        return { local: mountedLocal, display: normalizedPosix, flavor: "posix" };
      }

      if (!context.distro) {
        throw new PathError(`Linux paths need WSL. Start WSL, or use a Windows path.`);
      }

      const distroTarget = `\\\\wsl.localhost\\${context.distro}${normalizedPosix.replace(/\//g, "\\")}`;
      return { local: distroTarget, display: normalizedPosix, flavor: "posix" };
    }

    throw new PathError(`Use a full path, like D:\\Projects or ~/code.`);
  }

  // POSIX platform resolution
  if (!expanded.startsWith("/")) {
    throw new PathError(`Use a full path, like ~/code or /srv/app.`);
  }

  const resolvedLocal = nodePath.posix.resolve(expanded);
  return { local: resolvedLocal, display: resolvedLocal, flavor: "posix" };
}

/**
 * Lists subdirectories inside the designated folder for workspace folder selection.
 */
export async function listDirectory(rawPath: string, context: PathContext): Promise<DirectoryListing> {
  const resolved = resolveUserPath(rawPath, context);
  const pathEngine = resolved.flavor === "windows" ? nodePath.win32 : nodePath.posix;
  const parentPath = pathEngine.dirname(resolved.display);
  const pathSep: "/" | "\\" = resolved.flavor === "windows" ? "\\" : "/";

  const summary = {
    directory: `${resolved.display}`,
    parent: parentPath === resolved.display ? null : parentPath,
    separator: pathSep,
  };

  try {
    const dirEntries = await fs.readdir(resolved.local, { withFileTypes: true });
    const subDirs = dirEntries
      .filter((dirItem) => dirItem.isDirectory())
      .map((dirItem) => ({ name: dirItem.name }))
      .sort((first, second) => first.name.localeCompare(second.name, undefined, { sensitivity: "base", numeric: true }));

    return {
      ...summary,
      exists: true,
      entries: subDirs,
    };
  } catch (failure) {
    const errorCode = (failure as NodeJS.ErrnoException).code;
    if (errorCode === "EACCES" || errorCode === "EPERM") {
      return { ...summary, exists: true, entries: [] };
    }
    if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
      return { ...summary, exists: false, entries: [] };
    }
    throw failure;
  }
}

/**
 * Ensures creation of the requested directory hierarchy.
 */
export async function createDirectory(rawPath: string, context: PathContext): Promise<ResolvedPath> {
  const target = resolveUserPath(rawPath, context);
  await fs.mkdir(target.local, { recursive: true });
  return target;
}
