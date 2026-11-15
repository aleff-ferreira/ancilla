import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync } from "node:fs";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loginIdentity,
  MuseSubscriptionReader,
  parseMuseUsage,
  subscriptionIdentity,
  type MuseUsageCliResult,
  type MuseUsageRunner,
} from "../src/subscriptionQuota.js";

const NOW = 1_800_000_000_000;

function payload(percent = 42, observedAtMs = NOW) {
  return {
    schemaVersion: 1,
    tierName: "Muse Code Power Usage",
    user_email: "person@example.test",
    api_key: "LLM|must-never-leave-the-reader",
    payment_method: "private",
    reason: null,
    hint: null,
    allowance: {
      tier: "27681631238169137",
      observedAtMs,
      window: { usedPercent: percent, resetsAtMs: NOW + 600_000, windowDurationMins: 300 },
      weekly: { usedPercent: 61, resetsAtMs: NOW + 86_400_000 },
    },
  };
}

function cliJson(body: unknown): MuseUsageCliResult {
  return { exitCode: 0, stdout: JSON.stringify(body), stderr: "" };
}

async function fixture(token = "dca:test-device-token") {
  const directory = await mkdtemp(join(tmpdir(), "ancilla-subscription-"));
  after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "auth.json");
  const login = async (next = token, email = "person@example.test", mechanism = "oauth") => {
    await writeFile(path, JSON.stringify({ providers: { meta: { mechanism, access_token: next, user_email: email } } }));
  };
  await login();
  return { path, login };
}

function reader(runUsage: MuseUsageRunner, now: () => number = () => NOW) {
  const instance = new MuseSubscriptionReader({ runUsage, now });
  after(() => instance.close());
  return instance;
}

