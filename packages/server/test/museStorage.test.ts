import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMuseStorage,
  inspectMuseStorage,
  MuseStorageError,
  repairMuseStorage,
  type MuseStorageOptions,
} from "../src/museStorage.js";

describe("Linux Muse data-folder preflight", { skip: process.platform !== "linux" }, () => {
  async function fixture(t: { after: (fn: () => Promise<void>) => void }, mode?: number) {
    const home = await fs.mkdtemp(join(tmpdir(), "ancilla-muse-storage-"));
    t.after(() => fs.rm(home, { force: true, recursive: true }));
    const dataHome = join(home, "data");
    const root = join(dataHome, "muse");
    const options: MuseStorageOptions = { home, env: { XDG_DATA_HOME: dataHome }, platform: "linux" };
    if (mode !== undefined) {
      await fs.mkdir(root, { recursive: true });
      await fs.chmod(root, mode);
    }
    return { home, dataHome, root, options };
  }

  async function mode(path: string): Promise<number> {
    return (await fs.lstat(path)).mode & 0o7777;
  }

  async function absent(path: string): Promise<void> {
    await assert.rejects(fs.lstat(path), { code: "ENOENT" });
  }

  it("diagnoses a missing default folder without creating anything", async (t) => {
    const { home } = await fixture(t);
    const diagnosis = await inspectMuseStorage({ home, env: {} });
    assert.equal(diagnosis.status, "repairable");
    assert.equal(diagnosis.root, join(home, ".local", "share", "muse"));
    assert.deepEqual(diagnosis.issues.map((entry) => entry.code), ["missing-root"]);
    assert.equal(diagnosis.repaired, false);
    await absent(join(home, ".local"));
  });

  it("creates a missing private root and parents without creating a deletion registry", async (t) => {
    const { home } = await fixture(t);
    const options = { home, env: {} };
    const diagnosis = await ensureMuseStorage(options);
    assert.equal(diagnosis.status, "ready");
    assert.equal(diagnosis.repaired, true);
    assert.equal(await mode(diagnosis.root!), 0o700);
    await absent(join(diagnosis.root!, "session-deletions"));
    const again = await ensureMuseStorage(options);
    assert.equal(again.status, "ready");
    assert.equal(again.repaired, false);
  });

  it("repairs 775 to 755 and leaves credentials, history, children and parent permissions unchanged", async (t) => {
    const { dataHome, root, options } = await fixture(t, 0o775);
    await fs.chmod(dataHome, 0o775);
    const sessions = join(root, "sessions");
    await fs.mkdir(sessions);
    await fs.chmod(sessions, 0o777);
    const history = join(sessions, "conversation.json");
    await fs.writeFile(history, '{"message":"keep me"}');
    await fs.chmod(history, 0o666);
    const credentials = join(root, "credentials.json");
    await fs.writeFile(credentials, '{"token":"fixture only"}', { mode: 0o600 });

    const before = await inspectMuseStorage(options);
    assert.equal(before.status, "repairable");
    assert.equal(before.issues[0].code, "root-writable");
    assert.equal(await mode(root), 0o775);
    const repaired = await repairMuseStorage(options);
    assert.equal(repaired.status, "ready");
    assert.equal(repaired.repaired, true);
    assert.equal(await mode(root), 0o755);
    assert.equal(await mode(dataHome), 0o775);
    assert.equal(await mode(sessions), 0o777);
    assert.equal(await mode(history), 0o666);
    assert.equal(await fs.readFile(history, "utf8"), '{"message":"keep me"}');
    assert.equal(await fs.readFile(credentials, "utf8"), '{"token":"fixture only"}');
    assert.equal(await mode(credentials), 0o600);
    await absent(join(root, "session-deletions"));
  });

  it("only removes group/other write bits, preserving existing reads and special bits", async (t) => {
    const { root, options } = await fixture(t, 0o2770);
    const repaired = await ensureMuseStorage(options);
    assert.equal(repaired.status, "ready");
    assert.equal(await mode(root), 0o2750);
  });

  it("accepts an already safe root without changing its mode", async (t) => {
    const { root, options } = await fixture(t, 0o750);
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "ready");
    assert.equal(diagnosis.repaired, false);
    assert.equal(await mode(root), 0o750);
  });

  it("uses a named account's effective XDG_DATA_HOME without touching default storage", async (t) => {
    const { home, root, options } = await fixture(t, 0o775);
    const defaultRoot = join(home, ".local", "share", "muse");
    await fs.mkdir(defaultRoot, { recursive: true });
    await fs.chmod(defaultRoot, 0o777);
    const diagnosis = await ensureMuseStorage(options);
    assert.equal(diagnosis.root, root);
    assert.equal(await mode(root), 0o755);
    assert.equal(await mode(defaultRoot), 0o777);
  });

  it("skips non-Linux runtimes without inspecting or changing their folders", async (t) => {
    const { root, options } = await fixture(t, 0o777);
    for (const platform of ["win32", "darwin"]) {
      const diagnosis = await ensureMuseStorage({ ...options, platform });
      assert.equal(diagnosis.status, "not-applicable");
      assert.equal(diagnosis.root, null);
    }
    assert.equal(await mode(root), 0o777);
  });

  it("rejects relative and invalid paths with actionable structured errors", async (t) => {
    const { home } = await fixture(t);
    for (const dataHome of ["relative/data", "~/data", "relative\0data", `${home}/../other-data`, `${home}/./data`]) {
      const diagnosis = await repairMuseStorage({ home, env: { XDG_DATA_HOME: dataHome } });
      assert.equal(diagnosis.status, "blocked");
      assert.equal(diagnosis.issues[0].code, "invalid-data-home");
      assert.match(diagnosis.issues[0].message, /full Linux folder path/);
    }
    const invalidHome = await inspectMuseStorage({ home: "relative", env: {} });
    assert.equal(invalidHome.issues[0].code, "invalid-home");
  });

  it("supports an existing root symlink and changes only its owned canonical target", async (t) => {
    const { dataHome, root, home, options } = await fixture(t);
    const target = join(home, "real-muse");
    await fs.mkdir(dataHome);
    await fs.mkdir(target);
    await fs.chmod(target, 0o775);
    await fs.symlink(target, root);
    const diagnosis = await ensureMuseStorage(options);
    assert.equal(diagnosis.status, "ready");
    assert.equal(diagnosis.canonicalRoot, target);
    assert.equal(await mode(target), 0o755);
    assert.equal(await fs.readlink(root), target);
  });

  it("refuses a registry symlink without changing the root or target", async (t) => {
    const { home, root, options } = await fixture(t, 0o775);
    const target = join(home, "registry-target");
    await fs.mkdir(target);
    await fs.chmod(target, 0o777);
    const registry = join(root, "session-deletions");
    await fs.symlink(target, registry);
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.repaired, false);
    assert.ok(diagnosis.issues.some((entry) => entry.code === "registry-symlink"));
    assert.equal(await mode(root), 0o775);
    assert.equal(await mode(target), 0o777);
    assert.equal(await fs.readlink(registry), target);
    await assert.rejects(ensureMuseStorage(options), (error: unknown) => {
      assert.ok(error instanceof MuseStorageError);
      assert.equal(error.diagnosis.status, "blocked");
      assert.match(error.message, /symbolic link/);
      return true;
    });
  });

  it("accepts regular registry records with read-only group access and never changes contents", async (t) => {
    const { root, options } = await fixture(t, 0o775);
    const registry = join(root, "session-deletions");
    await fs.mkdir(registry, { mode: 0o755 });
    for (const name of ["authority.json", "deletions.db"]) {
      await fs.writeFile(join(registry, name), `unchanged ${name}`, { mode: 0o644 });
    }
    const diagnosis = await ensureMuseStorage(options);
    assert.equal(diagnosis.status, "ready");
    assert.equal(await mode(root), 0o755);
    assert.equal(await mode(registry), 0o755);
    for (const name of ["authority.json", "deletions.db"]) {
      assert.equal(await fs.readFile(join(registry, name), "utf8"), `unchanged ${name}`);
      assert.equal(await mode(join(registry, name)), 0o644);
    }
  });

  it("blocks an incomplete registry without fabricating its authority or database", async (t) => {
    const { root, options } = await fixture(t, 0o700);
    const registry = join(root, "session-deletions");
    await fs.mkdir(registry, { mode: 0o700 });
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.repaired, false);
    assert.equal(diagnosis.issues[0].code, "registry-incomplete");
    assert.match(diagnosis.issues[0].message, /authority.json and deletions.db are missing/);
    assert.deepEqual(await fs.readdir(registry), []);
    await fs.writeFile(join(registry, "authority.json"), "preserve the surviving authority", { mode: 0o600 });
    const partial = await repairMuseStorage(options);
    assert.equal(partial.status, "blocked");
    assert.equal(partial.issues[0].code, "registry-incomplete");
    assert.match(partial.issues[0].message, /deletions.db is missing/);
    assert.equal(await fs.readFile(join(registry, "authority.json"), "utf8"), "preserve the surviving authority");
    await absent(join(registry, "deletions.db"));
  });

  it("refuses unsafe registry modes instead of recursively repairing them", async (t) => {
    const { root, options } = await fixture(t, 0o775);
    const registry = join(root, "session-deletions");
    await fs.mkdir(registry);
    await fs.chmod(registry, 0o777);
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.ok(diagnosis.issues.some((entry) => entry.code === "registry-writable"));
    assert.equal(await mode(registry), 0o777);
    assert.equal(await mode(root), 0o775);
  });

  it("refuses unsafe metadata file modes without modifying records", async (t) => {
    const { root, options } = await fixture(t, 0o775);
    const registry = join(root, "session-deletions");
    await fs.mkdir(registry, { mode: 0o700 });
    const authority = join(registry, "authority.json");
    await fs.writeFile(authority, "original deletion authority");
    await fs.chmod(authority, 0o666);
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.ok(diagnosis.issues.some((entry) => entry.code === "registry-entry-writable"));
    assert.equal(await mode(authority), 0o666);
    assert.equal(await fs.readFile(authority, "utf8"), "original deletion authority");
    assert.equal(await mode(root), 0o775);
  });

  it("refuses links at either known deletion record without following them", async (t) => {
    const { root, home, options } = await fixture(t, 0o775);
    const registry = join(root, "session-deletions");
    const target = join(home, "do-not-touch");
    await fs.mkdir(registry, { mode: 0o700 });
    await fs.writeFile(target, "unchanged");
    await fs.chmod(target, 0o666);
    for (const name of ["authority.json", "deletions.db"]) {
      await fs.symlink(target, join(registry, name));
    }
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.issues.filter((entry) => entry.code === "registry-entry-type").length, 2);
    assert.equal(await mode(root), 0o775);
    assert.equal(await mode(target), 0o666);
    assert.equal(await fs.readFile(target, "utf8"), "unchanged");
  });

  it("does not repair a folder owned by a different Linux account", async (t) => {
    const { root, options } = await fixture(t, 0o775);
    const diagnosis = await repairMuseStorage({ ...options, uid: process.getuid!() + 1 });
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.issues[0].code, "wrong-owner");
    assert.equal(await mode(root), 0o775);
  });

  it("does not create a missing root under a parent owned by another account", async (t) => {
    const { root, options } = await fixture(t);
    const diagnosis = await repairMuseStorage({ ...options, uid: process.getuid!() + 1 });
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.issues[0].code, "wrong-owner");
    await absent(root);
  });

  it("does not broaden owner permissions on an existing folder", async (t) => {
    const { root, options } = await fixture(t, 0o555);
    // Restore write permission for fixture cleanup.
    t.after(() => fs.chmod(root, 0o700).catch(() => {}));
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.issues[0].code, "root-access");
    assert.equal(await mode(root), 0o555);
  });

  it("reports a file at the Muse root without overwriting it", async (t) => {
    const { dataHome, root, options } = await fixture(t);
    await fs.mkdir(dataHome);
    await fs.writeFile(root, "preserve");
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.issues[0].code, "not-directory");
    assert.equal(await fs.readFile(root, "utf8"), "preserve");
  });

  it("does not create missing folders through a symbolic-link parent", async (t) => {
    const { dataHome, home, root, options } = await fixture(t);
    const target = join(home, "actual-data");
    await fs.mkdir(target);
    await fs.symlink(target, dataHome);
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.issues[0].code, "unsafe-parent");
    await absent(root);
    assert.deepEqual(await fs.readdir(target), []);
  });

  it("detects a replacement directory between inspection and opening without chmodding either inode", async (t) => {
    const { home, root, options } = await fixture(t, 0o775);
    const oldRoot = join(home, "original-muse");
    const originalOpen = fs.open;
    let rootOpens = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === root && ++rootOpens === 2) {
        await fs.rename(root, oldRoot);
        await fs.mkdir(root);
        await fs.chmod(root, 0o777);
      }
      return originalOpen(...args);
    });
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(diagnosis.issues[0].code, "path-changed");
    assert.equal(await mode(root), 0o777);
    assert.equal(await mode(oldRoot), 0o775);
  });

  it("does not follow a replacement symlink opened during repair", async (t) => {
    const { home, root, options } = await fixture(t, 0o775);
    const oldRoot = join(home, "original-muse");
    const target = join(home, "other-directory");
    await fs.mkdir(target);
    await fs.chmod(target, 0o777);
    const originalOpen = fs.open;
    let rootOpens = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === root && ++rootOpens === 2) {
        await fs.rename(root, oldRoot);
        await fs.symlink(target, root);
      }
      return originalOpen(...args);
    });
    const diagnosis = await repairMuseStorage(options);
    assert.equal(diagnosis.status, "blocked");
    assert.equal(await mode(oldRoot), 0o775);
    assert.equal(await mode(target), 0o777);
    assert.equal(await fs.readlink(root), target);
  });
});
