/**
 * The owner lock as the server uses it: nothing of the folder is opened before the lock is settled (no database, no
 * Helicon import, no sweep under a live owner), the record carries the bound port and the close, the lock is released
 * after the store, servers of one process share it, the boot budget cuts the sweeps' waits, a contended bind is
 * retried, `freePortFirst` frees the port before the hosts are waited for, and `/api/health` says what the lock is.
 * The lock's probe, pid check and clock are fakes; the folders, store and listener are real.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore } from "@ancilla/daemon";
import { AncillaServer, type ServerOptions } from "../src/server.js";
import { DataDirOwnedError, OWNER_LOCK_FILE, OWNER_POLL_MS, probeOwner } from "../src/ownerLock.js";
import { EXIT_DATA_DIR_OWNED } from "../src/exitCodes.js";
import { newRun, seededStore, tmpDir } from "./lifecycle-rig.js";
import { fakeOwnerDeps, ownerFile, ownerRecord, readOwner, readOwnerText, writeOwner } from "./ownerLockFakes.js";
import { FakeConnection, fakeFactory, get, rawRequest, send, start, waitFor } from "./harness.js";

function serverOver(dir: string, extra: Partial<ServerOptions> = {}): AncillaServer {
  const server = new AncillaServer({ port: 0, dataDir: dir, platform: "linux", musePath: "muse", home: dir, exec: async () => ({ stdout: "", exitCode: 127 }), ...extra });
  after(() => server.close().catch(() => undefined));
  return server;
}

/** A pid no process has; see ownerLock.test.ts. */
const deadPid = () => 2_147_000_000 + Math.floor(Math.random() * 400_000);

/** A listener on a free port of this machine, closed when the suite ends. */
async function stubListener(): Promise<{ port: number; stub: NetServer }> {
  const stub = createNetServer();
  // Registered from the test's own context: a hook registered inside the listen callback is not the test's.
  after(() => new Promise<void>((done) => stub.close(() => done())));
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { port: (stub.address() as { port: number }).port, stub };
}

/** Whether a listener can take the port right now. */
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

describe("a server over a folder another Ancilla owns", () => {
  it("opens nothing: no database, no Helicon import, no sweep; listen() is refused and close() is quiet", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const helicon = new AncillaStore(join(dir, "helicon.db"));
    helicon.upsertProject("/work/theirs");
    helicon.close();
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const before = readOwnerText(dir);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, { kind: "ancilla", instanceId: theirs.instanceId, closing: false }]]), alive: new Set([theirs.pid]) });
    const server = serverOver(dir, { ownerLock: deps });
    assert.equal(server["store"], undefined, "the store was opened under a live owner");
    assert.equal(server["researchJobs"], undefined);
    assert.deepEqual(readdirSync(dir).sort(), [OWNER_LOCK_FILE, "helicon.db"], "the constructor touched the folder");
    await assert.rejects(server.listen(), (error: unknown) => {
      assert.ok(error instanceof DataDirOwnedError);
      assert.equal(error.exitCode, EXIT_DATA_DIR_OWNED);
      assert.equal(error.owner.instanceId, theirs.instanceId);
      return true;
    });
    assert.equal(server["store"], undefined, "the store was opened after the refusal");
    assert.deepEqual(readdirSync(dir).sort(), [OWNER_LOCK_FILE, "helicon.db"], "listen() touched the folder");
    assert.equal(server["server"].listening, false, "a refused server bound its port");
    assert.equal(readOwnerText(dir), before, "the owner's record changed");
    await server.close();
    assert.equal(readOwnerText(dir), before, "close() of a refused server changed the owner's record");
  });

  it("takes over a dead owner in listen(): the store opens only after the probe, the port is recorded, the sweep runs", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const seed = seededStore(join(dir, "ancilla.db"));
    const run = newRun(seed, "left", "running");
    seed.close();
    writeOwner(dir, ownerRecord({ port: 4100, pid: deadPid() }));
    const deps = fakeOwnerDeps();
    const storeAtProbe: boolean[] = [];
    const inner = deps.probe;
    deps.probe = async (host, port) => {
      storeAtProbe.push(server["store"] !== undefined);
      return inner(host, port);
    };
    const server = serverOver(dir, { ownerLock: deps });
    assert.equal(server["store"], undefined, "a contended claim opened the store in the constructor");
    const seeded = new AncillaStore(join(dir, "ancilla.db"));
    assert.equal(seeded.getResearchRun(run.id)?.status, "running", "constructing a server changes nothing");
    seeded.close();
    const bound = await server.listen();
    assert.deepEqual(storeAtProbe, [false], "the store was open when the owner was probed");
    const opened = server["store"] as AncillaStore | undefined;
    assert.notEqual(opened, undefined);
    assert.equal(opened!.getResearchRun(run.id)?.status, "interrupted", "the sweep ran once the folder was this server's");
    const record = readOwner(dir);
    assert.equal(record?.instanceId, server.instanceId);
    assert.equal(record?.port, bound.port);
    assert.equal(record?.pid, process.pid);
    assert.equal(record?.closingAt, null);
    await server.close();
    assert.equal(existsSync(ownerFile(dir)), false);
  });

  it("is closed by the harness after a refusal, store or no store", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const server = serverOver(dir, { ownerLock: fakeOwnerDeps({ probes: new Map([[4100, { kind: "ancilla", instanceId: theirs.instanceId, closing: false }]]) }) });
    await assert.rejects(server.listen(), DataDirOwnedError);
    await server.close();
    await server.close();
  });

  it("refuses to listen beyond the loopback without a token before it waits on any lock", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, { kind: "ancilla", instanceId: theirs.instanceId, closing: true }]]), alive: new Set([theirs.pid]) });
    const server = serverOver(dir, { host: "0.0.0.0", ownerLock: deps });
    await assert.rejects(server.listen(), /Refusing to listen on 0\.0\.0\.0/);
    assert.deepEqual(deps.probed, [], "the lock was probed before the bind address was refused");
  });
});

