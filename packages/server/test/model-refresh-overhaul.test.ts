/**
 * @file model-refresh-overhaul.test.ts
 *
 * Server-level E2E & Integration Test Suite for Feature 5 (Server Refresh Recycling & Probe Hosts).
 * Exercises real AncillaServer HTTP routing, idle host recycling, busy host preservation,
 * ephemeral probe host lifecycle (__probe__:...), session bundledCatalog fallback, and cleanup.
 *
 * Implements the 12 server test cases from TEST_INFRA.md:
 * - Tier 1: F5-T1-01 to F5-T1-05
 * - Tier 2: F5-T2-01 to F5-T2-05
 * - Tier 3: COMB-T3-05
 * - Tier 4: SCEN-T4-04
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServeTarget } from "@ancilla/daemon";
import { AncillaServer, type HostHandle } from "../src/server.js";
import { FakeConnection, get, send, start } from "./harness.js";

interface TrackedHost {
  id: number;
  target: ServeTarget;
  connection: FakeConnection;
  closed: boolean;
  closeCallCount: number;
  handle: HostHandle;
}

function catalogResponse(models: string[], source = "providerCatalog", providerId = "meta") {
  return {
    source,
    providerId,
    profileId: "profile-test",
    models: models.map((modelId) => ({
      modelId,
      displayLabel: modelId,
      providerId,
      profileId: "profile-test",
      isActive: false,
    })),
  };
}

function createTrackingRig() {
  const trackedHosts: TrackedHost[] = [];
  let nextId = 1;

  const makeHostFactory = (
    getConnection?: (target: ServeTarget, id: number) => FakeConnection,
    options?: { onStart?: (target: ServeTarget, id: number) => Promise<void> },
  ) => {
    return (target: ServeTarget): HostHandle => {
      const id = nextId++;
      const conn = getConnection ? getConnection(target, id) : new FakeConnection();
      const hostRecord: TrackedHost = {
        id,
        target,
        connection: conn,
        closed: false,
        closeCallCount: 0,
        handle: null as any,
      };

      const handle: HostHandle = {
        start: async () => {
          if (options?.onStart) {
            await options.onStart(target, id);
          } else {
            await new Promise((r) => setTimeout(r, 5));
          }
          return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
        },
        connection: conn as never,
        close: async () => {
          hostRecord.closed = true;
          hostRecord.closeCallCount++;
          return { code: 0, signal: null };
        },
        onExit: () => {},
      };
      hostRecord.handle = handle;
      trackedHosts.push(hostRecord);
      return handle;
    };
  };

  return { trackedHosts, makeHostFactory };
}

// ============================================================================
// TIER 1: Feature Coverage (5 Tests)
// ============================================================================

describe("Tier 1: Server Refresh & Host Lifecycle", () => {
  it("F5-T1-01: Idle Listing Host Recycling on Force Refresh", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    let connCount = 0;
    const conns = [new FakeConnection(), new FakeConnection()];
    conns[0].replies.set("model/list", catalogResponse(["muse-spark-1.3"]));
    conns[1].replies.set("model/list", catalogResponse(["muse-spark-1.3", "muse-wonder-1.0"]));

    const factory = makeHostFactory(() => {
      return conns[connCount++] ?? new FakeConnection();
    });

    const { base } = await start(conns[0], { hostFactory: factory });

    // Initial fetch: spawns Host 1
    const initial = await get(base, "/api/models");
    assert.equal(trackedHosts.length, 1);
    assert.equal(trackedHosts[0]?.closed, false);
    assert.equal(initial.models.models.length, 1);
    assert.equal(initial.models.models[0]?.modelId, "muse-spark-1.3");

    // Force refresh: recycles idle Host 1 and spawns Host 2
    const refreshed = await get(base, "/api/models?refresh=1");
    assert.equal(trackedHosts[0]?.closed, true, "Host 1 must be closed on idle recycling");
    assert.equal(trackedHosts.length, 2, "Fresh listing host must be spawned");
    assert.equal(trackedHosts[1]?.closed, false, "Fresh listing host remains open");
    assert.equal(refreshed.models.models.length, 2);
    assert.equal(refreshed.models.models[1]?.modelId, "muse-wonder-1.0");
  });

  it("F5-T1-02: Busy Listing Host Preservation via Ephemeral Probe Host", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    let connCount = 0;
    const host1Conn = new FakeConnection();
    host1Conn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));
    const probeConn = new FakeConnection();
    probeConn.replies.set("model/list", catalogResponse(["muse-probe-model"]));

    const factory = makeHostFactory(() => {
      if (connCount === 0) {
        connCount++;
        return host1Conn;
      }
      return probeConn;
    });

    const { base, server } = await start(host1Conn, { hostFactory: factory });

    // Initial fetch: spawns Host 1
    await get(base, "/api/models");
    assert.equal(trackedHosts.length, 1);
    const host1 = trackedHosts[0];
    assert.ok(host1);

    // Mark host 1 busy via active turn
    const listingKey = (server as any).hostKey("", null, "muse");
    const existing = (server as any).hosts.get(listingKey);
    assert.ok(existing);
    (server as any).live.set("session-busy-1", {
      turnHost: existing.key,
      activeTurnId: "turn-1",
      pendingApprovals: new Set(),
      pendingInputs: new Set(),
    });

    // Force refresh: Host 1 is preserved (NOT closed); ephemeral probe host is spawned & closed
    const res = await get(base, "/api/models?refresh=1");
    assert.equal(host1.closed, false, "Busy host 1 must NOT be closed");
    assert.equal(trackedHosts.length, 2, "Probe host must be spawned");
    assert.equal(trackedHosts[1]?.closed, true, "Probe host must be closed in finally");
    assert.equal(res.models.models.length, 1);
    assert.equal(res.models.models[0]?.modelId, "muse-probe-model");
  });

  it("F5-T1-03: Ephemeral Probe Host Closure in Finally Block", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    const hostConn = new FakeConnection();
    hostConn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));
    const probeConn = new FakeConnection();
    probeConn.replies.set("model/list", catalogResponse(["muse-probe-model"]));

    let connCount = 0;
    const factory = makeHostFactory(() => (connCount++ === 0 ? hostConn : probeConn));
    const { base, server } = await start(hostConn, { hostFactory: factory });

    await get(base, "/api/models");
    const listingKey = (server as any).hostKey("", null, "muse");
    const existing = (server as any).hosts.get(listingKey);
    assert.ok(existing);
    (server as any).live.set("session-busy-3", {
      turnHost: existing.key,
      activeTurnId: "turn-3",
      pendingApprovals: new Set(),
      pendingInputs: new Set(),
    });

    await get(base, "/api/models?refresh=1");
    assert.equal(trackedHosts.length, 2);
    const probeHost = trackedHosts[1];
    assert.ok(probeHost);
    assert.equal(probeHost.closed, true, "Probe host must be closed in finally");
    assert.equal(probeHost.closeCallCount, 1, "Probe host close must be called exactly once");

    // Assert that no probe keys linger in server.hosts
    const remainingKeys = Array.from((server as any).hosts.keys()) as string[];
    const probeKeys = remainingKeys.filter((k) => k.startsWith("__probe__"));
    assert.equal(probeKeys.length, 0, "No probe host key should linger in hosts map");
  });

  it("F5-T1-04: Session Scope BundledCatalog Refresh Triggering Probe Host", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    const sessionConn = new FakeConnection();
    sessionConn.replies.set("session/start", { session: { sessionId: "sess-1" } });
    sessionConn.replies.set("model/list", {
      source: "bundledCatalog",
      providerId: "meta",
      profileId: "default",
      models: [],
    });

    const probeConn = new FakeConnection();
    probeConn.replies.set("model/list", catalogResponse(["muse-fresh-1.0"]));

    let connCount = 0;
    const factory = makeHostFactory(() => (connCount++ === 0 ? sessionConn : probeConn));
    const { base } = await start(sessionConn, { hostFactory: factory });

    // Start session
    const startRes = await send(base, "/api/sessions", { cwd: "/tmp" });
    assert.equal(startRes.status, 200);
    const sessionId = startRes.json.session.sessionId;

    // Normal get without refresh returns bundledCatalog without spawning probe
    const unrefreshed = await get(base, `/api/models?sessionId=${sessionId}`);
    assert.equal(unrefreshed.models.source, "bundledCatalog");
    assert.equal(unrefreshed.models.models.length, 0);
    assert.equal(trackedHosts.length, 1);

    // Refresh with bundledCatalog triggers probe host
    const refreshed = await get(base, `/api/models?sessionId=${sessionId}&refresh=1`);
    assert.equal(trackedHosts.length, 2, "Probe host must be spawned to refresh bundled catalog");
    assert.equal(refreshed.models.source, "providerCatalog");
    assert.equal(refreshed.models.models[0]?.modelId, "muse-fresh-1.0");
    assert.equal(trackedHosts[0]?.closed, false, "Session host must remain open");
    assert.equal(trackedHosts[1]?.closed, true, "Probe host must be closed in finally");
  });

  it("F5-T1-05: Rejection of Invalid ProviderId Parameter", async () => {
    const conn = new FakeConnection();
    conn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));
    const { base } = await start(conn);

    const badRes = await send(base, "/api/models?providerId=bogus_ai", undefined, "GET");
    assert.equal(badRes.status, 400);
    assert.equal(badRes.json.error, "Unknown providerId.");

    const validRes = await send(base, "/api/models?providerId=muse", undefined, "GET");
    assert.equal(validRes.status, 200);
  });
});

// ============================================================================
// TIER 2: Boundary & Corner Cases (5 Tests)
// ============================================================================

describe("Tier 2: Server Boundary & Corner Cases", () => {
  it("F5-T2-01: Probe Host Failure Fallback", async () => {
    const { makeHostFactory } = createTrackingRig();
    const sessionConn = new FakeConnection();
    sessionConn.replies.set("session/start", { session: { sessionId: "sess-fallback" } });
    sessionConn.replies.set("model/list", {
      source: "bundledCatalog",
      providerId: "meta",
      profileId: "default",
      models: [],
    });

    const factory = makeHostFactory(
      () => sessionConn,
      {
        onStart: async (_target, id) => {
          if (id > 1) {
            throw new Error("Probe host failed to spawn");
          }
        },
      },
    );

    const { base } = await start(sessionConn, { hostFactory: factory });
    const startRes = await send(base, "/api/sessions", { cwd: "/tmp" });
    assert.equal(startRes.status, 200);
    const sessionId = startRes.json.session.sessionId;

    // Refresh when probe fails should fall back to session host response gracefully (HTTP 200)
    const res = await send(base, `/api/models?sessionId=${sessionId}&refresh=1`, undefined, "GET");
    assert.equal(res.status, 200, "Must not crash with 500 when probe fails");
    assert.equal(res.json.models.source, "bundledCatalog");
    assert.equal(res.json.models.models.length, 0);
  });

  it("F5-T2-02: Ephemeral Probe Key Uniqueness & UUID Format", async () => {
    const capturedProbeKeys: string[] = [];
    const { makeHostFactory } = createTrackingRig();
    const conn = new FakeConnection();
    conn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));

    const origStderrWrite = process.stderr.write;
    process.stderr.write = function (chunk: any, ...args: any[]): boolean {
      const str = String(chunk);
      const match = /host (__probe__:[^ ]+) cannot report/.exec(str);
      if (match?.[1] && !capturedProbeKeys.includes(match[1])) {
        capturedProbeKeys.push(match[1]);
      }
      return (origStderrWrite as any).apply(process.stderr, [chunk, ...args]);
    };

    try {
      const factory = makeHostFactory(() => conn);
      const { base, server } = await start(conn, { hostFactory: factory });

      await get(base, "/api/models");
      const listingKey = (server as any).hostKey("", null, "muse");
      const existing = (server as any).hosts.get(listingKey);
      assert.ok(existing);
      (server as any).live.set("session-busy-2", {
        turnHost: existing.key,
        activeTurnId: "turn-2",
        pendingApprovals: new Set(),
        pendingInputs: new Set(),
      });

      // Fire two consecutive refreshes on the busy host
      await get(base, "/api/models?refresh=1");
      await get(base, "/api/models?refresh=1");

      assert.ok(
        capturedProbeKeys.length >= 2,
        `Must capture at least 2 probe keys, got ${capturedProbeKeys.length}`,
      );
      const uuidRegex = /^__probe__:[^:]+:[^:]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      for (const key of capturedProbeKeys) {
        assert.match(key, uuidRegex, `Probe key '${key}' must match UUID format`);
      }
      assert.notEqual(capturedProbeKeys[0], capturedProbeKeys[1], "Probe keys must have unique UUIDs");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("F5-T2-03: Session Host on ProviderCatalog (Non-Bundled) Refresh Bypass", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    const sessionConn = new FakeConnection();
    sessionConn.replies.set("session/start", { session: { sessionId: "sess-provider" } });
    sessionConn.replies.set("model/list", catalogResponse(["session-model-1"]));

    const factory = makeHostFactory(() => sessionConn);
    const { base } = await start(sessionConn, { hostFactory: factory });

    const startRes = await send(base, "/api/sessions", { cwd: "/tmp" });
    assert.equal(startRes.status, 200);
    const sessionId = startRes.json.session.sessionId;

    // Refresh when source is already providerCatalog should NOT probe
    const res = await get(base, `/api/models?sessionId=${sessionId}&refresh=1`);
    assert.equal(res.models.source, "providerCatalog");
    assert.equal(res.models.models[0]?.modelId, "session-model-1");
    assert.equal(trackedHosts.length, 1, "Zero probe hosts should be spawned for providerCatalog");
  });

  it("F5-T2-04: Probe Host Process Cleanup on Unhandled Exception", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    const hostConn = new FakeConnection();
    hostConn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));
    const probeConn = new FakeConnection();
    probeConn.replies.set("model/list", new Error("Protocol crash during model listing"));

    let connCount = 0;
    const factory = makeHostFactory(() => (connCount++ === 0 ? hostConn : probeConn));
    const { base, server } = await start(hostConn, { hostFactory: factory });

    await get(base, "/api/models");
    const listingKey = (server as any).hostKey("", null, "muse");
    const existing = (server as any).hosts.get(listingKey);
    assert.ok(existing);
    (server as any).live.set("session-busy-4", {
      turnHost: existing.key,
      activeTurnId: "turn-4",
      pendingApprovals: new Set(),
      pendingInputs: new Set(),
    });

    const res = await send(base, "/api/models?refresh=1", undefined, "GET");
    assert.notEqual(res.status, 200, "Request should fail when probe host crashes");
    assert.equal(trackedHosts.length, 2);
    const probeHost = trackedHosts[1];
    assert.ok(probeHost);
    assert.equal(probeHost.closed, true, "Probe host must be closed in finally even on unhandled exception");
    assert.equal(probeHost.closeCallCount, 1);
  });

  it("F5-T2-05: Empty ProviderParam Fallback to Muse", async () => {
    const conn = new FakeConnection();
    conn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));
    const { base } = await start(conn);

    const resEmpty = await send(base, "/api/models?providerId=", undefined, "GET");
    assert.equal(resEmpty.status, 200);
    assert.equal(resEmpty.json.models.providerId, "meta");

    const resOmitted = await send(base, "/api/models", undefined, "GET");
    assert.equal(resOmitted.status, 200);
    assert.equal(resOmitted.json.models.providerId, "meta");
  });
});

// ============================================================================
// TIER 3: Cross-Feature Combinations (1 Test)
// ============================================================================

describe("Tier 3: Server Cross-Feature Combinations", () => {
  it("COMB-T3-05: Server Refresh During Active Turn", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    const conn = new FakeConnection();
    conn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));

    const factory = makeHostFactory(() => conn);
    const { base, server } = await start(conn, { hostFactory: factory });

    // Initial listing
    await get(base, "/api/models");
    const listingKey = (server as any).hostKey("", null, "muse");
    const existing = (server as any).hosts.get(listingKey);
    assert.ok(existing);

    // Active turn running on host
    (server as any).live.set("session-active-turn", {
      turnHost: existing.key,
      activeTurnId: "active-turn-xyz",
      pendingApprovals: new Set(),
      pendingInputs: new Set(),
    });

    // Issue refresh
    const res = await get(base, "/api/models?refresh=1");
    assert.ok(res.models);
    assert.equal(res.models.models[0]?.modelId, "muse-spark-1.3");

    // Existing host was NOT closed
    assert.equal(trackedHosts[0]?.closed, false, "Active turn host must not be closed");

    // Active turn state was not wiped or corrupted
    const live = (server as any).live.get("session-active-turn");
    assert.ok(live);
    assert.equal(live.activeTurnId, "active-turn-xyz");
  });
});

// ============================================================================
// TIER 4: Real-World Scenarios (1 Test)
// ============================================================================

describe("Tier 4: Server Real-World Scenarios", () => {
  it("SCEN-T4-04: High-Concurrency Refresh Under Heavy Workload", async () => {
    const { trackedHosts, makeHostFactory } = createTrackingRig();
    const conn = new FakeConnection();
    conn.replies.set("model/list", catalogResponse(["muse-spark-1.3"]));

    const factory = makeHostFactory(() => conn);
    const { base, server } = await start(conn, { hostFactory: factory });

    await get(base, "/api/models");
    const listingKey = (server as any).hostKey("", null, "muse");
    const existing = (server as any).hosts.get(listingKey);
    assert.ok(existing);
    (server as any).live.set("session-busy-conc", {
      turnHost: existing.key,
      activeTurnId: "turn-conc",
      pendingApprovals: new Set(),
      pendingInputs: new Set(),
    });

    // 8 concurrent refresh requests
    const count = 8;
    const promises = Array.from({ length: count }, () => get(base, "/api/models?refresh=1"));
    const results = await Promise.all(promises);

    assert.equal(results.length, count);
    for (const res of results) {
      assert.ok(res.models);
      assert.equal(res.models.models.length, 1);
    }

    // All probe hosts must be cleanly closed
    const probeHosts = trackedHosts.slice(1);
    assert.ok(probeHosts.length >= 1, "At least one probe host must have been spawned");
    for (const h of probeHosts) {
      assert.equal(h.closed, true, `Probe host ${h.id} must be closed`);
    }

    // Zero lingering probe keys in hosts map
    const remainingKeys = Array.from((server as any).hosts.keys()) as string[];
    const lingeringProbeKeys = remainingKeys.filter((k) => k.startsWith("__probe__"));
    assert.equal(lingeringProbeKeys.length, 0, "No probe host keys should linger in hosts map");
  });
});
