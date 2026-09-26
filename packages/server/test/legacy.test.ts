import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore } from "@ancilla/daemon";
import {
  DB_FILE,
  LEGACY_DB_FILE,
  envSetting,
  importLegacyDatabase,
  importLegacyRuntime,
  legacyDataDir,
  publishSnapshot,
} from "../src/legacy.js";
import { AncillaServer } from "../src/server.js";

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "ancilla-legacy-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

function logger(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = [];
  return { lines, log: (message) => lines.push(message) };
}

/** Runs `run` with stderr captured rather than printed, which is where the server logs an import. */
function quietly<T>(run: () => T): { value: T; stderr: string } {
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = run();
    return { value, stderr };
  } finally {
    process.stderr.write = write;
  }
}

function serverFor(dataDir: string, home: string): AncillaServer {
  return new AncillaServer({
    port: 0,
    dataDir,
    home,
    platform: "linux",
    musePath: "muse",
    exec: async () => ({ stdout: "", exitCode: 127 }),
  });
}

async function projectsOf(server: AncillaServer): Promise<{ cwd: string; pinned: boolean }[]> {
  const bound = await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${bound.port}/api/projects`);
    return ((await res.json()) as { projects: { cwd: string; pinned: boolean }[] }).projects;
  } finally {
    await server.close();
  }
}

/** A Helicon data folder as Helicon 0.17 left it: a pinned project, a thread it titled and archived, a file sent. */
function seedHelicon(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LEGACY_DB_FILE);
  const store = new AncillaStore(path);
  const project = store.upsertProject("/work/app");
  store.setPinned("/work/app", true);
  store.recordSession({ id: "s1", projectId: project.id, title: "Fix the login flow", titleSource: "user", origin: "helicon" });
  store.updateSession("s1", { archived: true });
  store.addAttachment({
    id: "a1", sessionId: "s1", turnId: "t1", ord: 0, name: "report.pdf", mediaType: "application/pdf", kind: "file",
    bytes: new Uint8Array([1, 2, 3]),
  });
  store.close();
  return path;
}

function assertImported(dataDir: string): void {
  const store = new AncillaStore(join(dataDir, DB_FILE));
  try {
    assert.equal(store.getProject("/work/app")?.pinned, true);
    const session = store.getSession("s1");
    assert.equal(session?.title, "Fix the login flow");
    assert.equal(session?.titleSource, "user", "a title the user typed stays theirs");
    assert.equal(session?.archived, true);
    assert.equal(session?.origin, "helicon");
    assert.deepEqual([...(store.readAttachment("a1")?.bytes ?? [])], [1, 2, 3]);
  } finally {
    store.close();
  }
}

const RUNTIME = `${JSON.stringify(
  {
    runtime: "wsl",
    distro: "Ubuntu",
    musePath: "/home/me/.local/bin/muse",
    wslEnv: { MUSE_CONFIG_DIR: "/home/me/.muse" },
    syncSessionNames: false,
  },
  null,
  2,
)}\n`;

describe("Helicon database import", () => {
  it("leaves a data dir with no Helicon data to start empty", () => {
    const root = scratch();
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const { lines, log } = logger();
    assert.equal(importLegacyDatabase(dataDir, root, log), false);
    assert.deepEqual(listing(dataDir), []);
    assert.deepEqual(lines, []);
    assert.equal(importLegacyDatabase(":memory:", root, log), false);
  });

  it("copies a helicon.db kept in the data dir itself, and leaves it byte for byte as it was", () => {
    const root = scratch();
    const dataDir = join(root, "data");
    const legacy = seedHelicon(dataDir);
    const before = digest(legacy);
    const { lines, log } = logger();
    assert.equal(importLegacyDatabase(dataDir, root, log), true);
    assertImported(dataDir);
    assert.equal(digest(legacy), before);
    assert.deepEqual(listing(dataDir), [DB_FILE, LEGACY_DB_FILE], "no snapshot leftovers beside it");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /imported Helicon's data from/);
    assert.ok(lines[0]!.includes(legacy), "the log names the source");
  });

  it("finds the Helicon desktop app's folder beside the Ancilla one, runtime.json included", () => {
    const root = scratch();
    const legacyDir = join(root, "app.helicon.desktop");
    const legacy = seedHelicon(legacyDir);
    writeFileSync(join(legacyDir, "runtime.json"), RUNTIME);
    writeFileSync(join(legacyDir, "server-port"), "52314");
    const before = { db: digest(legacy), runtime: digest(join(legacyDir, "runtime.json")), files: listing(legacyDir) };
    const dataDir = join(root, "app.ancilla.desktop");
    const { lines, log } = logger();
    // The server reads runtime.json before it opens the store, so that import goes first.
    assert.equal(importLegacyRuntime(dataDir, join(root, "home"), log), true);
    assert.equal(importLegacyDatabase(dataDir, join(root, "home"), log), true);
    assertImported(dataDir);
    assert.equal(readFileSync(join(dataDir, "runtime.json"), "utf8"), RUNTIME, "runtime.json arrives unchanged");
    assert.deepEqual(listing(dataDir), [DB_FILE, "runtime.json"], "the port file stays Helicon's");
    assert.deepEqual(
      { db: digest(legacy), runtime: digest(join(legacyDir, "runtime.json")), files: listing(legacyDir) },
      before,
      "Helicon's folder is untouched",
    );
    assert.equal(lines.length, 2);
  });

  it("looks in ~/.helicon only for the default ~/.ancilla", () => {
    const home = scratch();
    seedHelicon(join(home, ".helicon"));
    assert.equal(legacyDataDir(join(home, "elsewhere"), home), null);
    assert.equal(importLegacyDatabase(join(home, "elsewhere"), home, () => undefined), false);
    const dataDir = join(home, ".ancilla");
    assert.equal(legacyDataDir(dataDir, home), join(home, ".helicon"));
    assert.equal(importLegacyDatabase(dataDir, home, () => undefined), true);
    assertImported(dataDir);
  });

  it("prefers a helicon.db in the data dir over one in a sibling folder", () => {
    const root = scratch();
    const dataDir = join(root, "app.ancilla.desktop");
    seedHelicon(join(root, "app.helicon.desktop"));
    assert.equal(legacyDataDir(dataDir, root), join(root, "app.helicon.desktop"));
    seedHelicon(dataDir);
    assert.equal(legacyDataDir(dataDir, root), dataDir);
  });

  it("never replaces an ancilla.db that already exists", () => {
    const root = scratch();
    const legacyDir = join(root, "app.helicon.desktop");
    seedHelicon(legacyDir);
    writeFileSync(join(legacyDir, "runtime.json"), RUNTIME);
    const dataDir = join(root, "app.ancilla.desktop");
    mkdirSync(dataDir);
    const own = new AncillaStore(join(dataDir, DB_FILE));
    own.upsertProject("/work/mine");
    own.close();
    const before = digest(join(dataDir, DB_FILE));
    const { lines, log } = logger();
    assert.equal(importLegacyRuntime(dataDir, root, log), false, "a data dir that has started keeps its own runtime choice");
    assert.equal(importLegacyDatabase(dataDir, root, log), false);
    assert.equal(digest(join(dataDir, DB_FILE)), before);
    assert.deepEqual(listing(dataDir), [DB_FILE]);
    assert.deepEqual(lines, []);
  });

  for (const [label, damage] of [
    ["not a database at all", (bytes: Buffer) => Buffer.from("definitely not sqlite ".repeat(300))],
    ["cut off halfway", (bytes: Buffer) => bytes.subarray(0, Math.floor(bytes.length / 2))],
  ] as const) {
    it(`starts fresh, without crashing or leaving a partial copy, when helicon.db is ${label}`, async () => {
      const root = scratch();
      const legacyDir = join(root, "app.helicon.desktop");
      const legacy = seedHelicon(legacyDir);
      const filler = new DatabaseSync(legacy);
      filler.exec("CREATE TABLE filler (x TEXT)");
      const insert = filler.prepare("INSERT INTO filler VALUES (?)");
      for (let row = 0; row < 400; row += 1) insert.run(`row ${row} ${"x".repeat(300)}`);
      filler.close();
      writeFileSync(legacy, damage(readFileSync(legacy)));
      const before = digest(legacy);
      const dataDir = join(root, "app.ancilla.desktop");
      const { lines, log } = logger();
      assert.equal(importLegacyDatabase(dataDir, root, log), false);
      assert.deepEqual(listing(dataDir), [], "neither ancilla.db nor the temporary copy is left");
      assert.equal(digest(legacy), before);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /could not import Helicon's data from .*starting fresh/);

      // The server comes up on an empty store, and does not try again once it has one.
      const { value: server, stderr } = quietly(() => serverFor(dataDir, root));
      assert.match(stderr, /starting fresh/);
      assert.deepEqual(await projectsOf(server), []);
      assert.deepEqual(listing(dataDir), [DB_FILE]);
      assert.equal(importLegacyDatabase(dataDir, root, log), false);
    });
  }

  it("snapshots a database Helicon has open in WAL mode: committed writes in, the open transaction out", () => {
    const root = scratch();
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const legacy = join(dataDir, LEGACY_DB_FILE);
    const helicon = new DatabaseSync(legacy);
    try {
      helicon.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      helicon.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, cwd TEXT)");
      helicon.exec("INSERT INTO projects (cwd) VALUES ('/work/in-the-wal')");
      helicon.exec("BEGIN IMMEDIATE; INSERT INTO projects (cwd) VALUES ('/work/uncommitted');");
      const before = digest(legacy);
      assert.equal(importLegacyDatabase(dataDir, root, () => undefined), true);
      assert.equal(digest(legacy), before, "only Helicon's own checkpoint ever writes its file");
      const copy = new DatabaseSync(join(dataDir, DB_FILE), { readOnly: true });
      const rows = copy.prepare("SELECT cwd FROM projects ORDER BY id").all().map((row) => row["cwd"]);
      copy.close();
      assert.deepEqual(rows, ["/work/in-the-wal"]);
      helicon.exec("COMMIT");
    } finally {
      helicon.close();
    }
  });

  it("clears snapshots a killed import left behind, but not one still being written", () => {
    const root = scratch();
    const dataDir = join(root, "data");
    seedHelicon(dataDir);
    const stale = join(dataDir, ".ancilla.db.import-4242.tmp");
    const live = join(dataDir, ".ancilla.db.import-4343.tmp");
    writeFileSync(stale, "half a copy");
    writeFileSync(live, "another Ancilla's copy in progress");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(stale, old, old);
    assert.equal(importLegacyDatabase(dataDir, root, () => undefined), true);
    assertImported(dataDir);
    assert.deepEqual(listing(dataDir), [".ancilla.db.import-4343.tmp", DB_FILE, LEGACY_DB_FILE]);
    // Once that one stops changing, a later start clears it as well, although this data dir has started by now.
    utimesSync(live, old, old);
    assert.equal(importLegacyDatabase(dataDir, root, () => undefined), false);
    assert.deepEqual(listing(dataDir), [DB_FILE, LEGACY_DB_FILE]);
  });

  it("opens the server on Helicon's projects the first time the desktop app starts", async () => {
    const root = scratch();
    seedHelicon(join(root, "app.helicon.desktop"));
    const dataDir = join(root, "app.ancilla.desktop");
    mkdirSync(dataDir);
    const { value: server, stderr } = quietly(() => serverFor(dataDir, root));
    assert.match(stderr, /\[ancilla\] \S+ imported Helicon's data from .*app\.helicon\.desktop/);
    assert.deepEqual((await projectsOf(server)).map((p) => [p.cwd, p.pinned]), [["/work/app", true]]);
  });
});

describe("putting the snapshot in place", () => {
  function snapshotIn(root: string): { temp: string; target: string } {
    const temp = join(root, ".ancilla.db.import-1.tmp");
    writeFileSync(temp, "snapshot");
    return { temp, target: join(root, DB_FILE) };
  }

  /** A rename that fails `times` times with `code`, as when a scanner holds the file, then goes through. */
  function heldFor(code: string, times: number): { rename: (from: string, to: string) => void; calls: () => number } {
    let calls = 0;
    return {
      rename: (from, to) => {
        calls += 1;
        if (calls <= times) {
          throw Object.assign(new Error(`${code}: file in use`), { code });
        }
        renameSync(from, to);
      },
      calls: () => calls,
    };
  }

  it("tries again on Windows while something holds the new file", () => {
    const { temp, target } = snapshotIn(scratch());
    const held = heldFor("EBUSY", 2);
    publishSnapshot(temp, target, "win32", held.rename);
    assert.equal(held.calls(), 3);
    assert.equal(readFileSync(target, "utf8"), "snapshot");
    assert.equal(existsSync(temp), false);
  });

  it("gives up after a few tries, and at once for other errors or on other systems", () => {
    for (const [platform, code, calls] of [
      ["win32", "EACCES", 5],
      ["win32", "ENOENT", 1],
      ["linux", "EPERM", 1],
    ] as const) {
      const { temp, target } = snapshotIn(scratch());
      const held = heldFor(code, Number.POSITIVE_INFINITY);
      assert.throws(() => publishSnapshot(temp, target, platform, held.rename), { code });
      assert.equal(held.calls(), calls, `${platform} ${code}`);
      assert.equal(existsSync(target), false);
    }
  });

  it("never replaces an ancilla.db another Ancilla created in the meantime", () => {
    const { temp, target } = snapshotIn(scratch());
    writeFileSync(target, "another Ancilla's");
    assert.throws(() => publishSnapshot(temp, target, "linux", renameSync), /was created while importing/);
    assert.equal(readFileSync(target, "utf8"), "another Ancilla's");

    // Nor one that shows up between two tries.
    rmSync(target);
    let calls = 0;
    const raced = () => {
      calls += 1;
      writeFileSync(target, "another Ancilla's");
      throw Object.assign(new Error("EPERM: file in use"), { code: "EPERM" });
    };
    assert.throws(() => publishSnapshot(temp, target, "win32", raced), /was created while importing/);
    assert.equal(calls, 1);
    assert.equal(readFileSync(target, "utf8"), "another Ancilla's");
  });
});

describe("Helicon runtime.json import", () => {
  it("keeps a runtime.json the data dir already has", () => {
    const home = scratch();
    seedHelicon(join(home, ".helicon"));
    writeFileSync(join(home, ".helicon", "runtime.json"), RUNTIME);
    const dataDir = join(home, ".ancilla");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "runtime.json"), `{"runtime":"native"}\n`);
    assert.equal(importLegacyRuntime(dataDir, home, () => undefined), false);
    assert.equal(readFileSync(join(dataDir, "runtime.json"), "utf8"), `{"runtime":"native"}\n`);
  });

  it("does not copy a runtime.json the server would refuse to start on", () => {
    const home = scratch();
    seedHelicon(join(home, ".helicon"));
    const dataDir = join(home, ".ancilla");
    for (const broken of ["{ not json", "[1, 2]", "null"]) {
      writeFileSync(join(home, ".helicon", "runtime.json"), broken);
      const { lines, log } = logger();
      assert.equal(importLegacyRuntime(dataDir, home, log), false);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /did not import Helicon's runtime settings/);
    }
    assert.equal(existsSync(join(dataDir, "runtime.json")), false);
  });

  it("has nothing to copy when Helicon never ran", () => {
    const home = scratch();
    assert.equal(importLegacyRuntime(join(home, ".ancilla"), home, () => undefined), false);
    assert.equal(importLegacyRuntime(":memory:", home, () => undefined), false);
  });
});

describe("Helicon environment variables", () => {
  it("honours HELICON_* after ANCILLA_*", () => {
    assert.equal(envSetting("MUSE_RUNTIME", { ANCILLA_MUSE_RUNTIME: "native", HELICON_MUSE_RUNTIME: "wsl" }), "native");
    assert.equal(envSetting("MUSE_RUNTIME", { HELICON_MUSE_RUNTIME: "wsl" }), "wsl");
    assert.equal(envSetting("MUSE_RUNTIME", {}), undefined);
  });
});
