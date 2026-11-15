/**
 * What Ancilla itself writes into a project: the files attached to a prompt and a research run's report. Both live
 * under the project's own `.ancilla` folder, and neither may be steered somewhere else by a link planted there.
 *
 * The rules, all on the folders Ancilla owns and nothing else (Muse's own writes are never restricted):
 *  - each folder on the way down is looked at without following links, and a symbolic link or junction, anywhere
 *    along it, is refused rather than followed, wherever it points. No `realpath`: from Windows it fails on a Linux
 *    link inside a WSL share, and a link that stays inside the project can still reach `.git/hooks`.
 *  - a file is created with an exclusive open after its name was checked with `lstat`, so a name already taken,
 *    including by a dangling link, is skipped and never opened, and two writers of one name cannot meet.
 *  - a write that fails removes the file it created.
 * Node has no `openat`, so a link swapped in between the check and the open by something running as the user can
 * still win that race; the checks close the accidental cases and the planted ones, not an attacker who is already
 * writing into the project.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { FileError } from "./files.js";

/** Ancilla's folder inside a project. */
export const ANCILLA_DIR = ".ancilla";
/** Where a non-image attachment lands, so Muse's own tools can open it. */
export const ATTACHMENT_DIR = [ANCILLA_DIR, "attachments"];
/** Where a run's report and sources land, beside attachments. */
export const RESEARCH_DIR = [ANCILLA_DIR, "research"];

/** Plain names tried in order before a random one, so a busy folder costs a bounded number of opens. */
const SEQUENTIAL_NAMES = 20;
const RANDOM_ATTEMPTS = 8;

export type EntryState = "missing" | "dir" | "file" | "link";

/** What is at `path`, without following it: a symbolic link or junction is a link, whatever it points at. */
export async function entryState(path: string): Promise<EntryState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return "link";
    }
    return info.isDirectory() ? "dir" : "file";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return "missing";
    }
    // Windows reading a Linux link through a WSL share answers EISDIR: a link all the same.
    if (code === "EISDIR") {
      return "link";
    }
    throw error;
  }
}

function refuse(message: string): FileError {
  return new FileError(409, message, "workspaceWrite");
}

/**
 * The folder at `segments` under `root`, made if it is not there. Every folder on the way is one Ancilla owns, so
 * each is checked and none may be a link or a file. A project folder that is gone is a 404.
 */
export async function ownedDir(root: string, segments: readonly string[]): Promise<string> {
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    throw new FileError(404, "This project's folder is not there anymore.");
  }
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let state = await entryState(current);
    if (state === "missing") {
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      state = await entryState(current);
    }
    if (state === "link") {
      throw refuse(
        `Ancilla saves what it keeps for a project inside the project, and ${current} is a link (a symbolic link or a junction), so it will not write there. ` +
          "Replace the link with an ordinary folder, or remove it, and try again.",
      );
    }
    if (state !== "dir") {
      throw refuse(`Ancilla needs ${current} to be a folder, but something else is there. Rename or remove it and try again.`);
    }
  }
  return current;
}

/**
 * Keeps what Ancilla saves in `.ancilla` out of the project's commits: a lone `*`, written once. A file that is
 * already there, the user's own or a link, is left exactly as it is.
 */
export async function ensureIgnoreFile(directory: string): Promise<void> {
  const path = join(directory, ".gitignore");
  if ((await entryState(path)) !== "missing") {
    return;
  }
  let handle: FileHandle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }
  try {
    await handle.writeFile("*\n");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Refuses a file Ancilla is about to write when its name is held by a link, which a write would follow to wherever it
 * points, or by a folder. A plain file, or nothing, is fine: a run's own report and exports are written over.
 */
export async function assertWritableFile(directory: string, name: string): Promise<void> {
  const path = join(directory, name);
  const state = await entryState(path);
  if (state === "link") {
    throw refuse(
      `Ancilla saves what it keeps for a project inside the project, and ${path} is a link (a symbolic link or a junction), so it will not write through it. ` +
        "Remove the link and try again.",
    );
  }
  if (state === "dir") {
    throw refuse(`Ancilla needs ${path} to be a file, but a folder is there. Rename or remove it and try again.`);
  }
}

/** `ownedDir` under a project, with the ignore file beside it. A project that cannot take the ignore file still takes the files. */
export async function ownedProjectDir(root: string, segments: readonly string[]): Promise<string> {
  const directory = await ownedDir(root, segments);
  await ensureIgnoreFile(join(root, ANCILLA_DIR)).catch(() => undefined);
  return directory;
}

export interface CreateUniqueOptions {
  /** How the bytes are written once the file exists; a test makes it fail. */
  write?: (handle: FileHandle, bytes: Uint8Array) => Promise<void>;
}

async function createFile(path: string, bytes: Uint8Array, write: NonNullable<CreateUniqueOptions["write"]>): Promise<boolean> {
  // lstat first: an exclusive open alone follows a dangling link on Windows, and never sees a name a link holds.
  if ((await entryState(path)) !== "missing") {
    return false;
  }
  let handle: FileHandle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await write(handle, bytes);
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return true;
}

/**
 * Writes `bytes` to a file of its own in `directory` and answers the name it got: `name` when that is free, then
 * `stem-2.ext` and so on, then `stem-<8 hex>.ext`. No existing entry is ever opened or replaced.
 */
export async function createUnique(directory: string, name: string, bytes: Uint8Array, options: CreateUniqueOptions = {}): Promise<string> {
  const write = options.write ?? ((handle, data) => handle.writeFile(data));
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = dot > 0 ? name.slice(dot) : "";
  for (let attempt = 0; attempt < SEQUENTIAL_NAMES; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt + 1}${suffix}`;
    if (await createFile(join(directory, candidate), bytes, write)) {
      return candidate;
    }
  }
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    const candidate = `${stem}-${randomBytes(4).toString("hex")}${suffix}`;
    if (await createFile(join(directory, candidate), bytes, write)) {
      return candidate;
    }
  }
  throw refuse(`Ancilla could not find a free name for ${name} in ${directory}. Clear out some of the files there and try again.`);
}

/** Puts an attached file in the project at `root` and answers the name it was saved under. */
export type AttachmentWriter = (root: string, name: string, bytes: Buffer) => Promise<string>;

export const writeAttachment: AttachmentWriter = async (root, name, bytes) => {
  const directory = await ownedProjectDir(root, ATTACHMENT_DIR);
  return createUnique(directory, name, bytes);
};
