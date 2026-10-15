import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAonia } from "@harjjotsinghh/aonia";
import type { ExecFn, ServeTarget } from "@ancilla/daemon";
import { DB_FILE } from "../src/legacy.js";
import { MuseSubscriptionReader } from "../src/subscriptionQuota.js";
import { FakeConnection, fakeFactory, get, send, sseEvents, start } from "./harness.js";

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

/** What Meta answers for an active plan; its reset stamps are epoch seconds. */
function snapshot(at: number, percent: number) {
  return { is_subs_active: true, subs_tier_name: "Muse Code Power Usage",
    subs_usage: { tier: "123", window: { used_percent: percent, resets_at: at / 1000 + 3600, window_duration_mins: 300 },
      weekly: { used_percent: 20, resets_at: at / 1000 + 86400 } } };
}

/** A usage/changed frame, or the body of a usage/read reply; MSP stamps are milliseconds. */
function reading(at: number, percent: number) {
  return { tier: "high", observedAtMs: at,
    window: { usedPercent: percent, resetsAtMs: at + 60_000, windowDurationMins: 300 },
    weekly: { usedPercent: 10, resetsAtMs: at + 600_000, windowDurationMins: null } };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A reader whose answers the test chooses and whose requests it can count. */
function scriptedReader(options: { now: () => number; answer: () => Response }) {
  const probe = { requests: 0 };
  const reader = new MuseSubscriptionReader({ now: options.now, cacheMs: 0, fetch: async () => {
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
    let answer: () => Response = () => Response.json(snapshot(stamp, 42));
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });

    const good = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(good.status, "ready");
    assert.equal(good.planName, "Muse Code Power Usage");
    assert.equal(good.source, "meta");

    stamp += 1000;
    answer = () => new Response("private failure", { status: 503 });
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
    let answer: () => Response = () => Response.json(snapshot(stamp, 42));
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Power Usage");

    stamp += 1000;
    answer = () => Response.json({ is_subs_active: false });
    const ended = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(ended.status, "no-subscription");
    assert.equal(ended.planName, null);

    stamp += 1000;
    answer = () => new Response(null, { status: 503 });
    const failed = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.planName, null, "a plan that ended is not the plan to show after a failed check");
  });

  it("forgets the plan name of an ended subscription even while a newer runtime reading keeps its numbers", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-ended-runtime-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    let stamp = Date.now();
    let answer: () => Response = () => Response.json(snapshot(stamp, 42));
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { home, subscriptionReader: reader });
    await send(base, "/api/sessions", { cwd: "/work" });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Power Usage");

    connection.notify("usage/changed", reading(stamp + 5000, 60));
    stamp += 1000;
    answer = () => Response.json({ is_subs_active: false });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, null);

    stamp += 1000;
    answer = () => new Response(null, { status: 503 });
    const failed = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(failed.usage.window.usedPercent, 60, "the newer runtime reading is still the one shown");
    assert.equal(failed.planName, null);
  });

  it("keeps the name through a login Meta rejected, and through a failed check after it", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-rejected-"));
    quotaEnvironment(t, home);
    await saveLogin(join(home, ".config"), "person@example.test", "dca:default");
    let stamp = Date.now();
    let answer: () => Response = () => Response.json(snapshot(stamp, 42));
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base } = await start(new FakeConnection(), { home, subscriptionReader: reader });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Power Usage");
    stamp += 1000;
    answer = () => new Response(null, { status: 401 });
    const rejected = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(rejected.status, "login-required");
    assert.equal(rejected.planName, "Muse Code Power Usage", "a rejected token says nothing about which plan the account is on");
    stamp += 1000;
    answer = () => new Response(null, { status: 503 });
    const failed = (await get(base, "/api/plan-usage")).accounts[0];
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.planName, "Muse Code Power Usage", "the order of the failures does not matter");
    stamp += 1000;
    answer = () => Response.json({ ...snapshot(stamp, 50), subs_tier_name: "Muse Code Maximum Usage" });
    assert.equal((await get(base, "/api/plan-usage")).accounts[0].planName, "Muse Code Maximum Usage", "Meta's next answer replaces it");
  });

  it("keeps the name when the same login no longer holds a token, and asks Meta nothing", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-plan-notoken-"));
    quotaEnvironment(t, home);
    const root = join(home, ".config");
    await saveLogin(root, "person@example.test", "dca:default");
    let stamp = Date.now();
    const { reader, probe } = scriptedReader({ now: () => stamp, answer: () => Response.json(snapshot(stamp, 42)) });
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
    // Whole seconds, so Meta's second-based reset stamps and MSP's millisecond ones agree exactly.
    const stamp = Math.floor(Date.now() / 1000) * 1000;
    const { reader } = scriptedReader({ now: () => stamp, answer: () => Response.json(snapshot(stamp, 42)) });
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

describe("runtimes without a direct Meta read", () => {
  /** A `wsl.exe` that finds Muse in the one distro. */
  const fakeWsl: ExecFn = async (command, args) => {
    if (command !== "wsl") return { stdout: "", exitCode: 127 };
    if (args[0] === "-l") return { stdout: "  NAME  STATE  VERSION\n* Ubuntu  Running  2\n", exitCode: 0 };
    if (args[2] === "-e" && args[3] === "test") return { stdout: "", exitCode: 0 };
    return { stdout: "/home/u/.local/bin/muse\n", exitCode: 0 };
  };
  const WSL_PROJECT = "\\\\wsl.localhost\\Ubuntu\\home\\u\\proj";

  it("never reads a login under WSL, gives no plan name, and restores nothing after a restart", async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-quota-wsl-"));
    const home = join(dataDir, "home");
    quotaEnvironment(t, home);
    // A login on the Windows side must not be mistaken for the one Muse uses inside the distro.
    await saveLogin(join(home, ".config"), "person@example.test", "dca:windows-side");
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => Response.json(snapshot(Date.now(), 42)) });
    const options = { dataDir, home, platform: "win32" as const, runtime: "wsl" as const, musePath: "/home/u/.local/bin/muse",
      exec: fakeWsl };
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
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => Response.json(snapshot(Date.now(), 42)) });
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
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => Response.json(snapshot(Date.now(), 42)) });
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
    const { reader, probe } = scriptedReader({ now: Date.now, answer: () => Response.json(snapshot(Date.now(), 42)) });
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
    let answer: () => Response = () => Response.json(snapshot(stamp, 42));
    const { reader } = scriptedReader({ now: () => stamp, answer: () => answer() });
    const { base, profile, comeBack } = await twoLives(t, { subscriptionReader: reader });
    await saveLogin(profile.roots.config, "work@example.test", "dca:work");
    assert.equal(workOf(await get(base, "/api/plan-usage")).planName, "Muse Code Power Usage");

    // The same person signs in again under the same id: the scope is identical, so only the removal can clear the name.
    const again = await comeBack();
    await saveLogin(again.roots.config, "work@example.test", "dca:work");
    stamp += 1000;
    answer = () => new Response(null, { status: 503 });
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
