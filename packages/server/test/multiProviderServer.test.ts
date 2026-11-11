import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CanonicalSessionRuntime,
  capabilitiesForProvider,
  type ProviderId,
} from "@ancilla/daemon";
import type { LoginChild } from "../src/server.js";
import { FakeConnection, get, send, start, waitFor } from "./harness.js";

function startMockOpenAiServer(
  responder: (body: Record<string, unknown>, callIndex: number) => Record<string, unknown>[],
): Promise<{ url: string; close: () => Promise<void>; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  let callIndex = 0;
  const srv: HttpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      requests.push(parsed);
      const idx = callIndex++;
      const sseFrames = responder(parsed, idx);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "close",
      });
      for (const frame of sseFrames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

describe("multi-provider catalog, account CRUD, and AGPL source offer", () => {
  it("lists all built-in providers, manages BYOK & custom ACP accounts, and persists project defaultProviderId", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-mp-crud-"));
    const workDir = await mkdtemp(join(tmpdir(), "ancilla-mp-work-"));
    const connection = new FakeConnection();
    let srvRef: Awaited<ReturnType<typeof start>>["server"] | null = null;
    try {
      const { base, server } = await start(connection, { dataDir });
      srvRef = server;

      const initialCatalog = await get(base, "/api/providers");
      assert.equal(initialCatalog.license, "AGPL-3.0-only");
      assert.equal(initialCatalog.sourceOfferUrl, "https://github.com/aleff-ferreira/ancilla");
      assert.equal(initialCatalog.remoteDeployment, false);
      const ids = (initialCatalog.providers as { id: string }[]).map((p) => p.id);
      for (const expected of ["muse", "codex", "claude", "gemini", "copilot", "kimi", "qwen", "opencode", "acp-custom", "api"]) {
        assert.ok(ids.includes(expected), `missing provider ${expected} in /api/providers`);
      }

      const secretKey = "sk-test-never-returned-in-http-json";
      const createdApi = await send(base, "/api/providers/accounts", {
        providerId: "api",
        name: "OpenRouter Pro",
        apiKind: "openai",
        apiBaseUrl: "https://openrouter.ai/api/v1",
        apiKey: secretKey,
        defaultModelId: "openai/gpt-5.4",
        customModels: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
      });
      assert.equal(createdApi.status, 200);
      assert.equal(createdApi.json.account.providerId, "api");
      assert.equal(createdApi.json.account.hasApiKey, true);
      assert.equal(JSON.stringify(createdApi.json).includes(secretKey), false);

      const createdAcp = await send(base, "/api/providers/accounts", {
        providerId: "acp:goose",
        name: "Goose ACP",
        binaryPath: "/usr/local/bin/goose",
        customArgs: ["acp"],
      });
      assert.equal(createdAcp.status, 200);
      assert.equal(createdAcp.json.account.providerId, "acp:goose");

      const updatedCatalog = await get(base, "/api/providers");
      assert.ok((updatedCatalog.providers as { id: string }[]).some((p) => p.id === "acp:goose"));

      await send(base, "/api/projects", { cwd: workDir });
      const patchedProject = await send(
        base,
        "/api/projects/default-account",
        {
          cwd: workDir,
          providerId: "api",
          accountId: createdApi.json.account.id,
        },
        "PATCH",
      );
      assert.equal(patchedProject.status, 200);
      assert.equal(patchedProject.json.defaultProviderId, "api");
      assert.equal(patchedProject.json.defaultAccountId, createdApi.json.account.id);

      const deleted = await send(base, `/api/providers/accounts/${encodeURIComponent(createdApi.json.account.id)}`, undefined, "DELETE");
      assert.equal(deleted.status, 200);

      const projectsAfterDelete = await get(base, "/api/projects");
      const proj = (projectsAfterDelete.projects as { cwd: string; defaultProviderId: string; defaultAccountId: string | null }[])
        .find((p) => p.cwd === workDir);
      assert.ok(proj);
      assert.equal(proj.defaultProviderId, "muse");
      assert.equal(proj.defaultAccountId, null);
    } finally {
      await srvRef?.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("end-to-end built-in API agent host (ApiAgentHost)", () => {
  it("streams turns, gates write_file behind interactive approval, journals events, forks, compacts, and rejects unsupported capabilities", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-mp-api-data-"));
    const workDir = await mkdtemp(join(tmpdir(), "ancilla-mp-api-work-"));
    const mockLlm = await startMockOpenAiServer((body) => {
      const hasTools = Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0;
      if (!hasTools) {
        return [
          { choices: [{ delta: { content: "Write hello file" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ];
      }
      const messages = Array.isArray(body["messages"]) ? (body["messages"] as { role?: string }[]) : [];
      const hasToolResult = messages.some((m) => m.role === "tool");
      if (!hasToolResult) {
        return [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_write_1",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({ path: "hello.txt", content: "Created via API host\n" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 45, completion_tokens: 18 },
          },
        ];
      }
      return [
        {
          choices: [{ delta: { content: "Wrote hello.txt cleanly." }, finish_reason: null }],
        },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 72, completion_tokens: 9 },
        },
      ];
    });

    const connection = new FakeConnection();
    let srvRef: Awaited<ReturnType<typeof start>>["server"] | null = null;
    try {
      const { base, server } = await start(connection, { dataDir });
      srvRef = server;

      const acctRes = await send(base, "/api/providers/accounts", {
        providerId: "api",
        name: "Local Mock OpenAI",
        apiKind: "openai",
        apiBaseUrl: mockLlm.url,
        defaultModelId: "gpt-5.4",
        customModels: ["gpt-5.4", "gpt-5-mini"],
      });
      assert.equal(acctRes.status, 200);
      const accountId = acctRes.json.account.id as string;

      const modelsRes = await get(base, `/api/models?providerId=api&accountId=${encodeURIComponent(accountId)}`);
      const listedModels = Array.isArray(modelsRes.models)
        ? modelsRes.models
        : (modelsRes.models?.models ?? []);
      assert.ok((listedModels as { modelId: string }[]).some((m) => m.modelId === "gpt-5.4"));

      const started = await send(base, "/api/sessions", {
        cwd: workDir,
        providerId: "api",
        accountId,
        modelId: "gpt-5.4",
      });
      assert.equal(started.status, 200);
      const sessionId = started.json.session.sessionId as string;
      assert.equal(started.json.session.providerId, "api");
      assert.equal(started.json.session.capabilities.supportsGoals, false);

      const turnRes = await send(base, "/api/turns", {
        sessionId,
        text: "Please write hello.txt",
      });
      assert.equal(turnRes.status, 200);

      // Wait for approval request to appear in resume transcript pending approvals
      let approval: { approvalId: string; currentRequirementId: unknown; availableChoices: { choiceId: string; decision: string }[] } | null = null;
      await waitFor(async () => {
        const transcript = await send(base, `/api/sessions/${encodeURIComponent(sessionId)}/resume`, {});
        const pending = transcript.json?.pending?.approvals;
        if (Array.isArray(pending) && pending.length > 0) {
          approval = pending[0];
          return true;
        }
        const completed = Array.isArray(transcript.json?.events)
          ? (transcript.json.events as { method: string; params: Record<string, unknown> }[]).find((e) => e.method === "turn/completed")
          : undefined;
        if (completed) {
          throw new Error(`Turn completed early without approval: ${JSON.stringify(completed.params)}`);
        }
        return false;
      }, "approval/requested from ApiAgentHost");

      const approveChoice = approval!.availableChoices.find((c) => c.decision === "approved") ?? approval!.availableChoices[0]!;
      const approved = await send(base, "/api/approvals/decide", {
        sessionId,
        approvalId: approval!.approvalId,
        requirementId: approval!.currentRequirementId,
        choiceId: approveChoice.choiceId,
      });
      assert.equal(approved.status, 200);

      // Wait for turn/completed
      await waitFor(async () => {
        const transcript = await send(base, `/api/sessions/${encodeURIComponent(sessionId)}/resume`, {});
        return Array.isArray(transcript.json?.events) &&
          (transcript.json.events as { method: string }[]).some((e) => e.method === "turn/completed");
      }, "turn/completed after approval");

      const written = await readFile(join(workDir, "hello.txt"), "utf8");
      assert.equal(written, "Created via API host\n");

      // Goal mode is unsupported on `api` -> returns 400 unsupportedCapability
      const goalRes = await send(base, `/api/sessions/${encodeURIComponent(sessionId)}/goal`, {
        action: "set",
        objective: "Run forever",
      });
      assert.equal(goalRes.status, 400);
      assert.equal(goalRes.json.kind, "unsupportedCapability");

      // Forking and compacting work via CanonicalSessionRuntime + SessionJournal
      const forked = await send(base, `/api/sessions/${encodeURIComponent(sessionId)}/fork`, {});
      assert.equal(forked.status, 200);
      assert.equal(forked.json.session.providerId, "api");

      const compacted = await send(base, `/api/sessions/${encodeURIComponent(sessionId)}/compact`, {});
      assert.equal(compacted.status, 200);

      // Usage ledger recorded tokens attributed to providerId = "api"
      const usage = await get(base, "/api/usage?days=7");
      assert.ok((usage.threads as { sessionId: string; providerId: string }[]).some(
        (t) => t.sessionId === sessionId && t.providerId === "api",
      ));
    } finally {
      await srvRef?.close().catch(() => undefined);
      await mockLlm.close();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("multi-provider host pool isolation and Codex subscription quota forwarding", () => {
  it("runs Muse, Codex, and Gemini sessions side by side in the same folder and surfaces Codex providerQuotas", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-mp-pool-"));
    const workDir = await mkdtemp(join(tmpdir(), "ancilla-mp-pool-work-"));
    const museConn = new FakeConnection();
    museConn.replies.set("session/start", () => ({ session: { sessionId: "muse-sess-1" } }));

    const spawnedProviders: { providerId: ProviderId; accountId: string | null }[] = [];
    const runtimes = new Map<string, CanonicalSessionRuntime>();
    let srvRef: Awaited<ReturnType<typeof start>>["server"] | null = null;

    try {
      const { base, server } = await start(museConn, {
        dataDir,
        providerHostFactory: ({ providerId, accountId }) => {
          spawnedProviders.push({ providerId, accountId });
          const caps = capabilitiesForProvider(providerId);
          const runtime = new CanonicalSessionRuntime({
            providerId,
            capabilities: caps,
            journal: server["store"].sessionJournal(),
            onListModels: async () => ({
              models: [{ modelId: `${providerId}-flagship`, displayLabel: `${providerId} Flagship`, isDefault: true }],
              source: "providerCatalog",
            }),
            onRunTurn: async (ctx, rt) => {
              const itemId = rt.startAgentMessage(ctx.session, ctx.turnId);
              rt.deltaAgentMessage(ctx.session, ctx.turnId, itemId, `Reply from ${providerId}`);
              rt.completeAgentMessage(ctx.session, ctx.turnId, itemId, `Reply from ${providerId}`);
            },
          });
          runtimes.set(`${providerId}::${accountId ?? "default"}`, runtime);
          return {
            capabilities: caps,
            connection: runtime,
            start: async () => ({ serverInfo: { name: providerId, version: "1.0.0" } }),
            close: async () => ({ code: 0, signal: null }),
          };
        },
      });
      srvRef = server;

      const museStart = await send(base, "/api/sessions", { cwd: workDir, providerId: "muse" });
      const codexStart = await send(base, "/api/sessions", { cwd: workDir, providerId: "codex" });
      const geminiStart = await send(base, "/api/sessions", { cwd: workDir, providerId: "gemini" });

      assert.equal(museStart.status, 200);
      assert.equal(codexStart.status, 200);
      assert.equal(geminiStart.status, 200);
      assert.equal(museStart.json.session.providerId, "muse");
      assert.equal(codexStart.json.session.providerId, "codex");
      assert.equal(geminiStart.json.session.providerId, "gemini");
      assert.deepEqual(spawnedProviders, [
        { providerId: "codex", accountId: null },
        { providerId: "gemini", accountId: null },
      ]);

      // Emit Codex subscription rate-limit windows over canonical usage/changed
      const codexRuntime = runtimes.get("codex::default")!;
      const nowMs = Date.now();
      codexRuntime.updateSubscriptionUsage({
        tier: "chatgpt_pro",
        observedAtMs: nowMs,
        window: { usedPercent: 18, resetsAtMs: nowMs + 7_200_000, windowDurationMins: 300 },
        weekly: { usedPercent: 42, resetsAtMs: nowMs + 259_200_000, windowDurationMins: 10080 },
      });

      const planUsage = await get(base, "/api/plan-usage");
      assert.ok(Array.isArray(planUsage.providerQuotas));
      const codexQuota = (planUsage.providerQuotas as { providerId: string; usage: { tier: string; window: { usedPercent: number }; weekly: { usedPercent: number } } | null }[])
        .find((q) => q.providerId === "codex");
      assert.ok(codexQuota?.usage);
      assert.equal(codexQuota.usage.tier, "chatgpt_pro");
      assert.equal(codexQuota.usage.window.usedPercent, 18);
      assert.equal(codexQuota.usage.weekly.usedPercent, 42);
    } finally {
      await srvRef?.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("live model catalog discovery and immediate post-login refresh", () => {
  it("fetches live chat models from remote GET /v1/models on ApiAgentHost and filters utility models", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-api-models-"));
    const srv: HttpServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "openai/gpt-5.4", name: "GPT-5.4", context_length: 400_000 },
              { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", context_length: 1_000_000 },
              { id: "text-embedding-3-small", name: "Embedding" },
              { id: "whisper-1", name: "Whisper" },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    const baseUrl = await new Promise<string>((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`);
      });
    });

    let srvRef: Awaited<ReturnType<typeof start>>["server"] | null = null;
    try {
      const { base, server } = await start(new FakeConnection(), { dataDir });
      srvRef = server;
      const created = await send(base, "/api/providers/accounts", {
        providerId: "api",
        name: "Live OpenRouter",
        apiKind: "openai",
        apiBaseUrl: baseUrl,
        apiKey: "sk-live-test",
        defaultModelId: "anthropic/claude-opus-4-6",
      });
      assert.equal(created.status, 200);
      const accountId = created.json.account.id as string;

      const res = await get(base, `/api/models?providerId=api&accountId=${encodeURIComponent(accountId)}`);
      assert.equal(res.models.source, "providerCatalog");
      const rows = res.models.models as { modelId: string; isDefault: boolean; contextLimit: number | null }[];
      assert.deepEqual(
        rows.map((m) => [m.modelId, m.isDefault, m.contextLimit]),
        [
          ["anthropic/claude-opus-4-6", true, 1_000_000],
          ["openai/gpt-5.4", false, 400_000],
        ],
      );
    } finally {
      await srvRef?.close().catch(() => undefined);
      await new Promise<void>((r) => srv.close(() => r()));
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("refreshes subscription models immediately after login completes, even while pre-login hosts have running work", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-post-login-"));
    const workDir = await mkdtemp(join(tmpdir(), "ancilla-post-login-work-"));
    let loggedIn = false;
    let spawnedHosts = 0;

    class StubLoginChild extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      kill(): boolean {
        return true;
      }
      finish(code: number): void {
        this.emit("close", code);
      }
    }

    let pendingLogin: StubLoginChild | null = null;
    let srvRef: Awaited<ReturnType<typeof start>>["server"] | null = null;
    try {
      const { base, server } = await start(new FakeConnection(), {
        dataDir,
        hostFactory: () => {
          spawnedHosts += 1;
          const snapshotSignedIn = loggedIn;
          const conn = new FakeConnection();
          conn.replies.set("session/start", () => ({ session: { sessionId: "muse-busy-1" } }));
          conn.replies.set("turn/start", () => {
            conn.notify("turn/started", { sessionId: "muse-busy-1", turnId: "turn-busy-1" });
            return { turnId: "turn-busy-1", disposition: "started" };
          });
          conn.replies.set("model/list", () =>
            snapshotSignedIn
              ? {
                  source: "providerCatalog",
                  providerId: "meta",
                  models: [
                    { modelId: "muse-wonder-1.0", displayLabel: "Muse Wonder", isDefault: false, contextLimit: 1_048_576 },
                    { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3", isDefault: true, contextLimit: 1_000_000 },
                  ],
                }
              : {
                  source: "bundledCatalog",
                  providerId: "meta",
                  models: [],
                },
          );
          return {
            start: async () => ({ initializeResult: { serverInfo: { name: "muse", version: "1.4.15" } } }),
            connection: conn as never,
            close: async () => ({ code: 0, signal: null }),
            onExit: () => {},
          };
        },
        loginSpawn: () => {
          const child = new StubLoginChild();
          pendingLogin = child;
          setImmediate(() => {
            child.stdout.emit("data", "Open https://auth.meta.com/oauth/device/?code=SIGN-IN99\n");
          });
          return child as unknown as LoginChild;
        },
      });
      srvRef = server;

      // 1. Pre-login: Muse 1.4.15 returns empty bundledCatalog on the listing host AND a busy turn starts
      const preLoginModels = await get(base, "/api/models");
      assert.equal(preLoginModels.models.source, "bundledCatalog");
      assert.deepEqual(preLoginModels.models.models, []);
      assert.equal(preLoginModels.hostVersion, "1.4.15");

      // Keep the listing host busy by attaching an active turn directly or via a session on the default login
      const sess = await send(base, "/api/sessions", { cwd: workDir });
      assert.equal(sess.status, 200);
      await send(base, "/api/turns", { sessionId: sess.json.session.sessionId, text: "keep running" });

      // 2. Complete device-code login while work is still running
      const loginStart = await send(base, "/api/login", undefined);
      assert.equal(loginStart.status, 200);
      assert.equal(loginStart.json.code, "SIGN-IN99");
      loggedIn = true;
      pendingLogin!.finish(0);

      await waitFor(async () => {
        const progress = await get(base, `/api/login?loginId=${encodeURIComponent(loginStart.json.loginId)}`);
        return progress.status === "done";
      }, "login completion");

      // 3. Immediately query /api/models: must return the live providerCatalog from a fresh post-login host!
      const postLoginModels = await get(base, "/api/models");
      assert.equal(postLoginModels.models.source, "providerCatalog");
      assert.deepEqual(
        (postLoginModels.models.models as { modelId: string }[]).map((m) => m.modelId),
        ["muse-wonder-1.0", "muse-spark-1.3"],
      );
      assert.ok(spawnedHosts >= 3, "spawned a fresh post-login host to read live subscription models");
    } finally {
      await srvRef?.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
