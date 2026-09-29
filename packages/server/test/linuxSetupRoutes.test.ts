import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAonia } from "@harjjotsinghh/aonia";
import { AncillaServer } from "../src/server.js";
import { FakeConnection, fakeFactory, get, send, type FactoryProbe } from "./harness.js";

describe("Linux setup and thread-start routes", { skip: process.platform !== "linux" }, () => {
  async function fixture(t: TestContext, rootMode = 0o775) {
    const home = await mkdtemp(join(tmpdir(), "ancilla-linux-routes-"));
    const dataHome = join(home, "data");
    const root = join(dataHome, "muse");
    const configHome = join(home, "config");
    const oldDataHome = process.env["XDG_DATA_HOME"];
    const oldConfigHome = process.env["XDG_CONFIG_HOME"];
    // Each node:test file has its own process; these cases run sequentially. Never allow a
    // developer's inherited XDG paths to reach the automatic permission preflight.
    process.env["XDG_DATA_HOME"] = dataHome;
    process.env["XDG_CONFIG_HOME"] = configHome;
    let server: AncillaServer | null = null;
    t.after(async () => {
      await server?.close();
      if (oldDataHome === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = oldDataHome;
      if (oldConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = oldConfigHome;
      await rm(home, { recursive: true, force: true });
    });
    await mkdir(root, { recursive: true });
    await chmod(root, rootMode);
    const binary = join(home, ".local", "bin", "muse");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    // The path probe sees an executable, but every CLI call and MSP host is fake.
    await writeFile(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const aonia = createAonia({ home: join(home, "accounts"), platform: "linux", musePath: "muse", env: {
      HOME: home, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome,
    } });
    const connection = new FakeConnection();
    let session = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `thread-${++session}` } }));
    const hosts: FactoryProbe = { targets: [], exits: [] };
    const baseFactory = fakeFactory(connection, hosts);
    const rootModesAtHostStart: number[] = [];
    server = new AncillaServer({
      port: 0, dataDir: ":memory:", platform: "linux", home, musePath: "muse", aonia,
      exec: async (_command, args) => ({ stdout: args.includes("--version") ? "Muse 1.4.0-R0\n" : `${binary}\n`, exitCode: 0 }),
      hostFactory: (target) => {
        const host = baseFactory(target);
        return { ...host, start: async (params: Parameters<typeof host.start>[0]) => {
          const storage = join(target.env?.["XDG_DATA_HOME"] ?? dataHome, "muse");
          rootModesAtHostStart.push((await lstat(storage)).mode & 0o777);
          return host.start(params);
        } };
      },
      loginSpawn: () => { throw new Error("This test does not start Muse login."); },
      opener: async () => {},
    });
    const base = `http://127.0.0.1:${(await server.listen()).port}`;
    return { home, dataHome, root, configHome, binary, aonia, connection, hosts, rootModesAtHostStart, base };
  }

  it("reports repairable permissions without mutation, then repairs before the first host starts", async (t) => {
    const { home, root, base, hosts, rootModesAtHostStart, binary } = await fixture(t);
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    await chmod(sessions, 0o777);
    await writeFile(join(sessions, "history.json"), "existing conversation");
    const before = await get(base, "/api/setup/linux");
    assert.equal(before.supported, true);
    assert.equal(before.storage.status, "repairable");
    assert.equal(before.storage.path, root);
    assert.equal((await lstat(root)).mode & 0o777, 0o775);
    assert.equal(hosts.targets.length, 0);

    const started = await send(base, "/api/sessions", { cwd: home });
    assert.equal(started.status, 200);
    assert.equal(started.json.session.sessionId, "thread-1");
    assert.deepEqual(rootModesAtHostStart, [0o755]);
    assert.equal((await lstat(sessions)).mode & 0o777, 0o777);
    assert.equal(await readFile(join(sessions, "history.json"), "utf8"), "existing conversation");
    assert.equal(hosts.targets[0]?.command, binary);
    assert.equal(hosts.targets[0]?.env?.["HOME"], home);
    const after = await get(base, "/api/setup/linux");
    assert.equal(after.storage.status, "ready");
    await assert.rejects(lstat(join(root, "session-deletions")), { code: "ENOENT" });
  });

  it("offers explicit safe repair through setup and preserves login and history", async (t) => {
    const { root, configHome, base } = await fixture(t);
    const credentials = join(configHome, "muse", "auth.json");
    await mkdir(join(configHome, "muse"), { recursive: true });
    await writeFile(credentials, "fixture credentials", { mode: 0o600 });
    const repaired = await send(base, "/api/setup/linux/repair", {});
    assert.equal(repaired.status, 200);
    assert.equal(repaired.json.storage.status, "ready");
    assert.match(repaired.json.storage.message, /preserved/);
    assert.equal((await lstat(root)).mode & 0o777, 0o755);
    assert.equal(await readFile(credentials, "utf8"), "fixture credentials");
    assert.equal((await lstat(credentials)).mode & 0o777, 0o600);
    assert.equal((await send(base, "/api/setup/linux/repair", {})).json.storage.status, "ready");
  });

  it("blocks a foreign registry link before host creation and leaves both locations unchanged", async (t) => {
    const { home, root, base, hosts } = await fixture(t);
    const foreign = join(home, "foreign-records");
    await mkdir(foreign);
    await chmod(foreign, 0o777);
    await writeFile(join(foreign, "authority.json"), "existing authority");
    const registry = join(root, "session-deletions");
    await symlink(foreign, registry);

    const setup = await get(base, "/api/setup/linux");
    assert.equal(setup.storage.status, "blocked");
    assert.match(setup.storage.message, /symbolic link/);
    const repair = await send(base, "/api/setup/linux/repair", {});
    assert.equal(repair.json.storage.status, "blocked");
    const started = await send(base, "/api/sessions", { cwd: home });
    assert.equal(started.status, 409);
    assert.equal(started.json.kind, "muse_storage_unavailable");
    assert.match(started.json.error, /symbolic link/);
    assert.equal(hosts.targets.length, 0);
    assert.equal((await lstat(root)).mode & 0o777, 0o775);
    assert.equal((await lstat(foreign)).mode & 0o777, 0o777);
    assert.equal(await readFile(join(foreign, "authority.json"), "utf8"), "existing authority");
    assert.equal(await readlink(registry), foreign);
  });

  it("reports an incomplete registry instead of starting Muse or fabricating records", async (t) => {
    const { home, root, base, hosts } = await fixture(t, 0o700);
    const registry = join(root, "session-deletions");
    await mkdir(registry, { mode: 0o700 });
    await writeFile(join(registry, "authority.json"), "surviving authority", { mode: 0o600 });
    const setup = await get(base, "/api/setup/linux");
    assert.equal(setup.storage.status, "blocked");
    assert.match(setup.storage.message, /deletions.db is missing/);
    const started = await send(base, "/api/sessions", { cwd: home });
    assert.equal(started.status, 409);
    assert.equal(started.json.kind, "muse_storage_unavailable");
    assert.equal(hosts.targets.length, 0);
    assert.deepEqual(await readdir(registry), ["authority.json"]);
    assert.equal(await readFile(join(registry, "authority.json"), "utf8"), "surviving authority");
  });

  it("checks and repairs only the named account selected for the new thread", async (t) => {
    const { home, root, base, aonia, hosts, rootModesAtHostStart } = await fixture(t);
    const work = await aonia.createProfile("work");
    const personal = await aonia.createProfile("personal");
    const workRoot = join(work.roots.data, "muse");
    const personalRoot = join(personal.roots.data, "muse");
    await mkdir(workRoot, { recursive: true });
    await mkdir(personalRoot, { recursive: true });
    await chmod(workRoot, 0o775);
    await chmod(personalRoot, 0o777);
    const setup = await get(base, "/api/setup/linux?accountId=work");
    assert.equal(setup.storage.status, "repairable");
    assert.equal(setup.storage.path, workRoot);

    const started = await send(base, "/api/sessions", { cwd: home, accountId: "work" });
    assert.equal(started.status, 200);
    assert.deepEqual(rootModesAtHostStart, [0o755]);
    assert.equal(hosts.targets[0]?.env?.["XDG_DATA_HOME"], work.roots.data);
    assert.equal(hosts.targets[0]?.env?.["XDG_CONFIG_HOME"], work.roots.config);
    assert.equal(hosts.targets[0]?.env?.["HOME"], home);
    assert.equal((await lstat(root)).mode & 0o777, 0o775);
    assert.equal((await lstat(personalRoot)).mode & 0o777, 0o777);
    assert.equal((await lstat(workRoot)).mode & 0o777, 0o755);

    const repair = await send(base, "/api/setup/linux/repair", { accountId: "personal" });
    assert.equal(repair.json.storage.path, personalRoot);
    assert.equal(repair.json.storage.status, "ready");
    assert.equal((await lstat(personalRoot)).mode & 0o777, 0o755);
    assert.equal((await lstat(root)).mode & 0o777, 0o775);
  });

  it("rejects nonexistent or malformed account selections without touching default storage", async (t) => {
    const { root, base, hosts } = await fixture(t);
    const unknown = await send(base, "/api/setup/linux/repair", { accountId: "unknown" });
    assert.equal(unknown.status, 400);
    const malformed = await send(base, "/api/setup/linux/repair", { accountId: { path: root } });
    assert.equal(malformed.status, 400);
    assert.equal((await lstat(root)).mode & 0o777, 0o775);
    assert.equal(hosts.targets.length, 0);
  });
});
