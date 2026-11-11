import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAonia } from "@harjjotsinghh/aonia";
import type { ExecFn, ServeTarget } from "@ancilla/daemon";
import { DB_FILE } from "../src/legacy.js";
import {
  MuseSubscriptionReader,
  type MuseUsageCliRequest,
  type MuseUsageCliResult,
  type SubscriptionReading,
} from "../src/subscriptionQuota.js";
import { FakeConnection, fakeFactory, get, send, sseEvents, start, waitFor } from "./harness.js";

const DAY = 86_400_000;

/** Test credentials must stay inside their fixture even when the runner defines an XDG root or API key. */
function quotaEnvironment(t: TestContext, home: string): void {
  const keys = ["XDG_CONFIG_HOME", "MUSE_AUTH_PATH", "META_API_KEY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env["XDG_CONFIG_HOME"] = join(home, ".config");
  delete process.env["MUSE_AUTH_PATH"];
  delete process.env["META_API_KEY"];
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
}

/** A device login as the Muse CLI saves it. Without a token it is what a Keychain-only login leaves on disk. */
async function saveLogin(root: string, email: string, token?: string): Promise<string> {
  const dir = join(root, "muse");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify({ providers: { meta: {
    mechanism: "oauth", user_email: email, ...(token ? { access_token: token } : {}),
  } } }));
  return path;
}

/** What `muse usage --json` prints for an active plan. */
function snapshot(at: number, percent: number, tierName: string | null = "Muse Code Power Usage"): MuseUsageCliResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      schemaVersion: 1,
      tierName,
      reason: null,
      hint: null,
      allowance: {
        tier: "123",
        observedAtMs: at,
        window: { usedPercent: percent, resetsAtMs: at + 3_600_000, windowDurationMins: 300 },
        weekly: { usedPercent: 20, resetsAtMs: at + 86_400_000 },
      },
    }),
    stderr: "",
  };
}

function noSubscriptionResult(): MuseUsageCliResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ schemaVersion: 1, allowance: null, reason: "no_subscription", hint: null }),
    stderr: "",
  };
}

function unavailableResult(stderr = "muse usage: usage refresh failed (transient)"): MuseUsageCliResult {
  return { exitCode: 1, stdout: "", stderr };
}

function rejectedResult(stderr = "muse usage: usage refresh failed (credential_rejected)"): MuseUsageCliResult {
  return { exitCode: 1, stdout: "", stderr };
}

/** A usage/changed frame, or the body of a usage/read reply; MSP stamps are milliseconds. */
function reading(at: number, percent: number) {
  return { tier: "high", observedAtMs: at,
    window: { usedPercent: percent, resetsAtMs: at + 60_000, windowDurationMins: 300 },
    weekly: { usedPercent: 10, resetsAtMs: at + 600_000, windowDurationMins: null } };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A reader whose answers the test chooses and whose requests it can count. */
function scriptedReader(options: { now: () => number; answer: () => MuseUsageCliResult | Promise<MuseUsageCliResult> }) {
  const probe = { requests: 0 };
  const reader = new MuseSubscriptionReader({ now: options.now, cacheMs: 0, runUsage: async () => {
    probe.requests++;
    return options.answer();
  } });
  return { reader, probe };
}

describe("plan name and source of a subscription reading", () => {
  it("keeps the last plan name through a failed check and drops it when the login changes", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-name-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    let stamp = Date.now();
    let answer: () => MuseUsageCliResult = () => snapshot(stamp, 42);
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });

    const good = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(good.status, "ready");
    assert.equal(good.planName, "Muse Code Power Usage");
    assert.equal(good.source, "meta");

    stamp += 1000;
    answer = () => unavailableResult("private failure");
    const failed = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.planName, "Muse Code Power Usage", "one failed check does not blank the plan");
    assert.equal(failed.source, "meta", "the numbers still came from Meta; the failed check shows in status");
    assert.equal(failed.usage.window.usedPercent, 42);

    await saveLogin(join(home, ".config"), "other@example.test", "dca:other");
    stamp += 1000;
    const switched = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(switched.planName, null, "another login never inherits the previous plan's name");
    assert.equal(switched.usage, null);
  });

  it("does not bring a plan name back after Meta says the subscription ended", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-ended-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    let stamp = Date.now();
    let answer: () => MuseUsageCliResult = () => snapshot(stamp, 42);
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Power Usage");

    stamp += 1000;
    answer = () => noSubscriptionResult();
    const ended = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(ended.status, "no-subscription");
    assert.equal(ended.planName, null);

    stamp += 1000;
    answer = () => unavailableResult();
    const failed = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.planName, null, "a plan that ended is not the plan to show after a failed check");
  });

  it("forgets the plan name of an ended subscription even while a newer runtime reading keeps its numbers", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-ended-runtime-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    let stamp = Date.now();
    let answer: () => MuseUsageCliResult = () => snapshot(stamp, 42);
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home, subscriptionReader: reader });
    await send(base, "/api/sessions", { cwd: "/work" });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Power Usage");

    connection.notify("usage/changed", reading(stamp + 5000, 60));
    stamp += 1000;
    answer = () => noSubscriptionResult();
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, null);

    stamp += 1000;
    answer = () => unavailableResult();
    const failed = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(failed.usage.window.usedPercent, 60, "the newer runtime reading is still the one shown");
    assert.equal(failed.planName, null);
  });

  it("keeps the name through a login Meta rejected, and through a failed check after it", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-rejected-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    let stamp = Date.now();
    let answer: () => MuseUsageCliResult = () => snapshot(stamp, 42);
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Power Usage");
    stamp += 1000;
    answer = () => rejectedResult();
    const rejected = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(rejected.status, "login-required");
    assert.equal(rejected.planName, "Muse Code Power Usage", "a rejected token says nothing about which plan the account is on");
    stamp += 1000;
    answer = () => unavailableResult();
    const failed = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.planName, "Muse Code Power Usage", "the order of the failures does not matter");
    stamp += 1000;
    answer = () => snapshot(stamp, 50, "Muse Code Maximum Usage");
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Maximum Usage", "Meta's next answer replaces it");
  });

  it("keeps the name when the same login no longer holds a token, and asks Meta nothing", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-notoken-"));
    quotaEnvironment(t, home);
    const root = join(home, ".config");
    await saveLogin(root, "person@example.test", "dca:default");
    let stamp = Date.now();
    const { reader, probe } = scriptedReader({ now: () => stamp, answer: () => snapshot(stamp, 42) });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });
    const good = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(good.status, "ready");
    assert.equal(probe.requests, 1);

    // The secret moved to the keychain: the login file still names the person, but there is nothing to check with.
    await saveLogin(root, "person@example.test");
    stamp += 1000;
    const after = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(probe.requests, 1, "no request without a token");
    assert.equal(after.planName, "Muse Code Power Usage", "the same person is still on the same plan");
    assert.equal(after.status, "runtime-only", "nothing can be checked, so it is not ready");
    assert.equal(after.checkedAtMs, null);
    assert.equal(after.source, "meta", "the numbers still came from Meta");
    assert.equal(after.usage.window.usedPercent, 42);

    // A file that names no one at all is not the same login, whatever it held before.
    await writeFile(join(root, "muse", "auth.json"), "not json");
    stamp += 1000;
    const unreadable = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(unreadable.planName, null);
    assert.equal(unreadable.usage, null);
  });

  it("keeps the Meta label when the runtime reports the very same observation, and the runtime label once it is newer", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-tie-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    const stamp = Math.floor(Date.now() / 1000) * 1000;
    const { reader } = scriptedReader({ now: () => stamp, answer: () => snapshot(stamp, 42) });
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home, subscriptionReader: reader });
    await send(base, "/api/sessions", { cwd: "/work" });

    const meta = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(meta.source, "meta");
    // The runtime answers after Meta does, with exactly the observation Meta already gave.
    connection.replies.set("usage/read", async () => { await pause(50); return { usage: meta.usage }; });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].source, "meta", "the same observation keeps its Meta label");
    connection.replies.delete("usage/read");

    connection.notify("usage/changed", { ...meta.usage, observedAtMs: stamp + 1000, window: { ...meta.usage.window, usedPercent: 50 } });
    const newer = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(newer.usage.window.usedPercent, 50);
    assert.equal(newer.source, "runtime");
  });
});

