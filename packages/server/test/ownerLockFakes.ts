/**
 * The owner lock's dependencies as fakes: a clock that moves only when a wait asks it to (no timer is ever armed, a
 * ten-second wait is forty microtasks), a probe scripted per port, a set of live pids, and the lines logged. Plus the
 * record helpers the suites share.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_LOCK_FILE, OWNER_LOCK_WAIT_MS, parseOwnerRecord, type OwnerIdentity, type OwnerLockDeps, type OwnerProbe, type OwnerRecord } from "../src/ownerLock.js";

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

export function fakeClock(start = Date.parse("2026-10-14T20:00:00.000Z")): FakeClock {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

export interface FakeOwnerDeps extends OwnerLockDeps {
  clock: FakeClock;
  /** Every wait asked for, in order. */
  waits: number[];
  /** Every port probed, in order. */
  probed: number[];
  lines: string[];
  probes: Map<number, OwnerProbe | (() => OwnerProbe)>;
  alive: Set<number>;
}

export function fakeOwnerDeps(options: { probes?: Map<number, OwnerProbe | (() => OwnerProbe)>; alive?: Set<number>; clock?: FakeClock; waitMs?: number } = {}): FakeOwnerDeps {
  const clock = options.clock ?? fakeClock();
  const probes = options.probes ?? new Map<number, OwnerProbe | (() => OwnerProbe)>();
  const alive = options.alive ?? new Set<number>();
  const deps: FakeOwnerDeps = {
    clock,
    waits: [],
    probed: [],
    lines: [],
    probes,
    alive,
    waitMs: options.waitMs ?? OWNER_LOCK_WAIT_MS,
    now: () => clock.now(),
    async wait(ms, signal) {
      if (signal?.aborted) {
        return false;
      }
      deps.waits.push(ms);
      clock.advance(ms);
      await Promise.resolve();
      return !signal?.aborted;
    },
    async probe(_host, port) {
      deps.probed.push(port);
      const scripted = probes.get(port);
      if (scripted === undefined) {
        return { kind: "down" };
      }
      return typeof scripted === "function" ? scripted() : scripted;
    },
    pidAlive: (pid) => alive.has(pid),
    log: (line) => { deps.lines.push(line); },
  };
  return deps;
}

/** An identity for a lock of this process, as the server builds one. */
export function identity(overrides: Partial<OwnerIdentity> = {}): OwnerIdentity {
  return {
    instanceId: randomUUID(),
    pid: process.pid,
    host: "127.0.0.1",
    startedAt: "2026-10-14T20:00:00.000Z",
    ancillaVersion: "0.21.0",
    platform: process.platform,
    ...overrides,
  };
}

/** A record as another server would have left it; the pid and port are ones a test chooses. */
export function ownerRecord(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return { format: 1, ...identity(), port: null, closingAt: null, ...overrides };
}

export function ownerFile(dir: string): string {
  return join(dir, OWNER_LOCK_FILE);
}

/** The record in the folder, or null when there is no file or it holds no record. */
export function readOwner(dir: string): OwnerRecord | null {
  if (!existsSync(ownerFile(dir))) {
    return null;
  }
  return parseOwnerRecord(readFileSync(ownerFile(dir), "utf8"));
}

/** The file's bytes as they are, for a byte-for-byte comparison. */
export function readOwnerText(dir: string): string | null {
  return existsSync(ownerFile(dir)) ? readFileSync(ownerFile(dir), "utf8") : null;
}

export function writeOwner(dir: string, record: OwnerRecord): void {
  writeFileSync(ownerFile(dir), JSON.stringify(record) + "\n");
}

/** Whatever bytes a test wants in the file: a torn record, an empty file. */
export function writeOwnerText(dir: string, text: string): void {
  writeFileSync(ownerFile(dir), text);
}