describe("Muse CLI subscription quota", () => {
  it("keeps exact quota values from muse usage --json, supports snake_case fallbacks, and projects only safe fields", () => {
    const read = parseMuseUsage(payload(125), NOW);
    assert.equal(read?.status, "ready");
    assert.equal(read?.planName, "Muse Code Power Usage");
    assert.equal(read?.usage?.window.usedPercent, 125);
    assert.equal(read?.usage?.window.windowDurationMins, 300);
    assert.equal(read?.usage?.window.resetsAtMs, NOW + 600_000);
    assert.equal(read?.usage?.weekly.resetsAtMs, NOW + 86_400_000);
    assert.equal(read?.usage?.observedAtMs, NOW);
    assert.doesNotMatch(JSON.stringify(read), /must-never|payment_method|person@example/);

    const snake = parseMuseUsage(
      {
        schemaVersion: 1,
        allowance: {
          tier: "pro",
          window: { used_percent: 33, resets_at: NOW / 1000 + 600, window_duration_mins: 300 },
          weekly: { used_percent: 15, resets_at: NOW / 1000 + 86400 },
        },
        reason: null,
        hint: null,
      },
      NOW,
    );
    assert.equal(snake?.status, "ready");
    assert.equal(snake?.usage?.window.usedPercent, 33);
    assert.equal(snake?.usage?.window.resetsAtMs, NOW + 600_000);
    assert.equal(snake?.usage?.weekly.resetsAtMs, NOW + 86_400_000);
  });

  it("distinguishes an idle-window server_sent_no_usage response from inactive subscriptions and api_key sessions", () => {
    const absent = parseMuseUsage({ schemaVersion: 1, allowance: null, reason: "server_sent_no_usage", hint: "No active 5h window", tierName: "Muse Code Power Usage" }, NOW);
    assert.equal(absent?.status, "not-reported");
    assert.equal(absent?.usage, null);
    assert.equal(absent?.planName, "Muse Code Power Usage");

    assert.equal(parseMuseUsage({ schemaVersion: 1, allowance: null, reason: "no_subscription", hint: null }, NOW)?.status, "no-subscription");
    assert.equal(parseMuseUsage({ schemaVersion: 1, allowance: null, reason: "payment_subscription_required", hint: null }, NOW)?.status, "no-subscription");
    assert.equal(parseMuseUsage({ schemaVersion: 1, allowance: null, reason: "api_key", hint: null }, NOW), null);
    assert.equal(parseMuseUsage({ schemaVersion: 1 }, NOW)?.status, "unavailable");
  });

  it("refuses malformed windows without inventing percentages, dates or duration", () => {
    const original = payload();
    for (const field of [
      { usedPercent: -1 },
      { usedPercent: NaN },
      { usedPercent: "9" },
      { usedPercent: 2.4 },
      { windowDurationMins: 0 },
      { resetsAtMs: 0 },
      { resetsAtMs: Infinity },
      { resetsAtMs: 9e15 },
    ]) {
      const read = parseMuseUsage(
        {
          ...original,
          allowance: { ...original.allowance, window: { ...original.allowance.window, ...field } },
        },
        NOW,
      );
      assert.equal(read?.status, "unavailable");
      assert.equal(read?.usage, null);
    }
    assert.equal(parseMuseUsage({ ...original, allowance: { window: original.allowance.window } }, NOW)?.usage, null);
    assert.equal(parseMuseUsage(original, NaN)?.usage, null);
  });

  it("runs muse usage --json without extracting or exposing access_token, and caches within the short window", async () => {
    const { path } = await fixture();
    const before = await readFile(path, "utf8");
    let calls = 0;
    const instance = reader(async (req) => {
      calls++;
      assert.equal(req.authPath, path);
      assert.equal("token" in (req as unknown as Record<string, unknown>), false);
      assert.doesNotMatch(JSON.stringify(req), /dca:/);
      return cliJson(payload());
    });
    assert.equal((await instance.read(path))?.usage?.window.usedPercent, 42);
    assert.equal((await instance.read(path))?.usage?.window.usedPercent, 42);
    assert.equal(calls, 1, "a repeat read uses the short cache without changing the observation stamp");
    assert.equal(await readFile(path, "utf8"), before);
  });

  it("deduplicates simultaneous refreshes and refreshes again after the short cache expires", async () => {
    const { path } = await fixture();
    let time = NOW;
    let calls = 0;
    let finish!: (res: MuseUsageCliResult) => void;
    const instance = reader(
      async () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      () => time,
    );
    const first = instance.read(path);
    const second = instance.read(path);
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    finish(cliJson(payload(42, time)));
    const readings = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(readings[0], readings[1]);
    time += 16_000;
    const next = instance.read(path);
    while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
    finish(cliJson(payload(49, time)));
    assert.equal((await next)?.usage?.window.usedPercent, 49);
    assert.equal((await instance.read(path))?.usage?.observedAtMs, time);
  });

  it("keeps independent accounts and invalidates cached readings when a credential changes", async () => {
    const a = await fixture("dca:first");
    const b = await fixture("dca:second");
    let calls = 0;
    let aPercent = 10;
    const instance = reader(async (req) => {
      calls++;
      return cliJson(payload(req.authPath === a.path ? aPercent : 90));
    });
    assert.equal((await instance.read(a.path))?.usage?.window.usedPercent, 10);
    assert.equal((await instance.read(b.path))?.usage?.window.usedPercent, 90);
    aPercent = 90;
    await a.login("dca:replacement");
    assert.equal((await instance.read(a.path))?.usage?.window.usedPercent, 90);
    assert.equal(calls, 3);
  });

  it("drops a response that finishes after a sign-out or account switch", async () => {
    const { path, login } = await fixture();
    let finish!: (value: MuseUsageCliResult) => void;
    const instance = reader(async () => new Promise((resolve) => { finish = resolve; }));
    const pending = instance.read(path);
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    await login("dca:other-person", "other@example.test");
    finish(cliJson(payload()));
    assert.equal(await pending, null);
  });

  it("never queries inference/API keys, missing credentials or a Keychain-only metadata file", async () => {
    const { path, login } = await fixture();
    let calls = 0;
    const instance = reader(async () => {
      calls++;
      return cliJson(payload());
    });
    for (const token of ["LLM|inference", "LLM_dashboard", "", "dca:bad\nheader"]) {
      await login(token);
      assert.equal(await instance.read(path), null);
    }
    await login("dca:wrong-mechanism", "person@example.test", "api_key");
    assert.equal(await instance.read(path), null);
    await writeFile(path, JSON.stringify({ providers: { meta: { mechanism: "oauth", user_email: "person@example.test" } } }));
    assert.equal(await instance.read(path), null);
    assert.equal(await instance.read(join(path, "missing")), null);
    assert.equal(calls, 0);
  });

  it("rejects a mismatched response identity without exposing it", async () => {
    const { path } = await fixture();
    const instance = reader(async () => cliJson({ ...payload(), user_email: "different@example.test" }));
    const result = await instance.read(path);
    assert.equal(result?.status, "unavailable");
    assert.equal(result?.usage, null);
    assert.doesNotMatch(JSON.stringify(result), /different@example/);
  });

  it("reports rejected logins and CLI errors without exposing stderr bodies", async () => {
    const { path } = await fixture();
    for (const stderr of [
      "muse usage: usage refresh failed (credential_rejected) dca:secret",
      "muse usage: not logged in: run `muse login` first",
      "muse usage: usage refresh failed (transient) dca:secret",
    ]) {
      const instance = reader(async () => ({ exitCode: 1, stdout: "", stderr }));
      const result = await instance.read(path);
      assert.equal(result?.status, stderr.includes("transient") ? "unavailable" : "login-required");
      assert.doesNotMatch(JSON.stringify(result), /secret/);
    }
    const instance = reader(async () => {
      throw new Error("private process details");
    });
    assert.equal((await instance.read(path))?.status, "unavailable");
  });

  it("applies rate-limit cooldown without pretending that a failed refresh produced usage", async () => {
    const { path } = await fixture();
    let time = NOW;
    let calls = 0;
    const instance = new MuseSubscriptionReader({
      now: () => time,
      rateLimitCooldownMs: 120_000,
      runUsage: async () => {
        calls++;
        return { exitCode: 1, stdout: "", stderr: "muse usage: usage refresh failed (rate_limited)" };
      },
    });
    after(() => instance.close());
    assert.equal((await instance.read(path))?.usage, null);
    time += 60_000;
    await instance.read(path);
    assert.equal(calls, 1);
    time += 61_000;
    await instance.read(path);
    assert.equal(calls, 2);
  });

  it("times out a stalled CLI invocation", async () => {
    const { path } = await fixture();
    const instance = new MuseSubscriptionReader({
      now: () => NOW,
      timeoutMs: 5,
      runUsage: async ({ signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
    });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      assert.equal((await instance.read(path))?.status, "unavailable");
    } finally {
      clearTimeout(keepAlive);
      instance.close();
    }
  });

  it("bounds credential and CLI stdout reads and cancels pending invocations on close", async () => {
    const { path } = await fixture();
    const oversized = reader(async () => ({ exitCode: 0, stdout: " ".repeat(512 * 1024 + 1), stderr: "" }));
    assert.equal((await oversized.read(path))?.status, "unavailable");
    await writeFile(path, " ".repeat(512 * 1024 + 1));
    assert.equal(await oversized.read(path), null);
    const valid = await fixture();
    let started = false;
    const pendingReader = reader(
      async ({ signal }) =>
        new Promise((_resolve, reject) => {
          started = true;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const pending = pendingReader.read(valid.path);
    while (!started) await new Promise((resolve) => setImmediate(resolve));
    pendingReader.close();
    assert.equal(await pending, null);
  });
});

describe("the identity of a saved login", () => {
  async function saved(body: string | object) {
    const directory = await mkdtemp(join(tmpdir(), "ancilla-identity-"));
    after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "auth.json");
    await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  }
  const meta = (fields: Record<string, unknown>) => ({ providers: { meta: fields } });

  it("says a login exists, and names its e-mail, from the meta provider's mechanism and user_email", async () => {
    assert.deepEqual(
      await loginIdentity(await saved(meta({ mechanism: "oauth", user_email: "person@example.test", access_token: "dca:t" }))),
      { hasLogin: true, email: "person@example.test" },
    );
    assert.deepEqual(await loginIdentity(await saved(meta({ mechanism: "oauth" }))), { hasLogin: true, email: null });
    assert.deepEqual(await loginIdentity(await saved(meta({ mechanism: "oauth", user_email: "" }))), { hasLogin: true, email: null });
    assert.deepEqual(await loginIdentity(await saved(meta({ mechanism: "oauth", user_email: 7 }))), { hasLogin: true, email: null });
    assert.deepEqual(
      await loginIdentity(await saved(meta({ mechanism: "api_key", user_email: "other@example.test" }))),
      { hasLogin: true, email: "other@example.test" },
    );
  });

  it("gives nothing, never a claim of no login, for a file that does not say one exists", async () => {
    const missing = join(tmpdir(), "ancilla-identity-missing", "auth.json");
    const folder = await mkdtemp(join(tmpdir(), "ancilla-identity-folder-"));
    after(() => rm(folder, { recursive: true, force: true }));
    const cases: [string, string][] = [
      ["no file", missing],
      ["a folder", folder],
      ["not JSON", await saved("{ not json")],
      ["empty", await saved("")],
      ["an array", await saved("[]")],
      ["a string", await saved('"meta"')],
      ["no providers", await saved({})],
      ["no meta provider", await saved({ providers: { other: { mechanism: "oauth" } } })],
      ["meta is text", await saved({ providers: { meta: "oauth" } })],
      ["meta is a list", await saved({ providers: { meta: [] } })],
      ["no mechanism", await saved(meta({ user_email: "person@example.test" }))],
      ["an empty mechanism", await saved(meta({ mechanism: "", user_email: "person@example.test" }))],
      ["a mechanism that is not text", await saved(meta({ mechanism: true, user_email: "person@example.test" }))],
      ["a file past the size limit", await saved(" ".repeat(512 * 1024 + 1))],
    ];
    for (const [name, path] of cases) assert.equal(await loginIdentity(path), null, name);
  });

  it("trims the e-mail, and gives none (the login still exists) for text that is not fit to show as one", async () => {
    const email = async (value: unknown) => await loginIdentity(await saved(meta({ mechanism: "oauth", user_email: value })));
    assert.deepEqual(await email("  person@example.test \n"), { hasLogin: true, email: "person@example.test" });
    const unfit: [string, string][] = [
      ["only spaces", "   "],
      ["a line break inside", "person@example.test\nsecond line"],
      ["a bell", "per\u0007son@example.test"],
      ["a right-to-left override", "person@example.test\u202e"],
      ["a line separator", "person@example.test\u2028second"],
      ["a control character of the C1 block", "person\u0085@example.test"],
      ["more than 320 characters", `${"a".repeat(321)}@example.test`],
    ];
    for (const [name, value] of unfit) assert.deepEqual(await email(value), { hasLogin: true, email: null }, name);
    assert.deepEqual(
      await email(`${"a".repeat(300)}@example.test`),
      { hasLogin: true, email: `${"a".repeat(300)}@example.test` },
      "a long but sane address is kept",
    );
  });

  it("returns only the two fields, whatever else the file holds", async () => {
    const path = await saved(
      meta({
        mechanism: "oauth",
        user_email: "person@example.test",
        user_full_name: "Full Person",
        access_token: "dca:secret-token",
        refresh_token: "secret-refresh",
        expires_at: 1,
      }),
    );
    const identity = await loginIdentity(path);
    assert.deepEqual(Object.keys(identity ?? {}).sort(), ["email", "hasLogin"]);
    assert.doesNotMatch(JSON.stringify(identity), /Full Person|secret|dca:|auth\.json/);
  });

  it("opens a file once for every look at it, those of the quota reader's own kind included", async (t) => {
    let opens = 0;
    t.mock.method(fs, "open", () => {
      opens++;
      return new Promise(() => {});
    });
    const path = join(tmpdir(), "ancilla-identity-never-opened", "auth.json");
    for (let look = 0; look < 3; look++) {
      void loginIdentity(path);
      void subscriptionIdentity(path);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opens, 1);
  });
});

describe("a login file that does not open", () => {
  it("is opened once, however many looks ask, so the thread pool is not used up", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "ancilla-subscription-fifo-"));
    const fifo = join(directory, "auth.json");
    execFileSync("mkfifo", [fifo]);
    const plain = join(directory, "plain.txt");
    await writeFile(plain, "fine");
    t.after(async () => {
      openSync(fifo, "r+");
      await rm(directory, { recursive: true, force: true });
    });
    for (let look = 0; look < Number(process.env["UV_THREADPOOL_SIZE"] ?? 4) + 2; look++) void subscriptionIdentity(fifo);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const answer = await Promise.race([readFile(plain, "utf8"), new Promise<string>((resolve) => setTimeout(() => resolve("starved"), 2000))]);
    assert.equal(answer, "fine");
  });

  it("is opened once however many looks ask, on every platform, with nothing here to block a thread", async (t) => {
    let opens = 0;
    t.mock.method(fs, "open", () => {
      opens++;
      return new Promise(() => {});
    });
    for (let look = 0; look < 6; look++) void subscriptionIdentity(join(tmpdir(), "ancilla-never-opened", "auth.json"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opens, 1);
  });
});