describe("observation stamps from the future", () => {
  it("does not let one pin the reading", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-skew-"));
    quotaEnvironment(t, home);
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home });
    await send(base, "/api/sessions", { cwd: "/work" });

    connection.notify("usage/changed", reading(Date.now() + DAY, 10));
    const pinned = await get(base, "/api/plan-usage");
    assert.equal(pinned.usage.window.usedPercent, 10);
    assert.ok(pinned.usage.observedAtMs <= Date.now(), "the stamp counts as the moment it arrived");

    await pause(5);
    connection.notify("usage/changed", reading(Date.now(), 20));
    const next = await get(base, "/api/plan-usage");
    assert.equal(next.usage.window.usedPercent, 20, "a later honest reading is no longer outranked");
    assert.ok(next.usage.observedAtMs <= Date.now());
  });

  it("leaves a stamp a few minutes ahead alone, as ordinary clock skew", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-skew-small-"));
    quotaEnvironment(t, home);
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home });
    await send(base, "/api/sessions", { cwd: "/work" });
    const ahead = Date.now() + 60_000;
    connection.notify("usage/changed", reading(ahead, 10));
    assert.equal((await get(base, "/api/plan-usage")).usage.observedAtMs, ahead);
    connection.notify("usage/changed", reading(Date.now(), 20));
    assert.equal((await get(base, "/api/plan-usage")).usage.window.usedPercent, 10, "ordering by the host's own stamp still holds");
  });

  it("keeps a future-stamped observation at the moment it first arrived when it is read again", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-skew-reread-"));
    quotaEnvironment(t, home);
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("usage/read", { usage: reading(Date.now() + DAY, 30) });
    const { base } = await start(connection, { home });
    await send(base, "/api/sessions", { cwd: "/work" });
    let first: any;
    let second: any;
    const events = await sseEvents(base, "plan-usage", async () => {
      first = await get(base, "/api/plan-usage");
      await pause(25);
      second = await get(base, "/api/plan-usage");
    });
    assert.equal(first.usage.window.usedPercent, 30);
    assert.equal(second.usage.observedAtMs, first.usage.observedAtMs, "reading the same observation does not make it look newer");
    assert.equal(events.length, 1, "and does not announce it again");
  });

  /** A named account's saved row, as a build without the clamp left it: stamped a month ahead. Returns the options to restart on. */
  async function poisonedRow(t: TestContext) {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-skew-saved-"));
    quotaEnvironment(t, join(dataDir, "home"));
    const aonia = createAonia({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    const profile = await aonia.createProfile("work");
    await saveLogin(profile.roots.config, "first@example.test");
    const options = { dataDir, aonia, home: join(dataDir, "home") };
    const first = new FakeConnection();
    first.replies.set("session/start", { session: { sessionId: "w1" } });
    const initial = await start(first, options);
    await send(initial.base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    first.notify("usage/changed", reading(Date.now() - 1000, 33));
    await initial.server.close();

    const future = Date.now() + 30 * DAY;
    const poisoned = new DatabaseSync(join(dataDir, DB_FILE));
    try {
      assert.equal((poisoned.prepare("SELECT COUNT(*) AS n FROM subscription_usage").get() as { n: number }).n, 1);
      poisoned.prepare("UPDATE subscription_usage SET observed_at_ms = ?, usage = ?").run(future, JSON.stringify(reading(future, 33)));
    } finally { poisoned.close(); }
    return options;
  }
  const workOf = (report: { accounts: { accountId: string | null }[] }) => report.accounts.find((account) => account.accountId === "work") as any;
  const HALF_HOUR = 30 * 60_000;

  it("restores a saved reading that was stamped in the future as a reading half an hour old, and rewrites the row", async (t) => {
    const options = await poisonedRow(t);
    const second = new FakeConnection();
    const restored = await start(second, { ...options, hostFactory: fakeFactory(second) });
    const report = await get(restored.base, "/api/plan-usage");
    const age = Date.now() - report.byAccount.work.observedAtMs;
    assert.equal(report.byAccount.work.window.usedPercent, 33);
    assert.ok(age >= HALF_HOUR && age < HALF_HOUR + 10_000, "nothing says when it was observed, so it must not read as just now");
    assert.equal(workOf(report).source, "saved");
    await restored.server.close();

    const healed = new DatabaseSync(join(options.dataDir, DB_FILE));
    try {
      const row = healed.prepare("SELECT observed_at_ms AS at FROM subscription_usage").get() as { at: number };
      assert.ok(Date.now() - row.at >= HALF_HOUR, "the next start reads the same ordinary old reading");
    } finally { healed.close(); }
  });

  it("lets a reading Muse made a minute ago replace the restored one, whatever the saved row's stamp said", async (t) => {
    const options = await poisonedRow(t);
    const second = new FakeConnection();
    second.replies.set("session/start", { session: { sessionId: "w2" } });
    // The host's last observation is older than the moment the row is restored, but newer than any believable stamp it held.
    second.replies.set("usage/read", () => ({ usage: reading(Date.now() - 60_000, 44) }));
    const restored = await start(second, { ...options, hostFactory: fakeFactory(second) });
    await send(restored.base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    const report = await get(restored.base, "/api/plan-usage");
    assert.equal(report.byAccount.work.window.usedPercent, 44, "the saved row did not outrank it");
    assert.equal(workOf(report).source, "runtime");
  });
});

/** The shell question that learns the distro user's home folder; see `WslHomes`. */
const asksHome = (args: string[]) => args.includes('printf %s "$HOME"');

describe("logins without a direct Meta read", () => {
  /** A `wsl.exe` that finds Muse in the one distro and knows the user's home folder there. */
  const fakeWsl: ExecFn = async (command, args) => {
    if (command !== "wsl") return { stdout: "", exitCode: 127 };
    if (args[0] === "-l") return { stdout: "  NAME  STATE  VERSION\n* Ubuntu  Running  2\n", exitCode: 0 };
    if (args[2] === "-e" && args[3] === "test") return { stdout: "", exitCode: 0 };
    if (asksHome(args)) return { stdout: "/home/u", exitCode: 0 };
    return { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 };
  };
  const WSL_PROJECT = "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj";

  it("never mistakes the Windows-side login for the one inside the distro, gives no plan name, and restores nothing after a restart", async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-wsl-"));
    const home = join(dataDir, "home");
    quotaEnvironment(t, home);
    // A login on the Windows side must not be mistaken for the one Muse uses inside the distro, which holds none.
    await saveLogin(join(home, ".config"), "person@example.test", "dca:windows-side");
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => snapshot(Date.now(), 42) });
    const options = { dataDir, home, platform: "win32" as const, runtime: "wsl" as const, musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl, wslQuota: { localPath: () => join(dataDir, "distro", "home", "u", ".config", "muse", "auth.json") } };
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const initial = await start(connection, { ...options, subscriptionReader: reader, hostFactory: fakeFactory(connection) });
    assert.equal((await get(initial.base, "/api/plan-usage")).status, "no-host");
    assert.equal((await send(initial.base, "/api/sessions", { cwd: WSL_PROJECT })).status, 200);
    assert.equal((await get(initial.base, "/api/plan-usage")).status, "unobserved");

    connection.notify("usage/changed", reading(Date.now() - 1000, 61));
    const report = await get(initial.base, "/api/plan-usage");
    assert.equal(report.status, "ready");
    const account = report.accounts[0];
    assert.equal(account.status, "runtime-only");
    assert.equal(account.source, "runtime");
    assert.equal(account.planName, null);
    assert.equal(account.checkedAtMs, null);
    assert.equal(probe.requests, 0, "no request reaches Meta");
    await initial.server.close();

    const restarted = await start(new FakeConnection(), options);
    const after = await get(restarted.base, "/api/plan-usage");
    assert.equal(after.usage, null, "a reading with no verified login is never saved");
    assert.equal(after.status, "no-host");
  });

  it("does not ask Meta when an API key overrides the subscription login", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-quota-key-"));
    quotaEnvironment(t, home);
    process.env["META_API_KEY"] = "test-api-key";
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => snapshot(Date.now(), 42) });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });
    const account = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(account.status, "runtime-only");
    assert.equal(account.planName, null);
    assert.equal(account.usage, null);
    assert.equal(probe.requests, 0);
  });

  it("does not ask Meta for a login that only the keychain holds", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-quota-keychain-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test");
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => snapshot(Date.now(), 42) });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });
    const account = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(account.status, "runtime-only");
    assert.equal(account.planName, null);
    assert.equal(probe.requests, 0);
  });

  it("gives a named account no direct read while MUSE_AUTH_PATH points every login at one file", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-quota-auth-override-"));
    quotaEnvironment(t, home);
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    const profile = await aonia.createProfile("work");
    await saveLogin(profile.roots.config, "work@example.test", "dca:work");
    process.env["MUSE_AUTH_PATH"] = await saveLogin(join(home, "shared"), "person@example.test", "dca:shared");
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => snapshot(Date.now(), 42) });
    const { base } = await start(new FakeConnection(), { home, aonia, subscriptionReader: reader });
    const accounts = (await get(base, "/api/plan-usage")).accounts;
    const personal = accounts.find((account: { accountId: string | null }) => account.accountId === null);
    const work = accounts.find((account: { accountId: string | null }) => account.accountId === "work");
    assert.equal(personal.planName, "Muse Code Power Usage");
    assert.equal(work.planName, null);
    assert.equal(work.status, "runtime-only");
    assert.equal(probe.requests, 1, "only the default login is read from the override");
  });
});

