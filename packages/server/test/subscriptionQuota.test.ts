import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseSubscriptionReader, parseMetaSubscription } from "../src/subscriptionQuota.js";

const NOW = 1_800_000_000_000;
function payload(percent = 42) {
  return {
    is_subs_active: true, require_payment: false, subs_tier_name: "Muse Code Power Usage",
    user_email: "person@example.test", api_key: "LLM|must-never-leave-the-reader", payment_method: "private",
    subs_usage: {
      tier: "27681631238169137",
      window: { used_percent: percent, resets_at: NOW / 1000 + 600, window_duration_mins: 300 },
      weekly: { used_percent: 61, resets_at: NOW / 1000 + 86400 },
    },
  };
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

function reader(fetcher: (url: string | URL | Request, init?: RequestInit) => Promise<Response>, now: () => number = () => NOW) {
  const instance = new MuseSubscriptionReader({ fetch: fetcher as typeof fetch, now });
  after(() => instance.close());
  return instance;
}

describe("Meta subscription quota", () => {
  it("keeps exact quota values, converts seconds to milliseconds and projects only safe fields", () => {
    const read = parseMetaSubscription(payload(125), NOW);
    assert.equal(read.status, "ready");
    assert.equal(read.planName, "Muse Code Power Usage");
    assert.equal(read.usage?.window.usedPercent, 125);
    assert.equal(read.usage?.window.windowDurationMins, 300);
    assert.equal(read.usage?.window.resetsAtMs, NOW + 600_000);
    assert.equal(read.usage?.weekly.resetsAtMs, NOW + 86_400_000);
    assert.equal(read.usage?.observedAtMs, NOW);
    assert.doesNotMatch(JSON.stringify(read), /must-never|payment_method|person@example/);
  });

  it("distinguishes a missing idle-window snapshot from an unused or inactive subscription", () => {
    const absent = parseMetaSubscription({ ...payload(), subs_usage: null }, NOW);
    assert.equal(absent.status, "not-reported");
    assert.equal(absent.usage, null);
    assert.equal(absent.planName, "Muse Code Power Usage");
    assert.equal(parseMetaSubscription({ ...payload(), is_subs_active: false }, NOW).status, "no-subscription");
    assert.equal(parseMetaSubscription({ ...payload(), require_payment: true }, NOW).usage, null);
    assert.equal(parseMetaSubscription({ subs_usage: payload().subs_usage }, NOW).status, "unavailable");
  });

  it("refuses malformed windows without inventing percentages, dates or duration", () => {
    const original = payload();
    for (const field of [
      { used_percent: -1 }, { used_percent: NaN }, { used_percent: "9" }, { used_percent: 2.4 },
      { window_duration_mins: 0 }, { resets_at: 0 }, { resets_at: Infinity }, { resets_at: 9e15 },
    ]) {
      const read = parseMetaSubscription({ ...original, subs_usage: { ...original.subs_usage, window: { ...original.subs_usage.window, ...field } } }, NOW);
      assert.equal(read.status, "unavailable");
      assert.equal(read.usage, null);
    }
    assert.equal(parseMetaSubscription({ ...original, subs_usage: { window: original.subs_usage.window } }, NOW).usage, null);
    assert.equal(parseMetaSubscription(original, NaN).usage, null);
  });

  it("uses the fixed Meta endpoint, refuses redirects, and never writes the returned key to credentials", async () => {
    const { path } = await fixture();
    const before = await readFile(path, "utf8");
    let calls = 0;
    const instance = reader(async (url, init) => {
      calls++;
      assert.equal(url, "https://api.meta.ai/muse-code/key");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.body, "{}");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer dca:test-device-token");
      return Response.json(payload());
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
    let finish!: (response: Response) => void;
    const instance = reader(async () => { calls++; return new Promise((resolve) => { finish = resolve; }); }, () => time);
    const first = instance.read(path);
    const second = instance.read(path);
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    finish(Response.json(payload()));
    const readings = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(readings[0], readings[1]);
    time += 16_000;
    const next = instance.read(path);
    while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
    finish(Response.json(payload(49)));
    assert.equal((await next)?.usage?.window.usedPercent, 49);
    assert.equal((await instance.read(path))?.usage?.observedAtMs, time);
  });

  it("keeps independent accounts and invalidates cached readings when a credential changes", async () => {
    const a = await fixture("dca:first");
    const b = await fixture("dca:second");
    let calls = 0;
    const instance = reader(async (_url, init) => {
      calls++;
      const first = new Headers(init?.headers).get("Authorization") === "Bearer dca:first";
      return Response.json(payload(first ? 10 : 90));
    });
    assert.equal((await instance.read(a.path))?.usage?.window.usedPercent, 10);
    assert.equal((await instance.read(b.path))?.usage?.window.usedPercent, 90);
    await a.login("dca:replacement");
    assert.equal((await instance.read(a.path))?.usage?.window.usedPercent, 90);
    assert.equal(calls, 3);
  });

  it("drops a response that finishes after a sign-out or account switch", async () => {
    const { path, login } = await fixture();
    let finish!: (value: Response) => void;
    const instance = reader(async () => new Promise((resolve) => { finish = resolve; }));
    const pending = instance.read(path);
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    await login("dca:other-person", "other@example.test");
    finish(Response.json(payload()));
    assert.equal(await pending, null);
  });

  it("never uses inference/API keys, missing credentials or a Keychain-only metadata file", async () => {
    const { path, login } = await fixture();
    let calls = 0;
    const instance = reader(async () => { calls++; return Response.json(payload()); });
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
    const instance = reader(async () => Response.json({ ...payload(), user_email: "different@example.test" }));
    const result = await instance.read(path);
    assert.equal(result?.status, "unavailable");
    assert.equal(result?.usage, null);
    assert.doesNotMatch(JSON.stringify(result), /different@example/);
  });

  it("reports rejected logins and network errors without exposing provider error bodies", async () => {
    const { path } = await fixture();
    for (const code of [401, 403, 500]) {
      const instance = reader(async () => new Response("dca:secret-provider-error", { status: code }));
      const result = await instance.read(path);
      assert.equal(result?.status, code === 500 ? "unavailable" : "login-required");
      assert.doesNotMatch(JSON.stringify(result), /secret/);
    }
    const instance = reader(async () => { throw new Error("private request details"); });
    assert.equal((await instance.read(path))?.status, "unavailable");
  });

  it("honors retry-after throttling without pretending that a failed refresh produced usage", async () => {
    const { path } = await fixture();
    let time = NOW;
    let calls = 0;
    const instance = reader(async () => { calls++; return new Response(null, { status: 429, headers: { "Retry-After": "120" } }); }, () => time);
    assert.equal((await instance.read(path))?.usage, null);
    time += 60_000;
    await instance.read(path);
    assert.equal(calls, 1);
    time += 61_000;
    await instance.read(path);
    assert.equal(calls, 2);
  });

  it("times out a stalled provider request", async () => {
    const { path } = await fixture();
    const instance = new MuseSubscriptionReader({ now: () => NOW, timeoutMs: 5, fetch: async (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true })) });
    // AbortSignal's timer is unreferenced; retain the test process while it fires.
    const keepAlive = setTimeout(() => {}, 1000);
    try { assert.equal((await instance.read(path))?.status, "unavailable"); }
    finally { clearTimeout(keepAlive); instance.close(); }
  });

  it("bounds credential and response reads and cancels pending fetches on close", async () => {
    const { path } = await fixture();
    const oversized = reader(async () => new Response(" ".repeat(512 * 1024 + 1)));
    assert.equal((await oversized.read(path))?.status, "unavailable");
    await writeFile(path, " ".repeat(512 * 1024 + 1));
    assert.equal(await oversized.read(path), null);
    const valid = await fixture();
    let started = false;
    const pendingReader = reader(async (_url, init) => new Promise((_resolve, reject) => {
      started = true;
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = pendingReader.read(valid.path);
    while (!started) await new Promise((resolve) => setImmediate(resolve));
    pendingReader.close();
    assert.equal(await pending, null);
  });
});
