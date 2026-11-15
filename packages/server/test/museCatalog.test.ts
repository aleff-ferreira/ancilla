import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ServeTarget } from "@ancilla/daemon";
import {
  buildAuthenticatedMuseFallbackCatalog,
  isMuse1415OrNewer,
  readCachedMuseCatalog,
} from "../src/providers/museCatalog.js";
import type { HostHandle } from "../src/server.js";
import { FakeConnection, get, send, start } from "./harness.js";

const SAMPLE_MUSE_1415_CATALOG = {
  schema_version: 2,
  provider_id: "meta",
  profile_id: "tbh",
  updated_at: "2026-11-12T10:00:00.000Z",
  source: "provider_catalog",
  rows: [
    {
      model_id: "muse-wonder-1.0",
      display_label: "muse-wonder-1.0",
      provider_id: "meta",
      profile_id: "tbh",
      is_default: true,
      is_current: true,
      visibility: "visible",
      context_limit: 1007997,
      output_limit: 128000,
      reasoning_effort_variants: [
        { tier: "minimal", description: null },
        { tier: "medium", description: null },
        { tier: "max", description: null },
      ],
    },
    {
      model_id: "muse-wonder-full-1.0",
      display_label: "muse-wonder-full-1.0",
      provider_id: "meta",
      profile_id: "tbh",
      is_default: false,
      is_current: false,
      visibility: "visible",
      context_limit: 1007997,
      output_limit: 128000,
      reasoning_effort_variants: [{ tier: "high", description: null }],
    },
    {
      model_id: "muse-ember-1.0",
      display_label: "muse-ember-1.0",
      provider_id: "meta",
      profile_id: "tbh",
      is_default: false,
      is_current: false,
      visibility: "visible",
      context_limit: 1007997,
      output_limit: 128000,
    },
    {
      model_id: "muse-spark-1.3",
      display_label: "muse-spark-1.3",
      provider_id: "meta",
      profile_id: "tbh",
      is_default: false,
      is_current: false,
      visibility: "visible",
      context_limit: 1007997,
      output_limit: 128000,
    },
    {
      model_id: "muse-spark-1.2",
      display_label: "muse-spark-1.2",
      provider_id: "meta",
      profile_id: "tbh",
      is_default: false,
      is_current: false,
      visibility: "visible",
      context_limit: 1007997,
      output_limit: 128000,
    },
    {
      model_id: "muse-internal-hidden",
      display_label: "muse-internal-hidden",
      provider_id: "meta",
      profile_id: "tbh",
      is_default: false,
      is_current: false,
      visibility: "hidden",
    },
  ],
};

describe("Muse 1.4.15+ model catalog enrichment", () => {
  it("parses cached schema_version 2 model-catalog JSON files and filters hidden rows", async (t) => {
    const museHome = await mkdtemp(join(tmpdir(), "ancilla-muse-home-"));
    t.after(() => rm(museHome, { recursive: true, force: true }));
    const catalogDir = join(museHome, "model-catalog");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "6d657461__p746268.json"), JSON.stringify(SAMPLE_MUSE_1415_CATALOG), "utf8");

    const catalog = await readCachedMuseCatalog({
      modelCatalogDir: catalogDir,
      providerId: "meta",
      profileId: "tbh",
      activeModelId: "muse-wonder-full-1.0",
    });
    assert.ok(catalog);
    assert.equal(catalog.source, "providerCatalog");
    assert.equal(catalog.providerId, "meta");
    assert.equal(catalog.profileId, "tbh");
    assert.deepEqual(
      catalog.models.map((m) => m["modelId"]),
      [
        "muse-wonder-1.0",
        "muse-wonder-full-1.0",
        "muse-ember-1.0",
        "muse-spark-1.3",
        "muse-spark-1.2",
      ],
    );
    const wonderFull = catalog.models.find((m) => m["modelId"] === "muse-wonder-full-1.0");
    assert.equal(wonderFull?.["isActive"], true);
    assert.equal(
      catalog.models.find((m) => m["modelId"] === "muse-wonder-1.0")?.["isActive"],
      false,
    );
  });

  it("checks Muse 1.4.15+ versions and builds an authenticated providerCatalog fallback", () => {
    assert.equal(isMuse1415OrNewer("1.4.14"), false);
    assert.equal(isMuse1415OrNewer("1.4.15"), true);
    assert.equal(isMuse1415OrNewer("muse 1.4.16"), true);
    assert.equal(isMuse1415OrNewer("1.5.0"), true);
    assert.equal(isMuse1415OrNewer("2.0.0"), true);
    assert.equal(isMuse1415OrNewer(null), false);

    const fallback = buildAuthenticatedMuseFallbackCatalog({
      providerId: "meta",
      profileId: "tbh",
      activeModelId: "muse-ember-1.0",
    });
    assert.equal(fallback.source, "providerCatalog");
    assert.equal(fallback.models.length, 5);
    assert.equal(
      fallback.models.find((m) => m["modelId"] === "muse-ember-1.0")?.["isActive"],
      true,
    );
  });

  it("upgrades Muse 1.4.15 empty bundledCatalog replies to providerCatalog for GET /api/models and session/setModel", async (t) => {
    const museHome = await mkdtemp(join(tmpdir(), "ancilla-muse1415-srv-"));
    const workspace = await mkdtemp(join(tmpdir(), "ancilla-muse1415-ws-"));
    t.after(async () => {
      await rm(museHome, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });
    const catalogDir = join(museHome, "model-catalog");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(join(catalogDir, "6d657461__p746268.json"), JSON.stringify(SAMPLE_MUSE_1415_CATALOG), "utf8");

    const conn = new FakeConnection();
    conn.replies.set("model/list", {
      models: [],
      providerId: "meta",
      profileId: "tbh",
      source: "bundledCatalog",
    });
    conn.replies.set("session/start", {
      session: {
        sessionId: "sess-muse-1415",
        workspaceRoot: workspace,
        modelId: "muse-wonder-1.0",
        status: "idle",
      },
    });
    conn.replies.set("session/setModel", { ok: true });

    const hostFactory = (_target: ServeTarget): HostHandle => ({
      start: async () => ({
        initializeResult: {
          serverInfo: { name: "muse", version: "1.4.15" },
          museHome,
        },
      }),
      connection: conn as never,
      close: async () => ({ code: 0, signal: null }),
    });

    const { base } = await start(conn, { hostFactory });

    const listed = await get(base, "/api/models");
    assert.equal(listed.hostVersion, "1.4.15");
    assert.equal(listed.models.source, "providerCatalog");
    assert.deepEqual(
      listed.models.models.map((m: { modelId: string }) => m.modelId),
      [
        "muse-wonder-1.0",
        "muse-wonder-full-1.0",
        "muse-ember-1.0",
        "muse-spark-1.3",
        "muse-spark-1.2",
      ],
    );

    const created = await send(base, "/api/sessions", { cwd: workspace });
    assert.equal(created.status, 200);

    const switched = await send(base, "/api/sessions/sess-muse-1415/model", {
      model: { modelId: "muse-wonder-full-1.0" },
    });
    assert.equal(switched.status, 200);

    const setCalls = conn.of("session/setModel");
    assert.equal(setCalls.length, 1);
    assert.deepEqual(setCalls[0]?.params?.["model"], {
      modelId: "muse-wonder-full-1.0",
      providerId: "meta",
      profileId: "tbh",
      displayLabel: "muse-wonder-full-1.0",
    });
  });
});