describe("a login read from inside the WSL distro", () => {
  interface HomeAnswer { stdout: string; exitCode: number; timedOut?: boolean }
  interface Bounds { homeTimeoutMs?: number; readTimeoutMs?: number; retryMs?: number }

  /**
   * Muse under WSL with a fake `wsl.exe` and a fixture standing in for the distro's disk: the seam maps a Linux path
   * onto a folder in the temp dir, and the reader's fetch is the test's own. Nothing here starts WSL or reaches Meta.
   */
  async function rig(t: TestContext, o: {
    distro?: string; home?: () => Promise<HomeAnswer>; wslEnv?: Record<string, string>; dataDir?: string;
    answer?: (req: MuseUsageCliRequest) => MuseUsageCliResult | Promise<MuseUsageCliResult>; bounds?: Bounds;
  } = {}) {
    const root = await mkdtemp(join(tmpdir(), "ancilla-quota-distro-"));
    const winHome = join(root, "windows-home");
    quotaEnvironment(t, winHome);
    // A login on the Windows side, which nothing under WSL may read or send whatever becomes of the distro's own.
    await saveLogin(join(winHome, ".config"), "windows@example.test", "dca:windows-side");
    const distro = o.distro ?? "Ubuntu";
    const probe = { homeCalls: 0, homeTimeouts: [] as (number | undefined)[], requests: 0, authPaths: [] as string[], mapped: [] as [string, string][] };
    const exec: ExecFn = async (command, args, options) => {
      if (command !== "wsl") return { stdout: "", exitCode: 127 };
      if (args[0] === "-l") return { stdout: "  NAME  STATE  VERSION\n* Ubuntu  Running  2\n", exitCode: 0 };
      if (args[2] === "-e" && args[3] === "test") return { stdout: "", exitCode: 0 };
      if (asksHome(args)) {
        probe.homeCalls++;
        probe.homeTimeouts.push(options?.timeoutMs);
        return o.home ? o.home() : { stdout: "/home/u", exitCode: 0 };
      }
      return { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 };
    };
    const inDistro = (linux: string) => join(root, "distro", distro, ...linux.split("/").filter(Boolean));
    const reader = new MuseSubscriptionReader({ now: Date.now, cacheMs: 0, runUsage: async (req) => {
      probe.requests++;
      probe.authPaths.push(req.authPath);
      return o.answer ? o.answer(req) : snapshot(Date.now(), 42);
    } });
    const options = {
      dataDir: o.dataDir ?? ":memory:", home: winHome, platform: "win32" as const, runtime: "wsl" as const,
      musePath: "/home/u/.local/bin/muse", exec, subscriptionReader: reader, ...(o.distro ? { distro: o.distro } : {}),
      ...(o.wslEnv ? { wslEnv: o.wslEnv } : {}),
      wslQuota: { localPath: (name: string, linux: string) => { probe.mapped.push([name, linux]); return inDistro(linux); },
        homeTimeoutMs: 2000, readTimeoutMs: 3000, retryMs: 60_000, ...(o.bounds ?? {}) },
    };
    /** A login saved in a folder of the distro, as `muse login` there would leave it. */
    const login = (linuxDir: string, email: string, token?: string) => saveLogin(inDistro(linuxDir), email, token);
    return { root, winHome, probe, options, login, inDistro };
  }
  const first = async (base: string) => (await get(base, "/api/plan-usage")).accounts[0];
  const DISTRO_CONFIG = "/home/u/.config";

  it("reads the numbers and the plan name via Muse CLI for the distro's own login", async (t) => {
    const r = await rig(t);
    await saveLogin(join(r.winHome, ".config"), "windows@example.test", "dca:windows-side");
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const { base } = await start(new FakeConnection(), r.options);
    const account = await first(base);
    assert.equal(account.status, "ready");
    assert.equal(account.planName, "Muse Code Power Usage");
    assert.equal(account.source, "meta");
    assert.equal(account.usage.window.usedPercent, 42);
    assert.deepEqual(r.probe.authPaths, [r.inDistro("/home/u/.config/muse/auth.json")], "the Windows-side login is never queried");
    assert.deepEqual(r.probe.mapped.at(-1), ["Ubuntu", "/home/u/.config/muse/auth.json"]);
    await get(base, "/api/plan-usage");
    await get(base, "/api/plan-usage");
    assert.equal(r.probe.homeCalls, 1, "wsl.exe is asked for the home folder once, not on every poll");
    assert.deepEqual(r.probe.homeTimeouts, [2000], "and the child is given a deadline");
  });

  it("says the login is dead when Muse CLI reports a rejected or missing login", async (t) => {
    for (const stderr of ["muse usage: usage refresh failed (credential_rejected) secret body", "muse usage: not logged in: run `muse login` first"]) {
      const r = await rig(t, { answer: () => rejectedResult(stderr) });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const { base } = await start(new FakeConnection(), r.options);
      const report = await get(base, "/api/plan-usage");
      assert.equal(report.accounts[0].status, "login-required", stderr);
      assert.equal(report.accounts[0].usage, null);
      assert.doesNotMatch(JSON.stringify(report), /secret body|dca:/);
    }
  });

  it("is exactly what it was when the distro holds no login Ancilla may send", async (t) => {
    const r = await rig(t);
    const cases: [string, () => Promise<unknown>][] = [
      ["no file", async () => {}],
      ["not an oauth login", async () => {
        const path = await r.login(DISTRO_CONFIG, "person@example.test", "dca:x");
        await writeFile(path, JSON.stringify({ providers: { meta: { mechanism: "api_key", user_email: "person@example.test", access_token: "dca:x" } } }));
      }],
      ["no inline token", () => r.login(DISTRO_CONFIG, "person@example.test")],
      ["not a device token", () => r.login(DISTRO_CONFIG, "person@example.test", "sk-not-a-device-token")],
      ["a folder where the file should be", async () => {
        await mkdir(join(r.inDistro(DISTRO_CONFIG), "muse", "auth.json"), { recursive: true });
      }],
    ];
    for (const [name, prepare] of cases) {
      await rm(r.inDistro(DISTRO_CONFIG), { recursive: true, force: true });
      await prepare();
      const { base } = await start(new FakeConnection(), r.options);
      const account = await first(base);
      assert.equal(account.status, "runtime-only", name);
      assert.equal(account.usage, null, name);
      assert.equal(account.planName, null, name);
      assert.equal(account.checkedAtMs, null, name);
    }
    assert.equal(r.probe.requests, 0, "nothing was sent to Meta");
  });

  it("gives up on a distro that does not answer, in the time asked, and does not ask again at once", { timeout: 20_000 }, async (t) => {
    const r = await rig(t, { home: () => new Promise<HomeAnswer>(() => {}), bounds: { homeTimeoutMs: 50, readTimeoutMs: 30_000 } });
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const { base } = await start(new FakeConnection(), r.options);
    const began = Date.now();
    const reply = await send(base, "/api/plan-usage", undefined, "GET");
    assert.ok(Date.now() - began < 10_000, "the page is not held by a stopped distro");
    assert.equal(reply.status, 200);
    assert.equal(reply.json.accounts[0].status, "runtime-only");
    assert.equal(r.probe.requests, 0);
    await get(base, "/api/plan-usage");
    assert.equal(r.probe.homeCalls, 1, "a failed answer is remembered, so wsl.exe is not spawned on every poll");
  });

  it("asks the distro again once the retry window has passed", async (t) => {
    let calls = 0;
    const r = await rig(t, { home: async () => ++calls === 1 ? { stdout: "", exitCode: 1 } : { stdout: "/home/u", exitCode: 0 }, bounds: { retryMs: 60 } });
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const { base } = await start(new FakeConnection(), r.options);
    assert.equal((await first(base)).status, "runtime-only");
    await pause(150);
    assert.equal((await first(base)).status, "ready");
    assert.equal(r.probe.homeCalls, 2);
  });

  it("does not hold the page for a read that never finishes, and lets it go quietly", { timeout: 20_000 }, async (t) => {
    const r = await rig(t, { answer: (req) => new Promise<MuseUsageCliResult>((_resolve, reject) => {
      req.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }), bounds: { readTimeoutMs: 150 } });
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const { base } = await start(new FakeConnection(), r.options);
    const began = Date.now();
    const reply = await send(base, "/api/plan-usage", undefined, "GET");
    assert.ok(Date.now() - began < 8000, "the read would otherwise be held for the reader's own twelve seconds");
    assert.equal(reply.status, 200);
    assert.equal(reply.json.accounts[0].status, "runtime-only");
    assert.equal(reply.json.accounts[0].usage, null);
    assert.equal(r.probe.requests, 1);
  });

  it("does not hold the page for a path that cannot be had either", { timeout: 20_000 }, async (t) => {
    const r = await rig(t, { bounds: { readTimeoutMs: 150 } });
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const { base } = await start(new FakeConnection(), { ...r.options, wslQuota: { ...r.options.wslQuota, localPath: () => new Promise<string>(() => {}) } });
    const reply = await send(base, "/api/plan-usage", undefined, "GET");
    assert.equal(reply.status, 200);
    assert.equal(reply.json.accounts[0].status, "runtime-only");
    assert.equal(r.probe.requests, 0);
  });

  it("publishes nothing from a read that finished late, after another read has begun", async (t) => {
    let release: (answer: MuseUsageCliResult) => void = () => {};
    const r = await rig(t, { answer: () => new Promise<MuseUsageCliResult>((resolve) => { release = resolve; }), bounds: { readTimeoutMs: 100 } });
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const { server, base } = await start(new FakeConnection(), r.options);
    assert.equal((await first(base)).status, "runtime-only");
    // The next poll has begun: the revision has moved past the one the late read belongs to.
    server["planUsageReadRevision"] += 1;
    release(snapshot(Date.now(), 42));
    await waitFor(() => server["subscriptionReader"]["cached"].size === 1, "the late answer arriving");
    await pause(100);
    assert.equal(server["defaultPlanUsage"], null);
    assert.equal(server["directQuota"].size, 0);
  });

  it("reads no login when the home folder cannot be had in a form that is safe to map", async (t) => {
    let answer: HomeAnswer = { stdout: "/home/u", exitCode: 0 };
    const r = await rig(t, { home: async () => answer });
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const bad: HomeAnswer[] = [
      { stdout: "home/u", exitCode: 0 }, { stdout: "", exitCode: 0 }, { stdout: "/home/u\n", exitCode: 0 },
      { stdout: "wsl: a notice\n/home/u", exitCode: 0 }, { stdout: "/home/../home/u", exitCode: 0 },
      { stdout: "/home/u\0", exitCode: 0 }, { stdout: "/home\\u", exitCode: 0 },
      { stdout: "/home/u", exitCode: 1 }, { stdout: "/home/u", exitCode: 1, timedOut: true },
    ];
    for (const next of bad) {
      answer = next;
      const { base } = await start(new FakeConnection(), r.options);
      const account = await first(base);
      assert.equal(account.status, "runtime-only", JSON.stringify(next));
      assert.equal(account.usage, null);
    }
    assert.equal(r.probe.requests, 0);
    assert.deepEqual(r.probe.mapped, [], "no path was ever mapped");
    answer = { stdout: "/home/u", exitCode: 0 };
    assert.equal((await first((await start(new FakeConnection(), r.options)).base)).status, "ready", "the same fixture reads once the answer is good");
  });

  it("reads no login from a distro whose name could change the path", async (t) => {
    const r = await rig(t);
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    for (const distro of ["Ubuntu 22", "Ubuntu;calc", "..", "a/b", "a\\b", "Ubuntu\n", "é"]) {
      const { base } = await start(new FakeConnection(), { ...r.options, distro });
      assert.equal((await first(base)).status, "runtime-only", JSON.stringify(distro));
    }
    assert.equal(r.probe.requests, 0);
    assert.equal(r.probe.homeCalls, 0, "wsl.exe is not even asked about such a distro");
    assert.deepEqual(r.probe.mapped, []);
  });

  it("reads the login of the distro Muse is configured for", async (t) => {
    const r = await rig(t, { distro: "Ubuntu-22.04_lts" });
    await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
    const { base } = await start(new FakeConnection(), r.options);
    assert.equal((await first(base)).status, "ready");
    assert.deepEqual(r.probe.mapped.at(-1), ["Ubuntu-22.04_lts", "/home/u/.config/muse/auth.json"]);
  });

  describe("what real Windows runs, with no test seam", () => {
    it("opens the wsl.localhost path of the distro Muse runs in, asks that distro for the home folder, and gives the child a deadline", async (t) => {
      const root = await mkdtemp(join(tmpdir(), "ancilla-quota-default-"));
      quotaEnvironment(t, join(root, "windows-home"));
      const asked: { argv: string[]; timeoutMs: number | undefined }[] = [];
      const exec: ExecFn = async (command, args, options) => {
        if (command !== "wsl") return { stdout: "", exitCode: 127 };
        if (args[2] === "-e" && args[3] === "test") return { stdout: "", exitCode: 0 };
        if (asksHome(args)) {
          asked.push({ argv: args.slice(0, 4), timeoutMs: options?.timeoutMs });
          return { stdout: "/home/u", exitCode: 0 };
        }
        return { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 };
      };
      const opened: string[] = [];
      class Recording extends MuseSubscriptionReader {
        override async read(path: string): Promise<SubscriptionReading | null> { opened.push(path); return null; }
      }
      const { base } = await start(new FakeConnection(), { dataDir: ":memory:", home: join(root, "windows-home"), platform: "win32",
        runtime: "wsl", distro: "Ubuntu-22.04", musePath: "/home/u/.local/bin/muse", exec, subscriptionReader: new Recording() });
      await first(base);
      assert.deepEqual(opened, ["\\\\wsl.localhost\\Ubuntu-22.04\\home\\u\\.config\\muse\\auth.json"]);
      assert.deepEqual(asked, [{ argv: ["-d", "Ubuntu-22.04", "-e", "sh"], timeoutMs: 5000 }]);
    });

    it("saves a reading under the mapped file too, so one person's two files do not share it", async (t) => {
      const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-distro-two-files-"));
      const r = await rig(t, { dataDir, wslEnv: { XDG_CONFIG_HOME: "/x/cfg" } });
      await r.login("/x/cfg", "person@example.test", "dca:one");
      await r.login("/y/cfg", "person@example.test", "dca:one");
      const initial = await start(new FakeConnection(), r.options);
      assert.equal((await first(initial.base)).status, "ready");
      await initial.server.close();

      const down = scriptedReader({ now: Date.now, answer: () => unavailableResult() });
      const other = await start(new FakeConnection(), { ...r.options, wslEnv: { XDG_CONFIG_HOME: "/y/cfg" }, subscriptionReader: down.reader });
      const report = await get(other.base, "/api/plan-usage");
      assert.equal(report.usage, null, "the other file has not been read yet");
      await other.server.close();
      const same = await start(new FakeConnection(), { ...r.options, subscriptionReader: down.reader });
      assert.equal((await get(same.base, "/api/plan-usage")).usage.window.usedPercent, 42, "the same file still has its reading");
    });
  });

  describe("a distro that stalls", () => {
    const released: (() => void)[] = [];
    const releaseAll = () => { for (const release of released.splice(0)) release(); };

    class Hung extends MuseSubscriptionReader {
      calls = 0;
      override read(): Promise<SubscriptionReading | null> {
        this.calls++;
        return new Promise((resolve) => { released.push(() => resolve(null)); });
      }
    }

    it("starts no second read while one that outlived its bound is unsettled, and reads again once it has", async (t) => {
      const r = await rig(t, { bounds: { readTimeoutMs: 100 } });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const hung = new Hung();
      const { base } = await start(new FakeConnection(), { ...r.options, subscriptionReader: hung });
      for (let poll = 0; poll < 3; poll++) assert.equal((await first(base)).status, "runtime-only");
      assert.equal(hung.calls, 1, "three polls, one read");
      releaseAll();
      await pause(30);
      await first(base);
      assert.equal(hung.calls, 2, "a read that has settled is not waited on any more");
      releaseAll();
    });

    it("starts no second look at the path while one that outlived its bound is unsettled", async (t) => {
      const r = await rig(t, { bounds: { readTimeoutMs: 100 } });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const mapping = { calls: 0 };
      const stalled = { ...r.options, wslQuota: { ...r.options.wslQuota, localPath: () => {
        mapping.calls++;
        return new Promise<string>((resolve) => { released.push(() => resolve("")); });
      } } };
      const { base } = await start(new FakeConnection(), stalled);
      assert.equal((await first(base)).status, "runtime-only");
      const afterFirst = mapping.calls;
      assert.ok(afterFirst > 0);
      await first(base);
      await first(base);
      assert.equal(mapping.calls, afterFirst, "later polls do not look at the distro again");
      releaseAll();
    });

    it("answers every poll, and leaves the rest of the process working, while the login file never opens", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
      const r = await rig(t, { bounds: { readTimeoutMs: 150 } });
      const fifo = join(r.root, "stalled-login");
      execFileSync("mkfifo", [fifo]);
      // Opened at once and left open: letting the blocked opens go must not need a pool thread, which the very
      // regression this test is for would have used up, and the test then fails instead of hanging.
      t.after(() => { openSync(fifo, "r+"); });
      const plain = join(r.root, "plain.txt");
      await writeFile(plain, "fine");
      const { base } = await start(new FakeConnection(), { ...r.options, wslQuota: { ...r.options.wslQuota, localPath: () => fifo } });
      const verdicts: string[] = [];
      for (let poll = 0; poll < 4; poll++) {
        const answer = await Promise.race([send(base, "/api/plan-usage", undefined, "GET").then((reply) => `${reply.status}`), pause(5000).then(() => "held")]);
        verdicts.push(answer);
      }
      assert.deepEqual(verdicts, ["200", "200", "200", "200"]);
      assert.equal(await Promise.race([readFile(plain, "utf8"), pause(2000).then(() => "starved")]), "fine", "the thread pool is not used up");
    });

    it("keeps the reading on screen when one look at the login is slower than the bound", async (t) => {
      const meta = { down: false };
      // The bound is a second and the slow look three, so that only the order of events is raced, not the speed of the disk.
      const r = await rig(t, { bounds: { readTimeoutMs: 1000 },
        answer: () => meta.down ? unavailableResult() : snapshot(Date.now(), 42) });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const slow = { next: 0 };
      const { base } = await start(new FakeConnection(), { ...r.options, wslQuota: { ...r.options.wslQuota,
        localPath: async (_distro: string, linux: string) => { if (slow.next > 0) { slow.next--; await pause(3000); } return r.inDistro(linux); } } });
      assert.equal((await first(base)).status, "ready");
      slow.next = 1;
      meta.down = true;
      const slowed = await first(base);
      assert.equal(slowed.status, "unavailable", "Meta's own failure is the only thing this poll reports");
      assert.equal(slowed.usage.window.usedPercent, 42, "a slow look is no reading this time, not a login that changed");
      assert.equal(slowed.planName, "Muse Code Power Usage");
      assert.equal(slowed.source, "meta");
      meta.down = false;
      await pause(2500);
      assert.equal((await first(base)).status, "ready");
    });

    it("keeps the read it just made when the first look at the login is the slow one", async (t) => {
      const r = await rig(t, { bounds: { readTimeoutMs: 1000 } });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const slow = { next: 1 };
      const { base } = await start(new FakeConnection(), { ...r.options, wslQuota: { ...r.options.wslQuota,
        localPath: async (_distro: string, linux: string) => { if (slow.next > 0) { slow.next--; await pause(3000); } return r.inDistro(linux); } } });
      const account = await first(base);
      assert.equal(account.status, "ready");
      assert.equal(account.usage.window.usedPercent, 42);
    });
  });

  describe("a host started while the distro was slow", () => {
    it("takes the identity of the login once the home folder is known, so its usage frames are not dropped", async (t) => {
      let asked = 0;
      const r = await rig(t, { home: async () => ++asked === 1 ? { stdout: "", exitCode: 1 } : { stdout: "/home/u", exitCode: 0 }, bounds: { retryMs: 60 } });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const connection = new FakeConnection();
      connection.replies.set("session/start", { session: { sessionId: "s1" } });
      const { base } = await start(connection, { ...r.options, hostFactory: fakeFactory(connection) });
      assert.equal((await send(base, "/api/sessions", { cwd: "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj" })).status, 200);
      await pause(120);
      assert.equal((await first(base)).source, "meta");
      connection.notify("usage/changed", reading(Date.now() + 2000, 77));
      const account = await first(base);
      assert.equal(account.usage.window.usedPercent, 77, "the host's newer frame is taken");
      assert.equal(account.source, "runtime");
    });
  });

  describe("what never leaves the machine", () => {
    it("shows no token, address, file or path in output, events, answers or saved files", async (t) => {
      const token = "dca:leak-check-7f3a91";
      const email = "leak-check-person@example.test";
      const written: string[] = [];
      for (const stream of [process.stdout, process.stderr]) {
        const original = stream.write;
        stream.write = function write(this: unknown, chunk: unknown, ...rest: unknown[]) {
          written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
          return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
        } as typeof stream.write;
        t.after(() => { stream.write = original; });
      }
      const seen: string[] = [];
      const roots: string[] = [];
      const modes: { name: string; answer?: () => MuseUsageCliResult; home?: string }[] = [
        { name: "ok" }, { name: "refused", answer: () => rejectedResult(`credential_rejected ${token} ${email}`) },
        { name: "hostile home", home: "/home/../x\n" },
      ];
      for (const mode of modes) {
        const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-distro-leak-"));
        const r = await rig(t, { dataDir, ...(mode.answer ? { answer: mode.answer } : {}),
          ...(mode.home ? { home: async () => ({ stdout: mode.home as string, exitCode: 0 }) } : {}) });
        await r.login(DISTRO_CONFIG, email, token);
        roots.push(r.root, dataDir);
        const { server, base } = await start(new FakeConnection(), r.options);
        const events = await sseEvents(base, "plan-usage", async () => { seen.push(JSON.stringify(await get(base, "/api/plan-usage"))); });
        seen.push(JSON.stringify(events), JSON.stringify(await get(base, "/api/plan-usage")));
        await server.close();
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path); else seen.push((await readFile(path)).toString("latin1"));
          }
        };
        await walk(dataDir);
      }
      const forbidden = [token, email, "auth.json", "wsl.localhost", ...roots].map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const haystack = [...seen, ...written].join("\n");
      assert.doesNotMatch(haystack, new RegExp(forbidden.join("|")));
    });
  });

  describe("the file Muse is told to use", () => {
    it("follows MUSE_AUTH_PATH, then XDG_CONFIG_HOME, from runtime.json's wslEnv, and asks no home folder then", async (t) => {
      const both = await rig(t, { wslEnv: { MUSE_AUTH_PATH: "/srv/muse/auth.json", XDG_CONFIG_HOME: "/x/cfg" } });
      await both.login("/srv", "person@example.test", "dca:override");
      await both.login("/x/cfg", "other@example.test", "dca:xdg");
      assert.equal((await first((await start(new FakeConnection(), both.options)).base)).status, "ready");
      assert.deepEqual(both.probe.authPaths, [both.inDistro("/srv/muse/auth.json")]);
      assert.deepEqual(both.probe.mapped.at(-1), ["Ubuntu", "/srv/muse/auth.json"]);
      assert.equal(both.probe.homeCalls, 0);

      const xdg = await rig(t, { wslEnv: { XDG_CONFIG_HOME: "/x/cfg" } });
      await xdg.login("/x/cfg", "other@example.test", "dca:xdg");
      await xdg.login(DISTRO_CONFIG, "person@example.test", "dca:home");
      assert.equal((await first((await start(new FakeConnection(), xdg.options)).base)).status, "ready");
      assert.deepEqual(xdg.probe.authPaths, [xdg.inDistro("/x/cfg/muse/auth.json")]);
      assert.deepEqual(xdg.probe.mapped.at(-1), ["Ubuntu", "/x/cfg/muse/auth.json"]);
      assert.equal(xdg.probe.homeCalls, 0);
    });

    it("falls back to the home folder when those are not absolute Linux paths", async (t) => {
      const r = await rig(t, { wslEnv: { MUSE_AUTH_PATH: "rel/auth.json", XDG_CONFIG_HOME: "cfg" } });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:home");
      assert.equal((await first((await start(new FakeConnection(), r.options)).base)).status, "ready");
      assert.deepEqual(r.probe.mapped.at(-1), ["Ubuntu", "/home/u/.config/muse/auth.json"]);
    });

    it("reads nothing when an override is absolute but cannot be mapped safely", async (t) => {
      const r = await rig(t, { wslEnv: { MUSE_AUTH_PATH: "/srv/../etc/auth.json" } });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:home");
      assert.equal((await first((await start(new FakeConnection(), r.options)).base)).status, "runtime-only");
      assert.equal(r.probe.requests, 0);
      assert.deepEqual(r.probe.mapped, []);
    });
  });

  describe("what stays as it was", () => {
    it("does not read when an API key overrides the login, whether set here or for the distro", async (t) => {
      const forDistro = await rig(t, { wslEnv: { META_API_KEY: "test-api-key" } });
      await forDistro.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      assert.equal((await first((await start(new FakeConnection(), forDistro.options)).base)).status, "runtime-only");
      assert.equal(forDistro.probe.requests, 0);

      const here = await rig(t);
      await here.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      process.env["META_API_KEY"] = "test-api-key";
      assert.equal((await first((await start(new FakeConnection(), here.options)).base)).status, "runtime-only");
      assert.equal(here.probe.requests, 0);
    });

    it("does not read when this server's own environment names an auth file", async (t) => {
      const r = await rig(t);
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      process.env["MUSE_AUTH_PATH"] = await saveLogin(join(r.winHome, "elsewhere"), "windows@example.test", "dca:windows-side");
      assert.equal((await first((await start(new FakeConnection(), r.options)).base)).status, "runtime-only");
      assert.equal(r.probe.requests, 0);
    });

    it("gives a named account no direct read under WSL", async (t) => {
      const r = await rig(t);
      const aonia = createAonia({ home: r.winHome, platform: "linux", musePath: "muse" });
      const profile = await aonia.createProfile("work");
      await saveLogin(profile.roots.config, "work@example.test", "dca:work");
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const { base } = await start(new FakeConnection(), { ...r.options, aonia });
      const accounts = (await get(base, "/api/plan-usage")).accounts;
      const work = accounts.find((account: { accountId: string | null }) => account.accountId === "work");
      assert.equal(accounts.find((account: { accountId: string | null }) => account.accountId === null).status, "ready");
      assert.equal(work.status, "runtime-only");
      assert.equal(work.planName, null);
      assert.deepEqual(r.probe.authPaths, [r.inDistro("/home/u/.config/muse/auth.json")]);
    });
  });

  describe("the account Settings shows (GET /api/accounts/health)", () => {
    type Rig = Awaited<ReturnType<typeof rig>>;
    const UNKNOWN = { hasLogin: null, email: null };
    const identity = async (base: string) => (await get(base, "/api/accounts/health")).defaultLogin;
    /** What `muse login` leaves in the distro, written as the test chooses. */
    async function putFile(r: Rig, body: string | object) {
      const dir = join(r.inDistro(DISTRO_CONFIG), "muse");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "auth.json"), typeof body === "string" ? body : JSON.stringify(body));
    }
    const meta = (fields: Record<string, unknown>) => ({ providers: { meta: fields } });
    const released: (() => void)[] = [];
    const releaseAll = () => { for (const release of released.splice(0)) release(); };

    it("says the distro holds a login and names its e-mail, without asking Meta", async (t) => {
      const r = await rig(t);
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const { base } = await start(new FakeConnection(), r.options);
      const health = await get(base, "/api/accounts/health");
      assert.deepEqual(health.defaultLogin, { hasLogin: true, email: "person@example.test" });
      assert.deepEqual(Object.keys(health).sort(), ["defaultLogin", "metaApiKeyInherited"]);
      assert.deepEqual(r.probe.mapped.at(-1), ["Ubuntu", "/home/u/.config/muse/auth.json"], "the file of the distro, found the way the meter finds it");
      assert.equal(r.probe.requests, 0, "nothing is sent to Meta to learn who is signed in");
    });

    it("says a login exists when the file has a mechanism and no e-mail", async (t) => {
      const r = await rig(t);
      const { base } = await start(new FakeConnection(), r.options);
      await putFile(r, meta({ mechanism: "oauth" }));
      assert.deepEqual(await identity(base), { hasLogin: true, email: null });
      await putFile(r, meta({ mechanism: "oauth", user_email: "" }));
      assert.deepEqual(await identity(base), { hasLogin: true, email: null });
      await putFile(r, meta({ mechanism: "api_key", user_email: "person@example.test" }));
      assert.deepEqual(await identity(base), { hasLogin: true, email: "person@example.test" });
    });

    it("never says there is no login: a file that does not show one leaves it unknown, as another store could hold it", async (t) => {
      const r = await rig(t);
      const { base } = await start(new FakeConnection(), r.options);
      const cases: [string, () => Promise<unknown>][] = [
        ["no file", async () => {}],
        ["a folder where the file should be", () => mkdir(join(r.inDistro(DISTRO_CONFIG), "muse", "auth.json"), { recursive: true })],
        ["no meta provider", () => putFile(r, { providers: { other: { mechanism: "oauth" } } })],
        ["no providers at all", () => putFile(r, {})],
        ["no mechanism", () => putFile(r, meta({ user_email: "person@example.test" }))],
        ["an empty mechanism", () => putFile(r, meta({ mechanism: "", user_email: "person@example.test" }))],
        ["a mechanism that is not text", () => putFile(r, meta({ mechanism: 1, user_email: "person@example.test" }))],
        ["a file that is not JSON", () => putFile(r, "{ not json")],
      ];
      for (const [name, prepare] of cases) {
        await rm(r.inDistro(DISTRO_CONFIG), { recursive: true, force: true });
        await prepare();
        assert.deepEqual(await identity(base), UNKNOWN, name);
      }
      assert.ok(r.probe.mapped.length > 0, "each of these was looked for in the distro");
    });

    it("never takes the login on the Windows side for the one in the distro", async (t) => {
      // The rig saved a login on the Windows side, and the distro holds none.
      const r = await rig(t);
      const { base } = await start(new FakeConnection(), r.options);
      const health = await get(base, "/api/accounts/health");
      assert.deepEqual(health.defaultLogin, UNKNOWN);
      assert.doesNotMatch(JSON.stringify(health), /windows@example/);
      assert.ok(r.probe.mapped.length > 0);
      for (const [, linux] of r.probe.mapped) assert.ok(linux.startsWith("/"), "only paths inside the distro were asked for");
    });

    it("reads the file Muse is told to use through runtime.json's wslEnv, not the one in the home folder", async (t) => {
      // MUSE_AUTH_PATH first, then XDG_CONFIG_HOME, as the meter has it; a login of another person waits in the home folder.
      const named = await rig(t, { wslEnv: { MUSE_AUTH_PATH: "/srv/muse/auth.json", XDG_CONFIG_HOME: "/x/cfg" } });
      await named.login("/srv", "named@example.test", "dca:named");
      await named.login("/x/cfg", "xdg@example.test", "dca:xdg");
      await named.login(DISTRO_CONFIG, "home@example.test", "dca:home");
      assert.deepEqual(await identity((await start(new FakeConnection(), named.options)).base), { hasLogin: true, email: "named@example.test" });
      assert.deepEqual(named.probe.mapped.at(-1), ["Ubuntu", "/srv/muse/auth.json"]);
      assert.equal(named.probe.homeCalls, 0, "no home folder is asked for then");

      const xdg = await rig(t, { wslEnv: { XDG_CONFIG_HOME: "/x/cfg" } });
      await xdg.login("/x/cfg", "xdg@example.test", "dca:xdg");
      await xdg.login(DISTRO_CONFIG, "home@example.test", "dca:home");
      assert.deepEqual(await identity((await start(new FakeConnection(), xdg.options)).base), { hasLogin: true, email: "xdg@example.test" });
      assert.deepEqual(xdg.probe.mapped.at(-1), ["Ubuntu", "/x/cfg/muse/auth.json"]);
      assert.equal(xdg.probe.homeCalls, 0);
      assert.equal(xdg.probe.requests, 0);
    });

    it("opens nothing, and says nothing is known, when an API key or an auth file named here overrides the login", async (t) => {
      const SIGNED_IN = { hasLogin: true, email: "person@example.test" };
      // The same fixture, without the override, is read: so the answer below is the override's doing.
      const forDistro = await rig(t, { wslEnv: { META_API_KEY: "test-api-key" } });
      await forDistro.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      assert.deepEqual(await identity((await start(new FakeConnection(), { ...forDistro.options, wslEnv: {} })).base), SIGNED_IN, "no key for the distro");
      const mappedForDistro = forDistro.probe.mapped.length;
      assert.deepEqual(await identity((await start(new FakeConnection(), forDistro.options)).base), UNKNOWN, "an API key for the distro");
      assert.equal(forDistro.probe.mapped.length, mappedForDistro, "nothing more was opened");

      const here = await rig(t);
      await here.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      assert.deepEqual(await identity((await start(new FakeConnection(), here.options)).base), SIGNED_IN, "no key here");
      const mappedHere = here.probe.mapped.length;
      process.env["META_API_KEY"] = "test-api-key";
      assert.deepEqual(await identity((await start(new FakeConnection(), here.options)).base), UNKNOWN, "an API key in this server's environment");
      assert.equal(here.probe.mapped.length, mappedHere, "nothing more was opened");
      delete process.env["META_API_KEY"];

      const named = await rig(t);
      await named.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      assert.deepEqual(await identity((await start(new FakeConnection(), named.options)).base), SIGNED_IN, "no file named here");
      const mappedNamed = named.probe.mapped.length;
      process.env["MUSE_AUTH_PATH"] = await saveLogin(join(named.winHome, "elsewhere"), "windows@example.test", "dca:windows-side");
      assert.deepEqual(await identity((await start(new FakeConnection(), named.options)).base), UNKNOWN, "an auth file named in this server's environment");
      assert.equal(named.probe.mapped.length, mappedNamed, "nothing more was opened");
    });

    it("opens nothing for a distro name that could change the path, or a home folder that is not safe to map", async (t) => {
      const r = await rig(t);
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      assert.deepEqual(await identity((await start(new FakeConnection(), r.options)).base), { hasLogin: true, email: "person@example.test" }, "a good name is read");
      const [mapped, homeCalls] = [r.probe.mapped.length, r.probe.homeCalls];
      for (const distro of ["Ubuntu 22", "Ubuntu;calc", "..", "a/b", "a\\b", "Ubuntu\n", "é"]) {
        const { base } = await start(new FakeConnection(), { ...r.options, distro });
        assert.deepEqual(await identity(base), UNKNOWN, JSON.stringify(distro));
      }
      assert.equal(r.probe.homeCalls, homeCalls, "wsl.exe is not even asked about such a distro");
      assert.equal(r.probe.mapped.length, mapped, "no path was mapped");

      let answer = { stdout: "/home/../home/u", exitCode: 0 };
      const unsafe = await rig(t, { home: async () => answer });
      await unsafe.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      for (const next of [answer, { stdout: "home/u", exitCode: 0 }, { stdout: "/home/u\n", exitCode: 0 }, { stdout: "", exitCode: 0 }, { stdout: "/home/u", exitCode: 1 }]) {
        answer = next;
        const { base } = await start(new FakeConnection(), unsafe.options);
        assert.deepEqual(await identity(base), UNKNOWN, JSON.stringify(next));
      }
      assert.deepEqual(unsafe.probe.mapped, [], "no path was ever mapped");
      answer = { stdout: "/home/u", exitCode: 0 };
      assert.deepEqual(await identity((await start(new FakeConnection(), unsafe.options)).base), { hasLogin: true, email: "person@example.test" }, "the same fixture is read once the answer is good");
    });

    describe("a distro that stalls", () => {
      it("answers within the bound when the path cannot be had, and starts no second look while that one is unsettled", { timeout: 20_000 }, async (t) => {
        const r = await rig(t, { bounds: { readTimeoutMs: 150 } });
        await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
        const mapping = { calls: 0, stalls: true };
        const stalled = { ...r.options, wslQuota: { ...r.options.wslQuota, localPath: (_distro: string, linux: string) => {
          mapping.calls++;
          if (!mapping.stalls) return r.inDistro(linux);
          return new Promise<string>((resolve) => { released.push(() => resolve(r.inDistro(linux))); });
        } } };
        const { server, base } = await start(new FakeConnection(), stalled);
        const began = Date.now();
        const reply = await send(base, "/api/accounts/health", undefined, "GET");
        assert.ok(Date.now() - began < 8000, "the page is not held by a distro that does not answer");
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.json.defaultLogin, UNKNOWN);
        assert.ok(server["wslStuck"].has("identity"), "a look that outlived its bound holds its own kind");
        const afterFirst = mapping.calls;
        assert.ok(afterFirst > 0);
        assert.deepEqual(await identity(base), UNKNOWN);
        assert.deepEqual(await identity(base), UNKNOWN);
        assert.equal(mapping.calls, afterFirst, "later requests do not look at the distro again");
        mapping.stalls = false;
        releaseAll();
        await waitFor(() => !server["wslStuck"].has("identity"), "the look settling");
        assert.deepEqual(await identity(base), { hasLogin: true, email: "person@example.test" }, "a look that has settled is not waited on any more");
        assert.ok(mapping.calls > afterFirst);
        releaseAll();
      });

      it("answers within the bound when wsl.exe never answers about the home folder", { timeout: 20_000 }, async (t) => {
        const r = await rig(t, { home: () => new Promise<HomeAnswer>(() => {}), bounds: { homeTimeoutMs: 4000, readTimeoutMs: 150 } });
        await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
        const { server, base } = await start(new FakeConnection(), r.options);
        const began = Date.now();
        const reply = await send(base, "/api/accounts/health", undefined, "GET");
        assert.ok(Date.now() - began < 3000, "the bound of the look, not that of the home folder, ends the wait");
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.json.defaultLogin, UNKNOWN);
        assert.ok(server["wslStuck"].has("identity"));
        assert.deepEqual(await identity(base), UNKNOWN);
        assert.equal(r.probe.homeCalls, 1, "wsl.exe is not started again while it has not answered");
      });

      it("answers every request, and leaves the rest of the process working, while the login file never opens", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
        const r = await rig(t, { bounds: { readTimeoutMs: 150 } });
        const fifo = join(r.root, "stalled-login");
        execFileSync("mkfifo", [fifo]);
        // Opened at once and left open, so that letting the blocked open go needs no pool thread.
        t.after(() => { openSync(fifo, "r+"); });
        const plain = join(r.root, "plain.txt");
        await writeFile(plain, "fine");
        await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
        assert.deepEqual(await identity((await start(new FakeConnection(), r.options)).base), { hasLogin: true, email: "person@example.test" }, "the same rig reads a file that opens");
        const { base } = await start(new FakeConnection(), { ...r.options, wslQuota: { ...r.options.wslQuota, localPath: () => fifo } });
        const verdicts: string[] = [];
        for (let poll = 0; poll < 4; poll++) {
          const answer = await Promise.race([send(base, "/api/accounts/health", undefined, "GET").then((reply) => `${reply.status} ${JSON.stringify(reply.json.defaultLogin)}`), pause(5000).then(() => "held")]);
          verdicts.push(answer);
        }
        assert.deepEqual(verdicts, Array(4).fill(`200 ${JSON.stringify(UNKNOWN)}`));
        assert.equal(await Promise.race([readFile(plain, "utf8"), pause(2000).then(() => "starved")]), "fine", "the thread pool is not used up");
      });
    });

    it("lets only the e-mail out: no token, path, name or other field, in the answer or in any output", async (t) => {
      const token = "dca:identity-leak-7f3a91";
      const email = "identity-leak@example.test";
      const written: string[] = [];
      for (const stream of [process.stdout, process.stderr]) {
        const original = stream.write;
        stream.write = function write(this: unknown, chunk: unknown, ...rest: unknown[]) {
          written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
          return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
        } as typeof stream.write;
        t.after(() => { stream.write = original; });
      }
      const seen: string[] = [];
      const roots: string[] = [];
      const files: (string | object)[] = [
        meta({ mechanism: "oauth", user_email: email, user_full_name: "Identity Leak Name", access_token: token, refresh_token: "identity-refresh-secret" }),
        `{ not json ${token} ${email}`,
      ];
      for (const file of files) {
        const r = await rig(t);
        roots.push(r.root);
        await putFile(r, file);
        const { server, base } = await start(new FakeConnection(), r.options);
        const health = await get(base, "/api/accounts/health");
        seen.push(JSON.stringify(health));
        if (typeof file !== "string") assert.deepEqual(health.defaultLogin, { hasLogin: true, email }, "only these two fields");
        await server.close();
      }
      const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const secrets = [token, "Identity Leak Name", "identity-refresh-secret", "auth.json", "wsl.localhost", "windows@example", ...roots];
      assert.doesNotMatch(seen.join("\n"), new RegExp(secrets.map(escape).join("|")));
      assert.doesNotMatch(written.join("\n"), new RegExp([email, ...secrets].map(escape).join("|")), "no line of output holds the e-mail or any of the rest");
    });

    it("answers as before for a named account and for Muse outside WSL", async (t) => {
      const r = await rig(t);
      const aonia = createAonia({ home: r.winHome, platform: "linux", musePath: "muse" });
      const profile = await aonia.createProfile("work");
      await saveLogin(profile.roots.config, "work@example.test", "dca:work");
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const wsl = await start(new FakeConnection(), { ...r.options, aonia });
      const work = (await get(wsl.base, "/api/accounts")).accounts.find((account: { id: string }) => account.id === "work");
      assert.equal(work.hasLogin, true);
      assert.equal(work.email, "work@example.test", "a named account is still read from its own folder");
      assert.deepEqual(await identity(wsl.base), { hasLogin: true, email: "person@example.test" });

      const mapped = r.probe.mapped.length;
      for (const platform of ["win32", "linux"] as const) {
        const native = await start(new FakeConnection(), { ...r.options, platform, runtime: "native" });
        assert.deepEqual(await identity(native.base), { hasLogin: true, email: "windows@example.test" }, `${platform}: the login on this machine`);
        await rm(join(r.winHome, ".config", "muse"), { recursive: true, force: true });
        assert.deepEqual(await identity(native.base), { hasLogin: false, email: null }, `${platform}: signed out is still said`);
        await saveLogin(join(r.winHome, ".config"), "windows@example.test", "dca:windows-side");
      }
      assert.equal(r.probe.mapped.length, mapped, "the distro was not looked at");
    });

    it("leaves the distro alone for a runtime that is not WSL", async (t) => {
      const r = await rig(t);
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      assert.deepEqual(await identity((await start(new FakeConnection(), r.options)).base), { hasLogin: true, email: "person@example.test" }, "the same rig under WSL reads the distro");
      const before = r.probe.mapped.length;
      const native = await start(new FakeConnection(), { ...r.options, runtime: "native" });
      assert.deepEqual(await identity(native.base), { hasLogin: true, email: "windows@example.test" });
      assert.equal(r.probe.mapped.length, before, "nothing was mapped into the distro");
      assert.equal(r.probe.homeCalls, 1, "wsl.exe was asked only by the WSL server");
    });
  });

  describe("what is remembered", () => {
    it("keeps the last reading across a restart over the same data folder", async (t) => {
      const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-distro-data-"));
      const r = await rig(t, { dataDir });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const initial = await start(new FakeConnection(), r.options);
      assert.equal((await first(initial.base)).status, "ready");
      await initial.server.close();

      const down = scriptedReader({ now: Date.now, answer: () => unavailableResult() });
      const restarted = await start(new FakeConnection(), { ...r.options, subscriptionReader: down.reader });
      const report = await get(restarted.base, "/api/plan-usage");
      assert.equal(report.usage.window.usedPercent, 42);
      assert.equal(report.accounts[0].source, "saved");
      assert.equal(report.accounts[0].status, "unavailable");
    });

    it("forgets it, and its plan name, when the login in the distro is another one", async (t) => {
      let answer: () => MuseUsageCliResult = () => snapshot(Date.now(), 42);
      const r = await rig(t, { answer: () => answer() });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const { base } = await start(new FakeConnection(), r.options);
      assert.equal((await first(base)).planName, "Muse Code Power Usage");

      await r.login(DISTRO_CONFIG, "other@example.test", "dca:other-side");
      answer = () => unavailableResult();
      const switched = await first(base);
      assert.equal(switched.usage, null, "another login never inherits the previous reading");
      assert.equal(switched.planName, null);
    });

    it("keeps no credential in what it saves", async (t) => {
      const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-distro-keys-"));
      const r = await rig(t, { dataDir });
      await r.login(DISTRO_CONFIG, "person@example.test", "dca:distro-side");
      const { server, base } = await start(new FakeConnection(), r.options);
      await first(base);
      const scope = await server["quotaCacheScope"](null);
      assert.ok(scope);
      assert.match(scope, /^[0-9a-f]{64}$/);
      await server.close();
      const db = new DatabaseSync(join(dataDir, DB_FILE));
      try {
        const rows = JSON.stringify(db.prepare("SELECT * FROM subscription_usage").all());
        assert.doesNotMatch(rows, /dca:|person@example/);
        assert.match(rows, new RegExp(scope));
      } finally { db.close(); }
    });
  });
});

