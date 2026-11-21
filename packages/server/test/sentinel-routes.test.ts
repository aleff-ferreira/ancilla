import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantReply } from "../src/assistant/routes.js";
import type { Collector, CollectorHooks } from "../src/sentinel/collector.js";
import { handleSentinel, isSentinelPath } from "../src/sentinel/routes.js";
import { SentinelService, type StatusView } from "../src/sentinel/service.js";
import type { CollectorStatus, Finding } from "../src/sentinel/types.js";
import { LogBuilder, MIN, T0 } from "./sentinel-fixtures.js";

/** The Sentinel's HTTP surface as a function from a request to a reply, with a service that has no collector behind it. */

class Quiet implements Collector {
  hooks: CollectorHooks | null = null;
  start(hooks: CollectorHooks): void {
    this.hooks = hooks;
  }
  stop(): void {
    this.hooks = null;
  }
  status(): CollectorStatus {
    return { state: this.hooks ? "running" : "off", since: null, restarts: 0, lastError: null, sources: {} };
  }
}

function rig(platform: NodeJS.Platform = "win32") {
  const clock = { t: T0 + 30 * MIN };
  const collector = new Quiet();
  const service = new SentinelService({ dir: null, collector, now: () => clock.t, platform, schedule: () => () => undefined });
  const call = (method: string, sub: string, body: Record<string, unknown> = {}, query = ""): Promise<AssistantReply> =>
    handleSentinel(service, { method, path: `/api/assistant/desktop${sub}`, query: new URLSearchParams(query), body: async () => body });
  return { clock, collector, service, call };
}

describe("the Sentinel's routes", () => {
  it("owns /api/assistant/desktop and nothing next to it", () => {
    assert.equal(isSentinelPath("/api/assistant/desktop"), true);
    assert.equal(isSentinelPath("/api/assistant/desktop/findings"), true);
    assert.equal(isSentinelPath("/api/assistant/desktopx"), false);
    assert.equal(isSentinelPath("/api/assistant"), false);
    assert.equal(isSentinelPath("/api/assistant/connectors"), false);
  });

  it("reports the status, with both switches off", async () => {
    const { call } = rig();
    const reply = await call("GET", "");
    assert.equal(reply.status, 200);
    const status = reply.body as StatusView;
    assert.deepEqual(status.settings, { watch: false, act: false });
    assert.equal(status.watching, false);
    assert.equal(status.supported, true);
  });

  it("changes a setting, and refuses what it does not know, what is not a boolean, and Watch off Windows", async () => {
    const { call, collector } = rig();
    const on = await call("PATCH", "/settings", { watch: true });
    assert.equal(on.status, 200);
    assert.deepEqual((on.body as { settings: unknown }).settings, { watch: true, act: false });
    assert.equal(collector.hooks !== null, true, "the collector started");
    assert.equal(((await call("GET", "")).body as StatusView).watching, true);
    for (const body of [{ watch: "yes" }, { elevate: true }, {}]) {
      const bad = await call("PATCH", "/settings", body);
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal((bad.body as { kind: string }).kind, "invalid");
    }
    const linux = rig("linux");
    const refused = await linux.call("PATCH", "/settings", { watch: true });
    assert.equal(refused.status, 409);
    assert.equal(linux.collector.hooks, null);
  });

  it("lists findings, the open ones, since a time, and no more than asked", async () => {
    const { call, collector, clock, service } = rig();
    await call("PATCH", "/settings", { watch: true });
    const t = clock.t;
    const b = new LogBuilder();
    b.disconnect(t, 0);
    b.disconnect(t + 2 * MIN, 0);
    for (const event of b.events) collector.hooks?.event(event);
    clock.t = t + 3 * MIN;
    service.tick();
    const all = (await call("GET", "/findings")).body as { findings: Finding[] };
    assert.equal(all.findings.length, 2);
    assert.equal(((await call("GET", "/findings", {}, "open=1")).body as { findings: Finding[] }).findings.length, 2);
    assert.equal(((await call("GET", "/findings", {}, "limit=1")).body as { findings: Finding[] }).findings.length, 1);
    assert.equal(((await call("GET", "/findings", {}, `since=${t + MIN}`)).body as { findings: Finding[] }).findings.length, 1);
    assert.equal(((await call("GET", "/findings", {}, "limit=abc&since=x")).body as { findings: Finding[] }).findings.length, 2);
  });

  it("gives the digest, the history by day, and the audit with a check of its chain", async () => {
    const { call, service } = rig();
    await call("PATCH", "/settings", { watch: true });
    assert.equal(((await call("GET", "/digest")).body as { digest: { total: number } }).digest.total, 0);
    const history = (await call("GET", "/history", {}, "days=3&offset=-180")).body as { days: Array<{ day: string }> };
    assert.equal(history.days.length, 3);
    assert.equal(((await call("GET", "/history", {}, "days=9999")).body as { days: unknown[] }).days.length, 120);
    assert.equal(((await call("GET", "/history")).body as { days: unknown[] }).days.length, 14);
    const audit = (await call("GET", "/audit", {}, "limit=1")).body as { entries: Array<{ kind: string }> };
    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0]?.kind, "settings");
    assert.deepEqual(((await call("GET", "/audit/verify")).body as { check: unknown }).check, service.verifyAudit());
    assert.equal(service.verifyAudit().ok, true);
  });

  it("says nothing is here for the rest", async () => {
    const { call } = rig();
    assert.equal((await call("GET", "/nothing")).status, 404);
    assert.equal((await call("POST", "/findings")).status, 404);
    assert.equal((await call("DELETE", "")).status, 404);
  });
});
