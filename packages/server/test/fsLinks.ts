/**
 * Links for the tests that check a workspace write never follows one. A folder link is a junction on Windows, which
 * needs no privilege, so there a failure to make one is a real failure and the test fails with it instead of
 * skipping. A file link needs a privilege on Windows, so a machine without it reports false and the test skips itself.
 */
import { rmdir, symlink, unlink } from "node:fs/promises";

export async function tryLink(target: string, path: string, kind: "dir" | "file"): Promise<boolean> {
  const junction = process.platform === "win32" && kind === "dir";
  try {
    await symlink(target, path, process.platform === "win32" ? (kind === "dir" ? "junction" : "file") : kind);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!junction && (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "UNKNOWN")) {
      return false;
    }
    throw error;
  }
}

/**
 * Removes a link made by `tryLink` and nothing behind it. Never a recursive remove: a junction must go without the
 * contents of the folder it points at, which the test may still need to look at.
 */
export async function unlinkLink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Some platforms refuse to unlink a folder link; rmdir removes the link itself and fails on a real, filled folder.
    if (code !== "EISDIR" && code !== "EPERM" && code !== "ENOTEMPTY") {
      throw error;
    }
    await rmdir(path);
  }
}