describe("an account removed and created again under the same id", () => {
  /** Two hosts, the second of which starts when the account is back; the first is the retired one. */
  async function twoLives(t: TestContext, extra: Parameters<typeof start>[1] = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-plan-recreated-"));
    const home = join(dataDir, "home");
    quotaEnvironment(t, home);
    const aonia = createAonia({ home: join(dataDir, "accounts"), platform: "linux", musePath: "muse" });
    const profile = await aonia.createProfile("work");
    const first = new FakeConnection();
    const second = new FakeConnection();
    first.replies.set("session/start", { session: { sessionId: "w1" } });
    second.replies.set("session/start", { session: { sessionId: "w2" } });
    let starts = 0;
    const hostFactory = (target: ServeTarget) => fakeFactory(starts++ === 0 ? first : second)(target);
    const { base } = await start(first, { aonia, home, hostFactory, ...extra });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    const comeBack = async () => {
      assert.equal((await send(base, "/api/accounts/work", undefined, "DELETE")).status, 200);
      const again = await aonia.createProfile("work");
      await send(base, "/api/sessions", { cwd: "/another-project", accountId: "work" });
      return again;
    };
    return { base, first, second, profile, comeBack };
  }
  const workOf = (report: { accounts: { accountId: string | null }[] }) => report.accounts.find((account) => account.accountId === "work") as any;

  it("does not hand its plan name to the new account", async (t) => {
    let stamp = Date.now();
    let answer: () => MuseUsageCliResult = () => snapshot(stamp, 42);
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base, profile, comeBack } = await twoLives(t, { subscriptionReader: reader });
    await saveLogin(profile.roots.config, "work@example.test", "dca:work");
    assert.equal(workOf(await get(base, "/api/plan-usage")).planName, "Muse Code Power Usage");

    // The same person signs in again under the same id: the scope is identical, so only the removal can clear the name.
    const again = await comeBack();
    await saveLogin(again.roots.config, "work@example.test", "dca:work");
    stamp += 1000;
    answer = () => unavailableResult();
    const fresh = workOf(await get(base, "/api/plan-usage"));
    assert.equal(fresh.status, "unavailable");
    assert.equal(fresh.planName, null, "a failed check is not a reason to name a plan the old account had");
  });

  it("does not hand it the arrival moment of a future stamp either", async (t) => {
    const { base, first, second, comeBack } = await twoLives(t);
    const frame = reading(Date.now() + DAY, 10);
    first.notify("usage/changed", frame);
    const early = (await get(base, "/api/plan-usage")).byAccount.work.observedAtMs;
    assert.ok(early <= Date.now());

    await pause(25);
    await comeBack();
    second.notify("usage/changed", frame);
    const late = (await get(base, "/api/plan-usage")).byAccount.work.observedAtMs;
    assert.ok(late > early, "the same stamp from the new account arrives when it arrives, not when the old one did");
  });
});

