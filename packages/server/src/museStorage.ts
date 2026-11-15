import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { posix } from "node:path";

export interface MuseStorageOptions {
  /** The home and environment used by the Muse process, including any named account overrides. */
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  uid?: number;
}

export interface MuseStorageIssue {
  code: string;
  path: string | null;
  message: string;
  repairable: boolean;
}

export interface MuseStorageDiagnosis {
  status: "ready" | "repairable" | "blocked" | "not-applicable";
  root: string | null;
  canonicalRoot: string | null;
  issues: MuseStorageIssue[];
  /** This call created the missing data folder or removed its group/other write permission. */
  repaired: boolean;
}

export class MuseStorageError extends Error {
  readonly kind = "muse_storage_unavailable";
  readonly diagnosis: MuseStorageDiagnosis;

  constructor(diagnosis: MuseStorageDiagnosis) {
    super(diagnosis.issues.map((issue) => issue.message).join(" ") || "Muse's data folder could not be checked.");
    this.name = "MuseStorageError";
    this.diagnosis = diagnosis;
  }
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const OTHER_WRITE = 0o022;

function issue(code: string, path: string | null, message: string, repairable = false): MuseStorageIssue {
  return { code, path, message, repairable };
}

function result(root: string | null, canonicalRoot: string | null, issues: MuseStorageIssue[] = []): MuseStorageDiagnosis {
  return {
    status: issues.length === 0 ? "ready" : issues.every((item) => item.repairable) ? "repairable" : "blocked",
    root,
    canonicalRoot,
    issues,
    repaired: false,
  };
}

function fail(root: string | null, canonicalRoot: string | null, problem: MuseStorageIssue): never {
  throw new MuseStorageError(result(root, canonicalRoot, [problem]));
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unsafeOwner(path: string): MuseStorageIssue {
  return issue("wrong-owner", path, `The Muse data path “${path}” belongs to another user. Use a Muse data folder owned by your Linux account; Ancilla will not change its ownership or history.`);
}

function changedPath(path: string): MuseStorageIssue {
  return issue("path-changed", path, `The Muse data path “${path}” changed during the check. Close other programs changing this folder, then check again.`);
}

function ioIssue(path: string, error: unknown): MuseStorageIssue {
  if (errno(error) === "ELOOP") {
    return changedPath(path);
  }
  return issue("storage-unavailable", path, `Ancilla could not access the Muse data folder “${path}”${errno(error) ? ` (${errno(error)})` : ""}. Check that the drive is available and your Linux account can read and write this folder, then try again.`);
}

function absoluteFolder(path: string): boolean {
  // Do not normalize away parent segments before checking the filesystem: a symlink before
  // “..” can make that a different directory from the one Muse actually opens.
  return posix.isAbsolute(path) && !path.includes("\0") && !path.split("/").some((part) => part === "." || part === "..");
}

function configuredRoot(options: MuseStorageOptions): string {
  const dataHome = (options.env ?? process.env)["XDG_DATA_HOME"];
  if (dataHome) {
    if (!absoluteFolder(dataHome)) {
      fail(null, null, issue("invalid-data-home", dataHome, "XDG_DATA_HOME must be a full Linux folder path without . or .. segments, such as /home/you/.local/share. Set its absolute path or remove this setting, then restart Ancilla."));
    }
    return posix.join(dataHome, "muse");
  }
  if (!absoluteFolder(options.home)) {
    fail(null, null, issue("invalid-home", options.home, "Muse needs a full Linux home folder path. Check the HOME setting used to start Ancilla, then restart it."));
  }
  return posix.join(options.home, ".local", "share", "muse");
}

function userId(options: MuseStorageOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isInteger(uid) || uid < 0) {
    fail(null, null, issue("unknown-owner", null, "Ancilla could not identify your Linux account to check Muse's data folder. Restart Ancilla from your normal desktop account."));
  }
  return uid;
}

/** Open the inspected inode, never a replacement symlink, and verify ownership before using it. */
async function openDirectory(path: string, expected: Stats, uid: number, display = path): Promise<FileHandle> {
  const handle = await open(path, DIRECTORY_FLAGS);
  try {
    const actual = await handle.stat();
    if (!sameFile(expected, actual) || !actual.isDirectory()) {
      fail(display, display, changedPath(display));
    }
    if (actual.uid !== uid) {
      fail(display, display, unsafeOwner(display));
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

interface CreationPlan {
  parent: string;
  parentStat: Stats;
  parts: string[];
}

/** Locate an owned existing parent. This only reads metadata; it never changes shared ancestors. */
async function creationPlan(root: string, uid: number): Promise<CreationPlan> {
  const parts: string[] = [];
  let candidate = root;
  for (;;) {
    let metadata: Stats;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      const parent = posix.dirname(candidate);
      if (parent === candidate) throw error;
      parts.unshift(posix.basename(candidate));
      candidate = parent;
      continue;
    }
    if (metadata.isSymbolicLink()) {
      fail(root, null, issue("unsafe-parent", candidate, `Muse's missing data folder is below the symbolic link “${candidate}”. Set XDG_DATA_HOME to the real, owned folder and restart Ancilla so it can safely create the data folder.`));
    }
    if (!metadata.isDirectory()) {
      fail(root, null, issue("not-directory", candidate, `The Muse data path “${candidate}” is a file instead of a folder. Choose another XDG_DATA_HOME folder, then restart Ancilla.`));
    }
    if (metadata.uid !== uid) {
      fail(root, null, unsafeOwner(candidate));
    }
    if ((metadata.mode & 0o700) !== 0o700) {
      fail(root, null, issue("parent-access", candidate, `Your Linux account needs read, write and open-folder permission for “${candidate}” before Ancilla can create Muse's data folder. Ancilla will not change parent-folder permissions.`));
    }
    const canonicalParent = await realpath(candidate);
    const canonicalMetadata = await lstat(canonicalParent);
    if (!sameFile(metadata, canonicalMetadata)) {
      fail(root, null, changedPath(candidate));
    }
    return { parent: canonicalParent, parentStat: canonicalMetadata, parts };
  }
}

/** Read only the known deletion-authority entries. Never read, create, replace or repair their contents. */
async function registryIssues(root: string, rootHandle: FileHandle, uid: number): Promise<MuseStorageIssue[]> {
  const registry = posix.join(root, "session-deletions");
  const anchoredRegistry = `/proc/self/fd/${rootHandle.fd}/session-deletions`;
  let metadata: Stats;
  try {
    metadata = await lstat(anchoredRegistry);
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    return [issue("registry-symlink", registry, `Muse's deletion registry “${registry}” is a symbolic link. Muse requires the real registry folder here. Restore its original folder or contact support; Ancilla will not follow the link, delete records or recreate the registry.`)];
  }
  if (!metadata.isDirectory()) {
    return [issue("registry-not-directory", registry, `Muse's deletion registry “${registry}” is not a folder. Restore its original folder or contact support; Ancilla will not overwrite deletion records.`)];
  }
  if (metadata.uid !== uid) return [unsafeOwner(registry)];
  const issues: MuseStorageIssue[] = [];
  if (metadata.mode & OTHER_WRITE) {
    issues.push(issue("registry-writable", registry, `Muse's deletion registry “${registry}” can be changed by other Linux users. Its owner must remove group and other write permission. Ancilla only repairs the outer Muse data folder and leaves deletion records unchanged.`));
  }
  if ((metadata.mode & 0o700) !== 0o700) {
    issues.push(issue("registry-access", registry, `Your Linux account cannot fully access Muse's deletion registry “${registry}”. Restore its owner permissions or contact support; Ancilla will not recreate it.`));
    return issues;
  }
  const handle = await openDirectory(anchoredRegistry, metadata, uid, registry);
  try {
    const missing: string[] = [];
    for (const name of ["authority.json", "deletions.db"]) {
      const display = posix.join(registry, name);
      let entry: Stats;
      try {
        entry = await lstat(`/proc/self/fd/${handle.fd}/${name}`);
      } catch (error) {
        // Muse treats an existing but incomplete registry as a missing surviving deletion
        // authority. Diagnose that state; never fabricate the missing authority or database.
        if (errno(error) === "ENOENT") {
          missing.push(name);
          continue;
        }
        throw error;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) {
        issues.push(issue("registry-entry-type", display, `Muse's deletion record “${display}” must be a regular file, not a link or another file type. Restore the original record or contact support; Ancilla will not replace it.`));
      } else if (entry.uid !== uid) {
        issues.push(unsafeOwner(display));
      } else if (entry.mode & OTHER_WRITE) {
        issues.push(issue("registry-entry-writable", display, `Muse's deletion record “${display}” can be changed by other Linux users. Its owner must remove group and other write permission. Ancilla will leave the record unchanged.`));
      }
    }
    if (missing.length) {
      issues.push(issue("registry-incomplete", registry, `Muse's deletion registry “${registry}” is incomplete: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing. Restore the original records or contact support. Ancilla will not create replacement deletion records or erase your history.`));
    }
    const current = await lstat(anchoredRegistry);
    if (!sameFile(metadata, current) || current.isSymbolicLink()) {
      issues.push(changedPath(registry));
    }
  } finally {
    await handle.close();
  }
  return issues;
}

/** Read-only Linux preflight, using the same effective environment as the Muse process. */
export async function inspectMuseStorage(options: MuseStorageOptions): Promise<MuseStorageDiagnosis> {
  if ((options.platform ?? process.platform) !== "linux") {
    return { ...result(null, null), status: "not-applicable" };
  }
  let root: string | null = null;
  let canonicalRoot: string | null = null;
  try {
    root = configuredRoot(options);
    const uid = userId(options);
    try {
      // Muse supports an existing data-root symlink. Resolve it once, then open the target
      // without following a replacement link and keep subsequent checks anchored to its fd.
      canonicalRoot = await realpath(root);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      await creationPlan(root, uid);
      return result(root, null, [issue("missing-root", root, `Muse's data folder “${root}” is not created yet. Ancilla can create it privately for your Linux account.`, true)]);
    }
    const metadata = await lstat(canonicalRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return result(root, canonicalRoot, [issue("not-directory", root, `The Muse data path “${root}” is not a folder. Choose an owned folder for XDG_DATA_HOME, then restart Ancilla.`)]);
    }
    if (metadata.uid !== uid) return result(root, canonicalRoot, [unsafeOwner(root)]);
    const issues: MuseStorageIssue[] = [];
    if ((metadata.mode & 0o700) !== 0o700) {
      return result(root, canonicalRoot, [issue("root-access", root, `Your Linux account needs read, write and open-folder permission for Muse's data folder “${root}”. Restore those owner permissions, then check again. Ancilla will not broaden access to an existing folder.`)]);
    }
    if (metadata.mode & OTHER_WRITE) {
      issues.push(issue("root-writable", root, `Muse cannot start threads because other Linux users can write to “${root}”. Ancilla can remove only group and other write permission while preserving your login and conversation history.`, true));
    }
    const handle = await openDirectory(canonicalRoot, metadata, uid);
    try {
      issues.push(...await registryIssues(root, handle, uid));
      const currentPath = await realpath(root);
      const current = await lstat(currentPath);
      if (currentPath !== canonicalRoot || !sameFile(metadata, current) || current.isSymbolicLink()) {
        issues.push(changedPath(root));
      }
    } finally {
      await handle.close();
    }
    return result(root, canonicalRoot, issues);
  } catch (error) {
    if (error instanceof MuseStorageError) {
      return { ...error.diagnosis, root: root ?? error.diagnosis.root, canonicalRoot };
    }
    return result(root, canonicalRoot, [ioIssue(root ?? options.home, error)]);
  }
}

/** Create missing directories through pinned parent descriptors; never chmod existing parents. */
async function createRoot(root: string, uid: number): Promise<boolean> {
  const plan = await creationPlan(root, uid);
  let handle = await openDirectory(plan.parent, plan.parentStat, uid);
  let created = false;
  let canonical = plan.parent;
  try {
    for (const part of plan.parts) {
      const anchored = `/proc/self/fd/${handle.fd}/${part}`;
      canonical = posix.join(canonical, part);
      try {
        await mkdir(anchored, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
      const metadata = await lstat(anchored);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail(root, null, changedPath(canonical));
      }
      const next = await openDirectory(anchored, metadata, uid, canonical);
      await handle.close();
      handle = next;
    }
    const currentPath = await realpath(root);
    const current = await lstat(currentPath);
    if (currentPath !== canonical || !sameFile(await handle.stat(), current) || current.isSymbolicLink()) {
      fail(root, null, changedPath(root));
    }
  } finally {
    await handle.close();
  }
  return created;
}

async function tightenRoot(diagnosis: MuseStorageDiagnosis, uid: number): Promise<boolean> {
  const { root, canonicalRoot } = diagnosis;
  if (!root || !canonicalRoot) return false;
  const before = await lstat(canonicalRoot);
  if (!before.isDirectory() || before.isSymbolicLink() || await realpath(root) !== canonicalRoot) {
    fail(root, canonicalRoot, changedPath(root));
  }
  const handle = await openDirectory(canonicalRoot, before, uid);
  try {
    // Recheck the deletion registry before any mutation. A blocked registry is never "fixed"
    // by changing, deleting or fabricating its records, even when the outer root is writable.
    const problems = await registryIssues(root, handle, uid);
    if (problems.length) throw new MuseStorageError(result(root, canonicalRoot, problems));
    const current = await lstat(canonicalRoot);
    const held = await handle.stat();
    if (!sameFile(before, current) || !sameFile(before, held) || current.isSymbolicLink() || await realpath(root) !== canonicalRoot) {
      fail(root, canonicalRoot, changedPath(root));
    }
    if (held.uid !== uid) fail(root, canonicalRoot, unsafeOwner(root));
    if ((held.mode & 0o700) !== 0o700) {
      fail(root, canonicalRoot, issue("root-access", root, `Muse's data folder “${root}” no longer has full owner permissions. Restore its owner permissions, then check again.`));
    }
    if (!(held.mode & OTHER_WRITE)) return false;
    // fchmod changes exactly the inode we checked. Preserve all owner, read, execute and
    // special bits; only group/other write are proven to cause Muse's UnsafePath failure.
    await handle.chmod((held.mode & 0o7777) & ~OTHER_WRITE);
    return true;
  } finally {
    await handle.close();
  }
}

/** Safe, idempotent repair for setup or preflight. Never touches credentials or deletion records. */
export async function repairMuseStorage(options: MuseStorageOptions): Promise<MuseStorageDiagnosis> {
  let diagnosis = await inspectMuseStorage(options);
  if (diagnosis.status !== "repairable") return diagnosis;
  let repaired = false;
  try {
    const uid = userId(options);
    if (diagnosis.issues.some((item) => item.code === "missing-root") && diagnosis.root) {
      repaired = await createRoot(diagnosis.root, uid);
      diagnosis = await inspectMuseStorage(options);
    }
    if (diagnosis.status === "repairable" && diagnosis.issues.every((item) => item.code === "root-writable")) {
      repaired = await tightenRoot(diagnosis, uid) || repaired;
    }
    return { ...await inspectMuseStorage(options), repaired };
  } catch (error) {
    const failed = error instanceof MuseStorageError
      ? { ...error.diagnosis, root: diagnosis.root, canonicalRoot: diagnosis.canonicalRoot }
      : result(diagnosis.root, diagnosis.canonicalRoot, [ioIssue(diagnosis.root ?? options.home, error)]);
    return { ...failed, repaired };
  }
}

/** Call before launching a Linux Muse host, including hosts for named accounts and research. */
export async function ensureMuseStorage(options: MuseStorageOptions): Promise<MuseStorageDiagnosis> {
  const diagnosis = await repairMuseStorage(options);
  if (diagnosis.status === "blocked" || diagnosis.status === "repairable") {
    throw new MuseStorageError(diagnosis);
  }
  return diagnosis;
}