describe("the record of a running server", () => {
  it("says the close has begun before the research runs are closed, and is released only after the store", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const server = serverOver(dir);
    await server.listen();
    assert.equal(readOwner(dir)?.closingAt, null);
    const seen: string[] = [];
    const jobsClose = server["researchJobs"]!.close.bind(server["researchJobs"]);
    server["researchJobs"]!.close = async () => {
      seen.push(`jobs closing with closingAt ${readOwner(dir)?.closingAt === null ? "unset" : "set"}`);
      return jobsClose();
    };
    const storeClose = server["store"]!.close.bind(server["store"]);
    server["store"]!.close = () => {
      seen.push(`store closing with the record ${existsSync(ownerFile(dir)) ? "there" : "gone"}`);
      return storeClose();
    };
    await server.close();
    assert.deepEqual(seen, ["jobs closing with closingAt set", "store closing with the record there"]);
    assert.equal(existsSync(ownerFile(dir)), false, "the record was not released by close()");
  });

  it("is shared by the servers of one process over one folder, and names the survivor", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const first = await start(new FakeConnection(), { dataDir: dir });
    const second = await start(new FakeConnection(), { dataDir: dir });
    const firstHealth = await get(first.base, "/api/health");
    const secondHealth = await get(second.base, "/api/health");
    assert.equal(firstHealth.instanceId, first.server.instanceId);
    assert.equal(secondHealth.instanceId, second.server.instanceId);
    assert.notEqual(firstHealth.instanceId, secondHealth.instanceId);
    assert.equal(firstHealth.owner.lock, "held");
    assert.equal(secondHealth.owner.lock, "reentrant");
    assert.equal(readOwner(dir)?.instanceId, first.server.instanceId);
    assert.equal(readOwner(dir)?.port, Number(new URL(first.base).port));
    await first.server.close();
    assert.equal(readOwner(dir)?.instanceId, second.server.instanceId, "the file does not name the server still running");
    assert.equal(readOwner(dir)?.port, Number(new URL(second.base).port));
    assert.equal((await get(second.base, "/api/health")).owner.lock, "held");
    await second.server.close();
    assert.equal(existsSync(ownerFile(dir)), false);
  });

  it("is not written for :memory: or with the lock turned off, and health says so", async () => {
    const memory = await start(new FakeConnection());
    const memoryHealth = await get(memory.base, "/api/health");
    assert.equal(memoryHealth.owner.lock, "off");
    assert.equal(memoryHealth.owner.file, null);
    assert.equal(typeof memoryHealth.instanceId, "string");

    const dir = tmpDir("ancilla-lock-server-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const before = readOwnerText(dir);
    const off = await start(new FakeConnection(), { dataDir: dir, dataDirLock: false });
    const offHealth = await get(off.base, "/api/health");
    assert.equal(offHealth.owner.lock, "off");
    assert.equal(offHealth.owner.file, null);
    assert.equal(readOwnerText(dir), before, "a server with the lock off touched the record");
    await off.server.close();
    assert.equal(readOwnerText(dir), before);
  });
});

describe("/api/health", () => {
  it("carries the instance id and the lock in the authorised body, and stays 401 without a credential", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const { base, server } = await start(new FakeConnection(), { dataDir: dir, token: "secret-token-for-the-test" });
    const anonymous = await rawRequest(base, "/api/health");
    assert.equal(anonymous.status, 401, "the public minimal body is a later release's");
    assert.equal(anonymous.json?.instanceId, undefined);
    const authorised = await rawRequest(base, "/api/health", { headers: { authorization: "Bearer secret-token-for-the-test" } });
    assert.equal(authorised.status, 200);
    assert.equal(authorised.json.instanceId, server.instanceId);
    assert.deepEqual(authorised.json.owner, { lock: "held", pid: process.pid, startedAt: readOwner(dir)?.startedAt, file: ownerFile(dir) });
    assert.equal(typeof authorised.json.hosts, "object", "the rest of the body is as it was");
    assert.equal(authorised.json.closing, false);
  });

  it("is what the lock's probe reads: an Ancilla with its id, an Ancilla behind a token with none, something else, nothing", async () => {
    const open = await start(new FakeConnection());
    assert.deepEqual(await probeOwner("127.0.0.1", Number(new URL(open.base).port)), { kind: "ancilla", instanceId: open.server.instanceId, closing: false });
    const tokened = await start(new FakeConnection(), { token: "secret-token-for-the-test" });
    assert.deepEqual(await probeOwner("127.0.0.1", Number(new URL(tokened.base).port)), { kind: "ancilla", instanceId: null, closing: false });
    const other = createHttpServer((_request, response) => response.end("hi"));
    after(() => new Promise<void>((done) => other.close(() => done())));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    assert.deepEqual(await probeOwner("127.0.0.1", (other.address() as { port: number }).port), { kind: "other" });
    const { port: free, stub: closing } = await stubListener();
    await new Promise<void>((done) => closing.close(() => done()));
    assert.deepEqual(await probeOwner("127.0.0.1", free), { kind: "down" });
    assert.deepEqual(await probeOwner("0.0.0.0", Number(new URL(open.base).port)), { kind: "ancilla", instanceId: open.server.instanceId, closing: false }, "a wildcard bind is probed on the loopback");
  });
});