describe("default server CLI runner for muse usage --json", () => {
  it("invokes muse usage --json through options.exec with MUSE_AUTH_PATH and never passes tokens in argv", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-default-cli-usage-"));
    quotaEnvironment(t, home);
    const authPath = await saveLogin(join(home, ".config"), "person@example.test", "dca:default-cli");
    const stamp = Date.now();
    const calls: Array<{ command: string; args: string[]; museAuthPath: string | undefined }> = [];
    const exec: ExecFn = async (command, args, opts) => {
      calls.push({ command, args, museAuthPath: opts?.env?.["MUSE_AUTH_PATH"] });
      if (args[0] === "usage" && args[1] === "--json") {
        const cli = snapshot(stamp, 31);
        return { stdout: cli.stdout, stderr: cli.stderr, exitCode: cli.exitCode ?? 0 };
      }
      return { stdout: "", exitCode: 127 };
    };
    const { base } = await start(new FakeConnection(), { home, exec });
    const report = await get(base, "/api/plan-usage");
    const usageCall = calls.find((c) => c.args[0] === "usage");
    assert.ok(usageCall, "muse usage --json was invoked");
    assert.deepEqual(usageCall.args, ["usage", "--json"]);
    assert.equal(usageCall.museAuthPath, authPath);
    assert.doesNotMatch(JSON.stringify(calls), /dca:/);
    assert.equal(report.accounts[0].status, "ready");
    assert.equal(report.accounts[0].usage.window.usedPercent, 31);
  });
});
