/**
 * The data folder's owner lock on its own, with fakes for the probe, the pid check and the clock (a wait moves the
 * clock and never arms a timer): the claim, every verdict `resolve()` can reach, re-entry within one process, the
 * release, the 'exit' hook (with real child processes), a record from another system, and the exclusivity of the
 * claim itself between two processes. Real temp folders; no server.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DataDirOwnedError,
  OWNER_LOCK_FILE,
  OWNER_LOCK_WAIT_MS,
  OWNER_POLL_MS,
  claimOwnerLock,
  parseOwnerRecord,
  pidAlive,
  releaseAllOwnerLocksSync,
  type OwnerProbe,
} from "../src/ownerLock.js";
import { EXIT_DATA_DIR_OWNED } from "../src/exitCodes.js";
import { tmpDir } from "./lifecycle-rig.js";
import { fakeOwnerDeps, identity, ownerFile, ownerRecord, readOwner, readOwnerText, writeOwner, writeOwnerText } from "./ownerLockFakes.js";
import { isRunning } from "./fakeMuse.js";
import { until } from "./cliRig.js";

const MODULE = join(__dirname, "..", "src", "ownerLock.js");
const live = (instanceId: string | null, closing = false): OwnerProbe => ({ kind: "ancilla", instanceId, closing });
/** A pid no process has: a child that has already exited; the system does not hand it out again at once. */
function deadPid(): number {
  // Zero is never a process, and `kill(0, 0)` would mean this process's group: the pid of a child that ran and exited.
  return 2_147_000_000 + Math.floor(Math.random() * 400_000);
}
const ROOT_SKIP = typeof process.getuid === "function" && process.getuid() === 0 ? "root ignores file modes" : false;

describe("claiming a folder nobody owns", () => {
  it("writes the record, with no port yet, reads it back and holds the lock", () => {
    const dir = tmpDir("ancilla-lock-");
    const deps = fakeOwnerDeps();
    const me = identity();
    const lock = claimOwnerLock(dir, me, deps);
    assert.equal(lock.state, "held");
    assert.equal(lock.wasContended, false);
    assert.equal(lock.healthLock(), "held");
    assert.equal(lock.file, ownerFile(dir));
    const text = readFileSync(ownerFile(dir), "utf8");
    assert.ok(text.endsWith("\n") && text.split("\n").length === 2, "one JSON line");
    assert.deepEqual(JSON.parse(text), { format: 1, ...me, port: null, closingAt: null });
    assert.deepEqual(deps.waits, []);
    lock.setPort(4100);
    assert.equal(readOwner(dir)?.port, 4100, "the bound port is written into the record");
    lock.markClosing();
    assert.equal(readOwner(dir)?.closingAt, new Date(deps.clock.now()).toISOString());
    lock.release();
    assert.equal(lock.state, "released");
    assert.equal(existsSync(ownerFile(dir)), false, "the last release removes the file");
    assert.equal(lock.healthLock(), "off");
  });

  it("is off for :memory: and when the lock is not asked for, and touches nothing", () => {
    const dir = tmpDir("ancilla-lock-");
    assert.equal(claimOwnerLock(":memory:", identity(), fakeOwnerDeps()).state, "off");
    const off = claimOwnerLock(dir, identity(), fakeOwnerDeps(), { enabled: false });
    assert.equal(off.state, "off");
    assert.equal(off.file, null);
    assert.equal(off.healthLock(), "off");
    off.setPort(1);
    off.markClosing();
    off.release();
    assert.equal(existsSync(ownerFile(dir)), false);
  });

  it("does nothing on resolve() when it is held", async () => {
    const dir = tmpDir("ancilla-lock-");
    const deps = fakeOwnerDeps();
    const lock = claimOwnerLock(dir, identity(), deps);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.deepEqual(deps.waits, []);
    lock.release();
  });
});