describe("the boot budget", () => {
  it("cuts the sweeps' waits over a locked database when it is spent, and the ready promise resolves", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const seed = seededStore(join(dir, "ancilla.db"));
    const run = newRun(seed, "left", "running");
    seed.close();
    const deps = fakeOwnerDeps();
    const server = serverOver(dir, { ownerLock: deps, bootBudgetMs: 1_000, bootSweepRetryMs: [250, 500, 1_000, 2_000] });
    const holder = new DatabaseSync(join(dir, "ancilla.db"));
    holder.exec("BEGIN IMMEDIATE");
    after(() => {
      try {
        holder.exec("ROLLBACK");
      } catch {
        /* released already */
      }
      holder.close();
    });
    const bound = await server.listen();
    assert.deepEqual(deps.waits, [250, 500, 250], "the third wait is cut at the budget, and the turn sweep never waits");
    assert.equal((await get(`http://127.0.0.1:${bound.port}`, "/api/health")).research.interruptedAtBoot, 0);
    assert.equal(server["store"]!.getResearchRun(run.id)?.status, "running", "the row is left for the next start");
  });

  it("bounds the lock wait too: a closing owner is waited for only as long as the budget has left", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, { kind: "ancilla", instanceId: theirs.instanceId, closing: true }]]), alive: new Set([theirs.pid]) });
    const server = serverOver(dir, { ownerLock: deps, bootBudgetMs: 3_000 });
    await server.listen();
    assert.equal(deps.waits.reduce((sum, ms) => sum + ms, 0), 3_000);
    assert.equal(readOwner(dir)?.instanceId, server.instanceId);
  });
});

describe("binding the port", () => {
  it("is retried while the folder's last owner still holds the port, when the lock was contended at the claim", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const { port, stub } = await stubListener();
    writeOwner(dir, ownerRecord({ port, pid: deadPid() }));
    const deps = fakeOwnerDeps();
    const started = deps.clock.now();
    const inner = deps.wait;
    deps.wait = async (ms, signal) => {
      const slept = await inner(ms, signal);
      if (deps.clock.now() - started >= 600 && stub.listening) {
        // The previous owner lets go of the port 600 ms after this one started waiting for it.
        await new Promise<void>((done) => stub.close(() => done()));
      }
      return slept;
    };
    const server = serverOver(dir, { port, ownerLock: deps });
    const bound = await server.listen();
    assert.equal(bound.port, port);
    assert.deepEqual(deps.waits, [OWNER_POLL_MS, OWNER_POLL_MS, OWNER_POLL_MS]);
    assert.ok(deps.lines.some((line) => /still in use/.test(line)), deps.lines.join("\n"));
    assert.equal((await get(`http://127.0.0.1:${port}`, "/api/health")).instanceId, server.instanceId);
  });

  it("fails at once on a port in use when nobody owned the folder: an unrelated holder is not waited for", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const { port } = await stubListener();
    const deps = fakeOwnerDeps();
    const server = serverOver(dir, { port, ownerLock: deps });
    await assert.rejects(server.listen(), /EADDRINUSE/);
    assert.deepEqual(deps.waits, []);
  });
});

describe("close({ freePortFirst: true })", () => {
  it("frees the port before a slow host close resolves", async () => {
    const dir = tmpDir("ancilla-lock-server-");
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    let releaseHost!: () => void;
    const hostClosing = new Promise<{ code: number; signal: null }>((resolve) => {
      releaseHost = () => resolve({ code: 0, signal: null });
    });
    const plain = fakeFactory(connection);
    const { base, server } = await start(connection, { dataDir: dir, hostFactory: (target) => ({ ...plain(target), close: () => hostClosing }) });
    assert.equal((await send(base, "/api/sessions", { cwd: dir })).status, 200);
    const port = Number(new URL(base).port);
    const closing = server.close({ freePortFirst: true });
    await waitFor(() => bindable(port), "the port to be free while the host is still closing");
    assert.equal(readOwner(dir)?.closingAt === null, false, "the record says the close has begun while the host winds down");
    releaseHost();
    await closing;
    assert.equal(existsSync(ownerFile(dir)), false);
  });
});