describe("a folder with a record in it", () => {
  it("is contended at the claim, with nothing written and the record read", () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const before = readOwnerText(dir);
    const lock = claimOwnerLock(dir, identity(), fakeOwnerDeps());
    assert.equal(lock.state, "contended");
    assert.equal(lock.wasContended, true);
    assert.deepEqual(lock.existing, theirs);
    assert.equal(readOwnerText(dir), before, "the claim changed the file");
    lock.release();
    assert.equal(readOwnerText(dir), before, "releasing a contended lock touched the owner's file");
  });

  it("is taken over at once when its port is down and its pid is dead", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100, pid: deadPid() });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps();
    const me = identity();
    const lock = claimOwnerLock(dir, me, deps);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.equal(lock.tookOverFromClosing, false);
    assert.deepEqual(deps.waits, [], "a dead owner is not waited for");
    assert.deepEqual(deps.probed, [4100]);
    assert.equal(readOwner(dir)?.instanceId, me.instanceId);
    assert.equal(deps.lines.length, 1);
    assert.match(deps.lines[0]!, /taking over the data folder .*is gone/);
    lock.release();
    assert.equal(existsSync(ownerFile(dir)), false);
  });

  it("waits the whole budget, never less, for an owner whose port is down while its pid is alive (recycled, or blocked)", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100, startedAt: "2026-10-14T18:00:00.000Z" });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ alive: new Set([theirs.pid]) });
    const lock = claimOwnerLock(dir, identity(), deps);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.equal(lock.tookOverFromClosing, false);
    assert.equal(deps.waits.reduce((sum, ms) => sum + ms, 0), OWNER_LOCK_WAIT_MS, "the wait is the full budget");
    assert.ok(deps.waits.every((ms) => ms === OWNER_POLL_MS));
    assert.equal(deps.probed.length, deps.waits.length + 1, "the port is probed on every pass");
    assert.match(deps.lines.at(-1)!, /did not answer within 10 s/);
    lock.release();
  });

  it("waits the same for a record with no port yet, and refuses once the owner binds and answers as itself", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord();
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ alive: new Set([theirs.pid]) });
    const inner = deps.wait;
    deps.wait = async (ms, signal) => {
      const slept = await inner(ms, signal);
      if (deps.waits.length === 2) {
        // The owner finishes its boot: it writes its port and its health answers.
        writeOwner(dir, { ...theirs, port: 4100 });
        deps.probes.set(4100, live(theirs.instanceId));
      }
      return slept;
    };
    const lock = claimOwnerLock(dir, identity(), deps);
    await assert.rejects(lock.resolve(), (error: unknown) => {
      assert.ok(error instanceof DataDirOwnedError);
      assert.equal(error.exitCode, EXIT_DATA_DIR_OWNED);
      assert.equal(error.owner.instanceId, theirs.instanceId);
      assert.equal(error.owner.port, 4100);
      assert.equal(error.crossPlatform, false);
      assert.match(error.message, new RegExp(`another Ancilla \\(pid ${theirs.pid}, started ${theirs.startedAt}, http://127\\.0\\.0\\.1:4100\\) owns the data folder `));
      assert.ok(error.message.includes(dir));
      assert.match(error.message, /close it first, or start this one with --data-dir <other folder>\. \(.*ancilla\.owner holds the record\)$/);
      return true;
    });
    assert.equal(lock.state, "contended");
    assert.deepEqual(deps.waits, [OWNER_POLL_MS, OWNER_POLL_MS]);
    assert.equal(readOwner(dir)?.instanceId, theirs.instanceId, "the owner's record is untouched");
  });

  it("refuses a live owner at once, with the file untouched byte for byte", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const before = readOwnerText(dir);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, live(theirs.instanceId)]]) });
    const lock = claimOwnerLock(dir, identity(), deps);
    await assert.rejects(lock.resolve(), DataDirOwnedError);
    assert.deepEqual(deps.waits, []);
    assert.equal(readOwnerText(dir), before);
    assert.deepEqual(deps.lines, []);
    lock.release();
    assert.equal(readOwnerText(dir), before);
  });

  it("counts an older build, whose health answers 401 with no instance id, as live only while its pid is alive", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const refusing = claimOwnerLock(dir, identity(), fakeOwnerDeps({ probes: new Map([[4100, live(null)]]), alive: new Set([theirs.pid]) }));
    await assert.rejects(refusing.resolve(), DataDirOwnedError);

    const deps = fakeOwnerDeps({ probes: new Map([[4100, live(null)]]) });
    const me = identity();
    const lock = claimOwnerLock(dir, me, deps);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.deepEqual(deps.waits, []);
    assert.equal(readOwner(dir)?.instanceId, me.instanceId);
    lock.release();
  });

  it("takes over when another Ancilla answers on the port, or something that is not one", async () => {
    for (const probe of [live(randomUUID()), { kind: "other" } as const]) {
      const dir = tmpDir("ancilla-lock-");
      const theirs = ownerRecord({ port: 4100 });
      writeOwner(dir, theirs);
      const deps = fakeOwnerDeps({ probes: new Map([[4100, probe]]), alive: new Set([theirs.pid]) });
      const me = identity();
      const lock = claimOwnerLock(dir, me, deps);
      await lock.resolve();
      assert.equal(lock.state, "held", JSON.stringify(probe));
      assert.deepEqual(deps.waits, [], "the pid being alive counts for nothing once the port says the owner is gone");
      assert.equal(readOwner(dir)?.instanceId, me.instanceId);
      lock.release();
    }
  });

  it("waits for an owner that is closing until its record is gone, and takes nothing from it", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100, closingAt: "2026-10-14T20:00:01.000Z" });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, live(theirs.instanceId, true)]]), alive: new Set([theirs.pid]) });
    const inner = deps.wait;
    deps.wait = async (ms, signal) => {
      const slept = await inner(ms, signal);
      if (deps.waits.length === 3) {
        unlinkSync(ownerFile(dir));
      }
      return slept;
    };
    const me = identity();
    const lock = claimOwnerLock(dir, me, deps);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.equal(lock.tookOverFromClosing, false);
    assert.deepEqual(deps.waits, [OWNER_POLL_MS, OWNER_POLL_MS, OWNER_POLL_MS]);
    assert.deepEqual(deps.lines, [], "nothing was taken over");
    assert.equal(readOwner(dir)?.instanceId, me.instanceId);
    lock.release();
  });

  it("waits the same when only the record says the owner is closing, its health still answering as before", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100, closingAt: "2026-10-14T20:00:01.000Z" });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, live(theirs.instanceId)]]), alive: new Set([theirs.pid]) });
    const lock = claimOwnerLock(dir, identity(), deps);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.equal(lock.tookOverFromClosing, true);
    assert.equal(deps.waits.reduce((sum, ms) => sum + ms, 0), OWNER_LOCK_WAIT_MS);
    lock.release();
  });

  it("takes over an owner that is still closing when the budget is spent, and says so", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, live(theirs.instanceId, true)]]), alive: new Set([theirs.pid]), waitMs: 2_000 });
    const me = identity();
    const lock = claimOwnerLock(dir, me, deps);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.equal(lock.tookOverFromClosing, true);
    assert.equal(deps.waits.reduce((sum, ms) => sum + ms, 0), 2_000, "a shorter budget is a shorter wait");
    assert.equal(deps.lines.length, 1);
    assert.match(deps.lines[0]!, /closing there .*did not finish within 2 s/);
    assert.equal(readOwner(dir)?.instanceId, me.instanceId);
    lock.release();
  });

  it("takes a budget of its own, shorter than the deps' wait, from the caller", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, live(theirs.instanceId, true)]]), alive: new Set([theirs.pid]) });
    const lock = claimOwnerLock(dir, identity(), deps);
    await lock.resolve({ budgetMs: 1_000 });
    assert.equal(lock.state, "held");
    assert.equal(deps.waits.reduce((sum, ms) => sum + ms, 0), 1_000);
    lock.release();
  });

  it("re-reads a torn record on every pass, and uses it once it is whole", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100, pid: deadPid() });
    const whole = JSON.stringify(theirs) + "\n";
    writeOwnerText(dir, whole.slice(0, Math.floor(whole.length / 2)));
    const deps = fakeOwnerDeps();
    const inner = deps.wait;
    deps.wait = async (ms, signal) => {
      const slept = await inner(ms, signal);
      if (deps.waits.length === 2) {
        writeOwnerText(dir, whole);
      }
      return slept;
    };
    const me = identity();
    const lock = claimOwnerLock(dir, me, deps);
    assert.equal(lock.state, "contended");
    assert.equal(lock.existing, null);
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.deepEqual(deps.waits, [OWNER_POLL_MS, OWNER_POLL_MS], "two torn reads, then the whole record: a dead owner, taken over at once");
    assert.deepEqual(deps.probed, [4100]);
    assert.equal(readOwner(dir)?.instanceId, me.instanceId);
    lock.release();
  });

  it("takes over a record that never becomes readable only when the budget is spent", async () => {
    for (const text of ["", "{\"format\":1,\"instanceId\":\"x\"", "not json at all\n", "[]"]) {
      const dir = tmpDir("ancilla-lock-");
      writeOwnerText(dir, text);
      const deps = fakeOwnerDeps();
      const me = identity();
      const lock = claimOwnerLock(dir, me, deps);
      await lock.resolve();
      assert.equal(lock.state, "held", JSON.stringify(text));
      assert.equal(deps.waits.reduce((sum, ms) => sum + ms, 0), OWNER_LOCK_WAIT_MS, `${JSON.stringify(text)} was taken over before the budget`);
      assert.deepEqual(deps.probed, [], "nothing to probe");
      assert.match(deps.lines[0]!, /its record could not be read/);
      assert.equal(readOwner(dir)?.instanceId, me.instanceId);
      lock.release();
    }
  });

  it("stops waiting, with nothing taken, when the signal fires: the server that asked is closing", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100 });
    writeOwner(dir, theirs);
    const before = readOwnerText(dir);
    const deps = fakeOwnerDeps({ probes: new Map([[4100, live(theirs.instanceId, true)]]), alive: new Set([theirs.pid]) });
    const closing = new AbortController();
    const inner = deps.wait;
    deps.wait = async (ms, signal) => {
      if (deps.waits.length === 1) {
        closing.abort();
      }
      return inner(ms, signal);
    };
    const lock = claimOwnerLock(dir, identity(), deps);
    await lock.resolve({ signal: closing.signal });
    assert.equal(lock.state, "contended");
    assert.deepEqual(deps.waits, [OWNER_POLL_MS]);
    assert.equal(readOwnerText(dir), before);
    assert.deepEqual(deps.lines, []);
    lock.release();
    assert.equal(readOwnerText(dir), before);
  });

  it("refuses a record from another system, naming the file and saying to delete it, whatever the port says", async () => {
    const dir = tmpDir("ancilla-lock-");
    const theirs = ownerRecord({ port: 4100, platform: process.platform === "win32" ? "linux" : "win32", pid: deadPid() });
    writeOwner(dir, theirs);
    const deps = fakeOwnerDeps();
    const lock = claimOwnerLock(dir, identity(), deps);
    await assert.rejects(lock.resolve(), (error: unknown) => {
      assert.ok(error instanceof DataDirOwnedError);
      assert.equal(error.crossPlatform, true);
      assert.equal(error.exitCode, EXIT_DATA_DIR_OWNED);
      assert.ok(error.message.includes(ownerFile(dir)), error.message);
      assert.match(error.message, /from another system/);
      assert.match(error.message, /delete it when no other Ancilla runs\)$/);
      assert.match(error.message, new RegExp(`pid ${theirs.pid} on ${theirs.platform}`));
      return true;
    });
    assert.deepEqual(deps.probed, [], "a port on another system is not probed");
    assert.deepEqual(deps.waits, []);
    assert.equal(readOwner(dir)?.instanceId, theirs.instanceId);
  });
});

describe("a folder whose lock cannot be written", () => {
  it("leaves the server without the lock, with one line, when the folder is not a folder", () => {
    const root = tmpDir("ancilla-lock-");
    const notADir = join(root, "file");
    writeFileSync(notADir, "x");
    const deps = fakeOwnerDeps();
    const lock = claimOwnerLock(notADir, identity(), deps);
    assert.equal(lock.state, "unavailable");
    assert.equal(lock.healthLock(), "unavailable");
    assert.equal(deps.lines.length, 1);
    assert.match(deps.lines[0]!, /the data folder lock could not be written \((ENOTDIR|ENOENT)\): running without it/);
    lock.setPort(1);
    lock.markClosing();
    lock.release();
    assert.equal(lock.state, "unavailable");
  });

  it("leaves the server without the lock when the folder cannot be written to", { skip: process.platform === "win32" ? "file modes are POSIX" : ROOT_SKIP }, () => {
    const dir = tmpDir("ancilla-lock-");
    chmodSync(dir, 0o500);
    try {
      const deps = fakeOwnerDeps();
      const lock = claimOwnerLock(dir, identity(), deps);
      assert.equal(lock.state, "unavailable");
      assert.match(deps.lines[0]!, /could not be written \(EACCES\)/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("leaves the server without the lock when the record there cannot be read", { skip: process.platform === "win32" ? "file modes are POSIX" : ROOT_SKIP }, async () => {
    const dir = tmpDir("ancilla-lock-");
    writeOwner(dir, ownerRecord({ port: 4100 }));
    chmodSync(ownerFile(dir), 0o000);
    try {
      const deps = fakeOwnerDeps();
      const lock = claimOwnerLock(dir, identity(), deps);
      assert.equal(lock.state, "unavailable");
      assert.match(deps.lines[0]!, /could not be read \(EACCES\)/);
      await lock.resolve();
      assert.equal(lock.state, "unavailable");
    } finally {
      chmodSync(ownerFile(dir), 0o600);
    }
  });
});

describe("servers of one process over one folder", () => {
  it("share one lock: the second is reentrant, the file names the first, then the second, then nobody", () => {
    const dir = tmpDir("ancilla-lock-");
    const first = identity();
    const second = identity();
    const one = claimOwnerLock(dir, first, fakeOwnerDeps());
    const two = claimOwnerLock(join(dir, ".", "..", dir.split(/[\\/]/).pop() as string), second, fakeOwnerDeps());
    assert.equal(one.state, "held");
    assert.equal(two.state, "reentrant");
    assert.equal(two.healthLock(), "reentrant");
    one.setPort(4100);
    two.setPort(4200);
    assert.equal(readOwner(dir)?.instanceId, first.instanceId);
    assert.equal(readOwner(dir)?.port, 4100);
    two.markClosing();
    assert.equal(readOwner(dir)?.closingAt, null, "a shared holder closing does not mark the owner's record");
    one.release();
    assert.equal(readOwner(dir)?.instanceId, second.instanceId, "the file now names the survivor");
    assert.equal(readOwner(dir)?.port, 4200);
    assert.equal(two.state, "held");
    assert.equal(two.healthLock(), "held");
    two.release();
    assert.equal(existsSync(ownerFile(dir)), false);
  });

  it("let a contended claim join them once one of them has taken the folder", async () => {
    const dir = tmpDir("ancilla-lock-");
    writeOwner(dir, ownerRecord({ port: 4100, pid: deadPid() }));
    const one = claimOwnerLock(dir, identity(), fakeOwnerDeps());
    const two = claimOwnerLock(dir, identity(), fakeOwnerDeps());
    assert.equal(one.state, "contended");
    assert.equal(two.state, "contended");
    await one.resolve();
    assert.equal(one.state, "held");
    await two.resolve();
    assert.equal(two.state, "reentrant");
    one.release();
    two.release();
    assert.equal(existsSync(ownerFile(dir)), false);
  });
});

describe("releasing the lock", () => {
  it("never deletes a successor's record", () => {
    const dir = tmpDir("ancilla-lock-");
    const lock = claimOwnerLock(dir, identity(), fakeOwnerDeps());
    const successor = ownerRecord({ port: 4300 });
    writeOwner(dir, successor);
    lock.release();
    assert.deepEqual(readOwner(dir), successor);
    releaseAllOwnerLocksSync();
    assert.deepEqual(readOwner(dir), successor);
  });

  it("is what the 'exit' hook does for every lock held, and the hook never throws", () => {
    const dir = tmpDir("ancilla-lock-");
    const other = tmpDir("ancilla-lock-");
    const one = claimOwnerLock(dir, identity(), fakeOwnerDeps());
    const two = claimOwnerLock(other, identity(), fakeOwnerDeps());
    assert.equal(one.state, "held");
    assert.equal(two.state, "held");
    unlinkSync(ownerFile(other));
    writeOwner(other, ownerRecord());
    mkdirSync(join(other, "x"));
    releaseAllOwnerLocksSync();
    assert.equal(existsSync(ownerFile(dir)), false);
    assert.notEqual(readOwner(other), null, "a foreign record stayed");
    assert.doesNotThrow(() => releaseAllOwnerLocksSync());
    one.release();
    two.release();
  });
});

/** A child that claims the folder with the real deps, prints its state, then exits or waits to be killed. */
function childScript(root: string): string {
  const script = join(root, "claim.js");
  writeFileSync(
    script,
    [
      'const { randomUUID } = require("node:crypto");',
      "const { claimOwnerLock, defaultOwnerLockDeps } = require(process.argv[2]);",
      "const [dir, mode] = process.argv.slice(3);",
      "const me = { instanceId: randomUUID(), pid: process.pid, host: \"127.0.0.1\", startedAt: new Date().toISOString(), ancillaVersion: \"test\", platform: process.platform };",
      "const lock = claimOwnerLock(dir, me, defaultOwnerLockDeps(() => undefined));",
      "process.stdout.write(`${lock.state}\\n`, () => {",
      '  if (mode === "exit") process.exit(0);',
      "});",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  return script;
}

function spawnClaim(script: string, dir: string, mode: "exit" | "wait") {
  const child = spawn(process.execPath, [script, MODULE, dir, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  return { child, closed, out: () => out, err: () => err };
}

describe("the 'exit' hook in a real process", () => {
  it("removes the record when the process exits on its own", { timeout: 30_000 }, async () => {
    const root = tmpDir("ancilla-lock-");
    const dir = join(root, "data");
    mkdirSync(dir);
    const claim = spawnClaim(childScript(root), dir, "exit");
    assert.equal(await claim.closed, 0, claim.err());
    assert.equal(claim.out(), "held\n");
    assert.equal(existsSync(ownerFile(dir)), false, "the exiting process left its record behind");
  });

  it("cannot run for a process that is killed: the record stays, and the next claim takes it over by the dead pid", { timeout: 30_000 }, async () => {
    const root = tmpDir("ancilla-lock-");
    const dir = join(root, "data");
    mkdirSync(dir);
    const claim = spawnClaim(childScript(root), dir, "wait");
    await until(() => claim.out() === "held\n", "the child to claim the folder");
    assert.equal(readOwner(dir)?.pid, claim.child.pid);
    claim.child.kill(process.platform === "win32" ? undefined : "SIGKILL");
    await claim.closed;
    await until(() => !isRunning(claim.child.pid as number), "the killed child to be gone");
    assert.equal(readOwner(dir)?.pid, claim.child.pid, "the record of a killed process is still there");
    assert.equal(pidAlive(claim.child.pid as number), false);

    const deps = { ...fakeOwnerDeps(), pidAlive };
    const me = identity();
    const lock = claimOwnerLock(dir, me, deps);
    assert.equal(lock.state, "contended");
    await lock.resolve();
    assert.equal(lock.state, "held");
    assert.deepEqual(deps.waits, []);
    assert.equal(readOwner(dir)?.instanceId, me.instanceId);
    lock.release();
  });
});

describe("the claim between two processes", () => {
  it("is exclusive: over 300 folders claimed by two processes at once, each has exactly one holder, whose record is whole", { timeout: 120_000 }, async () => {
    const root = tmpDir("ancilla-lock-race-");
    const COUNT = 300;
    for (let index = 0; index < COUNT; index += 1) {
      mkdirSync(join(root, `d${index}`));
    }
    const script = join(root, "race.js");
    writeFileSync(
      script,
      [
        'const { randomUUID } = require("node:crypto");',
        'const { join } = require("node:path");',
        "const { claimOwnerLock, defaultOwnerLockDeps } = require(process.argv[2]);",
        "const [root, count] = process.argv.slice(3);",
        "const deps = defaultOwnerLockDeps(() => undefined);",
        "const results = [];",
        "for (let index = 0; index < Number(count); index += 1) {",
        "  const me = { instanceId: randomUUID(), pid: process.pid, host: \"127.0.0.1\", startedAt: new Date().toISOString(), ancillaVersion: \"test\", platform: process.platform };",
        "  const lock = claimOwnerLock(join(root, `d${index}`), me, deps);",
        "  results.push([index, lock.state, me.instanceId]);",
        "}",
        "process.stdout.write(JSON.stringify(results) + \"\\n\");",
        // Held until the parent has read every file: the 'exit' hook then removes the ones this process holds.
        'process.stdin.on("end", () => process.exit(0));',
        "process.stdin.resume();",
        "",
      ].join("\n"),
      "utf8",
    );
    const start = () => {
      const child = spawn(process.execPath, [script, MODULE, root, String(COUNT)], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
      const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
      return { child, closed, out: () => out, err: () => err };
    };
    const a = start();
    const b = start();
    await until(() => a.out().endsWith("\n") && b.out().endsWith("\n"), `both racers to finish; stderr: ${a.err()} ${b.err()}`, 100_000);
    const results = [...JSON.parse(a.out()), ...JSON.parse(b.out())] as [number, string, string][];
    const winners = new Map<number, string>();
    for (const [index, state, instanceId] of results) {
      assert.ok(state === "held" || state === "contended", `d${index}: ${state}`);
      if (state === "held") {
        assert.equal(winners.has(index), false, `d${index} was claimed by both processes`);
        winners.set(index, instanceId);
      }
    }
    assert.equal(winners.size, COUNT, "a folder has no holder");
    for (let index = 0; index < COUNT; index += 1) {
      const record = parseOwnerRecord(readFileSync(join(root, `d${index}`, OWNER_LOCK_FILE), "utf8"));
      assert.equal(record?.instanceId, winners.get(index), `d${index} holds a record that is not its winner's`);
    }
    a.child.stdin.end();
    b.child.stdin.end();
    assert.equal(await a.closed, 0, a.err());
    assert.equal(await b.closed, 0, b.err());
    for (let index = 0; index < COUNT; index += 1) {
      assert.equal(existsSync(join(root, `d${index}`, OWNER_LOCK_FILE)), false, `d${index} kept its record after both processes exited`);
    }
  });
});

describe("parseOwnerRecord", () => {
  it("accepts the record as written and nothing else", () => {
    const record = ownerRecord({ port: 4100 });
    assert.deepEqual(parseOwnerRecord(JSON.stringify(record) + "\n"), record);
    assert.deepEqual(parseOwnerRecord(JSON.stringify({ ...record, ancillaVersion: undefined })), { ...record, ancillaVersion: "" });
    for (const bad of [
      JSON.stringify({ ...record, format: 2 }),
      JSON.stringify({ ...record, pid: "1" }),
      JSON.stringify({ ...record, port: "4100" }),
      JSON.stringify({ ...record, port: 1.5 }),
      JSON.stringify({ ...record, instanceId: 1 }),
      JSON.stringify({ ...record, closingAt: 1 }),
      JSON.stringify({ ...record, platform: null }),
      "null",
      "1",
      "[1]",
      "",
    ]) {
      assert.equal(parseOwnerRecord(bad), null, bad);
    }
  });
});
